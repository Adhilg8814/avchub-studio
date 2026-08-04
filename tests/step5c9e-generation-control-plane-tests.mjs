// P0 Step 5C.9E — durable generation control plane: LIVE PostgreSQL integration.
//
// Verifies the facade against a REAL disposable PostgreSQL 16.4 (portable binaries, loopback, torn
// down after) — the ownership pipeline is the source of truth, generation_jobs is the 1:1
// projection, and every invariant holds: exactly-once dispatch/claim, one submission fact, terminal
// immutability, submit-uncertain never retries, cancel rules, idempotency, media capabilities,
// restart recovery classification, multi-worker no-double-claim, and idempotent legacy import.
//
// If the portable PG binaries are absent the suite SKIPS (offline-friendly) like the other
// PG-gated control-plane suites.
import assert from "node:assert/strict";
import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createGenerationControlPlane } from "../control-plane/src/api-staging/generation-control-plane.mjs";
import { generateId } from "../lib/protocol/ids.mjs";

const { Client } = pg;
let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }
async function rejects(name, fn, codeFragment) {
  try { await fn(); assert.fail(`${name}: expected reject`); }
  catch (e) { if (e instanceof assert.AssertionError && /expected reject/.test(e.message)) throw e; check(name, `${e.code || ""} ${e.message || ""}`.includes(codeFragment), true); }
}

if (!livePgAvailable()) {
  console.error("[SKIP] Step 5C.9E control plane: portable PostgreSQL binaries not present.");
  console.log("Step 5C.9E generation control plane: 0 passed, 0 failed (SKIPPED — no PostgreSQL)");
  process.exit(0);
}

const live = await startDisposablePg({ namePrefix: "cp5c9ecp" });
let adapter = null;
try {
  // ---- migrate + seed workspace/user ----
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  const ws = generateId("ws"), user = generateId("usr");
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
    const res = await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c9e-cp" });
    check("A0 migrations applied to latest", res.applied.length + res.alreadyApplied, loadMigrationFiles(MIGRATIONS_DIR).length);
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'GEN',$2)", [ws, user]);
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const config = { stagingApi: { workspaceId: ws, fakeAction: "GENERATE_GROK_VIDEO" } };

  // controllable clock for lease/capability expiry tests
  let clock = Date.parse("2026-07-18T00:00:00.000Z");
  const now = () => clock;
  const cp = createGenerationControlPlane({ persistence: adapter, config, now });

  // raw tenant-scoped read helper
  const q1 = (sql, params) => adapter.tenantTransaction(ws, async (client) => (await client.query(sql, params)).rows[0]);
  const qN = (sql, params) => adapter.tenantTransaction(ws, async (client) => (await client.query(sql, params)).rows);

  // ================================================================ bootstrap
  const boot = await cp.ensureBootstrap();
  check("B1 bootstrap creates a worker", /^wrk_[0-9A-HJKMNP-TV-Z]{26}$/.test(boot.workerId), true);
  check("B1 bootstrap creates a project", /^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(boot.projectId), true);
  check("B1 bootstrap is idempotent (same ids)", (await cp.ensureBootstrap()).workerId, boot.workerId);
  const aff = await q1("SELECT worker_id FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'", [ws, boot.projectId]);
  check("B1 ACTIVE affinity targets the local worker", aff.worker_id, boot.workerId);

  // ================================================================ enqueue
  const j1 = await cp.enqueue({ prompt: "A calm shoreline at dawn", durationSeconds: 6, aspectRatio: "9:16" });
  check("T1 enqueue returns a job view (QUEUED)", j1.state, "QUEUED");
  check("T1 enqueue binds a pipeline attempt", /^attempt_[0-9A-HJKMNP-TV-Z]{26}$/.test(j1.generationAttemptId), true);
  const reqRow = await q1("SELECT r.id FROM generation_requests r JOIN generation_attempts a ON a.generation_request_id=r.id WHERE a.id=$1", [j1.generationAttemptId]);
  check("T1 a pipeline request exists for the attempt", Boolean(reqRow?.id), true);
  const projRow = await q1("SELECT id, generation_attempt_id FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [ws, j1.jobId]);
  check("T1 projection is 1:1 with the pipeline job+attempt", projRow.generation_attempt_id, j1.generationAttemptId);

  // ================================================================ requestStart (dispatch)
  const d1 = await cp.requestStart({ jobId: j1.jobId });
  check("T2 requestStart mints an OFFER", d1.dispatchStatus, "OFFERED");
  check("T2 offer has a lease", Boolean(d1.leaseExpiresAt), true);
  const d1b = await cp.requestStart({ jobId: j1.jobId });
  check("T2 requestStart is idempotent (same offer)", d1b.offerId, d1.offerId);
  const offerCount = await q1("SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND job_id=$2", [ws, j1.jobId]);
  check("T2 exactly ONE offer row (never a second)", offerCount.n, 1);
  const attAfterOffer = await q1("SELECT ownership_status FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, j1.generationAttemptId]);
  check("T2 pipeline attempt is OFFERED", attAfterOffer.ownership_status, "OFFERED");

  // ================================================================ claim (accept its own offer)
  const claimed = await cp.claimNextForWorker({ max: 5 });
  check("T3 worker claims exactly its one offered job", claimed.length, 1);
  check("T3 claim carries the pipeline attempt + prompt", claimed[0].generationAttemptId, j1.generationAttemptId);
  check("T3 claim carries the prompt for the executor", claimed[0].prompt, "A calm shoreline at dawn");
  const claimAgain = await cp.claimNextForWorker({ max: 5 });
  check("T3 a second claim gets nothing (no double-claim)", claimAgain.length, 0);
  const afterAccept = await q1("SELECT state FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [ws, j1.jobId]);
  check("T3 projection advanced to PREPARING on accept", afterAccept.state, "PREPARING");

  // ================================================================ submission fact
  await cp.markSubmitted({ jobId: j1.jobId, attemptId: j1.generationAttemptId });
  const att2 = await q1("SELECT submission_state, generation_ordinal, possibly_submitted FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, j1.generationAttemptId]);
  check("T4 attempt SUBMITTED", att2.submission_state, "SUBMITTED");
  check("T4 exactly one paid ordinal booked", att2.generation_ordinal, 1);
  check("T4 possibly_submitted evidence set", att2.possibly_submitted, true);
  const proj4 = await q1("SELECT state, invocation_state FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [ws, j1.jobId]);
  check("T4 projection SUBMITTED + invocation CONSUMED", [proj4.state, proj4.invocation_state], ["SUBMITTED", "CONSUMED"]);
  // idempotent second submission fact does not re-book
  await cp.markSubmitted({ jobId: j1.jobId, attemptId: j1.generationAttemptId });
  const att2b = await q1("SELECT generation_ordinal FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, j1.generationAttemptId]);
  check("T4 submission fact is idempotent (ordinal stays 1)", att2b.generation_ordinal, 1);

  // ================================================================ complete (terminal)
  await cp.complete({ jobId: j1.jobId, resultId: "res_demo_1", resultAsset: { resultId: "res_demo_1" }, mediaMeta: { relativePath: `jobs/${j1.jobId}/generated.mp4`, sizeBytes: 2700000, container: "mp4", durationSeconds: 6.04, width: 464, height: 688 } });
  const jobRow = await q1("SELECT status FROM jobs WHERE workspace_id=$1 AND id=$2", [ws, j1.jobId]);
  check("T5 pipeline job SUCCEEDED", jobRow.status, "SUCCEEDED");
  const attT = await q1("SELECT terminal_state FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, j1.generationAttemptId]);
  check("T5 pipeline attempt COMPLETED", attT.terminal_state, "COMPLETED");
  const assetRow = await q1("SELECT relative_path, size_bytes FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2", [ws, j1.generationAttemptId]);
  check("T5 a safe result asset (relative path) is recorded", assetRow.relative_path, `jobs/${j1.jobId}/generated.mp4`);
  const v5 = await cp.getForUi(j1.jobId);
  check("T5 projection COMPLETED with media", [v5.state, v5.hasMedia], ["COMPLETED", true]);
  check("T5 UI view exposes the assigned worker", v5.assignedWorkerId, boot.workerId);
  // idempotent complete
  const c5b = await cp.complete({ jobId: j1.jobId });
  check("T5 complete is idempotent on a terminal job", c5b.idempotent, true);

  // ================================================================ events (ordered, redacted)
  const ev = await cp.events(j1.jobId);
  const types = ev.map((e) => e.type);
  check("T6 events are ordered + cover the lifecycle", types[0] === "JOB_QUEUED" && types.includes("SUBMIT_ATTEMPTED") && types.includes("JOB_COMPLETED"), true);
  check("T6 event seqs are strictly increasing", ev.every((e, i) => i === 0 || e.seq > ev[i - 1].seq), true);
  check("T6 no event leaks the prompt", JSON.stringify(ev).includes("calm shoreline"), false);

  // reusable full happy-path driver
  async function runFullJob(prompt, { resultId } = {}) {
    const j = await cp.enqueue({ prompt });
    await cp.requestStart({ jobId: j.jobId });
    const cl = await cp.claimNextForWorker({ max: 5 });
    const mine = cl.find((c) => c.jobId === j.jobId);
    await cp.markSubmitted({ jobId: j.jobId, attemptId: j.generationAttemptId });
    await cp.complete({ jobId: j.jobId, resultId: resultId || "res_x", mediaMeta: { relativePath: `jobs/${j.jobId}/generated.mp4`, sizeBytes: 1000 } });
    return { jobId: j.jobId, attemptId: j.generationAttemptId, claimed: Boolean(mine) };
  }

  // ================================================================ cancel rules
  const jc = await cp.enqueue({ prompt: "A quiet forest path" });
  const cancelled = await cp.cancel({ jobId: jc.jobId });
  check("T7 pre-submit cancel → CANCELLED_BEFORE_SUBMIT", cancelled.state, "CANCELLED_BEFORE_SUBMIT");
  check("T7 cancel of an already-terminal job is an idempotent no-op", (await cp.cancel({ jobId: j1.jobId })).idempotent, true);
  // A SUBMITTED (post-submit, not yet terminal) job can NEVER be cancelled.
  const jcs = await cp.enqueue({ prompt: "A submitted job that cannot cancel" });
  await cp.requestStart({ jobId: jcs.jobId });
  await cp.claimNextForWorker({ max: 5 });
  await cp.markSubmitted({ jobId: jcs.jobId, attemptId: jcs.generationAttemptId });
  await rejects("T7 cannot cancel a post-submit job", () => cp.cancel({ jobId: jcs.jobId }), "E_GENERATION_CANCEL_REJECTED");

  // ================================================================ submit-uncertain (never retry)
  const ju = await cp.enqueue({ prompt: "A misty harbor at night" });
  await cp.requestStart({ jobId: ju.jobId });
  await cp.claimNextForWorker({ max: 5 });
  await cp.markSubmitted({ jobId: ju.jobId, attemptId: ju.generationAttemptId });
  await cp.submitUncertain({ jobId: ju.jobId });
  const vu = await cp.getForUi(ju.jobId);
  check("T8 submit-uncertain is terminal SUBMIT_UNCERTAIN", vu.state, "SUBMIT_UNCERTAIN");
  const attU = await q1("SELECT possibly_submitted, terminal_state FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, ju.generationAttemptId]);
  check("T8 possibly_submitted evidence preserved (never cleared)", attU.possibly_submitted, true);
  await rejects("T8 an uncertain (terminal) job cannot be re-dispatched", () => cp.requestStart({ jobId: ju.jobId }), "E_GENERATION_START_REJECTED");

  // ================================================================ idempotent enqueue
  const key = generateId("req");
  const e1 = await cp.enqueue({ prompt: "Idempotent create", idempotencyKey: key });
  const e2 = await cp.enqueue({ prompt: "Idempotent create", idempotencyKey: key });
  check("T9 same idempotency key → same job", e2.jobId, e1.jobId);
  const reqN = await q1("SELECT count(*)::int n FROM generation_requests r JOIN generation_attempts a ON a.generation_request_id=r.id JOIN generation_jobs g ON g.generation_attempt_id=a.id WHERE g.id=$1", [e1.jobId]);
  check("T9 exactly one request/attempt for the idempotent job", reqN.n, 1);

  // ================================================================ media capability (digest-only, live-only)
  const capJob = await runFullJob("Media capability job", { resultId: "res_media" });
  const cap = await cp.issueMediaCapability({ jobId: capJob.jobId, ttlMs: 60_000 });
  check("T10 capability token is opaque (not a digest/jobId)", typeof cap.token === "string" && cap.token.length >= 20 && !cap.token.includes(capJob.jobId), true);
  check("T10 a valid token resolves to its job", await cp.resolveMediaCapability(cap.token), capJob.jobId);
  check("T10 a tampered token resolves to nothing", await cp.resolveMediaCapability(cap.token + "x"), null);
  clock += 61_000; // advance past TTL
  check("T10 an expired token resolves to nothing", await cp.resolveMediaCapability(cap.token), null);
  clock -= 61_000;

  // ================================================================ recovery classification
  // a fresh job left ACCEPTED (pre-submit, not consumed) → RESUME; a submitted job → TRACK; an
  // OFFERED-but-unaccepted expired offer → reoffer.
  const jResume = await cp.enqueue({ prompt: "Resume me pre-submit" });
  await cp.requestStart({ jobId: jResume.jobId });
  await cp.claimNextForWorker({ max: 5 }); // ACCEPTED, not submitted
  const jTrack = await cp.enqueue({ prompt: "Track me post-submit" });
  await cp.requestStart({ jobId: jTrack.jobId });
  await cp.claimNextForWorker({ max: 5 });
  await cp.markSubmitted({ jobId: jTrack.jobId, attemptId: jTrack.generationAttemptId });
  const rec = await cp.recover();
  check("T11 pre-submit accepted job is classified RESUME", rec.resume.some((r) => r.jobId === jResume.jobId), true);
  check("T11 post-submit job is classified TRACK (read-only)", rec.track.some((r) => r.jobId === jTrack.jobId), true);
  check("T11 recovery never resumes a submitted job", rec.resume.some((r) => r.jobId === jTrack.jobId), false);

  // ================================================================ multi-worker: no double-claim
  // A second facade acts as a DIFFERENT worker on a DIFFERENT project (its own affinity). Each
  // worker only ever claims offers assigned to itself.
  const cp2 = createGenerationControlPlane({ persistence: adapter, config, now, workerName: "second-local-worker", projectMarker: "grok-generation-2" });
  const boot2 = await cp2.ensureBootstrap();
  check("M1 second worker is distinct", boot2.workerId !== boot.workerId, true);
  const jw1 = await cp.enqueue({ prompt: "Worker one job" });
  await cp.requestStart({ jobId: jw1.jobId });
  const jw2 = await cp2.enqueue({ prompt: "Worker two job" });
  await cp2.requestStart({ jobId: jw2.jobId });
  const c1 = await cp.claimNextForWorker({ max: 10 });
  const c2 = await cp2.claimNextForWorker({ max: 10 });
  check("M1 worker one never claims worker two's job", c1.every((c) => c.jobId !== jw2.jobId), true);
  check("M1 worker two never claims worker one's job", c2.every((c) => c.jobId !== jw1.jobId), true);
  check("M1 each worker claims exactly its own started job", c1.some((c) => c.jobId === jw1.jobId) && c2.some((c) => c.jobId === jw2.jobId), true);

  // ================================================================ legacy import (idempotent)
  const legacy = { jobId: "job_01KXSK9S6D3SEMKNS46VJJVMC1", prompt: "Legacy cert clip", state: "COMPLETED", durationSeconds: 6, aspectRatio: "9:16", resultId: "res_legacy", isCertificationEvidence: true, media: { sizeBytes: 2700000, container: "mp4", durationSeconds: 6.04, width: 464, height: 688 } };
  const imp1 = await cp.importLegacyJob(legacy);
  check("T12 legacy import creates a projection job", imp1.imported, true);
  const impView = await cp.getForUi(imp1.jobId);
  check("T12 imported job is COMPLETED evidence with media", [impView.state, impView.hasMedia, impView.isCertificationEvidence], ["COMPLETED", true, true]);
  const imp2 = await cp.importLegacyJob(legacy);
  check("T12 legacy import is idempotent (skips existing)", imp2.imported, false);
  const impCount = await q1("SELECT count(*)::int n FROM generation_jobs WHERE workspace_id=$1 AND create_command_id=$2", [ws, `import:${legacy.jobId}`]);
  check("T12 exactly one imported row for the cert job", impCount.n, 1);

  // ================================================================ import as the FIRST call
  // A FRESH facade whose very first operation is importLegacyJob must NOT depend on a primed
  // bootstrap (regression: reading the module-level bootstrap before ensureBootstrap → TypeError).
  {
    const fresh = createGenerationControlPlane({ persistence: adapter, config });
    const out = await fresh.importLegacyJob({ jobId: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV", prompt: "First-call import", state: "COMPLETED", durationSeconds: 6, resultId: "res_first", media: { sizeBytes: 1000, container: "mp4" } });
    check("T14 import works as the very first facade call (bootstrap self-primes)", out.imported, true);
    check("T14 the first-call imported job is COMPLETED", (await fresh.getForUi(out.jobId)).state, "COMPLETED");
  }

  // ================================================================ listing + queue position
  const list = await cp.listForUi({ limit: 200 });
  check("T13 list returns all jobs FIFO with queue positions field", Array.isArray(list) && list.every((v) => "queuePosition" in v), true);
  check("T13 no list item leaks a full prompt", list.some((v) => JSON.stringify(v).includes("promptPreview")) && !list.some((v) => JSON.stringify(v).includes("prompt\":\"A calm shoreline")), true);

  console.log(`Step 5C.9E generation control plane: ${passed} passed, 0 failed`);
} finally {
  try { await adapter?.stop(); } catch { /* */ }
  await live.stop();
}
