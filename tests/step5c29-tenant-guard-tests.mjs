// P0 Step 5C.29 Phase 8 — tenant guard (customer lifecycle + quota) certification on REAL disposable PostgreSQL.
// Provider-free. Proves: lifecycle gates (ACTIVE ok / SUSPENDED / EXPIRED); daily reservation is atomic +
// concurrency-safe (N concurrent reservers at a limit never overshoot); count-based limits are advisory-locked
// (N concurrent creators at a limit stop exactly at the limit — no TOCTOU); a reservation rolls back with a
// failed transaction; an unmanaged workspace (no customer) is unconstrained.
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { platformRepository } from "../control-plane/src/platform/platform-repository.mjs";
import { createTenantGuard, TENANT_ERRORS, TenantQuotaError } from "../control-plane/src/platform/tenant-guard.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
async function throwsCode(fn, code) { try { await fn(); return false; } catch (e) { return e instanceof TenantQuotaError && e.code === code; } }

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 tenant guard: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c29tg" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-24T12:00:00.000Z");
  const guard = createTenantGuard({ clock: () => clock });
  const tx = (fn) => adapter.transaction(fn);
  const tenantTx = (ws, fn) => adapter.tenantTransaction(ws, fn);

  // ---- seed: owner user + workspace + a customer with quota, linked to the workspace ----
  const ownerId = newId("usr"), wsManaged = newId("ws"), wsUnmanaged = newId("ws");
  await tx(async (c) => {
    await c.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ownerId, `owner-${ownerId}@t.test`]);
    for (const ws of [wsManaged, wsUnmanaged]) { await c.query("SELECT set_config('app.current_workspace',$1,false)", [ws]); await c.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'WS',$2)", [ws, ownerId]); await c.query("INSERT INTO workspace_members (id,workspace_id,user_id,role,status) VALUES ($1,$2,$3,'OWNER','ACTIVE')", [newId("mship"), ws, ownerId]); }
  });
  const customer = await tx(async (c) => platformRepository.insertCustomer(c, { legalName: "Guarded Co", quota: { maxUsers: 3, maxActiveMovies: 3, maxGrokPerDay: 5, maxQueuedJobs: 10 } }));
  await tenantTx(wsManaged, async (c) => platformRepository.linkWorkspaceCustomer(c, { workspaceId: wsManaged, customerId: customer.id }));

  // ---- unmanaged workspace: no customer -> guard is a no-op (existing owner unaffected) ----
  check("T1 unmanaged workspace resolves NO customer", (await tenantTx(wsUnmanaged, (c) => guard.resolveCustomer(c, wsUnmanaged))) == null);
  await tenantTx(wsUnmanaged, async (c) => guard.assertLifecycle(await guard.resolveCustomer(c, wsUnmanaged))); // no throw
  check("T2 unmanaged lifecycle passes (no throw)", true);

  // ---- lifecycle: ACTIVE ok, SUSPENDED, EXPIRED ----
  check("T3 ACTIVE customer lifecycle ok", await (async () => { try { await tenantTx(wsManaged, async (c) => guard.assertLifecycle(await guard.resolveCustomer(c, wsManaged))); return true; } catch { return false; } })());
  await tx((c) => platformRepository.setCustomerStatus(c, { id: customer.id, status: "SUSPENDED", reason: "test" }));
  check("T4 SUSPENDED customer -> CUSTOMER_SUSPENDED", await throwsCode(() => tenantTx(wsManaged, async (c) => guard.assertLifecycle(await guard.resolveCustomer(c, wsManaged))), TENANT_ERRORS.CUSTOMER_SUSPENDED));
  await tx((c) => platformRepository.setCustomerStatus(c, { id: customer.id, status: "ACTIVE" }));
  check("T5 reactivated customer lifecycle ok again", await (async () => { try { await tenantTx(wsManaged, async (c) => guard.assertLifecycle(await guard.resolveCustomer(c, wsManaged))); return true; } catch { return false; } })());
  // expiration: set expires_at in the past
  await tx((c) => c.query("UPDATE customers SET expires_at=to_timestamp($2/1000.0) WHERE id=$1", [customer.id, clock - 1000]));
  check("T6 past expires_at -> CUSTOMER_EXPIRED", await throwsCode(() => tenantTx(wsManaged, async (c) => guard.assertLifecycle(await guard.resolveCustomer(c, wsManaged))), TENANT_ERRORS.CUSTOMER_EXPIRED));
  await tx((c) => c.query("UPDATE customers SET expires_at=NULL WHERE id=$1", [customer.id]));

  // ---- daily reservation atomicity: 10 concurrent grok reserves at limit 5 -> exactly 5 succeed ----
  const reserveOnce = () => tx(async (c) => { const cust = await platformRepository.getCustomer(c, customer.id); await guard.reserveDaily(c, cust, { field: "grok_invocations", limit: cust.max_grok_per_day, code: TENANT_ERRORS.QUOTA_GROK_DAILY_EXCEEDED }); return "ok"; }).then(() => true).catch((e) => (e instanceof TenantQuotaError && e.code === TENANT_ERRORS.QUOTA_GROK_DAILY_EXCEEDED) ? false : Promise.reject(e));
  const reserveResults = await Promise.all(Array.from({ length: 10 }, reserveOnce));
  const grokWins = reserveResults.filter(Boolean).length;
  const usage = await tx((c) => platformRepository.getUsage(c, { customerId: customer.id, day: guard.dayKey() }));
  check("T7 10 concurrent daily reserves at limit 5 -> exactly 5 succeed", grokWins === 5);
  check("T8 daily usage counter equals the limit exactly (no overshoot)", usage && usage.grok_invocations === 5);

  // ---- count-based limit concurrency: maxActiveMovies=3, 8 concurrent creators -> exactly 3 rows ----
  // A minimal movie_projects insert under the advisory-locked count guard, RLS-scoped to the workspace.
  const createMovie = () => tenantTx(wsManaged, async (c) => {
    const cust = await guard.resolveCustomer(c, wsManaged);
    await guard.assertCount(c, cust, { key: "active_movies", limit: cust.max_active_movies, code: TENANT_ERRORS.QUOTA_ACTIVE_MOVIES_EXCEEDED, counter: async (cc) => Number((await cc.query("SELECT count(*)::int n FROM movie_projects WHERE archived_at IS NULL")).rows[0].n) });
    await c.query("INSERT INTO movie_projects (id, workspace_id, title, status, input_mode, source) VALUES ($1,$2,'M','DRAFT','IDEA','UI')", [newId("mov"), wsManaged]);
    return true;
  }).then(() => true).catch((e) => (e instanceof TenantQuotaError && e.code === TENANT_ERRORS.QUOTA_ACTIVE_MOVIES_EXCEEDED) ? false : Promise.reject(e));
  const movieResults = await Promise.all(Array.from({ length: 8 }, createMovie));
  const movieWins = movieResults.filter(Boolean).length;
  const movieCount = await tenantTx(wsManaged, async (c) => Number((await c.query("SELECT count(*)::int n FROM movie_projects")).rows[0].n));
  check("T9 8 concurrent creates at limit 3 -> exactly 3 succeed (advisory-locked, no TOCTOU)", movieWins === 3);
  check("T10 movie_projects row count equals the limit exactly", movieCount === 3);

  // ---- reservation rollback: a reserve inside a tx that then throws leaves usage unchanged ----
  const before = (await tx((c) => platformRepository.getUsage(c, { customerId: customer.id, day: guard.dayKey() }))).grok_invocations;
  try { await tx(async (c) => { const cust = await platformRepository.getCustomer(c, customer.id); await guard.reserveDaily(c, cust, { field: "grok_invocations", limit: null }); throw new Error("boom"); }); } catch { /* expected */ }
  const after = (await tx((c) => platformRepository.getUsage(c, { customerId: customer.id, day: guard.dayKey() }))).grok_invocations;
  check("T11 reservation rolls back with a failed transaction (no leaked usage)", after === before);

  // ---- unmanaged workspace: unlimited (guard no-op even past any nominal limit) ----
  let unmanagedOk = true;
  for (let i = 0; i < 12; i++) { try { await tenantTx(wsUnmanaged, async (c) => { const cust = await guard.resolveCustomer(c, wsUnmanaged); await guard.assertCanEnqueue(c, { workspaceId: wsUnmanaged, countActiveJobs: async () => 9999 }); }); } catch { unmanagedOk = false; } }
  check("T12 unmanaged workspace enqueue never blocked by quota (no customer = unlimited)", unmanagedOk);

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}

main().then(() => {
  console.log(`\nStep 5C.29 tenant guard: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
