// P0 Step 5C.25 — the control-plane Policy DECISION Point (PDP): a NON-public internal endpoint the
// studio-gateway PEP calls to authorize a browser request BEFORE forwarding it to the enrollment/data
// upstream. Reachable ONLY with the valid trusted-gateway secret (constant-time; the gateway strips +
// re-stamps x-avc-gateway so a browser can never forge it) → unreachable from a browser. It resolves the
// opaque session cookie via the certified AuthService/enforcement, checks the user's membership+role in the
// TARGET workspace (resource's, else the runtime data workspace — resolved SERVER-SIDE, never client-
// asserted), enforces CSRF/Origin on mutations + role + strong-auth per route policy, and returns ONLY safe
// decision metadata (never a token/hash/secret). Fail-closed: no session → deny; unknown protected → deny.

import { classifyRoute, ROUTE_POLICY } from "../http/auth-route-policy.mjs";
import { parseSessionCookie } from "../http/auth-http.mjs";
import { canonicalRole } from "../auth-errors.mjs";
import { isFromTrustedGateway } from "../../../../lib/ops/gateway-trust.mjs";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PLATFORM_ROLES = new Set(["PLATFORM_OWNER", "PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
export const AUTHORIZE_ROUTE = "/internal/native-auth/authorize";
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

// Provider-management credential/secret + high-risk security actions require a fresh MFA (strong-auth).
function isStrongAuthRoute(method, path) {
  if (!MUTATING.has(method)) return false;
  return /\/api\/provider-management\/.*\/(credential|credentials|secret|rotate|enroll|enrollment)s?(\/|$)/.test(path)
    // P0 Step 5C.30 — acknowledging a SUBMIT_UNCERTAIN attempt asserts what did/did not reach a provider; it is
    // a high-trust reconciliation decision, so it requires a fresh MFA exactly like a credential rotation.
    || /\/api\/provider-management\/generations\/[^/]+\/uncertain-review$/.test(path)
    || /\/api\/provider-management\/(accounts|proxies)\/[^/]+$/.test(path) && method === "DELETE";
}
// Provider-management / workspace / user administration mutations require OWNER/ADMIN.
function isAdminMutation(method, path) {
  return MUTATING.has(method) && /\/api\/provider-management\//.test(path);
}
function isDocument(method, path) {
  return (method === "GET" || method === "HEAD") && !path.startsWith("/api/") && !path.startsWith("/auth-assets/") && !path.startsWith("/internal/");
}

export function createAuthorizeEndpoint({ authService, enforcement, config, dataWorkspaceId, resolveResourceWorkspace = null, platformRoleResolver = null, trustedProxySecret = null, logger = null } = {}) {
  if (!authService || !enforcement) throw new TypeError("authorize endpoint requires authService + enforcement");
  const na = (config && config.nativeAuth) || {};

  function handles(method, path) { return method === "POST" && path === AUTHORIZE_ROUTE; }

  function send(res, status, obj, ctx) {
    if (res.writableEnded) return;
    res.statusCode = status;
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    if (ctx && ctx.correlationId) res.setHeader("X-Correlation-Id", ctx.correlationId);
    res.end(JSON.stringify(obj));
  }

  function deny(status, denialClass, { redirect = null } = {}) { return { decision: "DENY", status, denialClass, ...(redirect ? { redirect } : {}) }; }

  // The pure decision (also unit-testable). Returns { decision:"ALLOW"|"DENY", status, denialClass?, context?, stripCookie? }.
  async function decide({ method = "GET", path = "", cookie = null, origin = null, csrf = null, accept = null }) {
    const policy = classifyRoute(method, path).policy;
    if (policy === ROUTE_POLICY.PUBLIC || policy === ROUTE_POLICY.PUBLIC_AUTH) return { decision: "ALLOW", policy };
    if (policy === ROUTE_POLICY.WORKER) return { decision: "ALLOW", policy, stripCookie: true }; // worker credential domain

    // authenticate (opaque cookie -> context, incl csrfHash) via the certified enforcement. The browser
    // Accept header is forwarded so a document request from a browser gets a 302 -> /login (not a bare 401).
    const headers = cookie ? { cookie } : {};
    if (accept) headers.accept = accept;
    const auth = await enforcement.authenticate({ headers, path }, { kind: isDocument(method, path) ? "document" : "api" });
    if (auth.bypassed) return { decision: "ALLOW", policy, reason: "ENFORCEMENT_OFF" };
    if (!auth.ok) return deny(401, "UNAUTHENTICATED", { redirect: auth.redirect || null });

    // CSRF + Origin for cookie-authenticated mutations (double-submit vs the session csrfHash)
    if (MUTATING.has(method)) {
      const c = enforcement.enforceCsrf({ method, headers: { origin: origin || "", "x-avc-studio-csrf": csrf || "" } }, auth.context);
      if (!c.ok) return deny(403, "FORBIDDEN");
    }

    // P0 Step 5C.29 — PLATFORM plane (Boss Manager). Authorized by the SEPARATE platform-admin role resolved
    // server-side (cp_platform_role), NEVER a workspace role. Fail-closed: no resolver / not a platform admin
    // -> 404 (hide the platform surface from tenants, cross-plane IDOR defense). Requires fresh MFA (now that
    // §Q1 is fixed). PLATFORM_SUPPORT is read-only (mutations require OWNER/ADMIN). No workspace is resolved.
    if (policy === ROUTE_POLICY.PLATFORM) {
      if (typeof platformRoleResolver !== "function") return deny(404, "RESOURCE_NOT_FOUND");
      let pr = null; try { pr = await platformRoleResolver(auth.context.userId); } catch { return { decision: "DENY", status: 503, denialClass: "ERROR" }; }
      const prole = pr && pr.status === "ACTIVE" ? pr.role : null;
      if (!prole || !PLATFORM_ROLES.has(prole)) return deny(404, "RESOURCE_NOT_FOUND");
      if (!auth.context.authenticatedWithMfa) return deny(403, "REAUTH_REQUIRED");
      if (MUTATING.has(method) && prole === "PLATFORM_SUPPORT") return deny(403, "FORBIDDEN");
      return { decision: "ALLOW", policy, context: { userId: auth.context.userId, platformRole: prole, authenticatedWithMfa: true } };
    }

    // resolve the TARGET workspace. Two modes:
    //  • single-tenant (platformEnabled OFF): the runtime's fixed data workspace wins — the historical
    //    behaviour, byte-identical, so current production is unaffected until multi-tenant is enabled.
    //  • multi-tenant (platformEnabled ON, P0 Step 5C.29 per-request workspace): the SESSION's active
    //    workspace (server-verified, resolved by enforcement from the session cookie — NEVER client-asserted)
    //    IS the target. This is what makes every browser data request scope to the requester's own workspace.
    //    The membership check below (isMemberOfTarget) fails closed if the session's active workspace is stale
    //    (member removed) — there is NO fallback to the data workspace or any other tenant.
    let targetWs = na.platformEnabled === true
      ? (auth.context.workspaceId || dataWorkspaceId || null)
      : (dataWorkspaceId || auth.context.workspaceId || null);
    if (typeof resolveResourceWorkspace === "function") {
      const r = await resolveResourceWorkspace(method, path);
      if (r && r.notFound) return deny(404, "RESOURCE_NOT_FOUND");
      if (r && r.workspaceId) targetWs = r.workspaceId;
    }

    // the user's canonical role in the TARGET workspace (membership resolved server-side via the definer)
    const az = await authService.resolveAuthorization({ sessionToken: parseSessionCookie(cookie).token, targetWorkspaceId: targetWs });
    if (!az.ok) return deny(401, "UNAUTHENTICATED");
    if (!az.isMemberOfTarget) return deny(404, "RESOURCE_NOT_FOUND"); // not a member of the target -> hide existence (cross-tenant IDOR)

    const role = canonicalRole(az.roleInTarget);
    const roleAdmin = role === "OWNER" || role === "ADMIN";
    if (policy === ROUTE_POLICY.ROLE_PROTECTED && !roleAdmin) return deny(403, "FORBIDDEN");
    if (isAdminMutation(method, path) && !roleAdmin) return deny(403, "FORBIDDEN");
    if ((policy === ROUTE_POLICY.STRONG_AUTH || isStrongAuthRoute(method, path)) && !az.authenticatedWithMfa) return deny(403, "REAUTH_REQUIRED");

    return { decision: "ALLOW", policy, context: { userId: az.userId, workspaceId: targetWs, role, authStrength: az.authStrength, authenticatedWithMfa: az.authenticatedWithMfa } };
  }

  async function handle(req, res, ctx) {
    try {
      // secret-gate: only the trusted gateway (constant-time). Missing/invalid -> 404 (hide existence).
      if (!trustedProxySecret || !isFromTrustedGateway(req.headers || {}, trustedProxySecret)) return send(res, 404, { error: "not_found" }, ctx);
      if (na.enforcementEnabled !== true) return send(res, 200, { decision: "ALLOW", reason: "ENFORCEMENT_OFF" }, ctx); // PEP inert until enforcement on
      const body = req.cpBody || {};
      const d = await decide({ method: body.method, path: body.path, cookie: body.cookie, origin: body.origin, csrf: body.csrf, accept: body.accept });
      return send(res, 200, d, ctx);
    } catch { return send(res, 200, { decision: "DENY", status: 500, denialClass: "ERROR" }, ctx); } // fail CLOSED on error
  }

  return Object.freeze({ handles, handle, decide, AUTHORIZE_ROUTE });
}
