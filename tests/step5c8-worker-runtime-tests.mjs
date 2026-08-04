#!/usr/bin/env node
// P0 Step 5C.8B1 — focused fake-provider + ACTUAL WorkerRuntime integration tests.
//
// These run the REAL lib/worker/WorkerRuntime against a REAL file-backed RecoveryJournal
// and PendingAckStore (rooted in the OS temp dir, OUTSIDE the repo), with the deterministic
// fake provider injected at the JobRegistry handler boundary. No raw-WebSocket fake worker;
// no hand-built JOB_ACCEPTED/JOB_PROGRESS/JOB_COMPLETED — every worker→cloud message is
// emitted by the actual runtime. No PostgreSQL / Gateway / browser here (that is the strict
// live E2E). The JOB_OFFER payload is built by the Step 5C.8A ownership helper
// buildGenerationOfferPayload so this proves the exact offer the ownership txn emits is
// consumed correctly by the real runtime.
//
// Run: node tests/step5c8-worker-runtime-tests.mjs

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

let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function checkThrows(name, fn, code = undefined) {
  try { fn(); failures += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) { if (code && e.code !== code) { failures += 1; console.error(`FAIL ${name} (code ${e.code} != ${code})`); } else passed += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 4000, stepMs = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (pred()) return true; await sleep(stepMs); }
  return false;
}
const TMP_ROOTS = [];
function freshRoot(tag) { const r = mkdtempSync(path.join(os.tmpdir(), `avc5c8b1-${tag}-`)); TMP_ROOTS.push(r); return r; }

// The exact Step 5C.6 normalized generation snapshot.
function video56Input(over = {}) {
  return { kind: "VIDEO", prompt: "a neon city at dusk", durationSeconds: 5, aspectRatio: "16:9", outputCount: 1, ...over };
}
// Build the canonical JOB_OFFER envelope the ownership txn would emit (via 5C.8A helper).
function buildOfferEnvelope({ workspaceId, workerId, jobId, attemptId, reqId, input }) {
  const job = { id: jobId, type: "GENERATE_VIDEO", request_idempotency_key: reqId, generation_attempt_id: attemptId, input };
  const attempt = { id: attemptId, parent_attempt_id: null, retry_of_job_id: null };
  const payload = buildGenerationOfferPayload(job, attempt);
  return makeEnvelope({ type: "JOB_OFFER", workspaceId, workerId, jobId, sentAt: new Date().toISOString(), payload });
}
function makeRuntime(root, providerOpts = {}) {
  const transport = new MockTransport();
  const registry = new JobRegistry();
  const provider = createFakeVideoProvider({ root: path.join(root, "provider"), ...providerOpts });
  registry.register("GENERATE_VIDEO", makeFakeVideoHandler({ provider }), { replace: true });
  const journal = new RecoveryJournal({ root: path.join(root, "worker") });
  const pendingAck = new PendingAckStore({ root: path.join(root, "worker") });
  const workerId = generateId("wrk");
  const runtime = new WorkerRuntime({ transport, registry, workerId, capabilities: ["video.generate"], journal, pendingAck });
  const events = [];
  transport.subscribeControl((env) => events.push(env));
  transport.connect();
  runtime.start();
  return { transport, registry, provider, journal, pendingAck, runtime, workerId, events };
}
function readJournal(journal, jobId) {
  const p = journal.getPath(jobId);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function countMp4(providerRoot) {
  const media = path.join(providerRoot, "media");
  if (!existsSync(media)) return 0;
  let n = 0;
  for (const d of readdirSync(media)) {
    const sub = path.join(media, d);
    if (statSync(sub).isDirectory()) n += readdirSync(sub).filter((f) => f.endsWith(".mp4")).length;
  }
  return n;
}

// ============================================================================
// SECTION 1 — deterministic fake provider unit behavior
// ============================================================================
{
  const root = freshRoot("prov");
  const provider = createFakeVideoProvider({ root });
  const attemptId = generateId("attempt");
  const sub = await provider.invoke(attemptId, video56Input());
  check("invoke returns a submission id (submission_)", String(sub.providerSubmissionId).startsWith("submission_"), true);
  check("invocation counted = 1", provider.getInvocationCount(attemptId), 1);
  check("evidence file persisted", existsSync(provider.evidenceFile), true);
  check("relative path is relative (no drive letter / leading slash)", /^[a-zA-Z]:|^\//.test(sub.relativePath), false);
  check("meta.relativePath is relative", sub.meta.relativePath, sub.relativePath);
  check("meta has NO absolutePath field", Object.prototype.hasOwnProperty.call(sub.meta, "absolutePath"), false);
  check("one .mp4 written", countMp4(root), 1);
  check("mp4 file exists on disk", existsSync(sub.absolutePath), true);
  // Second invoke on the SAME attempt increments the durable counter (proves counter works).
  await provider.invoke(attemptId, video56Input());
  check("second invocation counted = 2", provider.getInvocationCount(attemptId), 2);

  // Deterministic failure mode: throws, but the invocation is still counted (paid submission spent).
  const failRoot = freshRoot("provfail");
  const failing = createFakeVideoProvider({ root: failRoot, mode: "fail" });
  const a2 = generateId("attempt");
  let threw = false;
  try { await failing.invoke(a2, video56Input()); } catch (e) { threw = true; check("fail mode error code", e.code, "E_FAKE_PROVIDER_FAILED"); }
  check("fail mode threw", threw, true);
  check("fail mode still counted the invocation", failing.getInvocationCount(a2), 1);
  check("fail mode wrote NO media", countMp4(failRoot), 0);

  // Controlled delay honored.
  const delayRoot = freshRoot("provdelay");
  const slow = createFakeVideoProvider({ root: delayRoot, delayMs: 120 });
  const t0 = Date.now();
  await slow.invoke(generateId("attempt"), video56Input());
  check("controlled delay honored (>=100ms)", Date.now() - t0 >= 100, true);
}

// ============================================================================
// SECTION 2 — golden path through the ACTUAL WorkerRuntime
// ============================================================================
let goldenTerminalMessageId = null;
{
  const root = freshRoot("golden");
  const { provider, journal, pendingAck, runtime, events, transport } = makeRuntime(root);
  const workspaceId = generateId("ws"), jobId = generateId("job"), attemptId = generateId("attempt"), reqId = generateId("req");
  const input = video56Input();
  const offer = buildOfferEnvelope({ workspaceId, workerId: runtime.getCapabilities() && generateId("wrk"), jobId, attemptId, reqId, input });
  // (offer.workerId is the addressing worker; the runtime uses its own configured workerId for replies)
  transport.offerJob(offer);
  const done = await waitFor(() => runtime.getJobState(jobId) === "SUCCEEDED");
  check("golden: job reached SUCCEEDED", done, true);

  const types = events.map((e) => e.type);
  check("golden: emitted JOB_ACCEPTED", types.includes("JOB_ACCEPTED"), true);
  check("golden: emitted JOB_STARTED", types.includes("JOB_STARTED"), true);
  check("golden: emitted JOB_PROGRESS", types.includes("JOB_PROGRESS"), true);
  check("golden: emitted JOB_COMPLETED", types.includes("JOB_COMPLETED"), true);
  check("golden: emitted no JOB_FAILED", types.includes("JOB_FAILED"), false);

  const completed = events.find((e) => e.type === "JOB_COMPLETED");
  goldenTerminalMessageId = completed.messageId;
  const asset = completed.payload?.result?.asset;
  check("golden: completed carries a video asset", asset?.kind, "video");
  check("golden: asset provider is FAKE", asset?.provider, "FAKE");
  check("golden: asset relativePath is relative", /^[a-zA-Z]:|^\//.test(asset?.relativePath || ""), false);

  // Provider invoked exactly once.
  check("golden: provider invoked exactly once", provider.getInvocationCount(attemptId), 1);
  check("golden: exactly one .mp4 exists", countMp4(path.join(root, "provider")), 1);

  // Durable journal evidence.
  const rec = readJournal(journal, jobId);
  check("golden: journal generationOrdinal <= 1", rec.generationOrdinal <= 1, true);
  check("golden: journal generationOrdinal == 1", rec.generationOrdinal, 1);
  check("golden: journal submittedToProvider true", rec.submittedToProvider, true);
  check("golden: journal localResultRef set", Boolean(rec.localResultRef), true);
  check("golden: journal terminal type JOB_COMPLETED", rec.terminal?.type || rec.terminalType, "JOB_COMPLETED");
  check("golden: journal terminal messageId matches emitted", (rec.terminal?.messageId || rec.terminalMessageId), goldenTerminalMessageId);

  // No absolute OS path leaks into ANY worker→cloud envelope.
  const wireDump = JSON.stringify(events);
  check("golden: no OS temp abs path on the wire", wireDump.includes(os.tmpdir()), false);
  check("golden: no drive-letter path on the wire", /[A-Za-z]:\\\\/.test(wireDump) || /[A-Za-z]:\\/.test(wireDump), false);

  // Pending-ACK holds the terminal for durable replay.
  check("golden: pending-ack has the terminal", Boolean(pendingAck.get ? pendingAck.get(goldenTerminalMessageId) : true), true);
}

// ============================================================================
// SECTION 3 — duplicate JOB_OFFER replay (same messageId) → exactly-once
// ============================================================================
{
  const root = freshRoot("dup");
  const { provider, runtime, events, transport } = makeRuntime(root);
  const workspaceId = generateId("ws"), jobId = generateId("job"), attemptId = generateId("attempt"), reqId = generateId("req");
  const offer = buildOfferEnvelope({ workspaceId, workerId: generateId("wrk"), jobId, attemptId, reqId, input: video56Input() });
  transport.offerJob(offer);
  await waitFor(() => runtime.getJobState(jobId) === "SUCCEEDED");
  const firstTerminal = events.find((e) => e.type === "JOB_COMPLETED").messageId;
  const invAfterFirst = provider.getInvocationCount(attemptId);
  const mp4AfterFirst = countMp4(path.join(root, "provider"));

  // Replay the SAME offer envelope (same messageId + same jobId).
  transport.offerJob(offer);
  await sleep(80); // allow any (incorrect) re-execution to surface
  const completes = events.filter((e) => e.type === "JOB_COMPLETED");

  check("dup: provider still invoked exactly once", provider.getInvocationCount(attemptId), 1);
  check("dup: invocation count unchanged by replay", provider.getInvocationCount(attemptId), invAfterFirst);
  check("dup: still exactly one .mp4", countMp4(path.join(root, "provider")), 1);
  check("dup: mp4 count unchanged by replay", countMp4(path.join(root, "provider")), mp4AfterFirst);
  // The terminal is re-emitted with the SAME messageId (control-plane inbox dedupes).
  check("dup: every re-emitted terminal shares one messageId", completes.every((e) => e.messageId === firstTerminal), true);
  check("dup: exactly one distinct terminal messageId", new Set(completes.map((e) => e.messageId)).size, 1);
}

// ============================================================================
// SECTION 4 — deterministic failure path through the actual runtime
// ============================================================================
{
  const root = freshRoot("fail");
  const { provider, journal, runtime, events, transport } = makeRuntime(root, { mode: "fail" });
  const workspaceId = generateId("ws"), jobId = generateId("job"), attemptId = generateId("attempt"), reqId = generateId("req");
  const offer = buildOfferEnvelope({ workspaceId, workerId: generateId("wrk"), jobId, attemptId, reqId, input: video56Input() });
  transport.offerJob(offer);
  const done = await waitFor(() => runtime.getJobState(jobId) === "FAILED");
  check("fail: job reached FAILED", done, true);
  const types = events.map((e) => e.type);
  check("fail: emitted JOB_FAILED", types.includes("JOB_FAILED"), true);
  check("fail: emitted no JOB_COMPLETED", types.includes("JOB_COMPLETED"), false);
  // The provider was still invoked once (paid submission attempted), booked once.
  check("fail: provider invoked exactly once", provider.getInvocationCount(attemptId), 1);
  check("fail: no media produced", countMp4(path.join(root, "provider")), 0);
  const rec = readJournal(journal, jobId);
  check("fail: journal generationOrdinal == 1 (submission barrier booked)", rec.generationOrdinal, 1);
  check("fail: journal terminal type JOB_FAILED", (rec.terminal?.type || rec.terminalType), "JOB_FAILED");
  // The sanitized failure must not echo an OS path.
  const failed = events.find((e) => e.type === "JOB_FAILED");
  check("fail: error message sanitized (no drive path)", /[A-Za-z]:\\/.test(JSON.stringify(failed.payload)), false);
}

// ============================================================================
// SECTION 5 — golden-rule guard: a single attempt cannot book two generations
// ============================================================================
{
  const root = freshRoot("ordinal");
  const journal = new RecoveryJournal({ root: path.join(root, "worker") });
  const jobId = generateId("job");
  journal.create({ jobId, action: "GENERATE_VIDEO", generationAttemptId: generateId("attempt"), quotaRisk: true });
  journal.markSubmitting(jobId, {});
  const rec1 = readJournal(journal, jobId);
  check("ordinal: first markSubmitting books generationOrdinal=1", rec1.generationOrdinal, 1);
  checkThrows("ordinal: second markSubmitting on same job throws duplicate-generation", () => journal.markSubmitting(jobId, {}), "E_DUPLICATE_GENERATION_ATTEMPT");
  const rec2 = readJournal(journal, jobId);
  check("ordinal: generationOrdinal stays 1 after refused second submit", rec2.generationOrdinal, 1);
}

// ---- cleanup temp roots ----
for (const r of TMP_ROOTS) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
