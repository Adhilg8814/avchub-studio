// P0 Step 5C.29 §Q1 — Gateway-PDP strong-auth correctness, certified on REAL disposable PostgreSQL.
// Regression for the verified defect: cp_auth_session_resolve omitted auth_strength and resolveActiveSession
// did not surface mfaAuthenticatedAt/authStrength, so resolveAuthorization (the Gateway-PDP path) returned
// authenticatedWithMfa=false / authStrength=null for EVERY session — over-denying STRONG_AUTH routes even for
// MFA-authenticated sessions. This drives the REAL authService (not the gateway-pep fake) through the actual
// authorize-endpoint decide(), proving the verdict is now correct AND matches the direct enforcement path.
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { createAuthService } from "../control-plane/src/auth/auth-service.mjs";
import { AUTH_CONFIG_DEFAULTS } from "../control-plane/src/auth/auth-config.mjs";
import { createEnforcement } from "../control-plane/src/auth/http/auth-enforcement.mjs";
import { createAuthorizeEndpoint } from "../control-plane/src/auth/runtime/authorize-endpoint.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";
import { platformRepository } from "../control-plane/src/platform/platform-repository.mjs";
import { credentialRepository, mfaRepository, recoveryCodeRepository } from "../control-plane/src/persistence/repositories/auth-credential-repository.mjs";
import { userSessionRepository } from "../control-plane/src/persistence/repositories/auth-session-repository.mjs";
import { preAuthChallengeRepository, passwordResetTokenRepository, reauthProofRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, ARGON2_PARAMS } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotp, generateTotpSecret, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const ORIGIN = "https://studio.example.com";
const SECRET = "x".repeat(48);

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 §Q1 authstrength PDP: SKIPPED (portable PostgreSQL not available)"); return; }
  const LATEST = loadMigrationFiles(MIGRATIONS_DIR).length;
  const live = await startDisposablePg({ namePrefix: "cp5c29q1" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try {
    const mig = await mrun(mc, { dir: MIGRATIONS_DIR });
    check(`migrations apply to latest v=${LATEST} (>=31)`, (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === LATEST && LATEST >= 31);
    // 0031: the definer now projects auth_strength (the root fix).
    const cols = (await mc.query("SELECT pg_get_function_result(oid) r FROM pg_proc WHERE proname='cp_auth_session_resolve'")).rows[0].r;
    check("0031 cp_auth_session_resolve returns auth_strength", /auth_strength/.test(cols));
  } finally { await mc.end(); }

  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-24T12:00:00.000Z");
  const testKey = generateSecretBoxKey();
  const svc = createAuthService({
    persistence: adapter, setAuthContext,
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository, reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, security: securityRepository },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy,
    generateToken, hashToken, verifyTotp, decryptTotpSecret: (ct) => decryptSecret(ct, testKey),
    generateTotpSecret, otpauthUrl, encryptTotpSecret: (s) => encryptSecret(s, testKey), generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash,
    clock: () => clock, config: AUTH_CONFIG_DEFAULTS
  });
  const tx = (fn) => adapter.transaction(fn);
  const seedUser = (email, pw) => tx(async (c) => { const u = await userRepository.createInvitedUser(c, { email, status: "ACTIVE" }); await setAuthContext(c, { userId: u.id }); await credentialRepository.createPasswordCredential(c, { userId: u.id, secretHash: await hashPassword(pw), params: ARGON2_PARAMS }); return u; });
  const seedWs = (uid, name) => tx(async (c) => { await setAuthContext(c, { userId: uid }); const ws = await workspaceRepository.createWorkspace(c, { name, ownerUserId: uid }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: uid, role: "OWNER" }); return ws; });

  // Create a session with a PRECISE auth strength (bypassing the login flow so every strength is reachable).
  const mkSession = ({ userId, wsId, authStrength, mfa, absMs }) => tx(async (c) => {
    await setAuthContext(c, { userId });
    const token = generateToken(), csrf = generateToken();
    await userSessionRepository.createSession(c, {
      userId, tokenHash: hashToken(token), csrfHash: hashToken(csrf), activeWorkspaceId: wsId,
      idleExpiresAt: new Date(clock + 12 * 3600e3).toISOString(),
      absoluteExpiresAt: new Date(absMs ?? clock + 7 * 86400e3).toISOString(),
      mfaAuthenticatedAt: mfa ? new Date(clock).toISOString() : null, authStrength
    });
    return { token, csrf };
  });

  const enforcement = createEnforcement({ authService: svc, config: { allowedOrigins: [ORIGIN], nativeAuthEnforcementEnabled: true }, hashToken });
  const owner = await seedUser("owner@q1.test", "owner-pass-123456");
  const ws = await seedWs(owner.id, "Q1 WS");
  // A VIEWER never requires MFA (roleRequiresMfa), so a password-only session for the viewer is a valid
  // authenticated session — used for the PASSWORD parity (resolveSession does not gate it out).
  const viewer = await seedUser("viewer@q1.test", "viewer-pass-123456");
  await tx(async (c) => { await setAuthContext(c, { workspaceId: ws.id }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: viewer.id, role: "VIEWER" }); });
  const platformRoleResolver = (userId) => adapter.transaction((c) => platformRepository.resolvePlatformRole(c, userId));
  const authorize = createAuthorizeEndpoint({ authService: svc, enforcement, config: { nativeAuth: { enforcementEnabled: true }, security: { allowedOrigins: [ORIGIN] } }, dataWorkspaceId: ws.id, platformRoleResolver, trustedProxySecret: SECRET });

  // ---- resolveAuthorization projection per strength (the core fix) ----
  const pw = await mkSession({ userId: owner.id, wsId: ws.id, authStrength: "PASSWORD", mfa: false });
  const totp = await mkSession({ userId: owner.id, wsId: ws.id, authStrength: "MFA_TOTP", mfa: true });
  const rec = await mkSession({ userId: owner.id, wsId: ws.id, authStrength: "MFA_RECOVERY", mfa: true });

  const azPw = await svc.resolveAuthorization({ sessionToken: pw.token, targetWorkspaceId: ws.id });
  check("PASSWORD session: authenticatedWithMfa=false", azPw.ok && azPw.authenticatedWithMfa === false);
  check("PASSWORD session: authStrength=PASSWORD", azPw.authStrength === "PASSWORD");
  check("PASSWORD session: role OWNER in target", azPw.roleInTarget === "OWNER" && azPw.isMemberOfTarget === true);

  const azTotp = await svc.resolveAuthorization({ sessionToken: totp.token, targetWorkspaceId: ws.id });
  check("MFA_TOTP session: authenticatedWithMfa=TRUE (was false pre-fix)", azTotp.authenticatedWithMfa === true);
  check("MFA_TOTP session: authStrength=MFA_TOTP (was null pre-fix)", azTotp.authStrength === "MFA_TOTP");

  const azRec = await svc.resolveAuthorization({ sessionToken: rec.token, targetWorkspaceId: ws.id });
  check("MFA_RECOVERY session: authenticatedWithMfa=TRUE", azRec.authenticatedWithMfa === true);
  check("MFA_RECOVERY session: authStrength=MFA_RECOVERY (distinguishable for step-up)", azRec.authStrength === "MFA_RECOVERY");

  // ---- direct enforcement vs Gateway-PDP parity ----
  const dTotp = await svc.resolveSession({ sessionToken: totp.token });
  check("PARITY MFA: direct resolveSession.authenticatedWithMfa === PDP resolveAuthorization", dTotp.ok && dTotp.context.authenticatedWithMfa === azTotp.authenticatedWithMfa && azTotp.authenticatedWithMfa === true);
  const vpw = await mkSession({ userId: viewer.id, wsId: ws.id, authStrength: "PASSWORD", mfa: false });
  const dVpw = await svc.resolveSession({ sessionToken: vpw.token });
  const azVpw = await svc.resolveAuthorization({ sessionToken: vpw.token, targetWorkspaceId: ws.id });
  check("PARITY PASSWORD (viewer): direct === PDP (both false)", dVpw.ok && dVpw.context.authenticatedWithMfa === azVpw.authenticatedWithMfa && azVpw.authenticatedWithMfa === false);

  // ---- decide() STRONG_AUTH verdict end-to-end (the actual over-deny) ----
  const cookieOf = (t) => `__Host-avc_studio_session=${t}`;
  const STRONG = { method: "POST", path: "/api/provider-management/accounts/pa_0000000000000000000000000/credential/rotate", origin: ORIGIN };
  const strongTotp = await authorize.decide({ ...STRONG, csrf: totp.csrf, cookie: cookieOf(totp.token) });
  if (strongTotp.decision !== "ALLOW") console.log("DIAG strongTotp:", JSON.stringify(strongTotp));
  check("decide STRONG_AUTH + MFA session -> ALLOW (was REAUTH_REQUIRED pre-fix)", strongTotp.decision === "ALLOW" && strongTotp.context?.authenticatedWithMfa === true);
  // An OWNER password session is DENIED before reaching the strong-auth gate: resolveSession rejects a
  // non-MFA session for an MFA-requiring role (defense-in-depth upstream of the PDP strong-auth branch).
  const strongPw = await authorize.decide({ ...STRONG, csrf: pw.csrf, cookie: cookieOf(pw.token) });
  check("decide STRONG_AUTH + OWNER password session -> DENY (not bypassable)", strongPw.decision === "DENY");
  // A VIEWER (non-admin) mutation on provider-management is denied at the admin gate (403 FORBIDDEN).
  const viewerMut = await authorize.decide({ method: "POST", path: "/api/provider-management/accounts/pa_0000000000000000000000000", origin: ORIGIN, csrf: vpw.csrf, cookie: cookieOf(vpw.token) });
  check("decide admin mutation + VIEWER -> DENY 403 FORBIDDEN", viewerMut.decision === "DENY" && viewerMut.status === 403);
  // a non-strong admin mutation with the MFA session still ALLOWs (admin + member)
  const adminMut = await authorize.decide({ method: "POST", path: "/api/provider-management/accounts/pa_0000000000000000000000000", origin: ORIGIN, csrf: totp.csrf, cookie: cookieOf(totp.token) });
  check("decide admin mutation + MFA -> ALLOW", adminMut.decision === "ALLOW");

  // ---- revoked / expired sessions fail closed on the PDP path ----
  await tx(async (c) => { await setAuthContext(c, { userId: owner.id }); await userSessionRepository.revokeSession(c, { sessionId: (await svc.resolveSession({ sessionToken: totp.token })).context.sessionId, userId: owner.id, reason: "LOGOUT" }); });
  const azRevoked = await svc.resolveAuthorization({ sessionToken: totp.token, targetWorkspaceId: ws.id });
  check("REVOKED session -> resolveAuthorization {ok:false}", azRevoked.ok === false);
  const expired = await mkSession({ userId: owner.id, wsId: ws.id, authStrength: "MFA_TOTP", mfa: true, absMs: clock - 1000 });
  const azExpired = await svc.resolveAuthorization({ sessionToken: expired.token, targetWorkspaceId: ws.id });
  check("EXPIRED session -> resolveAuthorization {ok:false}", azExpired.ok === false);

  // ---- PLATFORM PDP branch (Boss Manager authorization) ----
  const PLAT = { method: "GET", path: "/api/platform/customers" };
  // owner (fresh MFA session) is NOT a platform admin yet -> platform surface hidden as 404
  const preGrant = await mkSession({ userId: owner.id, wsId: ws.id, authStrength: "MFA_TOTP", mfa: true });
  const notPlat = await authorize.decide({ ...PLAT, cookie: cookieOf(preGrant.token) });
  check("PLATFORM: non-platform (even MFA) session -> 404 (surface hidden)", notPlat.decision === "DENY" && notPlat.status === 404);
  // grant the owner PLATFORM_OWNER -> now allowed with the MFA session
  await tx((c) => platformRepository.grantPlatformRole(c, { userId: owner.id, role: "PLATFORM_OWNER", grantedBy: owner.id }));
  // owner's earlier MFA session was revoked in the revoke test; mint a fresh MFA + a password session
  const powner = await mkSession({ userId: owner.id, wsId: ws.id, authStrength: "MFA_TOTP", mfa: true });
  const ppw = await mkSession({ userId: owner.id, wsId: ws.id, authStrength: "PASSWORD", mfa: false });
  const platOk = await authorize.decide({ ...PLAT, cookie: cookieOf(powner.token) });
  check("PLATFORM: PLATFORM_OWNER + MFA -> ALLOW", platOk.decision === "ALLOW" && platOk.context.platformRole === "PLATFORM_OWNER");
  const platNoMfa = await authorize.decide({ ...PLAT, cookie: cookieOf(ppw.token) });
  check("PLATFORM: platform admin WITHOUT MFA -> DENY (resolveSession gates OWNER pw, or REAUTH)", platNoMfa.decision === "DENY");
  // a VIEWER (non-platform) session -> 404 (hidden)
  const platViewer = await authorize.decide({ ...PLAT, cookie: cookieOf(vpw.token) });
  check("PLATFORM: non-platform VIEWER -> 404", platViewer.decision === "DENY" && platViewer.status === 404);
  // PLATFORM_SUPPORT is read-only: grant viewer SUPPORT, MFA session, mutation -> FORBIDDEN
  await tx((c) => platformRepository.grantPlatformRole(c, { userId: viewer.id, role: "PLATFORM_SUPPORT", grantedBy: owner.id }));
  const vmfa = await mkSession({ userId: viewer.id, wsId: ws.id, authStrength: "MFA_TOTP", mfa: true });
  const supRead = await authorize.decide({ ...PLAT, cookie: cookieOf(vmfa.token) });
  check("PLATFORM: PLATFORM_SUPPORT + MFA read -> ALLOW", supRead.decision === "ALLOW");
  const supMut = await authorize.decide({ method: "POST", path: "/api/platform/customers", origin: ORIGIN, csrf: vmfa.csrf, cookie: cookieOf(vmfa.token) });
  check("PLATFORM: PLATFORM_SUPPORT mutation -> DENY 403 FORBIDDEN (read-only)", supMut.decision === "DENY" && supMut.status === 403);

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}

main().then(() => {
  console.log(`\nStep 5C.29 §Q1 authstrength PDP: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
