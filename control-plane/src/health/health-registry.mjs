// P0 Step 5C.1 — component health/readiness registry.
//
// Aggregates cached component lifecycle state. NO expensive network calls: each component
// returns its current in-memory status. Readiness = every registered component reports
// ready === true (a DISABLED dependency reports ready:true and does not block; an
// enabled-but-unimplemented dependency reports ready:false and DOES block).
//
// Distinction (documented in docs/p0-step5c1-notes.md):
//   * liveness   — the process is up and can answer (/healthz). Cheap, no dep checks.
//   * readiness  — config valid + lifecycle initialized + every enabled dependency ready.
//   * degraded   — process live and (mostly) ready, but a non-blocking component signals a
//                  soft problem; represented per-component via reasonCode.

export function createHealthRegistry({ now = () => new Date().toISOString() } = {}) {
  // name → { getStatus, lastReady, lastChangedAt }
  const components = new Map();

  function normalize(name, raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    return {
      component: name,
      enabled: r.enabled === true,
      initialized: r.initialized === true,
      ready: r.ready === true,
      reasonCode: typeof r.reasonCode === "string" ? r.reasonCode : "UNKNOWN"
    };
  }

  return {
    register(name, getStatus) {
      if (typeof getStatus !== "function") throw new Error(`health component ${name} needs a getStatus function`);
      components.set(name, { getStatus, lastReady: null, lastChangedAt: now() });
      return this;
    },

    // snapshot(): { ready, components: [{...perComponent, lastChangedAt}] }
    snapshot() {
      const out = [];
      let allReady = true;
      for (const [name, entry] of components) {
        let status;
        try { status = normalize(name, entry.getStatus()); }
        catch { status = { component: name, enabled: false, initialized: false, ready: false, reasonCode: "STATUS_ERROR" }; }
        if (entry.lastReady === null || entry.lastReady !== status.ready) {
          entry.lastReady = status.ready;
          entry.lastChangedAt = now();
        }
        if (!status.ready) allReady = false;
        out.push({ ...status, lastChangedAt: entry.lastChangedAt });
      }
      return { ready: allReady, components: out };
    },

    // liveness is independent of dependencies — if we can run this, we are alive.
    liveness() { return { alive: true }; },

    isReady() { return this.snapshot().ready; }
  };
}
