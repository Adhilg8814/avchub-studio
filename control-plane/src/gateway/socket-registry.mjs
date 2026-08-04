// P0 Step 5C.4 — in-memory local socket registry (scoped to ONE Gateway process).
//
// Indexes live sockets by connectionSessionId (and workerId → current). Holds ONLY safe runtime
// data — never a credential or resume token. Correctness never depends on this registry alone:
// PostgreSQL session state is authoritative across processes/restarts; this is a transport index
// so the delivery adapter can find the socket it owns and serialize writes per socket.

export function createSocketRegistry() {
  const bySession = new Map();   // connectionSessionId → entry
  const byWorker = new Map();    // workerId → current connectionSessionId

  function makeEntry({ socket, workspaceId, workerId, sessionId, epoch, gatewayInstance, connectedAt }) {
    return {
      socket, workspaceId, workerId, sessionId, epoch, gatewayInstance,
      connectedAt, lastPongAt: connectedAt, draining: false,
      _writeChain: Promise.resolve(),
      // Serialize writes per socket: never interleave two frames on one connection.
      serialize(fn) {
        const next = this._writeChain.then(fn, fn);
        // keep the chain from rejecting the pipeline; swallow here (callers get their own result)
        this._writeChain = next.then(() => {}, () => {});
        return next;
      }
    };
  }

  return {
    register(entry) {
      const e = makeEntry(entry);
      bySession.set(e.sessionId, e);
      byWorker.set(e.workerId, e.sessionId);
      return e;
    },
    getBySession(sessionId) { return bySession.get(sessionId) || null; },
    currentSessionIdFor(workerId) { return byWorker.get(workerId) || null; },
    getCurrentForWorker(workerId) {
      const sid = byWorker.get(workerId);
      return sid ? (bySession.get(sid) || null) : null;
    },
    // Fence: is this the registered CURRENT socket for the session + epoch?
    isCurrent(sessionId, epoch) {
      const e = bySession.get(sessionId);
      return Boolean(e) && !e.draining && (epoch == null || e.epoch === epoch);
    },
    markDraining(sessionId) { const e = bySession.get(sessionId); if (e) e.draining = true; },
    touchPong(sessionId, at) { const e = bySession.get(sessionId); if (e) e.lastPongAt = at; },
    unregister(sessionId) {
      const e = bySession.get(sessionId);
      if (!e) return null;
      bySession.delete(sessionId);
      if (byWorker.get(e.workerId) === sessionId) byWorker.delete(e.workerId);
      return e;
    },
    // Safe aggregate counts (no ids/payloads).
    counts() {
      let active = 0, degraded = 0, draining = 0;
      for (const e of bySession.values()) { active += 1; if (e.draining) draining += 1; }
      return { active, degraded, draining, sessions: bySession.size };
    },
    entries() { return [...bySession.values()]; },
    closeAll(closeFn) {
      for (const e of bySession.values()) { try { closeFn(e); } catch { /* */ } }
      bySession.clear(); byWorker.clear();
    }
  };
}
