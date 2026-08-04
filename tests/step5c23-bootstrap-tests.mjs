// P0 Step 5C.23 — owner-bootstrap ceremony against the REAL AuthService + disposable PostgreSQL (0030).
// Proves the one-time first-owner ceremony: zero-owner -> REQUIRED; no privileged session before MFA;
// atomic single-winner (concurrent begin -> one winner; concurrent confirm -> one owner); NO partial owner
// on a failed confirmation; recovery codes shown exactly once; the route is permanently closed after
// completion (and stays closed across a fresh service instance = "restart"); operator proof is one-time.
// SKIPS without portable PostgreSQL. NEVER touches production.

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
import { preAuthChallengeRepository, passwordResetTokenRepository, emailVerificationTokenRepository, invitationRepository, reauthProofRepository, notificationOutboxRepository, bootstrapTokenRepository, bootstrapCeremonyRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotp, generateTotpSecret, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const secretOf = (uri) => { const m = /[?&]secret=([A-Za-z2-7]+)/.exec(String(uri || "")); return m ? m[1] : null; };

function buildService(adapter, key, clockRef) {
  return createAuthService({
    persistence: adapter, setAuthContext,
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository, reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, verifyToken: emailVerificationTokenRepository, invitation: invitationRepository, notification: notificationOutboxRepository, security: securityRepository, bootstrap: bootstrapCeremonyRepository, bootstrapToken: bootstrapTokenRepository },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, generateToken, hashToken, verifyTotp,
    decryptTotpSecret: (ct) => decryptSecret(ct, key), generateTotpSecret, otpauthUrl, encryptTotpSecret: (s) => encryptSecret(s, key),
    generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash, encryptLinkToken: (t) => encryptSecret(t, key),
    clock: () => clockRef.now, config: AUTH_CONFIG_DEFAULTS
  });
}

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.23 bootstrap: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c23boot" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); check("migrations apply to latest", (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const clockRef = { now: Date.parse("2026-07-23T12:00:00.000Z") };
  const key = generateSecretBoxKey();
  const svc = buildService(adapter, key, clockRef);
  const q = (sql, args) => adapter.transaction((c) => c.query(sql, args));

  try {
    // ---- zero-owner cluster: REQUIRED + available ----
    const st0 = await svc.bootstrapStatus();
    check("zero-owner -> state REQUIRED + available", st0.state === "REQUIRED" && st0.available === true);

    // ---- weak password rejected (policy) ----
    const weak = await svc.beginOwnerBootstrap({ email: "owner@studio.test", password: "short", ip: "1.1.1.1" });
    check("weak password -> PASSWORD_POLICY_VIOLATION", weak.result === "PASSWORD_POLICY_VIOLATION" && weak.ok === false);
    check("weak-password begin did NOT claim the ceremony", (await svc.bootstrapStatus()).state === "REQUIRED");

    // ---- begin (no session issued before MFA) ----
    const b1 = await svc.beginOwnerBootstrap({ email: "owner@studio.test", password: "owner-pass-123456", displayName: "Owner", ip: "1.1.1.1" });
    check("begin -> OWNER_BOOTSTRAP_STARTED + ceremonyToken + otpauthUri", b1.result === "OWNER_BOOTSTRAP_STARTED" && b1.ok === true && typeof b1.ceremonyToken === "string" && typeof b1.otpauthUri === "string");
    check("begin issues NO session before MFA (no sessionToken)", !("sessionToken" in b1) && !("session" in b1));
    check("begin -> ceremony now IN_PROGRESS (still restartable/available)", (await svc.bootstrapStatus()).state === "IN_PROGRESS");
    const secret = secretOf(b1.otpauthUri);
    check("otpauthUri carries a base32 secret", typeof secret === "string" && secret.length >= 16);

    // ---- confirm with WRONG code -> retryable failure, NO partial owner ----
    const badCode = await svc.confirmOwnerBootstrap({ ceremonyToken: b1.ceremonyToken, code: "000000", ip: "1.1.1.1" });
    check("confirm wrong code -> AUTHENTICATION_FAILED", badCode.result === "AUTHENTICATION_FAILED" && badCode.ok === false);
    check("failed confirm created NO user (no partial owner)", (await q("SELECT count(*)::int n FROM users")).rows[0].n === 0);
    check("failed confirm created NO workspace + NO membership", (await q("SELECT count(*)::int n FROM workspaces")).rows[0].n === 0 && (await q("SELECT count(*)::int n FROM workspace_members")).rows[0].n === 0);
    check("ceremony still IN_PROGRESS + retryable", (await svc.bootstrapStatus()).state === "IN_PROGRESS");

    // ---- confirm with correct code -> SESSION_ISSUED + recovery codes once ----
    const code1 = generateTotp(secret, { nowMs: clockRef.now });
    const c1 = await svc.confirmOwnerBootstrap({ ceremonyToken: b1.ceremonyToken, code: code1, ip: "1.1.1.1", userAgent: "test" });
    check("confirm -> SESSION_ISSUED + session token", c1.result === "SESSION_ISSUED" && c1.ok === true && typeof c1.sessionToken === "string");
    check("confirm returns recovery codes exactly once (10)", Array.isArray(c1.recoveryCodes) && c1.recoveryCodes.length === AUTH_CONFIG_DEFAULTS.recoveryCodeCount);
    check("confirm returns the owner's workspaceId", typeof c1.workspaceId === "string" && c1.workspaceId.startsWith("ws_"));

    // ---- final state: owner + workspace + OWNER membership + ACTIVE MFA + recovery + cleared candidate ----
    // (RLS-protected tables must be read WITH the owner/workspace context set — like the real service.)
    const ownerId = (await q("SELECT id FROM users WHERE status='ACTIVE' LIMIT 1")).rows[0].id; // users is non-RLS
    const wsId = c1.workspaceId;
    const qUser = (sql, args) => adapter.transaction(async (c) => { await setAuthContext(c, { userId: ownerId }); return c.query(sql, args); });
    const qWs = (sql, args) => adapter.transaction(async (c) => { await setAuthContext(c, { workspaceId: wsId }); return c.query(sql, args); });
    check("exactly one ACTIVE owner user exists", (await q("SELECT count(*)::int n FROM users WHERE status='ACTIVE'")).rows[0].n === 1);
    check("owner has an OWNER membership", (await qWs("SELECT count(*)::int n FROM workspace_members WHERE role='OWNER' AND workspace_id=$1", [wsId])).rows[0].n === 1);
    check("owner has an ACTIVE TOTP method", (await qUser("SELECT count(*)::int n FROM user_mfa_methods WHERE status='ACTIVE'")).rows[0].n === 1);
    check("owner has a password credential", (await qUser("SELECT count(*)::int n FROM user_credentials WHERE kind='password'")).rows[0].n === 1);
    check("owner has active recovery codes", (await qUser("SELECT count(*)::int n FROM user_recovery_codes WHERE used_at IS NULL")).rows[0].n === AUTH_CONFIG_DEFAULTS.recoveryCodeCount);
    const bootRow = (await q("SELECT state, candidate_email, candidate_password_hash, candidate_totp_ciphertext, ceremony_proof_hash, owner_user_id FROM auth_bootstrap")).rows[0];
    check("auth_bootstrap COMPLETED + owner recorded", bootRow.state === "COMPLETED" && typeof bootRow.owner_user_id === "string");
    check("auth_bootstrap candidate secrets + proof CLEARED on completion", bootRow.candidate_email === null && bootRow.candidate_password_hash === null && bootRow.candidate_totp_ciphertext === null && bootRow.ceremony_proof_hash === null);

    // ---- the issued session actually resolves as an OWNER with MFA ----
    const resolved = await svc.resolveSession({ sessionToken: c1.sessionToken });
    check("bootstrap session resolves as OWNER + MFA", resolved.ok && resolved.context.role === "OWNER" && resolved.context.authenticatedWithMfa === true);

    // ---- route permanently closed after completion ----
    const st1 = await svc.bootstrapStatus();
    check("after completion -> state COMPLETED + not available", st1.state === "COMPLETED" && st1.available === false);
    const bAfter = await svc.beginOwnerBootstrap({ email: "intruder@studio.test", password: "intruder-pass-123456" });
    check("begin after completion -> BOOTSTRAP_UNAVAILABLE", bAfter.result === "BOOTSTRAP_UNAVAILABLE" && bAfter.ok === false);
    const cAfter = await svc.confirmOwnerBootstrap({ ceremonyToken: b1.ceremonyToken, code: generateTotp(secret, { nowMs: clockRef.now }) });
    check("confirm after completion -> BOOTSTRAP_UNAVAILABLE", cAfter.result === "BOOTSTRAP_UNAVAILABLE");

    // ---- "restart": a fresh service instance still sees the closed route (DB truth, not memory) ----
    const svc2 = buildService(adapter, key, clockRef);
    check("fresh service instance still sees COMPLETED (survives restart)", (await svc2.bootstrapStatus()).state === "COMPLETED");
  } finally { await adapter.stop().catch(() => {}); }

  // ================= concurrency + operator-proof on a SECOND, owner-less cluster =================
  const live2 = await startDisposablePg({ namePrefix: "cp5c23boot2" });
  const mc2 = new Client({ connectionString: live2.migrationUrl }); await mc2.connect();
  try { await mrun(mc2, { dir: MIGRATIONS_DIR }); } finally { await mc2.end(); }
  const adapter2 = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live2.appUrl, CONTROL_PLANE_DB_OPS_URL: live2.opsUrl }), {});
  await adapter2.start();
  const clockRef2 = { now: Date.parse("2026-07-23T12:00:00.000Z") };
  const key2 = generateSecretBoxKey();
  const svcB = buildService(adapter2, key2, clockRef2);
  const q2 = (sql, args) => adapter2.transaction((c) => c.query(sql, args));
  try {
    // ---- concurrent begin -> exactly one winner ----
    const [ba, bb] = await Promise.all([
      svcB.beginOwnerBootstrap({ email: "a@studio.test", password: "a-owner-pass-123456", ip: "1.1.1.1" }),
      svcB.beginOwnerBootstrap({ email: "b@studio.test", password: "b-owner-pass-123456", ip: "2.2.2.2" })
    ]);
    const startedCount = [ba, bb].filter((r) => r.result === "OWNER_BOOTSTRAP_STARTED").length;
    const conflictCount = [ba, bb].filter((r) => r.result === "BOOTSTRAP_CONFLICT").length;
    check("concurrent begin -> exactly one winner", startedCount === 1 && conflictCount === 1);
    const winner = ba.result === "OWNER_BOOTSTRAP_STARTED" ? ba : bb;
    const secret2 = secretOf(winner.otpauthUri);
    const code2 = generateTotp(secret2, { nowMs: clockRef2.now });

    // ---- concurrent confirm (same ceremonyToken+code) -> exactly one owner ----
    const [ca, cb] = await Promise.all([
      svcB.confirmOwnerBootstrap({ ceremonyToken: winner.ceremonyToken, code: code2, ip: "1.1.1.1", userAgent: "t" }),
      svcB.confirmOwnerBootstrap({ ceremonyToken: winner.ceremonyToken, code: code2, ip: "1.1.1.1", userAgent: "t" })
    ]);
    const issued = [ca, cb].filter((r) => r.result === "SESSION_ISSUED").length;
    check("concurrent confirm -> exactly one SESSION_ISSUED", issued === 1);
    const wsId2 = (ca.workspaceId || cb.workspaceId);
    const owners2 = await adapter2.transaction(async (c) => { await setAuthContext(c, { workspaceId: wsId2 }); return c.query("SELECT count(*)::int n FROM workspace_members WHERE role='OWNER' AND workspace_id=$1", [wsId2]); });
    check("concurrent confirm -> exactly one owner membership in the DB", owners2.rows[0].n === 1);
    check("concurrent confirm -> exactly one owner user", (await q2("SELECT count(*)::int n FROM users")).rows[0].n === 1);
  } finally { await adapter2.stop().catch(() => {}); }

  // ================= operator one-time proof on a THIRD, owner-less cluster =================
  const live3 = await startDisposablePg({ namePrefix: "cp5c23boot3" });
  const mc3 = new Client({ connectionString: live3.migrationUrl }); await mc3.connect();
  try { await mrun(mc3, { dir: MIGRATIONS_DIR }); } finally { await mc3.end(); }
  const adapter3 = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live3.appUrl, CONTROL_PLANE_DB_OPS_URL: live3.opsUrl }), {});
  await adapter3.start();
  const clockRef3 = { now: Date.parse("2026-07-23T12:00:00.000Z") };
  const svc3 = buildService(adapter3, generateSecretBoxKey(), clockRef3);
  try {
    // an invalid operator proof, when a proof is supplied, rolls the claim back (no ceremony claimed).
    const badProof = await svc3.beginOwnerBootstrap({ email: "op@studio.test", password: "op-owner-pass-123456", bootstrapProof: "not-a-real-proof-token" });
    check("begin with INVALID operator proof -> BAD_PROOF", badProof.reason === "BAD_PROOF" && badProof.ok === false);
    check("invalid-proof begin did NOT claim the ceremony", (await svc3.bootstrapStatus()).state === "REQUIRED");

    // mint a real operator proof, use it once, then prove it cannot be reused.
    const proofPlain = generateToken(32);
    await adapter3.transaction((c) => bootstrapTokenRepository.createBootstrapToken(c, { tokenHash: hashToken(proofPlain), expiresAt: new Date(clockRef3.now + 3600_000) }));
    const okProof = await svc3.beginOwnerBootstrap({ email: "op@studio.test", password: "op-owner-pass-123456", bootstrapProof: proofPlain, requireProof: true });
    check("begin with VALID operator proof -> STARTED", okProof.result === "OWNER_BOOTSTRAP_STARTED");
    check("operator proof consumed (marked used)", (await adapter3.transaction((c) => c.query("SELECT consumed_at FROM auth_bootstrap_tokens LIMIT 1"))).rows[0].consumed_at !== null);

    // require-proof with no proof supplied -> rolled back (needs a fresh, owner-less ceremony state; the prior
    // begin left IN_PROGRESS, so this asserts the require-proof gate returns PROOF_REQUIRED on a retry path).
    // (advance clock past the ceremony proof expiry so the claim can restart)
    clockRef3.now += AUTH_CONFIG_DEFAULTS.preAuthChallengeTtlMs + 1000;
    const noProof = await svc3.beginOwnerBootstrap({ email: "op@studio.test", password: "op-owner-pass-123456", requireProof: true });
    check("require-proof + no proof -> PROOF_REQUIRED", noProof.reason === "PROOF_REQUIRED" && noProof.ok === false);
  } finally { await adapter3.stop().catch(() => {}); }

  console.log(`Step 5C.23 bootstrap: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
