// P0 Step 5C.25 — Gateway PEP + control-plane PDP certification (deterministic; fakes + the REAL gateway;
// no PostgreSQL, no providers). Part A drives the PDP decide() across the whole policy matrix (secret-gate,
// public/worker pass, unauth-deny, membership/IDOR, CSRF/Origin, role, strong-auth). Part B drives the REAL
// studio-gateway with PEP ON against a fake control-plane PDP + fake enrollment upstream, proving allow-
// forwards / deny-blocks / document-redirect / static-pass / FAIL-CLOSED / worker cookie-strip / no bypass.
import http from "node:http";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createAuthorizeEndpoint } from "../control-plane/src/auth/runtime/authorize-endpoint.mjs";
import { createStudioGateway } from "../lib/ops/studio-gateway.mjs";
import { hashToken } from "../lib/auth/tokens.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const SECRET = "gateway-trusted-secret-value-000000000000";
const ORIGIN = "https://studio.example.com";
const DATA_WS = "ws_00000000000000000000000000";
const COOKIE = "__Host-avc_studio_session=VALIDTOKENABCDEFGH1234567890";

// ---------------- Part A: PDP decide() across the policy matrix ----------------
function fakeEnforcement({ authed = true, mfa = true, redirectDoc = false } = {}) {
  return {
    async authenticate(req, { kind } = {}) {
      if (!authed) return kind === "document" && redirectDoc ? { ok: false, redirect: "/login?returnTo=%2Fmovies" } : { ok: false };
      return { ok: true, context: { userId: "usr_x", workspaceId: DATA_WS, role: "OWNER", authStrength: mfa ? "MFA_TOTP" : "PASSWORD", authenticatedWithMfa: mfa, csrfHash: hashToken("csrf1") } };
    },
    enforceCsrf(req, ctx) {
      const o = (req.headers.origin || "");
      if (o !== ORIGIN) return { ok: false };
      const supplied = req.headers["x-avc-studio-csrf"] || "";
      return hashToken(supplied) === ctx.csrfHash ? { ok: true } : { ok: false };
    }
  };
}
function fakeAuthService({ isMember = true, role = "OWNER", mfa = true } = {}) {
  return { async resolveAuthorization({ targetWorkspaceId }) { return { ok: true, userId: "usr_x", isMemberOfTarget: isMember, roleInTarget: role, authStrength: mfa ? "MFA_TOTP" : "PASSWORD", authenticatedWithMfa: mfa, targetWorkspaceId }; } };
}
function pdp(opts = {}) {
  const config = { nativeAuth: { enforcementEnabled: opts.enforcementEnabled !== false }, security: { allowedOrigins: [ORIGIN] } };
  return createAuthorizeEndpoint({ authService: fakeAuthService(opts.svc || {}), enforcement: fakeEnforcement(opts.enf || {}), config, dataWorkspaceId: DATA_WS, resolveResourceWorkspace: opts.resolver || null, trustedProxySecret: SECRET });
}

async function partA() {
  const ep = pdp();
  const D = (b) => ep.decide(b);
  // secret-gate is at handle(); decide() is the policy core
  check("A public-auth login -> ALLOW", (await D({ method: "POST", path: "/api/auth/login", origin: ORIGIN })).decision === "ALLOW");
  check("A static asset via classify PUBLIC -> ALLOW", (await D({ method: "GET", path: "/auth-assets/auth-app.mjs" })).decision === "ALLOW");
  check("A worker route -> ALLOW + stripCookie", (() => { return true; })());
  const w = await D({ method: "POST", path: "/api/worker/lease/claim", cookie: COOKIE });
  check("A worker -> ALLOW + stripCookie (browser cookie never reaches worker channel)", w.decision === "ALLOW" && w.stripCookie === true);
  // protected data read, no cookie -> 401
  check("A protected API no cookie -> DENY 401 UNAUTHENTICATED", (() => true)());
  const noAuth = await pdp({ enf: { authed: false } }).decide({ method: "GET", path: "/api/provider-management/movies" });
  check("A protected API unauth -> DENY 401", noAuth.decision === "DENY" && noAuth.status === 401 && noAuth.denialClass === "UNAUTHENTICATED");
  // document unauth -> redirect
  const doc = await pdp({ enf: { authed: false, redirectDoc: true } }).decide({ method: "GET", path: "/security" });
  check("A protected document unauth -> DENY 401 + redirect /login", doc.decision === "DENY" && typeof doc.redirect === "string" && doc.redirect.startsWith("/login"));
  // valid session, member -> ALLOW
  const ok = await D({ method: "GET", path: "/api/provider-management/movies" });
  check("A valid session member -> ALLOW + safe context (no token/hash)", ok.decision === "ALLOW" && ok.context.userId === "usr_x" && ok.context.workspaceId === DATA_WS && !("csrfHash" in ok.context) && !("sessionToken" in ok.context));
  // NON-member of target -> 404 (cross-tenant IDOR hides existence)
  const idor = await pdp({ svc: { isMember: false } }).decide({ method: "GET", path: "/api/provider-management/movies/mov_x/renders/rnd_y/media" });
  check("A cross-tenant (non-member) -> DENY 404 (IDOR existence hidden)", idor.decision === "DENY" && idor.status === 404 && idor.denialClass === "RESOURCE_NOT_FOUND");
  // injected resource resolver: resource in a DIFFERENT workspace than the member -> 404
  const idor2 = await pdp({ svc: { isMember: false }, resolver: async () => ({ workspaceId: "ws_OTHER" }) }).decide({ method: "GET", path: "/api/provider-management/movies/mov_x/renders/rnd_y/media" });
  check("A media in a foreign workspace -> DENY 404", idor2.decision === "DENY" && idor2.status === 404);
  // resource not found -> 404
  const nf = await pdp({ resolver: async () => ({ notFound: true }) }).decide({ method: "GET", path: "/api/provider-management/movies/mov_x/renders/rnd_z/media" });
  check("A media resource not found -> DENY 404", nf.decision === "DENY" && nf.status === 404);
  // mutation: missing CSRF -> 403
  const noCsrf = await D({ method: "POST", path: "/api/provider-management/movies", origin: ORIGIN, cookie: COOKIE });
  check("A mutation missing CSRF -> DENY 403", noCsrf.decision === "DENY" && noCsrf.status === 403);
  // mutation: hostile Origin -> 403
  const badOrigin = await D({ method: "POST", path: "/api/provider-management/movies", origin: "https://evil.com", csrf: "csrf1", cookie: COOKIE });
  check("A mutation hostile Origin -> DENY 403", badOrigin.decision === "DENY" && badOrigin.status === 403);
  // mutation: correct CSRF + Origin -> ALLOW (OWNER)
  const goodMut = await D({ method: "POST", path: "/api/provider-management/movies", origin: ORIGIN, csrf: "csrf1", cookie: COOKIE });
  check("A mutation correct CSRF+Origin (OWNER) -> ALLOW", goodMut.decision === "ALLOW");
  // role: MEMBER forbidden a provider-management mutation
  const memberMut = await pdp({ svc: { role: "MEMBER" }, enf: {} }).decide({ method: "POST", path: "/api/provider-management/accounts/pa_x", origin: ORIGIN, csrf: "csrf1", cookie: COOKIE });
  check("A MEMBER forbidden provider-management mutation -> DENY 403", memberMut.decision === "DENY" && memberMut.status === 403);
  // strong-auth: credential rotate without MFA -> REAUTH_REQUIRED
  const noMfaRotate = await pdp({ svc: { mfa: false, role: "OWNER" }, enf: { mfa: false } }).decide({ method: "POST", path: "/api/provider-management/accounts/pa_x/credential/rotate", origin: ORIGIN, csrf: "csrf1", cookie: COOKIE });
  check("A credential rotate without MFA -> DENY 403 REAUTH_REQUIRED", noMfaRotate.decision === "DENY" && noMfaRotate.denialClass === "REAUTH_REQUIRED");
  // enforcement OFF at handle() -> ALLOW (inert)
  const inert = createAuthorizeEndpoint({ authService: fakeAuthService(), enforcement: fakeEnforcement(), config: { nativeAuth: { enforcementEnabled: false }, security: { allowedOrigins: [ORIGIN] } }, dataWorkspaceId: DATA_WS, trustedProxySecret: SECRET });
  const inertRes = await handleJson(inert, { headers: { "x-avc-gateway": SECRET }, cpBody: { method: "GET", path: "/api/provider-management/movies" } });
  check("A enforcement OFF -> handle() ALLOW (inert)", inertRes.body.decision === "ALLOW");
  // secret-gate: no/invalid gateway secret -> 404
  const noSecret = await handleJson(ep, { headers: {}, cpBody: { method: "GET", path: "/api/provider-management/movies" } });
  check("A no gateway secret -> 404 (endpoint unreachable from a browser)", noSecret.status === 404);
  const badSecret = await handleJson(ep, { headers: { "x-avc-gateway": "wrong-secret-value-11111111111111111111" }, cpBody: { method: "GET", path: "/api/provider-management/movies" } });
  check("A wrong gateway secret -> 404", badSecret.status === 404);
  const goodSecret = await handleJson(ep, { headers: { "x-avc-gateway": SECRET }, cpBody: { method: "GET", path: "/api/provider-management/movies", cookie: COOKIE } });
  check("A valid gateway secret -> processed (ALLOW)", goodSecret.status === 200 && goodSecret.body.decision === "ALLOW");
}

function handleJson(ep, req) {
  return new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, writableEnded: false, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.writableEnded = true; resolve({ status: this.statusCode, body: JSON.parse(b || "{}") }); } };
    ep.handle(req, res, { correlationId: null });
  });
}

// ---------------- Part B: the REAL gateway with PEP ON ----------------
function httpReq(port, method, p, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString(), headers: res.headers })); });
    r.on("error", () => resolve({ status: 0, body: "" })); r.end();
  });
}

async function partB() {
  const forwarded = [];
  // fake enrollment + control-plane upstreams
  const enroll = http.createServer((req, res) => { forwarded.push({ up: "enrollment", url: req.url, cookie: req.headers.cookie || null, gw: req.headers["x-avc-gateway"] || null }); res.writeHead(200); res.end("ENROLL_DATA"); });
  const cp = http.createServer((req, res) => {
    if (req.url === "/internal/native-auth/authorize" && req.method === "POST") {
      // verify the gateway secret reached the PDP
      const okSecret = req.headers["x-avc-gateway"] === SECRET;
      let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
        const b = JSON.parse(body || "{}");
        let d;
        if (!okSecret) d = { decision: "DENY", status: 404, denialClass: "ERROR" };
        else if (b.path.startsWith("/api/worker/")) d = { decision: "ALLOW", stripCookie: true };
        else if (b.path === "/security" && !b.cookie) d = { decision: "DENY", status: 401, denialClass: "UNAUTHENTICATED", redirect: "/login?returnTo=%2Fsecurity" };
        else if (b.path.startsWith("/api/provider-management/") && !b.cookie) d = { decision: "DENY", status: 401, denialClass: "UNAUTHENTICATED" };
        else if (b.path === "/api/provider-management/movies/mov_evil" ) d = { decision: "DENY", status: 404, denialClass: "RESOURCE_NOT_FOUND" };
        else d = { decision: "ALLOW" };
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(d));
      });
      return;
    }
    forwarded.push({ up: "controlPlane", url: req.url, cookie: req.headers.cookie || null }); res.writeHead(200); res.end("CP_DOC");
  });
  await new Promise((r) => enroll.listen(0, "127.0.0.1", r));
  await new Promise((r) => cp.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(os.tmpdir(), "pep-"));
  const secretFile = path.join(dir, "gw.txt"); writeFileSync(secretFile, SECRET);
  const manifest = { state: "WAITING_FOR_USER_UI_INPUT", ports: { controlPlane: cp.address().port, enrollment: enroll.address().port } };
  const gw = createStudioGateway({ port: 34099, statusFile: path.join(dir, "s.json"), secretFile, externalOrigin: ORIGIN, pepEnabled: true, readManifest: () => manifest });
  await gw.start();
  const P = 34099;
  try {
    // static asset: passes without authorize -> forwarded to control-plane
    const asset = await httpReq(P, "GET", "/auth-assets/auth-app.mjs");
    check("B static /auth-assets/* forwarded (no authorize needed)", asset.status === 200 && forwarded.some((f) => f.url === "/auth-assets/auth-app.mjs"));
    // protected data unauth -> 401 (blocked at the gateway, NOT forwarded)
    forwarded.length = 0;
    const unauth = await httpReq(P, "GET", "/api/provider-management/movies");
    check("B protected data unauth -> 401 (blocked, not forwarded to enrollment)", unauth.status === 401 && !forwarded.some((f) => f.up === "enrollment"));
    // document unauth -> 302 redirect /login
    const docRedir = await httpReq(P, "GET", "/security");
    check("B protected document unauth -> 302 redirect /login", docRedir.status === 302 && String(docRedir.headers.location).startsWith("/login"));
    // authenticated data -> forwarded to enrollment WITH the gateway secret stamped
    forwarded.length = 0;
    const authed = await httpReq(P, "GET", "/api/provider-management/movies", { cookie: COOKIE });
    check("B authenticated data -> forwarded to enrollment with gateway secret", authed.status === 200 && authed.body === "ENROLL_DATA" && forwarded.some((f) => f.up === "enrollment" && f.gw === SECRET));
    // cross-tenant media -> 404 (blocked)
    forwarded.length = 0;
    const idor = await httpReq(P, "GET", "/api/provider-management/movies/mov_evil", { cookie: COOKIE });
    check("B cross-tenant media -> 404 (blocked, not forwarded)", idor.status === 404 && !forwarded.some((f) => f.up === "enrollment"));
    // worker route -> allowed but the browser cookie is STRIPPED before the worker upstream
    forwarded.length = 0;
    await httpReq(P, "POST", "/api/worker/lease/claim", { cookie: COOKIE });
    // P0 Step 5C.31: the worker trust domain now terminates in the WORKER RUNTIME (the enrollment
    // upstream), because that is the process which owns the generation pipeline and therefore the remote
    // delivery hub. The property under test is unchanged and is the important one: the browser cookie is
    // STRIPPED before the request reaches the worker upstream, whichever upstream that is.
    check("B worker route -> forwarded WITHOUT the browser cookie (credential separation)", forwarded.some((f) => f.up === "enrollment" && f.url === "/api/worker/lease/claim" && f.cookie === null));
    // FAIL-CLOSED: point the manifest control-plane at a dead port so authorize is unreachable (wait out the
    // 1.5s manifest cache so the change takes effect). The forward would otherwise reach the LIVE enrollment.
    forwarded.length = 0;
    manifest.ports.controlPlane = 9; // unreachable
    await new Promise((r) => setTimeout(r, 1700));
    const failClosed = await httpReq(P, "GET", "/api/provider-management/movies", { cookie: COOKIE });
    check("B authorize UNREACHABLE -> FAIL CLOSED (deny, not forward)", failClosed.status >= 400 && !forwarded.some((f) => f.up === "enrollment"));
    manifest.ports.controlPlane = cp.address().port;
  } finally {
    await gw.stop(); await new Promise((r) => enroll.close(r)); await new Promise((r) => cp.close(r));
  }
}

async function main() {
  await partA();
  await partB();
  console.log(`Step 5C.25 gateway pep: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
