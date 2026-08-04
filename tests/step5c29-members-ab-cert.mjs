// P0 Step 5C.29 Phase 6 — workspace members + roles A/B certification on REAL disposable PostgreSQL.
// Provider-free. Proves the members matrix: invite (tenant-scoped) + resend; role change; suspend/reactivate
// (a suspended membership fails closed on access + switch WITHOUT touching other-workspace access); last-owner
// protection (never suspend/downgrade/revoke the last active owner); cross-tenant membership mutation refused;
// user C switches A<->B on valid membership + fails after removal; a Workspace Owner cannot self-grant a
// Platform role (no such surface exists on the workspace auth service — plane separation).
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { createAuthService } from "../control-plane/src/auth/auth-service.mjs";
import { AUTH_CONFIG_DEFAULTS } from "../control-plane/src/auth/auth-config.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";
import { credentialRepository, mfaRepository, recoveryCodeRepository } from "../control-plane/src/persistence/repositories/auth-credential-repository.mjs";
import { userSessionRepository } from "../control-plane/src/persistence/repositories/auth-session-repository.mjs";
import { preAuthChallengeRepository, passwordResetTokenRepository, reauthProofRepository, invitationRepository, emailVerificationTokenRepository, notificationOutboxRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, ARGON2_PARAMS } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotpSecret, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 members A/B: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c29mem" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-24T12:00:00.000Z");
  const key = generateSecretBoxKey();
  const svc = createAuthService({
    persistence: adapter, setAuthContext,
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository, reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, verifyToken: emailVerificationTokenRepository, invitation: invitationRepository, notification: notificationOutboxRepository, security: securityRepository },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy,
    generateToken, hashToken, verifyTotp, decryptTotpSecret: (ct) => decryptSecret(ct, key),
    generateTotpSecret, otpauthUrl, encryptTotpSecret: (s) => encryptSecret(s, key), generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash, encryptLinkToken: (s) => encryptSecret(s, key),
    clock: () => clock, config: AUTH_CONFIG_DEFAULTS
  });
  const tx = (fn) => adapter.transaction(fn);
  const seedUser = (email) => tx(async (c) => { const u = await userRepository.createInvitedUser(c, { email, status: "ACTIVE" }); await setAuthContext(c, { userId: u.id }); await credentialRepository.createPasswordCredential(c, { userId: u.id, secretHash: await hashPassword("pass-word-123456"), params: ARGON2_PARAMS }); return u; });
  const seedWs = (uid, name) => tx(async (c) => { await setAuthContext(c, { userId: uid }); const ws = await workspaceRepository.createWorkspace(c, { name, ownerUserId: uid }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: uid, role: "OWNER" }); return ws; });
  const addMember = (wsId, uid, role) => tx(async (c) => { await setAuthContext(c, { workspaceId: wsId }); await workspaceRepository.createMembership(c, { workspaceId: wsId, userId: uid, role }); });
  const mkSession = ({ userId, wsId, mfa = true }) => tx(async (c) => { await setAuthContext(c, { userId }); const token = generateToken(), csrf = generateToken(); await userSessionRepository.createSession(c, { userId, tokenHash: hashToken(token), csrfHash: hashToken(csrf), activeWorkspaceId: wsId, idleExpiresAt: new Date(clock + 12 * 3600e3).toISOString(), absoluteExpiresAt: new Date(clock + 7 * 86400e3).toISOString(), mfaAuthenticatedAt: mfa ? new Date(clock).toISOString() : null, authStrength: mfa ? "MFA_TOTP" : "PASSWORD" }); return { token, csrf }; });

  // ---- fixtures: Tenant A (owner A1 + admin A2), Tenant B (owner B1), user C in A and B ----
  const a1 = await seedUser("a1@mem.test"), a2 = await seedUser("a2@mem.test"), b1 = await seedUser("b1@mem.test"), c = await seedUser("c@mem.test");
  const wsA = await seedWs(a1.id, "Tenant A"), wsB = await seedWs(b1.id, "Tenant B");
  await addMember(wsA.id, a2.id, "ADMIN");
  await addMember(wsA.id, c.id, "MEMBER");
  await addMember(wsB.id, c.id, "MEMBER");
  const sA1 = await mkSession({ userId: a1.id, wsId: wsA.id });
  const sA2 = await mkSession({ userId: a2.id, wsId: wsA.id });
  const sC = await mkSession({ userId: c.id, wsId: wsA.id });

  // ---- 1. invite (tenant-scoped) + resend + list ----
  const inv = await svc.createInvitation({ sessionToken: sA1.token, email: "new@mem.test", role: "MEMBER" });
  check("P1 owner invites a MEMBER", inv.ok && inv.invitationId);
  const list1 = await svc.listWorkspaceInvitations({ sessionToken: sA1.token });
  check("P2 invitation listed as PENDING (workspace-scoped)", list1.ok && list1.invitations.some((i) => i.id === inv.invitationId && i.status === "PENDING"));
  const rs = await svc.resendInvitation({ sessionToken: sA1.token, invitationId: inv.invitationId });
  check("P3 resend invitation ok (token rotated, still pending)", rs.ok);
  // a MEMBER (userC) cannot invite (not admin)
  const cInv = await svc.createInvitation({ sessionToken: sC.token, email: "x@mem.test", role: "MEMBER" });
  check("P4 a MEMBER cannot invite (not admin)", cInv.ok === false);
  // B's owner cannot see A's invitations (tenant-scoped) — B1 session lists B's (empty)
  const sB1 = await mkSession({ userId: b1.id, wsId: wsB.id });
  const listB = await svc.listWorkspaceInvitations({ sessionToken: sB1.token });
  check("P5 B owner does NOT see A's invitations (tenant-scoped)", listB.ok && !listB.invitations.some((i) => i.id === inv.invitationId));

  // ---- 2. role change ----
  const roleUp = await svc.updateWorkspaceRole({ sessionToken: sA1.token, targetUserId: c.id, role: "ADMIN" });
  check("P6 owner promotes C MEMBER->ADMIN in A", roleUp.ok && roleUp.role === "ADMIN");
  await svc.updateWorkspaceRole({ sessionToken: sA1.token, targetUserId: c.id, role: "MEMBER" }); // back

  // ---- 3. suspend / reactivate (fail-closed access + switch) ----
  const susp = await svc.suspendWorkspaceMember({ sessionToken: sA1.token, targetUserId: a2.id });
  check("P7 owner suspends admin A2", susp.ok && susp.status === "SUSPENDED");
  const azA2 = await svc.resolveAuthorization({ sessionToken: sA2.token, targetWorkspaceId: wsA.id });
  check("P8 suspended A2 is NOT a member of A (access fails closed)", azA2.ok && azA2.isMemberOfTarget === false);
  const swA2 = await svc.switchWorkspace({ sessionToken: sA2.token, targetWorkspaceId: wsA.id });
  check("P9 suspended A2 cannot switch INTO A", swA2.ok === false);
  const react = await svc.reactivateWorkspaceMember({ sessionToken: sA1.token, targetUserId: a2.id });
  check("P10 owner reactivates A2", react.ok && react.status === "ACTIVE");
  const azA2b = await svc.resolveAuthorization({ sessionToken: sA2.token, targetWorkspaceId: wsA.id });
  check("P11 reactivated A2 is a member of A again", azA2b.ok && azA2b.isMemberOfTarget === true && azA2b.roleInTarget === "ADMIN");

  // ---- 4. last-owner protection (A2 as ADMIN cannot suspend/downgrade/revoke the sole OWNER A1) ----
  check("P12 cannot suspend the last active owner", (await svc.suspendWorkspaceMember({ sessionToken: sA2.token, targetUserId: a1.id })).reason === "LAST_OWNER");
  check("P13 cannot downgrade the last owner", (await svc.updateWorkspaceRole({ sessionToken: sA2.token, targetUserId: a1.id, role: "MEMBER" })).reason === "LAST_OWNER");
  check("P14 cannot revoke the last owner", (await svc.revokeWorkspaceMembership({ sessionToken: sA2.token, targetUserId: a1.id })).reason === "LAST_OWNER");

  // ---- 5. cross-tenant membership mutation refused (A1 session cannot touch a B member) ----
  const crossRole = await svc.updateWorkspaceRole({ sessionToken: sA1.token, targetUserId: b1.id, role: "MEMBER" });
  check("P15 A owner cannot mutate B's membership (target not in A -> refused)", crossRole.ok === false);
  const crossSusp = await svc.suspendWorkspaceMember({ sessionToken: sA1.token, targetUserId: b1.id });
  check("P16 A owner cannot suspend a B member", crossSusp.ok === false);

  // ---- 6. user C switching A<->B (valid membership) + removal fails closed ----
  // C's earlier session was revoked by the role change (adminRevokeAllSessions on ROLE_CHANGED) — mint a fresh one.
  const sCfresh = await mkSession({ userId: c.id, wsId: wsA.id });
  const swC = await svc.switchWorkspace({ sessionToken: sCfresh.token, targetWorkspaceId: wsB.id });
  check("P17 C switches A->B (member of both)", swC.ok && swC.session.activeWorkspaceId === wsB.id);
  await svc.revokeWorkspaceMembership({ sessionToken: sB1.token, targetUserId: c.id }); // B owner removes C from B
  const sC2 = await mkSession({ userId: c.id, wsId: wsA.id });
  const swCremoved = await svc.switchWorkspace({ sessionToken: sC2.token, targetWorkspaceId: wsB.id });
  check("P18 removed-from-B C cannot switch to B (fail closed)", swCremoved.ok === false);
  const azCb = await svc.resolveAuthorization({ sessionToken: sC2.token, targetWorkspaceId: wsB.id });
  check("P19 removed C is not a member of B", azCb.ok && azCb.isMemberOfTarget === false);
  check("P20 removed C is STILL a member of A (removal is workspace-scoped)", (await svc.resolveAuthorization({ sessionToken: sC2.token, targetWorkspaceId: wsA.id })).isMemberOfTarget === true);

  // ---- 7. plane separation: the workspace auth service exposes NO platform-role grant (owner cannot escalate) ----
  check("P21 workspace auth service has no platform-role grant surface (plane separation)", typeof svc.grantPlatformRole !== "function" && typeof svc.setPlatformRole !== "function");

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}

main().then(() => {
  console.log(`\nStep 5C.29 members A/B: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
