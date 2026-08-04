// P0 Step 5C.29 Phase 8 — the TENANT GUARD: server-side customer lifecycle (suspension/expiration) + quota
// enforcement at the data-plane choke points (generation enqueue, movie/scene create, member invite, provider/
// proxy create). Composable: every method operates on a CALLER-supplied client so it runs INSIDE the caller's
// existing tenant transaction — a reservation and the mutation it guards commit or roll back together (a failed
// enqueue therefore rolls back its usage reservation automatically). Concurrency-safe: count-based limits take a
// per-(customer,resource) transaction advisory lock so two near-limit requests serialize (no TOCTOU); daily
// limits use a single atomic UPSERT whose WHERE guard rejects the increment that would cross the limit.
//
// Backward compatible: a workspace with NO linked customer (the existing owner, pre-backfill) is UNMANAGED —
// no lifecycle gate, no quota — so current production is unaffected. A NULL limit means unlimited. The customers
// table is platform-plane (non-RLS) and granted to cp_tenant_app, so this reads/writes it inside the workspace
// transaction without touching the workspace RLS boundary (customer_id is NEVER an RLS predicate).
import { platformRepository } from "./platform-repository.mjs";
import { newId } from "../persistence/ids.mjs";
import { DomainError } from "../persistence/domain-errors.mjs";

// The exact error categories the spec mandates. TenantQuotaError.code is one of these; safe to surface (no
// tenant data), mapped to HTTP 402/403/409 by the caller. Never carries another tenant's identifiers.
// Wire codes are E_<CATEGORY> so they flow UNCHANGED through the provider channel's safe-error filter (which
// only passes E_[A-Z0-9_] codes) and the auth-http surface. The <CATEGORY> suffix is exactly the spec's error
// category — the UI maps E_QUOTA_GROK_DAILY_EXCEEDED etc. to a localized message. No tenant data in the code.
export const TENANT_ERRORS = Object.freeze({
  WORKSPACE_SUSPENDED: "E_WORKSPACE_SUSPENDED",
  CUSTOMER_SUSPENDED: "E_CUSTOMER_SUSPENDED",
  CUSTOMER_EXPIRED: "E_CUSTOMER_EXPIRED",
  QUOTA_USERS_EXCEEDED: "E_QUOTA_USERS_EXCEEDED",
  QUOTA_PROVIDER_ACCOUNTS_EXCEEDED: "E_QUOTA_PROVIDER_ACCOUNTS_EXCEEDED",
  QUOTA_PROXIES_EXCEEDED: "E_QUOTA_PROXIES_EXCEEDED",
  QUOTA_ACTIVE_MOVIES_EXCEEDED: "E_QUOTA_ACTIVE_MOVIES_EXCEEDED",
  QUOTA_SCENES_EXCEEDED: "E_QUOTA_SCENES_EXCEEDED",
  QUOTA_QUEUED_JOBS_EXCEEDED: "E_QUOTA_QUEUED_JOBS_EXCEEDED",
  QUOTA_GROK_DAILY_EXCEEDED: "E_QUOTA_GROK_DAILY_EXCEEDED",
  QUOTA_ELEVENLABS_DAILY_EXCEEDED: "E_QUOTA_ELEVENLABS_DAILY_EXCEEDED",
  QUOTA_STORAGE_EXCEEDED: "E_QUOTA_STORAGE_EXCEEDED",
  DEDICATED_WORKER_REQUIRED: "E_DEDICATED_WORKER_REQUIRED"
});

// Only these daily-counter columns may be reserved (fixed allow-list — the field is interpolated into SQL).
const DAILY_FIELDS = new Set(["grok_invocations", "elevenlabs_units", "jobs_enqueued"]);

// extends DomainError so the custom quota/lifecycle code SURVIVES the persistence adapter, which re-throws a
// DomainError as-is but remaps every other thrown error (a plain Error would lose its code). super() uses a
// known code to satisfy DomainError's constructor; this.code is then overridden with the real category.
export class TenantQuotaError extends DomainError {
  constructor(code, message) { super("E_INVALID_STATE_TRANSITION", message || code); this.code = code; this.name = "TenantQuotaError"; this.isTenantQuotaError = true; }
}

export function createTenantGuard({ repos = { platform: platformRepository }, resources = null, clock = () => Date.now() } = {}) {
  const P = repos.platform;
  // UTC day boundary (policy: usage days are UTC calendar days — deterministic across worker time zones).
  const dayKey = () => new Date(clock()).toISOString().slice(0, 10);

  // Resolve the customer that owns this workspace (or null = unmanaged / existing owner). Non-RLS read.
  const resolveCustomer = (client, workspaceId) => P.customerForWorkspace(client, workspaceId);

  // Lifecycle gate: SUSPENDED / CLOSED / EXPIRED (or past expires_at) blocks all new work. Existing data is
  // never touched here — this only refuses NEW mutations at the choke point.
  function assertLifecycle(customer) {
    if (!customer) return;
    if (customer.status === "SUSPENDED" || customer.status === "CLOSED") throw new TenantQuotaError(TENANT_ERRORS.CUSTOMER_SUSPENDED, "customer suspended");
    const exp = customer.expires_at ? new Date(customer.expires_at).getTime() : null;
    if (customer.status === "EXPIRED" || (exp !== null && Number.isFinite(exp) && exp <= clock())) throw new TenantQuotaError(TENANT_ERRORS.CUSTOMER_EXPIRED, "customer expired");
  }

  // Count-based quota (users / provider accounts / proxies / active movies / scenes / queued jobs). Serializes
  // concurrent reservations for the same (customer, resource) via a transaction advisory lock, then re-reads
  // the live count UNDER the lock — so two near-limit requests can never both pass.
  async function assertCount(client, customer, { key, limit, code, counter } = {}) {
    if (!customer || limit == null) return;
    if (typeof counter !== "function") throw new TypeError("assertCount requires a counter(client) fn");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [customer.id, key]);
    const n = Number(await counter(client));
    if (Number.isFinite(n) && n >= limit) throw new TenantQuotaError(code, `${key} quota exceeded`);
  }

  // Daily reservation (grok / elevenlabs / jobs). Atomic UPSERT: the WHERE guard on the ON CONFLICT UPDATE
  // rejects the increment that would cross the limit, so concurrent reservers cannot jointly overshoot. On a
  // rejected reservation NOTHING is written (no leaked reservation). Rolls back with the caller's transaction.
  async function reserveDaily(client, customer, { field, limit, code, by = 1 } = {}) {
    if (!customer) return;
    if (!DAILY_FIELDS.has(field)) throw new TypeError(`invalid daily field ${field}`);
    if (limit == null) { await P.incrementUsage(client, { customerId: customer.id, field, by, day: dayKey() }); return; }
    if (by > limit) throw new TenantQuotaError(code, `${field} daily quota exceeded`);
    const r = await client.query(
      `INSERT INTO customer_usage_daily (id, customer_id, usage_date, ${field}) VALUES ($1,$2,$3,$4)
       ON CONFLICT (customer_id, usage_date) DO UPDATE SET ${field} = customer_usage_daily.${field} + $4, updated_at = now()
       WHERE customer_usage_daily.${field} + $4 <= $5
       RETURNING ${field}`,
      [newId("cusg"), customer.id, dayKey(), by, limit]
    );
    if (r.rows.length === 0) throw new TenantQuotaError(code, `${field} daily quota exceeded`);
  }

  // ---- composed choke-point guards (each resolves the customer once, then enforces) ----

  // Member invite / create: lifecycle + max_users (members + pending invitations counted together).
  async function assertCanAddMember(client, { workspaceId, countMembers } = {}) {
    const customer = await resolveCustomer(client, workspaceId);
    assertLifecycle(customer);
    await assertCount(client, customer, { key: "users", limit: customer && customer.max_users, code: TENANT_ERRORS.QUOTA_USERS_EXCEEDED, counter: countMembers });
    return customer;
  }

  // Generation enqueue: lifecycle + max_queued_jobs (live) + reserve one grok invocation (daily). Called INSIDE
  // the enqueue transaction so a subsequent failure rolls the reservation back.
  async function assertCanEnqueue(client, { workspaceId, countActiveJobs } = {}) {
    const customer = await resolveCustomer(client, workspaceId);
    assertLifecycle(customer);
    // Phase 7 readiness (dedicated-worker customers only): refuse enqueue BEFORE any provider invocation unless
    // an ACTIVE dedicated worker + provider account are bound to THIS workspace. No fallback to another tenant's
    // resources. Checked before the grok reservation so a not-ready enqueue consumes no quota.
    if (resources && customer && customer.dedicated_worker_mode === true) await resources.assertReady(client, { requireProvider: true });
    await assertCount(client, customer, { key: "queued_jobs", limit: customer && customer.max_queued_jobs, code: TENANT_ERRORS.QUOTA_QUEUED_JOBS_EXCEEDED, counter: countActiveJobs });
    await reserveDaily(client, customer, { field: "grok_invocations", limit: customer && customer.max_grok_per_day, code: TENANT_ERRORS.QUOTA_GROK_DAILY_EXCEEDED });
    await reserveDaily(client, customer, { field: "jobs_enqueued", limit: null }); // informational counter (unbounded)
    return customer;
  }

  // Movie create: lifecycle + max_active_movies (non-archived).
  async function assertCanCreateMovie(client, { workspaceId, countActiveMovies } = {}) {
    const customer = await resolveCustomer(client, workspaceId);
    assertLifecycle(customer);
    await assertCount(client, customer, { key: "active_movies", limit: customer && customer.max_active_movies, code: TENANT_ERRORS.QUOTA_ACTIVE_MOVIES_EXCEEDED, counter: countActiveMovies });
    return customer;
  }

  // Scene add: lifecycle + max_scenes_per_movie.
  async function assertCanAddScene(client, { workspaceId, countScenes } = {}) {
    const customer = await resolveCustomer(client, workspaceId);
    assertLifecycle(customer);
    await assertCount(client, customer, { key: "scenes", limit: customer && customer.max_scenes_per_movie, code: TENANT_ERRORS.QUOTA_SCENES_EXCEEDED, counter: countScenes });
    return customer;
  }

  // Provider account create: lifecycle + max_provider_accounts.
  async function assertCanCreateProvider(client, { workspaceId, countProviders } = {}) {
    const customer = await resolveCustomer(client, workspaceId);
    assertLifecycle(customer);
    await assertCount(client, customer, { key: "provider_accounts", limit: customer && customer.max_provider_accounts, code: TENANT_ERRORS.QUOTA_PROVIDER_ACCOUNTS_EXCEEDED, counter: countProviders });
    return customer;
  }

  // Proxy create: lifecycle + max_proxies.
  async function assertCanCreateProxy(client, { workspaceId, countProxies } = {}) {
    const customer = await resolveCustomer(client, workspaceId);
    assertLifecycle(customer);
    await assertCount(client, customer, { key: "proxies", limit: customer && customer.max_proxies, code: TENANT_ERRORS.QUOTA_PROXIES_EXCEEDED, counter: countProxies });
    return customer;
  }

  return Object.freeze({
    resolveCustomer, assertLifecycle, assertCount, reserveDaily,
    assertCanAddMember, assertCanEnqueue, assertCanCreateMovie, assertCanAddScene, assertCanCreateProvider, assertCanCreateProxy,
    dayKey
  });
}
