// P0 Step 5C.13 - stable loopback studio gateway (the ONLY origin the Cloudflare tunnel targets).
//
// Binds 127.0.0.1:<stablePort> and reverse-proxies to the CURRENT dynamic production runtime by
// re-reading the runtime manifest (runtime-status.json) - a runtime restart changes ports without
// touching the tunnel. Fail-closed: when the manifest/runtime is not READY every request gets a
// minimal 503 (no internal details). Routing: /api/provider-management/* -> Worker enrollment
// channel, everything else -> control-plane UI/API. The gateway STRIPS any inbound trusted-proxy
// marker (spoof) before stamping its own per-installation secret, forwards bodies/Range verbatim,
// and serves a REDACTED external projection of /ops/health. External auth is Cloudflare Access in
// front of the tunnel - the gateway itself never handles credentials.

import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { TRUSTED_PROXY_HEADER, TRUSTED_WORKSPACE_HEADER, TRUSTED_USER_HEADER, TRUSTED_ROLE_HEADER } from "../protocol/trusted-headers.mjs";

const HOST = "127.0.0.1";
const MANIFEST_CACHE_MS = 1500;
export const GATEWAY_HEALTH_PATH = "/__avc-gateway/health";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
// Spoofable native-identity headers a client (or nested proxy) must NEVER be able to set: native auth derives
// identity ONLY from the session cookie resolved server-side, so these are stripped inbound before proxying.
const SPOOFABLE_IDENTITY = new Set(["x-user-id", "x-workspace-id", "x-role", "x-session-id", "x-auth-strength", "x-authenticated-user", "x-avc-user", "x-avc-workspace", "x-avc-role", "x-avc-user-id", "x-avc-session"]);

// Build the exact header set forwarded upstream: drop hop-by-hop + any inbound trusted-proxy/gateway marker
// (anti-spoof) + spoofable identity headers, then stamp our own per-installation trusted secret. Exported
// so the stripping contract is unit-testable with raw crafted requests.
export function buildForwardHeaders(rawHeaders, secret, trustedProxyHeader = TRUSTED_PROXY_HEADER) {
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === trustedProxyHeader || key.startsWith("x-avc-gateway")) continue;
    if (SPOOFABLE_IDENTITY.has(key)) continue;
    headers[k] = v;
  }
  headers[trustedProxyHeader] = secret;
  return headers;
}

export function ensureGatewaySecret(secretFile, { acl = true } = {}) {
  mkdirSync(path.dirname(secretFile), { recursive: true });
  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, randomBytes(48).toString("base64url"), { encoding: "utf8", mode: 0o600 });
    if (acl && process.platform === "win32") {
      // Best-effort tighten: only the current user (and SYSTEM) may read the marker secret.
      try {
        execFileSync("icacls.exe", [secretFile, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`, "/grant:r", "SYSTEM:F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
      } catch { /* ACL tightening is defense-in-depth */ }
    }
  }
  const secret = readFileSync(secretFile, "utf8").trim();
  if (secret.length < 32) throw Object.assign(new Error("gateway secret invalid"), { code: "E_GATEWAY_SECRET" });
  return secret;
}

function minimalJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(body);
}

export function createStudioGateway({
  port,
  statusFile,
  secretFile,
  externalOrigin,
  pepEnabled = false,     // P0 Step 5C.25: when true, authorize every non-static request at the control-plane
                          // PDP BEFORE forwarding (fail-closed). OFF = the pre-PEP passthrough behaviour.
  // P0 Step 5C.28: when set (e.g. "/ws/worker"), the gateway raw-tunnels WebSocket upgrades on THIS EXACT
  // path to the control-plane worker WS gateway so a REMOTE worker can hold its outbound WSS through the
  // Cloudflare tunnel. null = OFF (upgrades dropped, identical to the pre-5C.28 behaviour). Worker auth is
  // the Bearer wcred_ verified at the control-plane gateway — the studio gateway never authenticates it, it
  // only proxies the one worker path (everything else is destroyed, fail-closed). No browser route is
  // affected: browser traffic is HTTP and still flows through route()+PEP.
  workerWsPath = null,
  // P0 Step 5C.31: which upstream terminates the worker WSS. The production remote-delivery hub lives in
  // the WORKER RUNTIME (the enrollment upstream) because that process owns the generation pipeline; the
  // legacy 5C.28 transport-only gateway lived in the control plane. Default "enrollment".
  workerWsUpstream = "enrollment",
  now = Date.now,
  readManifest = null
} = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError("gateway port invalid");
  if (typeof statusFile !== "string" || typeof secretFile !== "string") throw new TypeError("gateway paths required");
  const secret = ensureGatewaySecret(secretFile);
  let cache = { at: 0, upstream: null };

  function upstreams() {
    if (now() - cache.at < MANIFEST_CACHE_MS) return cache.upstream;
    let upstream = null;
    try {
      const read = readManifest || (() => JSON.parse(readFileSync(statusFile, "utf8")));
      const m = read();
      const cp = m?.ports?.controlPlane ?? m?.ports?.ui ?? m?.ports?.api;
      const en = m?.ports?.enrollment;
      if (m?.state === "WAITING_FOR_USER_UI_INPUT" && Number.isInteger(cp) && Number.isInteger(en)) {
        upstream = { controlPlane: cp, enrollment: en };
      }
    } catch { upstream = null; }
    cache = { at: now(), upstream };
    return upstream;
  }

  async function projectHealth(res, up) {
    // External health projection: readiness only - never counters, paths, ports, accounts.
    // Internal same-origin GET via the gateway marker (no Origin header - a proxy-mode GET without
    // an Origin is accepted; a loopback Origin would be rejected in proxy mode).
    const options = {
      host: HOST, port: up.enrollment, path: "/api/provider-management/ops/health", method: "GET",
      headers: { [TRUSTED_PROXY_HEADER]: secret }
    };
    const body = await new Promise((resolve) => {
      const r = http.request(options, (u) => {
        const chunks = [];
        u.on("data", (c) => chunks.push(c));
        u.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      r.on("error", () => resolve(null));
      r.end();
    });
    if (!body) { minimalJson(res, 503, { ok: false, code: "E_STUDIO_UPSTREAM_NOT_READY" }); return; }
    try {
      const h = JSON.parse(body).health;
      minimalJson(res, 200, { ok: true, at: h.at, ready: h.readiness.ready, blockers: h.readiness.blockers, degraded: h.readiness.degraded });
    } catch { minimalJson(res, 503, { ok: false, code: "E_STUDIO_UPSTREAM_NOT_READY" }); }
  }

  // Static public assets never need authorization (the login page + its bundle must load without a session).
  const isStaticPublic = (p) => p.startsWith("/auth-assets/") || p.startsWith("/assets/");
  const denyCode = (cls) => (cls === "UNAUTHENTICATED" ? "E_STUDIO_UNAUTHENTICATED" : cls === "REAUTH_REQUIRED" ? "E_STUDIO_REAUTH_REQUIRED" : cls === "RESOURCE_NOT_FOUND" ? "E_STUDIO_NOT_FOUND" : "E_STUDIO_FORBIDDEN");

  // Ask the control-plane PDP (/internal/native-auth/authorize) whether to allow this request. Stamped with
  // the trusted-gateway secret so ONLY the gateway can reach it. FAILS CLOSED (DENY) on any error/timeout —
  // an unreachable auth service must never fail open.
  function authorizeViaControlPlane(req, up) {
    const pathOnly = req.url.split("?")[0];
    const payload = JSON.stringify({ method: req.method, path: pathOnly, cookie: req.headers.cookie || null, origin: req.headers.origin || null, csrf: req.headers["x-avc-studio-csrf"] || null, accept: req.headers.accept || null });
    const options = { host: HOST, port: up.controlPlane, path: "/internal/native-auth/authorize", method: "POST", headers: { [TRUSTED_PROXY_HEADER]: secret, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } };
    return new Promise((resolve) => {
      const r = http.request(options, (u) => { const cks = []; u.on("data", (c) => cks.push(c)); u.on("end", () => { try { resolve(JSON.parse(Buffer.concat(cks).toString("utf8"))); } catch { resolve({ decision: "DENY", status: 502, denialClass: "ERROR" }); } }); });
      r.on("error", () => resolve({ decision: "DENY", status: 502, denialClass: "ERROR" }));
      r.setTimeout(5000, () => { try { r.destroy(); } catch { /* */ } resolve({ decision: "DENY", status: 504, denialClass: "ERROR" }); });
      r.write(payload); r.end();
    });
  }

  async function route(req, res) {
    const up = upstreams();
    if (req.url === GATEWAY_HEALTH_PATH) { minimalJson(res, up ? 200 : 503, { ok: Boolean(up), gateway: "avc-studio", upstreamReady: Boolean(up) }); return; }
    if (!up) { minimalJson(res, 503, { ok: false, code: "E_STUDIO_UPSTREAM_NOT_READY" }); return; }
    // P0 Step 5C.31: /api/worker/* is the WORKER trust domain (credential-authenticated, no browser
    // session). It is served by the worker runtime alongside the data channel, so it routes to the same
    // enrollment upstream. The PDP classifies it WORKER -> ALLOW + strip cookie (auth-route-policy).
    // /api/workers/releases/* is the browser-facing release surface; it is served by the worker runtime
    // (which owns the owner-tree release storage), so it routes to the same enrollment upstream and is
    // workspace-stamped like any other data request.
    const isChannel = req.url.startsWith("/api/provider-management/") || req.url.startsWith("/api/worker/") || req.url.startsWith("/api/workers/");
    const pathOnly = req.url.split("?")[0];
    if (isChannel && req.method === "GET" && pathOnly === "/api/provider-management/ops/health") { await projectHealth(res, up); return; }

    // ---- PEP: authorize protected requests at the control-plane PDP BEFORE forwarding (fail-closed) ----
    let decision = null;
    if (pepEnabled && !isStaticPublic(pathOnly)) {
      const d = await authorizeViaControlPlane(req, up);
      if (!d || d.decision !== "ALLOW") {
        if (d && d.redirect) { res.writeHead(302, { Location: d.redirect, "Cache-Control": "no-store" }); res.end(); return; }
        minimalJson(res, (d && d.status) || 403, { ok: false, code: denyCode(d && d.denialClass) }); return;
      }
      if (d.stripCookie) { delete req.headers.cookie; delete req.headers.Cookie; } // worker route: no browser cookie downstream
      decision = d;
    }

    const headers = buildForwardHeaders(req.headers, secret);
    // P0 Step 5C.29 — per-request workspace. Stamp the PDP-verified workspace on data-channel forwards so the
    // enrollment upstream selects the correct workspace-scoped control plane. buildForwardHeaders has already
    // stripped any client-sent x-avc-gateway-workspace (it drops every x-avc-gateway* inbound header), so this
    // trusted re-stamp — sourced ONLY from the server-side PDP decision — is the sole authority for the
    // downstream workspace. Non-channel forwards (control-plane UI/API) never carry it.
    if (isChannel && decision && decision.context && typeof decision.context.workspaceId === "string") {
      headers[TRUSTED_WORKSPACE_HEADER] = decision.context.workspaceId;
      // P0 Step 5C.32 — the PDP already resolved WHO this is and WHAT role they hold in that workspace.
      // Stamping them (from the server-side decision only) lets the data channel audit a download by
      // actor without re-deriving identity from a cookie it must never see. buildForwardHeaders has
      // already stripped every inbound x-avc-gateway* header, so these cannot be client-supplied.
      if (typeof decision.context.userId === "string") headers[TRUSTED_USER_HEADER] = decision.context.userId;
      if (typeof decision.context.role === "string") headers[TRUSTED_ROLE_HEADER] = decision.context.role;
    }
    const options = { host: HOST, port: isChannel ? up.enrollment : up.controlPlane, path: req.url, method: req.method, headers };
    const upstreamReq = http.request(options, (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };
      delete outHeaders.connection;
      res.writeHead(upstreamRes.statusCode, outHeaders);
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", () => { if (!res.headersSent) minimalJson(res, 502, { ok: false, code: "E_STUDIO_UPSTREAM_ERROR" }); else { try { res.destroy(); } catch { /* */ } } });
    req.on("error", () => { try { upstreamReq.destroy(); } catch { /* */ } });
    req.pipe(upstreamReq);
  }

  const server = http.createServer((req, res) => { void route(req, res).catch(() => { if (!res.headersSent) minimalJson(res, 502, { ok: false, code: "E_STUDIO_UPSTREAM_ERROR" }); }); });
  server.requestTimeout = 0; // long media streams; Cloudflare enforces its own limits
  server.headersTimeout = 65_000;

  // P0 Step 5C.28 — WebSocket upgrade proxy for the remote worker. FAIL-CLOSED: only the single configured
  // worker WS path is tunnelled; any other upgrade (or when the feature is OFF, or upstream not ready) has its
  // socket destroyed. The Upgrade/Connection headers MUST be preserved for the handshake (unlike the HTTP
  // forward path which strips them), while inbound gateway markers + spoofable identity + browser cookies are
  // still stripped and our per-installation trusted secret is stamped. The worker credential (Authorization:
  // Bearer wcred_) is forwarded verbatim and verified downstream at the control-plane gateway.
  function buildUpgradeHeaders(rawHeaders, upstreamHost) {
    const headers = {};
    for (const [k, v] of Object.entries(rawHeaders || {})) {
      const key = k.toLowerCase();
      if (key === "host") continue;                                  // rewritten below
      if (key === "cookie") continue;                                // worker credential domain — no browser cookie
      if (key === TRUSTED_PROXY_HEADER || key.startsWith("x-avc-gateway")) continue; // anti-spoof
      if (SPOOFABLE_IDENTITY.has(key)) continue;
      headers[k] = v;
    }
    headers.Host = upstreamHost;
    headers[TRUSTED_PROXY_HEADER] = secret;
    return headers;
  }
  function onUpgrade(req, socket, head) {
    const pathOnly = (req.url || "").split("?")[0];
    const up = upstreams();
    if (!workerWsPath || pathOnly !== workerWsPath || !up) { try { socket.destroy(); } catch { /* */ } return; }
    let settled = false;
    const kill = () => { if (settled) return; settled = true; try { socket.destroy(); } catch { /* */ } try { upstream.destroy(); } catch { /* */ } };
    const upstreamPort = workerWsUpstream === "controlPlane" ? up.controlPlane : up.enrollment;
    const upstreamHost = `${HOST}:${upstreamPort}`;
    const headers = buildUpgradeHeaders(req.headers, upstreamHost);
    const upstream = net.connect(upstreamPort, HOST, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) { for (const vv of v) raw += `${k}: ${vv}\r\n`; } else raw += `${k}: ${v}\r\n`;
      }
      raw += "\r\n";
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", kill);
    socket.on("error", kill);
    socket.on("close", () => { try { upstream.destroy(); } catch { /* */ } });
    upstream.on("close", () => { try { socket.destroy(); } catch { /* */ } });
    try { socket.setTimeout(0); } catch { /* */ }
  }
  server.on("upgrade", onUpgrade);

  return Object.freeze({
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: HOST, port, exclusive: true }, () => { server.off("error", reject); resolve(); });
      });
      return { host: HOST, port, externalOrigin };
    },
    async stop() { await new Promise((r) => server.close(() => r())); if (server.closeAllConnections) server.closeAllConnections(); },
    _server: server
  });
}

// Probe an already-running gateway on the stable port (duplicate-process prevention).
export function probeGateway(port, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: HOST, port, path: GATEWAY_HEALTH_PATH, method: "GET", timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { const j = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolve(j.gateway === "avc-studio" ? { running: true, upstreamReady: j.upstreamReady === true } : { running: false, foreign: true }); }
        catch { resolve({ running: false, foreign: true }); }
      });
    });
    r.on("timeout", () => { r.destroy(); resolve({ running: false }); });
    r.on("error", () => resolve({ running: false }));
    r.end();
  });
}
