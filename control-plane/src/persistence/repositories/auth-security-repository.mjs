// P0 Step 5C.21 — security accounting + audit repository (login_attempts, security_events). Global,
// service-mediated (non-RLS): login attempts are keyed by normalized identifier / IP (pre-user), and
// security_events unify the auth audit trail (a nullable user_id/workspace_id lets pre-identify events —
// e.g. a failed login for an unknown email — be recorded). All event metadata passes through redactMetadata
// so a secret can never be persisted. listSafeSecurityEvents filters server-side by the caller's own user.

import { newId } from "../ids.mjs";
import { authError } from "../../auth/auth-errors.mjs";
import { redactMetadata } from "../../auth/redact.mjs";

function requireClient(client) { if (!client || typeof client.query !== "function") throw authError("AUTH_CONTEXT_REQUIRED", "repository requires a transaction client"); }
const one = (r) => (r.rows[0] ?? null);

export const securityRepository = {
  // Record ONE login-ish attempt on a dimension (EMAIL/IP/SESSION/DEVICE). Bounded by design (append-only,
  // swept elsewhere). The identifier is never a secret (normalized email / ip / device label).
  // createdAtMs threads the SAME clock the rate-limit window read uses, so accounting stays consistent under
  // an injected clock (defaults to DB now() when omitted — i.e. production, where clock() == wall time).
  async appendLoginAttempt(client, { identifier, dimension, outcome, route, createdAtMs = null } = {}) {
    requireClient(client);
    if (!["EMAIL", "IP", "SESSION", "DEVICE"].includes(dimension)) throw authError("AUTH_INVALID_ARGUMENT", "bad dimension");
    if (!["SUCCESS", "FAILURE"].includes(outcome)) throw authError("AUTH_INVALID_ARGUMENT", "bad outcome");
    await client.query(
      "INSERT INTO login_attempts (id,identifier,dimension,outcome,route,created_at) VALUES ($1,$2,$3,$4,$5, COALESCE(to_timestamp($6/1000.0), now()))",
      [newId("latt"), String(identifier || "").slice(0, 320), dimension, outcome, String(route || "").slice(0, 64), createdAtMs]
    );
    return true;
  },

  // Decision metadata for the (later) HTTP enforcement layer: how many FAILUREs on this identifier/dimension
  // within the window, and the earliest time a next attempt is allowed given a progressive backoff. This
  // method ONLY reports — it never sleeps or blocks (§13).
  async getRateLimitState(client, { identifier, dimension, windowMs = 15 * 60_000, maxFailures = 10, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      `SELECT count(*)::int failures, max(created_at) last_at
       FROM login_attempts
       WHERE identifier=$1 AND dimension=$2 AND outcome='FAILURE' AND created_at > to_timestamp($3/1000.0)`,
      [String(identifier || "").slice(0, 320), dimension, nowMs - windowMs]
    );
    const row = one(r) || { failures: 0, last_at: null };
    const failures = row.failures || 0;
    // progressive: no delay under a soft floor, then exponential backoff capped, hard-limit at maxFailures.
    const SOFT = 3;
    const over = Math.max(0, failures - SOFT);
    const backoffMs = over === 0 ? 0 : Math.min(5 * 60_000, 1000 * 2 ** Math.min(over, 8));
    const lastAt = row.last_at ? new Date(row.last_at).getTime() : 0;
    const nextAllowedAt = failures >= maxFailures ? lastAt + windowMs : (backoffMs ? lastAt + backoffMs : nowMs);
    return {
      failures, limited: failures >= maxFailures || nextAllowedAt > nowMs,
      hardLimited: failures >= maxFailures,
      nextAllowedAt, retryAfterMs: Math.max(0, nextAllowedAt - nowMs)
    };
  },

  // Record a security/audit event. metadata is redacted (allowlist-shaped) before storage; NEVER a secret.
  async appendSecurityEvent(client, { userId = null, workspaceId = null, event, outcome = "INFO", actorUserId = null, target = null, ipAddress = null, userAgent = null, metadata = {} } = {}) {
    requireClient(client);
    if (!event || typeof event !== "string") throw authError("AUTH_INVALID_ARGUMENT", "event required");
    if (!["SUCCESS", "FAILURE", "DENY", "INFO"].includes(outcome)) throw authError("AUTH_INVALID_ARGUMENT", "bad outcome");
    const id = newId("sec");
    await client.query(
      `INSERT INTO security_events (id,user_id,workspace_id,event,outcome,actor_user_id,target,ip_address,user_agent,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, userId, workspaceId, String(event).slice(0, 64), outcome, actorUserId, target ? String(target).slice(0, 120) : null, ipAddress, userAgent && String(userAgent).slice(0, 400), JSON.stringify(redactMetadata(metadata))]
    );
    return { id };
  },

  // A user's own security events (server-side authz filter by user_id; never another user's).
  async listSafeSecurityEvents(client, userId, { limit = 100 } = {}) {
    requireClient(client);
    const r = await client.query(
      "SELECT event,outcome,target,ip_address,user_agent,metadata,created_at FROM security_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
      [userId, Math.max(1, Math.min(500, limit))]
    );
    return r.rows.map((x) => ({ event: x.event, outcome: x.outcome, target: x.target, ipAddress: x.ip_address, userAgent: x.user_agent, metadata: x.metadata, createdAt: x.created_at }));
  }
};
