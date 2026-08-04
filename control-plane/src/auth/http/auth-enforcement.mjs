// P0 Step 5C.22 (Checkpoint B/C) — native-auth enforcement middleware for PROTECTED routes (API/media/
// documents/WS/SSE). Reusable primitives every protected handler calls; identity comes ONLY from the opaque
// session cookie resolved through the certified AuthService (never a client identity header). All decisions
// are server-side: authenticate -> role -> strong-auth -> workspace/resource ownership. Cross-tenant objects
// answer 404 (not 403) so existence never leaks. Nothing here logs a cookie/token/csrf value.

import { parseSessionCookie, validateOrigin, CSRF_HEADER } from "./auth-http.mjs";
import { timingSafeEqual } from "node:crypto";
import { canonicalRole } from "../auth-errors.mjs";

const SECURITY_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function ctEqualHex(aHex, bHex) {
  const a = Buffer.from(String(aHex || ""), "hex"), b = Buffer.from(String(bHex || ""), "hex");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
// returnTo must be a SAME-ORIGIN relative path (defeat open redirect): starts with a single '/', no scheme,
// no '//' authority, no backslash, no control chars.
export function safeReturnTo(raw, { fallback = "/" } = {}) {
  const s = typeof raw === "string" ? raw : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.includes("\\") || /[\x00-\x1f]/.test(s) || /^\/[a-z][a-z0-9+.-]*:/i.test(s)) return fallback;
  return s.slice(0, 512);
}

// Roles that may perform workspace/user/security administration.
export function roleCanAdmin(role) { const r = canonicalRole(role); return r === "OWNER" || r === "ADMIN"; }
export function roleAtLeast(role, min) {
  const order = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };
  return (order[canonicalRole(role)] || 0) >= (order[canonicalRole(min)] || 99);
}

export function createEnforcement({ authService, config = {}, hashToken } = {}) {
  if (!authService || typeof authService.resolveSession !== "function") throw new TypeError("enforcement requires authService");
  if (typeof hashToken !== "function") throw new TypeError("enforcement requires hashToken");
  const allowedOrigins = config.allowedOrigins || [];
  const enforcementOn = () => config.nativeAuthEnforcementEnabled === true;

  const deny = (status, extra = {}) => ({ ok: false, response: { status, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" }, body: { error: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "not_found" } }, ...extra });
  const isBrowserDoc = (headers) => String(headers.accept || headers.Accept || "").includes("text/html");

  // Resolve the request to an auth context, or a denial (401 / browser redirect to /login).
  async function authenticate(req = {}, { kind = "api" } = {}) {
    if (!enforcementOn()) return { ok: true, context: null, bypassed: true }; // flag off -> not enforced (dev/default)
    const { headers = {}, path = "" } = req;
    const cookie = parseSessionCookie(headers.cookie || headers.Cookie);
    if (!cookie.ok) return kind === "document" && isBrowserDoc(headers) ? { ok: false, redirect: `/login?returnTo=${encodeURIComponent(safeReturnTo(path))}`, clearCookie: cookie.code !== "NO_COOKIE" } : deny(401, { clearCookie: cookie.code !== "NO_COOKIE" });
    const r = await authService.resolveSession({ sessionToken: cookie.token, requestId: headers["x-request-id"] || null });
    if (!r.ok) return kind === "document" && isBrowserDoc(headers) ? { ok: false, redirect: `/login?returnTo=${encodeURIComponent(safeReturnTo(path))}`, clearCookie: true } : deny(401, { clearCookie: true });
    return { ok: true, context: Object.freeze({ userId: r.context.userId, workspaceId: r.context.workspaceId, role: r.context.role, sessionId: r.context.sessionId, authenticatedWithMfa: r.context.authenticatedWithMfa, csrfHash: r.context.csrfHash || null }), cookieToken: cookie.token };
  }

  // CSRF for cookie-authenticated mutations (double-submit vs the session csrfHash) + Origin.
  function enforceCsrf(req = {}, context) {
    if (!enforcementOn()) return { ok: true };
    if (!MUTATING.has(req.method || "GET")) return { ok: true };
    const o = validateOrigin(req.headers || {}, { allowedOrigins, requireForMutation: true });
    if (!o.ok) return deny(403);
    const supplied = (req.headers || {})[CSRF_HEADER];
    if (!context || !context.csrfHash || !supplied || !ctEqualHex(hashToken(String(supplied)), context.csrfHash)) return deny(403);
    return { ok: true };
  }

  function requireRole(context, roles) {
    if (!enforcementOn()) return { ok: true };
    const allowed = Array.isArray(roles) ? roles : [roles];
    return allowed.some((r) => canonicalRole(context.role) === canonicalRole(r)) ? { ok: true } : deny(403);
  }

  // Strong-auth gate for the most sensitive ops: a recovery-code session may NOT perform them until a fresh
  // password/TOTP re-auth (enforced separately by the AuthService's reauth proof). Here we reject outright a
  // non-MFA context for an MFA-required action.
  function requireStrongAuth(context) {
    if (!enforcementOn()) return { ok: true };
    return context && context.authenticatedWithMfa ? { ok: true } : { ok: false, response: { status: 403, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json" }, body: { result: "REAUTH_REQUIRED", ok: false } } };
  }

  // Media/resource ownership: the resource's workspace must equal the session workspace. Cross-tenant -> 404
  // (existence hidden). Range requests are authorized BEFORE streaming (the caller checks .ok first).
  function authorizeResource(context, resourceWorkspaceId) {
    if (!enforcementOn()) return { ok: true };
    if (!context || !resourceWorkspaceId || context.workspaceId !== resourceWorkspaceId) return deny(404);
    return { ok: true };
  }

  // WebSocket/SSE close/deny codes (§5/§13/§14). 4401 unauth, 4403 forbidden, 4409 state changed.
  const wsClose = { UNAUTHENTICATED: 4401, FORBIDDEN: 4403, STATE_CHANGED: 4409 };
  async function authenticateSocket(req = {}) {
    if (!enforcementOn()) return { ok: true, context: null, bypassed: true };
    const o = validateOrigin(req.headers || {}, { allowedOrigins, requireForMutation: true });
    if (!o.ok) return { ok: false, closeCode: wsClose.FORBIDDEN };
    const a = await authenticate({ headers: req.headers || {}, path: req.path || "" }, { kind: "api" });
    if (!a.ok) return { ok: false, closeCode: wsClose.UNAUTHENTICATED };
    return { ok: true, context: a.context };
  }

  return Object.freeze({ authenticate, enforceCsrf, requireRole, requireStrongAuth, authorizeResource, authenticateSocket, wsClose, safeReturnTo, roleCanAdmin, roleAtLeast });
}
