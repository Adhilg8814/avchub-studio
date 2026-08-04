// P0 Step 5C.9E — disposable PostgreSQL harness for live verification.
//
// Stands up a throwaway PostgreSQL 16.4 cluster on loopback using the portable binaries the
// runtime already extracted, creates the four control-plane roles + a *_test database owned by
// cp_migrator with the same grants the runtime bootstrap applies, and returns the three role URLs
// + a stop(). Everything lives under a temp dir OUTSIDE the repo and is torn down after the run.
// No owner secrets are read: passwords are generated per-run and auth is loopback-trust, so the
// disposable cluster never depends on the runtime's real credentials.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
// Where this machine keeps a local PostgreSQL. PGBIN points at the bin directory; without it these suites
// skip rather than fail, because "no database installed" is not a defect in the code under test.
const BIN = process.env.PGBIN || path.join(process.env.AVC_STUDIO_HOME || "", "postgres", "bin");
// The disposable cluster lives on the SAME volume as the portable binaries (E:), never the C:
// system temp — the runtime's own data already proves E: has room, and C: may be full.
const TMP_BASE = process.env.PG_TEST_DIR || path.resolve(BIN, "..", "..", ".disposable-test-pg");
export function livePgAvailable() { return existsSync(path.join(BIN, "initdb.exe")) && existsSync(path.join(BIN, "pg_ctl.exe")); }

function run(exe, args, { env, timeoutMs = 60_000, detach = false } = {}) {
  return new Promise((resolve, reject) => {
    // detach: stdio 'ignore' so a forked grandchild (postgres under pg_ctl) cannot keep an
    // inherited stdout/stderr pipe open — otherwise 'close' never fires on Windows and run() hangs.
    const child = spawn(path.join(BIN, exe), args, { env: { ...process.env, ...env }, windowsHide: true, stdio: detach ? "ignore" : "pipe" });
    let out = "", err = "", done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish(reject, new Error(`${exe} timed out after ${timeoutMs}ms: ${err || out}`)); }, timeoutMs);
    if (child.stdout) child.stdout.on("data", (d) => { out += d; });
    if (child.stderr) child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => (code === 0 ? finish(resolve, { out, err }) : finish(reject, new Error(`${exe} exited ${code}: ${err || out}`))));
  });
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function connectRetry(url, attempts = 40) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    const c = new Client({ connectionString: url });
    try { await c.connect(); return c; } catch (e) { lastErr = e; try { await c.end(); } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); }
  }
  throw lastErr || new Error("could not connect to disposable cluster");
}

// Provision a disposable cluster + roles + *_test DB. Returns URLs + stop().
export async function startDisposablePg({ namePrefix = "cp5c9e" } = {}) {
  const vlog = (m) => { if (process.env.LIVE_PG_VERBOSE) process.stderr.write(`[live-pg] ${m}\n`); };
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_BASE, "cp5c9e-pg-"));
  const dataDir = path.join(dir, "data");
  const pwFile = path.join(dir, "superpw");
  const superPw = "sp_" + Math.abs(hash(dir + ":super")).toString(36);
  writeFileSync(pwFile, superPw, { mode: 0o600 });
  vlog("initdb…");
  await run("initdb.exe", ["-D", dataDir, "-U", "postgres", "-A", "trust", `--pwfile=${pwFile}`, "-E", "UTF8", "--no-sync"]);
  const port = await freePort();
  const logFile = path.join(dir, "pg.log");
  vlog(`pg_ctl start on ${port}…`);
  // Start (loopback only). NO -w and stdio ignored: on Windows pg_ctl -w keeps the inherited
  // stdout pipe open (postgres is a grandchild) so 'close' never fires. connectRetry below is the
  // real readiness gate.
  await run("pg_ctl.exe", ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", logFile, "start"], { detach: true, timeoutMs: 30_000 });
  vlog("start issued; creating roles…");

  const dbName = `${namePrefix}_test`;
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const admin = await connectRetry(adminUrl);
  try {
    // Roles: cp_migrator (owner), cp_tenant_app, cp_ops_enumerator (BYPASSRLS), cp_readonly_observer.
    await admin.query("CREATE ROLE cp_migrator LOGIN PASSWORD 'm' NOBYPASSRLS");
    await admin.query("CREATE ROLE cp_tenant_app LOGIN PASSWORD 't' NOBYPASSRLS");
    await admin.query("CREATE ROLE cp_ops_enumerator LOGIN PASSWORD 'o' BYPASSRLS");
    await admin.query("CREATE ROLE cp_readonly_observer LOGIN PASSWORD 'r' NOBYPASSRLS");
    await admin.query(`CREATE DATABASE ${dbName} OWNER cp_migrator`);
    const cfg = await connectRetry(`postgres://postgres@127.0.0.1:${port}/${dbName}`);
    try {
      await cfg.query("GRANT CONNECT ON DATABASE " + dbName + " TO cp_migrator, cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
      await cfg.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
      await cfg.query("GRANT CREATE, USAGE ON SCHEMA public TO cp_migrator");
      await cfg.query("ALTER ROLE cp_migrator IN DATABASE " + dbName + " SET search_path=public");
      await cfg.query("ALTER ROLE cp_tenant_app IN DATABASE " + dbName + " SET search_path=public");
      await cfg.query("ALTER ROLE cp_ops_enumerator IN DATABASE " + dbName + " SET search_path=public");
      // cp_migrator must own future objects; make it able to create the citext extension is handled by migration 0001.
    } finally { await cfg.end(); }
  } finally { await admin.end(); }

  const base = (role) => `postgres://${role}@127.0.0.1:${port}/${dbName}`;
  return Object.freeze({
    testDbUrl: base("cp_tenant_app"),
    migrationUrl: base("cp_migrator"),
    opsUrl: base("cp_ops_enumerator"),
    appUrl: base("cp_tenant_app"),
    port, dbName,
    async stop() {
      try { await run("pg_ctl.exe", ["-D", dataDir, "-m", "immediate", "stop"], { detach: true, timeoutMs: 20_000 }); } catch { /* best-effort */ }
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort (Windows may hold handles briefly) */ }
    }
  });
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i += 1) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; } return h; }
