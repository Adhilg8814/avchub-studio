// P0 Step 5C.1 — Control Plane API router (health-safe placeholder routes only).
//
// Exposes ONLY: /healthz, /readyz, /version, and (dev/test) /internal/config-summary. There
// is NO business logic and NO authenticated route. Unknown paths → structured 404; wrong
// method → 405. Nothing here leaks secrets or stack traces.

import { PROTOCOL_VERSION } from "../../../lib/protocol/message-types.mjs";
import { CP_ERRORS, ControlPlaneError } from "../errors.mjs";
import { safeConfigSummary } from "../config/config.mjs";
import { sendJson, sendError, sendRedirect } from "./responses.mjs";

// The Studio landing path: bare "/" redirects here (the canonical Movies / Content Studio view
// served by the production-ui sub-router). Relative target → resolves for both local loopback and
// the external studio origin; no open redirect.
const STUDIO_LANDING = "/movies";

// createRouter(deps): returns handle(req, res, ctx) — ctx from request-context. An optional
// `pairing` sub-router (Step 5C.5) handles the Worker claim + operator lifecycle surfaces; it is
// consulted first and only claims paths it recognizes (OFF by default), leaving all health/version
// routing untouched.
export function createRouter({ config, readiness, logger, authUi = null, authRuntime = null, authAuthorize = null, productionUi = null, stagingUi = null, pairing = null, stagingApi = null }) {
  const production = config.isProduction;
  const devOnly = config.isDevOrTest;
  // Business sub-routers consulted (in order) before the health/version routes; each only claims the
  // paths it recognizes (all OFF by default). authUi (native /login docs + /auth-assets) and authRuntime
  // (native /api/auth/* transport) are consulted FIRST and ONLY claim paths when their flags are on — OFF =>
  // handles() is false for every path, so routing is byte-for-byte unchanged; productionUi then owns "/" +
  // the canonical Studio routes + the legacy /staging page redirects.
  const subRouters = [authAuthorize, authUi, authRuntime, productionUi, stagingUi, pairing, stagingApi].filter((r) => r && typeof r.handles === "function");

  function route(method, path) {
    // Bare root is the Studio landing: GET/HEAD redirect to the Movies view so an authenticated
    // owner who opens https://studio.example.com/ (or the local origin) lands on the app instead of
    // a 404. Only "/" and only GET/HEAD are affected; every other path/method is unchanged.
    if (path === "/") return method === "GET" || method === "HEAD" ? studioLanding : notFound;
    if (path === "/healthz") return method === "GET" ? healthz : methodNotAllowed;
    if (path === "/readyz") return method === "GET" ? readyz : methodNotAllowed;
    if (path === "/version") return method === "GET" ? version : methodNotAllowed;
    if (path === "/internal/config-summary") {
      if (!devOnly) return notFound;                 // hidden outside dev/test
      return method === "GET" ? configSummary : methodNotAllowed;
    }
    return notFound;
  }

  function healthz(req, res, ctx) {
    // Liveness only — no dependency checks, returns fast.
    sendJson(res, 200, { status: "ok", alive: true }, { correlationId: ctx.correlationId });
  }

  function readyz(req, res, ctx) {
    const r = readiness();
    const body = { ready: r.ready, phase: r.phase, components: r.components };
    if (r.ready) sendJson(res, 200, body, { correlationId: ctx.correlationId });
    else sendJson(res, 503, { ...body, code: CP_ERRORS.E_DEPENDENCY_NOT_READY }, { correlationId: ctx.correlationId });
  }

  function version(req, res, ctx) {
    const body = {
      service: config.logging.serviceName,
      version: config.deployment.version,
      protocolVersion: PROTOCOL_VERSION,
      environment: config.server.environment,
      instanceId: config.deployment.instanceId
    };
    if (config.deployment.commitSha) body.commit = config.deployment.commitSha;
    sendJson(res, 200, body, { correlationId: ctx.correlationId });
  }

  function configSummary(req, res, ctx) {
    // Allowlisted, sanitized, non-secret metadata only.
    sendJson(res, 200, safeConfigSummary(config), { correlationId: ctx.correlationId });
  }

  function studioLanding(req, res, ctx) {
    sendRedirect(res, STUDIO_LANDING, { status: 303, correlationId: ctx.correlationId });
  }
  function notFound(req, res, ctx) {
    sendError(res, new ControlPlaneError(CP_ERRORS.E_NOT_FOUND, "Route not found"), { correlationId: ctx.correlationId, production });
  }
  function methodNotAllowed(req, res, ctx) {
    sendError(res, new ControlPlaneError(CP_ERRORS.E_METHOD_NOT_ALLOWED, "Method not allowed"), { correlationId: ctx.correlationId, production });
  }

  return function handle(req, res, ctx) {
    const path = normalizePath(req.url);
    // Business surfaces (5C.5 pairing, 5C.6 staging API) get first refusal; each only takes the
    // paths it owns, leaving health/version/config-summary untouched.
    for (const sub of subRouters) {
      if (sub.handles(ctx.method, path)) return void sub.handle(req, res, { ...ctx, path });
    }
    const handler = route(ctx.method, path);
    handler(req, res, { ...ctx, path });
  };
}

function normalizePath(url) {
  const raw = typeof url === "string" ? url : "/";
  const q = raw.indexOf("?");
  let path = q >= 0 ? raw.slice(0, q) : raw;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

export { normalizePath };
