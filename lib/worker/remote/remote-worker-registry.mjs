// P0 Step 5C.31 — durable remote-worker registry (worker_runtime_state, migration 0036).
//
// Replaces the 5C.28 JSON flag file. Approval, draining, reported version/capabilities, readiness and
// liveness now live in PostgreSQL, workspace-scoped under FORCE RLS like every other tenant table, so:
//
//  * an approval decision can be read INSIDE the same transaction that hands out an offer (no
//    read-then-act race between "the owner just clicked Drain" and "the hub just offered a job");
//  * a restart cannot lose or resurrect an operational decision;
//  * the Workers UI shows the same truth the scheduler acts on, not a second copy of it.
//
// Nothing here stores a secret: no credential, no resume token, no cookie, no absolute path. The
// worker's self-reported metadata is advisory (recorded for display + compatibility checks) and never
// becomes authority — authority is the credential (identity) plus the owner's Enable (permission).

import { DELIVERY_PROTOCOL_VERSION, SUPPORTED_DELIVERY_PROTOCOL_VERSIONS, ONLINE_THRESHOLD_MS } from "./remote-protocol.mjs";

const WID = /^wrk_[0-9A-HJKMNP-TV-Z]{26}$/u;

function clampStr(v, max) { return typeof v === "string" && v.length ? v.slice(0, max) : null; }

// Owner-facing status categories. Deliberately NOT collapsed to ONLINE/OFFLINE — an operator has to be
// able to tell "the machine is off" from "the machine is up but Cloak is missing".
export const REMOTE_WORKER_STATUS = Object.freeze([
  "PENDING", "DRAINING", "ONLINE", "OFFLINE", "BUSY", "UPDATING", "INCOMPATIBLE", "REVOKED", "NEEDS_ATTENTION"
]);

export function deriveWorkerStatus(row, state, nowMs) {
  if (!row) return "OFFLINE";
  if (row.status === "REVOKED" || state?.removed) return "REVOKED";
  const hb = state?.last_heartbeat_at ? Date.parse(state.last_heartbeat_at) : null;
  const fresh = Number.isFinite(hb) && (nowMs - hb) <= ONLINE_THRESHOLD_MS;
  if (state?.incompatible) return "INCOMPATIBLE";
  if (state?.updating) return "UPDATING";
  // Not yet approved by the owner = PENDING (it has never been allowed to work), vs DRAINING which is
  // an explicit "stop taking new work" on a previously approved worker.
  if (!state?.approved && !state?.drain_requested_at) return "PENDING";
  if (state?.draining) return "DRAINING";
  if (!fresh) return "OFFLINE";
  if (state?.current_job_id) return "BUSY";
  if (state?.cloak_ready === false || state?.interactive_ready === false || state?.ffmpeg_ready === false) return "NEEDS_ATTENTION";
  return "ONLINE";
}

export function createRemoteWorkerRegistry({ persistence, now = () => Date.now() } = {}) {
  if (!persistence || typeof persistence.tenantTransaction !== "function") {
    throw new TypeError("createRemoteWorkerRegistry requires a persistence adapter");
  }
  const tx = (wsId, fn) => persistence.tenantTransaction(wsId, fn);

  // Create-if-absent. A worker row exists (pairing created it) before any runtime state does.
  async function ensureRowCore(client, wsId, workerId) {
    await client.query(
      `INSERT INTO worker_runtime_state (workspace_id, worker_id) VALUES ($1,$2)
       ON CONFLICT (workspace_id, worker_id) DO NOTHING`, [wsId, workerId]);
    return (await client.query("SELECT * FROM worker_runtime_state WHERE workspace_id=$1 AND worker_id=$2", [wsId, workerId])).rows[0];
  }

  async function ensureRow(wsId, workerId) {
    if (!WID.test(workerId)) throw Object.assign(new Error("worker not found"), { code: "E_WORKER_NOT_FOUND" });
    return tx(wsId, (c) => ensureRowCore(c, wsId, workerId));
  }

  async function get(wsId, workerId) {
    return tx(wsId, async (c) => (await c.query("SELECT * FROM worker_runtime_state WHERE workspace_id=$1 AND worker_id=$2", [wsId, workerId])).rows[0] || null);
  }

  // Full owner-facing projection: the pairing registry row joined with the durable runtime state.
  async function list(wsId, { includeRemoved = false } = {}) {
    return tx(wsId, async (c) => {
      const rows = (await c.query(
        `SELECT w.id, w.name, w.platform, w.os_version, w.architecture, w.worker_version, w.protocol_version,
                w.status, w.last_seen_at, w.paired_at, w.revoked_at, w.created_at,
                s.*
           FROM workers w LEFT JOIN worker_runtime_state s
             ON s.workspace_id = w.workspace_id AND s.worker_id = w.id
          WHERE w.workspace_id = $1 ORDER BY w.created_at ASC`, [wsId])).rows;
      const t = now();
      return rows
        .filter((r) => includeRemoved || r.removed !== true)
        .map((r) => projectRow(r, t));
    });
  }

  function projectRow(r, nowMs) {
    const state = r.worker_id ? r : null;
    return Object.freeze({
      workerId: r.id,
      workerIdRedacted: typeof r.id === "string" && r.id.length > 8 ? `${r.id.slice(0, 4)}…${r.id.slice(-4)}` : "wrk_…",
      displayName: r.display_name || r.name || null,
      status: deriveWorkerStatus(r, state, nowMs),
      approved: r.approved === true,
      draining: r.draining !== false,
      removed: r.removed === true,
      platform: r.platform || null,
      osCaption: r.os_caption || r.os_version || null,
      architecture: r.architecture || null,
      bundleVersion: r.bundle_version || r.worker_version || null,
      buildCommit: r.build_commit || null,
      deliveryProtocolVersion: r.delivery_protocol_version ?? null,
      protocolCompatible: r.delivery_protocol_version == null
        ? null
        : SUPPORTED_DELIVERY_PROTOCOL_VERSIONS.includes(r.delivery_protocol_version),
      serverProtocolVersion: DELIVERY_PROTOCOL_VERSION,
      capabilities: r.capabilities || null,
      cloakReady: r.cloak_ready ?? null,
      ffmpegReady: r.ffmpeg_ready ?? null,
      interactiveReady: r.interactive_ready ?? null,
      providerReady: r.provider_ready ?? null,
      lastHeartbeatAt: r.last_heartbeat_at || null,
      lastSeenAt: r.last_heartbeat_at || r.last_seen_at || null,
      pairedAt: r.paired_at || null,
      currentJobId: r.current_job_id || null,
      currentAttemptId: r.current_attempt_id || null,
      leaseExpiresAt: r.current_lease_expires_at || null,
      updateAvailable: r.update_available === true,
      lastSafeError: r.last_safe_error || null,
      revokedAt: r.revoked_at || null
    });
  }

  // Record a HELLO: identity/metadata + readiness snapshot. Never changes approval or draining —
  // a worker cannot promote itself by reconnecting.
  async function recordHello(wsId, workerId, info = {}) {
    const caps = info.capabilities || null;
    const incompatible = !SUPPORTED_DELIVERY_PROTOCOL_VERSIONS.includes(info.deliveryProtocolVersion);
    return tx(wsId, async (c) => {
      await ensureRowCore(c, wsId, workerId);
      const r = await c.query(
        `UPDATE worker_runtime_state SET
           bundle_version=$3, build_commit=$4, delivery_protocol_version=$5, os_caption=$6, architecture=$7,
           capabilities=$8, cloak_ready=$9, ffmpeg_ready=$10, interactive_ready=$11, provider_ready=$12,
           connected_session_id=$13, incompatible=$14, last_hello_at=now(), last_heartbeat_at=now()
         WHERE workspace_id=$1 AND worker_id=$2 RETURNING *`,
        [wsId, workerId,
          clampStr(info.bundleVersion, 40), clampStr(info.buildCommit, 40),
          Number.isInteger(info.deliveryProtocolVersion) ? info.deliveryProtocolVersion : null,
          clampStr(info.osCaption, 120), clampStr(info.architecture, 32),
          caps ? JSON.stringify(caps) : null,
          typeof caps?.cloakReady === "boolean" ? caps.cloakReady : null,
          typeof caps?.ffmpegReady === "boolean" ? caps.ffmpegReady : null,
          typeof caps?.interactiveSession === "boolean" ? caps.interactiveSession : null,
          typeof caps?.providerReady === "boolean" ? caps.providerReady : null,
          clampStr(info.sessionId, 80), incompatible]);
      // Mirror liveness onto the pairing registry row so existing surfaces stay consistent.
      await c.query("UPDATE workers SET last_seen_at=now(), worker_version=COALESCE($3, worker_version), architecture=COALESCE($4, architecture), os_version=COALESCE($5, os_version) WHERE workspace_id=$1 AND id=$2 AND status <> 'REVOKED'",
        [wsId, workerId, clampStr(info.bundleVersion, 64), clampStr(info.architecture, 64), clampStr(info.osCaption, 128)]);
      return r.rows[0];
    });
  }

  async function recordHeartbeat(wsId, workerId, patch = {}) {
    return tx(wsId, async (c) => {
      await c.query(
        `UPDATE worker_runtime_state SET last_heartbeat_at=now(),
           cloak_ready=COALESCE($3, cloak_ready), ffmpeg_ready=COALESCE($4, ffmpeg_ready),
           interactive_ready=COALESCE($5, interactive_ready), provider_ready=COALESCE($6, provider_ready)
         WHERE workspace_id=$1 AND worker_id=$2`,
        [wsId, workerId,
          typeof patch.cloakReady === "boolean" ? patch.cloakReady : null,
          typeof patch.ffmpegReady === "boolean" ? patch.ffmpegReady : null,
          typeof patch.interactiveSession === "boolean" ? patch.interactiveSession : null,
          typeof patch.providerReady === "boolean" ? patch.providerReady : null]);
      await c.query("UPDATE workers SET last_seen_at=now() WHERE workspace_id=$1 AND id=$2 AND status <> 'REVOKED'", [wsId, workerId]);
      return true;
    });
  }

  async function setCurrentWork(wsId, workerId, { jobId = null, attemptId = null, leaseExpiresAt = null } = {}) {
    return tx(wsId, async (c) => {
      await c.query(
        "UPDATE worker_runtime_state SET current_job_id=$3, current_attempt_id=$4, current_lease_expires_at=$5 WHERE workspace_id=$1 AND worker_id=$2",
        [wsId, workerId, jobId, attemptId, leaseExpiresAt]);
      return true;
    });
  }

  async function markDisconnected(wsId, workerId) {
    return tx(wsId, async (c) => {
      await c.query("UPDATE worker_runtime_state SET connected_session_id=NULL WHERE workspace_id=$1 AND worker_id=$2", [wsId, workerId]);
      return true;
    });
  }

  async function recordSafeError(wsId, workerId, code) {
    if (typeof code !== "string" || !/^[A-Z0-9_]{3,64}$/.test(code)) return false;
    return tx(wsId, async (c) => {
      await c.query("UPDATE worker_runtime_state SET last_safe_error=$3 WHERE workspace_id=$1 AND worker_id=$2", [wsId, workerId, code]);
      return true;
    });
  }

  // ---- owner actions (each is a durable, audited decision) ----
  async function approve(wsId, workerId) {
    return tx(wsId, async (c) => {
      await ensureRowCore(c, wsId, workerId);
      const r = await c.query(
        "UPDATE worker_runtime_state SET approved=true, draining=false, removed=false, drain_requested_at=NULL, drained_at=NULL WHERE workspace_id=$1 AND worker_id=$2 RETURNING *", [wsId, workerId]);
      return r.rows[0];
    });
  }
  async function drain(wsId, workerId) {
    return tx(wsId, async (c) => {
      await ensureRowCore(c, wsId, workerId);
      const r = await c.query(
        "UPDATE worker_runtime_state SET draining=true, drain_requested_at=COALESCE(drain_requested_at, now()) WHERE workspace_id=$1 AND worker_id=$2 RETURNING *", [wsId, workerId]);
      return r.rows[0];
    });
  }
  async function markDrained(wsId, workerId) {
    return tx(wsId, async (c) => {
      const r = await c.query(
        "UPDATE worker_runtime_state SET drained_at=now() WHERE workspace_id=$1 AND worker_id=$2 AND draining RETURNING *", [wsId, workerId]);
      return r.rows[0] || null;
    });
  }
  async function markRemoved(wsId, workerId) {
    return tx(wsId, async (c) => {
      await ensureRowCore(c, wsId, workerId);
      const r = await c.query(
        "UPDATE worker_runtime_state SET removed=true, approved=false, draining=true WHERE workspace_id=$1 AND worker_id=$2 RETURNING *", [wsId, workerId]);
      return r.rows[0];
    });
  }
  async function rename(wsId, workerId, name) {
    const clean = String(name || "").trim().slice(0, 80);
    if (!clean) throw Object.assign(new Error("a worker name is required"), { code: "E_WORKER_NAME" });
    return tx(wsId, async (c) => {
      await ensureRowCore(c, wsId, workerId);
      const r = await c.query("UPDATE worker_runtime_state SET display_name=$3 WHERE workspace_id=$1 AND worker_id=$2 RETURNING *", [wsId, workerId, clean]);
      return r.rows[0];
    });
  }
  async function setUpdateAvailable(wsId, workerId, available) {
    return tx(wsId, async (c) => {
      await ensureRowCore(c, wsId, workerId);
      await c.query("UPDATE worker_runtime_state SET update_available=$3 WHERE workspace_id=$1 AND worker_id=$2", [wsId, workerId, available === true]);
      return true;
    });
  }
  async function setUpdating(wsId, workerId, updating) {
    return tx(wsId, async (c) => {
      await ensureRowCore(c, wsId, workerId);
      await c.query("UPDATE worker_runtime_state SET updating=$3 WHERE workspace_id=$1 AND worker_id=$2", [wsId, workerId, updating === true]);
      return true;
    });
  }

  return Object.freeze({
    ensureRow, get, list, projectRow,
    recordHello, recordHeartbeat, recordSafeError, setCurrentWork, markDisconnected,
    approve, drain, markDrained, markRemoved, rename, setUpdateAvailable, setUpdating,
    // Transaction-scoped helper for callers that must read approval INSIDE their own txn.
    assignableCore: async (client, wsId, workerId) => {
      const r = (await client.query(
        `SELECT s.approved, s.draining, s.removed, s.incompatible, s.updating, s.last_heartbeat_at, w.status
           FROM workers w LEFT JOIN worker_runtime_state s ON s.workspace_id=w.workspace_id AND s.worker_id=w.id
          WHERE w.workspace_id=$1 AND w.id=$2`, [wsId, workerId])).rows[0];
      if (!r) return { assignable: false, reason: "NOT_FOUND" };
      if (r.status === "REVOKED") return { assignable: false, reason: "REVOKED" };
      if (r.removed) return { assignable: false, reason: "REMOVED" };
      if (!r.approved) return { assignable: false, reason: "NOT_APPROVED" };
      if (r.draining) return { assignable: false, reason: "DRAINING" };
      if (r.incompatible) return { assignable: false, reason: "INCOMPATIBLE" };
      if (r.updating) return { assignable: false, reason: "UPDATING" };
      const hb = r.last_heartbeat_at ? Date.parse(r.last_heartbeat_at) : null;
      if (!Number.isFinite(hb) || (now() - hb) > ONLINE_THRESHOLD_MS) return { assignable: false, reason: "OFFLINE" };
      return { assignable: true, reason: "READY" };
    }
  });
}
