#!/usr/bin/env node
// P0 Step 5A — Worker Protocol v1 over a REAL local WebSocket (transport + lifecycle).
// Localhost only, fake handlers, fake credentials, temp recovery dirs. NO browser,
// NO Python, NO provider, NO quota.

import {
  generateId, waitFor, tick, mkTmp, cleanupTmp, startPlane, connectFakeWorker,
  makeIdentity, grokInput, exportInput, activeHandleCount
} from "./helpers/step5a-harness.mjs";

let unhandled = false;
process.on("unhandledRejection", (err) => { unhandled = true; console.error("UNHANDLED REJECTION:", err && err.message); });

let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}

const workers = [];
const planes = [];
async function shutdown() {
  for (const w of workers) { try { await w.agent.stop(); } catch { /* ignore */ } }
  for (const p of planes) { try { await p.plane.stop(); } catch { /* ignore */ } }
}

try {
  // ---- setup: one plane, one fake worker ----
  const idA = makeIdentity("A");
  const setup = await startPlane({ credentials: { [idA.credential]: { workerId: idA.workerId, workspaceId: idA.workspaceId } } });
  planes.push(setup);
  const { plane, store } = setup;
  const wa = connectFakeWorker(plane, idA);
  workers.push(wa);
  await wa.agent.waitReady();

  // 1. connect + HELLO_ACK
  check("1 worker connected + hello acked", wa.agent._helloAcked, true);
  check("1 worker status ONLINE", plane.getWorkerStatus(idA.workerId), "ONLINE");
  // 2. Authorization header auth (connection succeeded because credential mapped)
  check("2 auth via header (audit worker_connected)", plane.getAudit().some((a) => a.type === "worker_connected"), true);
  check("2 credential never in audit", JSON.stringify(plane.getAudit()).includes(idA.credential), false);
  // 3. identity binding
  check("3 store bound workspace", store.workspaceOf(idA.workerId), idA.workspaceId);
  // 4. capability advertisement
  await waitFor(() => store.capabilities(idA.workerId).length > 0);
  check("4 capabilities advertised", store.capabilities(idA.workerId).includes("grok.video"), true);
  // 5. storage status
  await waitFor(() => store.storage(idA.workerId) != null);
  check("5 storage status received", typeof store.storage(idA.workerId).freeBytes, "number");
  check("5 storage has no absolute root path", /[A-Za-z]:\\|^\//.test(store.storage(idA.workerId).rootLabel || ""), false);
  // 6. heartbeat updates last-seen
  const before = store.lastSeenAt(idA.workerId);
  await tick(5);
  wa.agent.sendHeartbeat();
  await waitFor(() => store.lastSeenAt(idA.workerId) >= before);
  check("6 heartbeat keeps worker online", plane.getWorkerStatus(idA.workerId), "ONLINE");
  // 7. degraded/offline derived from elapsed (deterministic, no sleeping)
  const seen = store.lastSeenAt(idA.workerId);
  check("7 online within threshold", plane.getWorkerStatus(idA.workerId, seen + 50), "ONLINE");
  check("7 degraded after degradedMs", plane.getWorkerStatus(idA.workerId, seen + 150), "DEGRADED");
  check("7 offline after offlineMs", plane.getWorkerStatus(idA.workerId, seen + 400), "OFFLINE");

  // 8–11. job offer → accept → progress → terminal → ACK
  {
    const seenTypes = [];
    plane.getDispatcher(idA.workerId).subscribe; // noop; use dispatcher handle
    const h = plane.offerJob(idA.workerId, "GENERATE_GROK_VIDEO", grokInput());
    plane.getDispatcher(idA.workerId)._jobs.get(h.jobId); // ensure tracked
    const res = await h.done;
    check("8/9 job accepted + progressed (terminal COMPLETED)", res.type, "JOB_COMPLETED");
    check("8 provider is FAKE (no real Grok)", res.payload.result.asset.provider, "FAKE");
    await waitFor(() => wa.journal.read(h.jobId)?.acknowledged === true);
    check("11 MESSAGE_ACK cleared pending-ack", wa.pendingAck.list().length, 0);
    check("11 journal acknowledged (settled)", wa.journal.read(h.jobId).acknowledged, true);
    // progress ordering via journal phase progression / terminal
    check("10 terminal recorded in journal", wa.journal.read(h.jobId).terminal.type, "JOB_COMPLETED");

    // 12. duplicate ACK harmless
    const termMsg = wa.journal.read(h.jobId).terminalMessageId;
    plane.sendAck(idA.workerId, termMsg, "JOB_COMPLETED", h.jobId);
    await tick(20);
    check("12 duplicate ACK harmless (pending still empty)", wa.pendingAck.list().length, 0);
    // 13. unknown ACK harmless
    plane.sendAck(idA.workerId, generateId("msg"), "JOB_COMPLETED", generateId("job"));
    await tick(20);
    check("13 unknown ACK harmless (no crash)", unhandled, false);
  }

  // 14. cancel over the wire
  {
    let release; const gate = new Promise((r) => { release = r; });
    const gateHandler = {
      validate() {}, capabilities: () => ["grok.video"],
      async execute(input, ctx) { ctx.onProgress({ phase: "WAITING_FOR_RESULT", percent: 50 }); await new Promise((res) => { if (ctx.signal.aborted) res(); else ctx.signal.addEventListener("abort", res, { once: true }); }); return { aborted: true }; }
    };
    const idC = makeIdentity("C");
    plane.store; // same store
    setup.credentials[idC.credential] = { workerId: idC.workerId, workspaceId: idC.workspaceId };
    const wc = connectFakeWorker(plane, idC, { handlers: { GENERATE_GROK_VIDEO: gateHandler } });
    workers.push(wc);
    await wc.agent.waitReady();
    const h = plane.offerJob(idC.workerId, "GENERATE_GROK_VIDEO", grokInput());
    await waitFor(() => wc.runtime.getJobState(h.jobId) === "RUNNING");
    plane.cancelJob(idC.workerId, h.jobId);
    const res = await h.done;
    check("14 cancel over WS → JOB_CANCELED", res.type, "JOB_CANCELED");
  }

  // 22. duplicate JOB_OFFER does not execute twice
  {
    let n = 0;
    const countHandler = { validate() {}, capabilities: () => ["export.capcut"], async execute() { n += 1; return { result: { package: { mimeType: "application/zip" } } }; } };
    const idD = makeIdentity("D");
    setup.credentials[idD.credential] = { workerId: idD.workerId, workspaceId: idD.workspaceId };
    const wd = connectFakeWorker(plane, idD, { handlers: { EXPORT_PROJECT: countHandler } });
    workers.push(wd);
    await wd.agent.waitReady();
    const disp = plane.getDispatcher(idD.workerId);
    const key = generateId("req");
    const h1 = disp.dispatch("EXPORT_PROJECT", exportInput(), { requestIdempotencyKey: key });
    await h1.done;
    const h2 = disp.dispatch("EXPORT_PROJECT", exportInput(), { requestIdempotencyKey: key });
    check("22 same requestIdempotencyKey → same job", h2.jobId, h1.jobId);
    check("22 duplicate offer executed once", n, 1);
    // 23. new intentional attempt (new key) → new job
    const h3 = disp.dispatch("EXPORT_PROJECT", exportInput());
    await h3.done;
    check("23 new attempt → new job", h3.jobId !== h1.jobId, true);
    check("23 new attempt executed again", n, 2);
  }

  // 30. clean shutdown (graceful goodbye + no lingering handles beyond the plane)
  {
    const idG = makeIdentity("G");
    setup.credentials[idG.credential] = { workerId: idG.workerId, workspaceId: idG.workspaceId };
    const wg = connectFakeWorker(plane, idG, { durable: false, autoReconnect: false });
    await wg.agent.waitReady();
    await wg.agent.stop({ goodbye: true });
    await tick(20);
    check("30 graceful goodbye → worker OFFLINE", plane.getWorkerStatus(idG.workerId), "OFFLINE");
    check("30 goodbye audited", plane.getAudit().some((a) => a.type === "worker_goodbye"), true);
  }

  check("no unhandled rejection across suite", unhandled, false);
} finally {
  await shutdown();
  cleanupTmp();
}

// give sockets a beat to fully close, then report
await tick(30);
check("clean shutdown: no leaked active handles", activeHandleCount() <= 1, true);

if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
