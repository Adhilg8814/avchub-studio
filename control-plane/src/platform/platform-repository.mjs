// P0 Step 5C.29 — platform-plane repository (customers / platform_admins / customer_usage_daily /
// platform_audit_events). These are NON-RLS service-mediated tables (docs/…LOCK.md §R1): the caller runs
// them inside a persistence.transaction() (no workspace context needed for the platform plane). All
// authority checks live in platform-service; this layer is pure SQL. Ids via newId (any prefix).
import { newId } from "../persistence/ids.mjs";

function one(r) { return r.rows && r.rows[0] ? r.rows[0] : null; }

export const platformRepository = {
  // Resolve the ACTIVE platform role for a user via the owner-owned SECURITY DEFINER (never workspace role).
  async resolvePlatformRole(client, userId) {
    const r = await client.query("SELECT role, status FROM cp_platform_role($1)", [userId]);
    return one(r); // { role, status } | null
  },

  async grantPlatformRole(client, { userId, role, grantedBy }) {
    const r = await client.query(
      `INSERT INTO platform_admins (user_id, role, granted_by) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET role=$2, status='ACTIVE', disabled_at=NULL, granted_by=$3, updated_at=now()
       RETURNING user_id, role, status`, [userId, role, grantedBy || null]);
    return one(r);
  },
  async disablePlatformRole(client, { userId }) {
    const r = await client.query("UPDATE platform_admins SET status='DISABLED', disabled_at=now(), updated_at=now() WHERE user_id=$1 RETURNING user_id", [userId]);
    return one(r);
  },
  async listPlatformAdmins(client) {
    return (await client.query("SELECT pa.user_id, pa.role, pa.status, pa.granted_at, u.email FROM platform_admins pa JOIN users u ON u.id=pa.user_id ORDER BY pa.granted_at")).rows;
  },

  async insertCustomer(client, { legalName, plan = "FREE", primaryOwnerUserId = null, dedicatedWorkerMode = true, status = "ACTIVE", expiresAt = null, quota = {} }) {
    const id = newId("cust");
    const q = quota || {};
    const r = await client.query(
      `INSERT INTO customers (id, legal_name, plan, primary_owner_user_id, dedicated_worker_mode, status, activated_at, expires_at,
         max_users, max_provider_accounts, max_proxies, max_active_movies, max_scenes_per_movie, max_grok_per_day, max_elevenlabs_per_day, max_queued_jobs, storage_bytes_limit)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6='ACTIVE' THEN now() ELSE NULL END, $7, $8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [id, legalName, plan, primaryOwnerUserId, dedicatedWorkerMode, status, expiresAt,
        q.maxUsers ?? null, q.maxProviderAccounts ?? null, q.maxProxies ?? null, q.maxActiveMovies ?? null, q.maxScenesPerMovie ?? null, q.maxGrokPerDay ?? null, q.maxElevenlabsPerDay ?? null, q.maxQueuedJobs ?? null, q.storageBytesLimit ?? null]);
    return one(r);
  },
  async getCustomer(client, id) { return one(await client.query("SELECT * FROM customers WHERE id=$1", [id])); },
  async listCustomers(client) { return (await client.query("SELECT * FROM customers ORDER BY created_at DESC")).rows; },
  async firstCustomer(client) { return one(await client.query("SELECT * FROM customers ORDER BY created_at LIMIT 1")); },
  async setCustomerStatus(client, { id, status, reason = null }) {
    const r = await client.query(
      `UPDATE customers SET status=$2, updated_at=now(),
         suspended_at = CASE WHEN $2='SUSPENDED' THEN now() ELSE NULL END,
         suspend_reason = CASE WHEN $2='SUSPENDED' THEN $3 ELSE NULL END,
         activated_at = CASE WHEN $2='ACTIVE' AND activated_at IS NULL THEN now() ELSE activated_at END
       WHERE id=$1 RETURNING *`, [id, status, reason]);
    return one(r);
  },
  async updateCustomerQuota(client, { id, quota, plan = null }) {
    const q = quota || {};
    const r = await client.query(
      `UPDATE customers SET updated_at=now(), plan=COALESCE($2, plan),
         max_users=$3, max_provider_accounts=$4, max_proxies=$5, max_active_movies=$6, max_scenes_per_movie=$7,
         max_grok_per_day=$8, max_elevenlabs_per_day=$9, max_queued_jobs=$10, storage_bytes_limit=$11
       WHERE id=$1 RETURNING *`,
      [id, plan, q.maxUsers ?? null, q.maxProviderAccounts ?? null, q.maxProxies ?? null, q.maxActiveMovies ?? null, q.maxScenesPerMovie ?? null, q.maxGrokPerDay ?? null, q.maxElevenlabsPerDay ?? null, q.maxQueuedJobs ?? null, q.storageBytesLimit ?? null]);
    return one(r);
  },
  async customerForWorkspace(client, workspaceId) {
    return one(await client.query("SELECT c.* FROM customers c JOIN workspaces w ON w.customer_id=c.id WHERE w.id=$1", [workspaceId]));
  },
  async linkWorkspaceCustomer(client, { workspaceId, customerId }) {
    // requires app.current_workspace == workspaceId (workspaces FORCE-RLS UPDATE) — caller sets it, OR the
    // migrator/backfill path runs owner-privileged. Returns the linked row.
    return one(await client.query("UPDATE workspaces SET customer_id=$2, updated_at=now() WHERE id=$1 RETURNING id, customer_id", [workspaceId, customerId]));
  },
  async listWorkspacesForCustomer(client, customerId) {
    return (await client.query("SELECT id, name, owner_user_id, plan, created_at FROM workspaces WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY created_at", [customerId])).rows;
  },
  async workspacesWithoutCustomer(client) {
    return (await client.query("SELECT id FROM workspaces WHERE customer_id IS NULL AND deleted_at IS NULL ORDER BY created_at")).rows;
  },

  // durable per-customer daily usage (quota ledger). increment returns the new counter value.
  async incrementUsage(client, { customerId, field, by = 1, day = null }) {
    if (!/^(grok_invocations|elevenlabs_units|jobs_enqueued)$/.test(field)) throw new Error("bad usage field");
    const id = newId("cusg");
    const r = await client.query(
      `INSERT INTO customer_usage_daily (id, customer_id, usage_date, ${field}) VALUES ($1,$2, COALESCE($4::date, current_date), $3)
       ON CONFLICT (customer_id, usage_date) DO UPDATE SET ${field}=customer_usage_daily.${field}+$3, updated_at=now()
       RETURNING ${field} AS v`, [id, customerId, by, day]);
    return one(r)?.v ?? 0;
  },
  async getUsage(client, { customerId, day = null }) {
    return one(await client.query("SELECT * FROM customer_usage_daily WHERE customer_id=$1 AND usage_date=COALESCE($2::date, current_date)", [customerId, day]));
  },

  async recordAudit(client, { actorUserId = null, actorRole = null, action, targetType = null, targetId = null, customerId = null, workspaceId = null, outcome = "OK", metadata = null, ipAddress = null }) {
    await client.query(
      `INSERT INTO platform_audit_events (id, actor_user_id, actor_role, action, target_type, target_id, customer_id, workspace_id, outcome, metadata, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId("paud"), actorUserId, actorRole, action, targetType, targetId, customerId, workspaceId, outcome, metadata ? JSON.stringify(metadata).slice(0, 16000) : null, ipAddress]);
  },
  async listAudit(client, { limit = 100, customerId = null } = {}) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    if (customerId) return (await client.query("SELECT id, actor_user_id, actor_role, action, target_type, target_id, customer_id, workspace_id, outcome, created_at FROM platform_audit_events WHERE customer_id=$1 ORDER BY created_at DESC LIMIT $2", [customerId, lim])).rows;
    return (await client.query("SELECT id, actor_user_id, actor_role, action, target_type, target_id, customer_id, workspace_id, outcome, created_at FROM platform_audit_events ORDER BY created_at DESC LIMIT $1", [lim])).rows;
  },

  // platform dashboard totals (single round-trip-ish; platform-plane reads).
  async totals(client) {
    const c = await client.query("SELECT count(*)::int total, count(*) FILTER (WHERE status='ACTIVE')::int active, count(*) FILTER (WHERE status='SUSPENDED')::int suspended, count(*) FILTER (WHERE status='EXPIRED')::int expired FROM customers");
    const w = await client.query("SELECT count(*)::int n FROM workspaces WHERE deleted_at IS NULL");
    const u = await client.query("SELECT count(*)::int n FROM users");
    return { customers: c.rows[0], workspaces: w.rows[0].n, users: u.rows[0].n };
  }
};
