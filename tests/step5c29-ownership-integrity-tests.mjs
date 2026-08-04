// P0 Step 5C.29 Phase 1 — 0033 ownership integrity, certified on REAL disposable PostgreSQL.
// The DB-level owner-guard (§R12) + owner_user_id reconcile (§R13). Verifies the deferred constraint trigger
// blocks removing the last OWNER at COMMIT while allowing valid multi-step ownership transitions.
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
async function throws(fn) { try { await fn(); return false; } catch { return true; } }

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 ownership integrity: SKIPPED (portable PostgreSQL not available)"); return; }
  const LATEST = loadMigrationFiles(MIGRATIONS_DIR).length;
  const live = await startDisposablePg({ namePrefix: "cp5c29own" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try {
    await mrun(mc, { dir: MIGRATIONS_DIR });
    check(`migrations apply to latest v=${LATEST} (>=33)`, (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === LATEST && LATEST >= 33);
    check("owner-guard trigger exists", (await mc.query("SELECT 1 FROM pg_trigger WHERE tgname='workspace_members_owner_guard'")).rowCount === 1);
    check("cp_assert_workspace_owner exists", (await mc.query("SELECT 1 FROM pg_proc WHERE proname='cp_assert_workspace_owner'")).rowCount === 1);
  } finally { await mc.end(); }

  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const tx = (fn) => adapter.transaction(fn);

  const owner = await tx(async (c) => userRepository.createInvitedUser(c, { email: "own@own.test", status: "ACTIVE" }));
  const second = await tx(async (c) => userRepository.createInvitedUser(c, { email: "two@own.test", status: "ACTIVE" }));
  const ws = await tx(async (c) => { await setAuthContext(c, { userId: owner.id }); const w = await workspaceRepository.createWorkspace(c, { name: "Own WS", ownerUserId: owner.id }); await workspaceRepository.createMembership(c, { workspaceId: w.id, userId: owner.id, role: "OWNER" }); return w; });

  // §R13 reconcile ran at migrate time (no members then); do it via a fresh apply is not needed — verify the
  // repository keeps owner_user_id == the OWNER membership after creation.
  check("owner_user_id matches OWNER membership", (await tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); return (await c.query("SELECT owner_user_id FROM workspaces WHERE id=$1", [ws.id])).rows[0].owner_user_id; })) === owner.id);

  // DEMOTE the sole OWNER -> blocked at COMMIT by the deferred guard.
  const demoteBlocked = await throws(() => tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await c.query("UPDATE workspace_members SET role='ADMIN' WHERE workspace_id=$1 AND user_id=$2", [ws.id, owner.id]); }));
  check("demote sole OWNER -> BLOCKED (owner-guard)", demoteBlocked);
  check("sole OWNER still OWNER after blocked demote", (await tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); return (await c.query("SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [ws.id, owner.id])).rows[0].role; })) === "OWNER");

  // Invariant = "a NON-EMPTY workspace retains an OWNER". Add a non-owner member, then deleting THAT member
  // (owner remains) is allowed; but demoting/removing the owner while other members remain is blocked.
  const viewer = await tx(async (c) => userRepository.createInvitedUser(c, { email: "vw@own.test", status: "ACTIVE" }));
  await tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: viewer.id, role: "VIEWER" }); });
  const delNonOwnerOk = await throws(() => tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await c.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [ws.id, viewer.id]); }));
  check("delete a NON-owner member (owner remains) -> ALLOWED", delNonOwnerOk === false);
  // demote the owner while (only) a re-added viewer remains -> leaves members with no owner -> BLOCKED
  await tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: viewer.id, role: "VIEWER" }); });
  const demoteWithMembersBlocked = await throws(() => tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await c.query("UPDATE workspace_members SET role='ADMIN' WHERE workspace_id=$1 AND user_id=$2", [ws.id, owner.id]); }));
  check("demote sole OWNER while other members remain -> BLOCKED", demoteWithMembersBlocked);
  // clean the viewer back out so the transfer-pattern test below starts from owner-only
  await tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await c.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [ws.id, viewer.id]); });

  // Add a SECOND owner, THEN demote the first -> OK (still >=1 owner).
  await tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: second.id, role: "OWNER" }); });
  const demoteOk = await throws(() => tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await c.query("UPDATE workspace_members SET role='ADMIN' WHERE workspace_id=$1 AND user_id=$2", [ws.id, owner.id]); }));
  check("demote one OWNER while a second OWNER exists -> ALLOWED", demoteOk === false);

  // transferOwnership-style: promote a member to OWNER + demote the old owner in ONE tx (both valid at commit).
  await tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await c.query("UPDATE workspace_members SET role='OWNER' WHERE workspace_id=$1 AND user_id=$2", [ws.id, owner.id]); });
  const transferOk = await throws(() => tx(async (c) => {
    await setAuthContext(c, { workspaceId: ws.id });
    await c.query("UPDATE workspace_members SET role='OWNER' WHERE workspace_id=$1 AND user_id=$2", [ws.id, second.id]);
    await c.query("UPDATE workspace_members SET role='ADMIN' WHERE workspace_id=$1 AND user_id=$2", [ws.id, owner.id]);
  }));
  check("transfer-ownership pattern (promote+demote in one tx) -> ALLOWED", transferOk === false);

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}
main().then(() => { console.log(`\nStep 5C.29 ownership integrity: ${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); })
  .catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
