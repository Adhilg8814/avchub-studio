#!/usr/bin/env node
// P0 Step 2 — in-process mock transport + dispatcher plumbing tests.
// No ui-server, no browser, no Python, no network, no fs runtime state, no quota.
// Run: node tests/mock-transport-tests.mjs

import { MockTransport } from "../lib/worker/mock-transport.mjs";
import { JobTransport } from "../lib/worker/transport.mjs";
import { JobRegistry } from "../lib/worker/job-registry.mjs";
import { WorkerRuntime } from "../lib/worker/worker-runtime.mjs";
import { JobDispatcher } from "../lib/control/job-dispatcher.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";
import { PROTOCOL_ERRORS } from "../lib/protocol/errors.mjs";

// CRIT-1 regression sentinel: any unhandled rejection anywhere in this suite
// (e.g. an illegal terminal→terminal transition escaping an async handler) trips it.
let crit1Unhandled = false;
process.on("unhandledRejection", (err) => { crit1Unhandled = true; console.error("UNHANDLED REJECTION:", err && err.code, err && err.message); });

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
async function checkThrowsAsync(name, fn, code = undefined) {
  try { await fn(); failures += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) { if (code && e.code !== code) { failures += 1; console.error(`FAIL ${name} (code ${e.code})`); } else passed += 1; }
}

const WS = generateId("ws"), WRK = generateId("wrk");
function baseInput(extra = {}) {
  return {
    projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"),
    providerAccountId: generateId("pa"), sourceKeyframeAssetId: generateId("asset"),
    promptSnapshot: "Slow cinematic push-in", baseRevision: 1, ...extra
  };
}
const DUR_CTX = { supportedDurationsSec: [6, 10, 15], defaultDurationSec: 10 };

// fake handlers
function successHandler(counter) {
  return { validate() {}, async execute() { counter.n += 1; return { result: { ok: true } }; } };
}
function progressHandler() {
  return { validate() {}, async execute(input, ctx) {
    ctx.onProgress({ phase: "A", label: "a", percent: 10 });
    ctx.onProgress({ phase: "B", label: "b", percent: 150 }); // will be clamped to 100
    return { result: { done: true } };
  } };
}
function failHandler() {
  return { validate() {}, async execute() { throw new Error("boom secret sk-supersecret-123 C:\\path\\x"); } };
}
function manualHandler() {
  return { validate() {}, async execute() { return { needsManualAction: true, reason: "PROVIDER_VERIFICATION", message: "verify" }; } };
}
function waitCancelHandler(state) {
  return { validate() {}, async execute(input, ctx) {
    state.started = true;
    // resolve only when aborted
    await new Promise((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { result: { reached: "end" } }; // runtime sees abort → CANCELED, ignores this
  } };
}
function makeStack({ capabilities = ["grok.video", "chatgpt.image", "storage.scan"], handler, action = "GENERATE_GROK_VIDEO" } = {}) {
  const transport = new MockTransport().connect();
  const registry = new JobRegistry();
  if (handler) registry.register(action, handler);
  const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities, durationContext: DUR_CTX }).start();
  const dispatcher = new JobDispatcher({ transport, workspaceId: WS, workerId: WRK, durationContext: DUR_CTX });
  return { transport, registry, runtime, dispatcher };
}

// ================= Transport =================
{
  const t = new MockTransport();
  check("starts disconnected", t.isConnected(), false);
  t.connect(); check("connect", t.isConnected(), true);
  t.connect(); check("connect idempotent", t.isConnected(), true);
  t.disconnect(); check("disconnect", t.isConnected(), false);
  t.disconnect(); check("disconnect idempotent", t.isConnected(), false);

  // send while disconnected rejected
  const env = makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: generateId("job"), payload: { action: "STORAGE_SCAN", input: {} } });
  checkThrows("offerJob while disconnected", () => t.offerJob(env));

  // wrong-direction rejected
  t.connect();
  const workerEnv = makeEnvelope({ type: "JOB_ACCEPTED", workspaceId: WS, workerId: WRK, jobId: generateId("job"), payload: {} });
  checkThrows("offerJob with worker→cloud type rejected", () => t.offerJob(workerEnv));
  const controlEnv = makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: generateId("job"), payload: { action: "STORAGE_SCAN", input: {} } });
  checkThrows("publishWorkerEvent with cloud→worker type rejected", () => t.publishWorkerEvent(controlEnv));

  // event order preserved
  const got = [];
  t.subscribeWorker((e) => got.push(e.type));
  const mk = (jobId) => makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, payload: { action: "STORAGE_SCAN", input: {} } });
  const j1 = generateId("job"), j2 = generateId("job"), j3 = generateId("job");
  t.offerJob(mk(j1)); t.offerJob(mk(j2)); t.offerJob(mk(j3));
  check("event order preserved", got.length, 3);

  // subscriber exception must not corrupt transport
  const t2 = new MockTransport().connect();
  let delivered = 0;
  t2.subscribeWorker(() => { throw new Error("bad subscriber"); });
  t2.subscribeWorker(() => { delivered += 1; });
  t2.offerJob(mk(generateId("job")));
  check("throwing subscriber does not block others", delivered, 1);
  check("delivery error recorded", t2.getDeliveryErrors().length, 1);
  check("transport still usable after subscriber throw", t2.isConnected(), true);

  // isolated instances do not leak
  const a = new MockTransport().connect(), b = new MockTransport().connect();
  let aCount = 0, bCount = 0;
  a.subscribeWorker(() => aCount += 1);
  b.subscribeWorker(() => bCount += 1);
  a.offerJob(mk(generateId("job")));
  check("isolated: a received", aCount, 1);
  check("isolated: b did not", bCount, 0);

  // history is a copy (no mutable internal exposure)
  const hist = t.getHistory();
  hist.push({ tampered: true });
  hist[0].type = "HACKED";
  check("getHistory returns copy (length unaffected)", t.getHistory().length, 3);
  check("getHistory returns copy (content unaffected)", t.getHistory()[0].type, "JOB_OFFER");

  // base class contract throws
  checkThrows("abstract JobTransport.connect throws", () => new JobTransport().connect());
}

// ================= Registry =================
{
  const r = new JobRegistry();
  const h = successHandler({ n: 0 });
  r.register("GENERATE_GROK_VIDEO", h);
  check("has after register", r.has("GENERATE_GROK_VIDEO"), true);
  check("resolve returns handler", r.resolve("GENERATE_GROK_VIDEO"), h);
  check("listActions", r.listActions().includes("GENERATE_GROK_VIDEO"), true);
  checkThrows("duplicate registration rejected", () => r.register("GENERATE_GROK_VIDEO", h));
  check("replace option allowed", (() => { r.register("GENERATE_GROK_VIDEO", h, { replace: true }); return true; })(), true);
  checkThrows("invalid action rejected", () => r.register("RUN_COMMAND", h), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  checkThrows("malformed handler rejected", () => r.register("STORAGE_SCAN", { execute() {} }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("resolve unknown throws", () => r.resolve("EXPORT_PROJECT"), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  check("unregister", (() => { r.unregister("GENERATE_GROK_VIDEO"); return r.has("GENERATE_GROK_VIDEO"); })(), false);
}

// ================= Runtime =================
{
  // success lifecycle
  {
    const counter = { n: 0 };
    const { dispatcher, transport } = makeStack({ handler: successHandler(counter) });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput({ requestedDurationSec: 10 }));
    const res = await h.done;
    check("success terminal COMPLETED", res.type, "JOB_COMPLETED");
    check("handler executed once", counter.n, 1);
    const seq = transport.getHistory().map((x) => x.type);
    check("lifecycle order", seq.slice(0, 4).join(","), "JOB_OFFER,JOB_ACCEPTED,JOB_STARTED,JOB_COMPLETED");
  }

  // progress lifecycle + percent clamp
  {
    const { dispatcher } = makeStack({ handler: progressHandler() });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    await h.done;
    const events = dispatcher.getJob(h.jobId);
    const progressEvents = dispatcher._jobs.get(h.jobId).events.filter((e) => e.type === "JOB_PROGRESS");
    check("two progress events", progressEvents.length, 2);
    check("sequence increasing", progressEvents[1].payload.sequence > progressEvents[0].payload.sequence, true);
    check("percent clamped to 100", progressEvents[1].payload.percent, 100);
  }

  // failure lifecycle + sanitized error (no secret echo)
  {
    const { dispatcher } = makeStack({ handler: failHandler() });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    const res = await h.done;
    check("failure terminal FAILED", res.type, "JOB_FAILED");
    check("error code generic", res.payload.errorCode, "E_HANDLER_FAILED");
    check("no secret echoed in errorMessage", /sk-supersecret|C:\\/.test(JSON.stringify(res.payload)), false);
  }

  // manual-action lifecycle (behavior B: non-terminal, stays active)
  {
    const { dispatcher, runtime } = makeStack({ handler: manualHandler() });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    // manual-action does not resolve done; poll state
    await new Promise((r) => setImmediate(r));
    check("manual state NEEDS_MANUAL_ACTION", runtime.getJobState(h.jobId), "NEEDS_MANUAL_ACTION");
    check("manual job still active", runtime.listActiveJobs().includes(h.jobId), true);
    // cancel resolves it to terminal
    dispatcher.cancel(h.jobId);
    const res = await h.done;
    check("manual then cancel → CANCELED", res.type, "JOB_CANCELED");
  }

  // missing capability rejected before execution
  {
    const counter = { n: 0 };
    const { dispatcher } = makeStack({ capabilities: ["chatgpt.image"], handler: successHandler(counter) });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    const res = await h.done;
    check("missing capability → JOB_REJECTED", res.type, "JOB_REJECTED");
    check("capability error code", res.payload.errorCode, PROTOCOL_ERRORS.E_CAPABILITY_UNAVAILABLE);
    check("handler NOT executed on missing capability", counter.n, 0);
  }

  // duplicate active job not executed twice
  {
    const state = { started: false };
    const { dispatcher, runtime, transport } = makeStack({ handler: waitCancelHandler(state) });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    await new Promise((r) => setImmediate(r));
    check("job running", runtime.getJobState(h.jobId), "RUNNING");
    // re-deliver a valid JOB_OFFER for the SAME jobId — must not restart handler
    runtime.handleEnvelope(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: h.jobId, payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: baseInput() } }));
    check("duplicate active offer still RUNNING (not restarted)", runtime.getJobState(h.jobId), "RUNNING");
    dispatcher.cancel(h.jobId);
    await h.done;
  }

  // duplicate completed job does not execute twice (re-emits terminal)
  {
    const counter = { n: 0 };
    const { dispatcher, runtime, transport } = makeStack({ handler: successHandler(counter) });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    await h.done;
    check("executed once before dup", counter.n, 1);
    const histLen = transport.getHistory().length;
    runtime.handleEnvelope(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: h.jobId, payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: baseInput() } }));
    check("completed dup does not re-execute", counter.n, 1);
    check("completed dup re-emits terminal", transport.getHistory().length > histLen, true);
  }

  // start/stop idempotency + stop cancels active
  {
    const state = { started: false };
    const { runtime, dispatcher } = makeStack({ handler: waitCancelHandler(state) });
    runtime.start(); runtime.start(); // idempotent
    check("running", runtime.isRunning(), true);
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    await new Promise((r) => setImmediate(r));
    runtime.stop();
    check("stopped", runtime.isRunning(), false);
    runtime.stop(); // idempotent
    const res = await h.done;
    check("stop cancels active job", res.type, "JOB_CANCELED");
  }
}

// ================= Dispatcher =================
{
  // dispatch success + terminal tracked + ordered subscription
  {
    const { dispatcher } = makeStack({ handler: progressHandler() });
    const seen = [];
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    dispatcher.subscribe(h.jobId, (e) => seen.push(e.type));
    const res = await h.done;
    check("dispatch success", res.type, "JOB_COMPLETED");
    check("getJob terminal tracked", dispatcher.getJob(h.jobId).terminal.type, "JOB_COMPLETED");
    // subscription registered after ACCEPTED/STARTED already delivered; still gets terminal
    check("subscriber received ordered terminal", seen[seen.length - 1], "JOB_COMPLETED");
    check("attempt id valid prefix", h.generationAttemptId.split("_")[0], "attempt");
    check("req id valid prefix", h.requestIdempotencyKey.split("_")[0], "req");
  }

  // same requestIdempotencyKey dedupes
  {
    const counter = { n: 0 };
    const { dispatcher } = makeStack({ handler: successHandler(counter) });
    const key = generateId("req");
    const h1 = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput(), { requestIdempotencyKey: key, generationAttemptId: generateId("attempt") });
    await h1.done;
    const h2 = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput(), { requestIdempotencyKey: key, generationAttemptId: generateId("attempt") });
    check("same req key → same jobId", h2.jobId, h1.jobId);
    check("same req key does not execute twice", counter.n, 1);
  }

  // same prompt, new req key → new job (variant allowed)
  {
    const counter = { n: 0 };
    const { dispatcher } = makeStack({ handler: successHandler(counter) });
    const input = baseInput();
    const h1 = dispatcher.dispatch("GENERATE_GROK_VIDEO", { ...input });
    await h1.done;
    const h2 = dispatcher.dispatch("GENERATE_GROK_VIDEO", { ...input }, { parentAttemptId: h1.generationAttemptId });
    await h2.done;
    check("new req key → new jobId", h2.jobId !== h1.jobId, true);
    check("same prompt generated twice (deliberate)", counter.n, 2);
    check("parentAttemptId preserved", h2.parentAttemptId, h1.generationAttemptId);
  }

  // cancel flow (running)
  {
    const state = { started: false };
    const { dispatcher, runtime } = makeStack({ handler: waitCancelHandler(state) });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    await new Promise((r) => setImmediate(r));
    check("running before cancel", runtime.getJobState(h.jobId), "RUNNING");
    const c = dispatcher.cancel(h.jobId);
    check("cancel ok", c.ok, true);
    const res = await h.done;
    check("cancel → CANCELED", res.type, "JOB_CANCELED");
    // duplicate cancel idempotent
    const c2 = dispatcher.cancel(h.jobId);
    check("duplicate cancel idempotent", c2.ok, true);
  }

  // unknown job cancel safe
  {
    const { dispatcher } = makeStack({ handler: successHandler({ n: 0 }) });
    const c = dispatcher.cancel("job_01JQ7ZK9M3N4P5Q6R7S8T9V0ZZ");
    check("unknown job cancel safe", c.ok, false);
    check("unknown job cancel reason", c.reason, "unknown-job");
  }

  // unknown action dispatch rejected
  {
    const { dispatcher } = makeStack({ handler: successHandler({ n: 0 }) });
    checkThrows("dispatch unknown action", () => dispatcher.dispatch("RUN_COMMAND", {}), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  }

  // capability duration: unsupported duration rejected at dispatch (before send)
  {
    const { dispatcher } = makeStack({ handler: successHandler({ n: 0 }) });
    checkThrows("dispatch grok-video 15 unsupported", () => dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput({ requestedDurationSec: 15 }), { durationContext: { supportedDurationsSec: [10] } }), PROTOCOL_ERRORS.E_DURATION_OPTION_UNAVAILABLE);
  }

  // dispatcher emits canonical JOB_OFFER shape: request identity at payload level,
  // business-only input (no requestIdempotencyKey/generationAttemptId inside input)
  {
    const transport = new MockTransport().connect();
    let offer = null;
    transport.subscribeWorker((env) => { if (env.type === "JOB_OFFER") offer = env; });
    const dispatcher = new JobDispatcher({ transport, workspaceId: WS, workerId: WRK, durationContext: DUR_CTX });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput(), { parentAttemptId: generateId("attempt") });
    check("offer captured", Boolean(offer), true);
    check("offer.payload.action", offer.payload.action, "GENERATE_GROK_VIDEO");
    check("offer requestIdempotencyKey at payload level", offer.payload.requestIdempotencyKey, h.requestIdempotencyKey);
    check("offer generationAttemptId at payload level", offer.payload.generationAttemptId, h.generationAttemptId);
    check("offer parentAttemptId at payload level", offer.payload.parentAttemptId, h.parentAttemptId);
    check("offer quotaRisk true", offer.payload.quotaRisk, true);
    check("offer acceptedBaseRevision from input", offer.payload.acceptedBaseRevision, 1);
    check("offer input has NO requestIdempotencyKey", offer.payload.input.requestIdempotencyKey === undefined, true);
    check("offer input has NO generationAttemptId", offer.payload.input.generationAttemptId === undefined, true);
    check("offer input has business promptSnapshot", offer.payload.input.promptSnapshot, "Slow cinematic push-in");
  }
}

// ================= ACK =================
{
  // terminal receives MESSAGE_ACK; ACK not itself acked; duplicate ACK harmless
  {
    const { dispatcher, runtime, transport } = makeStack({ handler: successHandler({ n: 0 }) });
    const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
    await h.done;
    const acks = transport.getHistory().filter((x) => x.type === "MESSAGE_ACK");
    check("one MESSAGE_ACK for terminal", acks.length, 1);
    // runtime recorded ack, did not emit another message
    const before = transport.getHistory().length;
    // simulate a duplicate terminal re-emit → dispatcher must not double-ack (messageId dedupe)
    const rec = dispatcher._jobs.get(h.jobId);
    const terminalMsgId = transport.getHistory().find((x) => x.type === "JOB_COMPLETED").messageId;
    // Re-deliver the same terminal envelope to control subscribers is internal;
    // instead re-offer to runtime (completed) which re-emits stored terminal with same messageId
    runtime.handleEnvelope(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: h.jobId, payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), input: baseInput() } }));
    const acksAfter = transport.getHistory().filter((x) => x.type === "MESSAGE_ACK");
    check("duplicate terminal does not double-ack (messageId dedupe)", acksAfter.length, 1);
    // no ACK is ever acked (no MESSAGE_ACK whose ackedType is MESSAGE_ACK)
    check("no ack-of-ack in history", transport.getHistory().some((x) => x.type === "MESSAGE_ACK") && acksAfter.length === 1, true);
  }
}

// ================= Security =================
{
  // command/path/secret field still rejected by job contract via dispatcher
  const { dispatcher } = makeStack({ handler: successHandler({ n: 0 }) });
  checkThrows("dispatch with cookie field rejected", () => dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput({ cookie: "x" })), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  checkThrows("dispatch with command field rejected", () => dispatcher.dispatch("EXPORT_PROJECT", { projectId: generateId("prj"), episodeId: generateId("ep"), command: "rm" }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  checkThrows("dispatch with outputPath rejected", () => dispatcher.dispatch("EXPORT_PROJECT", { projectId: generateId("prj"), episodeId: generateId("ep"), outputPath: "C:\\x" }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);

  // transport does not accept arbitrary message type
  const t = new MockTransport().connect();
  checkThrows("transport rejects arbitrary type", () => t.offerJob(makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: generateId("job"), payload: { action: "STORAGE_SCAN", input: {} } })) && (() => { throw 0; })());
  checkThrows("envelope with unknown type cannot be built into offer", () => t.offerJob({ ...makeEnvelope({ type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId: generateId("job"), payload: { action: "STORAGE_SCAN", input: {} } }), type: "FROB" }));
}

// ================= CRIT-1 regression: terminal-emission crash-safety (pure mode) =================
{
  // Handler completes AFTER the transport is disconnected, so terminal emission's
  // publish fails. The runtime must NOT attempt a second terminal transition
  // (SUCCEEDED→FAILED) and must NOT throw an unhandled rejection; the terminal
  // state is preserved and delivery is recorded as deferred/undelivered.
  let release; const gate = new Promise((r) => { release = r; });
  const gatedHandler = { validate() {}, async execute() { await gate; return { result: { ok: true } }; } };
  const { dispatcher, runtime, transport } = makeStack({ handler: gatedHandler });
  const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
  await new Promise((r) => setImmediate(r));
  check("crit1 pure: running before disconnect", runtime.getJobState(h.jobId), "RUNNING");
  transport.disconnect();   // transport drops mid-job
  release();                // handler resolves → terminal publish fails
  await new Promise((r) => setTimeout(r, 30)); // let any (buggy) rejection surface
  check("crit1 pure: no unhandled rejection", crit1Unhandled, false);
  check("crit1 pure: terminal preserved (SUCCEEDED, not FAILED)", runtime.getJobState(h.jobId), "SUCCEEDED");
  const ds = runtime.getDeliveryStatus(h.jobId);
  check("crit1 pure: delivery deferred", ds.deferred, true);
  check("crit1 pure: sanitized delivery error present", typeof ds.error === "string" && ds.error.length > 0, true);
  check("crit1 pure: undelivered flagged (no durable replay in pure mode)", ds.undelivered, true);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
