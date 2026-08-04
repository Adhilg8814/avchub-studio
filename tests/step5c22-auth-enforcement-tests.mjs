// P0 Step 5C.22 (Checkpoint B/C) — native-auth enforcement middleware, provider-free (fake AuthService).
// Proves: authenticate (flag-off bypass, API 401, browser redirect, valid context, clear-on-invalid),
// safeReturnTo open-redirect defense, CSRF+Origin, role gate, strong-auth gate, media cross-tenant 404,
// and WebSocket/SSE 4401/4403.
import { createEnforcement, safeReturnTo, roleCanAdmin, roleAtLeast } from "../control-plane/src/auth/http/auth-enforcement.mjs";
import { SESSION_COOKIE, CSRF_HEADER } from "../control-plane/src/auth/http/auth-http.mjs";
import { hashToken } from "../lib/auth/tokens.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };

// safeReturnTo
check("returnTo relative path ok", safeReturnTo("/movies/123") === "/movies/123");
check("returnTo protocol-relative rejected", safeReturnTo("//evil.com") === "/");
check("returnTo absolute url rejected", safeReturnTo("https://evil.com") === "/");
check("returnTo backslash rejected", safeReturnTo("/\\evil") === "/");
check("returnTo scheme rejected", safeReturnTo("/javascript:alert(1)") === "/");

// role helpers
check("OWNER/ADMIN can admin", roleCanAdmin("OWNER") && roleCanAdmin("ADMIN") && !roleCanAdmin("MEMBER"));
check("roleAtLeast ordering", roleAtLeast("ADMIN", "MEMBER") && !roleAtLeast("VIEWER", "MEMBER") && roleAtLeast("OWNER", "OWNER"));
check("legacy EDITOR maps to MEMBER for gate", roleAtLeast("EDITOR", "MEMBER") && roleCanAdmin("BILLING_OWNER") === true);

const CTX = { userId: "usr_x", workspaceId: "ws_x", role: "MEMBER", sessionId: "sess_x", authenticatedWithMfa: false, csrfHash: hashToken("csrf1") };
const CTX_MFA = { ...CTX, authenticatedWithMfa: true };
const fakeSvc = { async resolveSession(a) { if (a.sessionToken === "VALIDTOKENABCDEFGH1234567890") return { ok: true, context: CTX }; if (a.sessionToken === "MFATOKENABCDEFGH123456789012") return { ok: true, context: CTX_MFA }; return { ok: false, result: "SESSION_REVOKED" }; } };
const ORIGINS = ["https://studio.example.com"];
const on = createEnforcement({ authService: fakeSvc, config: { nativeAuthEnforcementEnabled: true, allowedOrigins: ORIGINS }, hashToken });
const off = createEnforcement({ authService: fakeSvc, config: { nativeAuthEnforcementEnabled: false, allowedOrigins: ORIGINS }, hashToken });
const cookie = (t) => `${SESSION_COOKIE}=${t}`;

async function run() {
  // flag off -> bypassed
  check("flag off -> bypass", (await off.authenticate({ headers: {}, path: "/x" })).bypassed === true);

  // API no cookie -> 401
  const apiNo = await on.authenticate({ headers: {}, path: "/api/x" }, { kind: "api" });
  check("API no cookie -> 401", apiNo.ok === false && apiNo.response.status === 401);
  // browser doc no cookie -> redirect with safe returnTo
  const docNo = await on.authenticate({ headers: { accept: "text/html" }, path: "/movies" }, { kind: "document" });
  check("browser doc no cookie -> redirect /login?returnTo", docNo.ok === false && docNo.redirect === "/login?returnTo=%2Fmovies");
  // invalid session -> 401 + clearCookie
  const bad = await on.authenticate({ headers: { cookie: cookie("BADTOKENABCDEFGH123456789012") }, path: "/api/x" });
  check("invalid session -> 401 + clearCookie", bad.response.status === 401 && bad.clearCookie === true);
  // valid -> frozen context (no leak of csrfHash to business? it's kept for CSRF but not a secret)
  const ok = await on.authenticate({ headers: { cookie: cookie("VALIDTOKENABCDEFGH1234567890") }, path: "/api/x" });
  check("valid session -> context", ok.ok && ok.context.userId === "usr_x" && Object.isFrozen(ok.context));

  // CSRF + Origin
  check("GET not CSRF-checked", on.enforceCsrf({ method: "GET", headers: {} }, CTX).ok === true);
  check("mutation no Origin -> 403", on.enforceCsrf({ method: "POST", headers: {} }, CTX).response.status === 403);
  check("mutation bad Origin -> 403", on.enforceCsrf({ method: "POST", headers: { origin: "https://evil.com", [CSRF_HEADER]: "csrf1" } }, CTX).response.status === 403);
  check("mutation no CSRF -> 403", on.enforceCsrf({ method: "POST", headers: { origin: ORIGINS[0] } }, CTX).response.status === 403);
  check("mutation correct CSRF+Origin -> ok", on.enforceCsrf({ method: "POST", headers: { origin: ORIGINS[0], [CSRF_HEADER]: "csrf1" } }, CTX).ok === true);
  check("mutation wrong CSRF -> 403", on.enforceCsrf({ method: "POST", headers: { origin: ORIGINS[0], [CSRF_HEADER]: "nope" } }, CTX).response.status === 403);

  // role gate
  check("role gate allow MEMBER", on.requireRole(CTX, ["MEMBER", "ADMIN"]).ok === true);
  check("role gate deny VIEWER for ADMIN", on.requireRole({ ...CTX, role: "VIEWER" }, ["ADMIN"]).response.status === 403);

  // strong auth
  check("strong auth: non-MFA -> REAUTH_REQUIRED 403", on.requireStrongAuth(CTX).response.body.result === "REAUTH_REQUIRED");
  check("strong auth: MFA -> ok", on.requireStrongAuth(CTX_MFA).ok === true);

  // media/resource ownership -> cross-tenant 404
  check("resource same workspace -> ok", on.authorizeResource(CTX, "ws_x").ok === true);
  check("resource cross-tenant -> 404 (hide existence)", on.authorizeResource(CTX, "ws_OTHER").response.status === 404);

  // websocket
  check("WS no cookie -> 4401", (await on.authenticateSocket({ headers: { origin: ORIGINS[0] }, path: "/ws" })).closeCode === 4401);
  check("WS bad origin -> 4403", (await on.authenticateSocket({ headers: { origin: "https://evil.com", cookie: cookie("VALIDTOKENABCDEFGH1234567890") } })).closeCode === 4403);
  check("WS valid -> context", (await on.authenticateSocket({ headers: { origin: ORIGINS[0], cookie: cookie("VALIDTOKENABCDEFGH1234567890") } })).context.userId === "usr_x");

  console.log(`Step 5C.22 auth enforcement: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
