// P0 Step 5C.1 — minimal HTTP server (node:http; no framework).
//
// Responsibilities: per-request context, request timeout, body-size cap (413), JSON-parse
// safety (400), drain-aware admission (503 for new requests while draining), request
// logging, and clean shutdown with NO leaked sockets or timers. Business logic lives in the
// injected router; this module owns only transport + lifecycle.

import http from "node:http";
import { CP_ERRORS, ControlPlaneError } from "../errors.mjs";
import { sendError } from "./responses.mjs";
import { createRequestContext } from "./request-context.mjs";

export function createHttpServer({ config, logger, router, now = () => new Date().toISOString() }) {
  const production = config.isProduction;
  const { host, port, requestTimeoutMs, maxRequestBytes } = config.server;
  const trustProxy = config.security.trustProxy;

  const sockets = new Set();
  let inFlight = 0;
  let draining = false;
  let listening = false;

  const server = http.createServer((req, res) => handleRequest(req, res));

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  // WebSocket upgrade dispatch (P0 Step 5C.4). The Worker Gateway attaches its handler here; with
  // no handler attached (Gateway disabled) any upgrade is safely rejected. Normal HTTP routing is
  // unaffected — upgrades are a separate event from request handling.
  let upgradeHandler = null;
  server.on("upgrade", (req, socket, head) => {
    if (upgradeHandler && !draining) {
      try { upgradeHandler(req, socket, head); return; } catch { /* fall through to reject */ }
    }
    try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); } catch { /* */ }
    try { socket.destroy(); } catch { /* */ }
  });

  function handleRequest(req, res) {
    const ctx = createRequestContext(req, { now, trustProxy });

    // Drain: refuse NEW work with a retriable 503; in-flight requests continue.
    if (draining) {
      sendError(res, new ControlPlaneError(CP_ERRORS.E_DEPENDENCY_NOT_READY, "Service draining"),
        { correlationId: ctx.correlationId, production });
      return;
    }

    inFlight += 1;
    const startedMs = Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (!res.writableEnded && !res.headersSent) {
        sendError(res, new ControlPlaneError(CP_ERRORS.E_INTERNAL, "Request timeout"),
          { correlationId: ctx.correlationId, production });
      }
      try { req.destroy(); } catch { /* */ }
    }, requestTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlight -= 1;
      const status = res.statusCode || 0;
      logSafe("info", "http_request", {
        event: "http_request", method: ctx.method, path: normalizeForLog(req.url),
        status, durationMs: Date.now() - startedMs, outcome: status >= 500 ? "error" : "ok",
        requestId: ctx.requestId, correlationId: ctx.correlationId
      });
    };
    res.once("finish", finish);
    res.once("close", finish);

    // Read + cap the body; parse JSON when declared. GET routes ignore the body, but the
    // size cap and parse-safety paths are enforced uniformly.
    readBody(req, maxRequestBytes)
      .then(({ tooLarge, buffer }) => {
        if (res.writableEnded) return;
        if (tooLarge) {
          return sendError(res, new ControlPlaneError(CP_ERRORS.E_PAYLOAD_TOO_LARGE, "Request body too large"),
            { correlationId: ctx.correlationId, production });
        }
        const ctype = String(req.headers["content-type"] || "");
        let parsedBody;
        if (buffer.length > 0 && ctype.includes("application/json")) {
          try { parsedBody = JSON.parse(buffer.toString("utf8")); }
          catch {
            return sendError(res, new ControlPlaneError(CP_ERRORS.E_BAD_REQUEST, "Malformed JSON body"),
              { correlationId: ctx.correlationId, production });
          }
        }
        // Expose the parsed JSON body to the router (business routes read req.cpBody). GET/no-body
        // requests leave it undefined. The raw buffer is never retained past this point; the byte
        // length is kept so a route can enforce a stricter per-API body cap.
        req.cpBody = parsedBody;
        req.cpBodyBytes = buffer.length;
        router(req, res, ctx);
      })
      .catch(() => {
        if (!res.writableEnded) {
          sendError(res, new ControlPlaneError(CP_ERRORS.E_INTERNAL, "Internal error"),
            { correlationId: ctx.correlationId, production });
        }
      });
  }

  function logSafe(level, event, fields) {
    try { logger?.[level]?.(event, fields); } catch { /* logging must not crash */ }
  }

  return {
    async start() {
      if (listening) return this;
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.off("listening", onOk); reject(e); };
        const onOk = () => { server.off("error", onErr); resolve(); };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(port, host);
      });
      listening = true;
      draining = false;
      return this;
    },

    beginDrain() { draining = true; },

    // WebSocket upgrade attach/detach (Worker Gateway, Step 5C.4). No handler ⇒ upgrades rejected.
    attachUpgrade(fn) { upgradeHandler = typeof fn === "function" ? fn : null; },
    detachUpgrade() { upgradeHandler = null; },
    hasUpgradeHandler() { return upgradeHandler !== null; },

    async stop({ timeoutMs = config.server.shutdownTimeoutMs } = {}) {
      draining = true;
      if (!listening) { forceCloseSockets(); return; }
      // Stop accepting new connections.
      const closed = new Promise((resolve) => server.close(() => resolve()));
      // Wait for in-flight requests to finish, up to the timeout.
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (inFlight > 0 && Date.now() < deadline) {
        await sleep(15);
      }
      // Force-close anything still lingering so no socket leaks past the deadline.
      forceCloseSockets();
      await closed;
      listening = false;
    },

    address() { return listening ? server.address() : null },
    inFlight() { return inFlight; },
    isDraining() { return draining; },
    openSockets() { return sockets.size; },
    _server: server
  };

  function forceCloseSockets() {
    for (const s of sockets) { try { s.destroy(); } catch { /* */ } }
    sockets.clear();
  }
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers["content-length"]);
    if (Number.isFinite(cl) && cl > cap) {
      req.on("data", () => {}); req.on("end", () => {}); req.on("error", () => {});
      return resolve({ tooLarge: true, buffer: Buffer.alloc(0) });
    }
    let size = 0; const chunks = []; let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) { settle({ tooLarge: true, buffer: Buffer.alloc(0) }); try { req.destroy(); } catch { /* */ } }
      else chunks.push(c);
    });
    req.on("end", () => settle({ tooLarge: false, buffer: Buffer.concat(chunks) }));
    req.on("error", () => settle({ tooLarge: false, buffer: Buffer.concat(chunks) }));
  });
}

function sleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); }
function normalizeForLog(url) { const s = typeof url === "string" ? url : "/"; const q = s.indexOf("?"); return q >= 0 ? s.slice(0, q) : s; }
