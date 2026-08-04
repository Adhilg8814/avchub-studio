// P0 Step 5C.24 — native-auth RUNTIME adoption. This is the piece 5C.22/5C.23 deliberately deferred: it
// assembles the certified AuthService (repos + crypto + the STABLE secret-box key) and mounts the certified
// HTTP transport into the live control-plane router as a sub-router that owns /api/auth/*. It is INERT when
// config.nativeAuth.routesEnabled is false (handles() returns false for every path → routing unchanged), so a
// flags-OFF production deploy behaves exactly as before. Identity comes ONLY from the opaque __Host- cookie;
// nothing here logs a cookie/token/secret. Enforcement of protected business/media routes is a separate,
// later integration (behind Cloudflare Access until certified); this module wires the auth transport itself.

import { ControlPlaneError, CP_ERRORS } from "../../errors.mjs";
import { createAuthService } from "../auth-service.mjs";
import { setAuthContext } from "../auth-context.mjs";
import { AUTH_CONFIG_DEFAULTS } from "../auth-config.mjs";
import { createAuthHttpHandler } from "../http/auth-http.mjs";
import { createEnforcement } from "../http/auth-enforcement.mjs";
import { createAuthorizeEndpoint } from "./authorize-endpoint.mjs";
import { createPlatformService } from "../../platform/platform-service.mjs";
import { createTenantGuard } from "../../platform/tenant-guard.mjs";
import { createPlatformHttpHandler } from "../../platform/platform-http.mjs";
import { readTrustedProxySecret } from "../../../../lib/ops/gateway-trust.mjs";
import { userRepository, workspaceRepository } from "../../persistence/repositories/auth-identity-repository.mjs";
import { credentialRepository, mfaRepository, recoveryCodeRepository } from "../../persistence/repositories/auth-credential-repository.mjs";
import { userSessionRepository } from "../../persistence/repositories/auth-session-repository.mjs";
import { preAuthChallengeRepository, passwordResetTokenRepository, emailVerificationTokenRepository, invitationRepository, reauthProofRepository, notificationOutboxRepository, bootstrapTokenRepository, bootstrapCeremonyRepository } from "../../persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../../persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, ARGON2_PARAMS } from "../../../../lib/auth/password.mjs";
import { generateToken, hashToken } from "../../../../lib/auth/tokens.mjs";
import { verifyTotp, generateTotpSecret, otpauthUrl } from "../../../../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../../../../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret } from "../../../../lib/auth/secret-box.mjs";

const INERT = Object.freeze({ handles: () => false, handle: () => {}, enabled: false });

// Derive the client IP for rate-limit/audit. Behind the trusted studio-gateway the peer is loopback, so the
// real client is the first x-forwarded-for hop — but ONLY when trustProxy is set (otherwise it is spoofable).
function deriveIp(req, config) {
  try {
    if (config && config.security && config.security.trustProxy) {
      const xff = req.headers && (req.headers["x-forwarded-for"] || req.headers["X-Forwarded-For"]);
      if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
    }
    return (req.socket && req.socket.remoteAddress) || null;
  } catch { return null; }
}

// Write the transport's normalized { status, headers, body } to the node response. Set-Cookie may be an
// array (session + csrf) — node's setHeader emits one header line per array element.
function writeResponse(res, r, correlationId) {
  if (res.writableEnded) return;
  res.statusCode = (r && r.status) || 200;
  const headers = (r && r.headers) || {};
  for (const [k, v] of Object.entries(headers)) { try { res.setHeader(k, v); } catch { /* skip an invalid header */ } }
  if (correlationId && !headers["X-Correlation-Id"]) res.setHeader("X-Correlation-Id", correlationId);
  const body = r && r.body != null ? (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) : "";
  res.end(body);
}

export function createAuthRuntime({ persistence, config, logger = null } = {}) {
  const na = (config && config.nativeAuth) || {};
  if (na.routesEnabled !== true) return INERT; // flags OFF -> claims nothing -> routing byte-for-byte unchanged

  const key = config.security && config.security.authSecretBoxKey;
  if (!key) throw new ControlPlaneError(CP_ERRORS.E_CONFIG_INVALID, "native-auth routes require a stable CONTROL_PLANE_AUTH_SECRETBOX_KEY");
  const seal = (plaintext) => encryptSecret(plaintext, key);
  const unseal = (box) => decryptSecret(box, key);

  // P0 Step 5C.29 Phase 8 — customer lifecycle + quota guard (shared, stateless). Active only when the platform
  // plane is enabled; passed into the auth service so member invites enforce max_users + suspension/expiration.
  const authTenantGuard = (na.platformEnabled === true) ? createTenantGuard({ clock: () => Date.now() }) : null;
  const authService = createAuthService({
    persistence, setAuthContext, tenantGuard: authTenantGuard,
    repos: {
      user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository,
      recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository,
      reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, verifyToken: emailVerificationTokenRepository,
      invitation: invitationRepository, notification: notificationOutboxRepository, security: securityRepository,
      bootstrap: bootstrapCeremonyRepository, bootstrapToken: bootstrapTokenRepository
    },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, generateToken, hashToken, verifyTotp,
    decryptTotpSecret: unseal, generateTotpSecret, otpauthUrl, encryptTotpSecret: seal,
    generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash, encryptLinkToken: seal,
    config: AUTH_CONFIG_DEFAULTS, logger
  });

  const httpConfig = Object.freeze({
    nativeAuthRoutesEnabled: true,
    nativeAuthBootstrapEnabled: na.bootstrapEnabled === true,
    nativeAuthEnforcementEnabled: na.enforcementEnabled === true,
    bootstrapRequireProof: na.bootstrapRequireProof === true,
    allowedOrigins: (config.security && config.security.allowedOrigins) || [],
    cookieSecure: na.cookieSecure !== false,
    hashToken
  });
  const handler = createAuthHttpHandler({ authService, config: httpConfig });
  const enforcement = createEnforcement({ authService, config: httpConfig, hashToken });

  // P0 Step 5C.29 — the platform (Boss Manager) plane. Reuses the SAME persistence/repos/crypto as native auth
  // (no re-implementation). Enabled behind config.nativeAuth.platformEnabled (default OFF -> the /api/platform
  // routes 404 and the PDP platform branch has no resolver -> hidden). externalOrigin feeds the activation URL.
  const platformEnabled = na.platformEnabled === true;
  const externalOrigin = (config.cloud && config.cloud.externalOrigin) || ((config.security && config.security.allowedOrigins) || [])[0] || null;
  const platformService = platformEnabled ? createPlatformService({
    persistence, setAuthContext, clock: () => Date.now(), externalOrigin,
    config: { activationTtlMs: AUTH_CONFIG_DEFAULTS.invitationTtlMs, recoveryCodeCount: AUTH_CONFIG_DEFAULTS.recoveryCodeCount, sessionIdleMs: AUTH_CONFIG_DEFAULTS.idleTimeoutMs, sessionAbsoluteMs: AUTH_CONFIG_DEFAULTS.absoluteTimeoutMs },
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, invitation: invitationRepository, security: securityRepository },
    crypto: { hashPassword, validatePasswordPolicy, generateToken, hashToken, verifyTotp, generateTotpSecret, encryptTotpSecret: seal, decryptTotpSecret: unseal, otpauthUrl, generateRecoveryCodes, hashRecoveryCode, ARGON2_PARAMS }
  }) : null;
  const platformHandler = platformService ? createPlatformHttpHandler({ platformService, authService, config: { allowedOrigins: httpConfig.allowedOrigins, cookieSecure: httpConfig.cookieSecure, hashToken, sessionAbsoluteMs: AUTH_CONFIG_DEFAULTS.absoluteTimeoutMs } }) : null;

  // Sub-router: owns /api/auth/* + (when enabled) /api/platform/*.
  function handles(method, path) { return typeof path === "string" && (path.startsWith("/api/auth/") || (platformHandler && path.startsWith("/api/platform/"))); }
  async function handle(req, res, ctx) {
    try {
      const norm = { method: ctx.method, path: ctx.path, headers: req.headers || {}, body: req.cpBody || {}, ip: deriveIp(req, config) };
      const r = platformHandler && ctx.path.startsWith("/api/platform/") ? await platformHandler.handle(norm) : await handler.handle(norm);
      writeResponse(res, r, ctx.correlationId);
    } catch {
      if (!res.writableEnded) { res.statusCode = 500; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify({ error: "server_error" })); }
    }
  }

  // P0 Step 5C.25 — the internal PDP endpoint the studio-gateway PEP calls to authorize browser data/media
  // requests before forwarding to the enrollment/data upstream. Secret-gated (trusted gateway only) +
  // enforcement-gated. dataWorkspaceId = the runtime's single data workspace (the provider-management tenant);
  // resolveResourceWorkspace stays null on this single-tenant runtime (target = the data workspace, membership-
  // checked) — a per-resource resolver is injected only in multi-tenant test fixtures for IDOR certification.
  const trustedProxySecret = readTrustedProxySecret();
  const dataWorkspaceId = (config.stagingApi && config.stagingApi.workspaceId) || null;
  const platformRoleResolver = platformService ? (userId) => platformService.resolvePlatformRole({ userId }) : null;
  const authorize = createAuthorizeEndpoint({ authService, enforcement, config, dataWorkspaceId, resolveResourceWorkspace: null, platformRoleResolver, trustedProxySecret, logger });

  return Object.freeze({ handles, handle, enabled: true, authService, enforcement, handler, httpConfig, authorize, platformService });
}
