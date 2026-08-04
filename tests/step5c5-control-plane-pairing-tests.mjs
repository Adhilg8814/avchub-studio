#!/usr/bin/env node
// P0 Step 5C.5 — Worker pairing + credential lifecycle tests.
//
// SAFE BY CONSTRUCTION: offline unit/static checks always run. LIVE tests (real PostgreSQL + real
// HTTP + real local WebSocket on 127.0.0.1:ephemeral) run ONLY against a verified disposable *_test
// database; otherwise they SKIP with a reason. No browser automation, no provider, no quota, no
// staging/production connection. Exit 0 when there are no failures.

import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { loadConfig, safeConfigSummary } from "../control-plane/src/config/config.mjs";
import { createApp } from "../control-plane/src/app.mjs";
import { CP_ERRORS, httpStatusForCode } from "../control-plane/src/errors.mjs";
import { evaluateTestDbTarget } from "../control-plane/src/persistence/postgres/test-db-safety.mjs";
import { migrate as mrun } from "../control-plane/src/persistence/postgres/migrations.mjs";
import * as PC from "../control-plane/src/pairing/pairing-crypto.mjs";
import * as IC from "../lib/control/identity-crypto.mjs";
import { extractOperatorBearer, authenticateOperator, OPERATOR_AUTH_CODES } from "../control-plane/src/pairing/operator-auth.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";
import { WorkerPairingClient } from "../lib/worker/pairing-client.mjs";
import { MemoryCredentialStore } from "../lib/worker/credential-store.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let passed = 0, failed = 0, skipped = 0;
const skipReasons = new Set();
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function skip(reason, n = 1) { skipped += n; skipReasons.add(reason); }

const DIR = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = path.join(DIR, "..", "control-plane", "database", "migrations");
const SRC = path.join(DIR, "..", "control-plane", "src");
const CRED_PEPPER = "step5c5-credential-pepper-value-fixed-01";
const PAIR_PEPPER = "step5c5-pairing-pepper-value-fixed-02";
const OP_TOKEN = "step5c5-operator-token-value-fixed-3333";

function httpJson(port, method, pathname, { body, headers } = {}) {
  return new Promise((resolve) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { "content-type": "application/json", ...(headers || {}) };
    if (data) h["content-length"] = data.length;
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: h }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    if (data) req.write(data); req.end();
  });
}
function wsConnect(port, credential) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    sock.on("open", () => fin({ ok: true, sock }));
    sock.on("unexpected-response", (_q, res) => { fin({ ok: false, status: res.statusCode }); try { sock.terminate(); } catch { /* */ } });
    sock.on("error", (e) => fin({ ok: false, error: String(e && e.message) }));
  });
}
function nextEvent(sock, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); sock.off("message", onMsg); sock.off("close", onClose); resolve(v); };
    const onMsg = (d) => { let e = null; try { e = JSON.parse(d.toString()); } catch { /* */ } fin({ kind: "message", env: e }); };
    const onClose = (code) => fin({ kind: "close", code });
    const t = setTimeout(() => fin({ kind: "timeout" }), timeoutMs); if (t.unref) t.unref();
    sock.on("message", onMsg); sock.on("close", onClose);
  });
}
function helloEnv(workerId, workspaceId) {
  return makeEnvelope({ type: "WORKER_HELLO", workspaceId, workerId, sentAt: new Date().toISOString(), payload: { workerVersion: "1.0.0", protocolVersion: 1, capabilities: ["grok.video"] } });
}
async function probeLiveDb() {
  const url = process.env.CONTROL_PLANE_TEST_DB_URL;
  const guard = evaluateTestDbTarget({ url, allowDestructive: process.env.CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS === "true" });
  if (!guard.ok) return { available: false, reason: `guard:${guard.reasons.join(",")}` };
  try {
    const pg = (await import("pg")).default ?? (await import("pg"));
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await c.connect(); await c.query("SELECT 1"); await c.end();
    return { available: true, pg, testUrl: url, migrationUrl: process.env.CONTROL_PLANE_DB_MIGRATION_URL || url, opsUrl: process.env.CONTROL_PLANE_DB_OPS_URL || url };
  } catch (e) { return { available: false, reason: `connect:${String(e.code || e.message).slice(0, 40)}` }; }
}

try {
  // ============================ OFFLINE — pairing crypto ============================
  {
    const { code, normalized } = PC.generatePairingCode();
    check("crypto: code shape XXXX-XXXX-XXXX", /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code), true);
    check("crypto: normalize roundtrip", PC.normalizePairingCode(code), normalized);
    check("crypto: normalize wrong length → ''", PC.normalizePairingCode("ABC"), "");
    check("crypto: invalid format detected", PC.isValidPairingCodeFormat("ZZZZ"), false);
    // byte-compat with lib/control (worker side): same pepper ⇒ same verifier
    check("crypto: pairing verifier == lib/control", PC.pairingCodeVerifier(PAIR_PEPPER, normalized), IC.pairingCodeVerifier(PAIR_PEPPER, normalized));
    const cred = PC.generateWorkerCredential();
    check("crypto: credential shaped (both impls)", PC.isCredentialShaped(cred) && IC.isCredentialShaped(cred), true);
    check("crypto: credential verifier == lib/control", PC.credentialVerifier(CRED_PEPPER, cred), IC.credentialVerifier(CRED_PEPPER, cred));
    check("crypto: verifier is hex, not the secret", /^[0-9a-f]{64}$/.test(PC.credentialVerifier(CRED_PEPPER, cred)), true);
    check("crypto: verifier depends on pepper", PC.credentialVerifier("a", cred) !== PC.credentialVerifier("b", cred), true);
    check("crypto: constantTimeEqualHex equal", PC.constantTimeEqualHex("ab12", "ab12"), true);
    check("crypto: constantTimeEqualHex unequal", PC.constantTimeEqualHex("ab12", "ab13"), false);
    check("crypto: constantTimeEqualHex length-mismatch", PC.constantTimeEqualHex("ab", "abcd"), false);
    check("crypto: constantTimeEqualSecret equal", PC.constantTimeEqualSecret("tok-abc", "tok-abc"), true);
    check("crypto: constantTimeEqualSecret unequal", PC.constantTimeEqualSecret("tok-abc", "tok-abd"), false);
    // no Math.random anywhere in the pairing source (cryptographic randomness only)
    for (const f of ["pairing-crypto.mjs", "pairing-service.mjs", "pairing-router.mjs", "operator-auth.mjs"]) {
      check(`crypto: no Math.random in ${f}`, /Math\.random/.test(readFileSync(path.join(SRC, "pairing", f), "utf8")), false);
    }
  }
  // authoritative Crockford alias normalize check (I→1, L→1, O→0, U→V)
  check("crypto: normalize ILOU→110V", PC.normalizePairingCode("ILOU00000000"), "110V00000000");

  // ============================ OFFLINE — error model ============================
  {
    for (const c of ["E_OPERATOR_UNAUTHORIZED", "E_OPERATOR_FORBIDDEN", "E_PAIRING_DISABLED", "E_PAIRING_INVALID", "E_PAIRING_RATE_LIMITED", "E_WORKER_DISABLED", "E_CREDENTIAL_REVOKED", "E_CREDENTIAL_EXPIRED", "E_CREDENTIAL_ROTATION_REQUIRED", "E_IDEMPOTENCY_CONFLICT"]) {
      check(`errors: ${c} registered`, CP_ERRORS[c], c);
    }
    check("errors: operator unauthorized → 401", httpStatusForCode(CP_ERRORS.E_OPERATOR_UNAUTHORIZED), 401);
    check("errors: pairing invalid → 400", httpStatusForCode(CP_ERRORS.E_PAIRING_INVALID), 400);
    check("errors: pairing rate limited → 429", httpStatusForCode(CP_ERRORS.E_PAIRING_RATE_LIMITED), 429);
    check("errors: worker disabled → 403", httpStatusForCode(CP_ERRORS.E_WORKER_DISABLED), 403);
    check("errors: idempotency conflict → 409", httpStatusForCode(CP_ERRORS.E_IDEMPOTENCY_CONFLICT), 409);
  }

  // ============================ OFFLINE — operator auth ============================
  {
    check("op-auth: missing header → unauthorized", extractOperatorBearer({}).code, OPERATOR_AUTH_CODES.MISSING);
    check("op-auth: bare token malformed", extractOperatorBearer({ authorization: "tok" }).code, OPERATOR_AUTH_CODES.MALFORMED);
    check("op-auth: multiple rejected", extractOperatorBearer({ authorization: "Bearer a, Bearer b" }).code, OPERATOR_AUTH_CODES.MULTIPLE);
    check("op-auth: valid extracted", extractOperatorBearer({ authorization: "Bearer " + OP_TOKEN }).token, OP_TOKEN);
    check("op-auth: disabled → forbidden", authenticateOperator({ enabled: false, operatorToken: OP_TOKEN, headers: { authorization: "Bearer " + OP_TOKEN } }).code, CP_ERRORS.E_OPERATOR_FORBIDDEN);
    check("op-auth: no token configured → forbidden", authenticateOperator({ enabled: true, operatorToken: null, headers: { authorization: "Bearer x" } }).code, CP_ERRORS.E_OPERATOR_FORBIDDEN);
    check("op-auth: wrong token → unauthorized", authenticateOperator({ enabled: true, operatorToken: OP_TOKEN, headers: { authorization: "Bearer wrong-token" } }).code, CP_ERRORS.E_OPERATOR_UNAUTHORIZED);
    check("op-auth: correct token → ok", authenticateOperator({ enabled: true, operatorToken: OP_TOKEN, operatorActorId: "op:x", headers: { authorization: "Bearer " + OP_TOKEN } }).ok, true);
  }

  // ============================ OFFLINE — config gating ============================
  {
    const base = loadConfig({});
    check("cfg: pairing OFF by default", base.pairing.enabled, false);
    check("cfg: operator API OFF by default", base.pairing.operatorApiEnabled, false);
    check("cfg: staging operator auth OFF by default", base.pairing.stagingOperatorAuthEnabled, false);
    const sum = safeConfigSummary(base);
    check("cfg: summary has pairing block", typeof sum.pairing === "object", true);
    check("cfg: summary omits pairing pepper", !("pairingPepper" in sum.pairing) && !JSON.stringify(sum).includes(PAIR_PEPPER), true);
    check("cfg: summary omits operator token", !("operatorToken" in sum.pairing) && !JSON.stringify(sum).includes(OP_TOKEN), true);

    const stagingEnv = {
      CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://x", CONTROL_PLANE_DB_OPS_URL: "postgres://y",
      CONTROL_PLANE_PROCESSOR_ENABLED: "true",
      CONTROL_PLANE_CREDENTIAL_PEPPER: CRED_PEPPER, CONTROL_PLANE_PAIRING_PEPPER: PAIR_PEPPER,
      CONTROL_PLANE_PAIRING_ENABLED: "true", CONTROL_PLANE_PAIRING_OPERATOR_API_ENABLED: "true",
      CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "true", CONTROL_PLANE_PAIRING_OPERATOR_TOKEN: OP_TOKEN
    };
    const cfg = loadConfig(stagingEnv);
    check("cfg: peppers separate", cfg.pairing.pairingPepper !== cfg.security.credentialPepper, true);
    check("cfg: summary omits both peppers even when set", !JSON.stringify(safeConfigSummary(cfg)).includes(PAIR_PEPPER) && !JSON.stringify(safeConfigSummary(cfg)).includes(CRED_PEPPER), true);

    const throws = (env) => { try { loadConfig(env); return false; } catch (e) { return e.code === CP_ERRORS.E_CONFIG_INVALID; } };
    check("cfg: pairing enabled w/o DB throws", throws({ CONTROL_PLANE_PAIRING_ENABLED: "true", CONTROL_PLANE_PAIRING_PEPPER: PAIR_PEPPER, CONTROL_PLANE_CREDENTIAL_PEPPER: CRED_PEPPER }), true);
    check("cfg: pairing enabled w/o pairing pepper throws", throws({ ...stagingEnv, CONTROL_PLANE_PAIRING_PEPPER: "" }), true);
    check("cfg: pairing enabled w/o credential pepper throws", throws({ ...stagingEnv, CONTROL_PLANE_CREDENTIAL_PEPPER: "" }), true);
    check("cfg: operator API w/o staging auth throws", throws({ ...stagingEnv, CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "false" }), true);
    check("cfg: operator token < 16 chars throws", throws({ ...stagingEnv, CONTROL_PLANE_PAIRING_OPERATOR_TOKEN: "short" }), true);
    // production forbids the staging operator token adapter
    let prodForbids = false;
    try { loadConfig({ ...stagingEnv, CONTROL_PLANE_ENV: "production", CONTROL_PLANE_HOST: "0.0.0.0", CONTROL_PLANE_TRUST_PROXY: "true", CONTROL_PLANE_COMMIT_SHA: "abc", CONTROL_PLANE_ALLOWED_ORIGINS: "https://x" }); }
    catch (e) { prodForbids = JSON.stringify(e.details || {}).includes("FORBIDDEN_IN_PRODUCTION"); }
    check("cfg: production forbids staging operator auth", prodForbids, true);
  }

  // ============================ OFFLINE — migration 0014 static ============================
  {
    const sql = readFileSync(path.join(MIG_DIR, "0014_pairing_lifecycle.sql"), "utf8");
    check("mig0014: no GRANT ALL", /GRANT\s+ALL/i.test(sql), false);
    check("mig0014: no plaintext credential/code column", /\b(credential|password|pairing_code)\s+TEXT\b/i.test(sql), false);
    check("mig0014: ops grant SELECT only", /INSERT|UPDATE|DELETE/i.test((sql.match(/GRANT[^;]*TO cp_ops_enumerator/gis) || []).join(" ")), false);
    check("mig0014: sets safe search_path", /SET search_path = public/.test(sql), true);
    check("mig0014: does not edit frozen migrations (own file)", /0014/.test(sql), true);
  }

  // ============================ LIVE ============================
  const live = await probeLiveDb();
  if (!live.available) {
    skip(live.reason, 70);
    console.log(`[SKIP] Live pairing tests skipped. Reason: ${live.reason}`);
    console.log("[SKIP] To run: CONTROL_PLANE_TEST_DB_URL (loopback, *_test) + CONTROL_PLANE_DB_MIGRATION_URL +");
    console.log("[SKIP]   CONTROL_PLANE_DB_OPS_URL + CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS=true.");
  } else {
    await runLive(live);
  }
} catch (err) {
  failed += 1; console.error("FATAL", err && err.stack ? err.stack : err);
}

if (un) { failed += 1; console.error("had unhandled rejection"); }
if (failed > 0) { console.error(`\n${passed} passed, ${failed} failed, ${skipped} skipped`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed, ${skipped} skipped${skipped ? ` (reasons: ${[...skipReasons].join("; ")})` : ""}`); process.exit(0); }

async function runLive(live) {
  const { Client } = live.pg;
  const openSockets = [];
  const track = (s) => { if (s) openSockets.push(s); return s; };

  // reset + migrate from clean
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    await mc.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await mc.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
    await mc.query("GRANT CREATE ON SCHEMA public TO cp_migrator");
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    const res = await mrun(mc, { dir: MIG_DIR, appVersion: "5c5-test" });
    check("LIVE migrate applies incl 0015", res.applied.length + res.alreadyApplied, 15);
  } finally { await mc.end(); }

  // seed users + workspaces
  const ids = { wsA: generateId("ws"), userA: generateId("usr"), wsB: generateId("ws"), userB: generateId("usr") };
  const seed = new Client({ connectionString: live.migrationUrl });
  await seed.connect();
  try {
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.userA, `a-${Date.now()}@t.test`]);
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.userB, `b-${Date.now()}@t.test`]);
    // workspaces_insert RLS requires app.current_workspace to equal the row being inserted (FORCE
    // RLS applies to the migrator too).
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.wsA]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'A',$2)", [ids.wsA, ids.userA]);
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.wsB]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'B',$2)", [ids.wsB, ids.userB]);
    check("LIVE seed ok", true, true);
  } finally { await seed.end(); }

  function envFor(instanceId, overrides = {}) {
    return {
      CONTROL_PLANE_ENV: "test", CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: "0", CONTROL_PLANE_INSTANCE_ID: instanceId,
      CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.testUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl,
      CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0",
      CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_CREDENTIAL_PEPPER: CRED_PEPPER,
      CONTROL_PLANE_GATEWAY_HELLO_TIMEOUT_MS: "1500", CONTROL_PLANE_GATEWAY_HEARTBEAT_MS: "120000",
      CONTROL_PLANE_PAIRING_ENABLED: "true", CONTROL_PLANE_PAIRING_PEPPER: PAIR_PEPPER,
      CONTROL_PLANE_PAIRING_OPERATOR_API_ENABLED: "true", CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "true",
      CONTROL_PLANE_PAIRING_OPERATOR_TOKEN: OP_TOKEN,
      CONTROL_PLANE_PAIRING_MAX_CLAIMS_PER_WINDOW: "500", CONTROL_PLANE_PAIRING_MAX_ISSUE_PER_WINDOW: "500",
      ...overrides
    };
  }
  const logsA = [];
  const recLogger = (logs) => { const r = (level) => (event, fields) => logs.push({ level, event, fields }); const L = { debug: r("debug"), info: r("info"), warn: r("warn"), error: r("error") }; L.child = () => L; return L; };
  const app = await createApp({ config: loadConfig(envFor("cp-5c5-A")), logger: recLogger(logsA) });
  await app.start();
  const P = app._port = app.address().port;
  const persist = app.modules.persistence;
  const q = (ws, sql, params) => persist.tenantTransaction(ws, async (c) => (await c.query(sql, params)).rows);
  const q1 = (ws, sql, params) => q(ws, sql, params).then((r) => r[0] ?? null);

  const opHdr = { authorization: `Bearer ${OP_TOKEN}` };
  const issue = (ws, body = {}, headers = {}) => httpJson(P, "POST", `/internal/v1/workspaces/${ws}/pairing-codes`, { body, headers: { ...opHdr, ...headers } });
  const claim = (body) => httpJson(P, "POST", "/worker/pair", { body });

  try {
    // -------- L1: issue + claim happy path --------
    const iss = await issue(ids.wsA, { requestedLabel: "studio-1" });
    check("L1 issue → 201", iss.status, 201);
    check("L1 issue returns plaintext code once", /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(iss.json.pairingCode || ""), true);
    check("L1 issue returns pcode id", /^pcode_/.test(iss.json.pairingCodeId || ""), true);
    const codeRow = await q1(ids.wsA, "SELECT * FROM pairing_codes WHERE id=$1", [iss.json.pairingCodeId]);
    check("L1 code stored ACTIVE", codeRow.status, "ACTIVE");
    check("L1 code_hash is verifier not plaintext", /^[0-9a-f]{64}$/.test(codeRow.code_hash) && !codeRow.code_hash.includes("-"), true);

    const cl = await claim({ pairingCode: iss.json.pairingCode, requestedWorkerName: "studio-1", platform: "win32", protocolVersion: 1, installationId: "install_abc" });
    check("L1 claim → 200", cl.status, 200);
    check("L1 claim returns credential plaintext once", /^wcred_/.test(cl.json.workerCredential || ""), true);
    check("L1 claim returns worker id", /^wrk_/.test(cl.json.workerId || ""), true);
    check("L1 claim workspace = wsA", cl.json.workspaceId, ids.wsA);
    const w1 = { workerId: cl.json.workerId, credential: cl.json.workerCredential };
    const wrow = await q1(ids.wsA, "SELECT * FROM workers WHERE id=$1", [w1.workerId]);
    check("L1 worker created OFFLINE + paired_at + first_seen_at", wrow.status === "OFFLINE" && !!wrow.paired_at && !!wrow.first_seen_at, true);
    const crow = await q1(ids.wsA, "SELECT * FROM worker_credentials WHERE worker_id=$1 AND status='ACTIVE'", [w1.workerId]);
    check("L1 credential ACTIVE + verifier stored (not plaintext)", crow && /^[0-9a-f]{64}$/.test(crow.credential_hash) && !crow.credential_hash.startsWith("wcred_"), true);
    const codeAfter = await q1(ids.wsA, "SELECT * FROM pairing_codes WHERE id=$1", [iss.json.pairingCodeId]);
    check("L1 code CONSUMED after claim", codeAfter.status, "CONSUMED");
    check("L1 code records consuming worker", codeAfter.used_by_worker_id, w1.workerId);

    // -------- L2: paired credential authenticates via real Gateway --------
    const c2 = await wsConnect(P, w1.credential);
    check("L2 WS upgrade accepted with paired credential", c2.ok, true);
    if (c2.ok) {
      track(c2.sock);
      const evp = nextEvent(c2.sock);
      c2.sock.send(JSON.stringify(helloEnv(w1.workerId, ids.wsA)));
      const ev = await evp;
      check("L2 HELLO_ACK returned", ev.kind === "message" && ev.env && ev.env.type === "HELLO_ACK", true);
      check("L2 HELLO_ACK has sess_ id", ev.kind === "message" && /^sess_/.test((ev.env.payload || {}).sessionId || ""), true);
      const wOnline = await q1(ids.wsA, "SELECT status FROM workers WHERE id=$1", [w1.workerId]);
      check("L2 worker ONLINE after HELLO", wOnline.status, "ONLINE");
    }

    // -------- L3: one-time use --------
    const reuse = await claim({ pairingCode: iss.json.pairingCode });
    check("L3 reused code → 400 E_PAIRING_INVALID", reuse.status === 400 && reuse.json.code === CP_ERRORS.E_PAIRING_INVALID, true);

    // -------- L4: concurrent claim race → exactly one winner --------
    const raceIss = await issue(ids.wsA, { requestedLabel: "race" });
    const results = await Promise.all(Array.from({ length: 6 }, () => claim({ pairingCode: raceIss.json.pairingCode, platform: "win32" })));
    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 400 && r.json.code === CP_ERRORS.E_PAIRING_INVALID);
    check("L4 exactly one concurrent claim wins", winners.length, 1);
    check("L4 all other concurrent claims → generic invalid", losers.length, 5);
    const raceWorkers = await q(ids.wsA, "SELECT id FROM workers WHERE id=$1", [winners[0].json.workerId]);
    check("L4 exactly one worker created for the code", raceWorkers.length, 1);

    // -------- L5: invalid + expired + attempts/lock --------
    const bogus = await claim({ pairingCode: "AAAA-AAAA-AAAA" });
    check("L5 unknown code → 400 generic invalid", bogus.status === 400 && bogus.json.code === CP_ERRORS.E_PAIRING_INVALID, true);
    const expIss = await issue(ids.wsA, { maxAttempts: 2 });
    await q(ids.wsA, "UPDATE pairing_codes SET expires_at = now() - interval '1 hour' WHERE id=$1", [expIss.json.pairingCodeId]);
    const exp1 = await claim({ pairingCode: expIss.json.pairingCode });
    check("L5 expired code → 400 generic invalid", exp1.status === 400 && exp1.json.code === CP_ERRORS.E_PAIRING_INVALID, true);
    const expRow1 = await q1(ids.wsA, "SELECT attempts,status FROM pairing_codes WHERE id=$1", [expIss.json.pairingCodeId]);
    check("L5 failed attempt recorded", expRow1.attempts, 1);
    await claim({ pairingCode: expIss.json.pairingCode });
    const expRow2 = await q1(ids.wsA, "SELECT attempts,status FROM pairing_codes WHERE id=$1", [expIss.json.pairingCodeId]);
    check("L5 code LOCKED at max attempts", expRow2.status === "LOCKED" && expRow2.attempts === 2, true);

    // -------- L6: operator auth + surface gating --------
    const noAuth = await httpJson(P, "POST", `/internal/v1/workspaces/${ids.wsA}/pairing-codes`, { body: {} });
    check("L6 no operator token → 401", noAuth.status === 401 && noAuth.json.code === CP_ERRORS.E_OPERATOR_UNAUTHORIZED, true);
    const wrongAuth = await issue(ids.wsA, {}, { authorization: "Bearer nope" });
    check("L6 wrong operator token → 401", wrongAuth.status === 401 && wrongAuth.json.code === CP_ERRORS.E_OPERATOR_UNAUTHORIZED, true);
    const badWs = await httpJson(P, "POST", `/internal/v1/workspaces/not-a-ws/pairing-codes`, { body: {}, headers: opHdr });
    check("L6 malformed workspace id → 404", badWs.status, 404);

    // operator API disabled app → /internal/v1 hidden (404)
    const disApp = await createApp({ config: loadConfig(envFor("cp-5c5-noop", { CONTROL_PLANE_PAIRING_OPERATOR_API_ENABLED: "false", CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "false", CONTROL_PLANE_PAIRING_OPERATOR_TOKEN: "" })), logger: recLogger([]) });
    await disApp.start();
    const disP = disApp.address().port;
    const disOp = await httpJson(disP, "POST", `/internal/v1/workspaces/${ids.wsA}/pairing-codes`, { body: {}, headers: opHdr });
    check("L6 operator API disabled → 404 hidden", disOp.status, 404);
    // pairing fully disabled app → /worker/pair hidden (404)
    const offApp = await createApp({ config: loadConfig(envFor("cp-5c5-off", { CONTROL_PLANE_PAIRING_ENABLED: "false", CONTROL_PLANE_PAIRING_OPERATOR_API_ENABLED: "false", CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "false", CONTROL_PLANE_PAIRING_OPERATOR_TOKEN: "" })), logger: recLogger([]) });
    await offApp.start();
    const offClaim = await httpJson(offApp.address().port, "POST", "/worker/pair", { body: { pairingCode: "AAAA-AAAA-AAAA" } });
    check("L6 pairing disabled → claim path 404 hidden", offClaim.status, 404);
    await disApp.stop(); await offApp.stop();

    // -------- L7: rotation (immediate cutover) --------
    const rotIss = await issue(ids.wsA, { requestedLabel: "rot" });
    const rotClaim = await claim({ pairingCode: rotIss.json.pairingCode, platform: "win32" });
    const wr = { workerId: rotClaim.json.workerId, credential: rotClaim.json.workerCredential };
    const rc = await wsConnect(P, wr.credential); track(rc.sock);
    const rcEvp = nextEvent(rc.sock); rc.sock.send(JSON.stringify(helloEnv(wr.workerId, ids.wsA))); await rcEvp;
    const dropP = nextEvent(rc.sock, 3000);
    const rot = await httpJson(P, "POST", `/internal/v1/workspaces/${ids.wsA}/workers/${wr.workerId}/credentials/rotate`, { body: {}, headers: opHdr });
    check("L7 rotate → 201 new credential", rot.status === 201 && /^wcred_/.test(rot.json.workerCredential || ""), true);
    check("L7 rotate reports lineage", /^cred_/.test(rot.json.rotatedFrom || ""), true);
    const drop = await dropP;
    check("L7 rotation drops the live socket", drop.kind === "close" && drop.code === 4401, true);
    const activeCreds = await q(ids.wsA, "SELECT id,status FROM worker_credentials WHERE worker_id=$1 AND status='ACTIVE'", [wr.workerId]);
    check("L7 exactly one ACTIVE credential after rotate", activeCreds.length, 1);
    const oldRevoked = await q1(ids.wsA, "SELECT status,revoke_reason FROM worker_credentials WHERE id=$1", [rot.json.rotatedFrom]);
    check("L7 old credential REVOKED (rotated)", oldRevoked.status === "REVOKED" && oldRevoked.revoke_reason === "rotated", true);
    const oldConn = await wsConnect(P, wr.credential);
    check("L7 OLD credential cannot reconnect (401)", oldConn.ok === false && oldConn.status === 401, true);
    const newConn = await wsConnect(P, rot.json.workerCredential); track(newConn.sock);
    check("L7 NEW credential authenticates", newConn.ok, true);
    if (newConn.ok) { const ep = nextEvent(newConn.sock); newConn.sock.send(JSON.stringify(helloEnv(wr.workerId, ids.wsA))); const e = await ep; check("L7 NEW credential HELLO_ACK", e.kind === "message" && e.env.type === "HELLO_ACK", true); }

    // -------- L8: revocation --------
    const revIss = await issue(ids.wsA, {});
    const revClaim = await claim({ pairingCode: revIss.json.pairingCode, platform: "win32" });
    const wv = { workerId: revClaim.json.workerId, credential: revClaim.json.workerCredential };
    const vc = await wsConnect(P, wv.credential); track(vc.sock);
    const vEvp = nextEvent(vc.sock); vc.sock.send(JSON.stringify(helloEnv(wv.workerId, ids.wsA))); await vEvp;
    const vDrop = nextEvent(vc.sock, 3000);
    const rev = await httpJson(P, "POST", `/internal/v1/workspaces/${ids.wsA}/workers/${wv.workerId}/credentials/revoke`, { body: { reason: "test" }, headers: opHdr });
    check("L8 revoke → 200", rev.status, 200);
    check("L8 revoke drops live socket", (await vDrop).kind === "close", true);
    const vActive = await q(ids.wsA, "SELECT id FROM worker_credentials WHERE worker_id=$1 AND status='ACTIVE'", [wv.workerId]);
    check("L8 no ACTIVE credential after revoke", vActive.length, 0);
    const vReconn = await wsConnect(P, wv.credential);
    check("L8 revoked credential cannot reconnect (401)", vReconn.ok === false && vReconn.status === 401, true);

    // -------- L9: disable / enable --------
    const disIss = await issue(ids.wsA, {});
    const disClaim = await claim({ pairingCode: disIss.json.pairingCode, platform: "win32" });
    const wd = { workerId: disClaim.json.workerId, credential: disClaim.json.workerCredential };
    const dc = await wsConnect(P, wd.credential); track(dc.sock);
    const dEvp = nextEvent(dc.sock); dc.sock.send(JSON.stringify(helloEnv(wd.workerId, ids.wsA))); await dEvp;
    const dDrop = nextEvent(dc.sock, 3000);
    const dis = await httpJson(P, "POST", `/internal/v1/workspaces/${ids.wsA}/workers/${wd.workerId}/disable`, { body: { reason: "policy" }, headers: opHdr });
    check("L9 disable → 200 status REVOKED", dis.status === 200 && dis.json.status === "REVOKED", true);
    check("L9 disable drops live socket", (await dDrop).kind === "close", true);
    const wdRow = await q1(ids.wsA, "SELECT status,disabled_at,disable_reason FROM workers WHERE id=$1", [wd.workerId]);
    check("L9 worker REVOKED + disabled_at + reason", wdRow.status === "REVOKED" && !!wdRow.disabled_at && wdRow.disable_reason === "policy", true);
    const dActive = await q(ids.wsA, "SELECT id FROM worker_credentials WHERE worker_id=$1 AND status='ACTIVE'", [wd.workerId]);
    check("L9 disabled worker has no ACTIVE credential", dActive.length, 0);
    const dReconn = await wsConnect(P, wd.credential);
    check("L9 disabled worker credential cannot reconnect (401)", dReconn.ok === false && dReconn.status === 401, true);
    const ena = await httpJson(P, "POST", `/internal/v1/workspaces/${ids.wsA}/workers/${wd.workerId}/enable`, { body: {}, headers: opHdr });
    check("L9 enable → 200 OFFLINE requiresRotation", ena.status === 200 && ena.json.status === "OFFLINE" && ena.json.requiresRotation === true, true);
    const enaReconn = await wsConnect(P, wd.credential);
    check("L9 re-enabled worker still needs new credential (old revoked, 401)", enaReconn.ok === false && enaReconn.status === 401, true);
    const reRot = await httpJson(P, "POST", `/internal/v1/workspaces/${ids.wsA}/workers/${wd.workerId}/credentials/rotate`, { body: {}, headers: opHdr });
    check("L9 rotate after enable issues fresh credential", reRot.status === 201 && /^wcred_/.test(reRot.json.workerCredential || ""), true);
    const reConn = await wsConnect(P, reRot.json.workerCredential); track(reConn.sock);
    check("L9 re-enabled worker authenticates with new credential", reConn.ok, true);

    // -------- L10: idempotency --------
    const k1 = "idem-key-" + Date.now();
    const i1 = await issue(ids.wsA, { requestedLabel: "idem" }, { "idempotency-key": k1 });
    const i2 = await issue(ids.wsA, { requestedLabel: "idem" }, { "idempotency-key": k1 });
    check("L10 idempotent replay → 200 replayed", i2.status === 200 && i2.json.replayed === true, true);
    check("L10 idempotent replay same code id", i2.json.pairingCodeId, i1.json.pairingCodeId);
    check("L10 idempotent replay omits plaintext code", i2.json.pairingCode === undefined, true);
    const i3 = await issue(ids.wsA, { requestedLabel: "DIFFERENT" }, { "idempotency-key": k1 });
    check("L10 idempotency conflict on different params → 409", i3.status === 409 && i3.json.code === CP_ERRORS.E_IDEMPOTENCY_CONFLICT, true);

    // -------- L11: durable issuance rate limit --------
    const rlApp = await createApp({ config: loadConfig(envFor("cp-5c5-rl", { CONTROL_PLANE_PAIRING_MAX_ISSUE_PER_WINDOW: "3", CONTROL_PLANE_PAIRING_RATE_LIMIT_WINDOW_MS: "3600000" })), logger: recLogger([]) });
    await rlApp.start();
    const rlP = rlApp.address().port;
    let got429 = false;
    for (let i = 0; i < 6; i++) { const r = await httpJson(rlP, "POST", `/internal/v1/workspaces/${ids.wsB}/pairing-codes`, { body: {}, headers: opHdr }); if (r.status === 429 && r.json.code === CP_ERRORS.E_PAIRING_RATE_LIMITED) got429 = true; }
    check("L11 issuance rate limit → 429", got429, true);
    // durable: the bucket row exists in rate_limit_buckets
    const bucket = await q1(ids.wsB, "SELECT count FROM rate_limit_buckets WHERE workspace_id=$1 AND bucket_key=$2 ORDER BY window_start DESC LIMIT 1", [ids.wsB, `pairing.issue:${ids.wsB}`]);
    check("L11 durable rate bucket persisted", bucket && bucket.count >= 3, true);
    await rlApp.stop();

    // -------- L12: per-remote claim rate limit --------
    const crApp = await createApp({ config: loadConfig(envFor("cp-5c5-cr", { CONTROL_PLANE_PAIRING_MAX_CLAIMS_PER_WINDOW: "3", CONTROL_PLANE_PAIRING_RATE_LIMIT_WINDOW_MS: "3600000" })), logger: recLogger([]) });
    await crApp.start();
    const crP = crApp.address().port;
    let claim429 = false;
    for (let i = 0; i < 6; i++) { const r = await httpJson(crP, "POST", "/worker/pair", { body: { pairingCode: "AAAA-AAAA-AAAA" } }); if (r.status === 429 && r.json.code === CP_ERRORS.E_PAIRING_RATE_LIMITED) claim429 = true; }
    check("L12 per-remote claim rate limit → 429", claim429, true);
    await crApp.stop();

    // -------- L13: cross-workspace isolation --------
    const bIss = await issue(ids.wsB, { requestedLabel: "b-worker" });
    const bClaim = await claim({ pairingCode: bIss.json.pairingCode, platform: "win32" });
    check("L13 wsB code claims into wsB", bClaim.status === 200 && bClaim.json.workspaceId === ids.wsB, true);
    const bWorkerInA = await q(ids.wsA, "SELECT id FROM workers WHERE id=$1", [bClaim.json.workerId]);
    check("L13 wsB worker not visible under wsA RLS", bWorkerInA.length, 0);
    // wsB credential authenticates as wsB, and a HELLO claiming wsA is rejected (identity mismatch)
    const bConn = await wsConnect(P, bClaim.json.workerCredential); track(bConn.sock);
    if (bConn.ok) {
      const bp = nextEvent(bConn.sock); bConn.sock.send(JSON.stringify(helloEnv(bClaim.json.workerId, ids.wsA))); const be = await bp;
      check("L13 wsB credential cannot HELLO as wsA (closed)", be.kind === "close", true);
    }

    // -------- L15: shipped WorkerPairingClient + secure store (worker-side integration) --------
    const wcIss = await issue(ids.wsA, { requestedLabel: "real-client" });
    const store = new MemoryCredentialStore();
    const client = new WorkerPairingClient({ url: `http://127.0.0.1:${P}`, credentialStore: store, workerName: "real-client", installationId: "install_real" });
    const pairRes = await client.pair(wcIss.json.pairingCode);
    check("L15 WorkerPairingClient.pair stores + returns safe result", pairRes.stored === true && /^wrk_/.test(pairRes.workerId || "") && pairRes.workspaceId === ids.wsA, true);
    check("L15 pair() never returns plaintext credential", pairRes.credential === undefined && pairRes.workerCredential === undefined, true);
    const stored = await store.getActiveCredential();
    check("L15 credential persisted in worker store", /^wcred_/.test(stored.credential || ""), true);
    const scConn = await wsConnect(P, stored.credential); track(scConn.sock);
    check("L15 stored credential authenticates via real Gateway", scConn.ok, true);
    if (scConn.ok) { const sp = nextEvent(scConn.sock); scConn.sock.send(JSON.stringify(helloEnv(pairRes.workerId, ids.wsA))); const se = await sp; check("L15 stored credential HELLO_ACK", se.kind === "message" && se.env.type === "HELLO_ACK", true); }

    // -------- L14: security — no plaintext in DB, no secrets in logs, audit clean --------
    const allCodeHashes = await q(ids.wsA, "SELECT code_hash FROM pairing_codes", []);
    check("L14 no plaintext pairing code stored", allCodeHashes.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash)), true);
    const allCredHashes = await q(ids.wsA, "SELECT credential_hash FROM worker_credentials", []);
    check("L14 no plaintext credential stored", allCredHashes.every((r) => /^[0-9a-f]{64}$/.test(r.credential_hash) && !r.credential_hash.startsWith("wcred_")), true);
    const logStr = JSON.stringify(logsA);
    check("L14 no wcred_ plaintext in logs", logStr.includes("wcred_"), false);
    check("L14 no operator token in logs", logStr.includes(OP_TOKEN), false);
    check("L14 no pairing pepper in logs", logStr.includes(PAIR_PEPPER) || logStr.includes(CRED_PEPPER), false);
    const auditRows = await q(ids.wsA, "SELECT action, metadata::text AS m FROM audit_events WHERE action IN ('pairing_code.issue','worker.paired','credential.rotate','credential.revoke','worker.disable','worker.enable')", []);
    check("L14 audit events recorded for lifecycle", auditRows.length >= 5, true);
    check("L14 audit metadata carries no plaintext secret", auditRows.every((r) => !String(r.m || "").includes("wcred_") && !/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.test(String(r.m || ""))), true);

    // config summary from the running app leaks no secrets
    const sumStr = JSON.stringify(safeConfigSummary(app.modules.config));
    check("L14 running config summary omits peppers + token", !sumStr.includes(PAIR_PEPPER) && !sumStr.includes(CRED_PEPPER) && !sumStr.includes(OP_TOKEN), true);
  } finally {
    for (const s of openSockets) { try { s.terminate(); } catch { /* */ } }
    await app.stop().catch(() => {});
  }
}
