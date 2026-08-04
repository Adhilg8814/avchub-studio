// P0 Step 5C.21 — trusted, transaction-scoped database auth context (§2).
//
// The RLS predicates on the auth tables read current_setting('app.current_user' | 'app.current_workspace'
// | 'app.current_role' | 'app.request_id'). These GUCs are set with set_config(..., is_local => true) so
// they are TRANSACTION-LOCAL: they auto-reset on COMMIT/ROLLBACK and can NEVER leak into the next pooled
// checkout. Only the SERVER sets them, only from values it has itself resolved (a session it verified, a
// membership it checked) — a workspaceId/role/userId presented by a client is NEVER trusted here.
//
// Two use shapes:
//   * setAuthContext(client, ctx) — inside an existing transaction() the service sets the context AFTER it
//     resolves the identity (e.g. mid-login, once the user row is found). Fail-closed: any unset GUC makes
//     the RLS predicate NULL => zero rows.
//   * withAuthContext(persistence, ctx, fn) — a convenience wrapper that opens a tenant transaction() and
//     applies the context up front (request-time flows where the identity is already known).

import { validateId } from "../../../lib/protocol/ids.mjs";
import { AUTH_ROLE_SET, authError } from "./auth-errors.mjs";

export async function setAuthContext(client, { userId = null, workspaceId = null, role = null, requestId = null } = {}) {
  if (!client || typeof client.query !== "function") throw authError("AUTH_CONTEXT_REQUIRED", "a transaction client is required");
  if (userId != null) {
    if (!validateId(userId, "usr")) throw authError("AUTH_INVALID_ARGUMENT", "invalid userId");
    await client.query("SELECT set_config('app.current_user', $1, true)", [userId]);
  }
  if (workspaceId != null) {
    if (!validateId(workspaceId, "ws")) throw authError("AUTH_INVALID_ARGUMENT", "invalid workspaceId");
    await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
  }
  if (role != null) {
    if (!AUTH_ROLE_SET.has(String(role))) throw authError("AUTH_ROLE_INVALID", "invalid role");
    await client.query("SELECT set_config('app.current_role', $1, true)", [String(role)]);
  }
  if (requestId != null) {
    await client.query("SELECT set_config('app.request_id', $1, true)", [String(requestId).slice(0, 64)]);
  }
}

// Explicitly blank every auth GUC (txn-local). Used when a single transaction must switch identity (rare)
// or when a pre-auth segment must be provably context-free before touching user-scoped tables.
export async function clearAuthContext(client) {
  if (!client || typeof client.query !== "function") throw authError("AUTH_CONTEXT_REQUIRED", "a transaction client is required");
  await client.query("SELECT set_config('app.current_user','',true), set_config('app.current_workspace','',true), set_config('app.current_role','',true), set_config('app.request_id','',true)");
}

// Read back the effective context (for assertions/telemetry). Never used for authorization decisions.
export async function readAuthContext(client) {
  const r = await client.query("SELECT current_setting('app.current_user',true) u, current_setting('app.current_workspace',true) w, current_setting('app.current_role',true) r, current_setting('app.request_id',true) q");
  const row = r.rows[0] || {};
  return { userId: row.u || null, workspaceId: row.w || null, role: row.r || null, requestId: row.q || null };
}

// Open a tenant transaction and apply the (server-resolved) context up front. For request-time flows where
// the identity is already known; the callback runs the business query under RLS bound to that identity.
export async function withAuthContext(persistence, context, fn, options = {}) {
  if (!persistence || typeof persistence.transaction !== "function") throw authError("AUTH_CONTEXT_REQUIRED", "persistence with transaction() required");
  return persistence.transaction(async (client) => {
    await setAuthContext(client, context);
    return fn(client);
  }, options);
}
