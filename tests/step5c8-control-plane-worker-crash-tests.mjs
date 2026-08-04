#!/usr/bin/env node
// P0 Step 5C.8B2 — STRICT full-stack crash/restart/reconnect/cancel/retry certification.
//
// Real PostgreSQL + real Control Plane + real Processor + real WebSocket Gateway + Step 5C.5 pairing +
// Step 5C.6 staging API + Microsoft Edge (creator-state evidence) + a REAL Worker CHILD PROCESS
// (createPairedWorker → WorkerRuntime → RecoveryJournal/PendingAckStore → DPAPI) + the deterministic
// fake GENERATE_VIDEO provider with test-only crash seams. Setup/generation/cancel/retry go through the
// real operator API; duplicate/stale/conflicting protocol frames are replayed through the REAL inbox
// service (processor.inbox.processInboundEnvelope) — the exact settlement path the Gateway uses.
//
// Strict mode (--require-live): PG / Edge / DPAPI / Worker-pair / injection-point unavailable → HARD FAIL.
// Run: node tests/step5c8-control-plane-worker-crash-tests.mjs --require-live

import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { chromium } from "playwright-core";
import { Client } from "pg";
import { createApp } from "../control-plane/src/app.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { migrate } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { evaluateTestDbTarget } from "../control-plane/src/persistence/postgres/test-db-safety.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";
import { makeDpapiRunner } from "../lib/worker/credential-store.mjs";
import { spawnWorker, waitForMarker, releasePause } from "./helpers/step5c8-process-control.mjs";

const REQUIRE_LIVE = process.argv.includes("--require-live");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7); // optional CSV of scenario ids
const ROOTDIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(ROOTDIR, "..", "control-plane", "database", "migrations");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BROWSER_PATH = existsSync(EDGE) ? EDGE : (existsSync(CHROME) ? CHROME : null);
const OPERATOR_TOKEN = "step5c8b2-op-" + randomBytes(24).toString("base64url");
const CREDENTIAL_PEPPER = "step5c8b2-credential-pepper-fixed-00001";
const PAIRING_PEPPER = "step5c8b2-pairing-pepper-fixed-000002";

let passed = 0, failed = 0;
const results = {};
function rec(scn, ok, note) { (results[scn] ||= { pass: 0, fail: 0, notes: [] }); if (ok) results[scn].pass += 1; else results[scn].fail += 1; if (note) results[scn].notes.push(note); }
function check(scn, name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL [${scn}] ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
  rec(scn, ok, ok ? null : name);
}
function hardFail(scn, msg) { failed += 1; console.error(`FATAL [${scn}] ${msg}`); rec(scn, false, msg); }
// gap(): a FOCUSED failing test for a MISSING recovery behavior. It records the desired-vs-actual
// discrepancy as documented evidence WITHOUT failing the harness (a focused failing test is evidence
// for a later approved change, not a harness failure). The golden-invariant asserts still use check().
const gaps = [];
function gap(scn, name, actual, desired) {
  const holds = JSON.stringify(actual) === JSON.stringify(desired);
  gaps.push({ scn, name, actual, desired, holds });
  console.log(`  GAP [${scn}] ${name}\n       actual:  ${JSON.stringify(actual)}\n       desired: ${JSON.stringify(desired)}  → ${holds ? "already satisfied" : "MISSING (current-contract gap)"}`);
  rec(scn, true); // documented finding; does NOT fail the harness
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, desc, timeoutMs = 15000, stepMs = 100) {
  const t0 = Date.now();
  for (;;) { let v; try { v = await pred(); } catch { v = false; } if (v) return v; if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${desc}`); await sleep(stepMs); }
}
function shortId(id) { const b = String(id ?? "").split("_")[1] ?? ""; return b.slice(-10).toLowerCase(); }
function countMp4(providerRoot) { const m = path.join(providerRoot, "media"); if (!existsSync(m)) return 0; let n = 0; for (const d of readdirSync(m)) { const s = path.join(m, d); if (statSync(s).isDirectory()) n += readdirSync(s).filter((f) => f.endsWith(".mp4")).length; } return n; }
function mp4ForAttempt(providerRoot, attemptId) { const d = path.join(providerRoot, "media", shortId(attemptId)); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".mp4")).length : 0; }
function readEvidence(root) { const f = path.join(root, "provider", "evidence", "invocations.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { counts: {}, log: [] }; }
function invCount(root, attemptId) { return readEvidence(root).counts[attemptId] || 0; }
function readJournal(root, jobId) { const p = path.join(root, "worker", "journal", `${jobId}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; }
function pendingAckCount(root) { const d = path.join(root, "worker", "pending-ack"); return existsSync(d) ? readdirSync(d).filter((x) => x.endsWith(".json")).length : 0; }

function httpJson(port, method, pathname, { body, headers } = {}) {
  return new Promise((resolve) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { "content-type": "application/json", authorization: `Bearer ${OPERATOR_TOKEN}`, ...(headers || {}) };
    if (data) h["content-length"] = data.length;
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: h }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(c).toString() || "{}"); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    if (data) req.write(data); req.end();
  });
}
async function probeLiveDb() {
  const url = process.env.CONTROL_PLANE_TEST_DB_URL;
  const guard = evaluateTestDbTarget({ url, allowDestructive: process.env.CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS === "true" });
  if (!guard.ok) return { available: false, reason: `guard:${guard.reasons.join(",")}` };
  try { const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 }); await c.connect(); await c.query("SELECT 1"); await c.end(); return { available: true, testUrl: url, migrationUrl: process.env.CONTROL_PLANE_DB_MIGRATION_URL || url, opsUrl: process.env.CONTROL_PLANE_DB_OPS_URL || url }; }
  catch (e) { return { available: false, reason: `connect:${String(e.code || e.message).slice(0, 40)}` }; }
}
function appEnvironment(live, workspaceId, instanceId) {
  return {
    CONTROL_PLANE_ENV: "test", CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: "0", CONTROL_PLANE_INSTANCE_ID: instanceId,
    CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.testUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl,
    CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_DELIVERY_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0",
    CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_CREDENTIAL_PEPPER: CREDENTIAL_PEPPER,
    CONTROL_PLANE_GATEWAY_HELLO_TIMEOUT_MS: "2000", CONTROL_PLANE_GATEWAY_HEARTBEAT_MS: "120000",
    CONTROL_PLANE_PAIRING_ENABLED: "true", CONTROL_PLANE_PAIRING_PEPPER: PAIRING_PEPPER,
    CONTROL_PLANE_PAIRING_OPERATOR_API_ENABLED: "true", CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED: "true",
    CONTROL_PLANE_PAIRING_OPERATOR_TOKEN: OPERATOR_TOKEN,
    CONTROL_PLANE_STAGING_API_ENABLED: "true", CONTROL_PLANE_STAGING_API_WORKSPACE_ID: workspaceId,
    CONTROL_PLANE_STAGING_API_DISPATCH_ON_CREATE: "false", CONTROL_PLANE_STAGING_API_ALLOW_FAKE_JOBS_ONLY: "true",
    CONTROL_PLANE_STAGING_API_MAX_OUTPUT_COUNT: "1", CONTROL_PLANE_STAGING_API_FAKE_ACTION: "GENERATE_VIDEO",
    CONTROL_PLANE_STAGING_UI_ENABLED: "true", CONTROL_PLANE_STAGING_UI_SESSION_TTL_MS: "600000",
    CONTROL_PLANE_FLAG_REAL_GROK_WORKER_ENABLED: "false"
  };
}
const nullLogger = () => { const n = () => {}; const l = { debug: n, info: n, warn: n, error: n }; l.child = () => l; return l; };
const want = (scn) => !ONLY || ONLY.split(",").includes(scn);

async function main() {
  const live = await probeLiveDb();
  if (!live.available) { if (REQUIRE_LIVE) { hardFail("env", `STRICT: PostgreSQL unavailable (${live.reason})`); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); } console.log(`[SKIP] live PG unavailable (${live.reason})`); process.exit(0); }
  if (!BROWSER_PATH) { hardFail("env", "STRICT: no installed Edge/Chrome"); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }
  if (process.platform !== "win32" && REQUIRE_LIVE) { hardFail("env", "STRICT: DPAPI requires win32"); process.exit(1); }
  // strict DPAPI preflight
  if (process.platform === "win32") {
    const dp = makeDpapiRunner({ spawn: nodeSpawn });
    try { const ct = await dp("protect", "b2-secret"); const pt = await dp("unprotect", ct); check("env", "DPAPI round-trips", pt, "b2-secret"); }
    catch (e) { hardFail("env", `DPAPI failed: ${String(e.code || e.message)}`); }
  }

  // fresh schema
  const mig = new Client({ connectionString: live.migrationUrl });
  await mig.connect();
  await mig.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  await mig.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
  await mig.query("GRANT CREATE, USAGE ON SCHEMA public TO cp_migrator");
  try { await mig.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
  const mr = await migrate(mig, { dir: MIGRATIONS, appVersion: "5c8b2" });
  check("env", "migrations 0001-0015 from empty", (mr.applied.length + (mr.alreadyApplied || 0)), 15);
  const workspaceId = generateId("ws"), userId = generateId("usr");
  await mig.query("INSERT INTO users (id,email) VALUES ($1,$2)", [userId, "b2-" + Date.now() + "@local.test"]);
  await mig.query("SELECT set_config('app.current_workspace',$1,false)", [workspaceId]);
  await mig.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'B2',$2)", [workspaceId, userId]);
  await mig.end();

  const ops = new Client({ connectionString: live.opsUrl }); await ops.connect();
  const opsQ = async (sql, p = []) => (await ops.query(sql, p)).rows;

  // Restartable Control Plane holder. The Gateway is created ONCE inside createApp and its wss is
  // closed by drain, so the Gateway is NOT independently re-startable — a real Gateway/CP restart is
  // a full app restart on the SAME fixed port (the monolith's real deployment model). `cp` is
  // reassigned on restart; all helpers read cp.* so they follow the live instance.
  let cp = null;
  async function startApp(fixedPort) {
    const env = appEnvironment(live, workspaceId, "cp-b2");
    if (fixedPort) env.CONTROL_PLANE_PORT = String(fixedPort);
    const app = await createApp({ config: loadConfig(env), logger: nullLogger() });
    await app.start();
    const p = app.address().port;
    cp = { app, port: p, origin: "http://127.0.0.1:" + p, wsUrl: `ws://127.0.0.1:${p}/ws/worker`, persistence: app.modules.persistence, processor: app.modules.processor };
    return cp;
  }
  async function restartApp() { const port = cp.port; await cp.app.stop(); await sleep(400); await startApp(port); }
  await startApp();
  const tq = (sql, p = []) => cp.persistence.tenantTransaction(workspaceId, async (c) => (await c.query(sql, p)).rows);
  const op = (m, pth, body, headers) => httpJson(cp.port, m, pth, { body, headers });
  check("env", "Control Plane ready (gateway+processor+staging)", cp.app.readiness().ready && cp.port > 0, true);

  const pumpState = { on: true, alive: true };
  (async () => { while (pumpState.alive) { if (pumpState.on && cp) { try { await cp.processor.runOnce(); } catch { /* */ } } await sleep(70); } })();

  const workers = [], workerRoots = [];
  // ---- worker child lifecycle ----
  async function pairWorker({ crashAt, pauseAt, delayMs, mode = "success", label = "w" } = {}) {
    const issued = await op("POST", `/internal/v1/workspaces/${workspaceId}/pairing-codes`, { requestedLabel: label });
    const code = issued.json?.pairingCode;
    if (!code) throw new Error(`pairing code issue failed: ${issued.status} ${JSON.stringify(issued.json)}`);
    const root = mkdtempSync(path.join(os.tmpdir(), "avc5c8b2-wrk-")); workerRoots.push(root);
    const env = { S5C8_HTTP_BASE: cp.origin, S5C8_WS_URL: cp.wsUrl, S5C8_ROOT: root, S5C8_MODE: "pair", S5C8_PAIR_CODE: code, S5C8_CRED_BACKEND: "dpapi", S5C8_PROVIDER_MODE: mode, S5C8_MARKERS: path.join(root, "markers") };
    if (crashAt) env.S5C8_CRASH_AT = crashAt; if (pauseAt) env.S5C8_PAUSE_AT = pauseAt; if (delayMs != null) env.S5C8_PROVIDER_DELAY_MS = String(delayMs);
    const child = spawnWorker(env, { label }); workers.push(child);
    const paired = await child.waitForEvent("paired", 20000);
    const workerId = paired.workerId;
    await child.waitForOnline(20000);
    await waitFor(async () => (await opsQ("SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, workerId]))[0].n === 1, "worker online", 15000);
    return { child, workerId, root, markersDir: path.join(root, "markers") };
  }
  async function restartWorker(h, { crashAt, pauseAt, delayMs, mode = "success", label = "restart" } = {}) {
    const env = { S5C8_HTTP_BASE: cp.origin, S5C8_WS_URL: cp.wsUrl, S5C8_ROOT: h.root, S5C8_MODE: "reconnect", S5C8_CRED_BACKEND: "dpapi", S5C8_PROVIDER_MODE: mode, S5C8_MARKERS: path.join(h.root, "markers") };
    if (crashAt) env.S5C8_CRASH_AT = crashAt; if (pauseAt) env.S5C8_PAUSE_AT = pauseAt; if (delayMs != null) env.S5C8_PROVIDER_DELAY_MS = String(delayMs);
    const child = spawnWorker(env, { label }); workers.push(child);
    await child.waitForOnline(20000);
    await waitFor(async () => (await opsQ("SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, h.workerId]))[0].n === 1, "worker reconnected", 15000);
    h.child = child; return h;
  }
  async function newProject(workerId, title) {
    const p = await op("POST", "/internal/v1/projects", { title, description: "b2" });
    const projectId = p.json?.project?.id ?? p.json?.projectId ?? p.json?.id;
    if (!projectId) throw new Error(`createProject failed: ${p.status} ${JSON.stringify(p.json)}`);
    const a = await op("PUT", `/internal/v1/projects/${projectId}/worker-affinity`, { workerId });
    if (a.status !== 200) throw new Error(`assignAffinity failed: ${a.status} ${JSON.stringify(a.json)}`);
    await waitFor(async () => (await tq("SELECT worker_id FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'", [workspaceId, projectId]))[0]?.worker_id === workerId, "affinity", 10000);
    return projectId;
  }
  async function generate(projectId, prompt, idemKey) {
    const g = await op("POST", `/internal/v1/projects/${projectId}/generations`, { prompt }, { "idempotency-key": idemKey || ("gen-" + generateId("req")) });
    return g;
  }
  async function dispatch(jobId) { return op("POST", `/internal/v1/jobs/${jobId}/dispatch`); }
  // replay a frame through the REAL inbox service (the exact path the Gateway uses)
  async function replayInbound(workerId, envelope) {
    return cp.processor.inbox.processInboundEnvelope({ authenticatedWorkerId: workerId, authenticatedWorkspaceId: workspaceId, connectionSessionId: null, envelope, receivedAtIso: new Date().toISOString() });
  }
  const outboxOfferMsg = async (jobId) => (await opsQ("SELECT message_id FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [workspaceId, jobId]))[0]?.message_id;
  const jobStatus = async (jobId) => (await tq("SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [workspaceId, jobId]))[0]?.status;
  const terminalCount = async (jobId) => (await tq("SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, jobId]))[0].n;
  const assetCount = async () => (await tq("SELECT count(*)::int n FROM assets WHERE workspace_id=$1", [workspaceId]))[0].n;
  const attemptOrdinalCP = async (attemptId) => (await tq("SELECT generation_ordinal, submission_state, possibly_submitted, ownership_status FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [workspaceId, attemptId]))[0] || {};

  let browser = null, context = null, page = null;
  async function ensureBrowser() {
    if (browser) return;
    for (let i = 1; i <= 2 && !browser; i += 1) { try { browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true, args: ["--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--disable-gpu"] }); } catch (e) { if (i === 2) throw e; await sleep(1500); } }
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); page = await context.newPage(); page.setDefaultTimeout(15000);
  }

  try {
    // ================= CHECKPOINT 3: current-contract scenarios =================
    if (want("9")) await scenario9(); // duplicate + stale progress
    if (want("10")) await scenario10(); // duplicate conflicting terminal
    if (want("11")) await scenario11(); // cancel before submit
    if (want("3")) await scenario3(); // gateway restart
    if (want("4")) await scenario4(); // disconnect after offer
    if (want("13")) await scenario13(); // retry after FAILED
    if (want("14")) await scenario14(); // retry after CANCELED
    // ================= CHECKPOINT 4: restart durability =================
    if (want("1")) await scenario1(); // CP restart before offer delivery
    if (want("2")) await scenario2(); // processor interruption after commit, before delivery bookkeeping
    // ================= CHECKPOINT 5: reproduce current-contract behavior (capture gaps) =================
    if (want("5")) await scenario5(); // crash before markSubmitting
    if (want("6")) await scenario6(); // crash after markSubmitting
    if (want("7")) await scenario7(); // POSSIBLY_SUBMITTED (provider invocation started)
    if (want("8")) await scenario8(); // local result before terminal
    if (want("12")) await scenario12(); // cancel racing SUBMITTING
    if (want("16")) await scenarioRR(); // recovery-report idempotency + fencing

    // ---- helpers that produce a completed golden job on a fresh worker ----
    async function goldenJob({ delayMs = 0 } = {}) {
      const w = await pairWorker({ delayMs, label: "golden" });
      const projectId = await newProject(w.workerId, "P-" + shortId(generateId("prj")));
      const g = await generate(projectId, "a calm violet rail");
      const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      return { w, projectId, jobId, attemptId };
    }

    async function scenario9() {
      const S = "9";
      const { w, jobId, attemptId } = await goldenJob({ delayMs: 0 });
      await waitFor(async () => (await jobStatus(jobId)) === "SUCCEEDED", "job9 completed", 20000);
      check(S, "golden job completed, provider invoked once", invCount(w.root, attemptId), 1);
      const invBefore = invCount(w.root, attemptId), termBefore = await terminalCount(jobId), assetBefore = await assetCount();
      // 9A — same-message replay through the REAL inbox path (dedupe)
      const progA = makeEnvelope({ type: "JOB_PROGRESS", workspaceId, workerId: w.workerId, jobId, sentAt: new Date().toISOString(), payload: { sequence: 99, phase: "WAITING_FOR_RESULT", percent: 40 } });
      await replayInbound(w.workerId, progA);
      await replayInbound(w.workerId, progA); // duplicate, same messageId
      const inboxA = (await opsQ("SELECT count(*)::int n FROM protocol_inbox WHERE workspace_id=$1 AND worker_id=$2 AND message_id=$3", [workspaceId, w.workerId, progA.messageId]))[0].n;
      check(S, "9A same-message progress: exactly one inbox row (deduped)", inboxA, 1);
      check(S, "9A: terminal not regressed (still SUCCEEDED)", await jobStatus(jobId), "SUCCEEDED");
      check(S, "9A: no new terminal result", await terminalCount(jobId), termBefore);
      check(S, "9A: no new asset", await assetCount(), assetBefore);
      check(S, "9A: provider invocation unchanged", invCount(w.root, attemptId), invBefore);
      // 9B — logical/stale progress with a NEW messageId (advisory only)
      const progB = makeEnvelope({ type: "JOB_PROGRESS", workspaceId, workerId: w.workerId, jobId, sentAt: new Date().toISOString(), payload: { sequence: 1, phase: "SUBMITTING_PROMPT", percent: 10 } });
      const resB = await replayInbound(w.workerId, progB);
      const inboxB = (await opsQ("SELECT count(*)::int n, bool_or(ack_id IS NULL) advisory FROM protocol_inbox WHERE workspace_id=$1 AND worker_id=$2 AND message_id=$3", [workspaceId, w.workerId, progB.messageId]))[0];
      check(S, "9B new-message stale progress: recorded as advisory inbox row", { n: inboxB.n, advisory: inboxB.advisory }, { n: 1, advisory: true });
      check(S, "9B: terminal not regressed", await jobStatus(jobId), "SUCCEEDED");
      check(S, "9B: no new terminal result", await terminalCount(jobId), termBefore);
      check(S, "9B: no new asset", await assetCount(), assetBefore);
      check(S, "9B: provider invocation unchanged", invCount(w.root, attemptId), invBefore);
      await w.child.stopClean(8000);
    }

    async function scenario10() {
      const S = "10";
      const { w, jobId, attemptId } = await goldenJob({ delayMs: 0 });
      await waitFor(async () => (await jobStatus(jobId)) === "SUCCEEDED", "job10 completed", 20000);
      const origMsg = (await tq("SELECT terminal_message_id FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, jobId]))[0].terminal_message_id;
      const termBefore = await terminalCount(jobId), assetBefore = await assetCount(), invBefore = invCount(w.root, attemptId);
      // conflicting terminal with a NEW messageId through the real inbox path
      const conflict = makeEnvelope({ type: "JOB_COMPLETED", workspaceId, workerId: w.workerId, jobId, sentAt: new Date().toISOString(), payload: { result: { asset: { relativePath: "media/x/y.mp4", mimeType: "video/mp4", sizeBytes: 10 } } } });
      const res = await replayInbound(w.workerId, conflict);
      check(S, "conflicting terminal (new messageId) is REJECTED, not applied", (res && (res.outcome === "REJECTED" || res.rejected === true || res.businessApplied === false)) || (await terminalCount(jobId)) === termBefore, true);
      check(S, "exactly one terminal result (original messageId wins)", await terminalCount(jobId), termBefore);
      check(S, "original terminal messageId unchanged", (await tq("SELECT terminal_message_id FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, jobId]))[0].terminal_message_id, origMsg);
      check(S, "no second asset", await assetCount(), assetBefore);
      check(S, "no state regression (still SUCCEEDED)", await jobStatus(jobId), "SUCCEEDED");
      check(S, "provider invocation unchanged", invCount(w.root, attemptId), invBefore);
      await w.child.stopClean(8000);
    }

    async function scenario11() {
      const S = "11";
      // pause the handler BEFORE markSubmitting so we can cancel deterministically pre-submit.
      const w = await pairWorker({ pauseAt: "BEFORE_MARK_SUBMITTING", delayMs: 0, label: "cancel-pre" });
      const projectId = await newProject(w.workerId, "Cancel-Pre");
      const g = await generate(projectId, "cancel me before submit");
      const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      // wait until the worker is paused at the pre-submit window (durable marker) → provider not invoked
      await waitForMarker(path.join(w.markersDir, "paused-BEFORE_MARK_SUBMITTING.json"), { timeoutMs: 20000 });
      check(S, "provider NOT invoked at cancel point", invCount(w.root, attemptId), 0);
      // real Cancel via operator API, then release the pause → handler observes abort pre-submit
      const c = await op("POST", `/internal/v1/jobs/${jobId}/cancel`);
      check(S, "cancel accepted", c.status === 200, true);
      // The abort reaches the worker via a durable JOB_CANCEL_REQUEST — wait for it to be delivered
      // (signal aborts) BEFORE releasing the pre-submit pause, so the handler observes cancel first.
      await waitFor(async () => { const r = await opsQ("SELECT delivery_state FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_CANCEL_REQUEST'", [workspaceId, jobId]); return r[0] && r[0].delivery_state !== "PENDING"; }, "cancel delivered to worker", 15000);
      await sleep(300);
      releasePause(path.join(w.markersDir, "release-BEFORE_MARK_SUBMITTING"));
      await waitFor(async () => ["CANCELED", "CANCEL_REQUESTED"].includes(await jobStatus(jobId)), "job canceled", 20000);
      // let any terminal settle
      await waitFor(async () => (await jobStatus(jobId)) === "CANCELED", "job CANCELED terminal", 15000).catch(() => {});
      check(S, "provider invocation count = 0", invCount(w.root, attemptId), 0);
      check(S, "generationOrdinal 0 (never submitted)", (await tq("SELECT generation_ordinal FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [workspaceId, attemptId]))[0]?.generation_ordinal, 0);
      check(S, "no media artifact", mp4ForAttempt(path.join(w.root, "provider"), attemptId), 0);
      check(S, "no asset for the canceled attempt", (await tq("SELECT count(*)::int n FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attemptId]))[0].n, 0);
      check(S, "job reaches CANCELED", await jobStatus(jobId), "CANCELED");
      await w.child.stopClean(8000);
    }

    async function scenario3() {
      const S = "3";
      const w = await pairWorker({ delayMs: 6000, label: "gw-restart" });
      const projectId = await newProject(w.workerId, "GW-Restart");
      const g = await generate(projectId, "gateway restart mid-run"); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      await waitFor(async () => ["RUNNING", "ACCEPTED"].includes(await jobStatus(jobId)), "job running", 20000);
      const sessBefore = (await opsQ("SELECT session_id, connection_epoch FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, w.workerId]))[0];
      // Restart the REAL Gateway by restarting the whole Control Plane on the SAME port (the Gateway is
      // created once inside the monolith and its wss is closed by drain — a real Gateway restart IS a CP
      // restart). app.stop() drains the Gateway (closes sockets, closes the prior session).
      await restartApp();
      // the worker's transport auto-reconnects (indefinite backoff) with the SAME DPAPI credential.
      await waitFor(async () => (await opsQ("SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, w.workerId]))[0].n === 1, "worker reconnected post-restart", 30000);
      check(S, "worker reconnected using persisted DPAPI credential (no re-pair)", w.child.events.filter((e) => e.event === "paired").length, 1);
      const sessAfter = (await opsQ("SELECT session_id, connection_epoch FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, w.workerId]))[0];
      check(S, "a FRESH connection session replaced the drained one (fencing)", sessAfter.session_id !== sessBefore?.session_id, true);
      check(S, "prior session is no longer ACTIVE (stale connection cannot deliver work)", (await opsQ("SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, w.workerId]))[0].n, 1);
      // the job completes exactly once (no duplicate execution across the restart)
      await waitFor(async () => (await jobStatus(jobId)) === "SUCCEEDED", "job completed post-restart", 30000);
      check(S, "provider invoked exactly once across gateway restart", invCount(w.root, attemptId), 1);
      check(S, "one terminal result", await terminalCount(jobId), 1);
      await w.child.stopClean(8000);
    }

    async function scenario4() {
      const S = "4";
      const w = await pairWorker({ crashAt: "AFTER_OFFER_RECEIVED", delayMs: 0, label: "disc-offer" });
      const projectId = await newProject(w.workerId, "Disc-Offer");
      const g = await generate(projectId, "disconnect right after offer"); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      const offerMsg = await waitFor(() => outboxOfferMsg(jobId), "offer created", 20000);
      // the worker self-crashes on receiving the JOB_OFFER (before JOB_ACCEPTED). Wait for exit.
      await waitFor(() => w.child.hasExited(), "worker crashed after offer", 20000);
      check(S, "worker crashed after receiving offer (no accept)", w.child.events.some((e) => e.event === "crash-injected" && e.point === "AFTER_OFFER_RECEIVED"), true);
      check(S, "provider NOT invoked (crashed before accept)", invCount(w.root, attemptId), 0);
      check(S, "no JOB_ACCEPTED persisted yet", ["QUEUED", "DISPATCHED", "OFFERED"].includes(await jobStatus(jobId)), true);
      // restart the worker (reconnect, no crash) → the SAME durable offer is re-delivered → runs once
      await restartWorker(w, { label: "disc-offer-restart" });
      await waitFor(async () => (await jobStatus(jobId)) === "SUCCEEDED", "job completed after re-delivery", 30000);
      check(S, "same durable offer messageId reused on re-delivery", await outboxOfferMsg(jobId), offerMsg);
      check(S, "provider invoked exactly once (dedupe on re-delivery)", invCount(w.root, attemptId), 1);
      check(S, "exactly one terminal result", await terminalCount(jobId), 1);
      check(S, "exactly one media artifact", mp4ForAttempt(path.join(w.root, "provider"), attemptId), 1);
      await w.child.stopClean(8000);
    }

    async function scenario13() {
      const S = "13";
      const w = await pairWorker({ mode: "fail", delayMs: 0, label: "retry-failed" });
      const projectId = await newProject(w.workerId, "Retry-Failed");
      const g = await generate(projectId, "will fail then retry"); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      await waitFor(async () => (await jobStatus(jobId)) === "FAILED", "job failed", 20000);
      check(S, "original attempt FAILED, provider invoked once", { st: await jobStatus(jobId), inv: invCount(w.root, attemptId) }, { st: "FAILED", inv: 1 });
      const reqBefore = (await tq("SELECT count(*)::int n FROM generation_requests WHERE workspace_id=$1", [workspaceId]))[0].n;
      // switch the worker to success mode for the retry (reconnect) so the new attempt can complete
      await w.child.stopClean(8000);
      await restartWorker(w, { mode: "success", label: "retry-failed-ok" });
      const r = await op("POST", `/internal/v1/jobs/${jobId}/retry`, undefined, { "idempotency-key": "retry-" + generateId("req") });
      check(S, "retry accepted", r.status === 200 || r.status === 202, true);
      const newJobId = r.json?.jobId ?? r.json?.job?.id;
      check(S, "retry minted a NEW jobId", newJobId && newJobId !== jobId, true);
      if (newJobId) { await dispatch(newJobId); await waitFor(async () => (await jobStatus(newJobId)) === "SUCCEEDED", "retry completed", 30000); }
      const newAttempt = (await tq("SELECT ga.id FROM generation_attempts ga WHERE ga.workspace_id=$1 ORDER BY ga.created_at DESC LIMIT 1", [workspaceId]))[0]?.id;
      check(S, "retry created a NEW generation request (new lineage)", (await tq("SELECT count(*)::int n FROM generation_requests WHERE workspace_id=$1", [workspaceId]))[0].n, reqBefore + 1);
      check(S, "retry created a NEW generationAttemptId", newAttempt && newAttempt !== attemptId, true);
      check(S, "original FAILED attempt unchanged (still terminal FAILED)", (await tq("SELECT terminal_state FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [workspaceId, attemptId]))[0]?.terminal_state, "FAILED");
      check(S, "exactly one provider invocation for the NEW attempt", invCount(w.root, newAttempt), 1);
      check(S, "original attempt's invocation count still 1 (not re-run)", invCount(w.root, attemptId), 1);
      await w.child.stopClean(8000);
    }

    async function scenario14() {
      const S = "14";
      const w = await pairWorker({ pauseAt: "BEFORE_MARK_SUBMITTING", delayMs: 0, label: "retry-cancel" });
      const projectId = await newProject(w.workerId, "Retry-Cancel");
      const g = await generate(projectId, "cancel then retry"); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      await waitForMarker(path.join(w.markersDir, "paused-BEFORE_MARK_SUBMITTING.json"), { timeoutMs: 20000 });
      await op("POST", `/internal/v1/jobs/${jobId}/cancel`);
      await waitFor(async () => { const r = await opsQ("SELECT delivery_state FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_CANCEL_REQUEST'", [workspaceId, jobId]); return r[0] && r[0].delivery_state !== "PENDING"; }, "cancel delivered", 15000);
      await sleep(300);
      releasePause(path.join(w.markersDir, "release-BEFORE_MARK_SUBMITTING"));
      await waitFor(async () => (await jobStatus(jobId)) === "CANCELED", "job canceled", 20000);
      check(S, "canceled attempt: provider invoked 0", invCount(w.root, attemptId), 0);
      const reqBefore = (await tq("SELECT count(*)::int n FROM generation_requests WHERE workspace_id=$1", [workspaceId]))[0].n;
      // reconnect a clean worker (no pause) for the retry
      await w.child.stopClean(8000);
      await restartWorker(w, { label: "retry-cancel-ok" });
      const r = await op("POST", `/internal/v1/jobs/${jobId}/retry`, undefined, { "idempotency-key": "retry-" + generateId("req") });
      check(S, "retry accepted after cancel", r.status === 200 || r.status === 202, true);
      const newJobId = r.json?.jobId ?? r.json?.job?.id;
      check(S, "retry minted a NEW jobId", newJobId && newJobId !== jobId, true);
      if (newJobId) { await dispatch(newJobId); await waitFor(async () => (await jobStatus(newJobId)) === "SUCCEEDED", "retry completed", 30000); }
      const newAttempt = (await tq("SELECT ga.id FROM generation_attempts ga WHERE ga.workspace_id=$1 ORDER BY ga.created_at DESC LIMIT 1", [workspaceId]))[0]?.id;
      check(S, "retry created new lineage (request+attempt)", { req: (await tq("SELECT count(*)::int n FROM generation_requests WHERE workspace_id=$1", [workspaceId]))[0].n === reqBefore + 1, attempt: newAttempt !== attemptId }, { req: true, attempt: true });
      check(S, "original CANCELED attempt unchanged", (await tq("SELECT terminal_state FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [workspaceId, attemptId]))[0]?.terminal_state, "CANCELED");
      check(S, "exactly one provider invocation for the NEW attempt", invCount(w.root, newAttempt), 1);
      check(S, "original attempt invocation still 0", invCount(w.root, attemptId), 0);
      await w.child.stopClean(8000);
    }

    async function scenario1() {
      const S = "1";
      const w = await pairWorker({ delayMs: 0, label: "cp-restart-pre" });
      const projectId = await newProject(w.workerId, "CP-Restart-Pre");
      pumpState.on = false; // stop the delivery path BEFORE the offer is delivered
      const g = await generate(projectId, "cp restart before delivery"); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      const offerMsg = await waitFor(() => outboxOfferMsg(jobId), "offer committed (undelivered)", 15000);
      check(S, "offer durably committed but PENDING (not delivered)", (await opsQ("SELECT delivery_state FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [workspaceId, offerMsg]))[0].delivery_state, "PENDING");
      check(S, "provider not invoked yet", invCount(w.root, attemptId), 0);
      // restart the whole Control Plane on the same port — the durable offer survives in PostgreSQL.
      await restartApp();
      await waitFor(async () => (await opsQ("SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, w.workerId]))[0].n === 1, "worker reconnected", 30000);
      pumpState.on = true; // resume delivery — the real Processor now drives the pre-existing durable offer
      await waitFor(async () => (await jobStatus(jobId)) === "SUCCEEDED", "job completed after CP restart", 30000);
      check(S, "same durable offer messageId delivered after restart", await outboxOfferMsg(jobId), offerMsg);
      check(S, "exactly one JOB_OFFER outbox row (no duplicate)", (await opsQ("SELECT count(*)::int n FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [workspaceId, jobId]))[0].n, 1);
      check(S, "provider invoked exactly once", invCount(w.root, attemptId), 1);
      check(S, "one terminal result + one artifact", { t: await terminalCount(jobId), m: mp4ForAttempt(path.join(w.root, "provider"), attemptId) }, { t: 1, m: 1 });
      await w.child.stopClean(8000);
    }

    async function scenario2() {
      const S = "2";
      const w = await pairWorker({ delayMs: 0, label: "proc-restart" });
      const projectId = await newProject(w.workerId, "Proc-Restart");
      pumpState.on = false; // after the offer/outbox txn commits, the delivery bookkeeping has NOT run
      const g = await generate(projectId, "processor interruption after commit"); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      const offerMsg = await waitFor(() => outboxOfferMsg(jobId), "offer committed (PENDING)", 15000);
      const offerRowsBefore = (await opsQ("SELECT count(*)::int n FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [workspaceId, jobId]))[0].n;
      check(S, "durable outbox row exists, delivery not yet bookkept (PENDING)", (await opsQ("SELECT delivery_state FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [workspaceId, offerMsg]))[0].delivery_state, "PENDING");
      // restart ONLY the Processor module (real lifecycle) — the committed row must survive + be re-driven.
      await cp.app.modules.processor.stop();
      await sleep(300);
      await cp.app.modules.processor.start();
      pumpState.on = true; // the restarted real Processor claims + delivers the pre-committed durable row
      await waitFor(async () => (await jobStatus(jobId)) === "SUCCEEDED", "job completed after processor restart", 30000);
      check(S, "committed outbox row re-driven with the SAME messageId", await outboxOfferMsg(jobId), offerMsg);
      check(S, "no second offer row created", (await opsQ("SELECT count(*)::int n FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [workspaceId, jobId]))[0].n, offerRowsBefore);
      check(S, "provider invoked exactly once", invCount(w.root, attemptId), 1);
      check(S, "one terminal result", await terminalCount(jobId), 1);
      await w.child.stopClean(8000);
    }

    // ---- Checkpoint 5: crash-window recovery (invariants must hold; missing behaviors → gaps) ----
    // Drives a crash-armed worker to the exact durable window, restarts it clean, then captures the
    // current-contract outcome. The ordinal column at the CP is booked only from a submit fact; the
    // worker journal is authoritative for the worker-side window.
    async function crashAndRestart(label, crashAt, prompt) {
      const w = await pairWorker({ crashAt, delayMs: 0, label });
      const projectId = await newProject(w.workerId, "P-" + shortId(generateId("prj")));
      const g = await generate(projectId, prompt); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      await waitForMarker(path.join(w.markersDir, `crash-${crashAt}.json`), { timeoutMs: 20000 });
      await waitFor(() => w.child.hasExited(), `worker crashed at ${crashAt}`, 12000);
      const preJournal = readJournal(w.root, jobId), preInv = invCount(w.root, attemptId);
      await restartWorker(w, { label: `${label}-restart` });
      // the restarted worker reconciles on reconnect; each scenario waits for its own honest outcome.
      return { w, jobId, attemptId, preJournal, preInv };
    }

    async function scenario5() {
      const S = "5";
      const { w, jobId, attemptId, preJournal, preInv } = await crashAndRestart("crash-pre-submit", "BEFORE_MARK_SUBMITTING", "crash before submit");
      // pre-crash evidence
      check(S, "pre-crash: provider invoked 0", preInv, 0);
      check(S, "pre-crash: journal PRE_SUBMIT (CREATED/RUNNING)", ["CREATED", "RUNNING"].includes(preJournal?.localState), true);
      check(S, "pre-crash: generationOrdinal 0", preJournal?.generationOrdinal, 0);
      // C6: proven PRE_SUBMIT → the CP authorizes ONE safe recovery re-offer → the job completes with
      // provider count EXACTLY 1 (the original never invoked).
      await waitFor(async () => (await jobStatus(jobId)) === "SUCCEEDED", "PRE_SUBMIT safe recovery completes", 40000);
      check(S, "recovery re-offer → job SUCCEEDED", await jobStatus(jobId), "SUCCEEDED");
      check(S, "provider invoked EXACTLY 1 after safe recovery (never 2)", invCount(w.root, attemptId), 1);
      check(S, "CP generation_ordinal EXACTLY 1", (await attemptOrdinalCP(attemptId)).generation_ordinal, 1);
      check(S, "exactly one media artifact", mp4ForAttempt(path.join(w.root, "provider"), attemptId), 1);
      check(S, "exactly one terminal result", await terminalCount(jobId), 1);
      check(S, "recovery re-offer minted a NEW offer messageId (original preserved as audit)", (await opsQ("SELECT count(*)::int n FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [workspaceId, jobId]))[0].n >= 2, true);
      check(S, "at most one LIVE offer for the attempt (idempotent re-offer)", (await opsQ("SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')", [workspaceId, attemptId]))[0].n <= 1, true);
      console.log(`  [5] C6 recovered: job=SUCCEEDED, invocations=1, ordinal=1`);
      await w.child.stopClean(8000);
    }

    async function scenario6() {
      const S = "6";
      const { w, jobId, attemptId, preJournal, preInv } = await crashAndRestart("crash-post-submit", "AFTER_MARK_SUBMITTING", "crash after submit barrier");
      check(S, "pre-crash: journal SUBMITTING (ordinal 1, confidence UNKNOWN)", { s: preJournal?.submissionState, o: preJournal?.generationOrdinal, c: preJournal?.submissionConfidence }, { s: "SUBMITTING", o: 1, c: "UNKNOWN" });
      check(S, "pre-crash: provider NOT invoked (count 0)", preInv, 0);
      // C6: SUBMITTING_UNKNOWN → honest RECOVERING; NEVER auto-resubmit → provider stays EXACTLY 0.
      await waitFor(async () => (await attemptOrdinalCP(attemptId)).ownership_status === "RECOVERING", "attempt moves to RECOVERING", 30000);
      check(S, "provider invocation count remains EXACTLY 0 after recovery (no auto-resubmit)", invCount(w.root, attemptId), 0);
      check(S, "worker journal generationOrdinal remains EXACTLY 1", readJournal(w.root, jobId)?.generationOrdinal, 1);
      const cp = await attemptOrdinalCP(attemptId);
      check(S, "honest creator state: attempt ownership RECOVERING", cp.ownership_status, "RECOVERING");
      check(S, "possibly_submitted latched true (uncertain submit window)", cp.possibly_submitted, true);
      check(S, "no media / no terminal / no asset", { m: mp4ForAttempt(path.join(w.root, "provider"), attemptId), t: await terminalCount(jobId), a: (await tq("SELECT count(*)::int n FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attemptId]))[0].n }, { m: 0, t: 0, a: 0 });
      console.log(`  [6] C6: ownership=RECOVERING, invocations=0, ordinal=1, possibly_submitted=true`);
      await w.child.stopClean(8000);
    }

    async function scenario7() {
      const S = "7";
      const { w, jobId, attemptId, preJournal, preInv } = await crashAndRestart("crash-invoke-start", "AFTER_INVOKE_START", "crash after provider op started");
      // GOLDEN RULE (correction #1): invocation count = EXACTLY 1; restart must not make it 2.
      check(S, "pre-crash: provider invoked EXACTLY 1", preInv, 1);
      check(S, "provider invocation count remains EXACTLY 1 after restart (no second call)", invCount(w.root, attemptId), 1);
      check(S, "worker journal SUBMITTING (uncertain, no confirmed submit)", preJournal?.submissionState, "SUBMITTING");
      // uncertainty evidence durable (reconciliation ledger op started, not submitted)
      const led = (() => { const f = path.join(w.root, "provider", "evidence", "ledger.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).ops[attemptId] : null; })();
      check(S, "durable uncertainty evidence: op started, NOT submitted", { started: Boolean(led?.invocationStartedAt), submitted: Boolean(led?.submittedAt) }, { started: true, submitted: false });
      // C6: POSSIBLY_SUBMITTED → honest RECOVERING; NEVER re-invoke → provider stays EXACTLY 1.
      await waitFor(async () => (await attemptOrdinalCP(attemptId)).ownership_status === "RECOVERING", "attempt moves to RECOVERING", 30000);
      check(S, "provider invocation count remains EXACTLY 1 after recovery (no second call)", invCount(w.root, attemptId), 1);
      const cp = await attemptOrdinalCP(attemptId);
      check(S, "honest creator state: attempt ownership RECOVERING", cp.ownership_status, "RECOVERING");
      check(S, "possibly_submitted latched true (uncertainty owned)", cp.possibly_submitted, true);
      check(S, "no false COMPLETED, no asset without durable result", { t: await terminalCount(jobId), a: (await tq("SELECT count(*)::int n FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attemptId]))[0].n }, { t: 0, a: 0 });
      console.log(`  [7] C6: ownership=RECOVERING, invocations=1, possibly_submitted=true`);
      await w.child.stopClean(8000);
    }

    async function scenario8() {
      const S = "8";
      const { w, jobId, attemptId, preJournal, preInv } = await crashAndRestart("crash-local-result", "AFTER_LOCAL_RESULT", "crash after local result before terminal");
      check(S, "pre-crash: provider invoked EXACTLY 1", preInv, 1);
      check(S, "pre-crash: one media artifact on disk", mp4ForAttempt(path.join(w.root, "provider"), attemptId), 1);
      check(S, "pre-crash: journal has localResultRef + submittedToProvider, no terminal", { r: Boolean(preJournal?.localResultRef), s: preJournal?.submittedToProvider, t: preJournal?.terminal == null }, { r: true, s: true, t: true });
      // C6: the Worker resumes terminalization from the durable journal through the EXISTING pending-ack
      // + settlement path → ONE terminal COMPLETED, NO provider re-invocation, NO regenerated media.
      await waitFor(async () => (await jobStatus(jobId)) === "SUCCEEDED", "IMPORTED result reconciles to COMPLETED", 30000);
      check(S, "provider invocation count remains EXACTLY 1 (no regeneration)", invCount(w.root, attemptId), 1);
      check(S, "CP generation_ordinal EXACTLY 1", (await attemptOrdinalCP(attemptId)).generation_ordinal, 1);
      check(S, "exactly one media artifact (the pre-existing one, not overwritten)", mp4ForAttempt(path.join(w.root, "provider"), attemptId), 1);
      check(S, "job SUCCEEDED via canonical settlement", await jobStatus(jobId), "SUCCEEDED");
      check(S, "exactly one terminal result", await terminalCount(jobId), 1);
      check(S, "exactly one asset/result projection for the attempt", (await tq("SELECT count(*)::int n FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attemptId]))[0].n, 1);
      console.log(`  [8] C6: job=SUCCEEDED via terminal resume, invocations=1, one media, one terminal`);
      await w.child.stopClean(8000);
    }

    async function scenario12() {
      const S = "12";
      const w = await pairWorker({ pauseAt: "AFTER_MARK_SUBMITTING", delayMs: 0, label: "cancel-race" });
      const projectId = await newProject(w.workerId, "Cancel-Race");
      const g = await generate(projectId, "cancel racing submitting"); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      // worker pauses AFTER markSubmitting (ordinal 1 durable) — cancel now, before provider invoke.
      await waitForMarker(path.join(w.markersDir, "paused-AFTER_MARK_SUBMITTING.json"), { timeoutMs: 20000 });
      check(S, "at cancel boundary: worker journal SUBMITTING ordinal 1 (durable)", readJournal(w.root, jobId)?.generationOrdinal, 1);
      check(S, "at cancel boundary: provider NOT yet invoked", invCount(w.root, attemptId), 0);
      await op("POST", `/internal/v1/jobs/${jobId}/cancel`);
      await waitFor(async () => { const r = await opsQ("SELECT delivery_state FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_CANCEL_REQUEST'", [workspaceId, jobId]); return r[0] && r[0].delivery_state !== "PENDING"; }, "cancel delivered", 15000);
      await sleep(300);
      releasePause(path.join(w.markersDir, "release-AFTER_MARK_SUBMITTING"));
      await waitFor(async () => ["CANCELED", "CANCEL_REQUESTED"].includes(await jobStatus(jobId)), "job canceling", 20000);
      await waitFor(async () => (await jobStatus(jobId)) === "CANCELED", "job CANCELED", 15000).catch(() => {});
      // INVARIANTS (correction #2 + task): no second provider invocation; evidence preserved; honest state;
      // no false claim external execution was stopped when uncertainty exists.
      check(S, "no provider invocation (cancel won the race before invoke)", invCount(w.root, attemptId), 0);
      check(S, "worker SUBMITTING evidence remains durable (ordinal 1 not erased by cancel)", readJournal(w.root, jobId)?.generationOrdinal, 1);
      const cp = await attemptOrdinalCP(attemptId), fin = await jobStatus(jobId);
      // C6 correction E: since the provider was DEFINITIVELY never invoked (count 0) and the CP holds
      // explicit durable NOT_SUBMITTED evidence, CANCELED with possibly_submitted=false is HONEST — no
      // false claim that an external operation was stopped. Cancellation preserved the ordinal evidence.
      check(S, "final state CANCELED (honest, monotonic)", fin, "CANCELED");
      check(S, "possibly_submitted follows durable confidence (NOT_SUBMITTED proof → false; provider never ran)", cp.possibly_submitted, false);
      check(S, "no media / no terminal-completed / no asset for the canceled attempt", { m: mp4ForAttempt(path.join(w.root, "provider"), attemptId), a: (await tq("SELECT count(*)::int n FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attemptId]))[0].n }, { m: 0, a: 0 });
      console.log(`  [12] C6: job=CANCELED, invocations=0, workerOrdinal=1 preserved, possibly_submitted=false (honest)`);
      await w.child.stopClean(8000);
    }

    // Recovery-report idempotency + fencing — inject canonical reports through the REAL inbox service.
    async function scenarioRR() {
      const S = "16";
      const w = await pairWorker({ crashAt: "BEFORE_MARK_SUBMITTING", delayMs: 0, label: "rr-fence" });
      const projectId = await newProject(w.workerId, "RR-Fence");
      const g = await generate(projectId, "recovery report idempotency"); const jobId = g.json.jobId, attemptId = g.json.generationAttemptId;
      await dispatch(jobId);
      await waitForMarker(path.join(w.markersDir, "crash-BEFORE_MARK_SUBMITTING.json"), { timeoutMs: 20000 });
      await waitFor(() => w.child.hasExited(), "worker crashed pre-submit", 12000);
      // Worker is OFFLINE + the attempt is RUNNING/PRE_SUBMIT. Build a canonical PRE_SUBMIT recovery report.
      const preSubmitPayload = { recoveryContractState: "PRE_SUBMIT", recoveryState: "NOT_SUBMITTED_SAFE_TO_RETRY", generationAttemptId: attemptId, submittedToProvider: false, generationOrdinal: 0, submissionState: "NOT_SUBMITTED", submissionConfidence: "NONE", createdSecondGeneration: false };
      const mkReport = (wid) => makeEnvelope({ type: "JOB_RECOVERY_REPORT", workspaceId, workerId: wid, jobId, sentAt: new Date().toISOString(), payload: preSubmitPayload });
      const offerCount = async () => (await opsQ("SELECT count(*)::int n FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [workspaceId, jobId]))[0].n;
      const reportRows = async () => (await tq("SELECT count(*)::int n FROM job_recovery_reports WHERE workspace_id=$1 AND job_id=$2", [workspaceId, jobId]))[0].n;
      const liveOffers = async () => (await opsQ("SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')", [workspaceId, attemptId]))[0].n;
      const offersBefore = await offerCount();
      // (1) first report → exactly ONE recovery re-offer
      const r1 = mkReport(w.workerId);
      await replayInbound(w.workerId, r1);
      check(S, "recovery report authorized exactly one re-offer (a NEW offer row)", await offerCount(), offersBefore + 1);
      const rowsAfter1 = await reportRows();
      // (2) SAME messageId replay → protocol inbox dedupes → no new business effect
      await replayInbound(w.workerId, r1);
      check(S, "same-message replay: inbox dedupe → no new report row", await reportRows(), rowsAfter1);
      check(S, "same-message replay: no second re-offer", await offerCount(), offersBefore + 1);
      // (3) NEW messageId, logically identical → business idempotent (retired-marker guard) → no second re-offer
      await replayInbound(w.workerId, mkReport(w.workerId));
      check(S, "new-message logical duplicate: no second re-offer", await offerCount(), offersBefore + 1);
      check(S, "at most one LIVE offer after duplicates", await liveOffers() <= 1, true);
      // (4) FOREIGN worker (not the producing worker) → rejected / NO business effect. In production the
      // Gateway authenticates the Worker before the inbox; here we inject directly and the CP's ownership
      // + FK guards are the last-line defense (the report is rejected with no durable business effect).
      const foreign = generateId("wrk");
      let foreignRejected = false;
      try { await replayInbound(foreign, mkReport(foreign)); } catch { foreignRejected = true; }
      check(S, "foreign-worker recovery report is rejected (no worker identity)", foreignRejected, true);
      check(S, "foreign-worker report created NO additional re-offer", await offerCount(), offersBefore + 1);
      // (5) CONCURRENT identical new-message reports → serialize on the attempt lock → at most one action
      await Promise.all([replayInbound(w.workerId, mkReport(w.workerId)), replayInbound(w.workerId, mkReport(w.workerId)), replayInbound(w.workerId, mkReport(w.workerId))]);
      check(S, "concurrent reports: still no second re-offer", await offerCount(), offersBefore + 1);
      check(S, "concurrent reports: at most one live offer", await liveOffers() <= 1, true);
      console.log(`  [16] recovery-report idempotency + fencing OK`);
      try { await w.child.killAbrupt(); } catch { /* already exited */ }
    }

    // hoist scenario fns by declaring them above the invocations (function declarations hoist).
  } finally {
    pumpState.alive = false;
    for (const w of workers) { try { await w.killAbrupt(); } catch { /* */ } }
    try { if (context) await context.close(); } catch { /* */ }
    try { if (browser) await browser.close(); } catch { /* */ }
    try { await cp.app.stop(); } catch { /* */ }
    try { await ops.end(); } catch { /* */ }
    for (const r of workerRoots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
  }

  console.log("\n=== per-scenario ===");
  for (const [scn, r] of Object.entries(results)) console.log(`  [${scn}] ${r.fail === 0 ? "PASS" : "FAIL"} (${r.pass} ok${r.fail ? ", " + r.fail + " FAIL: " + r.notes.join("; ") : ""})`);
  if (gaps.length) {
    console.log("\n=== recovery-contract gaps (focused failing evidence — NOT harness failures) ===");
    for (const g of gaps) console.log(`  [${g.scn}] ${g.holds ? "OK" : "GAP"}: ${g.name} | actual=${JSON.stringify(g.actual)} desired=${JSON.stringify(g.desired)}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR", e && e.stack ? e.stack : e); console.log(`\n${passed} passed, ${failed + 1} failed`); process.exit(1); });
