#!/usr/bin/env node
// P0 Step 5A — reconnect, STATE_RECONCILE, durable recovery replay, and control-plane
// restart over a REAL local WebSocket. Fake handlers only; no provider/quota.

import {
  generateId, waitFor, tick, cleanupTmp, startPlane, connectFakeWorker, makeIdentity,
  grokInput, RecoveryJournal, PendingAckStore, mkTmp
} from "./helpers/step5a-harness.mjs";

let unhandled = false;
process.on("unhandledRejection", (err) => { unhandled = true; console.error("UNHANDLED REJECTION:", err && err.message); });

let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function gatedGrokHandler(state) {
  return {
    validate() {}, capabilities: () => ["grok.video"],
    async execute(input, ctx) {
      state.n += 1;
      if (state.submit) ctx.markSubmittedToProvider(generateId("submission"));
      ctx.onProgress({ phase: "WAITING_FOR_RESULT", percent: 50 });
      await state.gate;
      if (ctx.signal.aborted) return { aborted: true };
      return { result: { asset: { assetId: generateId("asset"), provider: "FAKE", relativePath: "episodes/ep/videos/out.mp4", checksum: "sha256:x", sizeBytes: 1234, mimeType: "video/mp4", reviewStatus: "PENDING", selected: false, approved: false } } };
    }
  };
}

const workers = []; const planes = [];
async function shutdown() {
  for (const w of workers) { try { await w.agent.stop(); } catch { /* ignore */ } }
  for (const p of planes) { try { await p.plane.stop(); } catch { /* ignore */ } }
}

try {
  // ===== basic reconnect returns online =====
  {
    const id = makeIdentity("R");
    const setup = await startPlane({ credentials: { [id.credential]: { workerId: id.workerId, workspaceId: id.workspaceId } } });
    planes.push(setup);
    const w = connectFakeWorker(setup.plane, id, { autoReconnect: true, backoffMs: [10, 20] });
    workers.push(w);
    await w.agent.waitReady();
    check("16 connected", w.transport.isConnected(), true);
    let reconnected = false;
    w.transport.onReconnect(() => { reconnected = true; });
    setup.plane.disconnectWorker(id.workerId);            // abrupt server-side drop
    await waitFor(() => reconnected, 1000);                // auto-reconnect fired
    check("15 abrupt drop observed + 16 auto-reconnected", reconnected, true);
    check("16 online after reconnect", w.transport.isConnected(), true);
  }

  // ===== Scenario A: terminal persisted, drop before ACK, reconnect replays same messageId =====
  {
    const id = makeIdentity("A");
    const setup = await startPlane({ credentials: { [id.credential]: { workerId: id.workerId, workspaceId: id.workspaceId } } });
    planes.push(setup);
    const state = { n: 0, submit: false, gate: null }; let release;
    state.gate = new Promise((r) => { release = r; });
    const w = connectFakeWorker(setup.plane, id, { handlers: { GENERATE_GROK_VIDEO: gatedGrokHandler(state) }, autoReconnect: false });
    workers.push(w);
    await w.agent.waitReady();
    const h = setup.plane.offerJob(id.workerId, "GENERATE_GROK_VIDEO", grokInput());
    await waitFor(() => w.runtime.getJobState(h.jobId) === "RUNNING");
    setup.plane.disconnectWorker(id.workerId);            // drop while running
    await waitFor(() => !w.transport.isConnected());
    release();                                            // handler completes WHILE disconnected
    await waitFor(() => w.pendingAck.list().length === 1);
    check("A terminal persisted in pending-ack during outage", w.pendingAck.list().length, 1);
    const termMsg = w.journal.read(h.jobId).terminalMessageId;
    check("A journal terminal persisted", w.journal.read(h.jobId).terminal.type, "JOB_COMPLETED");
    check("A not yet acknowledged", w.journal.read(h.jobId).acknowledged, false);

    w.transport.connect();                                // reconnect
    const res = await h.done;                             // terminal delivered post-reconnect
    check("A terminal COMPLETED", res.type, "JOB_COMPLETED");
    await waitFor(() => w.journal.read(h.jobId)?.acknowledged === true);
    check("17 replay used SAME terminal messageId", w.journal.read(h.jobId).terminalMessageId, termMsg);
    check("19 pending-ack cleaned up after reconnect ACK", w.pendingAck.list().length, 0);
    check("20 handler NOT re-executed", state.n, 1);
    check("A journal acknowledged", w.journal.read(h.jobId).acknowledged, true);
  }

  // ===== Scenario B: submitted paid job, drop, reconnect → STATE_RECONCILE, no re-offer =====
  {
    const id = makeIdentity("B");
    const setup = await startPlane({ credentials: { [id.credential]: { workerId: id.workerId, workspaceId: id.workspaceId } } });
    planes.push(setup);
    const state = { n: 0, submit: true, gate: null }; let release;
    state.gate = new Promise((r) => { release = r; });
    const w = connectFakeWorker(setup.plane, id, { handlers: { GENERATE_GROK_VIDEO: gatedGrokHandler(state) }, autoReconnect: false });
    workers.push(w);
    await w.agent.waitReady();
    const h = setup.plane.offerJob(id.workerId, "GENERATE_GROK_VIDEO", grokInput());
    await waitFor(() => w.journal.read(h.jobId)?.submittedToProvider === true);
    setup.plane.disconnectWorker(id.workerId);
    await waitFor(() => !w.transport.isConnected());
    w.transport.connect();                                // reconnect → agent sends STATE_RECONCILE
    await waitFor(() => setup.store.getJob(id.workerId, h.jobId)?.reconciled === true);
    check("18 STATE_RECONCILE received by control plane", setup.store.getJob(id.workerId, h.jobId)?.reconciled, true);
    check("B reconcile carried submittedToProvider=true", setup.store.getJob(id.workerId, h.jobId)?.submittedToProvider, true);
    check("B control plane did NOT re-offer a paid generation", state.n, 1);
    release(); await h.done;                              // let it finish for clean teardown
  }

  // ===== Scenario C: control-plane restart (same store + port), reconnect, no re-execution =====
  {
    const id = makeIdentity("C");
    const setup = await startPlane({ credentials: { [id.credential]: { workerId: id.workerId, workspaceId: id.workspaceId } } });
    const port = setup.plane.port; const store = setup.store; const creds = setup.credentials;
    planes.push(setup);
    const state = { n: 0, submit: false, gate: Promise.resolve() };
    const w = connectFakeWorker(setup.plane, id, { handlers: { GENERATE_GROK_VIDEO: gatedGrokHandler(state) }, autoReconnect: true, backoffMs: [10, 20, 40] });
    workers.push(w);
    await w.agent.waitReady();
    const h = setup.plane.offerJob(id.workerId, "GENERATE_GROK_VIDEO", grokInput());
    await h.done;
    await waitFor(() => w.journal.read(h.jobId)?.acknowledged === true);
    const termMsg = w.journal.read(h.jobId).terminalMessageId;
    check("C job settled before restart", w.journal.read(h.jobId).acknowledged, true);
    check("21 store saw terminal (dedupe state)", store.hasSeen(id.workerId, termMsg), true);

    await setup.plane.stop();                             // control-plane restarts...
    await waitFor(() => !w.transport.isConnected());
    const restarted = await startPlane({ credentials: creds, store, port }); // same store + port
    planes.push(restarted);
    await waitFor(() => w.transport.isConnected(), 1500); // worker auto-reconnects
    check("21 worker reconnected after control-plane restart", w.transport.isConnected(), true);
    check("21 ACK dedupe state survived restart (injected store)", restarted.store.hasSeen(id.workerId, termMsg), true);
    await tick(30);
    check("21 no re-execution after restart", state.n, 1);
    check("21 settled job stays settled", w.journal.read(h.jobId).acknowledged, true);
  }

  check("no unhandled rejection across suite", unhandled, false);
} finally {
  await shutdown();
  cleanupTmp();
}

await tick(30);
if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
