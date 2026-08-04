// P0 Step 5C.22 (Checkpoint A) — native-auth HTTP transport, provider-free (fake AuthService, no DB).
// Proves: __Host cookie attributes + parsing (duplicate/malformed/oversize reject), clear cookie, Origin
// allowlist, typed-result -> HTTP status, feature-flag 404 gate, fail-closed enforcement gate, and the
// handler's cookie/CSRF/Origin/redaction behavior (session token only in the cookie, never the JSON body).
import { serializeSessionCookie, clearSessionCookie, parseSessionCookie, validateOrigin, statusForResult, createAuthHttpHandler, SESSION_COOKIE, CSRF_HEADER } from "../control-plane/src/auth/http/auth-http.mjs";
import { canEnableNativeEnforcement } from "../control-plane/src/auth/http/auth-http-config.mjs";
import { hashToken } from "../lib/auth/tokens.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };

// ---- cookie ----
const c = serializeSessionCookie("abcDEF012345678901234567890", { maxAgeMs: 3600_000 });
check("cookie has __Host name + Secure + HttpOnly + Path=/ + SameSite + no Domain", c.startsWith(`${SESSION_COOKIE}=`) && /Secure/.test(c) && /HttpOnly/.test(c) && /Path=\//.test(c) && /SameSite=Lax/.test(c) && !/Domain/i.test(c) && /Max-Age=3600/.test(c));
check("clear cookie Max-Age=0 empty value", clearSessionCookie().includes(`${SESSION_COOKIE}=;`) && /Max-Age=0/.test(clearSessionCookie()));
check("parse valid cookie", parseSessionCookie(`${SESSION_COOKIE}=abcDEF012345678901234567890`).token === "abcDEF012345678901234567890");
check("parse rejects duplicate session cookie", parseSessionCookie(`${SESSION_COOKIE}=aaaaaaaaaaaaaaaaaaaaa; ${SESSION_COOKIE}=bbbbbbbbbbbbbbbbbbbbb`).code === "DUPLICATE_COOKIE");
check("parse rejects malformed", parseSessionCookie(`${SESSION_COOKIE}=has spaces!!`).code === "MALFORMED_COOKIE");
check("parse rejects oversize", parseSessionCookie(`${SESSION_COOKIE}=` + "a".repeat(9000)).code === "COOKIE_TOO_LARGE");
check("parse no cookie", parseSessionCookie("other=1").code === "NO_COOKIE");
check("parse ignores query/other cookies (no fallback)", parseSessionCookie("session=xyz; foo=bar").code === "NO_COOKIE");

// ---- Origin ----
const ORIGINS = ["https://studio.example.com", "http://127.0.0.1:60453"];
check("origin allowed exact", validateOrigin({ origin: "https://studio.example.com" }, { allowedOrigins: ORIGINS }).ok === true);
check("origin suffix trick rejected", validateOrigin({ origin: "https://studio.example.com.evil.com" }, { allowedOrigins: ORIGINS }).ok === false);
check("origin wrong port rejected", validateOrigin({ origin: "http://127.0.0.1:9999" }, { allowedOrigins: ORIGINS }).ok === false);
check("origin userinfo rejected", validateOrigin({ origin: "https://user:pw@studio.example.com" }, { allowedOrigins: ORIGINS }).code === "ORIGIN_USERINFO");
check("origin missing on mutation rejected", validateOrigin({}, { allowedOrigins: ORIGINS, requireForMutation: true }).code === "ORIGIN_MISSING");

// ---- status mapping ----
check("SESSION_ISSUED->200", statusForResult("SESSION_ISSUED") === 200);
check("AUTHENTICATION_FAILED->401", statusForResult("AUTHENTICATION_FAILED") === 401);
check("REAUTH_REQUIRED->403", statusForResult("REAUTH_REQUIRED") === 403);
check("RATE_LIMITED->429", statusForResult("RATE_LIMITED") === 429);
check("MFA_REQUIRED->200", statusForResult("MFA_REQUIRED") === 200);
check("PASSWORD_POLICY_VIOLATION->400", statusForResult("PASSWORD_POLICY_VIOLATION") === 400);

// ---- fail-closed enforcement gate ----
check("enforcement gate all good -> ok", canEnableNativeEnforcement({ flags: { nativeAuthEnforcementEnabled: true }, dbMigrationVersion: 29, requiredMigration: 29, ownerBootstrapped: true, cookieSecure: true, sessionConfigPresent: true }).ok === true);
check("gate migration behind -> fail", canEnableNativeEnforcement({ flags: { nativeAuthEnforcementEnabled: true }, dbMigrationVersion: 21, requiredMigration: 29, ownerBootstrapped: true, cookieSecure: true, sessionConfigPresent: true }).reasons.includes("MIGRATION_BEHIND"));
check("gate flag off -> fail", canEnableNativeEnforcement({ flags: {}, dbMigrationVersion: 29, requiredMigration: 29, ownerBootstrapped: true, cookieSecure: true, sessionConfigPresent: true }).reasons.includes("FLAG_OFF"));
check("gate no owner -> fail", canEnableNativeEnforcement({ flags: { nativeAuthEnforcementEnabled: true }, dbMigrationVersion: 29, requiredMigration: 29, ownerBootstrapped: false, cookieSecure: true, sessionConfigPresent: true }).reasons.includes("OWNER_BOOTSTRAP_REQUIRED"));

// ---- handler with a fake AuthService ----
const calls = [];
const fakeSvc = {
  _config: { session: { absoluteTimeoutMs: 604800000 } },
  async beginLogin(a) { calls.push(["beginLogin", a]); if (a.password === "good") return { result: "SESSION_ISSUED", ok: true, sessionToken: "SESSIONPLAINTEXTABCDEFGH123456", csrfToken: "csrfplain", session: { role: "MEMBER", authenticatedWithMfa: false } }; if (a.password === "slow") return { result: "RATE_LIMITED", ok: false, retryAfterMs: 5000 }; return { result: "AUTHENTICATION_FAILED", ok: false }; },
  async resolveSession(a) { calls.push(["resolveSession", a]); if (a.sessionToken === "VALIDSESSIONTOKENABCDEFGH12345") return { ok: true, result: "SESSION_ACTIVE", context: { userId: "usr_x", workspaceId: "ws_x", role: "MEMBER", sessionId: "sess_x", authenticatedWithMfa: true, csrfHash: hashToken("mycsrf") } }; return { ok: false, result: "SESSION_REVOKED" }; },
  async logout(a) { calls.push(["logout", a]); return { ok: true }; },
  async listSessions() { return { ok: true, sessions: [] }; },
  async switchWorkspace() { return { result: "SESSION_ISSUED", ok: true, sessionToken: "NEWSESSIONTOKENABCDEFGH1234567", csrfToken: "newcsrf", session: { activeWorkspaceId: "ws_y" } }; }
};
const handler = createAuthHttpHandler({ authService: fakeSvc, config: { nativeAuthRoutesEnabled: true, allowedOrigins: ORIGINS, cookieSecure: true, hashToken } });

async function run() {
  // flag off -> 404
  const off = createAuthHttpHandler({ authService: fakeSvc, config: { nativeAuthRoutesEnabled: false, allowedOrigins: ORIGINS, hashToken } });
  check("routes disabled by flag -> 404", (await off.handle({ method: "POST", path: "/api/auth/login", headers: { origin: ORIGINS[0] }, body: { email: "a@b.co", password: "good" } })).status === 404);

  // login success -> 200 + Set-Cookie (token NOT in body), csrfToken IS in body, no-store
  const login = await handler.handle({ method: "POST", path: "/api/auth/login", headers: { origin: ORIGINS[0] }, body: { email: "a@b.co", password: "good" } });
  check("login 200 + Set-Cookie __Host", login.status === 200 && String(login.headers["Set-Cookie"]).startsWith(`${SESSION_COOKIE}=SESSIONPLAINTEXT`) && /HttpOnly/.test(login.headers["Set-Cookie"]));
  check("login body has csrfToken but NOT sessionToken", login.body.csrfToken === "csrfplain" && !("sessionToken" in login.body));
  check("login Cache-Control no-store", login.headers["Cache-Control"] === "no-store");
  check("no session token string in body JSON", !JSON.stringify(login.body).includes("SESSIONPLAINTEXT"));

  // wrong password -> 401
  check("wrong password -> 401", (await handler.handle({ method: "POST", path: "/api/auth/login", headers: { origin: ORIGINS[0] }, body: { email: "a@b.co", password: "bad" } })).status === 401);
  // rate limited -> 429
  check("rate limited -> 429", (await handler.handle({ method: "POST", path: "/api/auth/login", headers: { origin: ORIGINS[0] }, body: { email: "a@b.co", password: "slow" } })).status === 429);
  // mutation without Origin -> 403
  check("mutation without Origin -> 403", (await handler.handle({ method: "POST", path: "/api/auth/login", headers: {}, body: {} })).status === 403);
  // mutation bad Origin -> 403
  check("mutation bad Origin -> 403", (await handler.handle({ method: "POST", path: "/api/auth/login", headers: { origin: "https://evil.com" }, body: {} })).status === 403);

  // GET session without cookie -> 401 + clears cookie
  const noSess = await handler.handle({ method: "GET", path: "/api/auth/session", headers: {} });
  check("GET session no cookie -> 401 + clear cookie", noSess.status === 401 && /Max-Age=0/.test(noSess.headers["Set-Cookie"]));
  // GET session with valid cookie -> 200 context (no secret)
  const sess = await handler.handle({ method: "GET", path: "/api/auth/session", headers: { cookie: `${SESSION_COOKIE}=VALIDSESSIONTOKENABCDEFGH12345` } });
  check("GET session valid -> 200 + safe context", sess.status === 200 && sess.body.context.userId === "usr_x" && !("csrfHash" in sess.body.context));

  // authenticated mutation WITHOUT csrf -> 403
  const noCsrf = await handler.handle({ method: "POST", path: "/api/auth/workspace/switch", headers: { origin: ORIGINS[0], cookie: `${SESSION_COOKIE}=VALIDSESSIONTOKENABCDEFGH12345` }, body: { workspaceId: "ws_y" } });
  check("authenticated mutation without CSRF -> 403", noCsrf.status === 403);
  // WITH correct csrf -> 200 + rotates cookie
  const withCsrf = await handler.handle({ method: "POST", path: "/api/auth/workspace/switch", headers: { origin: ORIGINS[0], cookie: `${SESSION_COOKIE}=VALIDSESSIONTOKENABCDEFGH12345`, [CSRF_HEADER]: "mycsrf" }, body: { workspaceId: "ws_y" } });
  check("authenticated mutation with CSRF -> 200 + new Set-Cookie", withCsrf.status === 200 && String(withCsrf.headers["Set-Cookie"]).startsWith(`${SESSION_COOKIE}=NEWSESSIONTOKEN`));
  // wrong csrf -> 403
  check("wrong CSRF -> 403", (await handler.handle({ method: "POST", path: "/api/auth/workspace/switch", headers: { origin: ORIGINS[0], cookie: `${SESSION_COOKIE}=VALIDSESSIONTOKENABCDEFGH12345`, [CSRF_HEADER]: "wrong" }, body: {} })).status === 403);

  // logout clears cookie
  const lo = await handler.handle({ method: "POST", path: "/api/auth/logout", headers: { origin: ORIGINS[0], cookie: `${SESSION_COOKIE}=VALIDSESSIONTOKENABCDEFGH12345`, [CSRF_HEADER]: "mycsrf" }, body: {} });
  check("logout -> 200 + clear cookie", lo.status === 200 && /Max-Age=0/.test(lo.headers["Set-Cookie"]));

  console.log(`Step 5C.22 auth http transport: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
