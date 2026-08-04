// P0 Step 5C.31 — EXECUTION WORKER ASSIGNMENT.
//
// Answers one question for a workspace, at dispatch time: "which machine executes this tenant's
// attempts — the Studio host itself, or a dedicated remote worker?"
//
// The answer comes from the 5C.29 Phase 7 dedicated-resource registry (workspace_resources), which
// already guarantees the property the architecture lock demands: a (resource_type, resource_ref) pair
// is GLOBALLY unique, so one worker can be bound to exactly one workspace. A shared worker is not
// "discouraged" here — it is unrepresentable.
//
// Two deliberate behaviours:
//
//   * Grandfathering. A workspace with NO bound WORKER resource resolves LOCAL. That is the existing
//     production owner workspace, and its dispatch path stays byte-identical to today.
//   * No silent fallback. A workspace that DOES have a dedicated remote worker never runs on the
//     Studio host, not even when the remote worker is offline. The dispatch is BLOCKED with a reason
//     the owner can act on. Running a tenant's prompt on the owner's browser profile because the
//     tenant's machine was asleep would be a tenancy violation, not a convenience.

const WID = /^wrk_[0-9A-HJKMNP-TV-Z]{26}$/u;
function assignErr(code, message) { return Object.assign(new Error(message || code), { code }); }

export const ASSIGNMENT_REASONS = Object.freeze({
  LOCAL: "LOCAL",
  NO_REMOTE_WORKER: "NO_REMOTE_WORKER",
  NOT_APPROVED: "NOT_APPROVED",
  DRAINING: "DRAINING",
  OFFLINE: "OFFLINE",
  DISCONNECTED: "DISCONNECTED",
  REVOKED: "REVOKED",
  REMOVED: "REMOVED",
  INCOMPATIBLE: "INCOMPATIBLE",
  UPDATING: "UPDATING",
  READY: "READY"
});

export function createWorkerAssignment({
  persistence, registry, isConnected = () => false,
  // Master switch. OFF (default) => every workspace resolves LOCAL and this module has no effect at
  // all on production — the staged rollout turns it on for the disposable tenant first.
  remoteDeliveryEnabled = false,
  // Optional hook: (workspaceId, workerId) => Promise. Lets the caller move the workspace project affinity
  // to the newly bound worker at ONBOARDING time (see bindDedicatedWorker).
  assignProjectAffinityAtBind = null,
  cacheMs = 2000, now = () => Date.now(), logger = null
} = {}) {
  if (!persistence || typeof persistence.tenantTransaction !== "function") throw new TypeError("worker assignment requires persistence");
  const cache = new Map(); // wsId -> { at, value }

  async function resolveUncached(wsId) {
    if (!remoteDeliveryEnabled) return { mode: "LOCAL", workerId: null, assignable: true, reason: ASSIGNMENT_REASONS.LOCAL };
    let bound = null;
    try {
      bound = await persistence.tenantTransaction(wsId, async (c) => {
        const r = await c.query(
          "SELECT resource_ref FROM workspace_resources WHERE resource_type='WORKER' AND status='ACTIVE' ORDER BY created_at ASC LIMIT 1");
        return r.rows[0]?.resource_ref || null;
      });
    } catch { bound = null; }
    if (!bound || !WID.test(bound)) {
      // Grandfathered / unmanaged workspace: the local in-process worker owns it, as it always has.
      return { mode: "LOCAL", workerId: null, assignable: true, reason: ASSIGNMENT_REASONS.LOCAL };
    }
    let a = { assignable: false, reason: ASSIGNMENT_REASONS.OFFLINE };
    try { a = await persistence.tenantTransaction(wsId, (c) => registry.assignableCore(c, wsId, bound)); }
    catch { a = { assignable: false, reason: ASSIGNMENT_REASONS.OFFLINE }; }
    // A worker whose row says "online" but whose socket is gone cannot be handed an offer: the offer
    // would sit undelivered until it expired. Connectivity is checked against the live hub session.
    if (a.assignable && !isConnected(bound)) a = { assignable: false, reason: ASSIGNMENT_REASONS.DISCONNECTED };
    return { mode: "REMOTE", workerId: bound, assignable: a.assignable === true, reason: a.reason || ASSIGNMENT_REASONS.READY };
  }

  async function resolve(wsId) {
    const hit = cache.get(wsId);
    if (hit && (now() - hit.at) < cacheMs) return hit.value;
    const value = await resolveUncached(wsId);
    cache.set(wsId, { at: now(), value });
    return value;
  }

  function invalidate(wsId = null) { if (wsId) cache.delete(wsId); else cache.clear(); }

  // Bind / unbind the dedicated worker for a workspace. Binding is globally unique, so attaching a
  // worker that already serves another tenant fails with E_RESOURCE_ALREADY_BOUND — never silently.
  async function bindDedicatedWorker(wsId, workerId, { label = null } = {}) {
    if (!WID.test(workerId)) throw assignErr("E_WORKER_NOT_FOUND", "worker id invalid");
    // Commit-then-signal: the persistence adapter preserves only a DomainError and remaps everything else,
    // so a coded rejection is returned as a marker and thrown AFTER the transaction (the same pattern
    // ownership.safeReoffer and the pairing service use).
    const out = await persistence.tenantTransaction(wsId, async (c) => {
      // The worker must belong to THIS workspace (pairing put it there); a foreign worker id is
      // invisible under RLS and therefore refused.
      const w = (await c.query("SELECT id FROM workers WHERE workspace_id=$1 AND id=$2", [wsId, workerId])).rows[0];
      if (!w) return { __reject: "E_WORKER_NOT_FOUND" };
      const existing = (await c.query("SELECT id, workspace_id, status FROM workspace_resources WHERE resource_type='WORKER' AND resource_ref=$1", [workerId])).rows[0];
      if (existing) {
        if (existing.status !== "ACTIVE") await c.query("UPDATE workspace_resources SET status='ACTIVE' WHERE id=$1", [existing.id]);
        return { bound: true, idempotent: true };
      }
      try {
        await c.query(
          "INSERT INTO workspace_resources (id, workspace_id, resource_type, resource_ref, status, label) VALUES ($1,$2,'WORKER',$3,'ACTIVE',$4)",
          [`wsrc_${cryptoUlid()}`, wsId, workerId, label]);
      } catch (e) {
        if (e && e.code === "23505") return { __reject: "E_RESOURCE_ALREADY_BOUND" };
        throw e;
      }
      return { bound: true, idempotent: false };
    });
    if (out && out.__reject) throw assignErr(out.__reject, "dedicated worker binding refused");
    invalidate(wsId);
    // Bind time is the RIGHT time to hand the workspace project to the dedicated worker: it happens at
    // onboarding, before any attempt exists, so the pipeline never has to migrate an affinity out from under
    // unresolved work. Best-effort here; requestStart re-asserts it (idempotently) at dispatch.
    if (typeof assignProjectAffinityAtBind === "function") { try { await assignProjectAffinityAtBind(wsId, workerId); } catch { /* surfaced later as a blocked dispatch */ } }
    try { logger?.info?.("REMOTE_WORKER_BOUND", { workspaceId: wsId, workerId }); } catch { /* */ }
    return out;
  }

  async function unbindDedicatedWorker(wsId, workerId) {
    const out = await persistence.tenantTransaction(wsId, async (c) => {
      const r = await c.query("DELETE FROM workspace_resources WHERE resource_type='WORKER' AND resource_ref=$1 RETURNING id", [workerId]);
      return { unbound: r.rowCount > 0 };
    });
    invalidate(wsId);
    return out;
  }

  return Object.freeze({ resolve, resolveUncached, invalidate, bindDedicatedWorker, unbindDedicatedWorker, isRemoteDeliveryEnabled: () => remoteDeliveryEnabled === true });
}

// Local ULID mint (the control-plane id helper lives behind the persistence layer; assignment must not
// import it to stay usable from the worker runtime without pulling in the repository graph).
function cryptoUlid() {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let time = Date.now(), timeChars = "";
  for (let i = 0; i < 10; i += 1) { timeChars = ALPHABET[time % 32] + timeChars; time = Math.floor(time / 32); }
  let rand = "";
  for (let i = 0; i < 16; i += 1) rand += ALPHABET[bytes[i] % 32];
  return (timeChars + rand).slice(0, 26);
}
