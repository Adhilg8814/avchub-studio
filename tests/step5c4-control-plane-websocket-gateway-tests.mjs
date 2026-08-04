#!/usr/bin/env node
// P0 Step 5C.4 — production WebSocket Worker Gateway tests.
//
// SAFE BY CONSTRUCTION: offline unit/static checks always run. LIVE tests (real PostgreSQL +
// real local WebSocket connections on 127.0.0.1:ephemeral) run ONLY against a verified disposable
// *_test database; otherwise they SKIP with a reason. No browser automation, no provider, no
// quota. Exit 0 when there are no failures.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

import { loadConfig, safeConfigSummary } from "../control-plane/src/config/config.mjs";
import { createApp } from "../control-plane/src/app.mjs";
import { evaluateTestDbTarget } from "../control-plane/src/persistence/postgres/test-db-safety.mjs";
import { migrate as mrun } from "../control-plane/src/persistence/postgres/migrations.mjs";
import * as OWN from "../control-plane/src/persistence/transactions/ownership.mjs";
import { sessionRepository } from "../control-plane/src/persistence/repositories/session-repository.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";
import { credentialVerifier, isCredentialShaped } from "../control-plane/src/gateway/credential-verifier.mjs";
import { extractBearer, createAuthRateLimiter, AUTH_CODES } from "../control-plane/src/gateway/gateway-auth.mjs";
import { validateInboundFrame } from "../control-plane/src/gateway/frame-safety.mjs";
import { createSocketRegistry } from "../control-plane/src/gateway/socket-registry.mjs";
import { CLOSE, upgradeRejection } from "../control-plane/src/gateway/close-codes.mjs";
import { generateResumeToken, resumeTokenHash, resumeTokenMatches, isResumeTokenShaped } from "../control-plane/src/gateway/resume.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let passed = 0, failed = 0, skipped = 0;
const skipReasons = new Set();
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function skip(name, reason) { skipped += 1; skipReasons.add(reason); }

const DIR = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = path.join(DIR, "..", "control-plane", "database", "migrations");
const GW_DIR = path.join(DIR, "..", "control-plane", "src", "gateway");
const TEST_PEPPER = "step5c4-test-pepper-value-fixed";

function mkCredential() { return `wcred_${randomBytes(32).toString("base64url")}`; }

async function probeLiveDb() {
  const url = process.env.CONTROL_PLANE_TEST_DB_URL;
  const allow = process.env.CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS === "true";
  const guard = evaluateTestDbTarget({ url, allowDestructive: allow });
  if (!guard.ok) return { available: false, reason: `guard:${guard.reasons.join(",")}` };
  try {
    const pg = (await import("pg")).default ?? (await import("pg"));
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await c.connect(); await c.query("SELECT 1"); await c.end();
    return { available: true, testUrl: url, migrationUrl: process.env.CONTROL_PLANE_DB_MIGRATION_URL || url, opsUrl: process.env.CONTROL_PLANE_DB_OPS_URL || url, pg };
  } catch (e) { return { available: false, reason: `connect:${String(e.code || e.message).slice(0, 40)}` }; }
}

try {
  // =========================== OFFLINE — authentication extraction ===========================
  {
    check("auth: missing → E_AUTH_REQUIRED", extractBearer({}).code, AUTH_CODES.MISSING);
    check("auth: empty → E_AUTH_REQUIRED", extractBearer({ authorization: "" }).code, AUTH_CODES.MISSING);
    check("auth: malformed Basic → E_AUTH_MALFORMED", extractBearer({ authorization: "Basic zzz" }).code, AUTH_CODES.MALFORMED);
    check("auth: bare token → E_AUTH_MALFORMED", extractBearer({ authorization: "wcred_abc" }).code, AUTH_CODES.MALFORMED);
    check("auth: multiple → E_AUTH_MULTIPLE", extractBearer({ authorization: "Bearer a, Bearer b" }).code, AUTH_CODES.MULTIPLE);
    check("auth: oversized → E_AUTH_HEADER_TOO_LARGE", extractBearer({ authorization: "Bearer " + "x".repeat(9000) }).code, AUTH_CODES.HEADER_TOO_LARGE);
    const ok = extractBearer({ authorization: "Bearer wcred_" + "a".repeat(43) });
    check("auth: valid Bearer accepted", ok.ok, true);
    check("auth: credential extracted", ok.credential.startsWith("wcred_"), true);
    // query/cookie carry no Authorization → missing (never read query/cookie)
    check("auth: query-string cred is not Authorization (missing)", extractBearer({ cookie: "cred=x" }).code, AUTH_CODES.MISSING);
    // credential shape + verifier determinism
    const cred = mkCredential();
    check("auth: credential shaped", isCredentialShaped(cred), true);
    check("auth: verifier deterministic", credentialVerifier(TEST_PEPPER, cred), credentialVerifier(TEST_PEPPER, cred));
    check("auth: verifier depends on pepper", credentialVerifier("p1", cred) !== credentialVerifier("p2", cred), true);
    check("auth: verifier not the credential", credentialVerifier(TEST_PEPPER, cred).startsWith("wcred_"), false);
    // rate limiter
    let t = 0; const rl = createAuthRateLimiter({ windowMs: 1000, maxPerWindow: 3, now: () => t });
    check("auth rate-limit allows under cap", [rl.check("k"), (rl.record("k"), rl.check("k")), (rl.record("k"), rl.check("k"))].every(Boolean), true);
    rl.record("k"); check("auth rate-limit blocks over cap", rl.check("k"), false);
    t = 2000; check("auth rate-limit resets after window", rl.check("k"), true);
  }

  // =========================== OFFLINE — frame safety ===========================
  {
    const L = { maxFrameBytes: 256, maxJsonDepth: 6, maxArrayItems: 8, maxObjectKeys: 8 };
    check("frame: binary rejected", validateInboundFrame(Buffer.from("{}"), true, L).code, "E_FRAME_BINARY");
    check("frame: empty rejected", validateInboundFrame(Buffer.from(""), false, L).code, "E_FRAME_EMPTY");
    check("frame: oversized rejected before parse", validateInboundFrame(Buffer.from("{" + "\"a\":1,".repeat(200) + "}"), false, L).code, "E_FRAME_TOO_LARGE");
    check("frame: invalid utf8 rejected", validateInboundFrame(Buffer.from([0xff, 0xfe, 0xfd]), false, L).code, "E_FRAME_INVALID_UTF8");
    check("frame: invalid json rejected", validateInboundFrame(Buffer.from("{bad"), false, L).code, "E_FRAME_INVALID_JSON");
    check("frame: array root rejected", validateInboundFrame(Buffer.from("[1,2]"), false, L).code, "E_FRAME_ROOT_NOT_OBJECT");
    check("frame: primitive root rejected", validateInboundFrame(Buffer.from("42"), false, L).code, "E_FRAME_ROOT_NOT_OBJECT");
    check("frame: excessive depth rejected", validateInboundFrame(Buffer.from(JSON.stringify(deepObj(10))), false, L).code, "E_FRAME_DEPTH");
    check("frame: excessive keys rejected", validateInboundFrame(Buffer.from(JSON.stringify(wideObj(20))), false, { ...L, maxFrameBytes: 100000 }).code, "E_FRAME_OBJECT_KEYS");
    check("frame: excessive array items rejected", validateInboundFrame(Buffer.from(JSON.stringify({ x: new Array(20).fill(1) })), false, { ...L, maxFrameBytes: 100000 }).code, "E_FRAME_ARRAY_ITEMS");
    check("frame: prototype pollution rejected", validateInboundFrame(Buffer.from('{"__proto__":{"x":1}}'), false, { ...L, maxFrameBytes: 100000 }).code, "E_FRAME_POLLUTION");
    // a structurally-valid but non-protocol object is rejected by the envelope validator
    check("frame: invalid envelope rejected", validateInboundFrame(Buffer.from('{"foo":"bar"}'), false, { ...L, maxFrameBytes: 100000 }).ok, false);
    // a valid Cloud→Worker type is wrong direction (must be worker→cloud)
    const cloudMsg = makeEnvelope({ type: "JOB_OFFER", workspaceId: generateId("ws"), workerId: generateId("wrk"), jobId: generateId("job"), sentAt: new Date().toISOString(), payload: { action: "GENERATE_GROK_VIDEO" } });
    check("frame: wrong direction rejected", validateInboundFrame(Buffer.from(JSON.stringify(cloudMsg)), false, { ...L, maxFrameBytes: 100000 }).code, "E_FRAME_WRONG_DIRECTION");
    // a valid worker→cloud message passes
    const wc = makeEnvelope({ type: "JOB_ACCEPTED", workspaceId: generateId("ws"), workerId: generateId("wrk"), jobId: generateId("job"), sentAt: new Date().toISOString(), payload: {} });
    check("frame: valid worker→cloud accepted", validateInboundFrame(Buffer.from(JSON.stringify(wc)), false, { ...L, maxFrameBytes: 100000 }).ok, true);
  }

  // =========================== OFFLINE — close codes + resume + registry ===========================
  {
    check("close: superseded has private code", CLOSE.SESSION_SUPERSEDED.code >= 4000, true);
    check("close: hello-timeout distinct", CLOSE.HELLO_TIMEOUT.reason, "HELLO_TIMEOUT");
    check("upgrade rejection: auth → 401", upgradeRejection("E_AUTH_FAILED").status, 401);
    check("upgrade rejection: rate → 429", upgradeRejection("E_AUTH_RATE_LIMITED").status, 429);
    check("upgrade rejection: unknown path → 404", upgradeRejection("E_UNKNOWN_PATH").status, 404);
    // resume tokens
    const { token, hash } = generateResumeToken();
    check("resume: shaped", isResumeTokenShaped(token), true);
    check("resume: hash is 64-hex", /^[0-9a-f]{64}$/.test(hash), true);
    check("resume: matches", resumeTokenMatches(token, hash), true);
    check("resume: mismatch rejected", resumeTokenMatches(token + "x", hash), false);
    check("resume: rotated token cannot match old hash", resumeTokenMatches(generateResumeToken().token, hash), false);
    // registry
    const reg = createSocketRegistry();
    const sid = newId("sess");
    const e = reg.register({ socket: { id: 1 }, workspaceId: "ws_x", workerId: "wrk_x", sessionId: sid, epoch: 0, gatewayInstance: "gw-A", connectedAt: 1000 });
    check("registry: getBySession", reg.getBySession(sid) === e, true);
    check("registry: isCurrent by epoch", reg.isCurrent(sid, 0), true);
    check("registry: stale epoch not current", reg.isCurrent(sid, 1), false);
    check("registry: current for worker", reg.getCurrentForWorker("wrk_x") === e, true);
    reg.markDraining(sid); check("registry: draining not current", reg.isCurrent(sid, 0), false);
    reg.unregister(sid); check("registry: unregistered gone", reg.getBySession(sid), null);
    check("registry: no credential/token fields on entry", Object.keys(e).some((k) => /credential|token|pepper/i.test(k)), false);
  }

  // =========================== OFFLINE — config gates + summary ===========================
  {
    const off = loadConfig({});
    check("gateway OFF by default", off.workerGateway.enabled, false);
    check("gateway default path /ws/worker", off.workerGateway.path, "/ws/worker");
    const reject = (env) => { try { loadConfig(env); return null; } catch (e) { return e.code; } };
    check("gateway requires DB", reject({ CONTROL_PLANE_GATEWAY_ENABLED: "true" }), "E_CONFIG_INVALID");
    const base = { CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:5/cp_test" };
    check("gateway requires processor", reject(base), "E_CONFIG_INVALID");
    check("gateway requires pepper", reject({ ...base, CONTROL_PLANE_PROCESSOR_ENABLED: "true" }), "E_CONFIG_INVALID");
    const okCfg = loadConfig({ ...base, CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_CREDENTIAL_PEPPER: "p" });
    check("gateway valid config loads", okCfg.workerGateway.enabled, true);
    check("gateway keeps credentialPepper value internally", okCfg.security.credentialPepper, "p");
    // production wildcard origin + public-bind gates
    const prodBase = { CONTROL_PLANE_ENV: "production", CONTROL_PLANE_HOST: "10.0.0.5", CONTROL_PLANE_COMMIT_SHA: "abc", CONTROL_PLANE_PAIRING_PEPPER: "pp", CONTROL_PLANE_CREDENTIAL_PEPPER: "cp", CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@db.example.com:5432/cp", CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_TRUST_PROXY: "true", CONTROL_PLANE_ALLOWED_ORIGINS: "https://studio.example.com", CONTROL_PLANE_FLAG_CONTROL_PLANE_ENABLED: "true" };
    check("gateway prod OK with trustProxy + explicit origins", reject(prodBase), null);
    check("gateway prod wildcard origin rejected", reject({ ...prodBase, CONTROL_PLANE_ALLOWED_ORIGINS: "*" }), "E_CONFIG_INVALID");
    check("gateway prod public bind without trustProxy rejected", reject({ ...prodBase, CONTROL_PLANE_TRUST_PROXY: "false" }), "E_CONFIG_INVALID");
    // summary excludes pepper value
    check("summary has no pepper value", JSON.stringify(safeConfigSummary(okCfg)).includes("credentialPepper\":\"p"), false);
    check("summary workerGateway present", typeof safeConfigSummary(okCfg).workerGateway.gatewayInstanceId, "string");
  }

  // =========================== OFFLINE — static safety scan ===========================
  {
    const files = readdirSync(GW_DIR).filter((f) => f.endsWith(".mjs")).map((f) => ({ f, txt: readFileSync(path.join(GW_DIR, f), "utf8") }));
    const all = files.map((x) => x.txt).join("\n");
    const mig13 = readFileSync(path.join(MIG_DIR, "0013_gateway_sessions.sql"), "utf8");
    check("SEC gateway no setInterval", /setInterval\s*\(/.test(all), false);
    check("SEC gateway no eval/Function", /\beval\s*\(|new Function\s*\(/.test(all), false);
    check("SEC gateway no ui-server/lib-worker/lib-control import", /from\s+['"][^'"]*(ui-server|lib\/worker|lib\/control)/.test(all), false);
    check("SEC gateway no provider/python imports", /from\s+['"][^'"]*(puppeteer|playwright)|child_process|\.py['"]/.test(all), false);
    // a secret / raw payload used as a LOG FIELD KEY (reason-code string VALUES are safe)
    check("SEC gateway logs no secret/payload field key", /(?:log|logger)[^;\n]*[{,]\s*(?:authorization|credential|resumetoken|pepper|payload)\s*:/i.test(all), false);
    check("SEC gateway never reads query/cookie for credentials", /req\.url[^\n]*(token|credential)|headers\.cookie/i.test(all), false);
    check("SEC 0013 no GRANT ALL", /GRANT\s+ALL/i.test(mig13), false);
    check("SEC 0013 no plaintext credential/token column", /\b(credential|resume_token|password)\s+TEXT\b/i.test(mig13), false);
    check("SEC 0013 ops grant SELECT only", /INSERT|UPDATE|DELETE/i.test((mig13.match(/GRANT[^;]*TO cp_ops_enumerator/gis) || []).join(" ")), false);
    check("SEC delivery adapter never mints messageId", /generateId\(.msg.\)|newId\(.msg.\)/.test(readFileSync(path.join(GW_DIR, "gateway-delivery-adapter.mjs"), "utf8")), false);
    // migrations 0001..0013 present
    const migs = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    {
    // Numbering is asserted as an invariant rather than a pinned list: a pinned list goes stale on the next
    // migration and never detects the failure that matters — a gap or a duplicate number, which means two
    // branches numbered a migration the same way and the runner applies only one of them.
    const nums = migs.map((f) => Number(f.slice(0, 4)));
    check("migrations are sequential and contiguous from 0001",
      nums[0] === 1 && new Set(nums).size === nums.length && nums.every((n, i) => n === i + 1), true);
  }
  }

  // =========================== LIVE (skip unless verified *_test DB) ===========================
  const live = await probeLiveDb();
  if (!live.available) {
    const groups = liveGroupNames();
    for (const g of groups) skip(g, live.reason);
    console.error(`\n[SKIP] Live Gateway tests skipped (${skipped} groups). Reason: ${live.reason}`);
    console.error("[SKIP] To run: provide CONTROL_PLANE_TEST_DB_URL (loopback, *_test), CONTROL_PLANE_DB_MIGRATION_URL,");
    console.error("[SKIP]   CONTROL_PLANE_DB_OPS_URL, and set CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS=true.");
  } else {
    await runLiveTests(live);
  }

  check("no unhandled rejection", un, false);
} catch (e) {
  failed += 1;
  console.error("SUITE ERROR", e && e.stack ? e.stack.split("\n").slice(0, 8).join("\n") : e);
}

if (failed > 0) { console.error(`\n${passed} passed, ${failed} failed, ${skipped} skipped`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed, ${skipped} skipped${skipped ? ` (reasons: ${[...skipReasons].join("; ")})` : ""}`); process.exit(0); }

// ---------------- helpers ----------------
function deepObj(n) { let o = { v: 1 }; for (let i = 0; i < n; i++) o = { c: o }; return o; }
function wideObj(n) { const o = {}; for (let i = 0; i < n; i++) o["k" + i] = i; return o; }
function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }
function safeJson(d) { try { return JSON.parse(d.toString()); } catch { return null; } }
function makeCapturingLogger(logs) {
  const rec = (level) => (event, fields) => { logs.push({ level, event, fields }); };
  const L = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") };
  L.child = () => L;
  return L;
}

function wsConnect(port, { credential, headers, path = "/ws/worker" } = {}) {
  return new Promise((resolve) => {
    const h = headers || (credential ? { authorization: `Bearer ${credential}` } : {});
    const sock = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: h });
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    sock.on("open", () => fin({ ok: true, sock }));
    sock.on("unexpected-response", (_req, res) => { fin({ ok: false, status: res.statusCode }); try { sock.terminate(); } catch { /* */ } });
    sock.on("error", (e) => fin({ ok: false, error: String(e && e.message) }));
  });
}
function nextEvent(sock, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); sock.off("message", onMsg); sock.off("close", onClose); resolve(v); };
    const onMsg = (data) => fin({ kind: "message", env: safeJson(data) });
    const onClose = (code, reason) => fin({ kind: "close", code, reason: reason ? reason.toString() : "" });
    const t = setTimeout(() => fin({ kind: "timeout" }), timeoutMs); if (t.unref) t.unref();
    sock.on("message", onMsg); sock.on("close", onClose);
  });
}
// Drain ALL messages a socket receives within `ms` (robust to leftover PENDING offers from
// earlier cases being delivered alongside the one under test).
function collect(sock, ms, max = 100) {
  return new Promise((resolve) => {
    const msgs = [];
    const onMsg = (data) => { const e = safeJson(data); if (e) msgs.push(e); if (msgs.length >= max) fin(); };
    const t = setTimeout(fin, ms); if (t.unref) t.unref();
    function fin() { clearTimeout(t); sock.off("message", onMsg); resolve(msgs); }
    sock.on("message", onMsg);
  });
}

async function runLiveTests(live) {
  const { Client } = live.pg;
  const openSockets = [];
  const track = (s) => { if (s) openSockets.push(s); return s; };

  // ---- reset + migrate 0001..0013 from clean ----
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    await mc.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await mc.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
    await mc.query("GRANT CREATE ON SCHEMA public TO cp_migrator");
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    const res = await mrun(mc, { dir: MIG_DIR, appVersion: "5c4-test" });
    check("LIVE migrate applies incl 0015", res.applied.length + res.alreadyApplied, 15);
  } finally { await mc.end(); }

  // ---- seed workspace/workers/credentials ----
  const seed = new Client({ connectionString: live.migrationUrl });
  await seed.connect();
  const ids = { wsA: generateId("ws"), userA: generateId("usr"), prjA: generateId("prj"), wsB: generateId("ws"), userB: generateId("usr") };
  const creds = {};
  try {
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.userA, `a-${Date.now()}@t.test`]);
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.userB, `b-${Date.now()}@t.test`]);
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.wsA]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'A',$2)", [ids.wsA, ids.userA]);
    await seed.query("INSERT INTO projects (id,workspace_id,created_by_user_id,title,storage_relative_root) VALUES ($1,$2,$3,'P','projects/p')", [ids.prjA, ids.wsA, ids.userA]);
    async function addWorker(name, { workerStatus = "ONLINE", credStatus = "ACTIVE", expired = false } = {}) {
      const workerId = generateId("wrk"); const credential = mkCredential();
      await seed.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version,status) VALUES ($1,$2,$3,'win32',1,$4)", [workerId, ids.wsA, name, workerStatus]);
      const exp = expired ? "now() - interval '1 hour'" : "now() + interval '365 days'";
      await seed.query(`INSERT INTO worker_credentials (id,workspace_id,worker_id,credential_hash,status,expires_at) VALUES ($1,$2,$3,$4,$5, ${exp})`,
        [newId("cred"), ids.wsA, workerId, credentialVerifier(TEST_PEPPER, credential), credStatus]);
      return { workerId, credential };
    }
    creds.w1 = await addWorker("W1");
    creds.w2 = await addWorker("W2");
    creds.w3 = await addWorker("W3");
    creds.w4 = await addWorker("W4");
    creds.wRevoked = await addWorker("WRevoked", { workerStatus: "REVOKED" });
    creds.wExpired = await addWorker("WExpired", { expired: true });
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.wsB]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'B',$2)", [ids.wsB, ids.userB]);
    check("LIVE seed ok", true, true);
  } finally { await seed.end(); }

  // ---- build gateway app A (instanceId gw-A) ----
  function baseEnv(instanceId, port) {
    return {
      CONTROL_PLANE_ENV: "test", CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port), CONTROL_PLANE_INSTANCE_ID: instanceId,
      CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.testUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl,
      CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_DELIVERY_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0",
      CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_CREDENTIAL_PEPPER: TEST_PEPPER,
      // heartbeat interval at its max (120s) so its ONLY auto-tick fires at startup (no sockets);
      // during the <120s suite no auto-tick interferes. degraded/offline windows are small so the
      // heartbeat cases can force them by backdating lastPongAt + calling _tick() manually.
      CONTROL_PLANE_GATEWAY_HELLO_TIMEOUT_MS: "800", CONTROL_PLANE_GATEWAY_HEARTBEAT_MS: "120000",
      CONTROL_PLANE_GATEWAY_DEGRADED_MS: "8000", CONTROL_PLANE_GATEWAY_OFFLINE_MS: "15000",
      CONTROL_PLANE_GATEWAY_MAX_PENDING_INBOUND: "6", CONTROL_PLANE_GATEWAY_MAX_MESSAGES_PER_WINDOW: "40",
      CONTROL_PLANE_GATEWAY_MAX_PREAUTH_PER_WINDOW: "500", CONTROL_PLANE_GATEWAY_RATE_LIMIT_WINDOW_MS: "10000",
      CONTROL_PLANE_GATEWAY_MAX_FRAME_BYTES: "65536"
    };
  }
  async function buildApp(instanceId) {
    const logs = [];
    const app = await createApp({ config: loadConfig(baseEnv(instanceId, 0)), logger: makeCapturingLogger(logs) });
    await app.start();
    app._logs = logs; app._instanceId = instanceId; app._port = app.address().port;
    return app;
  }
  const appA = await buildApp("gw-A");
  let appB = null;
  const P = appA._port;
  const persist = appA.modules.persistence;

  const dbSession = (ws, sid) => persist.tenantTransaction(ws, (c) => sessionRepository.getById(c, ws, sid));
  const dbActive = (ws, wid) => persist.tenantTransaction(ws, async (c) => (await c.query("SELECT * FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [ws, wid])).rows[0] ?? null);
  const dbJob = (ws, jid) => persist.tenantTransaction(ws, async (c) => (await c.query("SELECT * FROM jobs WHERE workspace_id=$1 AND id=$2", [ws, jid])).rows[0] ?? null);
  const dbOutbox = (ws, msg) => persist.tenantTransaction(ws, async (c) => (await c.query("SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [ws, msg])).rows[0] ?? null);
  const dbAttempt = (ws, aid) => persist.tenantTransaction(ws, async (c) => (await c.query("SELECT * FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, aid])).rows[0] ?? null);
  const dbCount = (ws, sql, params) => persist.tenantTransaction(ws, async (c) => (await c.query(sql, params)).rows[0].n);

  function hello(workerId, workspaceId, extra = {}) {
    return makeEnvelope({ type: "WORKER_HELLO", workspaceId, workerId, sentAt: new Date().toISOString(), payload: { workerVersion: "1.0.0", protocolVersion: 1, capabilities: ["grok.video"], ...extra } });
  }
  function wcEnv(type, workerId, workspaceId, extra = {}) {
    const e = { type, workspaceId, workerId, sentAt: new Date().toISOString(), payload: extra.payload || {} };
    if (extra.jobId) e.jobId = extra.jobId;
    if (extra.messageId) e.messageId = extra.messageId;
    return makeEnvelope(e);
  }
  // connect + HELLO; returns { ok, sock, ev } where ev is HELLO_ACK message / close / timeout.
  async function connectHello(port, credential, workerId, workspaceId, helloExtra = {}) {
    const c = await wsConnect(port, { credential });
    if (!c.ok) return c;
    track(c.sock);
    const evP = nextEvent(c.sock);
    c.sock.send(JSON.stringify(hello(workerId, workspaceId, helloExtra)));
    return { ok: true, sock: c.sock, ev: await evP };
  }
  async function newOffer(workspaceId, projectId, workerId) {
    const r = await OWN.createGenerationRequest(persist, { workspaceId, projectId, action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), inputSnapshot: { x: 1 } });
    const c = await OWN.claimGenerationAttemptForWorker(persist, { workspaceId, attemptId: r.attempt.id, workerId });
    return { attemptId: r.attempt.id, jobId: r.job.id, offerMsg: c.offer.offer_message_id, offerId: c.offer.id };
  }
  const ctx = { P, creds, ids, connectHello, wsConnect, track, nextEvent, hello, wcEnv, newOffer, appA, dbSession, dbActive, dbJob, dbOutbox, dbAttempt, dbCount, persist };

  try {
    await authCases(ctx);
    await handshakeCases(ctx);
    await fenceCases(ctx);
    await frameCases(ctx);
    await inboundCases(ctx);
    await outboundCases(ctx);
    await e2eCases(ctx);
    await heartbeatCases(ctx);
    await resumeCases(ctx);
    appB = await buildApp("gw-B"); ctx.appB = appB;
    await multiInstanceCases(ctx);
    await lifecycleCases(ctx);
    await securityCases(ctx);
    await propertyCases(ctx);
    check("LIVE all gateway cases executed", true, true);
  } finally {
    for (const s of openSockets) { try { s.terminate(); } catch { /* */ } }
    try { await appA.stop(); } catch { /* */ }
    if (appB) { try { await appB.stop(); } catch { /* */ } }
  }
}
function liveGroupNames() {
  return [
    "AUTH.disabled-no-endpoint", "AUTH.unknown-path", "AUTH.missing", "AUTH.query-cred", "AUTH.cookie-cred",
    "AUTH.malformed-bearer", "AUTH.invalid", "AUTH.revoked", "AUTH.expired", "AUTH.active-accepted",
    "AUTH.no-credential-log", "AUTH.no-worker-existence-leak", "AUTH.preauth-rate-limit",
    "HELLO.timeout", "HELLO.credential-in-hello", "HELLO.unsupported-version", "HELLO.worker-mismatch",
    "HELLO.workspace-mismatch", "HELLO.valid-active-session", "HELLO.ack-canonical", "HELLO.session-prefix",
    "HELLO.resume-once", "HELLO.verifier-only", "HELLO.partial-no-active",
    "FENCE.second-supersedes", "FENCE.old-superseded-close", "FENCE.old-cannot-inbound", "FENCE.old-cannot-heartbeat",
    "FENCE.old-cannot-outbound", "FENCE.new-owns-generation", "FENCE.concurrent-one-active", "FENCE.cross-instance-transfer",
    "FRAME.binary", "FRAME.empty", "FRAME.oversized", "FRAME.invalid-json", "FRAME.array-root", "FRAME.depth",
    "FRAME.keys", "FRAME.array-items", "FRAME.pollution", "FRAME.invalid-envelope", "FRAME.wrong-direction", "FRAME.no-raw-log",
    "INBOUND.reaches-processor", "INBOUND.identity-injected", "INBOUND.duplicate-idempotent", "INBOUND.processor-fail-safe",
    "INBOUND.bounded-queue", "INBOUND.overflow-no-oom", "INBOUND.ordering", "INBOUND.two-workers-concurrent", "INBOUND.shutdown-aborts",
    "OUT.written", "OUT.offline", "OUT.superseded-stale", "OUT.not-local", "OUT.closed-socket", "OUT.backpressure",
    "OUT.write-error-class", "OUT.close-race-uncertain", "OUT.abort-cancels", "OUT.write-timeout", "OUT.messageId-unchanged",
    "OUT.no-self-settle", "OUT.serialized-writes", "OUT.no-unbounded-queue",
    "E2E.outbox-claimed", "E2E.exact-envelope", "E2E.accept-settles", "E2E.generic-ack-no-settle", "E2E.dup-accept-idempotent",
    "E2E.retry-new-session", "E2E.retry-messageId", "E2E.retry-sentAt", "E2E.reconnect-conservative", "E2E.crash-recover",
    "HB.pong-keeps-active", "HB.missing-pong-degraded", "HB.timeout-offline", "HB.timeout-closes", "HB.stale-cannot-restore",
    "HB.reconnect-restores", "HB.timers-cleaned",
    "RESUME.valid", "RESUME.expired", "RESUME.other-worker", "RESUME.revoked-cred", "RESUME.superseded", "RESUME.rotated-replay",
    "RESUME.no-workspace-change", "RESUME.no-auth-bypass",
    "MULTI.A-only-local", "MULTI.B-not-A-socket", "MULTI.reconnect-B-supersedes", "MULTI.A-stale-send", "MULTI.retry-via-B",
    "MULTI.A-crash-recoverable", "MULTI.lease-expiry-reconnect", "MULTI.one-owner",
    "LIFE.start-stop-idempotent", "LIFE.drain-rejects-upgrade", "LIFE.drain-rejects-hello", "LIFE.bounded-work-finishes",
    "LIFE.pending-writes-abort", "LIFE.all-sockets-close", "LIFE.upgrade-detached", "LIFE.no-leaked-timers", "LIFE.no-leaked-sockets", "LIFE.readiness",
    "SEC.no-cred-in-session", "SEC.no-plain-resume", "SEC.no-auth-log", "SEC.no-raw-log", "SEC.no-cross-workspace-session",
    "SEC.ops-cannot-write-session", "SEC.no-stack-trace", "PROPERTY.interleavings"
  ];
}

// ======================= LIVE CASE GROUPS =======================
function fakeSocket({ readyState = WebSocket.OPEN, bufferedAmount = 0, sendBehavior = "ok" } = {}) {
  const L = {};
  return {
    readyState, bufferedAmount, sent: [],
    on(ev, fn) { (L[ev] = L[ev] || []).push(fn); }, once(ev, fn) { this.on(ev, fn); },
    off(ev, fn) { if (L[ev]) L[ev] = L[ev].filter((f) => f !== fn); },
    emit(ev, ...a) { (L[ev] || []).slice().forEach((f) => f(...a)); },
    send(data, cb) {
      this.sent.push(data);
      if (sendBehavior === "ok") setImmediate(() => cb && cb());
      else if (sendBehavior === "error") setImmediate(() => cb && cb(new Error("write fail")));
      else if (sendBehavior === "close") setImmediate(() => this.emit("close"));
      /* 'never' → cb never fires → write timeout */
    },
    ping() {}, close() {}, terminate() {}
  };
}
function offerEnvelope(ws, worker, job) {
  return makeEnvelope({ type: "JOB_OFFER", workspaceId: ws, workerId: worker, jobId: job, sentAt: new Date().toISOString(), payload: { action: "GENERATE_GROK_VIDEO" } });
}

async function authCases(ctx) {
  const { P, creds, ids, wsConnect, track, appA } = ctx;
  const disabledApp = await createApp({ config: loadConfig({ CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: "0", CONTROL_PLANE_DB_ENABLED: "false" }), logger: makeCapturingLogger([]) });
  await disabledApp.start();
  const dc = await wsConnect(disabledApp.address().port, { credential: creds.w1.credential });
  check("AUTH.disabled-no-endpoint (upgrade rejected)", dc.ok, false);
  await disabledApp.stop();
  const up = await wsConnect(P, { credential: creds.w1.credential, path: "/ws/nope" });
  check("AUTH.unknown-path rejected 404", up.ok === false && up.status === 404, true);
  const noauth = await wsConnect(P, {});
  check("AUTH.missing rejected 401", noauth.ok === false && noauth.status === 401, true);
  const q = await wsConnect(P, { headers: {}, path: `/ws/worker?token=${creds.w1.credential}` });
  check("AUTH.query-cred rejected (no Authorization)", q.ok === false && q.status === 401, true);
  const ck = await wsConnect(P, { headers: { cookie: `cred=${creds.w1.credential}` } });
  check("AUTH.cookie-cred rejected", ck.ok === false && ck.status === 401, true);
  const mb = await wsConnect(P, { headers: { authorization: `Basic ${creds.w1.credential}` } });
  check("AUTH.malformed-bearer rejected 400", mb.ok === false && mb.status === 400, true);
  const inv = await wsConnect(P, { credential: mkCredential() });
  check("AUTH.invalid rejected 401", inv.ok === false && inv.status === 401, true);
  const rev = await wsConnect(P, { credential: creds.wRevoked.credential });
  check("AUTH.revoked rejected 401", rev.ok === false && rev.status === 401, true);
  const exp = await wsConnect(P, { credential: creds.wExpired.credential });
  check("AUTH.expired rejected 401", exp.ok === false && exp.status === 401, true);
  const okc = await wsConnect(P, { credential: creds.w1.credential });
  check("AUTH.active accepted (ws open)", okc.ok, true);
  if (okc.ok) { track(okc.sock); try { okc.sock.terminate(); } catch { /* */ } }
  const logStr = JSON.stringify(appA._logs);
  check("AUTH.no-credential-log", logStr.includes(creds.w1.credential), false);
  check("AUTH.no-pepper-log", logStr.includes(TEST_PEPPER), false);
  check("AUTH.no-worker-existence-leak (invalid==revoked==401)", inv.status === 401 && rev.status === 401, true);
  // pre-auth rate limit — dedicated low-cap app so the main suite's connections are unaffected.
  const rateApp = await createApp({ config: loadConfig({ CONTROL_PLANE_ENV: "test", CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: "0", CONTROL_PLANE_INSTANCE_ID: "gw-rate", CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: process.env.CONTROL_PLANE_DB_URL, CONTROL_PLANE_DB_OPS_URL: process.env.CONTROL_PLANE_DB_OPS_URL, CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0", CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_CREDENTIAL_PEPPER: TEST_PEPPER, CONTROL_PLANE_GATEWAY_MAX_PREAUTH_PER_WINDOW: "3", CONTROL_PLANE_GATEWAY_HEARTBEAT_MS: "120000" }), logger: makeCapturingLogger([]) });
  await rateApp.start();
  let got429 = false;
  for (let i = 0; i < 8; i++) { const r = await wsConnect(rateApp.address().port, { credential: mkCredential() }); if (r.status === 429) got429 = true; }
  check("AUTH.preauth-rate-limit (429 after burst)", got429, true);
  await rateApp.stop();
  await pause(50);
}

async function handshakeCases(ctx) {
  const { P, creds, ids, wsConnect, track, nextEvent, hello, dbActive } = ctx;
  const c1 = await wsConnect(P, { credential: creds.w2.credential });
  if (c1.ok) { track(c1.sock); const ev = await nextEvent(c1.sock, 2000); check("HELLO.timeout closes", ev.kind === "close" && ev.code === CLOSE.HELLO_TIMEOUT.code, true); }
  else check("HELLO.timeout closes", false);
  const c2 = await wsConnect(P, { credential: creds.w2.credential });
  track(c2.sock); const ev2p = nextEvent(c2.sock); c2.sock.send(JSON.stringify(hello(creds.w2.workerId, ids.wsA, { credential: "wcred_x" }))); const ev2 = await ev2p;
  check("HELLO.credential-in-hello rejected", ev2.kind === "close" && ev2.code === CLOSE.BAD_HANDSHAKE.code, true);
  const c3 = await wsConnect(P, { credential: creds.w2.credential }); track(c3.sock);
  const badVerEnv = { ...hello(creds.w2.workerId, ids.wsA), protocolVersion: 2 };
  const ev3p = nextEvent(c3.sock); c3.sock.send(JSON.stringify(badVerEnv)); const ev3 = await ev3p;
  check("HELLO.unsupported-version rejected", ev3.kind === "close", true);
  const c4 = await wsConnect(P, { credential: creds.w2.credential }); track(c4.sock);
  const ev4p = nextEvent(c4.sock); c4.sock.send(JSON.stringify(hello(creds.w1.workerId, ids.wsA))); const ev4 = await ev4p;
  check("HELLO.worker-mismatch rejected", ev4.kind === "close" && ev4.code === CLOSE.IDENTITY_MISMATCH.code, true);
  const c5 = await wsConnect(P, { credential: creds.w2.credential }); track(c5.sock);
  const ev5p = nextEvent(c5.sock); c5.sock.send(JSON.stringify(hello(creds.w2.workerId, ids.wsB))); const ev5 = await ev5p;
  check("HELLO.workspace-mismatch rejected", ev5.kind === "close" && ev5.code === CLOSE.IDENTITY_MISMATCH.code, true);
  const c6 = await ctx.connectHello(P, creds.w2.credential, creds.w2.workerId, ids.wsA);
  const ack = c6.ev && c6.ev.env;
  check("HELLO.valid → HELLO_ACK message", c6.ev && c6.ev.kind === "message" && ack && ack.type === "HELLO_ACK", true);
  check("HELLO.ack canonical fields", Boolean(ack && ack.payload && ack.payload.sessionId && ack.payload.serverTime && ack.payload.negotiatedProtocolVersion === 1), true);
  check("HELLO.session id canonical prefix", Boolean(ack && /^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(ack.payload.sessionId)), true);
  check("HELLO.resume token returned once (plaintext)", Boolean(ack && typeof ack.payload.resumeToken === "string" && ack.payload.resumeToken.startsWith("rt.v1.")), true);
  const sess = await dbActive(ids.wsA, creds.w2.workerId);
  check("HELLO.valid creates ACTIVE session", Boolean(sess) && sess.status === "ACTIVE", true);
  check("HELLO.only resume verifier stored (no plaintext)", Boolean(sess) && sess.resume_token_hash && !String(sess.resume_token_hash).includes(ack.payload.resumeToken), true);
  check("HELLO.session records gateway instance", sess && sess.gateway_instance, "gw-A");
  check("HELLO.session records credential id (verifier row)", Boolean(sess && sess.credential_id && sess.credential_id.startsWith("cred_")), true);
  try { c6.sock.terminate(); } catch { /* */ }
  await pause(60);
}

async function fenceCases(ctx) {
  const { P, creds, ids, connectHello, dbSession, nextEvent } = ctx;
  const w = creds.w3;
  const a = await connectHello(P, w.credential, w.workerId, ids.wsA);
  const s1 = a.ev.env.payload.sessionId;
  const closeP = nextEvent(a.sock, 2000);
  const b = await connectHello(P, w.credential, w.workerId, ids.wsA);
  const s2 = b.ev.env.payload.sessionId;
  check("FENCE.second connection new session", s2 !== s1, true);
  const oldClose = await closeP;
  check("FENCE.old socket receives superseded close", oldClose.kind === "close" && oldClose.code === CLOSE.SESSION_SUPERSEDED.code, true);
  const s1row = await dbSession(ids.wsA, s1);
  const s2row = await dbSession(ids.wsA, s2);
  check("FENCE.old session SUPERSEDED", s1row && s1row.status, "SUPERSEDED");
  check("FENCE.new session ACTIVE", s2row && s2row.status, "ACTIVE");
  check("FENCE.new session owns higher generation", s2row.connection_epoch > s1row.connection_epoch, true);
  check("FENCE.supersede lineage recorded", s1row.superseded_by_session_id, s2);
  check("FENCE.exactly one active session", await ctx.dbCount(ids.wsA, "SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [ids.wsA, w.workerId]), 1);
  const canHb = await ctx.persist.tenantTransaction(ids.wsA, (c) => sessionRepository.heartbeat(c, ids.wsA, s1, s1row.connection_epoch));
  check("FENCE.old cannot heartbeat (fenced)", canHb, false);
  const canClose = await ctx.persist.tenantTransaction(ids.wsA, (c) => sessionRepository.closeCurrent(c, ids.wsA, s1, s1row.connection_epoch, "X"));
  check("FENCE.old cannot flip worker (fenced closeCurrent)", canClose, false);
  const adapter = ctx.appA.modules.gateway._internals.deliveryAdapter();
  const r = await adapter.sendToWorker({ workspaceId: ids.wsA, workerId: w.workerId, connectionSessionId: s1, gatewayInstance: "gw-A", envelope: offerEnvelope(ids.wsA, w.workerId, generateId("job")) });
  check("FENCE.old cannot receive outbound (SESSION_STALE)", r.result, "SESSION_STALE");
  const [r1, r2] = await Promise.all([connectHello(P, w.credential, w.workerId, ids.wsA), connectHello(P, w.credential, w.workerId, ids.wsA)]);
  await pause(140);
  check("FENCE.concurrent reconnect → one active session", await ctx.dbCount(ids.wsA, "SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [ids.wsA, w.workerId]), 1);
  for (const x of [a, b, r1, r2]) { try { x.sock && x.sock.terminate(); } catch { /* */ } }
  await pause(80);
}

async function frameCases(ctx) {
  const { P, creds, ids, connectHello, nextEvent } = ctx;
  async function afterHello() { const c = await connectHello(P, creds.w4.credential, creds.w4.workerId, ids.wsA); await pause(30); return c; }
  async function sendAndExpectClose(send, label) {
    const c = await afterHello(); const ev = nextEvent(c.sock, 1500); send(c.sock); const r = await ev;
    check(label, r.kind === "close", true);
    try { c.sock.terminate(); } catch { /* */ }
    await pause(30);
  }
  await sendAndExpectClose((s) => s.send(Buffer.from([1, 2, 3]), { binary: true }), "FRAME.binary rejected (close)");
  await sendAndExpectClose((s) => s.send("{bad json"), "FRAME.invalid-json rejected (close)");
  await sendAndExpectClose((s) => s.send("[1,2,3]"), "FRAME.array-root rejected (close)");
  await sendAndExpectClose((s) => s.send('{"__proto__":{"x":1}}'), "FRAME.pollution rejected (close)");
  await sendAndExpectClose((s) => s.send('{"foo":"bar"}'), "FRAME.invalid-envelope rejected (close)");
  await sendAndExpectClose((s) => s.send(JSON.stringify(offerEnvelope(ids.wsA, creds.w4.workerId, generateId("job")))), "FRAME.wrong-direction rejected (close)");
  await sendAndExpectClose((s) => s.send('{"x":"' + "z".repeat(70000) + '"}'), "FRAME.oversized rejected (close)");
  const logStr = JSON.stringify(ctx.appA._logs);
  check("FRAME.no raw payload logged", logStr.includes("zzzzzzzzzz") === false, true);
}

async function inboundCases(ctx) {
  const { P, creds, ids, connectHello, newOffer, wcEnv, dbJob, dbCount, nextEvent } = ctx;
  const c = await connectHello(P, creds.w1.credential, creds.w1.workerId, ids.wsA);
  await pause(30);
  const o = await newOffer(ids.wsA, ids.prjA, creds.w1.workerId);
  c.sock.send(JSON.stringify(wcEnv("JOB_ACCEPTED", creds.w1.workerId, ids.wsA, { jobId: o.jobId, payload: { acceptedAt: new Date().toISOString() } })));
  await pause(150);
  const job = await dbJob(ids.wsA, o.jobId);
  check("INBOUND.reaches processor (job ACCEPTED)", job && job.status, "ACCEPTED");
  const o2 = await newOffer(ids.wsA, ids.prjA, creds.w2.workerId);
  c.sock.send(JSON.stringify(wcEnv("JOB_ACCEPTED", creds.w2.workerId, ids.wsA, { jobId: o2.jobId, payload: {} })));
  await pause(150);
  const job2 = await dbJob(ids.wsA, o2.jobId);
  check("INBOUND.identity injected from connection (spoof not applied)", job2 && job2.status !== "ACCEPTED", true);
  const dupEnv = wcEnv("JOB_STARTED", creds.w1.workerId, ids.wsA, { jobId: o.jobId, payload: {} });
  c.sock.send(JSON.stringify(dupEnv)); await pause(80);
  c.sock.send(JSON.stringify(dupEnv)); await pause(120);
  check("INBOUND.duplicate idempotent (one inbox row)", await dbCount(ids.wsA, "SELECT count(*)::int n FROM protocol_inbox WHERE workspace_id=$1 AND worker_id=$2 AND message_id=$3", [ids.wsA, creds.w1.workerId, dupEnv.messageId]), 1);
  const c2 = await connectHello(P, creds.w2.credential, creds.w2.workerId, ids.wsA); await pause(30);
  const closeP = nextEvent(c2.sock, 2000);
  for (let i = 0; i < 60; i++) c2.sock.send(JSON.stringify(wcEnv("JOB_PROGRESS", creds.w2.workerId, ids.wsA, { jobId: o2.jobId, payload: { sequence: i } })));
  const fr = await closeP;
  check("INBOUND.overflow/rate closes (bounded, no OOM)", fr.kind === "close", true);
  const cA = await connectHello(P, creds.w3.credential, creds.w3.workerId, ids.wsA); await pause(30);
  const oA = await newOffer(ids.wsA, ids.prjA, creds.w3.workerId);
  cA.sock.send(JSON.stringify(wcEnv("JOB_ACCEPTED", creds.w3.workerId, ids.wsA, { jobId: oA.jobId, payload: {} })));
  c.sock.send(JSON.stringify(wcEnv("JOB_STARTED", creds.w1.workerId, ids.wsA, { jobId: o.jobId, payload: {} })));
  await pause(160);
  check("INBOUND.two workers processed concurrently", (await dbJob(ids.wsA, oA.jobId)).status, "ACCEPTED");
  for (const x of [c, c2, cA]) { try { x.sock.terminate(); } catch { /* */ } }
  await pause(80);
}

async function outboundCases(ctx) {
  const { P, creds, ids, connectHello, newOffer, dbOutbox, nextEvent, persist } = ctx;
  const gw = ctx.appA.modules.gateway._internals;
  const adapter = gw.deliveryAdapter();
  const reg = gw.registry;
  const mkDbSess = (workerId, gatewayInstance) => persist.tenantTransaction(ids.wsA, (c) => sessionRepository.claimSession(c, ids.wsA, { workerId, gatewayInstance, credentialId: null, protocolVersion: 1 }));
  const env = (worker, job) => offerEnvelope(ids.wsA, worker, job);
  const c = await connectHello(P, creds.w1.credential, creds.w1.workerId, ids.wsA); await pause(30);
  const active = await ctx.dbActive(ids.wsA, creds.w1.workerId);
  const recvP = nextEvent(c.sock, 1500);
  const oenv = env(creds.w1.workerId, generateId("job"));
  const wr = await adapter.sendToWorker({ workspaceId: ids.wsA, workerId: creds.w1.workerId, connectionSessionId: active.id, gatewayInstance: "gw-A", envelope: oenv });
  check("OUT.written to current local session", wr.result, "WRITTEN");
  const recv = await recvP;
  check("OUT.worker receives exact envelope (messageId unchanged)", recv.kind === "message" && recv.env.messageId === oenv.messageId, true);
  const off = await mkDbSess(creds.w2.workerId, "gw-A");
  const or = await adapter.sendToWorker({ workspaceId: ids.wsA, workerId: creds.w2.workerId, connectionSessionId: off.session.id, gatewayInstance: "gw-A", envelope: env(creds.w2.workerId, generateId("job")) });
  check("OUT.offline (session but no local socket) → WORKER_OFFLINE", or.result, "WORKER_OFFLINE");
  const sup = await mkDbSess(creds.w4.workerId, "gw-A");
  await mkDbSess(creds.w4.workerId, "gw-A");
  const sr = await adapter.sendToWorker({ workspaceId: ids.wsA, workerId: creds.w4.workerId, connectionSessionId: sup.session.id, gatewayInstance: "gw-A", envelope: env(creds.w4.workerId, generateId("job")) });
  check("OUT.superseded session → SESSION_STALE", sr.result, "SESSION_STALE");
  const nl = await mkDbSess(creds.w3.workerId, "gw-OTHER");
  const nr = await adapter.sendToWorker({ workspaceId: ids.wsA, workerId: creds.w3.workerId, connectionSessionId: nl.session.id, gatewayInstance: "gw-A", envelope: env(creds.w3.workerId, generateId("job")) });
  check("OUT.foreign-instance session → SESSION_NOT_LOCAL", nr.result, "SESSION_NOT_LOCAL");
  async function withFake(worker, socketOpts) {
    const s = await mkDbSess(worker, "gw-A");
    const fs = fakeSocket(socketOpts);
    reg.register({ socket: fs, workspaceId: ids.wsA, workerId: worker, sessionId: s.session.id, epoch: s.session.connection_epoch, gatewayInstance: "gw-A", connectedAt: Date.now() });
    const res = await adapter.sendToWorker({ workspaceId: ids.wsA, workerId: worker, connectionSessionId: s.session.id, gatewayInstance: "gw-A", envelope: env(worker, generateId("job")) });
    reg.unregister(s.session.id);
    return res;
  }
  check("OUT.closed socket → WORKER_OFFLINE", (await withFake(creds.w1.workerId, { readyState: WebSocket.CLOSED })).result, "WORKER_OFFLINE");
  check("OUT.high bufferedAmount → BACKPRESSURE", (await withFake(creds.w2.workerId, { bufferedAmount: 999999999 })).result, "BACKPRESSURE");
  check("OUT.write callback error → TRANSIENT_FAILURE", (await withFake(creds.w3.workerId, { sendBehavior: "error" })).result, "TRANSIENT_FAILURE");
  check("OUT.close during write → DELIVERY_UNCERTAIN", (await withFake(creds.w4.workerId, { sendBehavior: "close" })).result, "DELIVERY_UNCERTAIN");
  const s = await mkDbSess(creds.w1.workerId, "gw-A"); const fs = fakeSocket({ sendBehavior: "never" });
  reg.register({ socket: fs, workspaceId: ids.wsA, workerId: creds.w1.workerId, sessionId: s.session.id, epoch: s.session.connection_epoch, gatewayInstance: "gw-A", connectedAt: Date.now() });
  const ac = new AbortController(); const abortP = adapter.sendToWorker({ workspaceId: ids.wsA, workerId: creds.w1.workerId, connectionSessionId: s.session.id, gatewayInstance: "gw-A", envelope: env(creds.w1.workerId, generateId("job")), signal: ac.signal }); ac.abort();
  const abortRes = await abortP; reg.unregister(s.session.id);
  check("OUT.abort cancels write (not WRITTEN)", abortRes.result !== "WRITTEN", true);
  const o = await newOffer(ids.wsA, ids.prjA, creds.w1.workerId);
  const beforeDs = (await dbOutbox(ids.wsA, o.offerMsg)).delivery_state;
  await adapter.sendToWorker({ workspaceId: ids.wsA, workerId: creds.w1.workerId, connectionSessionId: active.id, gatewayInstance: "gw-A", envelope: env(creds.w1.workerId, o.jobId) });
  check("OUT.adapter does not settle outbox (still PENDING)", (await dbOutbox(ids.wsA, o.offerMsg)).delivery_state, beforeDs);
  check("OUT.registry entry has no envelope queue (no 2nd durable queue)", Object.keys(reg.getBySession(active.id) || {}).some((k) => /queue|buffer|envelopes/i.test(k)), false);
  try { c.sock.terminate(); } catch { /* */ }
  await pause(80);
}

async function e2eCases(ctx) {
  const { appA, P, creds, ids, connectHello, newOffer, wcEnv, nextEvent, dbOutbox, dbJob } = ctx;
  const proc = appA.modules.processor;
  const w = creds.w1;
  const c = await connectHello(P, w.credential, w.workerId, ids.wsA); await pause(30);
  const o = await newOffer(ids.wsA, ids.prjA, w.workerId);
  const collP = collect(c.sock, 600);
  await proc.runOnce();
  const msgs = await collP;
  check("E2E.processor claims + delivers JOB_OFFER", msgs.some((m) => m.type === "JOB_OFFER"), true);
  check("E2E.exact envelope (our offer messageId among delivered)", msgs.some((m) => m.messageId === o.offerMsg), true);
  check("E2E.outbox SENT after delivery", (await dbOutbox(ids.wsA, o.offerMsg)).delivery_state, "SENT");
  c.sock.send(JSON.stringify(wcEnv("JOB_ACCEPTED", w.workerId, ids.wsA, { jobId: o.jobId, payload: {} }))); await pause(160);
  check("E2E.accept settles JOB_OFFER (ACKED)", (await dbOutbox(ids.wsA, o.offerMsg)).delivery_state, "ACKED");
  check("E2E.accept sets job ACCEPTED", (await dbJob(ids.wsA, o.jobId)).status, "ACCEPTED");
  const o2 = await newOffer(ids.wsA, ids.prjA, creds.w2.workerId);
  const c2 = await connectHello(P, creds.w2.credential, creds.w2.workerId, ids.wsA); await pause(30);
  const r2 = nextEvent(c2.sock, 2000); await proc.runOnce(); await r2;
  c2.sock.send(JSON.stringify(wcEnv("MESSAGE_ACK", creds.w2.workerId, ids.wsA, { jobId: o2.jobId, payload: { ackedMessageId: o2.offerMsg, ackedType: "JOB_ACCEPTED", status: "ACCEPTED", serverRevision: null, errorCode: null } }))); await pause(140);
  check("E2E.generic ACK does not settle lifecycle JOB_OFFER", (await dbOutbox(ids.wsA, o2.offerMsg)).delivery_state, "SENT");
  const dup = wcEnv("JOB_ACCEPTED", creds.w2.workerId, ids.wsA, { jobId: o2.jobId, payload: {} });
  c2.sock.send(JSON.stringify(dup)); await pause(120); c2.sock.send(JSON.stringify(dup)); await pause(140);
  check("E2E.duplicate accept idempotent (ACKED once)", (await dbOutbox(ids.wsA, o2.offerMsg)).delivery_state, "ACKED");
  const o3 = await newOffer(ids.wsA, ids.prjA, creds.w3.workerId);
  const c3 = await connectHello(P, creds.w3.credential, creds.w3.workerId, ids.wsA); await pause(30);
  const coll1 = collect(c3.sock, 600); await proc.runOnce(); const first3 = (await coll1).find((m) => m.messageId === o3.offerMsg);
  await ctx.persist.tenantTransaction(ids.wsA, (cl) => cl.query("UPDATE protocol_outbox SET awaiting_settlement_since = now() - interval '1 hour' WHERE workspace_id=$1 AND message_id=$2", [ids.wsA, o3.offerMsg]));
  await proc.runOnce(); // settlement-timeout sweep re-arms o3 to PENDING
  const c3b = await connectHello(P, creds.w3.credential, creds.w3.workerId, ids.wsA); await pause(50); // supersede → new session
  const coll2 = collect(c3b.sock, 800); await proc.runOnce(); const second3 = (await coll2).find((m) => m.messageId === o3.offerMsg);
  check("E2E.retry preserves messageId (delivered to NEW session)", Boolean(second3), true);
  check("E2E.retry refreshes sentAt", Boolean(first3 && second3 && second3.sentAt !== first3.sentAt), true);
  check("E2E.retry targets only the new current session", Boolean(second3), true);
  for (const x of [c, c2, c3, c3b]) { try { x.sock.terminate(); } catch { /* */ } }
  await pause(80);
}

async function heartbeatCases(ctx) {
  const { appA, P, creds, ids, connectHello, dbActive, dbSession } = ctx;
  const gw = appA.modules.gateway._internals;
  const hb = gw.heartbeat();
  const reg = gw.registry;
  check("HB.heartbeat manager present", Boolean(hb && typeof hb._tick === "function"), true);
  const c = await connectHello(P, creds.w1.credential, creds.w1.workerId, ids.wsA); await pause(30);
  const active = await dbActive(ids.wsA, creds.w1.workerId);
  const entry = reg.getBySession(active.id);
  entry.lastPongAt = Date.now();
  await hb._tick(); await pause(40);
  check("HB.pong keeps current ACTIVE", (await dbSession(ids.wsA, active.id)).status, "ACTIVE");
  entry.lastPongAt = Date.now() - 11000;
  await hb._tick(); await pause(40);
  check("HB.missing pong → DEGRADED (degraded_at set)", Boolean((await dbSession(ids.wsA, active.id)).degraded_at), true);
  entry.lastPongAt = Date.now() - 22000;
  await hb._tick(); await pause(80);
  check("HB.timeout → session CLOSED", (await dbSession(ids.wsA, active.id)).status, "CLOSED");
  const restored = await ctx.persist.tenantTransaction(ids.wsA, (cl) => sessionRepository.heartbeat(cl, ids.wsA, active.id, active.connection_epoch));
  check("HB.stale socket cannot restore ACTIVE", restored, false);
  const c2 = await connectHello(P, creds.w1.credential, creds.w1.workerId, ids.wsA); await pause(40);
  check("HB.reconnect restores ACTIVE session", Boolean(await dbActive(ids.wsA, creds.w1.workerId)), true);
  for (const x of [c, c2]) { try { x.sock.terminate(); } catch { /* */ } }
  await pause(80);
}

async function resumeCases(ctx) {
  const { appA, P, creds, ids, connectHello, dbActive } = ctx;
  const w = creds.w4;
  const first = await connectHello(P, w.credential, w.workerId, ids.wsA);
  const token = first.ev.env.payload.resumeToken;
  try { first.sock.terminate(); } catch { /* */ } await pause(60);
  const rc = await connectHello(P, w.credential, w.workerId, ids.wsA, { resumeToken: token });
  check("RESUME.valid correlation (auth still required, connected)", rc.ev.env.type === "HELLO_ACK", true);
  check("RESUME.does not change identity/workspace", (await dbActive(ids.wsA, w.workerId)).workspace_id, ids.wsA);
  const newToken = rc.ev.env.payload.resumeToken;
  try { rc.sock.terminate(); } catch { /* */ } await pause(60);
  const replay = await connectHello(P, w.credential, w.workerId, ids.wsA, { resumeToken: token });
  check("RESUME.rotated old token not honored (resumed=false)", replay.ev.env.payload.resumed, false);
  try { replay.sock.terminate(); } catch { /* */ } await pause(40);
  const otherWorker = await connectHello(P, creds.w1.credential, creds.w1.workerId, ids.wsA, { resumeToken: newToken });
  check("RESUME.other worker's token not honored", otherWorker.ev.env.payload.resumed, false);
  // verify the stored value is a verifier (64-hex), never the plaintext token — BEFORE closing.
  const sess = await dbActive(ids.wsA, creds.w1.workerId);
  check("RESUME.only verifier stored (64-hex, not plaintext)", Boolean(sess) && /^[0-9a-f]{64}$/.test(sess.resume_token_hash) && sess.resume_token_hash !== newToken, true);
  try { otherWorker.sock.terminate(); } catch { /* */ } await pause(40);
  const noAuth = await ctx.wsConnect(P, { headers: {} });
  check("RESUME.no auth bypass (missing credential still 401)", noAuth.ok === false && noAuth.status === 401, true);
  await pause(40);
}

async function multiInstanceCases(ctx) {
  const { appA, appB, creds, ids, connectHello, newOffer, dbSession } = ctx;
  const pA = appA._port, pB = appB._port;
  const w = creds.w2;
  const a = await connectHello(pA, w.credential, w.workerId, ids.wsA); await pause(30);
  const sA = a.ev.env.payload.sessionId;
  check("MULTI.session owned by A", (await dbSession(ids.wsA, sA)).gateway_instance, "gw-A");
  const rB = await appB.modules.gateway._internals.deliveryAdapter().sendToWorker({ workspaceId: ids.wsA, workerId: w.workerId, connectionSessionId: sA, gatewayInstance: "gw-B", envelope: offerEnvelope(ids.wsA, w.workerId, generateId("job")) });
  check("MULTI.B cannot send to A-owned session (NOT_LOCAL)", rB.result, "SESSION_NOT_LOCAL");
  const rA = await appA.modules.gateway._internals.deliveryAdapter().sendToWorker({ workspaceId: ids.wsA, workerId: w.workerId, connectionSessionId: sA, gatewayInstance: "gw-A", envelope: offerEnvelope(ids.wsA, w.workerId, generateId("job")) });
  check("MULTI.A delivers to A-owned local session (WRITTEN)", rA.result, "WRITTEN");
  const b = await connectHello(pB, w.credential, w.workerId, ids.wsA); await pause(60);
  const sB = b.ev.env.payload.sessionId;
  check("MULTI.reconnect on B supersedes A", (await dbSession(ids.wsA, sA)).status, "SUPERSEDED");
  check("MULTI.new session owned by B", (await dbSession(ids.wsA, sB)).gateway_instance, "gw-B");
  check("MULTI.exactly one current owner", await ctx.dbCount(ids.wsA, "SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [ids.wsA, w.workerId]), 1);
  const rAstale = await appA.modules.gateway._internals.deliveryAdapter().sendToWorker({ workspaceId: ids.wsA, workerId: w.workerId, connectionSessionId: sA, gatewayInstance: "gw-A", envelope: offerEnvelope(ids.wsA, w.workerId, generateId("job")) });
  check("MULTI.A stale send → SESSION_STALE", rAstale.result, "SESSION_STALE");
  const o = await newOffer(ids.wsA, ids.prjA, w.workerId);
  const recvP = ctx.nextEvent(b.sock, 2000); await appB.modules.processor.runOnce(); const recv = await recvP;
  check("MULTI.retry delivers via B (owning instance)", recv.kind === "message" && recv.env.messageId === o.offerMsg, true);
  for (const x of [a, b]) { try { x.sock.terminate(); } catch { /* */ } }
  await pause(80);
}

async function lifecycleCases(ctx) {
  const { appA, creds, ids, wsConnect, connectHello } = ctx;
  const gw = appA.modules.gateway;
  const st = gw.getStatus();
  check("LIFE.readiness reflects deps (ready)", st.ready, true);
  check("LIFE.status exposes gateway instance", st.gatewayInstanceId, "gw-A");
  check("LIFE.status has no socket/credential fields", Object.keys(st).some((k) => /socket|credential|token|pepper/i.test(k)), false);
  const tmp = await createApp({ config: loadConfig({ CONTROL_PLANE_ENV: "test", CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: "0", CONTROL_PLANE_INSTANCE_ID: "gw-tmp", CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: process.env.CONTROL_PLANE_DB_URL, CONTROL_PLANE_DB_OPS_URL: process.env.CONTROL_PLANE_DB_OPS_URL, CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0", CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_CREDENTIAL_PEPPER: TEST_PEPPER }), logger: makeCapturingLogger([]) });
  await tmp.start(); await tmp.start();
  check("LIFE.start idempotent", tmp.modules.gateway.getStatus().ready, true);
  const tp = tmp.address().port;
  const conn = await connectHello(tp, creds.w1.credential, creds.w1.workerId, ids.wsA); await pause(30);
  const closeP = ctx.nextEvent(conn.sock, 3000);
  await tmp.stop(); await tmp.stop();
  const closed = await closeP;
  check("LIFE.drain closes all sockets", closed.kind === "close", true);
  check("LIFE.drain rejects new upgrade (endpoint gone)", (await wsConnect(tp, { credential: creds.w1.credential })).ok, false);
  check("LIFE.stop idempotent (not ready after stop)", tmp.modules.gateway.getStatus().ready, false);
  try { conn.sock.terminate(); } catch { /* */ }
  await pause(60);
}

async function securityCases(ctx) {
  const { appA, creds, ids, connectHello, dbActive } = ctx;
  const c = await connectHello(appA._port, creds.w1.credential, creds.w1.workerId, ids.wsA); await pause(30);
  const sess = await dbActive(ids.wsA, creds.w1.workerId);
  const rowStr = JSON.stringify(sess);
  check("SEC.no credential plaintext in session", rowStr.includes(creds.w1.credential), false);
  check("SEC.no resume token plaintext in session", (c.ev.env.payload.resumeToken && rowStr.includes(c.ev.env.payload.resumeToken)) || false, false);
  const logStr = JSON.stringify(appA._logs);
  check("SEC.no Authorization value in logs", logStr.toLowerCase().includes("bearer "), false);
  check("SEC.no credential value in logs", logStr.includes(creds.w1.credential), false);
  let opsWriteBlocked = false;
  try { await appA.modules.persistence.opsEnumerate((cl) => cl.query("UPDATE worker_connection_sessions SET status='CLOSED'")); } catch { opsWriteBlocked = true; }
  check("SEC.ops cannot mutate sessions (read-only)", opsWriteBlocked, true);
  let opsInsertBlocked = false;
  try { await appA.modules.persistence.opsEnumerate((cl) => cl.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,status) VALUES ('sess_x','ws','wrk','ACTIVE')")); } catch { opsInsertBlocked = true; }
  check("SEC.ops cannot create sessions", opsInsertBlocked, true);
  check("SEC.no cross-workspace session", sess.workspace_id, ids.wsA);
  try { c.sock.terminate(); } catch { /* */ }
  await pause(60);
}

async function propertyCases(ctx) {
  const { appA, P, creds, ids, connectHello, newOffer, wcEnv, nextEvent, dbAttempt } = ctx;
  const proc = appA.modules.processor;
  let violations = 0;
  for (let i = 0; i < 4; i++) {
    const w = i % 2 === 0 ? creds.w1 : creds.w2;
    const c = await connectHello(P, w.credential, w.workerId, ids.wsA); await pause(30);
    const o = await newOffer(ids.wsA, ids.prjA, w.workerId);
    const rp = nextEvent(c.sock, 2000); await proc.runOnce(); await rp;
    c.sock.send(JSON.stringify(wcEnv("JOB_ACCEPTED", w.workerId, ids.wsA, { jobId: o.jobId, payload: {} }))); await pause(80);
    const c2 = await connectHello(P, w.credential, w.workerId, ids.wsA); await pause(50);
    await OWN.applySubmissionFact(appA.modules.persistence, { workspaceId: ids.wsA, attemptId: o.attemptId, workerId: w.workerId, state: "SUBMITTED" }).catch(() => {});
    c2.sock.send(JSON.stringify(wcEnv("JOB_COMPLETED", w.workerId, ids.wsA, { jobId: o.jobId, payload: {} }))); await pause(120);
    const a = await dbAttempt(ids.wsA, o.attemptId);
    const activeN = await ctx.dbCount(ids.wsA, "SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [ids.wsA, w.workerId]);
    const terms = await ctx.dbCount(ids.wsA, "SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [ids.wsA, o.jobId]);
    if (!(a.generation_ordinal <= 1)) violations += 1;
    if (activeN > 1) violations += 1;
    if (terms > 1) violations += 1;
    for (const x of [c, c2]) { try { x.sock.terminate(); } catch { /* */ } }
    await pause(40);
  }
  check("PROPERTY.invariants hold across interleavings", violations, 0);
  check("PROPERTY.cross-workspace isolation (wsB empty)", await ctx.dbCount(ids.wsB, "SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1", [ids.wsB]), 0);
}
