// P0 Step 5C.22 — runtime enforcement: gateway header hygiene, route classification, SSE enforcement, and
// the mount adapter (flags OFF passthrough / ON enforce), provider-free. Proves worker/browser trust-domain
// separation at the header + route-policy layer, SSE HTTP 401/403 + revalidation-close, and that the mount is
// INERT when flags are OFF.
import { buildForwardHeaders } from "../lib/ops/studio-gateway.mjs";
import { classifyRoute, ROUTE_POLICY } from "../control-plane/src/auth/http/auth-route-policy.mjs";
import { authenticateSseRequest, createSseController } from "../control-plane/src/auth/http/auth-sse.mjs";
import { createNativeAuthMiddleware } from "../control-plane/src/auth/http/auth-mount.mjs";
import { createEnforcement } from "../control-plane/src/auth/http/auth-enforcement.mjs";
import { createAuthHttpHandler, SESSION_COOKIE, CSRF_HEADER } from "../control-plane/src/auth/http/auth-http.mjs";
import { hashToken } from "../lib/auth/tokens.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const ORIGIN = "https://studio.example.com";

// ---- gateway header hygiene (§9) ----
const fwd = buildForwardHeaders({ "host": "x", "connection": "keep-alive", "cookie": "a=1", "content-type": "application/json", "x-user-id": "usr_evil", "x-workspace-id": "ws_evil", "x-role": "OWNER", "x-session-id": "s", "x-auth-strength": "MFA_TOTP", "x-avc-gateway": "spoofed-marker", "x-avc-gateway-foo": "1", "authorization": "Bearer x" }, "REALSECRET");
check("gateway strips hop-by-hop (connection/host)", !("host" in fwd) && !("connection" in fwd));
check("gateway strips spoofable identity headers", !("x-user-id" in fwd) && !("x-workspace-id" in fwd) && !("x-role" in fwd) && !("x-session-id" in fwd) && !("x-auth-strength" in fwd));
check("gateway strips inbound gateway markers + stamps real secret (anti-spoof)", !("x-avc-gateway-foo" in fwd) && fwd["x-avc-gateway"] === "REALSECRET");
check("gateway keeps legitimate headers", fwd["content-type"] === "application/json" && fwd["cookie"] === "a=1" && fwd["authorization"] === "Bearer x");

// ---- route classification (§8) ----
check("login -> PUBLIC_AUTH", classifyRoute("POST", "/api/auth/login").policy === ROUTE_POLICY.PUBLIC_AUTH);
check("session -> AUTHENTICATED", classifyRoute("GET", "/api/auth/session").policy === ROUTE_POLICY.AUTHENTICATED);
check("worker path -> WORKER (not browser session)", classifyRoute("POST", "/api/worker/lease/claim").policy === ROUTE_POLICY.WORKER);
check("pairing -> WORKER", classifyRoute("POST", "/api/pairing/complete").policy === ROUTE_POLICY.WORKER);
check("ws -> STREAM", classifyRoute("GET", "/ws").policy === ROUTE_POLICY.STREAM);
check("media -> MEDIA", classifyRoute("GET", "/api/provider-management/movies/mov_x/renders/rnd_y/media").policy === ROUTE_POLICY.MEDIA);
check("ops health -> PUBLIC", classifyRoute("GET", "/api/provider-management/ops/health").policy === ROUTE_POLICY.PUBLIC);
check("unknown /api/* -> AUTHENTICATED (fail closed)", classifyRoute("GET", "/api/provider-management/movies").policy === ROUTE_POLICY.AUTHENTICATED);

// ---- fakes ----
const CTX = { userId: "usr_x", workspaceId: "ws_x", role: "MEMBER", sessionId: "sess_x", authenticatedWithMfa: true, csrfHash: hashToken("csrf1") };
const fakeSvc = { _config: { session: { absoluteTimeoutMs: 1e9 } }, async resolveSession(a) { return a.sessionToken === "VALIDTOKENABCDEFGH1234567890" ? { ok: true, context: CTX } : { ok: false, result: "SESSION_REVOKED" }; }, async beginLogin() { return { result: "SESSION_ISSUED", ok: true, sessionToken: "TKN12345678901234567890", csrfToken: "c", session: {} }; } };
const cfgOn = { nativeAuthRoutesEnabled: true, nativeAuthEnforcementEnabled: true, allowedOrigins: [ORIGIN], cookieSecure: true, hashToken };
const cfgOff = { nativeAuthRoutesEnabled: false, nativeAuthEnforcementEnabled: false, allowedOrigins: [ORIGIN], cookieSecure: true, hashToken };
const enfOn = createEnforcement({ authService: fakeSvc, config: cfgOn, hashToken });
const handlerOn = createAuthHttpHandler({ authService: fakeSvc, config: cfgOn });
const cookie = (t) => `${SESSION_COOKIE}=${t}`;

async function run() {
  // ---- SSE (§2/§3) ----
  const sseNo = await authenticateSseRequest({ headers: { origin: ORIGIN } }, { enforcement: enfOn });
  check("SSE no cookie -> HTTP 401 (not a WS code)", sseNo.ok === false && sseNo.status === 401);
  const sseBadOrigin = await authenticateSseRequest({ headers: { origin: "https://evil.com", cookie: cookie("VALIDTOKENABCDEFGH1234567890") } }, { enforcement: enfOn });
  check("SSE bad Origin -> 403", sseBadOrigin.status === 403);
  const sseOk = await authenticateSseRequest({ headers: { origin: ORIGIN, cookie: cookie("VALIDTOKENABCDEFGH1234567890") } }, { enforcement: enfOn });
  check("SSE valid -> ok + context", sseOk.ok && sseOk.context.userId === "usr_x");
  // controller: workspace filter + revalidation close
  let clk = 1_000_000; const ctl = createSseController({ context: CTX, sessionToken: "t", revalidateMs: 30_000, absoluteExpiresAtMs: 2_000_000, clock: () => clk });
  check("SSE event same workspace passes", ctl.filterEvent({ workspaceId: "ws_x", data: 1 }) !== null);
  check("SSE cross-workspace event dropped", ctl.filterEvent({ workspaceId: "ws_OTHER", data: 1 }) === null);
  check("SSE heartbeat carries no secret", ctl.heartbeat() === ": keep-alive\n\n");
  check("SSE not due to revalidate yet", ctl.shouldRevalidate(clk + 10_000) === false);
  check("SSE due to revalidate after window", ctl.shouldRevalidate(clk + 31_000) === true);
  check("SSE revalidation with revoked session -> close", ctl.applyRevalidation({ ok: false }).close === true);
  const ctl2 = createSseController({ context: CTX, sessionToken: "t", clock: () => clk });
  check("SSE role downgrade -> close", ctl2.applyRevalidation({ ok: true, context: { ...CTX, role: "VIEWER" } }).close === true);
  check("SSE absolute expiry -> expired", ctl.expired(2_000_001) === true);

  // ---- mount adapter (§6) ----
  const mountOff = createNativeAuthMiddleware({ handler: handlerOn, enforcement: enfOn, flags: cfgOff });
  check("flags OFF: /api/auth/* NOT mounted (passthrough)", (await mountOff.middleware({ method: "POST", path: "/api/auth/login", headers: { origin: ORIGIN }, body: {} })).handled === false);
  check("flags OFF: protected route NOT enforced (passthrough)", (await mountOff.middleware({ method: "GET", path: "/api/provider-management/movies", headers: {} })).handled === false);

  const mountOn = createNativeAuthMiddleware({ handler: handlerOn, enforcement: enfOn, flags: cfgOn });
  const login = await mountOn.middleware({ method: "POST", path: "/api/auth/login", headers: { origin: ORIGIN }, body: {} });
  check("flags ON: /api/auth/login handled", login.handled === true && login.response.status === 200);
  const protNoAuth = await mountOn.middleware({ method: "GET", path: "/api/provider-management/movies", headers: {} });
  check("flags ON: protected route unauth -> 401 handled", protNoAuth.handled === true && protNoAuth.response.status === 401);
  const worker = await mountOn.middleware({ method: "POST", path: "/api/worker/lease/claim", headers: { cookie: cookie("VALIDTOKENABCDEFGH1234567890") }, body: {} });
  check("flags ON: WORKER route NOT browser-session enforced (passthrough)", worker.handled === false);
  const authed = await mountOn.middleware({ method: "GET", path: "/api/provider-management/movies", headers: { cookie: cookie("VALIDTOKENABCDEFGH1234567890") } });
  check("flags ON: authenticated GET -> passthrough with context", authed.handled === false && authed.context.userId === "usr_x");
  const mutNoCsrf = await mountOn.middleware({ method: "POST", path: "/api/provider-management/movies", headers: { origin: ORIGIN, cookie: cookie("VALIDTOKENABCDEFGH1234567890") }, body: {} });
  check("flags ON: authenticated mutation without CSRF -> 403", mutNoCsrf.handled === true && mutNoCsrf.response.status === 403);
  const mutCsrf = await mountOn.middleware({ method: "POST", path: "/api/provider-management/movies", headers: { origin: ORIGIN, cookie: cookie("VALIDTOKENABCDEFGH1234567890"), [CSRF_HEADER]: "csrf1" }, body: {} });
  check("flags ON: authenticated mutation with CSRF -> passthrough with context", mutCsrf.handled === false && mutCsrf.context.userId === "usr_x");

  // ---- startup gate: enforcement requested but migration behind -> inert (fail closed) ----
  const gated = createNativeAuthMiddleware({ handler: handlerOn, enforcement: enfOn, flags: cfgOn, startupGate: { flags: cfgOn, dbMigrationVersion: 21, requiredMigration: 29, ownerBootstrapped: true, cookieSecure: true, sessionConfigPresent: true } });
  check("startup gate migration-behind -> enforcement inert", gated.gate.ok === false && (await gated.middleware({ method: "GET", path: "/api/provider-management/movies", headers: {} })).handled === false);

  console.log(`Step 5C.22 runtime enforcement: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
