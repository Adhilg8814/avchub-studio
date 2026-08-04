// P0 Step 5C.29 Phase 1 — 0032 platform/customer schema, certified on REAL disposable PostgreSQL.
// Asserts the LOCKED invariants: customers/platform_admins/platform_audit_events/customer_usage_daily are
// platform-plane (NON-RLS), workspaces.customer_id is additive metadata, and cp_platform_role resolves the
// platform authority plane server-side (never from workspace membership).
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { userRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const nid = (p) => `${p}_${"0123456789ABCDEFGHJKMNPQRS".slice(0, 26)}`; // deterministic valid Crockford id

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 platform schema: SKIPPED (portable PostgreSQL not available)"); return; }
  const LATEST = loadMigrationFiles(MIGRATIONS_DIR).length;
  const live = await startDisposablePg({ namePrefix: "cp5c29plat" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try {
    await mrun(mc, { dir: MIGRATIONS_DIR });
    check(`migrations apply to latest v=${LATEST} (>=32)`, (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === LATEST && LATEST >= 32);
    // tables exist
    for (const t of ["customers", "customer_usage_daily", "platform_admins", "platform_audit_events"]) {
      check(`table ${t} exists`, (await mc.query("SELECT to_regclass($1) r", [`public.${t}`])).rows[0].r === t);
      // platform-plane = NON-RLS (R1)
      check(`${t} is NON-RLS (platform-plane)`, (await mc.query("SELECT relrowsecurity FROM pg_class WHERE relname=$1", [t])).rows[0].relrowsecurity === false);
    }
    check("workspaces.customer_id column added (metadata)", (await mc.query("SELECT 1 FROM information_schema.columns WHERE table_name='workspaces' AND column_name='customer_id'")).rowCount === 1);
    // customer_id is NOT in any RLS policy (R2): the workspaces policies still key only on id/current_workspace
    const pol = (await mc.query("SELECT string_agg(coalesce(qual,'')||coalesce(with_check,''),' ') q FROM pg_policies WHERE tablename IN ('workspaces','projects','movie_projects','jobs')")).rows[0].q || "";
    check("R2: customer_id NOT referenced by any RLS policy", !/customer_id/.test(pol));
    check("cp_platform_role function exists", (await mc.query("SELECT 1 FROM pg_proc WHERE proname='cp_platform_role'")).rowCount === 1);
  } finally { await mc.end(); }

  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const tx = (fn) => adapter.transaction(fn);

  await tx(async (c) => {
    // seed a global user (platform-plane; users is non-RLS)
    const u = await userRepository.createInvitedUser(c, { email: "boss@platform.test", status: "ACTIVE" });
    const other = await userRepository.createInvitedUser(c, { email: "nobody@platform.test", status: "ACTIVE" });
    const custId = nid("cust");
    await c.query("INSERT INTO customers (id, legal_name, plan, primary_owner_user_id) VALUES ($1,$2,'FREE',$3)", [custId, "Acme Co", u.id]);
    check("customer insert (platform-plane, no ws context)", (await c.query("SELECT count(*)::int n FROM customers")).rows[0].n === 1);
    // usage upsert
    const usageId = nid("cusg");
    await c.query("INSERT INTO customer_usage_daily (id, customer_id, usage_date, grok_invocations) VALUES ($1,$2,current_date,1) ON CONFLICT (customer_id, usage_date) DO UPDATE SET grok_invocations = customer_usage_daily.grok_invocations + 1", [usageId, custId]);
    check("customer_usage_daily upsert", (await c.query("SELECT grok_invocations FROM customer_usage_daily WHERE customer_id=$1", [custId])).rows[0].grok_invocations === 1);

    // platform_admins + cp_platform_role
    await c.query("INSERT INTO platform_admins (user_id, role) VALUES ($1,'PLATFORM_OWNER')", [u.id]);
    const r1 = await c.query("SELECT * FROM cp_platform_role($1)", [u.id]);
    check("cp_platform_role -> PLATFORM_OWNER for an ACTIVE platform admin", r1.rowCount === 1 && r1.rows[0].role === "PLATFORM_OWNER");
    const r2 = await c.query("SELECT * FROM cp_platform_role($1)", [other.id]);
    check("cp_platform_role -> no row for a non-platform user (no elevation)", r2.rowCount === 0);
    // disable -> no longer resolves (status gate)
    await c.query("UPDATE platform_admins SET status='DISABLED', disabled_at=now() WHERE user_id=$1", [u.id]);
    const r3 = await c.query("SELECT * FROM cp_platform_role($1)", [u.id]);
    check("cp_platform_role -> no row for a DISABLED platform admin", r3.rowCount === 0);

    // platform_audit_events insert (non-RLS, NULL workspace allowed — unlike audit_events)
    await c.query("INSERT INTO platform_audit_events (id, actor_user_id, actor_role, action, target_type, target_id, customer_id) VALUES ($1,$2,'PLATFORM_OWNER','CUSTOMER_CREATED','customer',$3,$3)", [nid("paud"), u.id, custId]);
    check("platform_audit_events insert (NULL workspace ok)", (await c.query("SELECT count(*)::int n FROM platform_audit_events WHERE action='CUSTOMER_CREATED'")).rows[0].n === 1);

    // link a workspace to the customer (metadata)
    await setAuthContext(c, { userId: u.id });
    // create a ws via raw SQL under the new-ws RLS context so customer_id can be set
    const wsId = nid("ws");
    await c.query("SELECT set_config('app.current_workspace',$1,true)", [wsId]);
    await c.query("INSERT INTO workspaces (id, name, owner_user_id, customer_id) VALUES ($1,'Acme WS',$2,$3)", [wsId, u.id, custId]);
    check("workspace.customer_id link (metadata)", (await c.query("SELECT customer_id FROM workspaces WHERE id=$1", [wsId])).rows[0].customer_id === custId);
  });

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}
main().then(() => { console.log(`\nStep 5C.29 platform schema: ${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); })
  .catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
