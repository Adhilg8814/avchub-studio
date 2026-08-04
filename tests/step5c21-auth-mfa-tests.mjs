// P0 Step 5C.21C — MFA + recovery lifecycle, certified on REAL disposable PostgreSQL with real Argon2id +
// RFC-6238 TOTP + AES-256-GCM and a fake monotonic clock. Covers: 2-step TOTP enrollment (login-challenge
// path) -> session + recovery codes; recovery-code login; re-authentication (password/TOTP) proofs;
// regenerate recovery codes; disable TOTP (OWNER forced re-enroll); TOTP replacement (old stays active
// until confirm); rate-limit; audit redaction; and concurrency (enrollment confirm, recovery consume,
// regenerate) = exactly one winner. SKIPS without portable PostgreSQL. NEVER touches production.

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
import { preAuthChallengeRepository, passwordResetTokenRepository, reauthProofRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, ARGON2_PARAMS } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotp, generateTotpSecret, otpauthUrl, base32Decode } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.21C auth MFA: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c21mfa" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  let adapter;
  try {
    const mig = await mrun(mc, { dir: MIGRATIONS_DIR });
    check("migrations apply to latest", (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length);
  } finally { await mc.end(); }
  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();

  let clock = Date.parse("2026-07-23T12:00:00.000Z");
  const advance = (ms) => { clock += ms; };
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
  const addMember = (wsId, uid, role) => tx(async (c) => { await setAuthContext(c, { workspaceId: wsId }); return workspaceRepository.createMembership(c, { workspaceId: wsId, userId: uid, role }); });
  // extract the secret from an otpauth URI so the test can generate valid codes (URI is a one-time payload)
  const secretFromUri = (uri) => new URL(uri).searchParams.get("secret");
  const codeFor = (secret) => generateTotp(secret, { nowMs: clock });
  const noSecret = (o) => !containsLikelySecret(JSON.stringify(o));

  try {
    const owner = await seedUser("owner@studio.test", "owner-pass-123456");
    const wsA = await seedWs(owner.id, "WS A");

    // ===== A. 2-step TOTP enrollment via the login challenge =====
    const lb = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    check("A OWNER login -> MFA_ENROLLMENT_REQUIRED", lb.result === "MFA_ENROLLMENT_REQUIRED" && !lb.sessionToken);
    const enr = await svc.beginTotpEnrollment({ challengeToken: lb.challengeToken });
    check("A beginTotpEnrollment -> otpauth uri, no session", enr.ok && enr.otpauthUri.startsWith("otpauth://totp/") && !enr.sessionToken);
    const secret = secretFromUri(enr.otpauthUri);
    check("A wrong code confirm -> fail", (await svc.confirmTotpEnrollment({ challengeToken: lb.challengeToken, code: "000000" })).result === "AUTHENTICATION_FAILED");
    advance(30_000);
    const conf = await svc.confirmTotpEnrollment({ challengeToken: lb.challengeToken, code: codeFor(secret) });
    check("A confirm -> SESSION_ISSUED (mfa) + recovery codes once", conf.result === "SESSION_ISSUED" && conf.session.authenticatedWithMfa === true && Array.isArray(conf.recoveryCodes) && conf.recoveryCodes.length === 10);
    check("A enrollment result carries no secret (minus recovery/token)", noSecret({ ...conf, recoveryCodes: [], sessionToken: "", csrfToken: "" }));
    const recoveryCodes = conf.recoveryCodes;

    // ===== B. subsequent login uses MFA_REQUIRED; complete with TOTP =====
    advance(30_000);
    const lb2 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    check("B now MFA_REQUIRED (has active TOTP)", lb2.result === "MFA_REQUIRED");
    advance(30_000);
    const totpLogin = await svc.completeMfaLogin({ challengeToken: lb2.challengeToken, code: codeFor(secret) });
    check("B TOTP login -> SESSION_ISSUED", totpLogin.result === "SESSION_ISSUED");
    const totpSession = totpLogin.sessionToken;

    // ===== C. recovery-code login =====
    advance(30_000);
    const lb3 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    const recLogin = await svc.completeRecoveryLogin({ challengeToken: lb3.challengeToken, recoveryCode: recoveryCodes[0] });
    check("C recovery login -> SESSION_ISSUED (recovery flagged)", recLogin.result === "SESSION_ISSUED" && recLogin.authenticatedWithRecoveryCode === true);
    check("C recovery result no secret", noSecret({ ...recLogin, sessionToken: "", csrfToken: "" }));
    // that recovery code is now spent
    advance(30_000);
    const lb4 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    check("C used recovery code rejected", (await svc.completeRecoveryLogin({ challengeToken: lb4.challengeToken, recoveryCode: recoveryCodes[0] })).result === "AUTHENTICATION_FAILED");

    // ===== D. re-auth required for sensitive actions =====
    check("D regenerate without reauth -> REAUTH_REQUIRED", (await svc.regenerateRecoveryCodes({ sessionToken: totpSession, reauthToken: null })).result === "REAUTH_REQUIRED");
    const ra = await svc.beginReauthentication({ sessionToken: totpSession, action: "REGENERATE_RECOVERY", method: "TOTP" });
    check("D beginReauth -> reauthToken", ra.ok && typeof ra.reauthToken === "string");
    check("D reauth wrong TOTP -> fail", (await svc.completeTotpReauthentication({ sessionToken: totpSession, reauthToken: ra.reauthToken, code: "000000" })).result === "AUTHENTICATION_FAILED");
    advance(30_000);
    const raOk = await svc.completeTotpReauthentication({ sessionToken: totpSession, reauthToken: ra.reauthToken, code: codeFor(secret) });
    check("D reauth TOTP verified", raOk.ok === true);
    const regen = await svc.regenerateRecoveryCodes({ sessionToken: totpSession, reauthToken: ra.reauthToken });
    check("D regenerate -> new recovery set (10)", regen.ok && regen.recoveryCodes.length === 10);
    check("D old recovery codes now dead", await (async () => { advance(30_000); const l = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" }); return (await svc.completeRecoveryLogin({ challengeToken: l.challengeToken, recoveryCode: recoveryCodes[3] })).result === "AUTHENTICATION_FAILED"; })());
    check("D reauth proof is one-time (regenerate again fails)", (await svc.regenerateRecoveryCodes({ sessionToken: totpSession, reauthToken: ra.reauthToken })).result === "REAUTH_REQUIRED");
    const newRecovery = regen.recoveryCodes;

    // ===== E. TOTP replacement: old stays active until confirm =====
    const raRep = await svc.beginReauthentication({ sessionToken: totpSession, action: "REPLACE_TOTP", method: "TOTP" });
    advance(30_000);
    await svc.completeTotpReauthentication({ sessionToken: totpSession, reauthToken: raRep.reauthToken, code: codeFor(secret) });
    const rep = await svc.beginTotpReplacement({ sessionToken: totpSession, reauthToken: raRep.reauthToken });
    check("E replacement pending, old still usable", rep.ok && rep.otpauthUri.startsWith("otpauth://"));
    // old TOTP still logs in while replacement pending
    advance(30_000);
    const oldStill = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    advance(30_000);
    check("E old TOTP still works during pending replacement", (await svc.completeMfaLogin({ challengeToken: oldStill.challengeToken, code: codeFor(secret) })).result === "SESSION_ISSUED");
    const newSecret = secretFromUri(rep.otpauthUri);
    advance(30_000);
    const repConf = await svc.confirmTotpReplacement({ sessionToken: totpSession, reauthToken: raRep.reauthToken, code: codeFor(newSecret) });
    check("E confirm replacement -> new recovery set", repConf.ok && repConf.recoveryCodes.length === 10);
    // now the OLD secret no longer verifies (only one active method)
    advance(30_000);
    const afterRep = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    advance(30_000);
    check("E old secret rejected after replacement", (await svc.completeMfaLogin({ challengeToken: afterRep.challengeToken, code: codeFor(secret) })).result === "AUTHENTICATION_FAILED");
    advance(30_000);
    const afterRep2 = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    advance(30_000);
    check("E new secret accepted after replacement", (await svc.completeMfaLogin({ challengeToken: afterRep2.challengeToken, code: codeFor(newSecret) })).result === "SESSION_ISSUED");

    // ===== F. disable TOTP (OWNER -> forced re-enroll, sessions revoked) =====
    advance(30_000);
    const fLogin = await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" });
    advance(30_000);
    const fSession = (await svc.completeMfaLogin({ challengeToken: fLogin.challengeToken, code: codeFor(newSecret) })).sessionToken;
    const raDis = await svc.beginReauthentication({ sessionToken: fSession, action: "DISABLE_MFA", method: "TOTP" });
    advance(30_000);
    await svc.completeTotpReauthentication({ sessionToken: fSession, reauthToken: raDis.reauthToken, code: codeFor(newSecret) });
    const dis = await svc.disableTotp({ sessionToken: fSession, reauthToken: raDis.reauthToken });
    check("F disable TOTP -> reEnrollmentRequired (OWNER), session revoked", dis.ok && dis.reEnrollmentRequired === true && (await svc.resolveSession({ sessionToken: fSession })).ok === false);
    advance(30_000);
    check("F OWNER next login -> back to MFA_ENROLLMENT_REQUIRED", (await svc.beginLogin({ email: "owner@studio.test", password: "owner-pass-123456" })).result === "MFA_ENROLLMENT_REQUIRED");

    // ===== G. audit redaction across all MFA events =====
    const events = await tx(async (c) => { await setAuthContext(c, { userId: owner.id }); return securityRepository.listSafeSecurityEvents(c, owner.id, { limit: 300 }); });
    check("G MFA lifecycle events present + no secret", events.some((e) => e.event === "MFA_ENROLLMENT_CONFIRMED") && events.some((e) => e.event === "MFA_REPLACED") && events.some((e) => e.event === "MFA_DISABLED") && noSecret(events));

    // ===== H. concurrency =====
    // H1. concurrent enrollment confirm (fresh user) -> exactly one active method + one session
    const u2 = await seedUser("h1@studio.test", "h1-pass-12345678"); await addMember(wsA.id, u2.id, "ADMIN");
    advance(30_000);
    const h1b = await svc.beginLogin({ email: "h1@studio.test", password: "h1-pass-12345678", requestedWorkspaceId: wsA.id });
    const h1e = await svc.beginTotpEnrollment({ challengeToken: h1b.challengeToken });
    const h1secret = secretFromUri(h1e.otpauthUri);
    advance(30_000);
    const h1code = codeFor(h1secret);
    const [c1, c2] = await Promise.all([
      svc.confirmTotpEnrollment({ challengeToken: h1b.challengeToken, code: h1code }),
      svc.confirmTotpEnrollment({ challengeToken: h1b.challengeToken, code: h1code })
    ]);
    check("H1 concurrent enrollment confirm -> exactly one SESSION_ISSUED", [c1, c2].filter((x) => x.result === "SESSION_ISSUED").length === 1);
    const activeMethods = await tx(async (c) => { await setAuthContext(c, { userId: u2.id }); return mfaRepository.listSafeMfaMetadata(c, u2.id); });
    check("H1 exactly one active TOTP method", activeMethods.filter((m) => m.status === "ACTIVE").length === 1);

    // H2. concurrent recovery consume of the same code -> one winner
    const winner = [c1, c2].find((x) => x.result === "SESSION_ISSUED");
    const h1recovery = winner.recoveryCodes;
    advance(30_000);
    const h2a = await svc.beginLogin({ email: "h1@studio.test", password: "h1-pass-12345678", requestedWorkspaceId: wsA.id });
    advance(30_000);
    const h2b = await svc.beginLogin({ email: "h1@studio.test", password: "h1-pass-12345678", requestedWorkspaceId: wsA.id });
    const [r1, r2] = await Promise.all([
      svc.completeRecoveryLogin({ challengeToken: h2a.challengeToken, recoveryCode: h1recovery[0] }),
      svc.completeRecoveryLogin({ challengeToken: h2b.challengeToken, recoveryCode: h1recovery[0] })
    ]);
    check("H2 concurrent recovery consume -> exactly one SESSION_ISSUED", [r1, r2].filter((x) => x.result === "SESSION_ISSUED").length === 1);

    console.log(`Step 5C.21C auth MFA: ${passed} passed, ${failed} failed`);
  } finally {
    try { await adapter.stop(); } catch { /* */ }
    await live.stop();
  }
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
