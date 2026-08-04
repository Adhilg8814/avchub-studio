#!/usr/bin/env node
// P0 Step 5C.8B1 — STRICT full-stack live E2E: real Control Plane + Processor + WebSocket Gateway
// + Step 5C.5 pairing + Step 5C.6 staging API/UI + Microsoft Edge (playwright-core) + a REAL
// Worker CHILD PROCESS (scripts/worker-step5c8-runner.mjs → createPairedWorker → WorkerRuntime →
// RecoveryJournal/PendingAckStore → DPAPI credential store) + the deterministic fake GENERATE_VIDEO
// provider. NO raw-WebSocket fake worker; the harness constructs NO JOB_ACCEPTED/PROGRESS/COMPLETED.
//
// Strict mode (--require-live): PostgreSQL / Edge / Worker-pair / DPAPI unavailable → HARD FAIL,
// never a silent skip. Run: node tests/step5c8-control-plane-worker-e2e-tests.mjs --require-live

import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Client } from "pg";
import { createApp } from "../control-plane/src/app.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { migrate } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { evaluateTestDbTarget } from "../control-plane/src/persistence/postgres/test-db-safety.mjs";
import { spawn as nodeSpawn } from "node:child_process";
import { generateId } from "../lib/protocol/ids.mjs";
import { makeDpapiRunner } from "../lib/worker/credential-store.mjs";
import { spawnWorker } from "./helpers/step5c8-process-control.mjs";

const REQUIRE_LIVE = process.argv.includes("--require-live");
const ROOTDIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(ROOTDIR, "..", "control-plane", "database", "migrations");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BROWSER_PATH = existsSync(EDGE) ? EDGE : (existsSync(CHROME) ? CHROME : null);
const OPERATOR_TOKEN = "step5c8b1-op-" + randomBytes(24).toString("base64url");
const CREDENTIAL_PEPPER = "step5c8b1-credential-pepper-fixed-000001";
const PAIRING_PEPPER = "step5c8b1-pairing-pepper-fixed-0000002";
const PROMPT = "a calm violet rail at dusk";

let passed = 0, failed = 0;
const diagnosticSecrets = new Set();
function secret(s) { if (s) diagnosticSecrets.add(String(s)); return s; }
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function hardFail(msg) { failed += 1; console.error(`FATAL ${msg}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, desc, timeoutMs = 15000, stepMs = 120) {
  const t0 = Date.now();
  for (;;) { let v; try { v = await pred(); } catch { v = false; } if (v) return v; if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${desc}`); await sleep(stepMs); }
}
function countMp4(providerRoot) {
  const media = path.join(providerRoot, "media");
  if (!existsSync(media)) return 0;
  let n = 0;
  for (const d of readdirSync(media)) { const sub = path.join(media, d); if (statSync(sub).isDirectory()) n += readdirSync(sub).filter((f) => f.endsWith(".mp4")).length; }
  return n;
}
function readProviderEvidence(root) {
  const f = path.join(root, "provider", "evidence", "invocations.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { counts: {}, log: [] };
}
function shortId(id) { const b = String(id ?? "").split("_")[1] ?? ""; return b.slice(-10).toLowerCase(); }
function mp4ForAttempt(providerRoot, attemptId) { const d = path.join(providerRoot, "media", shortId(attemptId)); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".mp4")).length : 0; }
function pendingAckTerminal(root) {
  const d = path.join(root, "worker", "pending-ack");
  if (!existsSync(d)) return null;
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    try { const rec = JSON.parse(readFileSync(path.join(d, f), "utf8")); if (rec.type === "JOB_COMPLETED" && rec.status === "PENDING") return rec; } catch { /* */ }
  }
  return null;
}
function pendingAckCount(root) {
  const d = path.join(root, "worker", "pending-ack");
  return existsSync(d) ? readdirSync(d).filter((x) => x.endsWith(".json")).length : 0;
}

async function probeLiveDb() {
  const url = process.env.CONTROL_PLANE_TEST_DB_URL;
  const guard = evaluateTestDbTarget({ url, allowDestructive: process.env.CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS === "true" });
  if (!guard.ok) return { available: false, reason: `guard:${guard.reasons.join(",")}` };
  try {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await c.connect(); await c.query("SELECT 1"); await c.end();
    return { available: true, testUrl: url, migrationUrl: process.env.CONTROL_PLANE_DB_MIGRATION_URL || url, opsUrl: process.env.CONTROL_PLANE_DB_OPS_URL || url };
  } catch (e) { return { available: false, reason: `connect:${String(e.code || e.message).slice(0, 40)}` }; }
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
    CONTROL_PLANE_STAGING_API_MAX_OUTPUT_COUNT: "1",
    // THE mandated action selection — provider-neutral GENERATE_VIDEO (NOT the legacy default).
    CONTROL_PLANE_STAGING_API_FAKE_ACTION: "GENERATE_VIDEO",
    CONTROL_PLANE_STAGING_UI_ENABLED: "true", CONTROL_PLANE_STAGING_UI_SESSION_TTL_MS: "600000",
    CONTROL_PLANE_FLAG_REAL_GROK_WORKER_ENABLED: "false"
  };
}

const nullLogger = () => { const n = () => {}; const l = { debug: n, info: n, warn: n, error: n }; l.child = () => l; return l; };

async function main() {
  const live = await probeLiveDb();
  if (!live.available) {
    if (REQUIRE_LIVE) { hardFail(`STRICT: PostgreSQL unavailable (${live.reason})`); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }
    console.log(`[SKIP] live PG unavailable (${live.reason}) — pass --require-live to force`); process.exit(0);
  }
  if (!BROWSER_PATH) { hardFail("STRICT: no installed Edge/Chrome found"); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }
  if (process.platform !== "win32" && REQUIRE_LIVE) { hardFail("STRICT: DPAPI reconnect requires win32"); process.exit(1); }

  // ---- focused: real Windows DPAPI runner must protect + round-trip (regression for the
  // TypeNotFound defect that blocked the paired Worker from persisting its credential) ----
  if (process.platform === "win32") {
    const dpapi = makeDpapiRunner({ spawn: nodeSpawn });
    let ct = null, pt = null, dpapiErr = null;
    try { ct = await dpapi("protect", "dpapi-roundtrip-secret-🔒"); pt = await dpapi("unprotect", ct); } catch (e) { dpapiErr = String(e.code || e.message); }
    check("DPAPI runner protects a secret (non-empty ciphertext, no plaintext leak)", typeof ct === "string" && ct.length > 0 && !ct.includes("dpapi-roundtrip-secret"), true);
    check("DPAPI runner round-trips protect→unprotect", pt, "dpapi-roundtrip-secret-🔒");
    if (dpapiErr) hardFail(`DPAPI runner failed: ${dpapiErr}`);
  }

  // ---- fresh schema (idempotent reset + migrate 0001–0015) ----
  const mig = new Client({ connectionString: live.migrationUrl });
  await mig.connect();
  await mig.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  await mig.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
  await mig.query("GRANT CREATE, USAGE ON SCHEMA public TO cp_migrator");
  try { await mig.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also ensures */ }
  const mresult = await migrate(mig, { dir: MIGRATIONS, appVersion: "5c8b1-e2e" });
  check("live migrations apply from empty schema through 0015", (mresult.applied.length + (mresult.alreadyApplied || 0)), 15);

  const workspaceId = generateId("ws");
  const userId = generateId("usr");
  await mig.query("INSERT INTO users (id,email) VALUES ($1,$2)", [userId, "step5c8b1-" + Date.now() + "@local.test"]);
  await mig.query("SELECT set_config('app.current_workspace',$1,false)", [workspaceId]); // RLS context for the workspaces_insert policy
  await mig.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Step 5C.8B1',$2)", [workspaceId, userId]);
  await mig.end();

  // ops (BYPASSRLS, SELECT-only) client for protocol/ops evidence; tenant reads go through the app.
  const ops = new Client({ connectionString: live.opsUrl });
  await ops.connect();
  const opsQ = async (sql, params = []) => (await ops.query(sql, params)).rows;

  const app = await createApp({ config: loadConfig(appEnvironment(live, workspaceId, "cp-5c8b1")), logger: nullLogger() });
  await app.start();
  const port = app.address().port;
  const origin = "http://127.0.0.1:" + port;
  const wsUrl = `ws://127.0.0.1:${port}/ws/worker`;
  const persistence = app.modules.persistence;
  const processor = app.modules.processor;
  const tq = (sql, params = []) => persistence.tenantTransaction(workspaceId, async (c) => (await c.query(sql, params)).rows);
  check("real Control Plane ready on loopback with gateway+processor", app.readiness().ready && port > 0, true);

  // processor pump: drives outbox delivery (offers + MESSAGE_ACKs) + sweeps. `on` can be paused to
  // deterministically WITHHOLD the worker's terminal ACK (inbound is processed inline by the Gateway,
  // but the ACK is delivered via the outbox — so pausing the pump leaves the terminal in PendingAckStore).
  const pumpState = { on: true, alive: true };
  (async () => { while (pumpState.alive) { if (pumpState.on) { try { await processor.runOnce(); } catch { /* */ } } await sleep(80); } })();

  const workerRoots = [];
  const workers = [];
  const browserArgs = ["--disable-background-networking", "--disable-default-apps", "--no-first-run", "--no-default-browser-check", "--disable-gpu"];
  // FLAKE POLICY: exactly ONE bounded relaunch is permitted for a browser process-launch failure.
  let browser = null, browserRelaunches = 0;
  for (let attempt = 1; attempt <= 2 && !browser; attempt += 1) {
    try { browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true, args: browserArgs }); }
    catch (e) { if (attempt === 2) throw e; browserRelaunches += 1; console.error(`[flake] browser launch failed (attempt ${attempt}): ${String(e.message).slice(0, 80)} — one bounded relaunch`); await sleep(1500); }
  }
  globalThis.__b1_browserRelaunches = browserRelaunches;
  check("strict: launches installed Edge/Chrome without a bundled download", browser.isConnected(), true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(25000);

  const SHOTS = mkdtempSync(path.join(os.tmpdir(), "avc5c8b1-shots-"));
  let workerId = null, workspaceFromPair = null, generationAttemptId = null, jobId = null, projectId = null, offerMessageId = null;

  // Robustly assign the paired Worker in Studio. The studio polls worker availability on its own
  // cadence, so the just-connected Worker can lag a beat in the picker — reopen until selectable.
  const workerOnlineInProjection = async () => ["ONLINE", "DEGRADED"].includes((await tq("SELECT status FROM workers WHERE workspace_id=$1 AND id=$2", [workspaceId, workerId]))[0]?.status);
  // Assign the paired Worker to a project by issuing the EXACT real endpoint the Studio "Use this
  // Worker" button calls (PUT /staging/api/projects/:id/worker-affinity with X-CSRF-Token), from the
  // authenticated browser session. This is the real assignment path — used instead of clicking the
  // timing-sensitive picker, whose available-workers list can lag the just-connected Worker.
  async function chooseWorker(pid) {
    await waitFor(workerOnlineInProjection, "worker ONLINE projection", 25000);
    const res = await page.evaluate(async ({ pid, wid }) => {
      const s = await (await fetch("/staging/session", { credentials: "same-origin", cache: "no-store" })).json();
      const r = await fetch(`/staging/api/projects/${pid}/worker-affinity`, {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrfToken },
        body: JSON.stringify({ workerId: wid })
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { pid, wid: workerId });
    if (res.status !== 200) throw new Error(`assignAffinity failed: ${res.status} ${JSON.stringify(res.body)}`);
    await waitFor(async () => (await tq("SELECT worker_id FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'", [workspaceId, pid]))[0]?.worker_id === workerId, "affinity committed", 12000);
    await page.reload({ waitUntil: "domcontentloaded" }); // Studio now reflects the assignment
    await page.getByText("Worker ready", { exact: true }).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  }
  async function clickGenerate(prompt) {
    await page.locator("#video-prompt").fill(prompt);
    await page.locator("#generate-video-button").waitFor({ state: "visible" });
    await waitFor(async () => await page.locator("#generate-video-button").isEnabled().catch(() => false), "generate button enabled", 12000);
    await page.locator("#generate-video-button").click();
  }

  try {
    // ============================ SCENARIO 1 — actual Worker golden path ============================
    // ---- unlock staging UI ----
    await page.goto(origin + "/staging/unlock", { waitUntil: "domcontentloaded" });
    await page.locator("#operator-token").waitFor({ state: "visible" });
    await page.locator("#operator-token").fill(OPERATOR_TOKEN);
    await page.getByRole("button", { name: "Unlock Studio", exact: true }).click({ noWaitAfter: true });
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor({ state: "visible" });

    // ---- create a one-time pairing code via the real Worker UI ----
    await page.getByRole("link", { name: "Worker", exact: true }).first().click();
    await page.getByRole("heading", { name: "Worker", exact: true }).waitFor({ state: "visible" });
    await page.locator("#pair-worker-button").click();
    const pairingDialog = page.locator("#pair-worker-dialog");
    await page.getByRole("dialog", { name: "Pair a Worker" }).waitFor({ state: "visible" });
    await pairingDialog.locator("#worker-label").fill("Step 5C.8B1 Worker");
    await pairingDialog.getByRole("button", { name: "Create pairing code", exact: true }).click();
    const pairingCodeNode = page.locator("output.pairing-code");
    await pairingCodeNode.waitFor({ state: "visible" });
    const pairingCode = String(await pairingCodeNode.textContent()).trim();
    secret(pairingCode);
    check("real pairing UI shows one canonical one-time code", /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(pairingCode), true);

    // ---- spawn the REAL Worker child; it pairs (DPAPI) + connects to the real Gateway ----
    const wroot = mkdtempSync(path.join(os.tmpdir(), "avc5c8b1-wrk-"));
    workerRoots.push(wroot);
    const w1 = spawnWorker({
      S5C8_HTTP_BASE: origin, S5C8_WS_URL: wsUrl, S5C8_ROOT: wroot,
      S5C8_MODE: "pair", S5C8_PAIR_CODE: pairingCode, S5C8_CRED_BACKEND: "dpapi", S5C8_PROVIDER_MODE: "success"
    }, { label: "worker#1" });
    workers.push(w1);
    const paired = await w1.waitForEvent("paired", 20000).catch((e) => { hardFail(`worker pair failed: ${e.message}; events=${JSON.stringify(w1.events)}; stderr=${w1.stderrTail().join("|")}`); return null; });
    if (!paired) throw new Error("worker did not pair");
    workerId = paired.workerId; workspaceFromPair = paired.workspaceId;
    check("actual Worker child paired through the one-time code", /^wrk_[0-9A-HJKMNP-TV-Z]{26}$/.test(workerId), true);
    check("paired Worker joined the staging workspace", workspaceFromPair, workspaceId);
    await w1.waitForOnline(20000).catch((e) => { hardFail(`worker online failed: ${e.message}; stderr=${w1.stderrTail().join("|")}`); });
    // authoritative online = Gateway session row
    await waitFor(async () => (await opsQ("SELECT 1 FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, workerId])).length === 1, "worker ONLINE session", 15000);
    check("Gateway records exactly one ACTIVE worker session", (await opsQ("SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, workerId]))[0].n, 1);
    check("DPAPI credential persisted to disk (non-empty, encrypted at rest)", existsSync(path.join(wroot, "cred")) && readdirSync(path.join(wroot, "cred")).length > 0, true);

    // ---- close the pairing dialog (must fully detach or later clicks are modal-blocked) ----
    for (let i = 0; i < 3 && await page.locator("#pair-worker-dialog").count() > 0; i += 1) {
      await pairingDialog.getByRole("button", { name: /^(?:I've entered it|Done|Close)$/ }).first().click().catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.locator("#pair-worker-dialog").waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
    }

    // ---- create a project ----
    await page.getByRole("link", { name: "Projects", exact: true }).first().click();
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "New project", exact: true }).click();
    const projectDialog = page.getByRole("dialog", { name: "Create a project" });
    await projectDialog.locator("#project-title").fill("Violet Rail B1");
    await projectDialog.locator("#project-description").fill("Step 5C.8B1 actual-Worker golden path.");
    await projectDialog.getByRole("button", { name: "Create project", exact: true }).click();
    await page.getByRole("heading", { name: "Violet Rail B1", exact: true }).waitFor({ state: "visible" });
    projectId = /\/projects\/(prj_[0-9A-HJKMNP-TV-Z]{26})\/studio/.exec(new URL(page.url()).pathname)?.[1];
    check("project persisted via real HTTP + PostgreSQL", (await tq("SELECT count(*)::int n FROM projects WHERE workspace_id=$1 AND id=$2", [workspaceId, projectId]))[0].n, 1);

    // ---- assign the paired Worker ----
    await chooseWorker(projectId);
    check("Studio persisted the paired Worker affinity", (await tq("SELECT worker_id FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'", [workspaceId, projectId]))[0]?.worker_id, workerId);

    // ---- submit Generate (single click) ----
    await clickGenerate(PROMPT);

    // ---- durable request/attempt/job created ----
    const jrow = await waitFor(async () => (await tq("SELECT id, type, request_idempotency_key, generation_attempt_id, input FROM jobs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1", [workspaceId]))[0], "job row", 20000);
    jobId = jrow.id; generationAttemptId = jrow.generation_attempt_id;
    check("job created with action GENERATE_VIDEO", jrow.type, "GENERATE_VIDEO");
    check("exactly one generation request", (await tq("SELECT count(*)::int n FROM generation_requests WHERE workspace_id=$1", [workspaceId]))[0].n, 1);
    check("exactly one generation attempt", (await tq("SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1", [workspaceId]))[0].n, 1);

    // ---- durable JOB_OFFER outbox: capture the ACTUAL payload ----
    const outboxRow = await waitFor(async () => (await opsQ("SELECT message_id, payload FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [workspaceId, jobId]))[0], "JOB_OFFER outbox", 20000);
    offerMessageId = outboxRow.message_id;
    const outboxPayload = typeof outboxRow.payload === "string" ? JSON.parse(outboxRow.payload) : outboxRow.payload;
    check("outbox JOB_OFFER action is GENERATE_VIDEO", outboxPayload.action, "GENERATE_VIDEO");
    check("outbox JOB_OFFER carries request identity", /^req_/.test(outboxPayload.requestIdempotencyKey) && /^attempt_/.test(outboxPayload.generationAttemptId), true);
    check("outbox JOB_OFFER input matches the Step 5C.6 shape", {
      kind: outboxPayload.input?.kind, outputCount: outboxPayload.input?.outputCount,
      hasPrompt: typeof outboxPayload.input?.prompt === "string",
      hasDuration: Number.isInteger(outboxPayload.input?.durationSeconds), hasAspect: typeof outboxPayload.input?.aspectRatio === "string"
    }, { kind: "VIDEO", outputCount: 1, hasPrompt: true, hasDuration: true, hasAspect: true });

    // ---- browser reaches COMPLETED / Ready ----
    await page.locator(".generation-card").getByRole("heading", { name: "Ready", exact: true }).waitFor({ state: "visible", timeout: 25000 });
    await waitFor(async () => (await tq("SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [workspaceId, jobId]))[0].status === "SUCCEEDED", "job SUCCEEDED", 20000);

    // ---- ACTUAL Worker-received payload (recorded by the fake provider inside the actual runtime) ----
    const received = readProviderEvidence(wroot).log.find((e) => e.generationAttemptId?.includes(generationAttemptId.split("_")[1].slice(-10)) || e.received?.generationAttemptId === generationAttemptId)?.received
      || readProviderEvidence(wroot).log[0]?.received;
    check("actual Worker-received payload action is GENERATE_VIDEO", received?.action, "GENERATE_VIDEO");
    check("actual outbox payload == actual Worker-received payload (logical)", {
      action: outboxPayload.action === received?.action,
      req: outboxPayload.requestIdempotencyKey === received?.requestIdempotencyKey,
      attempt: outboxPayload.generationAttemptId === received?.generationAttemptId,
      input: JSON.stringify(outboxPayload.input) === JSON.stringify(received?.input)
    }, { action: true, req: true, attempt: true, input: true });

    // ---- exactly-once + artifact + result evidence ----
    const evid = readProviderEvidence(wroot);
    check("golden: provider invoked exactly once", evid.counts[generationAttemptId] || 0, 1);
    check("golden: exactly one local .mp4", countMp4(path.join(wroot, "provider")), 1);
    check("golden: generationOrdinal <= 1 in journal", (() => { const jf = path.join(wroot, "worker", "journal"); const files = existsSync(jf) ? readdirSync(jf) : []; const rec = files.length ? JSON.parse(readFileSync(path.join(jf, files[0]), "utf8")) : null; return rec ? rec.generationOrdinal <= 1 : false; })(), true);
    check("golden: exactly one terminal result row", (await tq("SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, jobId]))[0].n, 1);
    check("golden: exactly one asset/result projection", (await tq("SELECT count(*)::int n FROM assets WHERE workspace_id=$1", [workspaceId]))[0].n, 1);
    // no absolute path / filesystem URL in the browser DOM
    const domHtml = await page.evaluate(() => document.documentElement.outerHTML);
    check("golden: no absolute drive path in the browser DOM", /[A-Za-z]:\\\\|file:\/\//.test(domHtml) || /[A-Za-z]:\\/.test(domHtml), false);
    check("golden: no OS temp root leaked to the browser DOM", domHtml.includes(os.tmpdir()) || domHtml.includes(wroot), false);

    console.log(`[scenario 1] golden path OK — job ${jobId} SUCCEEDED, invocations=1, offerMsg=${offerMessageId.slice(0, 12)}…`);

    // ============================ SCENARIO 2 — restart with stored DPAPI credential ============================
    await w1.stopClean(10000);
    await waitFor(async () => (await opsQ("SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, workerId]))[0].n === 0, "worker#1 session cleared", 15000);
    const beforeWorkers = (await tq("SELECT count(*)::int n FROM workers WHERE workspace_id=$1", [workspaceId]))[0].n;

    const w2 = spawnWorker({
      S5C8_HTTP_BASE: origin, S5C8_WS_URL: wsUrl, S5C8_ROOT: wroot, // SAME durable roots (DPAPI cred + journal + pending-ack)
      S5C8_MODE: "reconnect", S5C8_CRED_BACKEND: "dpapi", S5C8_PROVIDER_MODE: "success"
    }, { label: "worker#2" });
    workers.push(w2);
    await w2.waitForEvent("reconnecting", 15000).catch((e) => hardFail(`worker#2 reconnect start failed: ${e.message}; stderr=${w2.stderrTail().join("|")}`));
    await w2.waitForOnline(20000).catch((e) => hardFail(`worker#2 online failed: ${e.message}; stderr=${w2.stderrTail().join("|")}`));
    await waitFor(async () => (await opsQ("SELECT count(*)::int n FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, workerId]))[0].n === 1, "worker#2 reconnected session", 15000);
    check("restart: reconnected using persisted DPAPI credential (NO new pairing code)", w2.events.some((e) => e.event === "reconnecting") && !w2.events.some((e) => e.event === "paired"), true);
    check("restart: no second Worker identity created", (await tq("SELECT count(*)::int n FROM workers WHERE workspace_id=$1", [workspaceId]))[0].n, beforeWorkers);
    check("restart: same Worker id online", (await opsQ("SELECT worker_id FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, workerId]))[0]?.worker_id, workerId);
    console.log(`[scenario 2] restart/reconnect OK — same worker ${workerId} back ONLINE via DPAPI, no re-pair`);

    // ============================ SCENARIO 3 — duplicate JOB_OFFER replay (same messageId) ============================
    const invBefore = readProviderEvidence(wroot).counts[generationAttemptId] || 0;
    const mp4Before = countMp4(path.join(wroot, "provider"));
    const termBefore = (await tq("SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, jobId]))[0].n;
    // Re-deliver the SAME durable outbox offer (same messageId) over the real Gateway to the real
    // Worker by re-arming its outbox row (write goes through the tenant role that owns the outbox).
    await persistence.tenantTransaction(workspaceId, async (c) => {
      await c.query("UPDATE protocol_outbox SET delivery_state='PENDING', attempts=0, next_attempt_at=now() WHERE workspace_id=$1 AND message_id=$2", [workspaceId, offerMessageId]);
    });
    await sleep(500);
    await processor.runOnce().catch(() => {});
    await sleep(700);
    // The processor must have re-sent the SAME outbox row (delivery_state moved off PENDING again).
    check("dup: same offer row was re-delivered by the processor", (await opsQ("SELECT delivery_state FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [workspaceId, offerMessageId]))[0].delivery_state !== "PENDING", true);
    check("dup: same offer messageId re-delivered (unchanged identity)", (await opsQ("SELECT message_id FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_OFFER'", [workspaceId, jobId]))[0].message_id, offerMessageId);
    check("dup: provider invocation count stays 1", readProviderEvidence(wroot).counts[generationAttemptId] || 0, invBefore);
    check("dup: local media count stays 1", countMp4(path.join(wroot, "provider")), mp4Before);
    check("dup: terminal result count stays 1", (await tq("SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, jobId]))[0].n, termBefore);
    check("dup: exactly one asset/result projection", (await tq("SELECT count(*)::int n FROM assets WHERE workspace_id=$1", [workspaceId]))[0].n, 1);
    console.log(`[scenario 3] duplicate offer replay OK — no re-invoke, counts stable`);

    // helpers for scenarios 4 & 5: reuse project1 (already Worker-affine) + one long-lived Worker
    // whose provider delay is controlled at RUNTIME via a file (no reconnect churn to destabilize
    // the Studio's ONLINE projection). Each re-Generate creates a fresh attempt in the same project.
    const attemptCountFor = async (pid) => (await tq("SELECT count(*)::int n FROM generation_attempts ga JOIN generation_requests gr ON gr.id=ga.generation_request_id AND gr.workspace_id=ga.workspace_id WHERE gr.workspace_id=$1 AND gr.project_id=$2", [workspaceId, pid]))[0].n;
    const latestAttemptFor = async (pid) => (await tq("SELECT ga.id FROM generation_attempts ga JOIN generation_requests gr ON gr.id=ga.generation_request_id AND gr.workspace_id=ga.workspace_id WHERE gr.workspace_id=$1 AND gr.project_id=$2 ORDER BY ga.created_at DESC LIMIT 1", [workspaceId, pid]))[0]?.id;
    function setDelay(ms) { mkdirSync(path.join(wroot, "provider"), { recursive: true }); writeFileSync(path.join(wroot, "provider", "delay-control.txt"), String(ms), "utf8"); }
    async function reGenerate(pid, prompt) {
      await waitFor(workerOnlineInProjection, "worker ONLINE projection (regen)", 25000);
      const before = await attemptCountFor(pid);
      await page.goto(origin + "/staging/projects/" + pid + "/studio", { waitUntil: "domcontentloaded" });
      await page.locator("#video-prompt").waitFor({ state: "visible", timeout: 15000 });
      await clickGenerate(prompt); // fills the prompt FIRST, then waits for the button to enable, then clicks
      return waitFor(async () => { const c = await attemptCountFor(pid); return c > before ? await latestAttemptFor(pid) : null; }, "new attempt created", 20000);
    }

    // ============================ SCENARIO 4 — browser refresh while the actual Worker is RUNNING ============================
    // w2 stays connected (no churn). A long provider delay keeps the job RUNNING across the reload.
    setDelay(8000);
    const attempt2 = await reGenerate(projectId, "amber rail loop at night");
    const attemptCount2 = await attemptCountFor(projectId);
    await waitFor(async () => ["RUNNING", "ACCEPTED"].includes((await tq("SELECT status FROM jobs WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attempt2]))[0]?.status), "attempt2 RUNNING", 20000);
    await page.locator(".generation-card").getByRole("heading", { name: "Generating", exact: true }).waitFor({ state: "visible", timeout: 15000 });
    // reload mid-RUNNING; the UI must restore its session + resume via read-only polling (no re-mutation)
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Violet Rail B1", exact: true }).waitFor({ state: "visible", timeout: 20000 });
    await page.locator(".generation-card").waitFor({ state: "visible", timeout: 20000 });
    await page.locator(".generation-card").getByRole("heading", { name: "Ready", exact: true }).waitFor({ state: "visible", timeout: 30000 });
    await waitFor(async () => (await tq("SELECT status FROM jobs WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attempt2]))[0]?.status === "SUCCEEDED", "attempt2 SUCCEEDED", 20000);
    check("refresh: no second Generate mutation (attempt count unchanged by reload)", await attemptCountFor(projectId), attemptCount2);
    check("refresh: same generationAttemptId stayed active", await latestAttemptFor(projectId), attempt2);
    check("refresh: provider invoked exactly once for the running attempt", readProviderEvidence(wroot).counts[attempt2] || 0, 1);
    check("refresh: exactly one media file for the attempt", mp4ForAttempt(path.join(wroot, "provider"), attempt2), 1);
    check("refresh: exactly one terminal result for the attempt's job", (await tq("SELECT count(*)::int n FROM job_terminal_results jt JOIN jobs j ON j.id=jt.job_id AND j.workspace_id=jt.workspace_id WHERE jt.workspace_id=$1 AND j.generation_attempt_id=$2", [workspaceId, attempt2]))[0].n, 1);
    console.log(`[scenario 4] browser refresh while RUNNING OK — resumed to Ready, no duplicate work`);

    // ============================ SCENARIO 5 — terminal pending-ACK replay ============================
    setDelay(4000);
    const attempt3 = await reGenerate(projectId, "cobalt arc at sunrise");
    const job3 = await waitFor(async () => (await tq("SELECT id FROM jobs WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attempt3]))[0]?.id, "job3", 20000);
    // wait until the offer is delivered + the Worker is RUNNING, THEN pause the outbox pump.
    await waitFor(async () => ["RUNNING", "ACCEPTED"].includes((await tq("SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [workspaceId, job3]))[0]?.status), "job3 RUNNING", 20000);
    // CONTROLLED INJECTION: pause the outbox pump. Inbound is processed INLINE by the Gateway, so the
    // job still completes (SUCCEEDED, terminal result applied) — but the terminal's MESSAGE_ACK is an
    // OUTBOX row, so with the pump paused it is never delivered → the ack lifecycle cannot finish.
    pumpState.on = false;
    await waitFor(() => pendingAckTerminal(wroot) !== null, "terminal persisted in PendingAckStore", 20000);
    await waitFor(async () => (await tq("SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [workspaceId, job3]))[0].status === "SUCCEEDED", "job3 applied (SUCCEEDED)", 15000);
    const terminalMessageId = pendingAckTerminal(wroot).messageId;
    check("ack: terminal is held PENDING in the Worker PendingAckStore before ack", /^msg_/.test(terminalMessageId), true);
    check("ack: CP recorded exactly one terminal result (applied once)", (await tq("SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, job3]))[0].n, 1);
    const invBeforeReplay = readProviderEvidence(wroot).counts[attempt3] || 0;
    const mediaBeforeReplay = mp4ForAttempt(path.join(wroot, "provider"), attempt3);

    // interrupt the Worker abruptly BEFORE the ack completes (terminal still pending in its store).
    await w2.killAbrupt();
    check("ack: terminal still pending after abrupt interrupt", pendingAckTerminal(wroot) !== null, true);
    // restart the Worker with the SAME pending-ack store; resume the pump so the ack lifecycle can run.
    const w5 = spawnWorker({ S5C8_HTTP_BASE: origin, S5C8_WS_URL: wsUrl, S5C8_ROOT: wroot, S5C8_MODE: "reconnect", S5C8_CRED_BACKEND: "dpapi", S5C8_PROVIDER_MODE: "success" }, { label: "worker#5" });
    workers.push(w5);
    await w5.waitForOnline(20000).catch((e) => hardFail(`w5 online: ${e.message}; ${w5.stderrTail().join("|")}`));
    pumpState.on = true; // resume ack delivery
    // the reconnected Worker replays the SAME terminal messageId; the CP inbox dedupes it.
    await waitFor(() => pendingAckCount(wroot) === 0, "pending-ack cleared after accepted ACK replay", 25000);
    check("ack: replayed terminal cleared the PendingAckStore (accepted ACK)", pendingAckCount(wroot), 0);
    check("ack: still exactly one terminal result after replay (inbox dedupe)", (await tq("SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, job3]))[0].n, 1);
    check("ack: inbox recorded the terminal messageId exactly once", (await opsQ("SELECT count(*)::int n FROM protocol_inbox WHERE workspace_id=$1 AND message_id=$2", [workspaceId, terminalMessageId]))[0].n, 1);
    check("ack: no second provider invocation on replay", readProviderEvidence(wroot).counts[attempt3] || 0, invBeforeReplay);
    check("ack: no second media file on replay", mp4ForAttempt(path.join(wroot, "provider"), attempt3), mediaBeforeReplay);
    check("ack: exactly one terminal result for job3 (no second completion)", (await tq("SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [workspaceId, job3]))[0].n, 1);
    console.log(`[scenario 5] terminal pending-ACK replay OK — dedupe, no second result, pending-ack cleared`);
    await w5.stopClean(10000);
  } finally {
    pumpState.alive = false;
    for (const w of workers) { try { await w.killAbrupt(); } catch { /* */ } }
    try { await context.close(); } catch { /* */ }
    try { await browser.close(); } catch { /* */ }
    try { await app.stop(); } catch { /* */ }
    try { await ops.end(); } catch { /* */ }
    try { rmSync(SHOTS, { recursive: true, force: true }); } catch { /* */ }
    for (const r of workerRoots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR", e && e.stack ? e.stack : e); console.log(`\n${passed} passed, ${failed + 1} failed`); process.exit(1); });
