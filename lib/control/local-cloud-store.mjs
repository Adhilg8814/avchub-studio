// AVC Studio P0 Step 5A — injectable in-memory cloud store (test/dev only).
//
// Holds the minimal cloud-side state that must survive a control-plane simulator
// object restart: per-worker seen messageIds + cached ACKs (for reconnect replay),
// capabilities/storage, last-seen time, and coarse job outcomes (for reconcile).
// NO database, NO real credentials, NO provider data. The raw credential is NEVER
// stored — only the derived workerId/workspaceId identity it maps to.

const MAX_SEEN = 8192;   // per-worker inbound-messageId dedupe ring
const MAX_ACKS = 8192;   // per-worker ACK cache ring
const MAX_AUDIT = 10000; // global audit ring

export class InMemoryCloudStore {
  constructor() {
    this._workers = new Map(); // workerId -> record
    this._audit = [];
  }

  _w(workerId) {
    if (!this._workers.has(workerId)) {
      this._workers.set(workerId, {
        workspaceId: null, capabilities: [], storage: null, lastSeenAt: 0,
        seen: new Set(), acks: new Map(), jobs: new Map(), status: "OFFLINE"
      });
    }
    return this._workers.get(workerId);
  }

  bindWorkspace(workerId, workspaceId) { this._w(workerId).workspaceId = workspaceId; }
  workspaceOf(workerId) { return this._workers.get(workerId)?.workspaceId ?? null; }

  // dedupe + ACK replay (bounded ring — evict oldest so a message flood cannot OOM).
  hasSeen(workerId, messageId) { return this._w(workerId).seen.has(messageId); }
  markSeen(workerId, messageId) { const s = this._w(workerId).seen; s.add(messageId); if (s.size > MAX_SEEN) s.delete(s.values().next().value); }
  setAck(workerId, ackedMessageId, ackEnvelope) { const a = this._w(workerId).acks; a.set(ackedMessageId, ackEnvelope); if (a.size > MAX_ACKS) a.delete(a.keys().next().value); }
  getAck(workerId, messageId) { return this._w(workerId).acks.get(messageId) ?? null; }

  // liveness + advertised state
  touch(workerId, atMs) { this._w(workerId).lastSeenAt = atMs; }
  lastSeenAt(workerId) { return this._workers.get(workerId)?.lastSeenAt ?? 0; }
  setStatus(workerId, status) { this._w(workerId).status = status; }
  setCapabilities(workerId, caps) { this._w(workerId).capabilities = Array.isArray(caps) ? [...caps] : []; }
  capabilities(workerId) { return [...(this._workers.get(workerId)?.capabilities ?? [])]; }
  setStorage(workerId, storage) { this._w(workerId).storage = sanitizeStorage(storage); }
  storage(workerId) { return this._workers.get(workerId)?.storage ?? null; }

  // coarse job outcomes (for reconcile / restart, never re-execution)
  upsertJob(workerId, jobId, patch) {
    const jobs = this._w(workerId).jobs;
    jobs.set(jobId, { ...(jobs.get(jobId) || {}), ...patch });
  }
  getJob(workerId, jobId) { return this._workers.get(workerId)?.jobs.get(jobId) ?? null; }
  listJobs(workerId) { return [...(this._workers.get(workerId)?.jobs.entries() ?? [])].map(([jobId, v]) => ({ jobId, ...v })); }

  // sanitized audit trail (NEVER a raw credential)
  // Bounded audit ring — appended on every (even unauthenticated) upgrade rejection /
  // malformed frame, so it must not grow without limit.
  audit(type, details = {}) { this._audit.push({ type, ...sanitizeAudit(details) }); if (this._audit.length > MAX_AUDIT) this._audit.splice(0, this._audit.length - MAX_AUDIT); }
  getAudit() { return this._audit.map((a) => ({ ...a })); }
}

function sanitizeStorage(s) {
  if (!s || typeof s !== "object") return null;
  // Keep only non-sensitive numbers + a coarse label (never an absolute path/root).
  const out = {};
  if (Number.isFinite(s.freeBytes)) out.freeBytes = s.freeBytes;
  if (Number.isFinite(s.totalBytes)) out.totalBytes = s.totalBytes;
  if (typeof s.rootLabel === "string") out.rootLabel = s.rootLabel.slice(0, 40);
  return out;
}

function sanitizeAudit(details) {
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    const lk = k.toLowerCase();
    if (lk.includes("credential") || lk.includes("authorization") || lk.includes("token") || lk.includes("cookie") || lk.includes("password")) continue;
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}
