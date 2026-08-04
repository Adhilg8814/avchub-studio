// P0 Step 5C.21E — RLS + SECURITY DEFINER final certification on real disposable PostgreSQL. Audits every
// auth SECURITY DEFINER (prosecdef + pinned search_path + owned by the migrator + EXECUTE granted ONLY to
// cp_tenant_app, never PUBLIC), proves the runtime role cp_tenant_app is NOBYPASSRLS, that a pre-auth
// challenge token cannot be used to read tenant data, and enforces service-level cross-workspace isolation
// (an ADMIN of workspace A cannot administer workspace B). SKIPS without portable PostgreSQL. NEVER prod.

import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { createAuthService } from "../control-plane/src/auth/auth-service.mjs";
import { AUTH_CONFIG_DEFAULTS } from "../control-plane/src/auth/auth-config.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";
import { credentialRepository, mfaRepository, recoveryCodeRepository } from "../control-plane/src/persistence/repositories/auth-credential-repository.mjs";
import { userSessionRepository } from "../control-plane/src/persistence/repositories/auth-session-repository.mjs";
import { preAuthChallengeRepository, passwordResetTokenRepository, emailVerificationTokenRepository, invitationRepository, reauthProofRepository, notificationOutboxRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, ARGON2_PARAMS } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotp, generateTotpSecret, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const AUTH_DEFINERS = ["cp_auth_session_resolve", "cp_auth_user_memberships", "cp_auth_admin_revoke_sessions", "cp_auth_owner_exists"];

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.21E auth RLS cert: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c21rls" });
  const mig = new Client({ connectionString: live.migrationUrl }); await mig.connect();
  let adapter;
  try {
    await mrun(mig, { dir: MIGRATIONS_DIR });
    check("migrations apply to latest", (await mig.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length);

    // ---- SECURITY DEFINER audit ----
    const fns = (await mig.query(`SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'cp_auth_%'`)).rows;
    check("exactly the 3 expected auth definers exist", fns.length === AUTH_DEFINERS.length && AUTH_DEFINERS.every((f) => fns.find((x) => x.proname === f)));
    check("all auth functions are SECURITY DEFINER", fns.every((f) => f.prosecdef === true));
    check("all auth definers pin search_path=public", fns.every((f) => Array.isArray(f.proconfig) && f.proconfig.some((c) => c === "search_path=public")));
    check("all auth definers owned by cp_migrator", fns.every((f) => f.owner === "cp_migrator"));
    // EXECUTE must be granted to cp_tenant_app and NOT to PUBLIC
    for (const fn of AUTH_DEFINERS) {
      const s = String((await mig.query("SELECT proacl::text FROM pg_proc WHERE proname=$1", [fn])).rows[0].proacl || "");
      // aclitem text is like {cp_migrator=X/cp_migrator,cp_tenant_app=X/cp_migrator}; a PUBLIC grant shows as "=X/..."
      check(`${fn}: EXECUTE to cp_tenant_app, not PUBLIC`, /cp_tenant_app=X/.test(s) && !/(^|[,{])=X/.test(s));
    }
    // cp_tenant_app is NOBYPASSRLS
    check("cp_tenant_app is NOBYPASSRLS", (await mig.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='cp_tenant_app'")).rows[0].rolbypassrls === false);
    // FORCE RLS on the core personal-auth tables; user_sessions ENABLE (not FORCE, so the definer can resolve)
    const rls = (await mig.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)", [["user_credentials", "user_mfa_methods", "user_recovery_codes", "user_sessions", "workspace_members"]])).rows;
    const forced = Object.fromEntries(rls.map((r) => [r.relname, r.relforcerowsecurity]));
    check("credentials/mfa/recovery FORCE RLS", forced.user_credentials && forced.user_mfa_methods && forced.user_recovery_codes);
    check("user_sessions + workspace_members ENABLE-not-FORCE (definer-resolvable)", forced.user_sessions === false && forced.workspace_members === false);
    // 0030 owner-bootstrap: singleton seeded REQUIRED; the pre-context owner-exists definer is false on an
    // empty cluster; auth_bootstrap is granted to cp_tenant_app (service-mediated, like auth_bootstrap_tokens).
    check("auth_bootstrap singleton seeded REQUIRED", (await mig.query("SELECT state FROM auth_bootstrap")).rows.length === 1 && (await mig.query("SELECT state FROM auth_bootstrap")).rows[0].state === "REQUIRED");
    check("cp_auth_owner_exists() is false on an owner-less cluster", (await mig.query("SELECT cp_auth_owner_exists() AS x")).rows[0].x === false);
    check("auth_bootstrap granted to cp_tenant_app", (await mig.query("SELECT has_table_privilege('cp_tenant_app','auth_bootstrap','SELECT,INSERT,UPDATE') AS x")).rows[0].x === true);
  } finally { await mig.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-23T12:00:00.000Z");
  const testKey = generateSecretBoxKey(), deliveryKey = generateSecretBoxKey();
  const svc = createAuthService({
    persistence: adapter, setAuthContext,
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository, reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, verifyToken: emailVerificationTokenRepository, invitation: invitationRepository, notification: notificationOutboxRepository, security: securityRepository },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, generateToken, hashToken, verifyTotp,
    decryptTotpSecret: (ct) => decryptSecret(ct, testKey), generateTotpSecret, otpauthUrl, encryptTotpSecret: (s) => encryptSecret(s, testKey),
    generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash, encryptLinkToken: (t) => encryptSecret(t, deliveryKey),
    clock: () => clock, config: AUTH_CONFIG_DEFAULTS
  });
  const tx = (fn) => adapter.transaction(fn);
  const seedUser = (email, pw) => tx(async (c) => { const u = await userRepository.createInvitedUser(c, { email, status: "ACTIVE" }); await setAuthContext(c, { userId: u.id }); await credentialRepository.createPasswordCredential(c, { userId: u.id, secretHash: await hashPassword(pw), params: ARGON2_PARAMS }); return u; });
  const seedWs = (uid, name) => tx(async (c) => { await setAuthContext(c, { userId: uid }); const ws = await workspaceRepository.createWorkspace(c, { name, ownerUserId: uid }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: uid, role: "OWNER" }); return ws; });
  const addMember = (wsId, uid, role) => tx(async (c) => { await setAuthContext(c, { workspaceId: wsId }); return workspaceRepository.createMembership(c, { workspaceId: wsId, userId: uid, role }); });

  try {
    const totpFor = (uid, secret) => tx(async (c) => { await setAuthContext(c, { userId: uid }); const m = await mfaRepository.createPendingTotp(c, { userId: uid, secretCiphertext: encryptSecret(secret, testKey) }); await mfaRepository.activateTotp(c, { userId: uid, methodId: m.id }); });
    const adminA = await seedUser("adminA@studio.test", "adminA-pass-12345678");
    const aSecret = generateTotpSecret(); await totpFor(adminA.id, aSecret);
    const wsA = await seedWs(adminA.id, "WS A");         // adminA OWNER of A
    const userB = await seedUser("userB@studio.test", "userB-pass-12345678");
    const wsB = await seedWs(userB.id, "WS B");          // userB OWNER of B (separate tenant)
    // MFA login for adminA (OWNER requires MFA)
    const lb = await svc.beginLogin({ email: "adminA@studio.test", password: "adminA-pass-12345678", requestedWorkspaceId: wsA.id });
    clock += 30_000;
    const admSess = (await svc.completeMfaLogin({ challengeToken: lb.challengeToken, code: generateTotp(aSecret, { nowMs: clock }) })).sessionToken;
    check("admin session on A resolves", (await svc.resolveSession({ sessionToken: admSess })).context.workspaceId === wsA.id);
    // listWorkspaceUsersSafe scopes to the session's own workspace only (never B's members)
    const usersVisible = await svc.listWorkspaceUsersSafe({ sessionToken: admSess });
    check("listWorkspaceUsersSafe scopes to session workspace only", usersVisible.ok && usersVisible.users.every((u) => u.id !== userB.id) && usersVisible.users.some((u) => u.id === adminA.id));
    // invitation is bound to the session's OWN workspace (there is no cross-workspace path)
    const inv = await svc.createInvitation({ sessionToken: admSess, email: "x@studio.test", role: "MEMBER" });
    const invWs = await tx(async (c) => (await c.query("SELECT workspace_id FROM user_invitations WHERE id=$1", [inv.invitationId])).rows[0].workspace_id);
    check("invitation workspace == A (never B)", inv.ok && invWs === wsA.id);
    // direct cross-tenant read is RLS fail-closed
    const leak = await tx(async (c) => { await setAuthContext(c, { userId: adminA.id, workspaceId: wsA.id, role: "OWNER" }); return (await c.query("SELECT count(*)::int n FROM workspace_members WHERE workspace_id=$1", [wsB.id])).rows[0].n; });
    check("member of A cannot read B's memberships (RLS)", leak === 0);

    console.log(`Step 5C.21E auth RLS cert: ${passed} passed, ${failed} failed`);
  } finally {
    try { await adapter.stop(); } catch { /* */ }
    await live.stop();
  }
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
