// AVC Studio P0 Step 2 — in-memory job store.
//
// PURE / in-memory. No fs/net/timers. A tiny Map wrapper both WorkerRuntime and
// JobDispatcher use to track per-job state without a durable store (that comes
// in a later P0 step). Isolated per instance — no module-level singleton.

export class InMemoryJobStore {
  constructor() {
    this._jobs = new Map(); // jobId -> record (opaque to the store)
  }

  has(jobId) { return this._jobs.has(jobId); }
  get(jobId) { return this._jobs.get(jobId) ?? null; }

  create(jobId, record) {
    if (this._jobs.has(jobId)) throw new Error(`Job already exists: ${jobId}`);
    this._jobs.set(jobId, record);
    return record;
  }

  set(jobId, record) { this._jobs.set(jobId, record); return record; }

  patch(jobId, patch) {
    const cur = this._jobs.get(jobId);
    if (!cur) return null;
    Object.assign(cur, patch);
    return cur;
  }

  delete(jobId) { return this._jobs.delete(jobId); }
  list() { return [...this._jobs.values()]; }
  ids() { return [...this._jobs.keys()]; }
  clear() { this._jobs.clear(); }
  get size() { return this._jobs.size; }
}
