// P0 Step 5C.4 — the real Gateway-backed delivery adapter (replaces the unavailable default).
//
// The Step 5C.3 outbox processor calls sendToWorker(...) for a claimed row. This adapter delivers
// ONLY to a session that is (a) still ACTIVE in PostgreSQL, (b) owned by THIS gateway instance,
// and (c) present as a live local socket at the matching connection epoch. It NEVER mints a new
// messageId (the processor-generated envelope is written verbatim) and a confirmed local write is
// NOT protocol settlement (Step 5C.3 owns settlement by mode). Writes are serialized per socket
// with backpressure + a write timeout; close/timeout races are reported DELIVERY_UNCERTAIN so a
// paid offer is never re-offered on uncertainty.

import WebSocket from "ws";
import { DELIVERY_RESULTS } from "../processor/retry-policy.mjs";
import { sessionRepository } from "../persistence/repositories/session-repository.mjs";

export function createGatewayDeliveryAdapter({ persistence, registry, gatewayInstanceId, clock, config, logger }) {
  const maxBuffered = config.maxBufferedAmountBytes;
  const writeTimeoutMs = config.deliveryWriteTimeoutMs;

  async function sendToWorker({ workspaceId, workerId, connectionSessionId, gatewayInstance, envelope, signal }) {
    if (!connectionSessionId) return { result: DELIVERY_RESULTS.WORKER_OFFLINE, reasonCode: "NO_SESSION" };

    // (a/b) FRESH fence against PostgreSQL (authoritative across instances/restarts).
    let sess;
    try { sess = await persistence.tenantTransaction(workspaceId, (c) => sessionRepository.getById(c, workspaceId, connectionSessionId)); }
    catch { return { result: DELIVERY_RESULTS.TRANSIENT_FAILURE, reasonCode: "FENCE_READ_FAILED" }; }
    if (!sess) return { result: DELIVERY_RESULTS.WORKER_OFFLINE, reasonCode: "SESSION_GONE" };
    if (sess.status !== "ACTIVE") return { result: DELIVERY_RESULTS.SESSION_STALE, reasonCode: "SESSION_" + sess.status };
    if (sess.gateway_instance !== gatewayInstanceId) return { result: DELIVERY_RESULTS.SESSION_NOT_LOCAL, reasonCode: "FOREIGN_INSTANCE" };

    // (c) Local live socket matching the fenced connection epoch.
    const entry = registry.getBySession(connectionSessionId);
    if (!entry || entry.draining) return { result: DELIVERY_RESULTS.WORKER_OFFLINE, reasonCode: "NO_LOCAL_SOCKET" };
    if (entry.epoch !== sess.connection_epoch) return { result: DELIVERY_RESULTS.SESSION_STALE, reasonCode: "EPOCH_MISMATCH" };
    const socket = entry.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return { result: DELIVERY_RESULTS.WORKER_OFFLINE, reasonCode: "SOCKET_NOT_OPEN" };

    // Backpressure: bounded socket buffer (the durable outbox is the real queue; never buffer here).
    if (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > maxBuffered) {
      return { result: DELIVERY_RESULTS.BACKPRESSURE, reasonCode: "BUFFERED_AMOUNT" };
    }
    if (signal && signal.aborted) return { result: DELIVERY_RESULTS.TRANSIENT_FAILURE, reasonCode: "ABORTED_PRE_SEND" };

    // Serialize writes on this socket; write the EXACT processor envelope (messageId preserved).
    const json = JSON.stringify(envelope);
    return entry.serialize(() => writeOnce(socket, json, { writeTimeoutMs, clock, signal }));
  }

  return Object.freeze({ available: true, kind: "gateway", fencesSessions: true, gatewayInstanceId, sendToWorker });
}

// One socket write with a bounded timeout + abort. WRITTEN only after ws confirms the write
// callback with no error. A timeout or close/write race → DELIVERY_UNCERTAIN (conservative).
function writeOnce(socket, json, { writeTimeoutMs, clock, signal }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result, reasonCode) => { if (settled) return; settled = true; cleanup(); resolve({ result, reasonCode }); };
    const onAbort = () => done(DELIVERY_RESULTS.TRANSIENT_FAILURE, "ABORTED");
    const onClose = () => done(DELIVERY_RESULTS.DELIVERY_UNCERTAIN, "CLOSE_RACE");
    let timer = null;
    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) { try { signal.removeEventListener("abort", onAbort); } catch { /* */ } }
      try { socket.off("close", onClose); } catch { /* */ }
    }
    if (signal) { if (signal.aborted) { return done(DELIVERY_RESULTS.TRANSIENT_FAILURE, "ABORTED_PRE_SEND"); } signal.addEventListener("abort", onAbort, { once: true }); }
    try { socket.once("close", onClose); } catch { /* */ }
    if (socket.readyState !== WebSocket.OPEN) return done(DELIVERY_RESULTS.WORKER_OFFLINE, "SOCKET_NOT_OPEN");
    timer = setTimeout(() => done(DELIVERY_RESULTS.DELIVERY_UNCERTAIN, "WRITE_TIMEOUT"), Math.max(1, writeTimeoutMs));
    if (typeof timer.unref === "function") timer.unref();
    try {
      socket.send(json, (err) => {
        if (err) return done(DELIVERY_RESULTS.TRANSIENT_FAILURE, "WRITE_ERROR");
        done(DELIVERY_RESULTS.WRITTEN, "OK");
      });
    } catch (e) {
      done(DELIVERY_RESULTS.PERMANENT_FAILURE, "SEND_THREW");
    }
  });
}
