// AVC Studio P0 Step 5.7a — DRAIN vs STOP runtime contract (recovery contract §8).
//
// SAFE BY CONSTRUCTION: temp dirs only; no ui-server / browser / Python / provider /
// real socket / credential / production media / quota. The "provider" is a gated fake
// handler; every "submission" is a journal write.
//
//   stop()  = hard stop: reject new offers AND cancel active jobs.
//   drain() = graceful: reject new offers but let active jobs FINISH and persist —
//             a job that already spent quota is never interrupted.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";
import { PROTOCOL_ERRORS } from "../lib/protocol/errors.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import { PendingAckStore } from "../lib/worker/pending-ack-store.mjs";
import { MockTransport } from "../lib/worker/mock-transport.mjs";
import { JobRegistry } from "../lib/worker/job-registry.mjs";
import { WorkerRuntime } from "../lib/worker/worker-runtime.mjs";
import { IDEMPOTENCY_SUPPORT } from "../lib/worker/recovery-states.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
async function waitFor(pred, budgetMs = 2000, stepMs = 5) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) { if (pred()) return true; await new Promise((r) => setTimeout(r, stepMs)); }
  return pred();
}

const tmpDirs = [];
const mkTmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "avc-drain-")); tmpDirs.push(d); return d; };
const WS = generateId("ws"), WRK = generateId("wrk");
const DUR_CTX = { supportedDurationsSec: [6, 10, 15], defaultDurationSec: 10 };
const fixedClock = (iso = "2026-07-12T00:00:00.000Z") => () => iso;
function baseInput(extra = {}) {
  return {
    projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"),
    providerAccountId: generateId("pa"), sourceKeyframeAssetId: generateId("asset"),
    promptSnapshot: "Slow cinematic push-in", baseRevision: 1, ...extra
  };
}
function offerFor(jobId) {
  return makeEnvelope({
    type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, correlationId: generateId("corr"),
    payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), quotaRisk: true, input: baseInput() }
  });
}

try {
  // ============ DRAIN: active job finishes, new offer refused ============
  {
    const root = mkTmp();
    const journal = new RecoveryJournal({ root, now: fixedClock() });
    const pendingAck = new PendingAckStore({ root, now: fixedClock() });
    const transport = new MockTransport().connect();
    const registry = new JobRegistry();
    let release; const gate = new Promise((r) => { release = r; });
    const submissionId = generateId("submission");
    registry.register("GENERATE_GROK_VIDEO", {
      validate() {},
      async execute(input, ctx) {
        // Cross the submit barrier, spend the (fake) generation, then block.
        ctx.markSubmitting({ providerIdempotencyKey: "idem-1", idempotencySupport: IDEMPOTENCY_SUPPORT.NONE });
        ctx.markSubmittedToProvider(submissionId);
        await gate;
        return { result: { ok: true } };
      }
    });
    // capture worker→cloud events (JOB_REJECTED etc.)
    const control = [];
    transport.subscribeControl((env) => control.push(env));

    const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video"], durationContext: DUR_CTX, journal, pendingAck }).start();
    const jobId = generateId("job");
    transport.offerJob(offerFor(jobId));
    await waitFor(() => journal.read(jobId)?.submittedToProvider === true);
    check("drain: job submitted before drain", journal.read(jobId).submittedToProvider, true);

    // Begin draining while the job is mid-flight (blocked on the gate).
    runtime.drain();
    check("drain: isDraining true", runtime.isDraining(), true);
    check("drain: isRunning false", runtime.isRunning(), false);
    check("drain: still has active jobs", runtime.hasActiveJobs(), true);
    check("drain: mid-flight job NOT canceled", runtime.getJobState(jobId), "RUNNING");

    // A brand-new offer during drain must be REFUSED (E_WORKER_UNAVAILABLE), not run.
    const jobId2 = generateId("job");
    runtime.handleEnvelope(offerFor(jobId2));
    const rejected = control.find((e) => e.type === "JOB_REJECTED" && e.jobId === jobId2);
    check("drain: new offer rejected", Boolean(rejected), true);
    check("drain: reject code E_WORKER_UNAVAILABLE", rejected?.payload?.errorCode, PROTOCOL_ERRORS.E_WORKER_UNAVAILABLE);
    check("drain: rejected job never created", journal.read(jobId2), null);

    // Let the in-flight job finish; drain must have allowed it to complete + persist.
    release();
    await waitFor(() => journal.read(jobId)?.terminal != null);
    check("drain: in-flight job completed (not canceled)", journal.read(jobId).terminal.type, "JOB_COMPLETED");
    check("drain: no active jobs after finish", runtime.hasActiveJobs(), false);
    check("drain: submission evidence persisted", journal.read(jobId).providerSubmissionId, submissionId);
    check("drain: submissionState SUBMITTED", journal.read(jobId).submissionState, "SUBMITTED");
    runtime.stop();
  }

  // ============ STOP: active job is canceled (contrast) ============
  {
    const root = mkTmp();
    const journal = new RecoveryJournal({ root, now: fixedClock() });
    const transport = new MockTransport().connect();
    const registry = new JobRegistry();
    let release; const gate = new Promise((r) => { release = r; });
    registry.register("GENERATE_GROK_VIDEO", {
      validate() {},
      async execute(input, ctx) {
        ctx.markSubmitting();
        ctx.markSubmittedToProvider(generateId("submission"));
        await gate; // will be aborted by stop()
        return { result: { ok: true } };
      }
    });
    const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video"], durationContext: DUR_CTX, journal }).start();
    const jobId = generateId("job");
    transport.offerJob(offerFor(jobId));
    await waitFor(() => runtime.getJobState(jobId) === "RUNNING");

    runtime.stop(); // hard stop → cancels the active job
    check("stop: isRunning false", runtime.isRunning(), false);
    check("stop: isDraining false", runtime.isDraining(), false);
    check("stop: active job moved to cancel", ["CANCEL_REQUESTED", "CANCELED"].includes(runtime.getJobState(jobId)), true);
    release();
    await waitFor(() => runtime.getJobState(jobId) === "CANCELED");
    check("stop: job ended CANCELED", runtime.getJobState(jobId), "CANCELED");
    // Even a canceled job keeps its quota-safety flag (it did submit).
    check("stop: submitted flag retained for recovery", journal.read(jobId).submittedToProvider, true);
  }

  // ============ drain() is idempotent and safe when idle ============
  {
    const transport = new MockTransport().connect();
    const registry = new JobRegistry();
    registry.register("GENERATE_GROK_VIDEO", { validate() {}, async execute() { return { result: { ok: true } }; } });
    const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video"], durationContext: DUR_CTX }).start();
    runtime.drain(); runtime.drain(); // idempotent
    check("drain idempotent: draining", runtime.isDraining(), true);
    runtime.stop();
    check("stop after drain clears draining", runtime.isDraining(), false);
    // drain() on a stopped runtime is a no-op
    runtime.drain();
    check("drain on stopped runtime no-op", runtime.isDraining(), false);
  }

  check("no unhandled rejection", un, false);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
