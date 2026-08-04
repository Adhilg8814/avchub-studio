// P0 Step 5C.29 — platform HTTP handler dispatch + auth/CSRF, on REAL disposable PG. The service logic is
// covered by step5c29-platform-service; this proves the /api/platform/* router: actor from session, CSRF/
// Origin on mutations, pre-session activation, route regexes, error->status mapping.
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { createPlatformService } from "../control-plane/src/platform/platform-service.mjs";
import { createPlatformHttpHandler } from "../control-plane/src/platform/platform-http.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";
import { credentialRepository, mfaRepository, recoveryCodeRepository } from "../control-plane/src/persistence/repositories/auth-credential-repository.mjs";
import { userSessionRepository } from "../control-plane/src/persistence/repositories/auth-session-repository.mjs";
import { invitationRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, validatePasswordPolicy, ARGON2_PARAMS } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotp, generateTotpSecret, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const ORIGIN = "https://studio.example.com";

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 platform http: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c29phttp" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-24T12:00:00.000Z");
  const key = generateSecretBoxKey();
  const svc = createPlatformService({ persistence: adapter, setAuthContext, clock: () => clock, externalOrigin: ORIGIN, config: {}, repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, invitation: invitationRepository, security: securityRepository }, crypto: { hashPassword, validatePasswordPolicy, generateToken, hashToken, verifyTotp, generateTotpSecret, encryptTotpSecret: (s) => encryptSecret(s, key), decryptTotpSecret: (ct) => decryptSecret(ct, key), otpauthUrl, generateRecoveryCodes, hashRecoveryCode, ARGON2_PARAMS } });
  const tx = (fn) => adapter.transaction(fn);
  const boss = await tx((c) => userRepository.createInvitedUser(c, { email: "boss@h.test", status: "ACTIVE" }));
  const ws = await tx(async (c) => { await setAuthContext(c, { userId: boss.id }); const w = await workspaceRepository.createWorkspace(c, { name: "W", ownerUserId: boss.id }); await workspaceRepository.createMembership(c, { workspaceId: w.id, userId: boss.id, role: "OWNER" }); return w; });
  await svc.runBackfill({ ownerUserId: boss.id, workspaceIds: [ws.id] });

  // minimal authService: a known (real-format) session token -> the boss (MFA), csrfHash = hashToken('csrf1')
  const SESS = generateToken(32); // parseSessionCookie requires >=20 chars [A-Za-z0-9_-]
  const fakeAuth = { resolveSession: async ({ sessionToken }) => sessionToken === SESS ? { ok: true, context: { userId: boss.id, csrfHash: hashToken("csrf1"), authenticatedWithMfa: true } } : { ok: false } };
  const http = createPlatformHttpHandler({ platformService: svc, authService: fakeAuth, config: { allowedOrigins: [ORIGIN], cookieSecure: true, hashToken } });
  const cookie = `__Host-avc_studio_session=${SESS}`;
  const H = (extra = {}) => ({ cookie, origin: ORIGIN, "x-avc-studio-csrf": "csrf1", ...extra });

  // unauth
  check("no cookie -> 401", (await http.handle({ method: "GET", path: "/api/platform/customers", headers: {} })).status === 401);
  // CSRF missing on mutation
  check("mutation without csrf -> 403", (await http.handle({ method: "POST", path: "/api/platform/customers", headers: { cookie, origin: ORIGIN }, body: {} })).status === 403);
  // create customer (happy path)
  const created = await http.handle({ method: "POST", path: "/api/platform/customers", headers: H(), body: { legalName: "Tenant A", workspaceName: "Tenant A WS", ownerEmail: "a@a.test", plan: "PRO" } });
  check("POST customers -> 201 + activationToken", created.status === 201 && created.body.ok && created.body.activationToken && created.body.activationUrl.includes("/activate?token="));
  const custId = created.body.customerId;
  check("GET customers -> 200 list", (await http.handle({ method: "GET", path: "/api/platform/customers", headers: H() })).body.customers.length >= 1);
  check("GET customer detail -> 200", (await http.handle({ method: "GET", path: `/api/platform/customers/${custId}`, headers: H() })).body.customer.id === custId);
  check("dashboard -> 200 totals", (await http.handle({ method: "GET", path: "/api/platform/dashboard", headers: H() })).body.totals.customers.total >= 2);
  // suspend + reactivate
  check("suspend -> SUSPENDED", (await http.handle({ method: "POST", path: `/api/platform/customers/${custId}/suspend`, headers: H(), body: { reason: "x" } })).body.customer.status === "SUSPENDED");
  check("reactivate -> ACTIVE", (await http.handle({ method: "POST", path: `/api/platform/customers/${custId}/reactivate`, headers: H(), body: {} })).body.customer.status === "ACTIVE");
  // duplicate name -> 409
  check("duplicate customer -> 409", (await http.handle({ method: "POST", path: "/api/platform/customers", headers: H(), body: { legalName: "Tenant A", workspaceName: "dup ws", ownerEmail: "b@b.test" } })).status === 409);

  // ----- pre-session activation via HTTP (no cookie) -----
  const beg = await http.handle({ method: "POST", path: "/api/platform/activation/begin", headers: { origin: ORIGIN }, body: { token: created.body.activationToken } });
  check("activation/begin (pre-session) -> 200 otpauth", beg.status === 200 && beg.body.otpauthUri.startsWith("otpauth://"));
  const secret = new URL(beg.body.otpauthUri).searchParams.get("secret"); clock += 30_000;
  const conf = await http.handle({ method: "POST", path: "/api/platform/activation/confirm", headers: { origin: ORIGIN }, body: { token: created.body.activationToken, password: "TenantA-pass-123456", totpCode: generateTotp(secret, { nowMs: clock }) } });
  check("activation/confirm -> 200 + session cookies + recovery codes", conf.status === 200 && conf.body.ok && conf.body.recoveryCodes.length === 10 && Array.isArray(conf.headers["Set-Cookie"]) && conf.headers["Set-Cookie"].some((c) => c.includes("__Host-avc_studio_session=")));
  check("confirm is no-store", conf.headers["Cache-Control"] === "no-store");

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}
main().then(() => { console.log(`\nStep 5C.29 platform http: ${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); })
  .catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
