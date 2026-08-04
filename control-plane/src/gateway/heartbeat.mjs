// P0 Step 5C.4 — heartbeat / connection-health manager.
//
// ONE controlled reschedule loop for the whole Gateway (no setInterval, no per-connection timer).
// Each tick pings live local sockets and evaluates liveness from lastPongAt (updated by the WS
// 'pong' handler on the CURRENT fenced session only). ACTIVE → DEGRADED after degradedAfterMs;
// → OFFLINE (close + DB) after offlineAfterMs. All DB updates are epoch-fenced: a stale/superseded
// socket can neither flip the worker OFFLINE nor restore ACTIVE.

import { CLOSE } from "./close-codes.mjs";
import { sessionRepository } from "../persistence/repositories/session-repository.mjs";

export function createHeartbeatManager({ registry, persistence, gatewayInstanceId, config, clock, logger, onOffline }) {
  const intervalMs = config.heartbeatIntervalMs;
  const degradedAfterMs = config.degradedAfterMs;
  const offlineAfterMs = config.offlineAfterMs;
  let abort = null, loopPromise = null;

  async function evaluate(entry) {
    if (entry.draining) return;
    const age = clock.now() - entry.lastPongAt;
    if (age > offlineAfterMs) {
      // OFFLINE: fence-close in DB, then close the socket (only the CURRENT session flips OFFLINE).
      try { await persistence.tenantTransaction(entry.workspaceId, (c) => sessionRepository.closeCurrent(c, entry.workspaceId, entry.sessionId, entry.epoch, "HEARTBEAT_OFFLINE")); }
      catch { /* transient; retried next tick or on close */ }
      logger?.info?.("heartbeat_offline", { component: "gateway", event: "heartbeat_offline", workspaceId: entry.workspaceId, workerId: entry.workerId, connectionSessionId: entry.sessionId, gatewayInstanceId });
      try { onOffline && onOffline(entry, CLOSE.HEARTBEAT_TIMEOUT); } catch { /* */ }
      return;
    }
    if (age > degradedAfterMs) {
      try { await persistence.tenantTransaction(entry.workspaceId, (c) => sessionRepository.markDegraded(c, entry.workspaceId, entry.sessionId, entry.epoch)); }
      catch { /* */ }
      logger?.debug?.("heartbeat_degraded", { component: "gateway", event: "heartbeat_degraded", connectionSessionId: entry.sessionId });
    }
    // Prompt a pong (healthy or degraded — gives a degraded connection a chance to recover).
    try { entry.socket.ping(); } catch { /* socket gone; next tick handles it */ }
  }

  async function tick() {
    for (const entry of registry.entries()) {
      if (abort && abort.signal.aborted) break;
      await evaluate(entry);
    }
  }

  async function loop() {
    while (abort && !abort.signal.aborted) {
      try { await tick(); } catch { /* keep looping */ }
      if (!abort || abort.signal.aborted) break;
      try { await clock.sleep(intervalMs, abort.signal); } catch { break; }
    }
  }

  return {
    start() { if (loopPromise) return; abort = new AbortController(); loopPromise = loop(); },
    async stop() {
      if (abort) abort.abort();
      if (loopPromise) { try { await loopPromise; } catch { /* */ } }
      loopPromise = null; abort = null;
    },
    _tick: tick,          // for deterministic tests (backdate lastPongAt then call)
    _evaluate: evaluate
  };
}
