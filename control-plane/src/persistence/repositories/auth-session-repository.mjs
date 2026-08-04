// P0 Step 5C.21 — opaque Studio session repository (user_sessions). DISTINCT from the worker
// connection-session repository. A session id is a high-entropy random token; the DB stores only its
// sha256 hash + a separate csrf hash — the plaintext token lives only in the (future) __Host-avc_studio_
// session cookie. Resolution BY TOKEN happens before any user context exists, so it goes through the
// cp_auth_session_resolve SECURITY DEFINER (0022) which reads exactly one row; every other operation is
// app.current_user-RLS'd. Validity = not revoked AND now < idle-expiry AND now < absolute-expiry
// (fail-closed). Rotation revokes the old row and mints a new one in the same transaction.

import { newId } from "../ids.mjs";
import { authError } from "../../auth/auth-errors.mjs";

function requireClient(client) { if (!client || typeof client.query !== "function") throw authError("AUTH_CONTEXT_REQUIRED", "repository requires a transaction client"); }
const one = (r) => (r.rows[0] ?? null);

// Non-secret session projection (NEVER the token hash or csrf hash).
function mapSafeSession(row, currentId = null) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, activeWorkspaceId: row.active_workspace_id || null,
    issuedAt: row.created_at, lastSeenAt: row.last_seen_at || null,
    idleExpiresAt: row.expires_at, absoluteExpiresAt: row.absolute_expires_at || null,
    authenticatedWithMfa: Boolean(row.mfa_authenticated_at), authTime: row.mfa_authenticated_at || null,
    createdIp: row.ip_address || null, userAgent: row.user_agent || null,
    authStrength: row.auth_strength || null,
    revokedAt: row.revoked_at || null, revokedReason: row.revoked_reason || null,
    current: currentId != null && row.id === currentId
  };
}

export const userSessionRepository = {
  // Create a session (requires app.current_user == userId). Caller passes pre-hashed token/csrf; expiries
  // are absolute timestamps the caller computed. Returns only the session id + safe metadata.
  async createSession(client, { userId, tokenHash, csrfHash = null, activeWorkspaceId = null, idleExpiresAt, absoluteExpiresAt, mfaAuthenticatedAt = null, ipAddress = null, userAgent = null, rotatedFromId = null, authStrength = null } = {}) {
    requireClient(client);
    if (!userId || !tokenHash || !idleExpiresAt || !absoluteExpiresAt) throw authError("AUTH_INVALID_ARGUMENT", "userId/tokenHash/expiries required");
    const id = newId("sess");
    const r = await client.query(
      `INSERT INTO user_sessions
        (id,user_id,token_hash,csrf_hash,active_workspace_id,expires_at,absolute_expires_at,last_seen_at,mfa_authenticated_at,ip_address,user_agent,rotated_from_id,auth_strength)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12)
       RETURNING id,user_id,active_workspace_id,created_at,last_seen_at,expires_at,absolute_expires_at,mfa_authenticated_at,ip_address,user_agent,revoked_at,revoked_reason`,
      [id, userId, tokenHash, csrfHash, activeWorkspaceId, idleExpiresAt, absoluteExpiresAt, mfaAuthenticatedAt, ipAddress, userAgent && String(userAgent).slice(0, 400), rotatedFromId, authStrength]
    );
    return mapSafeSession(one(r));
  },

  // Pre-context resolve by token hash (SECURITY DEFINER). Returns { ok, session } with a validity verdict.
  async resolveActiveSession(client, tokenHash, { nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query("SELECT * FROM cp_auth_session_resolve($1)", [tokenHash]);
    const row = one(r);
    if (!row) return { ok: false, code: "AUTH_SESSION_INVALID" };
    const now = new Date(nowMs).getTime();
    if (row.revoked_at) return { ok: false, code: "AUTH_SESSION_REVOKED", userId: row.user_id };
    if (row.absolute_expires_at && new Date(row.absolute_expires_at).getTime() <= now) return { ok: false, code: "AUTH_SESSION_EXPIRED", userId: row.user_id };
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) return { ok: false, code: "AUTH_SESSION_EXPIRED", userId: row.user_id };
    return { ok: true, session: {
      id: row.id, userId: row.user_id, activeWorkspaceId: row.active_workspace_id || null,
      idleExpiresAt: row.expires_at, absoluteExpiresAt: row.absolute_expires_at,
      lastSeenAt: row.last_seen_at, authenticatedWithMfa: Boolean(row.mfa_authenticated_at),
      // P0 Step 5C.29 §Q1: surface the raw MFA timestamp + strength (server-resolved, non-secret) so the
      // Gateway-PDP path (resolveAuthorization) can derive strong-auth correctly. auth_strength is present
      // once 0031 is applied; the coalesce keeps this correct against a pre-0031 schema (fail-safe: an MFA
      // session with no strength column still reports MFA_TOTP, a password session reports PASSWORD).
      mfaAuthenticatedAt: row.mfa_authenticated_at || null,
      authStrength: row.auth_strength || (row.mfa_authenticated_at ? "MFA_TOTP" : "PASSWORD"),
      csrfHash: row.csrf_hash || null
    } };
  },

  // Throttled idle-expiry bump (requires app.current_user). Extends the idle deadline; never past absolute.
  async touchLastSeen(client, { sessionId, userId, idleExpiresAt, throttleMs = 60_000, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      `UPDATE user_sessions SET last_seen_at=now(), expires_at=LEAST($3, absolute_expires_at)
       WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL
         AND (last_seen_at IS NULL OR last_seen_at < (to_timestamp($4/1000.0) - ($5 || ' milliseconds')::interval))
       RETURNING id`,
      [sessionId, userId, idleExpiresAt, nowMs, throttleMs]
    );
    return Boolean(one(r));
  },

  // Atomic rotation: revoke the old session and mint a new one (rotated_from lineage) in one txn. The new
  // session is minted ONLY if THIS call won the revoke (the conditional UPDATE flipped revoked_at) — so two
  // concurrent rotations of the same session yield exactly one new session; the loser gets null (the row
  // lock on the old session serializes them). Returns the new safe session, or null if it lost the race.
  async rotateSession(client, { oldSessionId, userId, newTokenHash, newCsrfHash = null, activeWorkspaceId = null, idleExpiresAt, absoluteExpiresAt, mfaAuthenticatedAt = null, ipAddress = null, userAgent = null, reason = "ROTATED" } = {}) {
    requireClient(client);
    const rev = await client.query("UPDATE user_sessions SET revoked_at=now(), revoked_reason=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id", [oldSessionId, userId, reason]);
    if (!one(rev)) return null; // lost the race (already revoked/rotated) — caller must NOT issue a new session
    return userSessionRepository.createSession(client, { userId, tokenHash: newTokenHash, csrfHash: newCsrfHash, activeWorkspaceId, idleExpiresAt, absoluteExpiresAt, mfaAuthenticatedAt, ipAddress, userAgent, rotatedFromId: oldSessionId });
  },

  async revokeSession(client, { sessionId, userId, reason = "LOGOUT" } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE user_sessions SET revoked_at=now(), revoked_reason=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id", [sessionId, userId, reason]);
    return Boolean(one(r));
  },

  async revokeAllSessions(client, userId, { reason = "LOGOUT_ALL" } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE user_sessions SET revoked_at=now(), revoked_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL RETURNING id", [userId, reason]);
    return r.rows.length;
  },

  // Admin-initiated revoke of ANOTHER user's sessions (via the SECURITY DEFINER; the actor's app.current_user
  // is not the target). The service MUST authorize (OWNER/ADMIN) before calling.
  async adminRevokeAllSessions(client, targetUserId, { reason = "ADMIN_REVOKED" } = {}) {
    requireClient(client);
    const r = await client.query("SELECT cp_auth_admin_revoke_sessions($1,$2) AS n", [targetUserId, reason]);
    return one(r).n;
  },

  async revokeAllExceptCurrent(client, { userId, keepSessionId, reason = "LOGOUT_OTHERS" } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE user_sessions SET revoked_at=now(), revoked_reason=$3 WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL RETURNING id", [userId, keepSessionId, reason]);
    return r.rows.length;
  },

  // Bump the active workspace / role on a session (e.g. switchWorkspace) — caller should ALSO rotate.
  async setActiveWorkspace(client, { sessionId, userId, activeWorkspaceId } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE user_sessions SET active_workspace_id=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id", [sessionId, userId, activeWorkspaceId]);
    if (!one(r)) throw authError("AUTH_SESSION_INVALID", "session not found");
    return true;
  },

  async listSafeSessions(client, userId, { currentSessionId = null, includeRevoked = false } = {}) {
    requireClient(client);
    const r = await client.query(
      `SELECT id,user_id,active_workspace_id,created_at,last_seen_at,expires_at,absolute_expires_at,mfa_authenticated_at,ip_address,user_agent,auth_strength,revoked_at,revoked_reason
       FROM user_sessions WHERE user_id=$1 ${includeRevoked ? "" : "AND revoked_at IS NULL"} ORDER BY created_at DESC LIMIT 200`,
      [userId]
    );
    return r.rows.map((row) => mapSafeSession(row, currentSessionId));
  },

  // Maintenance: hard-delete long-expired/revoked rows (no context; runs on a sweep). Bounded.
  async cleanupExpired(client, { olderThanMs = Date.now() - 30 * 24 * 3600_000 } = {}) {
    requireClient(client);
    const r = await client.query("DELETE FROM user_sessions WHERE (revoked_at IS NOT NULL OR absolute_expires_at < to_timestamp($1/1000.0)) AND created_at < to_timestamp($1/1000.0) RETURNING id", [olderThanMs]);
    return r.rows.length;
  }
};
