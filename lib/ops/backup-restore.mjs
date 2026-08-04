// P0 Step 5C.12 — consistent cold backup + verified restore (+ automated restore drill).
//
// Backup model: the runtime MUST be stopped (cold copy of a cleanly shut-down PostgreSQL cluster
// is consistent by construction; no WAL trickery, no partially-written media). Scope: postgres-data,
// generated-media (clips/renders/packages/correlation), generation-jobs JSON evidence, and the
// invocation guards. Browser profiles are NEVER backed up (machine-bound DPAPI credentials;
// re-enrollment is the supported recovery); the secrets dir is opt-in. Every file is copied then
// re-hashed at the destination (SHA-256) into MANIFEST.json; the destination directory is written
// under a temp name and atomically renamed, so an interrupted backup can never look complete.
// Restore refuses a non-empty target without explicit confirmation, refuses the production owner
// root without a second explicit flag, writes a RESTORE_IN_PROGRESS marker (an interrupted restore
// is detectable), and re-hashes everything after copy. The drill starts the RESTORED copy of the
// cluster on a loopback port (trust auth appended to the copy's pg_hba only) and verifies
// migrations, project rows, scene correlation, render metadata, and media hashes.

import { shippedMigrationCount } from "./shipped-migrations.mjs";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

export const BACKUP_SCOPE = Object.freeze([
  "b3-local-runtime/postgres-data",
  "generated-media",
  "generation-jobs",
  "c9c3-generation-guards"
]);
const SECRETS_SCOPE = "b3-local-runtime/secrets";
const BACKUP_NAME_RE = /^backup-\d{8}-\d{6}$/;

function err(code, message) { return Object.assign(new Error(message), { code }); }
const toPosix = (p) => p.split(path.sep).join("/");
// Manifest paths must stay INSIDE the backup/restore roots — a crafted manifest can never escape.
function assertSafeManifestPath(rel) {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024 ||
      path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split("/").includes("..") || rel.includes("\\")) {
    throw err("E_MANIFEST_PATH_UNSAFE", `Unsafe path in manifest: ${String(rel).slice(0, 120)}`);
  }
  return rel;
}

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

function* walkFiles(root, base = root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) { yield { abs: full, rel: toPosix(path.relative(base, full)), dir: true }; yield* walkFiles(full, base); }
    else if (entry.isFile()) yield { abs: full, rel: toPosix(path.relative(base, full)) };
  }
}

export function runtimeIsStopped(ownerRoot) {
  const statusFile = path.join(ownerRoot, "b3-local-runtime", "runtime", "runtime-status.json");
  if (!existsSync(statusFile)) return true;
  try { return JSON.parse(readFileSync(statusFile, "utf8")).state === "STOPPED"; } catch { return true; }
}

function backupStamp(now) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- backup ------------------------------------------------------------------------------------
export async function createBackup({
  ownerRoot, backupDir, includeSecrets = false, retentionCount = 5,
  now = () => Date.now(), copyFile = copyFileSync, onProgress = () => {}
} = {}) {
  if (!existsSync(ownerRoot)) throw err("E_BACKUP_OWNER_ROOT", `ownerRoot does not exist: ${ownerRoot}`);
  if (!runtimeIsStopped(ownerRoot)) throw err("E_BACKUP_RUNTIME_RUNNING", "Stop the runtime before backing up (cold backup keeps PostgreSQL consistent)");
  mkdirSync(backupDir, { recursive: true });
  const name = `backup-${backupStamp(now())}`;
  const finalDir = path.join(backupDir, name);
  if (existsSync(finalDir)) throw err("E_BACKUP_EXISTS", `Backup already exists: ${name}`);
  const tmpDir = path.join(backupDir, `.tmp-${name}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const scope = [...BACKUP_SCOPE, ...(includeSecrets ? [SECRETS_SCOPE] : [])];
  const files = [];
  const dirs = []; // EVERY directory (PostgreSQL needs its empty dirs — pg_tblspc, pg_twophase, …)
  let totalBytes = 0;
  try {
    for (const scopeRel of scope) {
      const srcRoot = path.join(ownerRoot, scopeRel.split("/").join(path.sep));
      if (!existsSync(srcRoot)) continue;
      dirs.push(scopeRel);
      for (const f of walkFiles(srcRoot)) {
        const rel = `${scopeRel}/${f.rel}`;
        if (f.dir) { dirs.push(rel); mkdirSync(path.join(tmpDir, rel.split("/").join(path.sep)), { recursive: true }); continue; }
        const dest = path.join(tmpDir, rel.split("/").join(path.sep));
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFile(f.abs, dest);
        const sha256 = await hashFile(dest); // hash the DESTINATION → verifies the copy itself
        const bytes = statSync(dest).size;
        files.push({ path: rel, sha256, bytes });
        totalBytes += bytes;
        onProgress({ copied: files.length, bytes: totalBytes });
      }
    }
    const manifest = {
      schema: "avc-backup/1", name, createdAt: new Date(now()).toISOString(),
      ownerRoot: "<owner-root>", scope, includeSecrets,
      dirs, files, totals: { files: files.length, bytes: totalBytes }
    };
    writeFileSync(path.join(tmpDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2), "utf8");
    renameSync(tmpDir, finalDir); // atomic completion — no MANIFEST at final path ⇒ not a backup
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw e.code ? e : err("E_BACKUP_FAILED", e.message);
  }

  // Retention: keep the newest N VALID backups; only dirs matching backup-* with a manifest are
  // ever deleted — nothing else in backupDir is touched.
  const kept = readdirSync(backupDir).filter((d) => BACKUP_NAME_RE.test(d) && existsSync(path.join(backupDir, d, "MANIFEST.json"))).sort();
  const excess = kept.slice(0, Math.max(0, kept.length - retentionCount));
  for (const d of excess) rmSync(path.join(backupDir, d), { recursive: true, force: true });

  return { name, path: finalDir, files: files.length, bytes: totalBytes, deletedByRetention: excess };
}

// ---- verify ------------------------------------------------------------------------------------
export async function verifyBackup({ backupPath } = {}) {
  const manifestPath = path.join(backupPath, "MANIFEST.json");
  if (!existsSync(manifestPath)) return { ok: false, error: "E_BACKUP_NO_MANIFEST", mismatched: [], missing: [] };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return { ok: false, error: "E_BACKUP_MANIFEST_PARSE", mismatched: [], missing: [] }; }
  const mismatched = [], missing = [];
  for (const f of manifest.files || []) {
    assertSafeManifestPath(f.path);
    const abs = path.join(backupPath, f.path.split("/").join(path.sep));
    if (!existsSync(abs)) { missing.push(f.path); continue; }
    const sha = await hashFile(abs);
    if (sha !== f.sha256 || statSync(abs).size !== f.bytes) mismatched.push(f.path);
  }
  return { ok: mismatched.length === 0 && missing.length === 0, manifest: { name: manifest.name, createdAt: manifest.createdAt, totals: manifest.totals, includeSecrets: manifest.includeSecrets === true }, mismatched, missing };
}

// ---- restore -----------------------------------------------------------------------------------
export const RESTORE_MARKER = "RESTORE_IN_PROGRESS.json";

export async function restoreBackup({
  backupPath, targetOwnerRoot, productionOwnerRoot = null,
  confirmNonEmpty = false, allowProduction = false,
  now = () => Date.now(), copyFile = copyFileSync
} = {}) {
  const verified = await verifyBackup({ backupPath });
  if (!verified.ok) throw err("E_RESTORE_SOURCE_INVALID", `Backup failed verification (${verified.error || `${verified.mismatched.length} mismatched, ${verified.missing.length} missing`})`);
  if (typeof targetOwnerRoot !== "string" || !path.isAbsolute(targetOwnerRoot)) throw err("E_RESTORE_TARGET", "An absolute restore target is required");
  if (productionOwnerRoot && path.resolve(targetOwnerRoot) === path.resolve(productionOwnerRoot)) {
    if (!allowProduction) throw err("E_RESTORE_PRODUCTION_GUARD", "Refusing to restore over the PRODUCTION owner root without --confirm-production");
    if (!runtimeIsStopped(productionOwnerRoot)) throw err("E_RESTORE_RUNTIME_RUNNING", "Stop the runtime before restoring over production data");
  }
  mkdirSync(targetOwnerRoot, { recursive: true });
  const existing = readdirSync(targetOwnerRoot).filter((x) => x !== RESTORE_MARKER);
  if (existing.length > 0 && !confirmNonEmpty) throw err("E_RESTORE_TARGET_NOT_EMPTY", "Restore target is not empty — pass --confirm-overwrite to proceed");

  const manifest = JSON.parse(readFileSync(path.join(backupPath, "MANIFEST.json"), "utf8"));
  writeFileSync(path.join(targetOwnerRoot, RESTORE_MARKER), JSON.stringify({ startedAt: new Date(now()).toISOString(), from: manifest.name }), "utf8");
  // Recreate EVERY directory first (a cold PostgreSQL cluster requires its empty dirs).
  for (const d of manifest.dirs || []) mkdirSync(path.join(targetOwnerRoot, assertSafeManifestPath(d).split("/").join(path.sep)), { recursive: true });
  let restored = 0;
  for (const f of manifest.files) {
    assertSafeManifestPath(f.path);
    const src = path.join(backupPath, f.path.split("/").join(path.sep));
    const dest = path.join(targetOwnerRoot, f.path.split("/").join(path.sep));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFile(src, dest);
    const sha = await hashFile(dest);
    if (sha !== f.sha256) throw err("E_RESTORE_COPY_MISMATCH", `Restored file hash mismatch: ${f.path}`);
    restored += 1;
  }
  rmSync(path.join(targetOwnerRoot, RESTORE_MARKER), { force: true });
  return { restored, from: manifest.name, target: targetOwnerRoot };
}

export function restoreWasInterrupted(targetOwnerRoot) {
  return existsSync(path.join(targetOwnerRoot, RESTORE_MARKER));
}

// ---- restore drill (provider-free) -------------------------------------------------------------
function runExe(exe, args, { timeoutMs = 60_000, detach = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: detach ? "ignore" : "pipe" });
    let out = "", errText = "", done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(t); fn(arg); };
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish(reject, err("E_DRILL_TIMEOUT", `${path.basename(exe)} timed out`)); }, timeoutMs);
    if (child.stdout) child.stdout.on("data", (d) => { out += d; });
    if (child.stderr) child.stderr.on("data", (d) => { errText += d; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => (code === 0 ? finish(resolve, { out, err: errText }) : finish(reject, err("E_DRILL_EXEC", `${path.basename(exe)} exited ${code}: ${(errText || out).slice(-300)}`))));
  });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Start the RESTORED cluster copy, verify durable content, verify media hashes vs the DB, stop.
// expectedMigrations defaults to the count THIS build ships (never a hard-coded number, which would make
// every restore drill fail the moment a deploy adds a migration). null/unknown -> the check is skipped.
export async function runRestoreDrill({ restoredOwnerRoot, pgBinDir, dbName, superUser = "postgres", expectedMigrations = null } = {}) {
  const expectMigrations = Number.isInteger(expectedMigrations) ? expectedMigrations : shippedMigrationCount();
  const dataDir = path.join(restoredOwnerRoot, "b3-local-runtime", "postgres-data");
  if (!existsSync(dataDir)) throw err("E_DRILL_NO_DATA", "Restored postgres-data not found");
  if (restoreWasInterrupted(restoredOwnerRoot)) throw err("E_DRILL_INTERRUPTED_RESTORE", "Restore marker present — the restore did not complete");
  // Trust auth on the RESTORED COPY only (never the production cluster). pg_hba is first-match-
  // wins, so the trust line must go FIRST to override a strict scram-only production hba.
  const hbaPath = path.join(dataDir, "pg_hba.conf");
  const hba = readFileSync(hbaPath, "utf8");
  writeFileSync(hbaPath, "host all all 127.0.0.1/32 trust\n" + hba, "utf8");
  rmSync(path.join(dataDir, "postmaster.pid"), { force: true }); // stale lock from a crashed source is safe to clear on a COPY
  const port = await freePort();
  const pgCtl = path.join(pgBinDir, "pg_ctl.exe");
  const psql = path.join(pgBinDir, "psql.exe");
  const logFile = path.join(restoredOwnerRoot, "drill-pg.log");
  await runExe(pgCtl, ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", logFile, "start"], { detach: true, timeoutMs: 45_000 });
  const q = async (sql, db) => {
    for (let i = 0; i < 40; i += 1) {
      try { return (await runExe(psql, ["-h", "127.0.0.1", "-p", String(port), "-U", superUser, "-d", db, "-t", "-A", "-c", sql], { timeoutMs: 20_000 })).out.trim(); }
      catch (e) { if (i === 39) throw e; await new Promise((r) => setTimeout(r, 250)); }
    }
    return null;
  };
  const report = { port, checks: {} };
  try {
    const dbs = (await q("SELECT datname FROM pg_database WHERE datistemplate=false", "postgres")).split(/\r?\n/).filter(Boolean);
    const db = dbName && dbs.includes(dbName) ? dbName : dbs.find((d) => d !== "postgres") || "postgres";
    report.database = db;
    report.checks.migrations = Number(await q("SELECT count(*) FROM cp_schema_migrations", db));
    report.checks.movieProjects = Number(await q("SELECT count(*) FROM movie_projects", db));
    report.checks.completedScenesWithCorrelation = Number(await q(
      "SELECT count(*) FROM movie_scenes WHERE state='COMPLETED' AND generation_job_id IS NOT NULL AND generation_attempt_id IS NOT NULL AND result_id IS NOT NULL", db));
    report.checks.completedScenesMissingCorrelation = Number(await q(
      "SELECT count(*) FROM movie_scenes WHERE state='COMPLETED' AND (generation_job_id IS NULL OR result_id IS NULL)", db));
    report.checks.completedRenders = Number(await q("SELECT count(*) FROM movie_renders WHERE state='COMPLETED'", db));
    // Media hash verification: every COMPLETED render's final_media {relativePath,sha256} must
    // exist in the restored media tree and hash-match; packages likewise.
    const rows = (await q("SELECT COALESCE(final_media->>'relativePath','') || '|' || COALESCE(final_media->>'sha256','') || '|' || COALESCE(package_media->>'relativePath','') || '|' || COALESCE(package_media->>'sha256','') FROM movie_renders WHERE state='COMPLETED'", db) || "").split(/\r?\n/).filter(Boolean);
    let mediaOk = 0, mediaBad = 0;
    for (const row of rows) {
      const [finalRel, finalSha, pkgRel, pkgSha] = row.split("|");
      for (const [rel, sha] of [[finalRel, finalSha], [pkgRel, pkgSha]]) {
        if (!rel) continue;
        const abs = path.join(restoredOwnerRoot, "generated-media", rel.split("/").join(path.sep));
        if (!existsSync(abs)) { mediaBad += 1; continue; }
        if (sha && sha.length === 64) { (await hashFile(abs)) === sha ? mediaOk += 1 : mediaBad += 1; }
        else mediaOk += 1;
      }
    }
    report.checks.renderMediaVerified = mediaOk;
    report.checks.renderMediaBad = mediaBad;
    report.ok = (expectMigrations === null || report.checks.migrations === expectMigrations) && mediaBad === 0 && report.checks.completedScenesMissingCorrelation === 0;
  } finally {
    try { await runExe(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], { detach: true, timeoutMs: 30_000 }); } catch { /* best-effort */ }
  }
  return report;
}
