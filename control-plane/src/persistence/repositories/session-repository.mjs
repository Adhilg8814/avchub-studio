// P0 Step 5C.4 — worker connection-session repository (Gateway persistence).
//
// Client-taking, workspace-scoped, parameterized SQL only. PostgreSQL is the authoritative
// session state across Gateway instances and restarts; the in-memory socket registry is only a
// local transport index. The single-ACTIVE-session-per-worker invariant is guaranteed by the
// worker_sessions_one_active_uq partial index (0004): supersede-then-insert inside ONE txn.
//
// Stores NO plaintext credential / resume token / Authorization header / IP: credential_id is a
// verifier-row id, resume_token_hash is a verifier only, remote_summary is a coarse label.

import { newId } from "../ids.mjs";
import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";

function requireClient(client) {
  if (!client || typeof client.query !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "session repository requires a transaction client");
}
const one = (r) => (r.rows[0] ?? null);

export const sessionRepository = {
  // Transactional supersede + create (§8). Locks the worker row to serialize concurrent
  // reconnects; supersedes ANY existing ACTIVE session for the worker (across instances);
  // inserts the new ACTIVE session with an incremented connection_epoch. Returns
  // { session, supersededSessionId, supersededGatewayInstance } so the caller can close the old
  // LOCAL socket (only if it owns it). The LAST writer wins → exactly one ACTIVE session.
  async claimSession(client, workspaceId, { workerId, gatewayInstance, resumeTokenHash = null, presentedResumeHash = null, resumeNotBeforeIso = null, credentialId = null, protocolVersion = null, clientVersion = null, remoteSummary = null }) {
    requireClient(client);
    // Serialize concurrent reconnects for this worker.
    const w = one(await client.query("SELECT id FROM workers WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, workerId]));
    if (!w) throw domainError(DOMAIN_ERRORS.E_WORKER_NOT_FOUND, "worker not found");

    const newSessionId = newId("sess");
    const prev = one(await client.query(
      "SELECT id, gateway_instance, connection_epoch, resume_token_hash, connected_at FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE' FOR UPDATE",
      [workspaceId, workerId]));
    // Resume correlation: the presented token must match the session being SUPERSEDED (rotation
    // means an old/replayed token can never match a newer prev session), within its TTL window.
    let resumed = false;
    if (prev && presentedResumeHash && prev.resume_token_hash === presentedResumeHash) {
      resumed = !resumeNotBeforeIso || (prev.connected_at && new Date(prev.connected_at).getTime() >= new Date(resumeNotBeforeIso).getTime());
    }
    let epoch = 0, supersededSessionId = null, supersededGatewayInstance = null;
    if (prev) {
      epoch = (prev.connection_epoch ?? 0) + 1;
      supersededSessionId = prev.id;
      supersededGatewayInstance = prev.gateway_instance;
      await client.query(
        `UPDATE worker_connection_sessions
           SET status='SUPERSEDED', superseded_by_session_id=$3, disconnected_at=now(), disconnect_reason='SESSION_SUPERSEDED'
         WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, prev.id, newSessionId]);
    }
    const session = one(await client.query(
      `INSERT INTO worker_connection_sessions
         (id, workspace_id, worker_id, gateway_instance, session_id, resume_token_hash, status,
          connection_epoch, credential_id, protocol_version, client_version, remote_summary,
          connected_at, authenticated_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$1,$5,'ACTIVE',$6,$7,$8,$9,$10, now(), now(), now()) RETURNING *`,
      [newSessionId, workspaceId, workerId, gatewayInstance, resumeTokenHash, epoch, credentialId, protocolVersion, clientVersion, remoteSummary]));
    // Reflect connectivity on the worker row (health starts ONLINE for the new connection).
    await client.query("UPDATE workers SET status='ONLINE', last_seen_at=now() WHERE workspace_id=$1 AND id=$2 AND status <> 'REVOKED'", [workspaceId, workerId]);
    return { session, supersededSessionId, supersededGatewayInstance, resumed };
  },

  async getById(client, workspaceId, sessionId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM worker_connection_sessions WHERE workspace_id=$1 AND id=$2", [workspaceId, sessionId]));
  },

  // Fence a session as the CURRENT owner: ACTIVE + matching connection_epoch (+ optionally
  // gateway_instance). Returns the row or null (stale/superseded/foreign).
  async getCurrent(client, workspaceId, sessionId, { epoch = null, gatewayInstance = null } = {}) {
    requireClient(client);
    const r = one(await client.query(
      "SELECT * FROM worker_connection_sessions WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE'", [workspaceId, sessionId]));
    if (!r) return null;
    if (epoch != null && r.connection_epoch !== epoch) return null;
    if (gatewayInstance != null && r.gateway_instance !== gatewayInstance) return null;
    return r;
  },

  // Heartbeat: only the CURRENT fenced session may refresh liveness + return health to ONLINE.
  async heartbeat(client, workspaceId, sessionId, epoch) {
    requireClient(client);
    const r = await client.query(
      `UPDATE worker_connection_sessions SET last_seen_at=now(), degraded_at=NULL
         WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' AND connection_epoch=$3 RETURNING id`,
      [workspaceId, sessionId, epoch]);
    if (r.rowCount === 1) {
      await client.query("UPDATE workers SET status='ONLINE', last_seen_at=now() WHERE workspace_id=$1 AND id=(SELECT worker_id FROM worker_connection_sessions WHERE workspace_id=$1 AND id=$2) AND status <> 'REVOKED'", [workspaceId, sessionId]);
    }
    return r.rowCount === 1;
  },

  async markDegraded(client, workspaceId, sessionId, epoch) {
    requireClient(client);
    const r = await client.query(
      `UPDATE worker_connection_sessions SET degraded_at = COALESCE(degraded_at, now())
         WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' AND connection_epoch=$3 RETURNING worker_id`,
      [workspaceId, sessionId, epoch]);
    if (r.rowCount === 1) {
      await client.query("UPDATE workers SET status='DEGRADED' WHERE workspace_id=$1 AND id=$2 AND status='ONLINE'", [workspaceId, r.rows[0].worker_id]);
    }
    return r.rowCount === 1;
  },

  // Close the CURRENT session (heartbeat offline or normal disconnect). A superseded/closed
  // session is left untouched (a newer session may be current) → a stale socket can never flip
  // the worker back OFFLINE or restore ACTIVE.
  async closeCurrent(client, workspaceId, sessionId, epoch, reason) {
    requireClient(client);
    const r = await client.query(
      `UPDATE worker_connection_sessions
         SET status='CLOSED', disconnected_at=now(), disconnect_reason=$4
       WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' AND connection_epoch=$3 RETURNING worker_id`,
      [workspaceId, sessionId, epoch, String(reason || "CLOSED").slice(0, 64)]);
    if (r.rowCount === 1) {
      await client.query("UPDATE workers SET status='OFFLINE' WHERE workspace_id=$1 AND id=$2 AND status <> 'REVOKED'", [workspaceId, r.rows[0].worker_id]);
    }
    return r.rowCount === 1;
  },

  // Resume correlation: find a recent session for this worker whose resume_token_hash matches and
  // whose issuance (connected_at) is within TTL. Returns the row or null. Used ONLY to correlate
  // prior session state — never to bypass credential authentication.
  async findResumeCandidate(client, workspaceId, workerId, resumeTokenHash, notBeforeIso) {
    requireClient(client);
    if (!resumeTokenHash) return null;
    return one(await client.query(
      `SELECT * FROM worker_connection_sessions
        WHERE workspace_id=$1 AND worker_id=$2 AND resume_token_hash=$3 AND connected_at >= $4::timestamptz
        ORDER BY connected_at DESC LIMIT 1`,
      [workspaceId, workerId, resumeTokenHash, notBeforeIso]));
  },

  // Health snapshot counts for status endpoints (safe aggregate; no payloads/ids leaked).
  async countsForInstance(client, workspaceId, gatewayInstance) {
    requireClient(client);
    return one(await client.query(
      `SELECT count(*) FILTER (WHERE status='ACTIVE') AS active
         FROM worker_connection_sessions WHERE workspace_id=$1 AND gateway_instance=$2`,
      [workspaceId, gatewayInstance]));
  }
};

// Ops-enumerator (BYPASSRLS, READ ONLY) credential authentication lookup. Runs BEFORE the
// workspace is known, so it cannot use the RLS-scoped tenant pool. Reads verifier rows only.
export async function lookupCredentialByVerifier(opsClient, verifierHex) {
  const r = await opsClient.query(
    `SELECT wc.id AS credential_id, wc.worker_id, wc.workspace_id, wc.status AS cred_status, wc.expires_at,
            w.status AS worker_status, w.protocol_version
       FROM worker_credentials wc
       JOIN workers w ON w.workspace_id = wc.workspace_id AND w.id = wc.worker_id
      WHERE wc.credential_hash = $1 AND wc.status = 'ACTIVE'
      LIMIT 1`, [verifierHex]);
  return r.rows[0] ?? null;
}
