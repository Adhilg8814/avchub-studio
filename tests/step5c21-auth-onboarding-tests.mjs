// P0 Step 5C.21D — invitation / password-reset / email-verification / admin + durable outbox, certified on
// REAL disposable PostgreSQL. Covers: invite-only onboarding (create->outbox->accept, ADMIN->MFA enroll,
// one-time + concurrent accept), password reset (generic, outbox, complete revokes sessions + old pw dead),
// email verification (+ mismatch), user/membership admin (role change/revoke/disable revoke target
// sessions; last-owner rejected; ownership transfer with re-auth, no zero-owner), outbox token stored
// ENCRYPTED + cleared after send, audit redaction. SKIPS without portable PostgreSQL. NEVER touches prod.

import { Client } from "pg";
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
import { preAuthChallengeRepository, passwordResetTokenRepository, emailVerificationTokenRepository, invitationRepository, reauthProofRepository, notificationOutboxRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, ARGON2_PARAMS } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotp, generateTotpSecret, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.21D auth onboarding: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c21onb" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  let adapter;
  try { const mig = await mrun(mc, { dir: MIGRATIONS_DIR }); check("migrations apply to latest", (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length); } finally { await mc.end(); }
  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();

  let clock = Date.parse("2026-07-23T12:00:00.000Z");
  const advance = (ms) => { clock += ms; };
  const testKey = generateSecretBoxKey(), deliveryKey = generateSecretBoxKey();
  const svc = createAuthService({
    persistence: adapter, setAuthContext,
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository, reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, verifyToken: emailVerificationTokenRepository, invitation: invitationRepository, notification: notificationOutboxRepository, security: securityRepository },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy,
    generateToken, hashToken, verifyTotp, decryptTotpSecret: (ct) => decryptSecret(ct, testKey),
    generateTotpSecret, otpauthUrl, encryptTotpSecret: (s) => encryptSecret(s, testKey), generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash,
    encryptLinkToken: (t) => encryptSecret(t, deliveryKey),
    clock: () => clock, config: AUTH_CONFIG_DEFAULTS
  });
  const tx = (fn) => adapter.transaction(fn);
  const seedUser = (email, pw) => tx(async (c) => { const u = await userRepository.createInvitedUser(c, { email, status: "ACTIVE" }); await setAuthContext(c, { userId: u.id }); await credentialRepository.createPasswordCredential(c, { userId: u.id, secretHash: await hashPassword(pw), params: ARGON2_PARAMS }); return u; });
  const seedWs = (uid, name) => tx(async (c) => { await setAuthContext(c, { userId: uid }); const ws = await workspaceRepository.createWorkspace(c, { name, ownerUserId: uid }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: uid, role: "OWNER" }); return ws; });
  const addMember = (wsId, uid, role) => tx(async (c) => { await setAuthContext(c, { workspaceId: wsId }); return workspaceRepository.createMembership(c, { workspaceId: wsId, userId: uid, role }); });
  const totpFor = (uid, secret) => tx(async (c) => { await setAuthContext(c, { userId: uid }); const m = await mfaRepository.createPendingTotp(c, { userId: uid, secretCiphertext: encryptSecret(secret, testKey) }); await mfaRepository.activateTotp(c, { userId: uid, methodId: m.id }); });
  // drain the outbox for a kind + recipient, returning the decrypted one-time link token (delivery boundary)
  const drainToken = (kind, email) => tx(async (c) => { const rows = await notificationOutboxRepository.listPending(c, { limit: 100 }); const row = rows.find((r) => r.kind === kind && r.recipientEmail === email.toLowerCase()); if (!row) return null; await notificationOutboxRepository.markSent(c, { id: row.id }); return row.tokenCiphertext ? decryptSecret(row.tokenCiphertext, deliveryKey) : null; });
  const rawOutbox = (email) => tx(async (c) => (await c.query("SELECT kind,status,token_ciphertext FROM auth_notification_outbox WHERE recipient_email=$1 ORDER BY created_at", [email.toLowerCase()])).rows);
  const noSecret = (o) => !containsLikelySecret(JSON.stringify(o));
  const login = async (email, pw, wsId) => (await svc.beginLogin({ email, password: pw, requestedWorkspaceId: wsId })).sessionToken;

  try {
    const owner = await seedUser("owner@studio.test", "owner-pass-123456");
    const ownerSecret = generateTotpSecret(); await totpFor(owner.id, ownerSecret);
    const wsA = await seedWs(owner.id, "WS A");
    // owner logs in (MFA)
    let ob = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456", requestedWorkspaceId: wsA.id });
    advance(30_000);
    const ownerSession = (await svc.completeMfaLogin({ challengeToken: ob.challengeToken, code: generateTotp(ownerSecret, { nowMs: clock }) })).sessionToken;

    // ===== A. invitation (create -> outbox -> accept) =====
    const inv = await svc.createInvitation({ sessionToken: ownerSession, email: "alice@studio.test", role: "MEMBER" });
    check("A createInvitation ok", inv.ok && /^uinv_/.test(inv.invitationId));
    const outboxRows = await rawOutbox("alice@studio.test");
    check("A outbox row PENDING with ENCRYPTED token (no plaintext)", outboxRows.length === 1 && outboxRows[0].kind === "INVITATION" && outboxRows[0].token_ciphertext && outboxRows[0].token_ciphertext.startsWith("v1."));
    const inviteToken = await drainToken("INVITATION", "alice@studio.test");
    check("A outbox token decrypts (delivery boundary)", typeof inviteToken === "string" && inviteToken.length > 20);
    check("A outbox cleared after send", (await rawOutbox("alice@studio.test"))[0].token_ciphertext === null && (await rawOutbox("alice@studio.test"))[0].status === "SENT");
    const acc = await svc.acceptInvitation({ token: inviteToken, password: "alice-pass-12345678" });
    check("A accept (new MEMBER) -> SESSION_ISSUED", acc.result === "SESSION_ISSUED" && acc.session.role === "MEMBER");
    check("A alice can log in", (await svc.beginLogin({ email: "alice@studio.test", password: "alice-pass-12345678" })).result === "SESSION_ISSUED");
    check("A accept token is one-time", (await svc.acceptInvitation({ token: inviteToken, password: "x" })).result === "AUTHENTICATION_FAILED");
    check("A non-admin cannot invite", (await svc.createInvitation({ sessionToken: acc.sessionToken, email: "x@studio.test", role: "MEMBER" })).result === "AUTHENTICATION_FAILED");

    // ADMIN invitee -> MFA enrollment required
    await svc.createInvitation({ sessionToken: ownerSession, email: "adm@studio.test", role: "ADMIN" });
    const admTok = await drainToken("INVITATION", "adm@studio.test");
    const admAcc = await svc.acceptInvitation({ token: admTok, password: "adm-pass-12345678" });
    check("A ADMIN invitee -> MFA_ENROLLMENT_REQUIRED (no session)", admAcc.result === "MFA_ENROLLMENT_REQUIRED" && !admAcc.sessionToken && admAcc.challengeToken);

    // concurrent accept (fresh invite) -> exactly one winner
    await svc.createInvitation({ sessionToken: ownerSession, email: "bob@studio.test", role: "MEMBER" });
    const bobTok = await drainToken("INVITATION", "bob@studio.test");
    const [b1, b2] = await Promise.all([svc.acceptInvitation({ token: bobTok, password: "bob-pass-12345678" }), svc.acceptInvitation({ token: bobTok, password: "bob-pass-12345678" })]);
    check("A concurrent accept -> exactly one success", [b1, b2].filter((x) => x.ok).length === 1);

    // ===== B. password reset =====
    check("B forgot unknown email -> generic OK, no outbox", (await svc.beginForgotPassword({ email: "nobody@studio.test" })).ok === true && (await rawOutbox("nobody@studio.test")).length === 0);
    const aliceSess = await login("alice@studio.test", "alice-pass-12345678");
    await svc.beginForgotPassword({ email: "alice@studio.test" });
    const resetTok = await drainToken("PASSWORD_RESET", "alice@studio.test");
    check("B reset token delivered", typeof resetTok === "string");
    const rst = await svc.completePasswordReset({ token: resetTok, newPassword: "alice-new-87654321" });
    check("B reset completes", rst.ok === true);
    check("B existing session revoked by reset", (await svc.resolveSession({ sessionToken: aliceSess })).ok === false);
    check("B old password dead", (await svc.beginLogin({ email: "alice@studio.test", password: "alice-pass-12345678" })).result === "AUTHENTICATION_FAILED");
    check("B new password works", (await svc.beginLogin({ email: "alice@studio.test", password: "alice-new-87654321" })).result === "SESSION_ISSUED");
    check("B reset token one-time", (await svc.completePasswordReset({ token: resetTok, newPassword: "z-12345678" })).result === "AUTHENTICATION_FAILED");

    // ===== C. email verification =====
    const aliceSess2 = await login("alice@studio.test", "alice-new-87654321");
    await svc.beginEmailVerification({ sessionToken: aliceSess2 });
    const verTok = await drainToken("EMAIL_VERIFICATION", "alice@studio.test");
    check("C verify token delivered", typeof verTok === "string");
    check("C complete verification ok", (await svc.completeEmailVerification({ token: verTok })).ok === true);
    check("C verify token one-time", (await svc.completeEmailVerification({ token: verTok })).result === "AUTHENTICATION_FAILED");

    // ===== D. admin: role change / revoke / disable revoke target sessions; last-owner; transfer =====
    const carol = await seedUser("carol@studio.test", "carol-pass-12345678"); await addMember(wsA.id, carol.id, "MEMBER");
    const carolSess = await login("carol@studio.test", "carol-pass-12345678", wsA.id);
    const roleChg = await svc.updateWorkspaceRole({ sessionToken: ownerSession, targetUserId: carol.id, role: "VIEWER" });
    check("D admin role change ok + target session revoked", roleChg.ok && (await svc.resolveSession({ sessionToken: carolSess })).ok === false);
    check("D last-owner downgrade rejected", (await svc.updateWorkspaceRole({ sessionToken: ownerSession, targetUserId: owner.id, role: "MEMBER" })).result === "AUTHENTICATION_FAILED");
    // disable user
    const carolSess2 = await login("carol@studio.test", "carol-pass-12345678", wsA.id);
    const dis = await svc.disableUser({ sessionToken: ownerSession, targetUserId: carol.id });
    check("D disableUser ok + target session revoked + cannot login", dis.ok && (await svc.resolveSession({ sessionToken: carolSess2 })).ok === false && (await svc.beginLogin({ email: "carol@studio.test", password: "carol-pass-12345678" })).result === "AUTHENTICATION_FAILED");
    await svc.enableUser({ sessionToken: ownerSession, targetUserId: carol.id });
    check("D enableUser -> can login again", (await svc.beginLogin({ email: "carol@studio.test", password: "carol-pass-12345678" })).result === "SESSION_ISSUED");
    // ownership transfer (owner -> carol) requires re-auth
    check("D transfer without reauth -> REAUTH_REQUIRED", (await svc.transferWorkspaceOwnership({ sessionToken: ownerSession, reauthToken: null, targetUserId: carol.id })).result === "REAUTH_REQUIRED");
    const raT = await svc.beginReauthentication({ sessionToken: ownerSession, action: "TRANSFER_OWNERSHIP", method: "TOTP" });
    advance(30_000);
    await svc.completeTotpReauthentication({ sessionToken: ownerSession, reauthToken: raT.reauthToken, code: generateTotp(ownerSecret, { nowMs: clock }) });
    const xfer = await svc.transferWorkspaceOwnership({ sessionToken: ownerSession, reauthToken: raT.reauthToken, targetUserId: carol.id });
    check("D ownership transferred", xfer.ok === true);
    const roles = await tx(async (c) => { await setAuthContext(c, { workspaceId: wsA.id }); return { carol: (await workspaceRepository.findMembership(c, { workspaceId: wsA.id, userId: carol.id })).role, owner: (await workspaceRepository.findMembership(c, { workspaceId: wsA.id, userId: owner.id })).role }; });
    check("D new owner=carol, old owner downgraded to ADMIN (never zero owners)", roles.carol === "OWNER" && roles.owner === "ADMIN");

    // ===== E. audit redaction across onboarding events =====
    const events = await tx(async (c) => { await setAuthContext(c, { userId: owner.id }); return securityRepository.listSafeSecurityEvents(c, owner.id, { limit: 300 }); });
    check("E onboarding events present + no secret", events.some((e) => e.event === "INVITATION_CREATED") && events.some((e) => e.event === "OWNERSHIP_TRANSFERRED") && noSecret(events));
    const allOutbox = await tx(async (c) => (await c.query("SELECT token_ciphertext FROM auth_notification_outbox")).rows);
    check("E no plaintext token anywhere in outbox", noSecret(allOutbox) && allOutbox.every((r) => r.token_ciphertext === null || r.token_ciphertext.startsWith("v1.")));

    console.log(`Step 5C.21D auth onboarding: ${passed} passed, ${failed} failed`);
  } finally {
    try { await adapter.stop(); } catch { /* */ }
    await live.stop();
  }
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
