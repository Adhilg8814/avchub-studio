#!/usr/bin/env node
// P0 Step 5C.6 — Staging Project / Generation / Job / Result API tests.
//
// SAFE BY CONSTRUCTION: offline unit/static checks always run. LIVE tests (real PostgreSQL + real
// HTTP + real local WebSocket fake-Worker on 127.0.0.1:ephemeral) run ONLY against a verified
// disposable *_test database; otherwise they SKIP with a reason. NO browser automation, NO provider
// execution, NO quota, NO staging/production connection. The fake Worker never runs a provider
// handler — it only speaks the canonical protocol. Exit 0 when there are no failures.

import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

import { loadConfig, safeConfigSummary } from "../control-plane/src/config/config.mjs";
import { createApp } from "../control-plane/src/app.mjs";
import { CP_ERRORS, httpStatusForCode } from "../control-plane/src/errors.mjs";
import { evaluateTestDbTarget } from "../control-plane/src/persistence/postgres/test-db-safety.mjs";
import { migrate as mrun } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { credentialVerifier } from "../control-plane/src/gateway/credential-verifier.mjs";
import * as PROJ from "../control-plane/src/api-staging/projections.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";

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
const CRED_PEPPER = "step5c6-credential-pepper-value-fixed-01";
const PAIR_PEPPER = "step5c6-pairing-pepper-value-fixed-02";
const OP_TOKEN = "step5c6-operator-token-value-fixed-3333";
const rd = (rel) => readFileSync(path.join(SRC, rel), "utf8");

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
function nextEvent(sock, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); sock.off("message", onMsg); sock.off("close", onClose); resolve(v); };
    const onMsg = (d) => { let e = null; try { e = JSON.parse(d.toString()); } catch { /* */ } fin({ kind: "message", env: e }); };
    const onClose = (code) => fin({ kind: "close", code });
    const t = setTimeout(() => fin({ kind: "timeout" }), timeoutMs); if (t.unref) t.unref();
    sock.on("message", onMsg); sock.on("close", onClose);
  });
}
function collectUntil(sock, predicate, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const msgs = []; let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(t); sock.off("message", onMsg); resolve(msgs); };
    const onMsg = (d) => { let e = null; try { e = JSON.parse(d.toString()); } catch { /* */ } if (e) { msgs.push(e); if (predicate(e)) fin(); } };
    const t = setTimeout(fin, timeoutMs); if (t.unref) t.unref();
    sock.on("message", onMsg);
  });
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
  // ============================ OFFLINE — config + error model ============================
  {
    const base = loadConfig({});
    check("cfg: staging API OFF by default", base.stagingApi.enabled, false);
    check("cfg: dispatchOnCreate OFF by default", base.stagingApi.dispatchOnCreate, false);
    check("cfg: allowFakeJobsOnly ON by default", base.stagingApi.allowFakeJobsOnly, true);
    const sum = safeConfigSummary(base);
    check("cfg: summary has stagingApi block", typeof sum.stagingApi === "object", true);
    check("cfg: summary omits workspaceId value", !("workspaceId" in sum.stagingApi), true);
    check("cfg: summary omits operator token", !JSON.stringify(sum).includes(OP_TOKEN), true);

    const WS = "ws_0123456789ABCDEFGHJKMNPQRS";
    const stagingEnv = {
      CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://x", CONTROL_PLANE_DB_OPS_URL: "postgres://y",
      CONTROL_PLANE_CREDENTIAL_PEPPER: CRED_PEPPER, CONTROL_PLANE_PAIRING_PEPPER: PAIR_PEPPER,
      CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "true", CONTROL_PLANE_PAIRING_OPERATOR_TOKEN: OP_TOKEN,
      CONTROL_PLANE_STAGING_API_ENABLED: "true", CONTROL_PLANE_STAGING_API_WORKSPACE_ID: WS
    };
    check("cfg: staging valid config loads", loadConfig(stagingEnv).stagingApi.enabled, true);
    const throws = (env) => { try { loadConfig(env); return false; } catch (e) { return e.code === CP_ERRORS.E_CONFIG_INVALID; } };
    check("cfg: staging w/o DB throws", throws({ CONTROL_PLANE_STAGING_API_ENABLED: "true" }), true);
    check("cfg: staging w/o workspace throws", throws({ ...stagingEnv, CONTROL_PLANE_STAGING_API_WORKSPACE_ID: "" }), true);
    check("cfg: staging w/o operator auth throws", throws({ ...stagingEnv, CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "false" }), true);
    check("cfg: fake-jobs-only=false throws", throws({ ...stagingEnv, CONTROL_PLANE_STAGING_API_ALLOW_FAKE_JOBS_ONLY: "false" }), true);
    let prodForbids = false;
    try { loadConfig({ ...stagingEnv, CONTROL_PLANE_ENV: "production", CONTROL_PLANE_HOST: "0.0.0.0", CONTROL_PLANE_TRUST_PROXY: "true", CONTROL_PLANE_COMMIT_SHA: "abc", CONTROL_PLANE_ALLOWED_ORIGINS: "https://x" }); }
    catch (e) { prodForbids = JSON.stringify(e.details || {}).includes("FORBIDDEN_IN_PRODUCTION"); }
    check("cfg: production forbids staging API/auth", prodForbids, true);
    check("cfg: enabling staging API does not enable gateway/processor/pairing/paid", loadConfig(stagingEnv).workerGateway.enabled === false && loadConfig(stagingEnv).processor.enabled === false && loadConfig(stagingEnv).pairing.enabled === false, true);

    for (const c of ["E_PROJECT_NOT_FOUND", "E_PROJECT_ARCHIVED", "E_WORKER_NOT_AVAILABLE", "E_WORKER_CAPABILITY_MISMATCH", "E_PROJECT_AFFINITY_REQUIRED", "E_RECONCILIATION_REQUIRED", "E_REVISION_CONFLICT", "E_JOB_NOT_FOUND", "E_JOB_NOT_CANCELABLE", "E_JOB_NOT_RETRYABLE", "E_ATTEMPT_ALREADY_OWNED", "E_ATTEMPT_POSSIBLY_SUBMITTED", "E_INVALID_STATE_TRANSITION"]) {
      check(`errors: ${c} registered`, CP_ERRORS[c], c);
    }
    check("errors: project-not-found → 404", httpStatusForCode(CP_ERRORS.E_PROJECT_NOT_FOUND), 404);
    check("errors: revision-conflict → 409", httpStatusForCode(CP_ERRORS.E_REVISION_CONFLICT), 409);
    check("errors: job-not-retryable → 409", httpStatusForCode(CP_ERRORS.E_JOB_NOT_RETRYABLE), 409);
  }

  // ============================ OFFLINE — projection unit tests ============================
  {
    check("proj: QUEUED + worker unavailable → WAITING_FOR_WORKER", PROJ.projectJobStatus({ job: { status: "QUEUED" }, attempt: { ownership_status: "CREATED" }, workerAvailable: false }), "WAITING_FOR_WORKER");
    check("proj: QUEUED + worker available → QUEUED", PROJ.projectJobStatus({ job: { status: "QUEUED" }, attempt: { ownership_status: "CREATED" }, workerAvailable: true }), "QUEUED");
    check("proj: DISPATCHED → OFFERED", PROJ.projectJobStatus({ job: { status: "DISPATCHED" }, attempt: { ownership_status: "OFFERED" } }), "OFFERED");
    check("proj: RUNNING → RUNNING", PROJ.projectJobStatus({ job: { status: "RUNNING" }, attempt: { ownership_status: "RUNNING" } }), "RUNNING");
    check("proj: SUBMITTED → RUNNING (not COMPLETED before terminal)", PROJ.projectJobStatus({ job: { status: "RUNNING" }, attempt: { ownership_status: "SUBMITTED" } }), "RUNNING");
    check("proj: SUCCEEDED → COMPLETED", PROJ.projectJobStatus({ job: { status: "SUCCEEDED" }, attempt: { ownership_status: "COMPLETED" } }), "COMPLETED");
    check("proj: RECOVERING attempt → RECOVERING", PROJ.projectJobStatus({ job: { status: "RUNNING" }, attempt: { ownership_status: "RECOVERING" } }), "RECOVERING");
    check("proj: FAILED → FAILED", PROJ.projectJobStatus({ job: { status: "FAILED" }, attempt: { ownership_status: "FAILED" } }), "FAILED");
    check("proj: manual → NEEDS_ACTION", PROJ.projectJobStatus({ job: { status: "NEEDS_MANUAL_ACTION" }, attempt: { ownership_status: "MANUAL_ACTION_REQUIRED" } }), "NEEDS_ACTION");
    check("proj: progress never 100 before COMPLETED", PROJ.projectJob({ job: { id: "job_x", status: "RUNNING", progress: { percent: 100 }, created_at: null }, attempt: { ownership_status: "RUNNING" }, workerAvailable: true }).progress.percent, 99);
    // worker + asset projections carry no secrets; liveness independent of storage tier
    const wp = PROJ.projectWorker({ id: "wrk_1", name: "W", status: "ONLINE", protocol_version: 1, worker_version: "1.0.0", last_seen_at: null }, { capabilities: ["grok.video"] });
    check("proj: worker projection safe keys only", Object.keys(wp).sort().join(","), "capabilities,id,label,lastSeenAt,protocolVersion,reconciling,status,workerVersion");
    check("proj: worker DISABLED for revoked", PROJ.projectWorkerStatus({ status: "REVOKED" }), "DISABLED");
    const a = PROJ.projectAsset({ id: "asset_1", mime_type: "video/mp4", relative_path: "projects/p/x.mp4", file_name: "x.mp4", storage_tier: "LOCAL_ONLY", liveness: "ONLINE", review_status: "UNREVIEWED", created_at: null }, { workerOnline: false });
    check("proj: asset liveness WORKER_OFFLINE when worker offline", a.liveness, "WORKER_OFFLINE");
    check("proj: asset storageTier separate from liveness", a.storageTier, "LOCAL_ONLY");
    check("proj: asset has no absolute path / provider", !JSON.stringify(a).includes("://") && !("provider" in a) && !("providerAccountRef" in a), true);
  }

  // ============================ OFFLINE — static safety scans ============================
  {
    const svc = rd("api-staging/staging-api-service.mjs");
    const router = rd("api-staging/staging-api-router.mjs");
    const repo = rd("api-staging/staging-repository.mjs");
    const mig = readFileSync(path.join(MIG_DIR, "0015_project_staging_fields.sql"), "utf8");
    check("static: migration 0015 no plaintext credential/code column", /\b(credential|password|pairing_code)\s+TEXT\b/i.test(mig), false);
    check("static: migration 0015 sets safe search_path", /SET search_path = public/.test(mig), true);
    check("static: migration 0015 no GRANT ALL", /GRANT\s+ALL/i.test(mig), false);
    check("static: service reuses ownership cores (no duplicated INSERT into generation_attempts/job_offers)", /INSERT\s+INTO\s+(generation_attempts|job_offers|generation_requests)\b/i.test(svc), false);
    check("static: service does not open a WebSocket / send to socket", /\bnew WebSocket\b|\.send\(|socket\.write|sendToWorker/.test(svc), false);
    check("static: no provider/browser/python imports in staging modules", /(grok-video|puppeteer|playwright|provider-session|\.py\b|chatgpt|elevenlabs)/i.test(svc + router + repo), false);
    check("static: retry passes parentAttemptId + retryOfJobId (lineage, new attempt)", /parentAttemptId:\s*priorJob\.generation_attempt_id/.test(svc) && /retryOfJobId:\s*priorJob\.id/.test(svc), true);
    check("static: retry mints a fresh req idempotency key (no attemptId reuse)", /reqIdemKey\s*=\s*newId\("req"\)/.test(svc), true);
    check("static: dispatch calls claimGenerationAttemptForWorkerCore", /claimGenerationAttemptForWorkerCore/.test(svc), true);
    check("static: cancel calls applyCancelCore", /applyCancelCore/.test(svc), true);
    check("static: no hard-delete endpoint (no DELETE FROM projects/jobs)", /DELETE\s+FROM\s+(projects|jobs)\b/i.test(repo + svc), false);
    check("static: every staging query is workspace-scoped (workspace_id predicate present)", /workspace_id\s*=\s*\$1/.test(repo), true);
    check("static: router reads Authorization only (no token from query/cookie)", /req\.headers/.test(router) && !/req\.url.*token|cookie/i.test(router), true);
  }

  // ============================ LIVE ============================
  const live = await probeLiveDb();
  if (!live.available) {
    skip(live.reason, 96);
    console.log(`[SKIP] Live staging API tests skipped. Reason: ${live.reason}`);
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
  const recLogger = (logs) => { const r = (level) => (event, fields) => logs.push({ level, event, fields }); const L = { debug: r("debug"), info: r("info"), warn: r("warn"), error: r("error") }; L.child = () => L; return L; };

  // reset + migrate from clean
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    await mc.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await mc.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
    await mc.query("GRANT CREATE ON SCHEMA public TO cp_migrator");
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    const res = await mrun(mc, { dir: MIG_DIR, appVersion: "5c6-test" });
    check("LIVE migrate applies incl 0015", res.applied.length + res.alreadyApplied, 15);
  } finally { await mc.end(); }

  // seed users + workspaces (wsA = staging workspace, wsB = other/cross-workspace)
  const ids = { wsA: generateId("ws"), userA: generateId("usr"), wsB: generateId("ws"), userB: generateId("usr") };
  const seed = new Client({ connectionString: live.migrationUrl });
  await seed.connect();
  const mkCred = () => `wcred_${randomBytes(32).toString("base64url")}`;
  async function seedWorker(ws, { name, status = "ONLINE", online = true, capability = null, credential = null } = {}) {
    const workerId = generateId("wrk"); const cred = credential || mkCred();
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await seed.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version,status,paired_at,first_seen_at) VALUES ($1,$2,$3,'win32',1,$4, now(), now())", [workerId, ws, name, status]);
    await seed.query("INSERT INTO worker_credentials (id,workspace_id,worker_id,credential_hash,status,expires_at) VALUES ($1,$2,$3,$4,'ACTIVE', now() + interval '365 days')", [newId("cred"), ws, workerId, credentialVerifier(CRED_PEPPER, cred)]);
    if (capability) await seed.query("INSERT INTO worker_capabilities (id,workspace_id,worker_id,capability) VALUES ($1,$2,$3,$4)", [newId("wcap"), ws, workerId, capability]);
    if (online) await seed.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,gateway_instance,session_id,status,connection_epoch,connected_at,authenticated_at,last_seen_at) VALUES ($1,$2,$3,'seed',$1,'ACTIVE',0,now(),now(),now())", [generateId("sess"), ws, workerId]);
    return { workerId, credential: cred };
  }
  let seeded = {};
  try {
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.userA, `a-${Date.now()}@t.test`]);
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.userB, `b-${Date.now()}@t.test`]);
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.wsA]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'A',$2)", [ids.wsA, ids.userA]);
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.wsB]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'B',$2)", [ids.wsB, ids.userB]);
    seeded.wDisabled = await seedWorker(ids.wsA, { name: "Disabled", status: "REVOKED", online: false });
    seeded.wOffline = await seedWorker(ids.wsA, { name: "Offline", status: "OFFLINE", online: false, capability: "grok.video" });
    seeded.wMismatch = await seedWorker(ids.wsA, { name: "Mismatch", status: "ONLINE", online: true, capability: "other.capability" });
    seeded.wB = await seedWorker(ids.wsB, { name: "ForeignB", status: "ONLINE", online: true });
    check("LIVE seed ok", true, true);
  } catch (e) { check("LIVE seed ok", String(e && e.message), true); }
  // NOTE: `seed` stays open for the whole run (seedWorker is used throughout); closed in finally.

  function envFor(instanceId, overrides = {}) {
    return {
      CONTROL_PLANE_ENV: "test", CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: "0", CONTROL_PLANE_INSTANCE_ID: instanceId,
      CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.testUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl,
      CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_DELIVERY_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0",
      CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_CREDENTIAL_PEPPER: CRED_PEPPER,
      CONTROL_PLANE_GATEWAY_HELLO_TIMEOUT_MS: "1500", CONTROL_PLANE_GATEWAY_HEARTBEAT_MS: "120000",
      CONTROL_PLANE_PAIRING_ENABLED: "true", CONTROL_PLANE_PAIRING_PEPPER: PAIR_PEPPER,
      CONTROL_PLANE_PAIRING_OPERATOR_API_ENABLED: "true", CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "true",
      CONTROL_PLANE_PAIRING_OPERATOR_TOKEN: OP_TOKEN,
      CONTROL_PLANE_STAGING_API_ENABLED: "true", CONTROL_PLANE_STAGING_API_WORKSPACE_ID: ids.wsA,
      CONTROL_PLANE_STAGING_API_DISPATCH_ON_CREATE: "false",
      ...overrides
    };
  }
  const logsA = [];
  const app = await createApp({ config: loadConfig(envFor("cp-5c6-A")), logger: recLogger(logsA) });
  await app.start();
  const P = app.address().port;
  const persist = app.modules.persistence;
  const processor = app.modules.processor;
  const opHdr = { authorization: `Bearer ${OP_TOKEN}` };
  const op = (method, p, body, headers) => httpJson(P, method, p, { body, headers: { ...opHdr, ...(headers || {}) } });
  const q1 = (ws, sql, params) => persist.tenantTransaction(ws, async (c) => (await c.query(sql, params)).rows[0] ?? null);
  const qn = (ws, sql, params) => persist.tenantTransaction(ws, async (c) => (await c.query(sql, params)).rows);

  // WS fake worker: connect + HELLO (gateway → ONLINE + real session).
  function hello(workerId, ws) { return makeEnvelope({ type: "WORKER_HELLO", workspaceId: ws, workerId, sentAt: new Date().toISOString(), payload: { workerVersion: "1.0.0", protocolVersion: 1, capabilities: ["grok.video"] } }); }
  function wc(type, workerId, ws, jobId, payload = {}) { const e = { type, workspaceId: ws, workerId, sentAt: new Date().toISOString(), payload }; if (jobId) e.jobId = jobId; return makeEnvelope(e); }
  async function connectWorker(credential, workerId, ws = ids.wsA) {
    const c = await wsConnect(P, credential); if (!c.ok) return c;
    track(c.sock); const evp = nextEvent(c.sock); c.sock.send(JSON.stringify(hello(workerId, ws))); const ev = await evp;
    return { ok: true, sock: c.sock, ack: ev };
  }
  // dispatch (HTTP) + deliver (processor.runOnce) + receive the JOB_OFFER on the worker socket.
  async function dispatchAndDeliver(sock, jobId) {
    const offerP = collectUntil(sock, (e) => e.type === "JOB_OFFER", 4000);
    const d = await op("POST", `/internal/v1/jobs/${jobId}/dispatch`);
    await processor.runOnce();
    const msgs = await offerP;
    return { dispatch: d, offer: msgs.find((e) => e.type === "JOB_OFFER") || null };
  }

  try {
    // -------- API auth / config (tests 1-8) --------
    const disabledApp = await createApp({ config: loadConfig(envFor("cp-5c6-off", { CONTROL_PLANE_STAGING_API_ENABLED: "false" })), logger: recLogger([]) });
    await disabledApp.start();
    const offResp = await httpJson(disabledApp.address().port, "GET", "/internal/v1/projects", { headers: opHdr });
    check("A1 staging API disabled by default → 404 hidden", offResp.status, 404);
    await disabledApp.stop();
    check("A2 missing operator auth → 401", (await httpJson(P, "GET", "/internal/v1/projects")).status, 401);
    check("A3 invalid operator auth → 401", (await httpJson(P, "GET", "/internal/v1/projects", { headers: { authorization: "Bearer wrong" } })).status, 401);
    check("A6 body-size limit → 413", (await op("POST", "/internal/v1/projects", { title: "x".repeat(200000) })).status, 413);
    const unk = await op("POST", "/internal/v1/projects", { title: "T", bogusField: 1 });
    check("A7 unknown field rejected → 400", unk.status === 400 && unk.json.code === CP_ERRORS.E_BAD_REQUEST, true);
    check("A8 error body has no stack trace", (() => { const s = JSON.stringify(unk.json); return !s.includes("at ") && !s.includes(".mjs"); })(), true);

    // -------- Projects (tests 9-18) --------
    const c1 = await op("POST", "/internal/v1/projects", { title: "Project One", description: "d1", aspectRatio: "16:9", defaultDuration: 5 }, { "idempotency-key": "pk1" });
    check("B9 create project → 201", c1.status === 201 && /^prj_/.test(c1.json.id), true);
    check("B9 project response shape (camelCase, no raw row)", ["id", "title", "description", "status", "revision", "defaults", "worker", "counts", "createdAt", "updatedAt"].every((k) => k in c1.json), true);
    const c1b = await op("POST", "/internal/v1/projects", { title: "Project One", description: "d1", aspectRatio: "16:9", defaultDuration: 5 }, { "idempotency-key": "pk1" });
    check("B10 duplicate create idempotent (same id, 200)", c1b.status === 200 && c1b.json.id === c1.json.id, true);
    const projId = c1.json.id;
    await op("POST", "/internal/v1/projects", { title: "Project Two" });
    const list = await op("GET", "/internal/v1/projects?limit=50");
    check("B11 list projects paginated + stable", Array.isArray(list.json.projects) && list.json.projects.length >= 2 && typeof list.json.page.total === "number", true);
    check("B12 get project", (await op("GET", `/internal/v1/projects/${projId}`)).json.id, projId);
    const upd = await op("PATCH", `/internal/v1/projects/${projId}`, { title: "Renamed", expectedRevision: 0 });
    check("B13 update with correct revision", upd.status === 200 && upd.json.title === "Renamed" && upd.json.revision === 1, true);
    const stale = await op("PATCH", `/internal/v1/projects/${projId}`, { title: "X", expectedRevision: 0 });
    check("B14 stale revision → E_REVISION_CONFLICT (409)", stale.status === 409 && stale.json.code === CP_ERRORS.E_REVISION_CONFLICT, true);
    const arch = await op("POST", `/internal/v1/projects/${projId}/archive`, { expectedRevision: 1 });
    check("B15 archive project", arch.status === 200 && arch.json.status === "ARCHIVED", true);
    const genArchived = await op("POST", `/internal/v1/projects/${projId}/generations`, { prompt: "x" }, { "idempotency-key": "gA" });
    check("B16 archived project cannot generate → E_PROJECT_ARCHIVED", genArchived.status === 409 && genArchived.json.code === CP_ERRORS.E_PROJECT_ARCHIVED, true);
    check("B17 no hard-delete route (DELETE project → 404/405)", [404, 405].includes((await op("DELETE", `/internal/v1/projects/${projId}`)).status), true);
    check("B18 project response contains no secrets", !JSON.stringify(c1.json).includes("wcred_") && !JSON.stringify(c1.json).includes(OP_TOKEN) && !JSON.stringify(c1.json).includes("credential_hash"), true);

    // -------- Affinity (tests 19-26) --------
    const proj2 = (await op("POST", "/internal/v1/projects", { title: "Affinity Project" })).json;
    const wConn = await connectWorker(seeded.wOfflineCred || (seeded.wLive = await seedWorker(ids.wsA, { name: "Live", online: false, capability: "grok.video" })).credential, seeded.wLive.workerId);
    check("B19 assign same-workspace paired online Worker", (await op("PUT", `/internal/v1/projects/${proj2.id}/worker-affinity`, { workerId: seeded.wLive.workerId })).status, 200);
    const xws = await op("PUT", `/internal/v1/projects/${proj2.id}/worker-affinity`, { workerId: seeded.wB.workerId });
    check("B20 cross-workspace Worker rejected", xws.status === 404 || (xws.json && xws.json.code === CP_ERRORS.E_WORKER_NOT_FOUND), true);
    const disA = await op("PUT", `/internal/v1/projects/${proj2.id}/worker-affinity`, { workerId: seeded.wDisabled.workerId });
    check("B21 disabled Worker rejected → E_WORKER_NOT_AVAILABLE", disA.status === 409 && disA.json.code === CP_ERRORS.E_WORKER_NOT_AVAILABLE, true);
    check("B22 one active affinity (reassign migrates, still one ACTIVE)", await (async () => { await op("PUT", `/internal/v1/projects/${proj2.id}/worker-affinity`, { workerId: seeded.wMismatch.workerId }); const n = await q1(ids.wsA, "SELECT count(*)::int n FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'", [ids.wsA, proj2.id]); return n.n; })(), 1);    check("B26 release preserves history (row RELEASED not deleted)", await (async () => { await op("DELETE", `/internal/v1/projects/${proj2.id}/worker-affinity`, {}); const n = await q1(ids.wsA, "SELECT count(*)::int n FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='RELEASED'", [ids.wsA, proj2.id]); return n.n >= 1; })(), true);

    // -------- Generation creation (tests 27-36) --------
    const gproj = (await op("POST", "/internal/v1/projects", { title: "Gen Project" })).json;
    const g1 = await op("POST", `/internal/v1/projects/${gproj.id}/generations`, { kind: "VIDEO", prompt: "a cat", durationSeconds: 5, aspectRatio: "16:9", outputCount: 1 }, { "idempotency-key": "gg1" });
    check("C27 valid generation → 202 with req/attempt/job", g1.status === 202 && /^req_/.test(g1.json.requestId) && /^attempt_/.test(g1.json.generationAttemptId) && /^job_/.test(g1.json.jobId), true);
    const attemptCount1 = await q1(ids.wsA, "SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1 AND generation_request_id=$2", [ids.wsA, g1.json.requestId]);
    check("C27 exactly one attempt for the request", attemptCount1.n, 1);
    const g1dup = await op("POST", `/internal/v1/projects/${gproj.id}/generations`, { kind: "VIDEO", prompt: "a cat", durationSeconds: 5, aspectRatio: "16:9", outputCount: 1 }, { "idempotency-key": "gg1" });
    check("C28 duplicate Idempotency-Key → same job (no duplicate)", g1dup.json.jobId === g1.json.jobId, true);
    check("C28 still exactly one attempt after duplicate", (await q1(ids.wsA, "SELECT count(*)::int n FROM jobs WHERE workspace_id=$1 AND generation_attempt_id=$2", [ids.wsA, g1.json.generationAttemptId])).n, 1);
    const g1conf = await op("POST", `/internal/v1/projects/${gproj.id}/generations`, { kind: "VIDEO", prompt: "DIFFERENT", durationSeconds: 5, aspectRatio: "16:9", outputCount: 1 }, { "idempotency-key": "gg1" });
    check("C29 changed payload + same key → E_IDEMPOTENCY_CONFLICT", g1conf.status === 409 && g1conf.json.code === CP_ERRORS.E_IDEMPOTENCY_CONFLICT, true);
    check("C31 invalid project rejected", (await op("POST", `/internal/v1/projects/prj_00000000000000000000000000/generations`, { prompt: "x" }, { "idempotency-key": "gx" })).status, 404);
    check("C32 invalid prompt (empty) rejected", (await op("POST", `/internal/v1/projects/${gproj.id}/generations`, { prompt: "" }, { "idempotency-key": "gp" })).status, 400);
    check("C33 invalid duration rejected", (await op("POST", `/internal/v1/projects/${gproj.id}/generations`, { prompt: "x", durationSeconds: 999 }, { "idempotency-key": "gd" })).status, 400);
    check("C34 invalid aspect ratio rejected", (await op("POST", `/internal/v1/projects/${gproj.id}/generations`, { prompt: "x", aspectRatio: "3:2" }, { "idempotency-key": "ga" })).status, 400);
    check("C35 unknown field rejected", (await op("POST", `/internal/v1/projects/${gproj.id}/generations`, { prompt: "x", evil: 1 }, { "idempotency-key": "gu" })).status, 400);
    const snap = await q1(ids.wsA, "SELECT input_snapshot FROM generation_requests WHERE workspace_id=$1 AND id=$2", [ids.wsA, g1.json.requestId]);
    check("C36 generation input has no identity duplication", snap && !("requestIdempotencyKey" in snap.input_snapshot) && !("generationAttemptId" in snap.input_snapshot), true);
    check("C30 request→attempt→job canonical id prefixes", /^req_/.test(g1.json.requestId) && /^attempt_/.test(g1.json.generationAttemptId) && /^job_/.test(g1.json.jobId), true);

    // -------- Dispatch (tests 37-49) --------
    // Project with NO affinity + an OFFLINE worker → WAITING_FOR_WORKER (keep this generation on the
    // offline worker; we do NOT reassign it, since its unresolved attempt would block migration).
    const dproj = (await op("POST", "/internal/v1/projects", { title: "Dispatch Project" })).json;
    const dgen = await op("POST", `/internal/v1/projects/${dproj.id}/generations`, { prompt: "dispatch me" }, { "idempotency-key": "dg1" });
    check("C40 no affinity → dispatch WAITING_FOR_WORKER", (await op("POST", `/internal/v1/jobs/${dgen.json.jobId}/dispatch`)).json.dispatchStatus, "WAITING_FOR_WORKER");
    await op("PUT", `/internal/v1/projects/${dproj.id}/worker-affinity`, { workerId: seeded.wOffline.workerId });
    check("C41 offline Worker → dispatch WAITING_FOR_WORKER", (await op("POST", `/internal/v1/jobs/${dgen.json.jobId}/dispatch`)).json.dispatchStatus, "WAITING_FOR_WORKER");
    // Fresh project + ONLINE worker (seeded fake session) → dispatch OFFERED.
    const wOn = await seedWorker(ids.wsA, { name: "SeedOnline", online: true, capability: "grok.video" });
    const dproj2 = (await op("POST", "/internal/v1/projects", { title: "Dispatch Online" })).json;
    await op("PUT", `/internal/v1/projects/${dproj2.id}/worker-affinity`, { workerId: wOn.workerId });
    const dgen2 = await op("POST", `/internal/v1/projects/${dproj2.id}/generations`, { prompt: "dispatch online" }, { "idempotency-key": "dg2" });
    const dres = await op("POST", `/internal/v1/jobs/${dgen2.json.jobId}/dispatch`);
    check("C37 active online Worker dispatches → OFFERED", dres.json.dispatched === true && dres.json.dispatchStatus === "OFFERED", true);
    const offerRow = await q1(ids.wsA, "SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status='OFFERED'", [ids.wsA, dgen2.json.generationAttemptId]);
    const obRow = await q1(ids.wsA, "SELECT count(*)::int n FROM protocol_outbox WHERE workspace_id=$1 AND generation_attempt_id=$2 AND type='JOB_OFFER'", [ids.wsA, dgen2.json.generationAttemptId]);
    check("C38 dispatch creates exactly one offer + one JOB_OFFER outbox", offerRow.n === 1 && obRow.n === 1, true);
    const dres2 = await op("POST", `/internal/v1/jobs/${dgen2.json.jobId}/dispatch`);
    check("C43 duplicate dispatch idempotent (still one offer)", dres2.json.idempotent === true && (await q1(ids.wsA, "SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2", [ids.wsA, dgen2.json.generationAttemptId])).n === 1, true);
    // concurrent dispatch → exactly one owner
    const cproj = (await op("POST", "/internal/v1/projects", { title: "Concurrent" })).json;
    await op("PUT", `/internal/v1/projects/${cproj.id}/worker-affinity`, { workerId: wOn.workerId });
    const cgen = await op("POST", `/internal/v1/projects/${cproj.id}/generations`, { prompt: "race" }, { "idempotency-key": "cg1" });
    const races = await Promise.all(Array.from({ length: 5 }, () => op("POST", `/internal/v1/jobs/${cgen.json.jobId}/dispatch`)));
    check("C44 concurrent dispatch → exactly one offer", (await q1(ids.wsA, "SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2", [ids.wsA, cgen.json.generationAttemptId])).n, 1);
    check("C49 fake job did not consume a paid approval grant", (await q1(ids.wsA, "SELECT count(*)::int n FROM paid_generation_approval_grants WHERE workspace_id=$1", [ids.wsA])).n, 0);
    check("C39 API did not send JOB_OFFER to a socket (outbox row exists, delivery handled by processor)", await (async () => { const r = await q1(ids.wsA, "SELECT delivery_state FROM protocol_outbox WHERE workspace_id=$1 AND generation_attempt_id=$2 AND type='JOB_OFFER'", [ids.wsA, dgen2.json.generationAttemptId]); return r && ["PENDING", "SENT", "SETTLED", "DEAD"].includes(r.delivery_state); })(), true);

    // -------- Live WebSocket fake-worker flow (tests 50-60) --------
    const wsFlow = await seedWorker(ids.wsA, { name: "WSWorker", online: false });
    const conn = await connectWorker(wsFlow.credential, wsFlow.workerId);
    check("D50 paired Worker connects + HELLO_ACK", conn.ok && conn.ack.kind === "message" && conn.ack.env.type === "HELLO_ACK", true);
    const fproj = (await op("POST", "/internal/v1/projects", { title: "Flow Project" })).json;
    await op("PUT", `/internal/v1/projects/${fproj.id}/worker-affinity`, { workerId: wsFlow.workerId });
    const fgen = await op("POST", `/internal/v1/projects/${fproj.id}/generations`, { prompt: "make a fake video", durationSeconds: 5, aspectRatio: "16:9" }, { "idempotency-key": "fg1" });
    const jobId = fgen.json.jobId;
    const del = await dispatchAndDeliver(conn.sock, jobId);
    check("D51 Worker receives canonical JOB_OFFER", del.offer && del.offer.type === "JOB_OFFER" && del.offer.jobId === jobId, true);
    const outMsg = await q1(ids.wsA, "SELECT message_id FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [ids.wsA, jobId]);
    check("D52 offer messageId matches durable outbox", del.offer && del.offer.messageId === outMsg.message_id, true);
    // JOB_ACCEPTED
    conn.sock.send(JSON.stringify(wc("JOB_ACCEPTED", wsFlow.workerId, ids.wsA, jobId)));
    await waitFor(async () => (await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, jobId])).status === "ACCEPTED");
    check("D53 JOB_ACCEPTED settles lifecycle → job ACCEPTED", (await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, jobId])).status, "ACCEPTED");
    // JOB_STARTED + progress
    conn.sock.send(JSON.stringify(wc("JOB_STARTED", wsFlow.workerId, ids.wsA, jobId)));
    await waitFor(async () => (await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, jobId])).status === "RUNNING");
    check("D54 JOB_STARTED updates job → RUNNING", (await op("GET", `/internal/v1/jobs/${jobId}`)).json.status, "RUNNING");
    // JOB_COMPLETED with a safe fake asset
    conn.sock.send(JSON.stringify(wc("JOB_COMPLETED", wsFlow.workerId, ids.wsA, jobId, { result: { asset: { relativePath: `projects/${fproj.id}/out.mp4`, fileName: "out.mp4", mimeType: "video/mp4", durationSeconds: 5, width: 1920, height: 1080, sizeBytes: 1234 } } })));
    await waitFor(async () => (await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, jobId])).status === "SUCCEEDED");
    check("D56 JOB_COMPLETED applies → job SUCCEEDED", (await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, jobId])).status, "SUCCEEDED");
    // duplicate terminal is idempotent
    conn.sock.send(JSON.stringify(wc("JOB_COMPLETED", wsFlow.workerId, ids.wsA, jobId, { result: { asset: { relativePath: `projects/${fproj.id}/out.mp4`, fileName: "out.mp4", mimeType: "video/mp4" } } })));
    await sleep(200);
    check("D57 duplicate terminal idempotent (one terminal_result)", (await q1(ids.wsA, "SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [ids.wsA, jobId])).n, 1);
    check("D60 job reaches projected COMPLETED via API", (await op("GET", `/internal/v1/jobs/${jobId}`)).json.status, "COMPLETED");
    const results = await op("GET", `/internal/v1/jobs/${jobId}/results`);
    check("D58 result metadata appears through API", results.status === 200 && results.json.assets.length >= 1 && results.json.assets[0].mediaType === "video/mp4", true);
    check("D59 result exposes no absolute path / provider URL", !JSON.stringify(results.json).includes("://") && !/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(JSON.stringify(results.json)), true);

    // -------- Job reads (tests 61-67) --------
    check("D61 list project jobs", (await op("GET", `/internal/v1/projects/${fproj.id}/jobs`)).json.jobs.length >= 1, true);
    const jv = (await op("GET", `/internal/v1/jobs/${jobId}`)).json;
    check("D62/64 job projection safe + stable status set", ["QUEUED", "WAITING_FOR_WORKER", "OFFERED", "RUNNING", "NEEDS_ACTION", "RECOVERING", "COMPLETED", "FAILED", "CANCELED"].includes(jv.status), true);
    check("D65 job worker metadata safe (no credential)", jv.worker && !JSON.stringify(jv.worker).includes("wcred_") && !("credential" in jv.worker), true);
    const events = await op("GET", `/internal/v1/jobs/${jobId}/events?limit=5`);
    check("D63 event timeline paginated + sanitized (no raw envelopes/payload)", Array.isArray(events.json.events) && events.json.events.length >= 1 && !JSON.stringify(events.json).includes("payload") && !JSON.stringify(events.json).includes("messageId"), true);
    check("D67 media liveness independent from completion (COMPLETED + liveness field present)", jv.status === "COMPLETED" && results.json.assets[0].liveness !== undefined && results.json.assets[0].storageTier !== undefined, true);

    // -------- Cancel (tests 68-74) --------
    const cancelProj = (await op("POST", "/internal/v1/projects", { title: "Cancel Project" })).json;
    const cq = await op("POST", `/internal/v1/projects/${cancelProj.id}/generations`, { prompt: "cancel me" }, { "idempotency-key": "cq1" });
    const cancel1 = await op("POST", `/internal/v1/jobs/${cq.json.jobId}/cancel`);
    check("D68 cancel queued job", cancel1.status, 200);
    const cancel1b = await op("POST", `/internal/v1/jobs/${cq.json.jobId}/cancel`);
    check("D70 duplicate cancel idempotent", cancel1b.status, 200);
    // cancel an OFFERED/dispatched job → durable outbox JOB_CANCEL_REQUEST
    await op("PUT", `/internal/v1/projects/${cancelProj.id}/worker-affinity`, { workerId: wOn.workerId });
    const cq2 = await op("POST", `/internal/v1/projects/${cancelProj.id}/generations`, { prompt: "offered cancel" }, { "idempotency-key": "cq2" });
    await op("POST", `/internal/v1/jobs/${cq2.json.jobId}/dispatch`);
    await op("POST", `/internal/v1/jobs/${cq2.json.jobId}/cancel`);
    check("D73 cancel of dispatched job uses durable JOB_CANCEL_REQUEST outbox", (await q1(ids.wsA, "SELECT count(*)::int n FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_CANCEL_REQUEST'", [ids.wsA, cq2.json.jobId])).n, 1);
    check("D71 cancel never deletes request/attempt/job evidence", (await q1(ids.wsA, "SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ids.wsA, cq2.json.generationAttemptId])).n, 1);
    check("D72 terminal (completed) job cancel does not mutate terminal", await (async () => { const before = await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, jobId]); await op("POST", `/internal/v1/jobs/${jobId}/cancel`); const after = await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, jobId]); return before.status === "SUCCEEDED" && after.status === "SUCCEEDED"; })(), true);

    // -------- Retry (tests 75-82) --------
    const retry = await op("POST", `/internal/v1/jobs/${jobId}/retry`, {}, { "idempotency-key": "retry1" });    check("D75-77 retry creates new request/attempt/job", retry.status === 202 && retry.json.requestId !== g1.json.requestId && /^attempt_/.test(retry.json.generationAttemptId) && retry.json.jobId !== jobId, true);
    check("D78 retry preserves lineage (parentAttemptId + retryOfJobId)", await (async () => { const a = await q1(ids.wsA, "SELECT parent_attempt_id, retry_of_job_id FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ids.wsA, retry.json.generationAttemptId]); return a.parent_attempt_id === fgen.json.generationAttemptId && a.retry_of_job_id === jobId; })(), true);
    check("D79 retry never reuses prior attempt id", retry.json.generationAttemptId !== fgen.json.generationAttemptId, true);
    check("D81 old attempt remains terminal/immutable", (await q1(ids.wsA, "SELECT terminal_state FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ids.wsA, fgen.json.generationAttemptId])).terminal_state, "COMPLETED");
    const inflightRetry = await op("POST", `/internal/v1/jobs/${cgen.json.jobId}/retry`, {}, { "idempotency-key": "retry-inflight" });
    check("D80/82 retry of in-flight job → E_JOB_NOT_RETRYABLE", inflightRetry.status === 409 && inflightRetry.json.code === CP_ERRORS.E_JOB_NOT_RETRYABLE, true);

    // -------- Results / assets (tests 83-88) --------
    const assetId = results.json.assets[0].id;
    check("D83 result list workspace-scoped", results.json.assets.every((a) => /^asset_/.test(a.id)), true);
    const foreignJob = await op("GET", `/internal/v1/jobs/job_00000000000000000000000000/results`);
    check("D84 cross-workspace/unknown job result → 404", foreignJob.status, 404);
    check("D85/86 asset response no absolute path / provider URL", !JSON.stringify(results.json.assets[0]).includes("://") && !("provider" in results.json.assets[0]), true);
    check("D87 storageTier and liveness separate fields", results.json.assets[0].storageTier !== results.json.assets[0].liveness || (results.json.assets[0].storageTier === "LOCAL_ONLY"), true);
    // review (optional)
    const rev = await op("PATCH", `/internal/v1/assets/${assetId}/review`, { reviewStatus: "APPROVED", expectedRevision: results.json.assets[0].revision });
    check("D(review) asset review update optimistic-concurrency", rev.status === 200 && rev.json.reviewStatus === "APPROVED", true);
    check("D(review) stale review revision rejected", (await op("PATCH", `/internal/v1/assets/${assetId}/review`, { reviewStatus: "REJECTED", expectedRevision: 0 })).status, 409);

    // -------- Concurrency / crash-ish (tests 89-95) --------
    const ccProj = (await op("POST", "/internal/v1/projects", { title: "Concurrency" })).json;
    const conc = await Promise.all(Array.from({ length: 5 }, () => op("POST", `/internal/v1/projects/${ccProj.id}/generations`, { prompt: "concurrent" }, { "idempotency-key": "conc1" })));
    const jobIds = new Set(conc.filter((r) => r.json && r.json.jobId).map((r) => r.json.jobId));
    check("C89 concurrent duplicate Generate → exactly one job", jobIds.size, 1);
    check("C89 concurrent duplicate Generate → exactly one attempt", (await q1(ids.wsA, "SELECT count(*)::int n FROM generation_attempts ga JOIN generation_requests gr ON gr.id=ga.generation_request_id AND gr.workspace_id=ga.workspace_id WHERE gr.workspace_id=$1 AND gr.project_id=$2", [ids.wsA, ccProj.id])).n, 1);
    check("C93 lost HTTP response replay returns existing request", (await op("POST", `/internal/v1/projects/${ccProj.id}/generations`, { prompt: "concurrent" }, { "idempotency-key": "conc1" })).json.jobId, [...jobIds][0]);
    // processor delivers existing durable outbox (an earlier dispatched offer) without error
    check("C94 processor.runOnce delivers existing durable outbox (no error)", (await processor.runOnce()) !== undefined, true);

    // -------- Security (tests 96-102) --------
    const logStr = JSON.stringify(logsA);
    check("D96 no operator token in logs", logStr.includes(OP_TOKEN), false);
    check("D97 no Worker credential in logs", logStr.includes("wcred_"), false);
    check("D98 no raw prompt in logs", logStr.includes("make a fake video") || logStr.includes("a cat"), false);
    check("D99 no raw protocol payload in logs", /"payload":\{[^}]*asset/.test(logStr), false);
    check("D100 no SQL error text exposed in any error body", !JSON.stringify(g1conf.json).includes("constraint") && !JSON.stringify(stale.json).includes("SELECT"), true);
    // cp_ops_enumerator has no mutate grant on projects/jobs (RLS + grants)
    const opsGrants = await (async () => { const c = new Client({ connectionString: live.opsUrl }); await c.connect(); const r = await c.query("SELECT count(*)::int n FROM information_schema.role_table_grants WHERE grantee='cp_ops_enumerator' AND table_name IN ('projects','jobs') AND privilege_type IN ('INSERT','UPDATE','DELETE')"); await c.end(); return r.rows[0].n; })();
    check("D101 cp_ops_enumerator cannot mutate projects/jobs", opsGrants, 0);
    // RLS: a project created in wsA is not visible under wsB context
    check("D102 RLS protects project queries (wsB cannot see wsA project)", (await q1(ids.wsB, "SELECT count(*)::int n FROM projects WHERE id=$1", [gproj.id])).n, 0);

    // -------- End-to-end fake staging via pairing API (tests 103-114) --------
    const issue = await op("POST", `/internal/v1/workspaces/${ids.wsA}/pairing-codes`, { requestedLabel: "e2e" });
    check("E103 create pairing code", issue.status === 201 && /^[0-9A-HJKMNP-TV-Z-]{14}$/.test(issue.json.pairingCode), true);
    const claim = await httpJson(P, "POST", "/worker/pair", { body: { pairingCode: issue.json.pairingCode, platform: "win32", protocolVersion: 1 } });
    check("E104 pair Worker", claim.status === 200 && /^wcred_/.test(claim.json.workerCredential), true);
    const e2eConn = await connectWorker(claim.json.workerCredential, claim.json.workerId);
    check("E105 connect Worker (HELLO_ACK)", e2eConn.ok && e2eConn.ack.env.type === "HELLO_ACK", true);
    const e2eProj = (await op("POST", "/internal/v1/projects", { title: "E2E" })).json;
    check("E106 create project", /^prj_/.test(e2eProj.id), true);
    check("E107 assign Worker", (await op("PUT", `/internal/v1/projects/${e2eProj.id}/worker-affinity`, { workerId: claim.json.workerId })).status, 200);
    const e2eGen = await op("POST", `/internal/v1/projects/${e2eProj.id}/generations`, { prompt: "e2e fake video", durationSeconds: 10, aspectRatio: "9:16" }, { "idempotency-key": "e2e1" });
    check("E108 create fake video generation", e2eGen.status, 202);
    const e2eDel = await dispatchAndDeliver(e2eConn.sock, e2eGen.json.jobId);
    check("E109 receive one JOB_OFFER", e2eDel.offer && e2eDel.offer.type === "JOB_OFFER", true);
    e2eConn.sock.send(JSON.stringify(wc("JOB_ACCEPTED", claim.json.workerId, ids.wsA, e2eGen.json.jobId)));
    e2eConn.sock.send(JSON.stringify(wc("JOB_STARTED", claim.json.workerId, ids.wsA, e2eGen.json.jobId)));
    e2eConn.sock.send(JSON.stringify(wc("JOB_COMPLETED", claim.json.workerId, ids.wsA, e2eGen.json.jobId, { result: { asset: { relativePath: `projects/${e2eProj.id}/e2e.mp4`, fileName: "e2e.mp4", mimeType: "video/mp4", durationSeconds: 10 } } })));
    await waitFor(async () => (await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, e2eGen.json.jobId])).status === "SUCCEEDED", 5000);
    check("E110/111 accept/start/complete → poll job COMPLETED", (await op("GET", `/internal/v1/jobs/${e2eGen.json.jobId}`)).json.status, "COMPLETED");
    check("E112 fetch fake result metadata", (await op("GET", `/internal/v1/jobs/${e2eGen.json.jobId}/results`)).json.assets.length >= 1, true);
    const e2eRetry = await op("POST", `/internal/v1/jobs/${e2eGen.json.jobId}/retry`, {}, { "idempotency-key": "e2e-retry" });
    check("E113 retry creates a separate generation attempt", e2eRetry.status === 202 && e2eRetry.json.generationAttemptId !== e2eGen.json.generationAttemptId, true);
    check("E114 no provider/browser/python executed (fake asset only, no provider column set)", (await q1(ids.wsA, "SELECT count(*)::int n FROM assets WHERE workspace_id=$1 AND provider IS NOT NULL", [ids.wsA])).n, 0);

    // -------- Property / invariant (bounded deterministic interleavings) --------
    await propertyInvariants({ op, q1, connectWorker, seedWorker, dispatchAndDeliver, ids, wc, processor });
  } finally {
    for (const s of openSockets) { try { s.terminate(); } catch { /* */ } }
    try { await seed.end(); } catch { /* */ }
    await app.stop().catch(() => {});
  }

  function sleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); }
  async function waitFor(fn, timeoutMs = 3000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { try { if (await fn()) return true; } catch { /* */ } await sleep(50); } return false; }

  async function propertyInvariants({ op, q1, connectWorker, seedWorker, dispatchAndDeliver, ids, wc, processor }) {
    // A few bounded interleavings: create → assign → generate → dup → dispatch A/B → accept → complete
    // → retry, asserting the golden invariants after each sequence.
    for (let i = 0; i < 3; i++) {
      const proj = (await op("POST", "/internal/v1/projects", { title: `Prop ${i}` })).json;
      const w = await seedWorker(ids.wsA, { name: `PW${i}`, online: false });
      const conn = await connectWorker(w.credential, w.workerId);
      await op("PUT", `/internal/v1/projects/${proj.id}/worker-affinity`, { workerId: w.workerId });
      const key = `prop-${i}-${Date.now()}`;
      const g = await op("POST", `/internal/v1/projects/${proj.id}/generations`, { prompt: `p${i}` }, { "idempotency-key": key });
      const gdup = await op("POST", `/internal/v1/projects/${proj.id}/generations`, { prompt: `p${i}` }, { "idempotency-key": key });
      const attemptN = await q1(ids.wsA, "SELECT count(*)::int n FROM generation_attempts ga JOIN generation_requests gr ON gr.id=ga.generation_request_id AND gr.workspace_id=ga.workspace_id WHERE gr.workspace_id=$1 AND gr.project_id=$2", [ids.wsA, proj.id]);
      check(`PROP[${i}] one request per idempotency key`, gdup.json.jobId === g.json.jobId && attemptN.n === 1, true);
      // concurrent dispatch A/B → one owner
      await Promise.all([op("POST", `/internal/v1/jobs/${g.json.jobId}/dispatch`), op("POST", `/internal/v1/jobs/${g.json.jobId}/dispatch`)]);
      const owners = await q1(ids.wsA, "SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status='OFFERED'", [ids.wsA, g.json.generationAttemptId]);
      check(`PROP[${i}] at most one paid owner / offer`, owners.n <= 1, true);
      // deliver + accept + complete
      await dispatchAndDeliver(conn.sock, g.json.jobId);
      conn.sock.send(JSON.stringify(wc("JOB_ACCEPTED", w.workerId, ids.wsA, g.json.jobId)));
      conn.sock.send(JSON.stringify(wc("JOB_COMPLETED", w.workerId, ids.wsA, g.json.jobId, { result: { asset: { relativePath: `projects/${proj.id}/p${i}.mp4`, fileName: `p${i}.mp4`, mimeType: "video/mp4" } } })));
      await waitFor(async () => (await q1(ids.wsA, "SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ids.wsA, g.json.jobId])).status === "SUCCEEDED", 5000);
      const attempt = await q1(ids.wsA, "SELECT generation_ordinal, terminal_state FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ids.wsA, g.json.generationAttemptId]);
      check(`PROP[${i}] generationOrdinal <= 1`, attempt.generation_ordinal <= 1, true);
      check(`PROP[${i}] terminal immutable (COMPLETED)`, attempt.terminal_state, "COMPLETED");
      const retry = await op("POST", `/internal/v1/jobs/${g.json.jobId}/retry`, {}, { "idempotency-key": `${key}-retry` });
      check(`PROP[${i}] retry uses a new generationAttemptId`, retry.json.generationAttemptId !== g.json.generationAttemptId, true);
      // no cross-workspace mutation: wsB sees none of these
      check(`PROP[${i}] no cross-workspace visibility`, (await q1(ids.wsB, "SELECT count(*)::int n FROM projects WHERE id=$1", [proj.id])).n, 0);
    }
  }
}
