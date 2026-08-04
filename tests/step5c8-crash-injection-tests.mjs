#!/usr/bin/env node
// P0 Step 5C.8B2 — Checkpoint 2: crash-injection + reconciliation-ledger unit proofs.
//
// Drives the REAL WorkerRuntime + real file-backed journal + the fake provider over a MockTransport
// (no PG/socket/browser). For each crash point, an INJECTABLE exit snapshots the DURABLE on-disk state
// at the crash instant (then unwinds), so we can prove each seam fires at exactly the intended durable
// boundary — without a real process kill. Also proves: unarmed = pure no-op; the reconciliation ledger
// records op start/submitted/local-result; pause/release opens a deterministic window.
//
// Run: node tests/step5c8-crash-injection-tests.mjs

import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";
import { MockTransport } from "../lib/worker/mock-transport.mjs";
import { WorkerRuntime } from "../lib/worker/worker-runtime.mjs";
import { JobRegistry } from "../lib/worker/job-registry.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import { PendingAckStore } from "../lib/worker/pending-ack-store.mjs";
import { buildGenerationOfferPayload } from "../control-plane/src/persistence/transactions/ownership.mjs";
import { createFakeVideoProvider, makeFakeVideoHandler } from "./helpers/step5c8-fake-provider.mjs";
import { createCrashController, CRASH_POINTS } from "./helpers/step5c8-crash-injection.mjs";

let passed = 0, failed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(10); } return false; }
const ROOTS = [];
function freshRoot(tag) { const r = mkdtempSync(path.join(os.tmpdir(), `avc5c8b2-${tag}-`)); ROOTS.push(r); return r; }
function video56() { return { kind: "VIDEO", prompt: "crash-window probe", durationSeconds: 5, aspectRatio: "16:9", outputCount: 1 }; }
function countMp4(providerRoot) { const m = path.join(providerRoot, "media"); if (!existsSync(m)) return 0; let n = 0; for (const d of readdirSync(m)) { const s = path.join(m, d); if (statSync(s).isDirectory()) n += readdirSync(s).filter((f) => f.endsWith(".mp4")).length; } return n; }
function readJournal(journal, jobId) { const p = journal.getPath(jobId); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; }

// Run one job through the real runtime; `crashAt` snapshots durable state at the crash instant.
async function runWithCrash(root, crashAt) {
  const markersDir = path.join(root, "markers");
  let snapshot = null;
  const transport = new MockTransport();
  const registry = new JobRegistry();
  const journal = new RecoveryJournal({ root: path.join(root, "worker") });
  const pendingAck = new PendingAckStore({ root: path.join(root, "worker") });
  const workerId = generateId("wrk");
  const attemptId = generateId("attempt");
  const jobId = generateId("job");
  // Injectable exit: capture the DURABLE state at crash time, then unwind (the runtime catches → FAILED,
  // but we already snapshotted the pre-crash truth). Its closure references `provider` (assigned below).
  let provider = null;
  const crash = createCrashController({
    crashAt, markersDir,
    exit: () => { snapshot = { journal: readJournal(journal, jobId), invocations: provider.getInvocationCount(attemptId), op: provider.lookupOp(attemptId), media: countMp4(path.join(root, "provider")) }; throw new Error("CRASH_SENTINEL"); },
    emit: () => {}
  });
  provider = createFakeVideoProvider({ root: path.join(root, "provider"), crash });
  registry.register("GENERATE_VIDEO", makeFakeVideoHandler({ provider, crash }), { replace: true });
  const runtime = new WorkerRuntime({ transport, registry, workerId, capabilities: ["video.generate"], journal, pendingAck });
  transport.connect(); runtime.start();
  const job = { id: jobId, type: "GENERATE_VIDEO", request_idempotency_key: generateId("req"), generation_attempt_id: attemptId, input: video56() };
  const payload = buildGenerationOfferPayload(job, { id: attemptId });
  transport.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: generateId("ws"), workerId, jobId, sentAt: new Date().toISOString(), payload }));
  await waitFor(() => ["SUCCEEDED", "FAILED", "CANCELED"].includes(runtime.getJobState(jobId)));
  return { snapshot, markersDir, attemptId, jobId, provider, root, markerFile: path.join(markersDir, `crash-${crashAt}.json`) };
}

// ---- each crash point lands at the intended durable boundary ----
{
  // scenario 5: BEFORE markSubmitting — no submit, no provider call, no media
  const r = await runWithCrash(freshRoot("c5"), "BEFORE_MARK_SUBMITTING");
  check("BEFORE_MARK_SUBMITTING: marker written", existsSync(r.markerFile), true);
  check("BEFORE_MARK_SUBMITTING: journal NOT submitting (pre-submit)", ["CREATED", "RUNNING"].includes(r.snapshot.journal?.localState), true);
  check("BEFORE_MARK_SUBMITTING: ordinal 0", r.snapshot.journal?.generationOrdinal, 0);
  check("BEFORE_MARK_SUBMITTING: provider invocations 0", r.snapshot.invocations, 0);
  check("BEFORE_MARK_SUBMITTING: no media", r.snapshot.media, 0);
}
{
  // scenario 6: AFTER markSubmitting — SUBMITTING+ordinal 1 persisted, provider NOT called
  const r = await runWithCrash(freshRoot("c6"), "AFTER_MARK_SUBMITTING");
  check("AFTER_MARK_SUBMITTING: marker written", existsSync(r.markerFile), true);
  check("AFTER_MARK_SUBMITTING: journal SUBMITTING", r.snapshot.journal?.submissionState, "SUBMITTING");
  check("AFTER_MARK_SUBMITTING: ordinal 1", r.snapshot.journal?.generationOrdinal, 1);
  check("AFTER_MARK_SUBMITTING: confidence UNKNOWN", r.snapshot.journal?.submissionConfidence, "UNKNOWN");
  check("AFTER_MARK_SUBMITTING: provider invocations 0 (never called)", r.snapshot.invocations, 0);
  check("AFTER_MARK_SUBMITTING: no media", r.snapshot.media, 0);
}
{
  // scenario 7: provider op started (uncertain), before accept/media
  const r = await runWithCrash(freshRoot("c7"), "AFTER_INVOKE_START");
  check("AFTER_INVOKE_START: marker written", existsSync(r.markerFile), true);
  check("AFTER_INVOKE_START: provider invocation EXACTLY 1", r.snapshot.invocations, 1);
  check("AFTER_INVOKE_START: ledger has invocationStartedAt", Boolean(r.snapshot.op?.invocationStartedAt), true);
  check("AFTER_INVOKE_START: ledger has NO submitted/localResult (uncertain)", Boolean(r.snapshot.op?.submittedAt) || Boolean(r.snapshot.op?.localResultAt), false);
  check("AFTER_INVOKE_START: no media yet", r.snapshot.media, 0);
}
{
  // scenario 8: submitted + local result on disk, before terminal emission
  const r = await runWithCrash(freshRoot("c8"), "AFTER_LOCAL_RESULT");
  check("AFTER_LOCAL_RESULT: marker written", existsSync(r.markerFile), true);
  check("AFTER_LOCAL_RESULT: provider invocation EXACTLY 1", r.snapshot.invocations, 1);
  check("AFTER_LOCAL_RESULT: exactly one media file", r.snapshot.media, 1);
  check("AFTER_LOCAL_RESULT: journal has localResultRef", Boolean(r.snapshot.journal?.localResultRef), true);
  check("AFTER_LOCAL_RESULT: journal submittedToProvider true", r.snapshot.journal?.submittedToProvider, true);
  check("AFTER_LOCAL_RESULT: journal NOT terminal", r.snapshot.journal?.terminal == null, true);
  check("AFTER_LOCAL_RESULT: ledger records full op lineage", Boolean(r.snapshot.op?.invocationStartedAt && r.snapshot.op?.submittedAt && r.snapshot.op?.localResultAt && r.snapshot.op?.artifactId), true);
}

// ---- unarmed controller = pure no-op (golden path unaffected) ----
{
  const root = freshRoot("noop");
  const provider = createFakeVideoProvider({ root: path.join(root, "provider") });
  const transport = new MockTransport(); const registry = new JobRegistry();
  const journal = new RecoveryJournal({ root: path.join(root, "worker") }); const pendingAck = new PendingAckStore({ root: path.join(root, "worker") });
  const workerId = generateId("wrk"); const attemptId = generateId("attempt"); const jobId = generateId("job");
  const crash = createCrashController({ crashAt: null, pauseAt: null, markersDir: path.join(root, "markers"), exit: () => { throw new Error("should not exit"); }, emit: () => {} });
  registry.register("GENERATE_VIDEO", makeFakeVideoHandler({ provider, crash }), { replace: true });
  const runtime = new WorkerRuntime({ transport, registry, workerId, capabilities: ["video.generate"], journal, pendingAck });
  transport.connect(); runtime.start();
  const events = []; transport.subscribeControl((e) => events.push(e));
  const job = { id: jobId, type: "GENERATE_VIDEO", request_idempotency_key: generateId("req"), generation_attempt_id: attemptId, input: video56() };
  transport.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: generateId("ws"), workerId, jobId, sentAt: new Date().toISOString(), payload: buildGenerationOfferPayload(job, { id: attemptId }) }));
  await waitFor(() => runtime.getJobState(jobId) === "SUCCEEDED");
  check("unarmed: golden path SUCCEEDED", runtime.getJobState(jobId), "SUCCEEDED");
  check("unarmed: provider invoked once", provider.getInvocationCount(attemptId), 1);
  check("unarmed: emitted JOB_COMPLETED", events.some((e) => e.type === "JOB_COMPLETED"), true);
  check("unarmed: no crash markers written", existsSync(path.join(root, "markers")) ? readdirSync(path.join(root, "markers")).length === 0 : true, true);
  check("unarmed: ledger has full op lineage", Boolean(provider.lookupOp(attemptId)?.localResultAt), true);
}

// ---- pause + release opens a deterministic window ----
{
  const root = freshRoot("pause");
  const markersDir = path.join(root, "markers");
  const releaseFile = path.join(markersDir, "release-BEFORE_MARK_SUBMITTING");
  const provider = createFakeVideoProvider({ root: path.join(root, "provider") });
  const transport = new MockTransport(); const registry = new JobRegistry();
  const journal = new RecoveryJournal({ root: path.join(root, "worker") }); const pendingAck = new PendingAckStore({ root: path.join(root, "worker") });
  const workerId = generateId("wrk"); const attemptId = generateId("attempt"); const jobId = generateId("job");
  const crash = createCrashController({ pauseAt: "BEFORE_MARK_SUBMITTING", markersDir, releaseFile, exit: () => {}, emit: () => {}, sleepMs: 10 });
  registry.register("GENERATE_VIDEO", makeFakeVideoHandler({ provider, crash }), { replace: true });
  const runtime = new WorkerRuntime({ transport, registry, workerId, capabilities: ["video.generate"], journal, pendingAck });
  transport.connect(); runtime.start();
  const job = { id: jobId, type: "GENERATE_VIDEO", request_idempotency_key: generateId("req"), generation_attempt_id: attemptId, input: video56() };
  transport.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: generateId("ws"), workerId, jobId, sentAt: new Date().toISOString(), payload: buildGenerationOfferPayload(job, { id: attemptId }) }));
  // The handler pauses BEFORE markSubmitting → paused marker appears, provider not yet invoked.
  const paused = await waitFor(() => existsSync(path.join(markersDir, "paused-BEFORE_MARK_SUBMITTING.json")));
  check("pause: paused marker appears before submit", paused, true);
  check("pause: provider NOT invoked while paused", provider.getInvocationCount(attemptId), 0);
  check("pause: job not yet SUCCEEDED while paused", runtime.getJobState(jobId) === "SUCCEEDED", false);
  // Release → the handler proceeds to completion.
  const { releasePause } = await import("./helpers/step5c8-process-control.mjs");
  releasePause(releaseFile);
  const done = await waitFor(() => runtime.getJobState(jobId) === "SUCCEEDED", 4000);
  check("pause: released → SUCCEEDED", done, true);
  check("pause: provider invoked exactly once after release", provider.getInvocationCount(attemptId), 1);
}

// ---- C6: resumeRecoverableTerminals promotes IMPORTED → TERMINAL_PENDING_ACK (NO provider call) ----
{
  const root = freshRoot("resume");
  const transport = new MockTransport(); const registry = new JobRegistry();
  const journal = new RecoveryJournal({ root: path.join(root, "worker") }); const pendingAck = new PendingAckStore({ root: path.join(root, "worker") });
  const workerId = generateId("wrk"); const jobId = generateId("job"); const attemptId = generateId("attempt");
  const runtime = new WorkerRuntime({ transport, registry, workerId, capabilities: ["video.generate"], journal, pendingAck });
  // Build an IMPORTED journal record directly (provider ran once, local result committed, no terminal).
  journal.create({ jobId, action: "GENERATE_VIDEO", generationAttemptId: attemptId, requestIdempotencyKey: generateId("req"), workspaceId: generateId("ws"), quotaRisk: true });
  journal.markRunning(jobId); journal.markSubmitting(jobId, {}); journal.markSubmitted(jobId, generateId("submission"));
  journal.markLocalResult(jobId, { localResultRef: "media/x/y_fake.mp4", importedAssetId: generateId("asset"), resultMeta: { sizeBytes: 1032, relativePath: "media/x/y_fake.mp4", mimeType: "video/mp4" } });
  check("resume pre: journal IMPORTED, no terminal", readJournal(journal, jobId).terminal == null, true);
  const resumed = runtime.resumeRecoverableTerminals();
  check("resume promoted the IMPORTED record", resumed.includes(jobId), true);
  const rec = readJournal(journal, jobId);
  check("resume post: journal terminal JOB_COMPLETED", (rec.terminal?.type || rec.terminalType), "JOB_COMPLETED");
  check("resume post: exactly one pending-ack terminal", pendingAck.list().length, 1);
  check("resume: pending-ack terminal has NO absolute path", /[A-Za-z]:\\/.test(JSON.stringify(pendingAck.list()[0].envelope)), false);
  check("resume: pending-ack terminal messageId matches journal terminal", (rec.terminal?.messageId || rec.terminalMessageId), pendingAck.list()[0].messageId);
  const resumed2 = runtime.resumeRecoverableTerminals();
  check("second resume is a no-op (idempotent, already terminal)", resumed2.length, 0);
  check("still exactly one pending-ack terminal after second resume", pendingAck.list().length, 1);
}

// sanity: all declared crash points are covered above (minus the transport-only AFTER_OFFER_RECEIVED,
// which is proven in the live harness because it requires a real transport delivering a JOB_OFFER).
check("CRASH_POINTS covers the handler/provider windows", CRASH_POINTS.includes("AFTER_OFFER_RECEIVED") && CRASH_POINTS.length === 5, true);

for (const r of ROOTS) { try { rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
