// P0 Step 5C.29 Phase 7 — dedicated tenant RESOURCE isolation on REAL disposable PostgreSQL. Provider-free
// (fake worker/provider/profile/proxy refs). Proves the ownership chain: workspace-scoped resolution (a tenant
// never sees another's resource), GLOBAL dedicated uniqueness (a worker/provider can't be bound to two
// customers), readiness (enqueue refused before any provider invocation until worker + provider are ACTIVE),
// DRAINING worker excluded, and the guard integration (dedicated customer gated, grandfathered owner not).
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { platformRepository } from "../control-plane/src/platform/platform-repository.mjs";
import { tenantResourceRepository as RR, RESOURCE_ERRORS, ResourceError } from "../control-plane/src/platform/tenant-resources.mjs";
import { createTenantGuard, TENANT_ERRORS, TenantQuotaError } from "../control-plane/src/platform/tenant-guard.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
async function throwsRes(fn, code) { try { await fn(); return false; } catch (e) { return e instanceof ResourceError && e.code === code; } }

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 tenant resources: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c29tr" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-24T12:00:00.000Z");
  const tx = (fn) => adapter.transaction(fn);
  const T = (ws, fn) => adapter.tenantTransaction(ws, fn);

  // ---- seed owner + 3 workspaces + a customer per workspace ----
  const owner = newId("usr"), wsA = newId("ws"), wsB = newId("ws"), wsC = newId("ws");
  await tx(async (c) => {
    await c.query("INSERT INTO users (id,email) VALUES ($1,$2)", [owner, `o-${owner}@t.test`]);
    for (const ws of [wsA, wsB, wsC]) { await c.query("SELECT set_config('app.current_workspace',$1,false)", [ws]); await c.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'WS',$2)", [ws, owner]); }
  });
  const custA = await tx((c) => platformRepository.insertCustomer(c, { legalName: "Tenant A Inc", quota: { maxQueuedJobs: 100 } }));
  const custB = await tx((c) => platformRepository.insertCustomer(c, { legalName: "Tenant B Inc", quota: { maxQueuedJobs: 100 } }));
  const custC = await tx((c) => platformRepository.insertCustomer(c, { legalName: "Tenant C Inc", quota: {} }));
  await T(wsA, (c) => platformRepository.linkWorkspaceCustomer(c, { workspaceId: wsA, customerId: custA.id }));
  await T(wsB, (c) => platformRepository.linkWorkspaceCustomer(c, { workspaceId: wsB, customerId: custB.id }));
  await T(wsC, (c) => platformRepository.linkWorkspaceCustomer(c, { workspaceId: wsC, customerId: custC.id }));

  const wrkA = "wrk_" + "A".repeat(26), wrkB = "wrk_" + "B".repeat(26);
  const paA = "pa_" + "A".repeat(26), paB = "pa_" + "B".repeat(26);

  // ---- bind dedicated resources per tenant ----
  await T(wsA, (c) => RR.bind(c, { workspaceId: wsA, resourceType: "WORKER", resourceRef: wrkA, label: "Worker A" }));
  await T(wsA, (c) => RR.bind(c, { workspaceId: wsA, resourceType: "PROVIDER_ACCOUNT", resourceRef: paA }));
  await T(wsA, (c) => RR.bind(c, { workspaceId: wsA, resourceType: "CLOAK_PROFILE", resourceRef: "cbp_A" }));
  await T(wsA, (c) => RR.bind(c, { workspaceId: wsA, resourceType: "PROXY", resourceRef: "tun_A" }));
  await T(wsB, (c) => RR.bind(c, { workspaceId: wsB, resourceType: "WORKER", resourceRef: wrkB }));
  await T(wsB, (c) => RR.bind(c, { workspaceId: wsB, resourceType: "PROVIDER_ACCOUNT", resourceRef: paB }));

  // ---- 1. workspace-scoped listing (RLS): A sees only A ----
  const listA = await T(wsA, (c) => RR.list(c, {}));
  const listB = await T(wsB, (c) => RR.list(c, {}));
  check("R1 A lists exactly its 4 resources; B its 2 (RLS-scoped)", listA.length === 4 && listB.length === 2 && listA.every((r) => r.workspaceId === wsA));
  check("R2 A's resource refs are A's only (no B ref present)", !listA.some((r) => r.resourceRef === wrkB || r.resourceRef === paB));

  // ---- 2. cross-tenant resolve fails closed ----
  check("R3 A resolveOwned(B's worker) -> null (foreign resource hidden by RLS)", (await T(wsA, (c) => RR.resolveOwned(c, { resourceType: "WORKER", resourceRef: wrkB }))) === null);
  check("R4 A assertOwned(B's worker) -> NOT_OWNED", await throwsRes(() => T(wsA, (c) => RR.assertOwned(c, { resourceType: "WORKER", resourceRef: wrkB })), RESOURCE_ERRORS.NOT_OWNED));
  check("R5 A assertOwned(A's worker) -> ok", (await T(wsA, (c) => RR.assertOwned(c, { resourceType: "WORKER", resourceRef: wrkA }))).resourceRef === wrkA);

  // ---- 3. GLOBAL dedicated uniqueness: binding A's worker to B fails (never shared across customers) ----
  check("R6 binding A's worker to workspace B -> ALREADY_BOUND (dedicated, not shared)", await throwsRes(() => T(wsB, (c) => RR.bind(c, { workspaceId: wsB, resourceType: "WORKER", resourceRef: wrkA })), RESOURCE_ERRORS.ALREADY_BOUND));
  check("R7 binding A's provider to B -> ALREADY_BOUND", await throwsRes(() => T(wsB, (c) => RR.bind(c, { workspaceId: wsB, resourceType: "PROVIDER_ACCOUNT", resourceRef: paA })), RESOURCE_ERRORS.ALREADY_BOUND));
  // same ref, DIFFERENT type is allowed (distinct resources)
  check("R8 same ref different type is a distinct resource (allowed)", (await T(wsA, (c) => RR.bind(c, { workspaceId: wsA, resourceType: "PROXY", resourceRef: wrkA }))).resourceRef === wrkA);

  // ---- 4. readiness gate ----
  check("R9 wsC (no resources) assertReady -> DEDICATED_WORKER_REQUIRED", await throwsRes(() => T(wsC, (c) => RR.assertReady(c, {})), RESOURCE_ERRORS.DEDICATED_WORKER_REQUIRED));
  await T(wsC, (c) => RR.bind(c, { workspaceId: wsC, resourceType: "WORKER", resourceRef: "wrk_" + "C".repeat(26) }));
  check("R10 wsC worker-only assertReady -> PROVIDER_ACCOUNT_NOT_READY", await throwsRes(() => T(wsC, (c) => RR.assertReady(c, {})), RESOURCE_ERRORS.PROVIDER_NOT_READY));
  await T(wsC, (c) => RR.bind(c, { workspaceId: wsC, resourceType: "PROVIDER_ACCOUNT", resourceRef: "pa_" + "C".repeat(26) }));
  check("R11 wsC worker+provider assertReady -> ok", (await T(wsC, async (c) => { await RR.assertReady(c, {}); return true; })));
  // DRAINING worker is not ready
  await T(wsB, (c) => RR.setStatus(c, { resourceType: "WORKER", resourceRef: wrkB, status: "DRAINING" }));
  check("R12 DRAINING worker excluded -> DEDICATED_WORKER_REQUIRED", await throwsRes(() => T(wsB, (c) => RR.assertReady(c, {})), RESOURCE_ERRORS.DEDICATED_WORKER_REQUIRED));
  await T(wsB, (c) => RR.setStatus(c, { resourceType: "WORKER", resourceRef: wrkB, status: "ACTIVE" }));

  // ---- 5. guard integration: dedicated customer gated on readiness; grandfathered owner (mode=false) not ----
  const guard = createTenantGuard({ resources: RR, clock: () => clock });
  // wsC has worker+provider (ready) -> enqueue allowed (dedicated_worker_mode default true)
  check("R13 dedicated + ready workspace -> assertCanEnqueue passes", await T(wsC, async (c) => { await guard.assertCanEnqueue(c, { workspaceId: wsC, countActiveJobs: async () => 0 }); return true; }));
  // a fresh dedicated customer with NO resources -> enqueue blocked BEFORE any provider call
  const wsD = newId("ws"); const custD = await tx((c) => platformRepository.insertCustomer(c, { legalName: "Tenant D Inc", quota: {} }));
  await tx(async (c) => { await c.query("SELECT set_config('app.current_workspace',$1,false)", [wsD]); await c.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'WS',$2)", [wsD, owner]); });
  await T(wsD, (c) => platformRepository.linkWorkspaceCustomer(c, { workspaceId: wsD, customerId: custD.id }));
  check("R14 dedicated + NOT ready -> enqueue blocked (DEDICATED_WORKER_REQUIRED)", await (async () => { try { await T(wsD, (c) => guard.assertCanEnqueue(c, { workspaceId: wsD, countActiveJobs: async () => 0 })); return false; } catch (e) { return e instanceof ResourceError && e.code === RESOURCE_ERRORS.DEDICATED_WORKER_REQUIRED; } })());
  // grandfathered owner (dedicated_worker_mode=false) is NEVER readiness-gated even with no resources
  const wsO = newId("ws"); const custO = await tx((c) => platformRepository.insertCustomer(c, { legalName: "Owner Co", dedicatedWorkerMode: false, quota: {} }));
  await tx(async (c) => { await c.query("SELECT set_config('app.current_workspace',$1,false)", [wsO]); await c.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'WS',$2)", [wsO, owner]); });
  await T(wsO, (c) => platformRepository.linkWorkspaceCustomer(c, { workspaceId: wsO, customerId: custO.id }));
  check("R15 grandfathered owner (mode=false) -> enqueue never readiness-gated", await T(wsO, async (c) => { await guard.assertCanEnqueue(c, { workspaceId: wsO, countActiveJobs: async () => 0 }); return true; }));

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}

main().then(() => {
  console.log(`\nStep 5C.29 tenant resources: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
