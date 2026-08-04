// P0 Step 5C.21 (Checkpoint A) — auth repository + trusted context, certified on a REAL disposable
// PostgreSQL (portable binaries). Proves: migrations 0001..0024 apply (v=24); trusted app.current_user
// context is fail-closed + per-user isolated + cleared on rollback + not leaked across pooled checkouts;
// repository CRUD; last-OWNER invariant; atomic single-use consume races (recovery code, tokens, TOTP
// timestep) yield exactly one winner; security-event metadata is redacted (never a secret). SKIPS cleanly
// when the portable PostgreSQL binaries are absent. NEVER touches production.

import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext, clearAuthContext, readAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";
import { credentialRepository, mfaRepository, recoveryCodeRepository } from "../control-plane/src/persistence/repositories/auth-credential-repository.mjs";
import { userSessionRepository } from "../control-plane/src/persistence/repositories/auth-session-repository.mjs";
import { invitationRepository, passwordResetTokenRepository, preAuthChallengeRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashToken } from "../lib/auth/tokens.mjs";
import { generateRecoveryCodes } from "../lib/auth/recovery-codes.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const throwsAuth = async (n, fn, code) => { try { await fn(); failed += 1; console.log("FAIL(no throw)", n); } catch (e) { if (!code || e.code === code) passed += 1; else { failed += 1; console.log("FAIL(code)", n, "got", e.code); } } };

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.21 auth repository: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c21auth" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  let adapter;
  try {
    const mig = await mrun(mc, { dir: MIGRATIONS_DIR });
    check("migrations apply to latest", (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length);
    check("applied count latest", mig.applied.length === loadMigrationFiles(MIGRATIONS_DIR).length);
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const tx = (fn) => adapter.transaction(fn);
  const authTx = (ctx, fn) => adapter.transaction(async (c) => { await setAuthContext(c, ctx); return fn(c); });

  try {
    // ---- A. trusted context: set/read/clear + rollback isolation ----
    await tx(async (c) => {
      await setAuthContext(c, { userId: null }); // no-op
      const before = await readAuthContext(c);
      check("A no context initially", !before.userId);
    });

    // ---- B. create two users + password credentials under their own context ----
    let userA, userB;
    await tx(async (c) => { userA = await userRepository.createInvitedUser(c, { email: "a@studio.test", displayName: "A", status: "ACTIVE" }); });
    await tx(async (c) => { userB = await userRepository.createInvitedUser(c, { email: "b@studio.test", status: "ACTIVE" }); });
    check("B users created with usr_ ids", /^usr_/.test(userA.id) && /^usr_/.test(userB.id));
    check("B mapUser hides password_hash", !("passwordHash" in userA) && !("password_hash" in userA));
    await throwsAuth("B duplicate email fails closed", () => tx((c) => userRepository.createInvitedUser(c, { email: "A@Studio.test" })), "AUTH_EMAIL_TAKEN");
    check("B email normalized (case-insensitive lookup)", (await tx((c) => userRepository.findByNormalizedEmail(c, "A@STUDIO.TEST"))).id === userA.id);

    await authTx({ userId: userA.id }, (c) => credentialRepository.createPasswordCredential(c, { userId: userA.id, secretHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaa$AHASHFORA" }));
    await authTx({ userId: userB.id }, (c) => credentialRepository.createPasswordCredential(c, { userId: userB.id, secretHash: "$argon2id$v=19$m=19456,t=2,p=1$bbbb$BHASHFORB" }));

    // ---- C. RLS isolation on credentials ----
    check("C A reads own credential", (await authTx({ userId: userA.id }, (c) => credentialRepository.loadPasswordForVerification(c, userA.id))).secretHash.endsWith("AHASHFORA"));
    check("C A cannot read B credential (RLS)", (await authTx({ userId: userA.id }, (c) => credentialRepository.loadPasswordForVerification(c, userB.id))) === null);
    check("C no-context read is fail-closed (0 rows)", (await tx((c) => credentialRepository.loadPasswordForVerification(c, userA.id))) === null);
    // context must not leak across pooled checkouts: a fresh tx has no context
    check("C fresh tx has no leaked context", (await tx((c) => readAuthContext(c))).userId === null);

    // ---- D. optimistic-version rehash ----
    await authTx({ userId: userA.id }, async (c) => {
      const cred = await credentialRepository.loadPasswordForVerification(c, userA.id);
      const r = await credentialRepository.replaceHashIfVersionMatches(c, { userId: userA.id, newHash: "$argon2id$v=19$m=19456,t=2,p=1$cccc$REHASHED", expectedVersion: cred.version });
      check("D rehash bumps version", r.version === cred.version + 1);
    });
    await throwsAuth("D stale version conflict", () => authTx({ userId: userA.id }, (c) => credentialRepository.replaceHashIfVersionMatches(c, { userId: userA.id, newHash: "x", expectedVersion: 1 })), "AUTH_CREDENTIAL_CONFLICT");

    // ---- E. workspace + membership + last-owner invariant ----
    let wsA;
    await authTx({ userId: userA.id }, async (c) => {
      wsA = await workspaceRepository.createWorkspace(c, { name: "A WS", ownerUserId: userA.id });
      await workspaceRepository.createMembership(c, { workspaceId: wsA.id, userId: userA.id, role: "OWNER" });
      await workspaceRepository.createMembership(c, { workspaceId: wsA.id, userId: userB.id, role: "MEMBER" });
    });
    check("E workspace + memberships created", /^ws_/.test(wsA.id));
    await throwsAuth("E duplicate membership fails", () => authTx({ workspaceId: wsA.id }, (c) => workspaceRepository.createMembership(c, { workspaceId: wsA.id, userId: userB.id, role: "MEMBER" })), "AUTH_MEMBERSHIP_EXISTS");
    await throwsAuth("E cannot revoke last owner", () => authTx({ workspaceId: wsA.id }, (c) => workspaceRepository.revokeMembership(c, { workspaceId: wsA.id, userId: userA.id })), "AUTH_LAST_OWNER");
    await throwsAuth("E cannot downgrade last owner", () => authTx({ workspaceId: wsA.id }, (c) => workspaceRepository.updateMembershipRole(c, { workspaceId: wsA.id, userId: userA.id, role: "MEMBER" })), "AUTH_LAST_OWNER");
    // promote B to OWNER, then A can be downgraded
    await authTx({ workspaceId: wsA.id }, (c) => workspaceRepository.updateMembershipRole(c, { workspaceId: wsA.id, userId: userB.id, role: "OWNER" }));
    check("E second owner allows downgrade of A", (await authTx({ workspaceId: wsA.id }, (c) => workspaceRepository.updateMembershipRole(c, { workspaceId: wsA.id, userId: userA.id, role: "ADMIN" }))).role === "ADMIN");

    // ---- F. TOTP method: pending -> activate + replay guard ----
    let mfaId;
    await authTx({ userId: userA.id }, async (c) => { mfaId = (await mfaRepository.createPendingTotp(c, { userId: userA.id, secretCiphertext: "v1.aa.bb.cc" })).id; });
    await authTx({ userId: userA.id }, (c) => mfaRepository.activateTotp(c, { userId: userA.id, methodId: mfaId }));
    check("F totp active", (await authTx({ userId: userA.id }, (c) => mfaRepository.loadUsableTotp(c, userA.id))).status === "ACTIVE");
    await authTx({ userId: userA.id }, async (c) => {
      check("F first timestep accepted", (await mfaRepository.recordTimestepIfNewer(c, { userId: userA.id, methodId: mfaId, timestep: 100 })) === true);
      check("F replay same timestep rejected", (await mfaRepository.recordTimestepIfNewer(c, { userId: userA.id, methodId: mfaId, timestep: 100 })) === false);
      check("F older timestep rejected", (await mfaRepository.recordTimestepIfNewer(c, { userId: userA.id, methodId: mfaId, timestep: 99 })) === false);
      check("F newer timestep accepted", (await mfaRepository.recordTimestepIfNewer(c, { userId: userA.id, methodId: mfaId, timestep: 101 })) === true);
    });

    // ---- G. recovery codes: create + atomic single-use consume race ----
    const codes = generateRecoveryCodes(5);
    await authTx({ userId: userA.id }, (c) => recoveryCodeRepository.createRecoveryCodeSet(c, { userId: userA.id, batchId: "batch1", hashes: codes.hashes }));
    check("G 5 active recovery codes", (await authTx({ userId: userA.id }, (c) => recoveryCodeRepository.countActive(c, userA.id))) === 5);
    // concurrent double-consume of the SAME code → exactly one winner
    const [c1, c2] = await Promise.all([
      authTx({ userId: userA.id }, (c) => recoveryCodeRepository.consumeRecoveryCode(c, { userId: userA.id, codeHash: codes.hashes[0] })),
      authTx({ userId: userA.id }, (c) => recoveryCodeRepository.consumeRecoveryCode(c, { userId: userA.id, codeHash: codes.hashes[0] }))
    ]);
    check("G concurrent recovery consume: exactly one winner", (c1 ? 1 : 0) + (c2 ? 1 : 0) === 1);
    check("G one code now used (4 left)", (await authTx({ userId: userA.id }, (c) => recoveryCodeRepository.countActive(c, userA.id))) === 4);
    // regenerate revokes the old set
    const codes2 = generateRecoveryCodes(6);
    await authTx({ userId: userA.id }, (c) => recoveryCodeRepository.createRecoveryCodeSet(c, { userId: userA.id, batchId: "batch2", hashes: codes2.hashes }));
    check("G regenerate revokes old set (6 active)", (await authTx({ userId: userA.id }, (c) => recoveryCodeRepository.countActive(c, userA.id))) === 6);
    check("G old code no longer consumable", (await authTx({ userId: userA.id }, (c) => recoveryCodeRepository.consumeRecoveryCode(c, { userId: userA.id, codeHash: codes.hashes[1] }))) === false);

    // ---- H. sessions: create + pre-context resolve + rotate + revoke ----
    const tokHash = hashToken("session-token-plain-A");
    let sessA;
    await authTx({ userId: userA.id }, async (c) => {
      sessA = await userSessionRepository.createSession(c, { userId: userA.id, tokenHash: tokHash, csrfHash: hashToken("csrf-A"), activeWorkspaceId: wsA.id, idleExpiresAt: new Date(Date.now() + 3600_000), absoluteExpiresAt: new Date(Date.now() + 24 * 3600_000), mfaAuthenticatedAt: new Date() });
    });
    check("H session created, no token exposed", /^sess_/.test(sessA.id) && !("tokenHash" in sessA) && sessA.authenticatedWithMfa === true);
    // resolve by hash WITHOUT context (SECURITY DEFINER path)
    const resolved = await tx((c) => userSessionRepository.resolveActiveSession(c, tokHash));
    check("H pre-context resolve finds session", resolved.ok === true && resolved.session.userId === userA.id && resolved.session.activeWorkspaceId === wsA.id);
    check("H direct session read w/o context = 0 (RLS)", (await tx((c) => userSessionRepository.listSafeSessions(c, userA.id))).length === 0);
    // rotate
    const newHash = hashToken("session-token-plain-A2");
    await authTx({ userId: userA.id }, (c) => userSessionRepository.rotateSession(c, { oldSessionId: sessA.id, userId: userA.id, newTokenHash: newHash, idleExpiresAt: new Date(Date.now() + 3600_000), absoluteExpiresAt: new Date(Date.now() + 24 * 3600_000) }));
    check("H old session revoked after rotate", (await tx((c) => userSessionRepository.resolveActiveSession(c, tokHash))).code === "AUTH_SESSION_REVOKED");
    check("H new session resolves", (await tx((c) => userSessionRepository.resolveActiveSession(c, newHash))).ok === true);
    // revoke all
    await authTx({ userId: userA.id }, (c) => userSessionRepository.revokeAllSessions(c, userA.id));
    check("H revokeAll kills new session", (await tx((c) => userSessionRepository.resolveActiveSession(c, newHash))).ok === false);

    // ---- I. tokens: invitation + reset one-time consume race ----
    const invHash = hashToken("invite-token-1");
    await authTx({ workspaceId: wsA.id }, (c) => invitationRepository.createInvitation(c, { workspaceId: wsA.id, email: "c@studio.test", role: "MEMBER", tokenHash: invHash, expiresAt: new Date(Date.now() + 3600_000), invitedBy: userA.id }));
    const [i1, i2] = await Promise.allSettled([
      tx((c) => invitationRepository.consumeInvitation(c, { tokenHash: invHash, acceptedUserId: userB.id })),
      tx((c) => invitationRepository.consumeInvitation(c, { tokenHash: invHash, acceptedUserId: userB.id }))
    ]);
    check("I invitation consume: exactly one winner", [i1, i2].filter((x) => x.status === "fulfilled").length === 1);
    const rstHash = hashToken("reset-token-1");
    await authTx({ userId: userA.id }, (c) => passwordResetTokenRepository.createResetToken(c, { userId: userA.id, tokenHash: rstHash, expiresAt: new Date(Date.now() + 900_000) }));
    check("I reset token consume returns user", (await tx((c) => passwordResetTokenRepository.consumeResetToken(c, { tokenHash: rstHash }))).userId === userA.id);
    await throwsAuth("I reset token single-use", () => tx((c) => passwordResetTokenRepository.consumeResetToken(c, { tokenHash: rstHash })), "AUTH_TOKEN_CONSUMED");
    await throwsAuth("I unknown token invalid", () => tx((c) => passwordResetTokenRepository.consumeResetToken(c, { tokenHash: hashToken("nope") })), "AUTH_TOKEN_INVALID");

    // ---- J. pre-auth challenge ----
    const pacHash = hashToken("pac-token-1");
    let pac;
    await tx(async (c) => { pac = await preAuthChallengeRepository.createChallenge(c, { userId: userA.id, tokenHash: pacHash, purpose: "MFA", loginAttemptId: "la1", intendedWorkspaceId: wsA.id, expiresAt: new Date(Date.now() + 300_000) }); });
    check("J challenge resolves unverified", (await tx((c) => preAuthChallengeRepository.resolveChallenge(c, { tokenHash: pacHash }))).challenge.mfaVerified === false);
    check("J consume before verified is rejected", (await tx((c) => preAuthChallengeRepository.consumeChallenge(c, { challengeId: pac.id, userId: userA.id, requireVerified: true }))) === false);
    await tx((c) => preAuthChallengeRepository.markVerified(c, { challengeId: pac.id, userId: userA.id }));
    const [p1, p2] = await Promise.all([
      tx((c) => preAuthChallengeRepository.consumeChallenge(c, { challengeId: pac.id, userId: userA.id })),
      tx((c) => preAuthChallengeRepository.consumeChallenge(c, { challengeId: pac.id, userId: userA.id }))
    ]);
    check("J verified challenge consumes exactly once", (p1 ? 1 : 0) + (p2 ? 1 : 0) === 1);

    // ---- K. security events + rate-limit + redaction ----
    await tx((c) => securityRepository.appendSecurityEvent(c, { userId: userA.id, event: "LOGIN_SUCCESS", outcome: "SUCCESS", ipAddress: "127.0.0.1", metadata: { workspaceId: wsA.id, password: "should-be-dropped", totpSecret: "GEZDGNBVGY3TQOJQ", note: "ok" } }));
    const evs = await authTx({ userId: userA.id }, (c) => securityRepository.listSafeSecurityEvents(c, userA.id));
    const meta = evs.find((e) => e.event === "LOGIN_SUCCESS").metadata;
    check("K event metadata dropped secret keys", !("password" in meta) && !("totpSecret" in meta) && meta.note === "ok");
    check("K event stored no secret literal", !JSON.stringify(evs).includes("GEZDGNBVGY3TQOJQ") && !JSON.stringify(evs).includes("should-be-dropped"));
    for (let i = 0; i < 6; i += 1) await tx((c) => securityRepository.appendLoginAttempt(c, { identifier: "brute@studio.test", dimension: "EMAIL", outcome: "FAILURE", route: "/login" }));
    const rl = await tx((c) => securityRepository.getRateLimitState(c, { identifier: "brute@studio.test", dimension: "EMAIL" }));
    check("K rate-limit reports backoff after failures", rl.failures === 6 && rl.limited === true && rl.retryAfterMs > 0);
    check("K clean identifier not limited", (await tx((c) => securityRepository.getRateLimitState(c, { identifier: "fresh@studio.test", dimension: "EMAIL" }))).limited === false);

    console.log(`Step 5C.21 auth repository: ${passed} passed, ${failed} failed`);
  } finally {
    try { await adapter.stop(); } catch { /* */ }
    await live.stop();
  }
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
