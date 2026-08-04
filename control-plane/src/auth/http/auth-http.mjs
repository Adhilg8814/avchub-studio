// P0 Step 5C.22 (Checkpoint A) — native-auth HTTP transport. Framework-agnostic: handle(req) takes a
// normalized request { method, path, headers, ip } (+ parsed json body) and returns { status, headers, body }
// so it mounts into any server and is unit-testable without a socket. It is a THIN adapter over the certified
// AuthService: parse/validate input, enforce Origin + CSRF + rate-limit responses, call the service, map the
// TYPED result to an HTTP status, and set/clear the __Host-avc_studio_session cookie. It contains NO second
// copy of auth business logic. Identity comes ONLY from the opaque session cookie — never a client identity
// header. Default-OFF behind a feature flag; token/csrf/cookie values are never logged or echoed.

import { timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "__Host-avc_studio_session";
export const CSRF_HEADER = "x-avc-studio-csrf";
// Double-submit CSRF companion cookie: the RAW csrf token (the server stores only its hash). It is
// deliberately readable by same-origin JS (NOT HttpOnly) so a freshly-loaded authenticated page can echo it
// in the CSRF_HEADER; it is still Secure + __Host- + SameSite=Lax, so a cross-site attacker can neither read
// it nor forge the header. The session cookie stays HttpOnly.
export const CSRF_COOKIE = "__Host-avc_studio_csrf";

// ---- cookie ----
// The __Host- prefix REQUIRES Secure + Path=/ + no Domain (browser-enforced) — we always emit that shape.
export function serializeSessionCookie(token, { maxAgeMs, secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure"); // production always secure; a local test transport may relax over loopback
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return parts.join("; ");
}
export function clearSessionCookie({ secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
// The csrf companion cookie is NOT HttpOnly (same-origin JS reads it for the double-submit header).
export function serializeCsrfCookie(token, { maxAgeMs, secure = true } = {}) {
  const parts = [`${CSRF_COOKIE}=${token}`, "Path=/", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return parts.join("; ");
}
export function clearCsrfCookie({ secure = true } = {}) {
  const parts = [`${CSRF_COOKIE}=`, "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
// Parse ONLY our session cookie. Reject a duplicate (ambiguous) session cookie, oversize headers, and
// malformed encodings. NO fallback to a query token or an identity header.
export function parseSessionCookie(cookieHeader) {
  const h = typeof cookieHeader === "string" ? cookieHeader : "";
  if (h.length > 8192) return { ok: false, code: "COOKIE_TOO_LARGE" };
  const values = [];
  for (const pair of h.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    if (name === SESSION_COOKIE) values.push(pair.slice(idx + 1).trim());
  }
  if (values.length === 0) return { ok: false, code: "NO_COOKIE" };
  if (values.length > 1) return { ok: false, code: "DUPLICATE_COOKIE" };
  const token = values[0];
  if (!token || token.length < 20 || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return { ok: false, code: "MALFORMED_COOKIE" };
  return { ok: true, token };
}

// ---- Origin / Host (exact allowlist; no substring/suffix matching) ----
export function validateOrigin(headers, { allowedOrigins = [], requireForMutation = true } = {}) {
  const origin = headers.origin || headers.Origin || null;
  const allow = new Set(allowedOrigins);
  if (!origin) return requireForMutation ? { ok: false, code: "ORIGIN_MISSING" } : { ok: true, origin: null };
  let parsed; try { parsed = new URL(origin); } catch { return { ok: false, code: "ORIGIN_MALFORMED" }; }
  if (parsed.username || parsed.password) return { ok: false, code: "ORIGIN_USERINFO" };
  // exact string match against the configured origins (scheme+host+port must all match)
  return allow.has(`${parsed.protocol}//${parsed.host}`) ? { ok: true, origin } : { ok: false, code: "ORIGIN_NOT_ALLOWED" };
}

function ctEqualHex(aHex, bHex) {
  const a = Buffer.from(String(aHex || ""), "hex"), b = Buffer.from(String(bHex || ""), "hex");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// ---- typed result -> HTTP status ----
const RESULT_STATUS = {
  SESSION_ISSUED: 200, SESSION_ACTIVE: 200, OK: 200,
  WORKSPACE_SELECTION_REQUIRED: 200, MFA_REQUIRED: 200, MFA_ENROLLMENT_REQUIRED: 200,
  AUTHENTICATION_FAILED: 401, SESSION_EXPIRED: 401, SESSION_REVOKED: 401,
  REAUTH_REQUIRED: 403, PASSWORD_POLICY_VIOLATION: 400, RATE_LIMITED: 429,
  // owner bootstrap (§14–16)
  OWNER_BOOTSTRAP_STARTED: 200, BOOTSTRAP_UNAVAILABLE: 409, BOOTSTRAP_CONFLICT: 409
};
export function statusForResult(result) { return RESULT_STATUS[result] || 400; }

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Type": "application/json; charset=utf-8" };

// Strip fields that must never reach the response body / logs (internal hashes, ids beyond safe ones).
function safeBody(result) {
  if (!result || typeof result !== "object") return {};
  const { csrfHash, tokenHash, ...rest } = result; // defensive
  // session token is delivered ONLY via the cookie, never the JSON body
  const { sessionToken, ...noToken } = rest;
  return noToken;
}

export function createAuthHttpHandler({ authService, config = {}, clock = () => Date.now() } = {}) {
  if (!authService) throw new TypeError("createAuthHttpHandler requires authService");
  const allowedOrigins = config.allowedOrigins || [];
  const cookieSecure = config.cookieSecure !== false; // production: true
  const routesEnabled = () => config.nativeAuthRoutesEnabled === true;
  const absoluteMs = (authService._config && authService._config.session && authService._config.session.absoluteTimeoutMs) || 7 * 24 * 3600_000;

  const json = (status, body, extra = {}) => ({ status, headers: { ...AUTH_HEADERS, ...extra }, body });
  // Session issue sets BOTH cookies (HttpOnly session + readable csrf); clear removes both.
  const withSessionCookie = (res, token, csrfToken) => ({ ...res, headers: { ...res.headers, "Set-Cookie": [
    serializeSessionCookie(token, { maxAgeMs: absoluteMs, secure: cookieSecure }),
    serializeCsrfCookie(String(csrfToken || ""), { maxAgeMs: absoluteMs, secure: cookieSecure })
  ] } });
  const withClearCookie = (res) => ({ ...res, headers: { ...res.headers, "Set-Cookie": [
    clearSessionCookie({ secure: cookieSecure }), clearCsrfCookie({ secure: cookieSecure })
  ] } });

  // map a service result -> HTTP response, attaching cookie side-effects for issue/clear.
  const respond = (result, { clearOnFail = false } = {}) => {
    const status = statusForResult(result.result);
    let res = json(status, safeBody(result));
    if (result.result === "SESSION_ISSUED" && result.sessionToken) res = withSessionCookie(res, result.sessionToken, result.csrfToken);
    if (clearOnFail && (result.result === "SESSION_EXPIRED" || result.result === "SESSION_REVOKED")) res = withClearCookie(res);
    return res;
  };

  async function handle(req = {}) {
    const { method = "GET", path = "", headers = {}, body = {}, ip = null } = req;
    if (!routesEnabled()) return json(404, { error: "not_found" });
    if (!path.startsWith("/api/auth/")) return json(404, { error: "not_found" });
    const requestId = headers["x-request-id"] || null;

    // Origin required on every browser mutation (login/reset/etc. included, even pre-session).
    if (MUTATING.has(method)) {
      const o = validateOrigin(headers, { allowedOrigins, requireForMutation: true });
      if (!o.ok) return json(403, { error: "forbidden" }); // generic; no token/expected disclosed
    }

    // resolve the session (if any) once for authenticated routes + CSRF.
    const cookie = parseSessionCookie(headers.cookie || headers.Cookie);
    const resolveCtx = async () => (cookie.ok ? authService.resolveSession({ sessionToken: cookie.token, requestId }) : { ok: false, result: "SESSION_REVOKED" });
    // CSRF for cookie-authenticated mutations: double-submit — hashToken(header) must equal the session csrfHash.
    const csrfOk = (ctxResult, hashToken) => {
      const supplied = headers[CSRF_HEADER];
      if (!ctxResult.ok || !ctxResult.context.csrfHash || !supplied) return false;
      return ctEqualHex(hashToken(String(supplied)), ctxResult.context.csrfHash);
    };

    const route = path.slice("/api/auth/".length);
    const m = (p) => method === "POST" && route === p;

    try {
      // ---- one-time owner bootstrap (pre-session; gated by an EXPLICIT deploy flag; permanently closed
      // once an owner exists — the service returns BOOTSTRAP_UNAVAILABLE regardless of the flag). ----
      if (path.startsWith("/api/auth/bootstrap/")) {
        if (config.nativeAuthBootstrapEnabled !== true) return json(404, { error: "not_found" }); // route disabled/closed
        if (method === "GET" && route === "bootstrap/status") { const r = await authService.bootstrapStatus(); return json(200, { state: r.state, available: r.available }); }
        if (m("bootstrap/begin")) { const r = await authService.beginOwnerBootstrap({ email: body.email, password: body.password, displayName: body.displayName || null, bootstrapProof: body.bootstrapProof || null, requireProof: config.bootstrapRequireProof === true, ip }); return json(statusForResult(r.result), safeBody(r)); }
        if (m("bootstrap/confirm")) return respond(await authService.confirmOwnerBootstrap({ ceremonyToken: body.ceremonyToken, code: body.code, ip, userAgent: headers["user-agent"] }));
        return json(404, { error: "not_found" });
      }
      // ---- public (pre-session) endpoints — Origin already checked above ----
      if (m("login")) return respond(await authService.beginLogin({ email: body.email, password: body.password, requestedWorkspaceId: body.workspaceId || null, ip, userAgent: headers["user-agent"], requestId }));
      if (m("mfa/complete")) return respond(await authService.completeMfaLogin({ challengeToken: body.challengeToken, code: body.code, ip, userAgent: headers["user-agent"], requestId }));
      if (m("recovery/complete")) return respond(await authService.completeRecoveryLogin({ challengeToken: body.challengeToken, recoveryCode: body.recoveryCode, ip, userAgent: headers["user-agent"] }));
      if (m("mfa/enroll/confirm")) return respond(await authService.confirmTotpEnrollment({ challengeToken: body.challengeToken, code: body.code, ip, userAgent: headers["user-agent"] }));
      if (m("mfa/enroll/begin")) { const r = await authService.beginTotpEnrollment({ challengeToken: body.challengeToken }); return json(statusForResult(r.result), safeBody(r)); }
      if (m("password/forgot")) return respond(await authService.beginForgotPassword({ email: body.email, ip }));
      if (m("password/reset")) return respond(await authService.completePasswordReset({ token: body.token, newPassword: body.newPassword, ip }));
      if (m("invitations/inspect")) return json(200, await authService.inspectInvitation({ token: body.token })); // non-consuming preview
      if (m("invitations/accept")) return respond(await authService.acceptInvitation({ token: body.token, password: body.password, displayName: body.displayName || null, ip, userAgent: headers["user-agent"] }));
      if (m("email/verify")) return respond(await authService.completeEmailVerification({ token: body.token, ip }));

      // ---- authenticated endpoints (require a live session; mutations require CSRF) ----
      const ctx = await resolveCtx();
      const needAuth = () => (ctx.ok ? null : respond(ctx, { clearOnFail: true }));
      const needCsrf = (hashToken) => (csrfOk(ctx, hashToken) ? null : json(403, { error: "forbidden" }));

      if (method === "GET" && route === "session") return ctx.ok ? json(200, { ok: true, context: { userId: ctx.context.userId, workspaceId: ctx.context.workspaceId, role: ctx.context.role, authenticatedWithMfa: ctx.context.authenticatedWithMfa } }) : withClearCookie(json(401, { ok: false }));
      // Account-menu identity (session required, GET so no CSRF). Returns email + active workspace + the
      // switchable workspace list. Never a token/cookie/hash.
      if (method === "GET" && route === "me") { const a = needAuth(); if (a) return a; const d = await authService.describeSession({ sessionToken: cookie.token }); return d.ok ? json(200, d) : withClearCookie(json(401, { ok: false })); }
      if (method === "GET" && route === "sessions") return (needAuth() || json(200, await authService.listSessions({ sessionToken: cookie.token })));
      // read-only security surfaces (session required; no CSRF for a GET)
      if (method === "GET" && route === "mfa/status") return (needAuth() || json(200, await authService.listMfaStatus({ sessionToken: cookie.token })));
      if (method === "GET" && route === "recovery/status") return (needAuth() || json(200, await authService.listRecoveryCodeStatus({ sessionToken: cookie.token })));
      if (method === "GET" && route === "security/events") return (needAuth() || json(200, await authService.listSecurityEvents({ sessionToken: cookie.token, limit: 50 })));
      if (method === "GET" && route === "workspace/users") return (needAuth() || json(200, await authService.listWorkspaceUsersSafe({ sessionToken: cookie.token })));

      // everything below mutates -> session + CSRF required. The handler exposes hashToken via config.
      if (MUTATING.has(method)) {
        const a = needAuth(); if (a) return a;
        const c = needCsrf(config.hashToken); if (c) return c;
      }
      if (m("logout")) { await authService.logout({ sessionToken: cookie.token }); return withClearCookie(json(200, { ok: true })); }
      if (m("logout-all")) { await authService.logoutAll({ sessionToken: cookie.token }); return withClearCookie(json(200, { ok: true })); }
      if (m("logout-others")) return json(200, await authService.logoutOthers({ sessionToken: cookie.token }));
      if (method === "DELETE" && route.startsWith("sessions/")) return json(200, await authService.revokeSession({ sessionToken: cookie.token, targetSessionId: route.slice("sessions/".length) }));
      if (m("workspace/switch")) return respond(await authService.switchWorkspace({ sessionToken: cookie.token, targetWorkspaceId: body.workspaceId, ip, userAgent: headers["user-agent"] }));
      if (m("password/change")) return respond(await authService.changePassword({ sessionToken: cookie.token, currentPassword: body.currentPassword, newPassword: body.newPassword, ip, userAgent: headers["user-agent"] }));
      if (m("reauth/begin")) { const r = await authService.beginReauthentication({ sessionToken: cookie.token, action: body.action, method: body.method, ip }); return json(statusForResult(r.result), safeBody(r)); }
      if (m("reauth/password")) return respond(await authService.completePasswordReauthentication({ sessionToken: cookie.token, reauthToken: body.reauthToken, password: body.password, ip }));
      if (m("reauth/totp")) return respond(await authService.completeTotpReauthentication({ sessionToken: cookie.token, reauthToken: body.reauthToken, code: body.code, ip }));
      if (m("email/verify/begin")) return respond(await authService.beginEmailVerification({ sessionToken: cookie.token, ip }));
      // ---- security-settings sensitive actions (all require a fresh re-auth proof at the service layer) ----
      if (m("mfa/replace/begin")) { const r = await authService.beginTotpReplacement({ sessionToken: cookie.token, reauthToken: body.reauthToken, ip }); return json(statusForResult(r.result), safeBody(r)); }
      if (m("mfa/replace/confirm")) { const r = await authService.confirmTotpReplacement({ sessionToken: cookie.token, reauthToken: body.reauthToken, code: body.code, ip }); return json(statusForResult(r.result), safeBody(r)); }
      if (m("mfa/disable")) return respond(await authService.disableTotp({ sessionToken: cookie.token, reauthToken: body.reauthToken, ip }));
      if (m("recovery/regenerate")) { const r = await authService.regenerateRecoveryCodes({ sessionToken: cookie.token, reauthToken: body.reauthToken, ip }); return json(statusForResult(r.result), safeBody(r)); }
      // ---- workspace administration (OWNER/ADMIN; the service enforces the role + re-auth) ----
      if (m("invitations")) { const r = await authService.createInvitation({ sessionToken: cookie.token, email: body.email, role: body.role, ip }); return json(statusForResult(r.result), safeBody(r)); }
      if (m("invitations/resend")) { const r = await authService.resendInvitation({ sessionToken: cookie.token, invitationId: body.invitationId, ip }); return json(statusForResult(r.result), safeBody(r)); }
      if (method === "DELETE" && route.startsWith("invitations/")) return json(200, await authService.revokeInvitation({ sessionToken: cookie.token, invitationId: route.slice("invitations/".length), ip }));
      if (m("workspace/role")) { const r = await authService.updateWorkspaceRole({ sessionToken: cookie.token, targetUserId: body.targetUserId, role: body.role, ip }); return json(statusForResult(r.result), safeBody(r)); }
      if (m("workspace/members/suspend")) { const r = await authService.suspendWorkspaceMember({ sessionToken: cookie.token, targetUserId: body.targetUserId, ip }); return json(statusForResult(r.result), safeBody(r)); }
      if (m("workspace/members/reactivate")) { const r = await authService.reactivateWorkspaceMember({ sessionToken: cookie.token, targetUserId: body.targetUserId, ip }); return json(statusForResult(r.result), safeBody(r)); }
      if (method === "DELETE" && route.startsWith("workspace/users/")) return json(200, await authService.revokeWorkspaceMembership({ sessionToken: cookie.token, targetUserId: route.slice("workspace/users/".length), ip }));
      if (m("workspace/transfer")) return respond(await authService.transferWorkspaceOwnership({ sessionToken: cookie.token, reauthToken: body.reauthToken, targetUserId: body.targetUserId, ip }));

      return json(404, { error: "not_found" });
    } catch {
      return json(500, { error: "server_error" }); // never leak an internal reason
    }
  }

  return Object.freeze({ handle, SESSION_COOKIE, CSRF_HEADER });
}
