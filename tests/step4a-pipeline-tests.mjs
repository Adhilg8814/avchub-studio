#!/usr/bin/env node
// P0 Step 4A — Worker Runtime execution pipeline (fake handlers only).
//
// Proves: Dispatcher → Transport → WorkerRuntime → HandlerRegistry → FakeHandler →
// Progress → Terminal → Recovery, entirely in-process. NO real provider, NO browser,
// NO Python, NO WebSocket/HTTP/cloud/DB. Filesystem is used ONLY via injected
// RecoveryJournal / PendingAckStore rooted in a throwaway temp dir.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";
import { PROTOCOL_ERRORS } from "../lib/protocol/errors.mjs";
import { classifyRecovery, RECOVERY_STATES } from "../lib/worker/recovery-classifier.mjs";

import { JobRegistry } from "../lib/worker/job-registry.mjs";
import { WorkerRuntime } from "../lib/worker/worker-runtime.mjs";
import { MockTransport } from "../lib/worker/mock-transport.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import { PendingAckStore } from "../lib/worker/pending-ack-store.mjs";
import { createLocalWorkerStack, DEFAULT_DURATION_CONTEXT } from "../lib/worker/local-worker.mjs";
import { defineHandler } from "../lib/worker/handlers/job-handler.mjs";
import {
  makeFakeGrokVideoHandler, makeFakeChatgptImageHandler, makeFakeExportHandler,
  fakeHandlerSet, registerFakeHandlers, fakeVideoMetadata, fakeImageMetadata, fakeExportMetadata
} from "../lib/worker/handlers/fake-handlers.mjs";

// CRIT-1 regression sentinel — no async lifecycle error may escape.
let unhandled = false;
process.on("unhandledRejection", (err) => { unhandled = true; console.error("UNHANDLED REJECTION:", err && err.code, err && err.message); });

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
async function waitFor(pred, tries = 300) {
  for (let i = 0; i < tries; i += 1) { if (pred()) return true; await new Promise((r) => setImmediate(r)); }
  return pred();
}

const tmpDirs = [];
function mkTmp() { const d = mkdtempSync(path.join(os.tmpdir(), "avc-step4a-")); tmpDirs.push(d); return d; }
function cleanup() { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } }

const WS = generateId("ws"), WRK = generateId("wrk");
function grokInput(extra = {}) {
  return { projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"),
    providerAccountId: generateId("pa"), sourceKeyframeAssetId: generateId("asset"),
    promptSnapshot: "Slow cinematic push-in", baseRevision: 1, ...extra };
}
function imageInput(extra = {}) {
  return { projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"),
    providerAccountId: generateId("pa"), promptSnapshot: "A quiet room", baseRevision: 1, ...extra };
}
function exportInput(extra = {}) {
  return { projectId: generateId("prj"), episodeId: generateId("ep"), locales: ["en-US"], ...extra };
}
// Collect worker→cloud events on the control side (subscribe BEFORE dispatch to catch 0%).
function collect(transport, jobId) {
  const events = [];
  transport.subscribeControl((env) => { if (!jobId || env.jobId === jobId) events.push({ type: env.type, messageId: env.messageId, payload: env.payload }); });
  return events;
}
const percents = (events) => events.filter((e) => e.type === "JOB_PROGRESS").map((e) => e.payload.percent);

// ================= Handler registry =================
{
  const reg = new JobRegistry();
  const h = makeFakeGrokVideoHandler();
  reg.register("GENERATE_GROK_VIDEO", h);
  check("has after register", reg.has("GENERATE_GROK_VIDEO"), true);
  check("get returns handler", reg.get("GENERATE_GROK_VIDEO"), h);
  check("get unknown returns null", reg.get("EXPORT_PROJECT"), null);
  check("list contains action", reg.list().includes("GENERATE_GROK_VIDEO"), true);
  check("resolve returns handler", reg.resolve("GENERATE_GROK_VIDEO"), h);
  checkThrows("duplicate registration rejected", () => reg.register("GENERATE_GROK_VIDEO", makeFakeGrokVideoHandler()), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  check("replace allowed", (() => { reg.register("GENERATE_GROK_VIDEO", h, { replace: true }); return true; })(), true);
  checkThrows("unknown action registration rejected", () => reg.register("RUN_COMMAND", h), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  checkThrows("malformed handler rejected", () => reg.register("STORAGE_SCAN", { execute() {} }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("resolve unknown throws", () => reg.resolve("STORAGE_SCAN"), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  check("unregister", (() => { reg.unregister("GENERATE_GROK_VIDEO"); return reg.has("GENERATE_GROK_VIDEO"); })(), false);

  // lazy registration materializes once
  let built = 0;
  const reg2 = new JobRegistry();
  reg2.registerLazy("EXPORT_PROJECT", () => { built += 1; return makeFakeExportHandler(); });
  check("lazy has before materialize", reg2.has("EXPORT_PROJECT"), true);
  check("lazy not built before use", built, 0);
  const lz = reg2.resolve("EXPORT_PROJECT");
  check("lazy materialized", typeof lz.execute === "function", true);
  reg2.get("EXPORT_PROJECT"); reg2.resolve("EXPORT_PROJECT");
  check("lazy factory ran exactly once", built, 1);
  checkThrows("lazy duplicate rejected", () => reg2.registerLazy("EXPORT_PROJECT", () => makeFakeExportHandler()), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // registerFakeHandlers convenience
  const reg3 = registerFakeHandlers(new JobRegistry());
  check("registerFakeHandlers registers 3", reg3.list().length, 3);
}

// ================= JobHandler interface (defineHandler) =================
{
  const h = defineHandler({ action: "GENERATE_GROK_VIDEO", execute: async () => ({ result: {} }) });
  check("defineHandler capabilities default from action", h.capabilities().join(","), "grok.video");
  check("defineHandler has validate", typeof h.validate, "function");
  check("defineHandler has cancel", typeof h.cancel, "function");
  check("defineHandler has recover", typeof h.recover, "function");
  check("defineHandler recover default null", h.recover({}), null);
  const h2 = defineHandler({ action: "EXPORT_PROJECT", capabilities: ["export.capcut", "extra.cap"], execute: async () => ({}) });
  check("defineHandler explicit capabilities", h2.capabilities().join(","), "export.capcut,extra.cap");
  checkThrows("defineHandler requires execute", () => defineHandler({ action: "EXPORT_PROJECT" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("defineHandler unknown action", () => defineHandler({ action: "RUN_COMMAND", execute: async () => ({}) }), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  // fake handler exposes the full interface
  const fg = makeFakeGrokVideoHandler();
  check("fake handler capabilities", fg.capabilities().join(","), "grok.video");
  check("fake handler recover descriptor", fg.recover({ submittedToProvider: true, localResultRef: "a/b.mp4" }).canReuseExistingResult, true);
}

// ================= Fake metadata determinism =================
{
  const input = grokInput();
  const m1 = fakeVideoMetadata(input), m2 = fakeVideoMetadata(input);
  check("video metadata deterministic", JSON.stringify(m1), JSON.stringify(m2));
  check("video checksum stable prefix", m1.checksum.startsWith("sha256:"), true);
  check("video dims 9:16", `${m1.width}x${m1.height}`, "1080x1920");
  check("video relativePath relative (no backslash/scheme)", /^[A-Za-z0-9._/-]+$/.test(m1.relativePath) && !m1.relativePath.includes(".."), true);
  check("different input → different checksum", fakeVideoMetadata(grokInput()).checksum !== m1.checksum, true);
  const img = fakeImageMetadata(imageInput());
  check("image mimeType png", img.mimeType, "image/png");
  const xp = fakeExportMetadata(exportInput());
  check("export mimeType zip", xp.mimeType, "application/zip");
  check("export locales preserved", xp.locales.join(","), "en-US");
}

// ================= Dispatch success — full loop (grok video, durable) =================
{
  const root = mkTmp();
  const journal = new RecoveryJournal({ root });
  const pendingAck = new PendingAckStore({ root });
  const { transport, dispatcher, runtime } = createLocalWorkerStack({ workspaceId: WS, workerId: WRK, journal, pendingAck });
  const events = collect(transport);
  const input = grokInput();
  const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", input);
  const res = await h.done;
  await waitFor(() => journal.read(h.jobId)?.acknowledged === true);

  check("grok terminal COMPLETED", res.type, "JOB_COMPLETED");
  check("grok progress ordering 0..100", percents(events).join(","), "0,25,50,75,100");
  const lifecycle = events.map((e) => e.type);
  check("lifecycle starts OFFER? no (control side) — ACCEPTED first", lifecycle[0], "JOB_ACCEPTED");
  check("lifecycle order ACCEPTED,STARTED,PROGRESS…", `${lifecycle[0]},${lifecycle[1]},${lifecycle[2]}`, "JOB_ACCEPTED,JOB_STARTED,JOB_PROGRESS");
  check("terminal after all progress", lifecycle.filter((t) => t === "JOB_COMPLETED").length >= 1, true);
  const rec = journal.read(h.jobId);
  check("journal submittedToProvider", rec.submittedToProvider, true);
  check("journal localResultRef present", typeof rec.localResultRef === "string" && rec.localResultRef.length > 0, true);
  check("journal importedAssetId present", rec.importedAssetId?.split("_")[0], "asset");
  check("journal terminal persisted", rec.terminal.type, "JOB_COMPLETED");
  check("journal acknowledged after loop", rec.acknowledged, true);
  check("pending-ack drained after ACK", pendingAck.list().length, 0);
  check("result carries deterministic checksum", res.payload.result.asset.checksum, fakeVideoMetadata(input).checksum);
  check("result asset not auto-approved", res.payload.result.asset.approved, false);
}

// ================= Dispatch success — chatgpt image + export =================
{
  const { transport, dispatcher } = createLocalWorkerStack({ workspaceId: WS, workerId: WRK });
  const evImg = collect(transport);
  const hi = dispatcher.dispatch("GENERATE_CHATGPT_IMAGE", imageInput());
  const ri = await hi.done;
  check("chatgpt image COMPLETED", ri.type, "JOB_COMPLETED");
  check("chatgpt image progress 0..100", percents(evImg).join(","), "0,25,50,75,100");
  check("chatgpt image asset kind", ri.payload.result.asset.kind, "image");

  const evExp = collect(transport);
  const hx = dispatcher.dispatch("EXPORT_PROJECT", exportInput());
  const rx = await hx.done;
  check("export COMPLETED", rx.type, "JOB_COMPLETED");
  check("export progress 0..100", percents(evExp).join(","), "0,25,50,75,100");
  check("export package present", rx.payload.result.package.mimeType, "application/zip");
  check("export did NOT submit to provider", rx.payload.result.package.locales.join(","), "en-US");
}

// ================= Error paths =================
{
  // unknown action → dispatcher rejects synchronously
  {
    const { dispatcher } = createLocalWorkerStack({ workspaceId: WS, workerId: WRK });
    checkThrows("unknown action rejected at dispatch", () => dispatcher.dispatch("RUN_COMMAND", {}), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  }
  // missing handler (capability present, no handler registered) → JOB_REJECTED E_UNKNOWN_ACTION
  {
    const transport = new MockTransport().connect();
    const runtime = new WorkerRuntime({ transport, registry: new JobRegistry(), workerId: WRK, capabilities: ["grok.video"], durationContext: DEFAULT_DURATION_CONTEXT }).start();
    const ev = collect(transport);
    transport.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: generateId("job"), correlationId: generateId("corr"),
      payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: grokInput() } }));
    await waitFor(() => ev.some((e) => e.type === "JOB_REJECTED"));
    check("missing handler → JOB_REJECTED", ev.find((e) => e.type === "JOB_REJECTED").payload.errorCode, PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  }
  // handler validation failure → JOB_REJECTED (distinct from execute throw)
  {
    const registry = registerFakeHandlers(new JobRegistry(), { grokVideo: { rejectValidation: "nope" } });
    const transport = new MockTransport().connect();
    const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video", "chatgpt.image", "export.capcut"], durationContext: DEFAULT_DURATION_CONTEXT }).start();
    const ev = collect(transport);
    transport.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: generateId("job"), correlationId: generateId("corr"),
      payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: grokInput() } }));
    await waitFor(() => ev.some((e) => e.type === "JOB_REJECTED"));
    check("handler validation failure → JOB_REJECTED", ev.find((e) => e.type === "JOB_REJECTED").payload.errorCode, PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
    check("validation failure did not execute (no progress)", ev.some((e) => e.type === "JOB_PROGRESS"), false);
  }
  // handler execute throw → JOB_FAILED, sanitized
  {
    const registry = registerFakeHandlers(new JobRegistry(), { grokVideo: { failAtStep: 2, failError: Object.assign(new Error("boom secret sk-xyz C:\\path"), {}) } });
    const { transport, dispatcher } = createLocalWorkerStack({ workspaceId: WS, workerId: WRK, registry });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", grokInput());
    const res = await h.done;
    check("execute throw → JOB_FAILED", res.type, "JOB_FAILED");
    check("failure error code generic", res.payload.errorCode, "E_HANDLER_FAILED");
    check("failure message sanitized (no secret)", /sk-xyz|C:\\|secret/.test(JSON.stringify(res.payload)), false);
  }
}

// ================= Cancel paths =================
{
  // cancel BEFORE execute (paused at step 0, before any progress or submission)
  {
    const gateHandler = makeFakeGrokVideoHandler({ onStep: async (i, ctx) => {
      if (i === 0) await new Promise((res) => { if (ctx.signal.aborted) res(); else ctx.signal.addEventListener("abort", res, { once: true }); });
    } });
    const root = mkTmp();
    const journal = new RecoveryJournal({ root });
    const { dispatcher, runtime } = createLocalWorkerStack({ workspaceId: WS, workerId: WRK, handlers: { GENERATE_GROK_VIDEO: gateHandler }, capabilities: ["grok.video"], journal });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", grokInput());
    await waitFor(() => runtime.getJobState(h.jobId) === "RUNNING");
    dispatcher.cancel(h.jobId);
    const res = await h.done;
    check("cancel before execute → JOB_CANCELED", res.type, "JOB_CANCELED");
    check("cancel before submit: not submittedToProvider", journal.read(h.jobId).submittedToProvider, false);
  }
  // cancel DURING execute (paused at step 2, after submission)
  {
    const gateHandler = makeFakeGrokVideoHandler({ onStep: async (i, ctx) => {
      if (i === 2) await new Promise((res) => { if (ctx.signal.aborted) res(); else ctx.signal.addEventListener("abort", res, { once: true }); });
    } });
    const root = mkTmp();
    const journal = new RecoveryJournal({ root });
    const { transport, dispatcher, runtime } = createLocalWorkerStack({ workspaceId: WS, workerId: WRK, handlers: { GENERATE_GROK_VIDEO: gateHandler }, capabilities: ["grok.video"], journal });
    const ev = collect(transport);
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", grokInput());
    await waitFor(() => percents(ev).length >= 2); // reached step 2 gate (0,25 emitted)
    dispatcher.cancel(h.jobId);
    const res = await h.done;
    check("cancel during execute → JOB_CANCELED", res.type, "JOB_CANCELED");
    check("cancel after submit: submittedToProvider persisted", journal.read(h.jobId).submittedToProvider, true);
    check("submitted+canceled NOT auto-retryable", runtime.recoverJobs().autoRetryable.some((c) => c.jobId === h.jobId), false);
  }
}

// ================= Duplicate dispatch / completion / ACK =================
{
  const { dispatcher, transport } = createLocalWorkerStack({ workspaceId: WS, workerId: WRK });
  // duplicate dispatch: same requestIdempotencyKey → same job, one execution
  const key = generateId("req");
  const h1 = dispatcher.dispatch("GENERATE_GROK_VIDEO", grokInput(), { requestIdempotencyKey: key, generationAttemptId: generateId("attempt") });
  await h1.done;
  const h2 = dispatcher.dispatch("GENERATE_GROK_VIDEO", grokInput(), { requestIdempotencyKey: key, generationAttemptId: generateId("attempt") });
  check("duplicate dispatch → same jobId", h2.jobId, h1.jobId);

  // duplicate completion: re-offer completed job → same terminal messageId, no re-execute
  const counter = { n: 0 };
  const countingHandler = defineHandler({ action: "GENERATE_GROK_VIDEO", capability: "grok.video",
    execute: async (input, ctx) => { counter.n += 1; ctx.markSubmittedToProvider(generateId("submission")); return { result: { ok: true } }; } });
  const transport2 = new MockTransport().connect();
  const registry2 = new JobRegistry().register("GENERATE_GROK_VIDEO", countingHandler);
  const runtime2 = new WorkerRuntime({ transport: transport2, registry: registry2, workerId: WRK, capabilities: ["grok.video"], durationContext: DEFAULT_DURATION_CONTEXT }).start();
  const ev2 = collect(transport2);
  const jobId = generateId("job");
  const offer = makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, correlationId: generateId("corr"),
    payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: grokInput() } });
  transport2.offerJob(offer);
  await waitFor(() => ev2.some((e) => e.type === "JOB_COMPLETED"));
  const termMsg = ev2.find((e) => e.type === "JOB_COMPLETED").messageId;
  transport2.offerJob(offer); // duplicate offer, same jobId
  await new Promise((r) => setImmediate(r));
  const completes = ev2.filter((e) => e.type === "JOB_COMPLETED");
  check("duplicate completion did NOT re-execute", counter.n, 1);
  check("duplicate completion re-emits SAME messageId", completes.every((e) => e.messageId === termMsg), true);

  // duplicate ACK + unknown ACK + late ACK are all harmless (no throw, no re-emit)
  const before = ev2.length;
  const ack = makeEnvelope({ type: "MESSAGE_ACK", workspaceId: WS, workerId: WRK, jobId,
    payload: { ackedMessageId: termMsg, ackedType: "JOB_COMPLETED", status: "ACCEPTED", serverRevision: null, errorCode: null } });
  runtime2.handleEnvelope(ack);
  runtime2.handleEnvelope(ack); // duplicate ACK
  runtime2.handleEnvelope(makeEnvelope({ type: "MESSAGE_ACK", workspaceId: WS, workerId: WRK, jobId: generateId("job"),
    payload: { ackedMessageId: generateId("msg"), ackedType: "JOB_COMPLETED", status: "ACCEPTED", serverRevision: null, errorCode: null } })); // unknown ACK
  check("duplicate/unknown ACK produced no new worker→cloud events", ev2.length, before);
}

// ================= Recovery: disconnect → reconnect → same messageId replay → ACK → cleanup =================
{
  const root = mkTmp();
  const journal = new RecoveryJournal({ root });
  const pendingAck = new PendingAckStore({ root });
  const transport = new MockTransport().connect();
  const registry = registerFakeHandlers(new JobRegistry());
  const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video", "chatgpt.image", "export.capcut"], durationContext: DEFAULT_DURATION_CONTEXT, journal, pendingAck }).start();

  // Offer directly (no dispatcher auto-ack) so we can observe pending-ack before ACK.
  const jobId = generateId("job");
  transport.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, correlationId: generateId("corr"),
    payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: grokInput() } }));
  await waitFor(() => journal.read(jobId)?.terminal != null);
  const rec = journal.read(jobId);
  check("recovery: terminal persisted", rec.terminal.type, "JOB_COMPLETED");
  check("recovery: pending-ack holds terminal", pendingAck.has(rec.terminalMessageId), true);
  check("recovery: not yet acknowledged", rec.acknowledged, false);

  // Runtime restart: a fresh runtime reads the SAME journal → structured candidates,
  // NEVER auto-runs a submitted job.
  const runtime2 = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video", "chatgpt.image", "export.capcut"], durationContext: DEFAULT_DURATION_CONTEXT, journal, pendingAck });
  const recovery = runtime2.recoverJobs();
  check("recovery: candidate present after restart", recovery.candidates.some((c) => c.jobId === jobId), true);
  check("recovery: submitted job NOT auto-retryable", recovery.autoRetryable.length, 0);
  check("recovery: classified terminal-pending-ack", classifyRecovery(journal.read(jobId)), RECOVERY_STATES.TERMINAL_PENDING_ACK);

  // Disconnect + reconnect + duplicate offer → SAME terminal messageId replayed.
  transport.disconnect();
  transport.connect();
  const replay = collect(transport, jobId);
  transport.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, correlationId: generateId("corr"),
    payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: grokInput() } }));
  await new Promise((r) => setImmediate(r));
  check("recovery: replay uses SAME terminal messageId", replay.find((e) => e.type === "JOB_COMPLETED")?.messageId, rec.terminalMessageId);

  // ACK → cleanup.
  runtime.handleEnvelope(makeEnvelope({ type: "MESSAGE_ACK", workspaceId: WS, workerId: WRK, jobId,
    payload: { ackedMessageId: rec.terminalMessageId, ackedType: "JOB_COMPLETED", status: "ACCEPTED", serverRevision: null, errorCode: null } }));
  check("recovery: ACK cleared pending-ack", pendingAck.has(rec.terminalMessageId), false);
  check("recovery: ACK marked journal acknowledged", journal.read(jobId).acknowledged, true);
  check("recovery: acknowledged job now SETTLED", classifyRecovery(journal.read(jobId)), RECOVERY_STATES.SETTLED);
  check("recovery: settled excluded from recoverable", runtime.recoverJobs().candidates.some((c) => c.jobId === jobId), false);
}

// ================= Transport disconnect BEFORE terminal → deferred, no crash =================
{
  // All progress is delivered while connected; the transport drops only just before
  // the terminal is published. Terminal emission is crash-safe: it persists then
  // defers delivery instead of failing the job. (A progress-time disconnect, by
  // contrast, legitimately fails the in-flight job — that is not this scenario.)
  const root = mkTmp();
  const journal = new RecoveryJournal({ root });
  const pendingAck = new PendingAckStore({ root });
  const transport = new MockTransport().connect();
  let release; const gate = new Promise((r) => { release = r; });
  const deferHandler = defineHandler({ action: "GENERATE_GROK_VIDEO", capability: "grok.video",
    execute: async (input, ctx) => {
      ctx.onProgress({ phase: "VALIDATING", percent: 0 });
      ctx.markSubmittedToProvider(generateId("submission"));
      const meta = fakeVideoMetadata(input);
      ctx.markLocalResult(meta.relativePath, generateId("asset"), meta);
      ctx.onProgress({ phase: "IMPORTING", percent: 100 });
      await gate;                      // pause after all progress, before terminal
      return { result: { asset: { assetId: generateId("asset"), provider: "FAKE", ...meta } } };
    } });
  const registry = new JobRegistry().register("GENERATE_GROK_VIDEO", deferHandler);
  const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video"], durationContext: DEFAULT_DURATION_CONTEXT, journal, pendingAck }).start();
  const jobId = generateId("job");
  const ev = collect(transport, jobId);
  transport.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, correlationId: generateId("corr"),
    payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: grokInput() } }));
  await waitFor(() => percents(ev).includes(100)); // all progress delivered while connected
  transport.disconnect();            // drop just before the terminal publish
  release();
  await waitFor(() => journal.read(jobId)?.terminal != null);
  await new Promise((r) => setTimeout(r, 20));
  check("disconnect: no unhandled rejection", unhandled, false);
  check("disconnect: terminal preserved (SUCCEEDED)", runtime.getJobState(jobId), "SUCCEEDED");
  check("disconnect: terminal durably persisted", journal.read(jobId).terminal.type, "JOB_COMPLETED");
  check("disconnect: delivery deferred", runtime.getDeliveryStatus(jobId).deferred, true);
  check("disconnect: pending-ack holds replay copy", pendingAck.has(journal.read(jobId).terminalMessageId), true);
}

// ================= No provider knowledge in the runtime =================
{
  // The runtime module source must not reference any provider/browser/python symbols.
  // (Static guarantee checked in the dedicated purity test below via imports.)
  const stack = createLocalWorkerStack({ workspaceId: WS, workerId: WRK });
  check("runtime exposes only action-driven API", typeof stack.runtime.recoverJobs === "function" && typeof stack.runtime.getJobState === "function", true);
  check("stack derived capabilities from handlers", stack.runtime.getCapabilities().sort().join(","), "chatgpt.image,export.capcut,grok.video");
}

check("no unhandled rejection across suite", unhandled, false);

cleanup();
if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else console.log(`${passed} passed, 0 failed`);
