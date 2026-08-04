// P0 Step 5C.21B — AuthService login/pre-auth/MFA/session state machine, certified on a REAL disposable
// PostgreSQL with REAL Argon2id + RFC-6238 TOTP crypto and a FAKE (monotonic) CLOCK. Proves the whole
// matrix: generic failure (no enumeration), no session before MFA, active-TOTP completion + replay guard,
// opaque session issue/resolve/rotate/revoke, idle+absolute expiry + touch throttle, live role
// re-resolution (revoked membership + MFA-escalation), workspace switch, password change (revoke others +
// rotate), rate-limit, audit redaction (no secret persisted/returned), and the key concurrency races
// (exactly one winner). SKIPS when portable PostgreSQL is absent. NEVER touches production.

import { Client } from "pg";
import { hash as argonHash, Algorithm } from "@node-rs/argon2";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { createAuthService } from "../control-plane/src/auth/auth-service.mjs";
import { AUTH_CONFIG_DEFAULTS } from "../control-plane/src/auth/auth-config.mjs";
import { containsLikelySecret } from "../control-plane/src/auth/redact.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";
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

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.21B auth service: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c21svc" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  let adapter;
  try {
    const mig = await mrun(mc, { dir: MIGRATIONS_DIR });
    check("migrations apply to latest", (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length);
    check("applied count latest", mig.applied.length === loadMigrationFiles(MIGRATIONS_DIR).length);
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();

  let clock = Date.parse("2026-07-23T12:00:00.000Z"); // fake clock — only ever moves FORWARD
  const advance = (ms) => { clock += ms; };
  const testKey = generateSecretBoxKey();
  const wsMfaPolicy = new Set();
  const svc = createAuthService({
    persistence: adapter, setAuthContext,
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository, reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, security: securityRepository },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy,
    generateToken, hashToken, verifyTotp, decryptTotpSecret: (ct) => decryptSecret(ct, testKey),
    generateTotpSecret, otpauthUrl, encryptTotpSecret: (s) => encryptSecret(s, testKey), generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash,
    clock: () => clock, config: AUTH_CONFIG_DEFAULTS, workspaceMfaPolicy: (wsId) => wsMfaPolicy.has(wsId)
  });

  const tx = (fn) => adapter.transaction(fn);
  const seedUser = (email, password, { status = "ACTIVE", weak = false } = {}) => tx(async (c) => {
    const u = await userRepository.createInvitedUser(c, { email, status });
    await setAuthContext(c, { userId: u.id });
    const h = weak ? await argonHash(password, { algorithm: Algorithm.Argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 }) : await hashPassword(password);
    await credentialRepository.createPasswordCredential(c, { userId: u.id, secretHash: h, params: ARGON2_PARAMS });
    return u;
  });
  const seedWs = (ownerUserId, name) => tx(async (c) => { await setAuthContext(c, { userId: ownerUserId }); const ws = await workspaceRepository.createWorkspace(c, { name, ownerUserId }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: ownerUserId, role: "OWNER" }); return ws; });
  const addMember = (wsId, userId, role) => tx(async (c) => { await setAuthContext(c, { workspaceId: wsId }); return workspaceRepository.createMembership(c, { workspaceId: wsId, userId, role }); });
  const setRole = (wsId, userId, role) => tx(async (c) => { await setAuthContext(c, { workspaceId: wsId }); return workspaceRepository.updateMembershipRole(c, { workspaceId: wsId, userId, role }); });
  const activateTotp = (userId, secret) => tx(async (c) => { await setAuthContext(c, { userId }); const m = await mfaRepository.createPendingTotp(c, { userId, secretCiphertext: encryptSecret(secret, testKey) }); await mfaRepository.activateTotp(c, { userId, methodId: m.id }); });
  const sessionsOf = (userId) => tx(async (c) => { await setAuthContext(c, { userId }); return userSessionRepository.listSafeSessions(c, userId); });
  const noSecret = (obj) => !containsLikelySecret(JSON.stringify(obj));
  // Complete an MFA login using a FRESH timestep (advance 30s so the replay guard never rejects a new login).
  const completeMfaFresh = async (challengeToken, secret, extra = {}) => { advance(30_000); return svc.completeMfaLogin({ challengeToken, code: generateTotp(secret, { nowMs: clock }), ...extra }); };

  try {
    const owner = await seedUser("owner@studio.test", "owner-pass-123456");
    const wsA = await seedWs(owner.id, "WS A");
    const member = await seedUser("member@studio.test", "member-pass-123456");
    await addMember(wsA.id, member.id, "MEMBER");

    // ===== A. beginLogin generic failure + no-MFA success =====
    check("A wrong password -> AUTHENTICATION_FAILED", (await svc.beginLogin({ email: "member@studio.test", password: "wrong", ip: "10.0.0.1" })).result === "AUTHENTICATION_FAILED");
    check("A nonexistent user -> same generic failure", (await svc.beginLogin({ email: "ghost@studio.test", password: "whatever-123456", ip: "10.0.0.1" })).result === "AUTHENTICATION_FAILED");
    const ok = await svc.beginLogin({ email: "member@studio.test", password: "member-pass-123456", ip: "10.0.0.2" });
    check("A member (no MFA) -> SESSION_ISSUED", ok.result === "SESSION_ISSUED" && ok.ok === true);
    check("A token returned once; no token-hash/secret in result", typeof ok.sessionToken === "string" && !JSON.stringify(ok).includes(hashToken(ok.sessionToken)) && noSecret({ ...ok, sessionToken: "", csrfToken: "" }));
    check("A session not MFA-authenticated", ok.session.authenticatedWithMfa === false);

    // ===== B. disabled user =====
    const disabled = await seedUser("disabled@studio.test", "disabled-pass-123456", { status: "DISABLED" });
    await addMember(wsA.id, disabled.id, "MEMBER");
    check("B disabled user -> generic failure", (await svc.beginLogin({ email: "disabled@studio.test", password: "disabled-pass-123456" })).result === "AUTHENTICATION_FAILED");

    // ===== C. OWNER requires MFA =====
    const ob1 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456", ip: "10.0.0.3" });
    check("C OWNER without TOTP -> MFA_ENROLLMENT_REQUIRED (no session)", ob1.result === "MFA_ENROLLMENT_REQUIRED" && !ob1.sessionToken && typeof ob1.challengeToken === "string");
    const ownerSecret = generateTotpSecret();
    await activateTotp(owner.id, ownerSecret);
    const ob2 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456", ip: "10.0.0.3" });
    check("C OWNER with active TOTP -> MFA_REQUIRED (no session)", ob2.result === "MFA_REQUIRED" && typeof ob2.challengeToken === "string" && !ob2.sessionToken);
    const mfaOk = await completeMfaFresh(ob2.challengeToken, ownerSecret, { ip: "10.0.0.3" });
    check("C completeMfaLogin correct -> SESSION_ISSUED (mfa=true)", mfaOk.result === "SESSION_ISSUED" && mfaOk.session.authenticatedWithMfa === true);
    check("C mfa result carries no secret", noSecret({ ...mfaOk, sessionToken: "", csrfToken: "" }));
    const ob3 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    check("C MFA wrong code -> generic failure", (await svc.completeMfaLogin({ challengeToken: ob3.challengeToken, code: "000000" })).result === "AUTHENTICATION_FAILED");
    const ob4 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    const mfaOk2 = await completeMfaFresh(ob4.challengeToken, ownerSecret);
    check("C MFA correct after wrong -> SESSION_ISSUED", mfaOk2.result === "SESSION_ISSUED");
    check("C replay of consumed challenge -> fail", (await svc.completeMfaLogin({ challengeToken: ob4.challengeToken, code: generateTotp(ownerSecret, { nowMs: clock }) })).result === "AUTHENTICATION_FAILED");
    const ob5 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    advance(AUTH_CONFIG_DEFAULTS.preAuthChallengeTtlMs + 1000);
    check("C expired challenge -> fail", (await svc.completeMfaLogin({ challengeToken: ob5.challengeToken, code: generateTotp(ownerSecret, { nowMs: clock }) })).result === "AUTHENTICATION_FAILED");

    // ===== D. resolveSession + expiry + touch + live role (member single-workspace here) =====
    const dTok = (await svc.beginLogin({ email: "member@studio.test", password: "member-pass-123456", ip: "10.1.0.1" })).sessionToken;
    const r1 = await svc.resolveSession({ sessionToken: dTok, requestId: "req1" });
    check("D resolve active -> SESSION_ACTIVE + context", r1.result === "SESSION_ACTIVE" && r1.context.userId === member.id && r1.context.workspaceId === wsA.id && r1.context.role === "MEMBER");
    check("D businessFn runs under app.current_user", (await svc.resolveSession({ sessionToken: dTok }, async (c) => (await c.query("SELECT current_setting('app.current_user',true) u")).rows[0].u)).value === member.id);
    advance(AUTH_CONFIG_DEFAULTS.session.idleTimeoutMs + 1000);
    check("D idle expiry -> SESSION_EXPIRED", (await svc.resolveSession({ sessionToken: dTok })).result === "SESSION_EXPIRED");
    const absTok = (await svc.beginLogin({ email: "member@studio.test", password: "member-pass-123456" })).sessionToken;
    advance(AUTH_CONFIG_DEFAULTS.session.absoluteTimeoutMs + 1000);
    check("D absolute expiry -> SESSION_EXPIRED", (await svc.resolveSession({ sessionToken: absTok })).result === "SESSION_EXPIRED");
    const tTok = (await svc.beginLogin({ email: "member@studio.test", password: "member-pass-123456" })).sessionToken;
    await svc.resolveSession({ sessionToken: tTok });
    const seen1 = (await sessionsOf(member.id))[0].lastSeenAt;
    advance(5000);
    await svc.resolveSession({ sessionToken: tTok });
    const seen2 = (await sessionsOf(member.id))[0].lastSeenAt;
    check("D touch throttled within window (last_seen unchanged)", String(seen1) === String(seen2));
    await setRole(wsA.id, member.id, "ADMIN");
    check("D role escalated to ADMIN + non-MFA session -> REAUTH_REQUIRED", (await svc.resolveSession({ sessionToken: tTok })).result === "REAUTH_REQUIRED");
    await setRole(wsA.id, member.id, "MEMBER");
    const revTok = (await svc.beginLogin({ email: "member@studio.test", password: "member-pass-123456" })).sessionToken;
    const wsB = await seedWs(owner.id, "WS B");
    await tx(async (c) => { await setAuthContext(c, { workspaceId: wsA.id }); await workspaceRepository.revokeMembership(c, { workspaceId: wsA.id, userId: member.id }); });
    check("D membership revoked -> SESSION_REVOKED", (await svc.resolveSession({ sessionToken: revTok })).result === "SESSION_REVOKED");
    await addMember(wsA.id, member.id, "MEMBER"); // restore

    // ===== E. switchWorkspace (member now multi-workspace) =====
    await addMember(wsB.id, member.id, "MEMBER");
    const eLogin = await svc.beginLogin({ email: "member@studio.test", password: "member-pass-123456", requestedWorkspaceId: wsA.id });
    const sw = await svc.switchWorkspace({ sessionToken: eLogin.sessionToken, targetWorkspaceId: wsB.id });
    check("E switchWorkspace -> new session on wsB", sw.result === "SESSION_ISSUED" && sw.session.activeWorkspaceId === wsB.id);
    check("E old session revoked after switch", (await svc.resolveSession({ sessionToken: eLogin.sessionToken })).ok === false);
    check("E new session active on wsB", (await svc.resolveSession({ sessionToken: sw.sessionToken })).context.workspaceId === wsB.id);
    check("E switch to non-member workspace -> fail", (await svc.switchWorkspace({ sessionToken: sw.sessionToken, targetWorkspaceId: "ws_0123456789ABCDEFGHJKMNPQRS" })).result === "AUTHENTICATION_FAILED");

    // ===== F. changePassword (cpUser, single-workspace) =====
    const cpUser = await seedUser("cp@studio.test", "old-pass-12345678"); await addMember(wsA.id, cpUser.id, "MEMBER");
    const cpS1 = (await svc.beginLogin({ email: "cp@studio.test", password: "old-pass-12345678" })).sessionToken;
    const cpS2 = (await svc.beginLogin({ email: "cp@studio.test", password: "old-pass-12345678" })).sessionToken;
    const chg = await svc.changePassword({ sessionToken: cpS1, currentPassword: "old-pass-12345678", newPassword: "new-pass-87654321" });
    check("F changePassword -> new session issued", chg.result === "SESSION_ISSUED");
    check("F other session revoked", (await svc.resolveSession({ sessionToken: cpS2 })).ok === false);
    check("F old current session rotated (dead)", (await svc.resolveSession({ sessionToken: cpS1 })).ok === false);
    check("F old password no longer works", (await svc.beginLogin({ email: "cp@studio.test", password: "old-pass-12345678" })).result === "AUTHENTICATION_FAILED");
    check("F new password works", (await svc.beginLogin({ email: "cp@studio.test", password: "new-pass-87654321" })).result === "SESSION_ISSUED");
    check("F wrong current password rejected", (await svc.changePassword({ sessionToken: chg.sessionToken, currentPassword: "nope", newPassword: "another-pass-123" })).result === "AUTHENTICATION_FAILED");
    check("F weak new password -> policy violation", (await svc.changePassword({ sessionToken: chg.sessionToken, currentPassword: "new-pass-87654321", newPassword: "short" })).result === "PASSWORD_POLICY_VIOLATION");

    // ===== G. logout / revoke / list (lg user single-workspace) =====
    const lg = await seedUser("lg@studio.test", "lg-pass-12345678"); await addMember(wsA.id, lg.id, "MEMBER");
    const lgS1 = (await svc.beginLogin({ email: "lg@studio.test", password: "lg-pass-12345678" })).sessionToken;
    const lgS2 = (await svc.beginLogin({ email: "lg@studio.test", password: "lg-pass-12345678" })).sessionToken;
    const list = await svc.listSessions({ sessionToken: lgS1 });
    check("G listSessions safe (2 active, no token)", list.sessions.length === 2 && noSecret(list.sessions) && !list.sessions.some((s) => "tokenHash" in s));
    await svc.logout({ sessionToken: lgS1 });
    check("G logout kills current only", (await svc.resolveSession({ sessionToken: lgS1 })).ok === false && (await svc.resolveSession({ sessionToken: lgS2 })).ok === true);
    await svc.logoutAll({ sessionToken: lgS2 });
    check("G logoutAll kills the rest", (await svc.resolveSession({ sessionToken: lgS2 })).ok === false);
    const victimTok = (await svc.beginLogin({ email: "lg@studio.test", password: "lg-pass-12345678" })).sessionToken;
    const victimId = (await svc.resolveSession({ sessionToken: victimTok })).context.sessionId;
    const attackerTok = (await svc.beginLogin({ email: "cp@studio.test", password: "new-pass-87654321" })).sessionToken;
    await svc.revokeSession({ sessionToken: attackerTok, targetSessionId: victimId });
    check("G cannot revoke another user's session", (await svc.resolveSession({ sessionToken: victimTok })).ok === true);

    // ===== H. rate limit (lg user) =====
    for (let i = 0; i < 11; i += 1) await svc.beginLogin({ email: "lg@studio.test", password: "wrong", ip: "9.9.9.9" });
    check("H after many failures -> RATE_LIMITED", (await svc.beginLogin({ email: "lg@studio.test", password: "lg-pass-12345678", ip: "9.9.9.9" })).result === "RATE_LIMITED");
    check("H clean identifier still works", (await svc.beginLogin({ email: "cp@studio.test", password: "new-pass-87654321", ip: "8.8.8.8" })).result === "SESSION_ISSUED");

    // ===== I. audit redaction (cpUser, not rate-limited) =====
    const evUser = (await svc.resolveSession({ sessionToken: (await svc.beginLogin({ email: "cp@studio.test", password: "new-pass-87654321", ip: "7.7.7.7" })).sessionToken })).context.userId;
    const events = await tx(async (c) => { await setAuthContext(c, { userId: evUser }); return securityRepository.listSafeSecurityEvents(c, evUser, { limit: 200 }); });
    check("I security events contain no secret", events.length > 0 && noSecret(events));

    // ===== J. concurrency =====
    const jb = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456", requestedWorkspaceId: wsA.id });
    advance(30_000);
    const jcode = generateTotp(ownerSecret, { nowMs: clock });
    const [j1, j2] = await Promise.all([
      svc.completeMfaLogin({ challengeToken: jb.challengeToken, code: jcode }),
      svc.completeMfaLogin({ challengeToken: jb.challengeToken, code: jcode })
    ]);
    check("J1 concurrent MFA completion -> exactly one SESSION_ISSUED", [j1, j2].filter((x) => x.result === "SESSION_ISSUED").length === 1);

    const weakU = await seedUser("weak@studio.test", "weak-pass-12345678", { weak: true }); await addMember(wsA.id, weakU.id, "MEMBER");
    const [w1, w2] = await Promise.all([
      svc.beginLogin({ email: "weak@studio.test", password: "weak-pass-12345678" }),
      svc.beginLogin({ email: "weak@studio.test", password: "weak-pass-12345678" })
    ]);
    check("J2 concurrent login both succeed despite rehash race", w1.result === "SESSION_ISSUED" && w2.result === "SESSION_ISSUED");
    const rehashed = await tx(async (c) => { await setAuthContext(c, { userId: weakU.id }); return credentialRepository.loadPasswordForVerification(c, weakU.id); });
    check("J2 credential rehashed to strong params", !needsRehash(rehashed.secretHash));

    await addMember(wsB.id, weakU.id, "MEMBER");
    const jS = (await svc.beginLogin({ email: "weak@studio.test", password: "weak-pass-12345678", requestedWorkspaceId: wsA.id })).sessionToken;
    const [rs1, rs2] = await Promise.all([
      svc.switchWorkspace({ sessionToken: jS, targetWorkspaceId: wsB.id }),
      svc.switchWorkspace({ sessionToken: jS, targetWorkspaceId: wsB.id })
    ]);
    let stillValid = 0;
    for (const u of [rs1, rs2]) if (u.ok && u.sessionToken && (await svc.resolveSession({ sessionToken: u.sessionToken })).ok) stillValid += 1;
    check("J3 concurrent rotation -> exactly one usable new session, old dead", stillValid === 1 && (await svc.resolveSession({ sessionToken: jS })).ok === false);

    console.log(`Step 5C.21B auth service: ${passed} passed, ${failed} failed`);
  } finally {
    try { await adapter.stop(); } catch { /* */ }
    await live.stop();
  }
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
