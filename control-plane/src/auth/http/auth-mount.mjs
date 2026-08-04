// P0 Step 5C.22 — native-auth mount adapter (§6). ONE integration point the runtime/gateway calls before
// its normal routing. It does NOT create a parallel router: it returns { handled } so the host either sends
// the produced response or continues to its existing handler. Behavior is INERT when flags are OFF (the
// production default) — production routing is byte-for-byte unchanged. When ON (test harness) it mounts the
// /api/auth/* routes and enforces the centralized route policy on protected routes; WORKER routes never pass
// through browser-session middleware; unknown Studio APIs fail closed (authenticated required).

import { classifyRoute, ROUTE_POLICY } from "./auth-route-policy.mjs";
import { canEnableNativeEnforcement } from "./auth-http-config.mjs";
import { clearSessionCookie } from "./auth-http.mjs";

export function createNativeAuthMiddleware({ handler, enforcement, flags = {}, startupGate = null } = {}) {
  if (!handler || typeof handler.handle !== "function") throw new TypeError("mount requires the auth http handler");
  if (!enforcement) throw new TypeError("mount requires enforcement");
  const routesOn = () => flags.nativeAuthRoutesEnabled === true;
  const enforceOn = () => flags.nativeAuthEnforcementEnabled === true;

  // Fail-closed startup: if enforcement is requested but a precondition (migration/owner/cookie/config) is
  // missing, the mount refuses to enforce (the host should refuse to start / stay on the outer gate).
  const gate = startupGate ? canEnableNativeEnforcement(startupGate) : { ok: true, reasons: [] };
  const enforcementActive = () => enforceOn() && gate.ok;

  async function middleware(req = {}) {
    const path = String(req.path || "").split("?")[0];
    // native auth routes only mount when routes are enabled
    if (path.startsWith("/api/auth/")) {
      if (!routesOn()) return { handled: false }; // routes OFF -> not mounted (host may 404 or ignore)
      return { handled: true, response: await handler.handle(req) };
    }
    if (!enforcementActive()) return { handled: false }; // enforcement OFF/gated -> host behaves exactly as before

    const { policy, document } = classifyRoute(req.method, path);
    if (policy === ROUTE_POLICY.WORKER || policy === ROUTE_POLICY.PUBLIC || policy === ROUTE_POLICY.PUBLIC_AUTH) return { handled: false };

    // authenticate (browser document -> redirect; API/media/stream -> 401)
    const auth = await enforcement.authenticate({ headers: req.headers || {}, path }, { kind: document ? "document" : "api" });
    if (auth.bypassed) return { handled: false };
    if (!auth.ok) {
      if (auth.redirect) return { handled: true, response: { status: 302, headers: { Location: auth.redirect, "Cache-Control": "no-store", ...(auth.clearCookie ? { "Set-Cookie": clearSessionCookie({ secure: flags.cookieSecure !== false }) } : {}) }, body: null } };
      return { handled: true, response: auth.response };
    }
    // authenticated: enforce CSRF on mutations, then let the host handler run WITH the resolved context.
    const csrf = enforcement.enforceCsrf(req, auth.context);
    if (!csrf.ok) return { handled: true, response: csrf.response };
    return { handled: false, context: auth.context }; // host continues its normal routing, now trusted
  }

  return Object.freeze({ middleware, gate, routesOn, enforcementActive });
}
