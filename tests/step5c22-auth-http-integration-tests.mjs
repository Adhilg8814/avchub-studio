// P0 Step 5C.22 (Checkpoint D/E) — native-auth HTTP transport + enforcement END-TO-END against the REAL
// AuthService + disposable PostgreSQL. Drives HTTP-shaped requests through createAuthHttpHandler +
// createEnforcement: login -> __Host cookie -> GET /session -> CSRF mutation -> logout; membership revoke
// kills the session on the next resolve; WS handshake authorizes then closes 4401 after revoke; media
// cross-tenant -> 404. SKIPS without portable PostgreSQL. NEVER touches production.

import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { createAuthService } from "../control-plane/src/auth/auth-service.mjs";
import { AUTH_CONFIG_DEFAULTS } from "../control-plane/src/auth/auth-config.mjs";
import { createAuthHttpHandler, SESSION_COOKIE, CSRF_HEADER } from "../control-plane/src/auth/http/auth-http.mjs";
import { createEnforcement } from "../control-plane/src/auth/http/auth-enforcement.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";
import { credentialRepository, mfaRepository, recoveryCodeRepository } from "../control-plane/src/persistence/repositories/auth-credential-repository.mjs";
import { userSessionRepository } from "../control-plane/src/persistence/repositories/auth-session-repository.mjs";
import { preAuthChallengeRepository, passwordResetTokenRepository, emailVerificationTokenRepository, invitationRepository, reauthProofRepository, notificationOutboxRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, ARGON2_PARAMS } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotpSecret, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const ORIGIN = "https://studio.example.com";
const cookieFromSetCookie = (sc) => { const m = /(^|;?\s*)__Host-avc_studio_session=([^;]+)/.exec(String(sc || "")); return m ? m[2] : null; };

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.22 auth http integration: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c22http" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  let adapter;
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); check("migrations apply to latest", (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length); } finally { await mc.end(); }
  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-23T12:00:00.000Z");
  const testKey = generateSecretBoxKey();
  const svc = createAuthService({
    persistence: adapter, setAuthContext,
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository, reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, verifyToken: emailVerificationTokenRepository, invitation: invitationRepository, notification: notificationOutboxRepository, security: securityRepository },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, generateToken, hashToken, verifyTotp,
    decryptTotpSecret: (ct) => decryptSecret(ct, testKey), generateTotpSecret, otpauthUrl, encryptTotpSecret: (s) => encryptSecret(s, testKey),
    generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash, encryptLinkToken: (t) => encryptSecret(t, testKey),
    clock: () => clock, config: AUTH_CONFIG_DEFAULTS
  });
  const httpConfig = { nativeAuthRoutesEnabled: true, nativeAuthEnforcementEnabled: true, allowedOrigins: [ORIGIN], cookieSecure: true, hashToken };
  const handler = createAuthHttpHandler({ authService: svc, config: httpConfig, clock: () => clock });
  const enforce = createEnforcement({ authService: svc, config: httpConfig, hashToken });

  const tx = (fn) => adapter.transaction(fn);
  const seedUser = (email, pw) => tx(async (c) => { const u = await userRepository.createInvitedUser(c, { email, status: "ACTIVE" }); await setAuthContext(c, { userId: u.id }); await credentialRepository.createPasswordCredential(c, { userId: u.id, secretHash: await hashPassword(pw), params: ARGON2_PARAMS }); return u; });
  const seedWs = (uid, name) => tx(async (c) => { await setAuthContext(c, { userId: uid }); const ws = await workspaceRepository.createWorkspace(c, { name, ownerUserId: uid }); await workspaceRepository.createMembership(c, { workspaceId: ws.id, userId: uid, role: "OWNER" }); return ws; });
  const addMember = (wsId, uid, role) => tx(async (c) => { await setAuthContext(c, { workspaceId: wsId }); return workspaceRepository.createMembership(c, { workspaceId: wsId, userId: uid, role }); });

  try {
    const owner = await seedUser("owner@studio.test", "owner-pass-123456");
    const wsA = await seedWs(owner.id, "WS A");
    const wsB = await seedWs(owner.id, "WS B");
    const member = await seedUser("member@studio.test", "member-pass-123456"); await addMember(wsA.id, member.id, "MEMBER");

    // ---- HTTP login (member, no MFA) -> 200 + __Host cookie; token only in cookie ----
    const loginRes = await handler.handle({ method: "POST", path: "/api/auth/login", headers: { origin: ORIGIN, "user-agent": "test" }, ip: "1.1.1.1", body: { email: "member@studio.test", password: "member-pass-123456", workspaceId: wsA.id } });
    check("HTTP login -> 200 + Set-Cookie __Host, no token in body", loginRes.status === 200 && String(loginRes.headers["Set-Cookie"]).includes(`${SESSION_COOKIE}=`) && !JSON.stringify(loginRes.body).includes("Set-Cookie") && !("sessionToken" in loginRes.body));
    const sessTok = cookieFromSetCookie(loginRes.headers["Set-Cookie"]);
    const csrf = loginRes.body.csrfToken;
    check("login returned csrfToken (for double-submit)", typeof csrf === "string" && csrf.length > 10);

    // ---- GET /session with cookie -> 200 ----
    const s1 = await handler.handle({ method: "GET", path: "/api/auth/session", headers: { cookie: `${SESSION_COOKIE}=${sessTok}` } });
    check("GET /session -> 200 with member context", s1.status === 200 && s1.body.context.userId === member.id && s1.body.context.workspaceId === wsA.id);

    // ---- enforcement authenticate for a protected route ----
    const authCtx = await enforce.authenticate({ headers: { cookie: `${SESSION_COOKIE}=${sessTok}` }, path: "/api/provider-management/movies" }, { kind: "api" });
    check("enforcement authenticate -> context", authCtx.ok && authCtx.context.userId === member.id);

    // ---- CSRF mutation: switch to wsB (member is not in B -> AUTHENTICATION_FAILED, but CSRF must pass first) ----
    const noCsrf = await handler.handle({ method: "POST", path: "/api/auth/workspace/switch", headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${sessTok}` }, body: { workspaceId: wsB.id } });
    check("switch without CSRF -> 403", noCsrf.status === 403);
    const badWs = await handler.handle({ method: "POST", path: "/api/auth/workspace/switch", headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${sessTok}`, [CSRF_HEADER]: csrf }, body: { workspaceId: wsB.id } });
    check("switch to non-member workspace (CSRF ok) -> 401", badWs.status === 401);

    // ---- WS handshake authorizes with the cookie ----
    const ws1 = await enforce.authenticateSocket({ headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${sessTok}` }, path: "/ws" });
    check("WS handshake authorized", ws1.ok && ws1.context.userId === member.id);

    // ---- media authorization: member (ws A) cannot access a ws B resource ----
    check("media same-workspace ok", enforce.authorizeResource(authCtx.context, wsA.id).ok === true);
    check("media cross-tenant -> 404", enforce.authorizeResource(authCtx.context, wsB.id).response.status === 404);

    // ---- membership revoke -> next resolve kills the session (HTTP 401 + WS 4401) ----
    await tx(async (c) => { await setAuthContext(c, { workspaceId: wsA.id }); await workspaceRepository.revokeMembership(c, { workspaceId: wsA.id, userId: member.id }); });
    const afterRevoke = await handler.handle({ method: "GET", path: "/api/auth/session", headers: { cookie: `${SESSION_COOKIE}=${sessTok}` } });
    check("after membership revoke -> GET /session 401 + clear cookie", afterRevoke.status === 401 && /Max-Age=0/.test(afterRevoke.headers["Set-Cookie"]));
    const wsAfter = await enforce.authenticateSocket({ headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${sessTok}` } });
    check("WS after revoke -> 4401", wsAfter.closeCode === 4401);

    // ---- logout clears cookie + kills session ----
    await addMember(wsA.id, member.id, "MEMBER"); // restore so we can log in again
    const login2 = await handler.handle({ method: "POST", path: "/api/auth/login", headers: { origin: ORIGIN }, ip: "1.1.1.1", body: { email: "member@studio.test", password: "member-pass-123456", workspaceId: wsA.id } });
    const tok2 = cookieFromSetCookie(login2.headers["Set-Cookie"]);
    const lo = await handler.handle({ method: "POST", path: "/api/auth/logout", headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${tok2}`, [CSRF_HEADER]: login2.body.csrfToken }, body: {} });
    check("logout -> 200 + clear cookie", lo.status === 200 && /Max-Age=0/.test(lo.headers["Set-Cookie"]));
    check("session dead after logout", (await handler.handle({ method: "GET", path: "/api/auth/session", headers: { cookie: `${SESSION_COOKIE}=${tok2}` } })).status === 401);

    console.log(`Step 5C.22 auth http integration: ${passed} passed, ${failed} failed`);
  } finally {
    try { await adapter.stop(); } catch { /* */ }
    await live.stop();
  }
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
