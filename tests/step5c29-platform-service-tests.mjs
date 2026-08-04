// P0 Step 5C.29 — Platform service (onboarding + activation + lifecycle + authority), on REAL disposable PG.
// Provider-free. Proves: backfill (owner->PLATFORM_OWNER, ws->customer, idempotent), createCustomer atomic +
// dedup, owner activation (begin->confirm, single-use, password+TOTP+recovery+session), suspend/reactivate,
// platform-role authority (non-platform user denied), NO cross elevation.
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { createPlatformService } from "../control-plane/src/platform/platform-service.mjs";
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
async function throwsCode(fn, code) { try { await fn(); return false; } catch (e) { return code ? e.code === code : true; } }

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 platform service: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c29psvc" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-24T12:00:00.000Z");
  const key = generateSecretBoxKey();
  const svc = createPlatformService({
    persistence: adapter, setAuthContext, clock: () => clock, externalOrigin: "https://studio.example.com",
    config: { activationTtlMs: 7 * 86400e3, recoveryCodeCount: 10 },
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, invitation: invitationRepository, security: securityRepository },
    crypto: { hashPassword, validatePasswordPolicy, generateToken, hashToken, verifyTotp, generateTotpSecret, encryptTotpSecret: (s) => encryptSecret(s, key), decryptTotpSecret: (ct) => decryptSecret(ct, key), otpauthUrl, generateRecoveryCodes, hashRecoveryCode, ARGON2_PARAMS }
  });
  const tx = (fn) => adapter.transaction(fn);
  const secretFromUri = (uri) => new URL(uri).searchParams.get("secret");

  // ----- seed an existing native owner (like production) + a workspace -----
  const boss = await tx(async (c) => userRepository.createInvitedUser(c, { email: "boss@studio.test", status: "ACTIVE" }));
  const ownerWs = await tx(async (c) => { await setAuthContext(c, { userId: boss.id }); const w = await workspaceRepository.createWorkspace(c, { name: "Owner WS", ownerUserId: boss.id }); await workspaceRepository.createMembership(c, { workspaceId: w.id, userId: boss.id, role: "OWNER" }); return w; });

  // ----- backfill: owner -> PLATFORM_OWNER, ws -> customer (operator-supplied ids; idempotent) -----
  const bf1 = await svc.runBackfill({ legalName: "AVC Studio", ownerUserId: boss.id, workspaceIds: [ownerWs.id] });
  check("backfill promotes owner + links workspace", bf1.backfilled === true && bf1.ownerUserId === boss.id && bf1.workspacesLinked === 1);
  const bf2 = await svc.runBackfill({ legalName: "AVC Studio", ownerUserId: boss.id, workspaceIds: [ownerWs.id] });
  check("backfill idempotent (no new customer, 0 new links)", bf2.backfilled === true && bf2.workspacesLinked === 0);
  check("boss resolves PLATFORM_OWNER", (await svc.resolvePlatformRole({ userId: boss.id }))?.role === "PLATFORM_OWNER");

  // a non-platform user cannot act as platform admin (IDOR / authority)
  const stranger = await tx(async (c) => userRepository.createInvitedUser(c, { email: "stranger@x.test", status: "ACTIVE" }));
  check("non-platform user denied createCustomer", await throwsCode(() => svc.createCustomer({ actorUserId: stranger.id, legalName: "Bad Co", workspaceName: "Bad WS", ownerEmail: "x@bad.test" }), "PLATFORM_FORBIDDEN"));
  check("non-platform user resolvePlatformRole -> null", (await svc.resolvePlatformRole({ userId: stranger.id })) === null);

  // ----- createCustomer (Tenant A) atomic -----
  const A = await svc.createCustomer({ actorUserId: boss.id, legalName: "Tenant A Inc", workspaceName: "Tenant A WS", ownerEmail: "ownerA@a.test", plan: "PRO", quota: { maxGrokPerDay: 5, maxActiveMovies: 2 } });
  check("createCustomer returns customer/workspace/activation", Boolean(A.customerId && A.workspaceId && A.activationToken && A.activationUrl?.includes("/activate?token=")));
  check("Tenant A owner is PENDING (not activated)", (await tx(async (c) => userRepository.findByNormalizedEmail(c, "ownerA@a.test"))).status === "PENDING");
  // dedup: same legal_name -> rejected
  check("duplicate customer name rejected", await throwsCode(() => svc.createCustomer({ actorUserId: boss.id, legalName: "Tenant A Inc", workspaceName: "dup", ownerEmail: "z@z.test" }), "PLATFORM_CUSTOMER_EXISTS"));
  // onboarding an already-ACTIVE email as a new tenant owner -> rejected (no hijack)
  check("active email cannot be onboarded as new owner", await throwsCode(() => svc.createCustomer({ actorUserId: boss.id, legalName: "Tenant Z", workspaceName: "Zed WS", ownerEmail: "boss@studio.test" }), "PLATFORM_OWNER_EMAIL_IN_USE"));

  // ----- owner activation (begin -> confirm) -----
  const beg = await svc.beginActivation({ activationToken: A.activationToken });
  check("beginActivation returns otpauth uri", beg.otpauthUri?.startsWith("otpauth://totp/") && beg.email === "ownera@a.test");
  const secret = secretFromUri(beg.otpauthUri);
  clock += 30_000;
  check("confirm with wrong code fails", await throwsCode(() => svc.confirmActivation({ activationToken: A.activationToken, password: "TenantA-pass-123456", totpCode: "000000" }), "PLATFORM_TOTP_INVALID"));
  check("confirm with weak password fails", await throwsCode(() => svc.confirmActivation({ activationToken: A.activationToken, password: "short", totpCode: generateTotp(secret, { nowMs: clock }) }), "PLATFORM_WEAK_PASSWORD"));
  const conf = await svc.confirmActivation({ activationToken: A.activationToken, password: "TenantA-pass-123456", totpCode: generateTotp(secret, { nowMs: clock }) });
  check("confirmActivation issues session + recovery codes", conf.ok && conf.sessionToken && conf.workspaceId === A.workspaceId && Array.isArray(conf.recoveryCodes) && conf.recoveryCodes.length === 10);
  check("Tenant A owner now ACTIVE", (await tx(async (c) => userRepository.findByNormalizedEmail(c, "ownerA@a.test"))).status === "ACTIVE");
  check("Tenant A session resolves to Tenant A workspace", await tx(async (c) => { const s = await userSessionRepository.resolveActiveSession(c, hashToken(conf.sessionToken), { nowMs: clock }); return s.ok && s.session.activeWorkspaceId === A.workspaceId && s.session.authenticatedWithMfa === true; }));
  // replay activation -> consumed
  check("activation token single-use (replay fails)", await throwsCode(() => svc.beginActivation({ activationToken: A.activationToken }), "PLATFORM_ACTIVATION_CONSUMED") || await throwsCode(() => svc.confirmActivation({ activationToken: A.activationToken, password: "TenantA-pass-123456", totpCode: generateTotp(secret, { nowMs: clock }) })));

  // ----- lifecycle -----
  const susp = await svc.setCustomerStatus({ actorUserId: boss.id, customerId: A.customerId, status: "SUSPENDED", reason: "test" });
  check("suspend customer", susp.status === "SUSPENDED" && susp.suspend_reason === "test");
  const react = await svc.setCustomerStatus({ actorUserId: boss.id, customerId: A.customerId, status: "ACTIVE" });
  check("reactivate customer", react.status === "ACTIVE" && react.suspended_at === null);

  // ----- dashboard + audit (platform-plane read) -----
  const dash = await svc.dashboard({ actorUserId: boss.id });
  check("dashboard totals + recent audit", dash.totals.customers.total >= 2 && dash.recentAudit.some((a) => a.action === "CUSTOMER_CREATED"));
  check("stranger denied dashboard", await throwsCode(() => svc.dashboard({ actorUserId: stranger.id }), "PLATFORM_FORBIDDEN"));

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}
main().then(() => { console.log(`\nStep 5C.29 platform service: ${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); })
  .catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
