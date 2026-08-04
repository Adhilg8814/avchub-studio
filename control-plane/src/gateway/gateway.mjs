// P0 Step 5C.4 — production WebSocket Worker Gateway.
//
// Replaces the Step 5C.1 placeholder. Transports durable Protocol-v1 messages between
// authenticated local Workers and the Step 5C.3 processor. It executes NO provider jobs and owns
// NO business/settlement logic — PostgreSQL + the durable inbox/outbox remain the source of truth.
//
// Flow: HTTP upgrade → origin/path check → Authorization-header credential auth (rate-limited) →
// WS established → WORKER_HELLO within timeout → transactional session claim/supersede → register
// local socket → HELLO_ACK (resume token once) → ACTIVE. Inbound frames are size/shape-limited,
// rate-limited, and handed to processInboundEnvelope() through a bounded per-connection queue.
// Outbound flows through the installed Gateway delivery adapter. One ACTIVE session per worker is
// guaranteed transactionally; superseded connections lose all authority (fenced everywhere).

import WebSocket, { WebSocketServer } from "ws";
import { makeEnvelope } from "../../../lib/protocol/envelope.mjs";
import { PROTOCOL_VERSION } from "../../../lib/protocol/message-types.mjs";
import { createClock } from "../processor/clock.mjs";
import { sessionRepository } from "../persistence/repositories/session-repository.mjs";
import { extractBearer, authenticateCredential, createAuthRateLimiter, AUTH_CODES } from "./gateway-auth.mjs";
import { validateInboundFrame } from "./frame-safety.mjs";
import { createSocketRegistry } from "./socket-registry.mjs";
import { createHeartbeatManager } from "./heartbeat.mjs";
import { createGatewayDeliveryAdapter } from "./gateway-delivery-adapter.mjs";
import { CLOSE, rejectUpgrade } from "./close-codes.mjs";
import { generateResumeToken, resumeTokenHash, isResumeTokenShaped } from "./resume.mjs";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const GW_STATE = Object.freeze({ CREATED: "CREATED", INITIALIZING: "INITIALIZING", READY: "READY", DRAINING: "DRAINING", STOPPED: "STOPPED", FAILED: "FAILED" });

// Map a frame-safety code to a WS close outcome.
function frameClose(code) {
  if (code === "E_FRAME_TOO_LARGE") return CLOSE.MESSAGE_TOO_LARGE;
  if (code === "E_FRAME_BINARY" || code === "E_FRAME_EMPTY" || code === "E_FRAME_INVALID_UTF8" || code === "E_FRAME_INVALID_JSON") return CLOSE.MALFORMED_FRAME;
  if (code === "E_PROTOCOL_VERSION") return CLOSE.UNSUPPORTED_VERSION;
  return CLOSE.MALFORMED_FRAME;
}

export function createWorkerGateway(config, { logger, persistence, processor, httpServer, now, clock } = {}) {
  const gw = config.workerGateway;
  const enabled = gw.enabled === true;
  // P0 Step 5C.28 — TRANSPORT-ONLY mode. The gateway authenticates + connects + claims the session +
  // heartbeats + registers the socket (all processor-free — see onFirstMessage/heartbeat), but installs NO
  // delivery adapter and processes NO inbound job envelopes. This lets a remote worker HOLD a WSS connection
  // (pair, connect, heartbeat, appear in the registry, DRAINING) WITHOUT starting a second job-owner: the
  // control-plane processor stays disabled/inert and the local worker keeps SOLE ownership of the 5C.9E
  // pipeline. Job delivery to remote workers is a later, separately-activated concern (the processor).
  const transportOnly = gw.transportOnly === true;
  const gatewayInstanceId = gw.gatewayInstanceId || config.deployment.instanceId;
  const theClock = clock || createClock(now ? { now: () => Date.parse(now()) } : {});
  const pepper = config.security.credentialPepper || null;
  const allowedProtocolVersions = gw.allowedProtocolVersions && gw.allowedProtocolVersions.length ? gw.allowedProtocolVersions : [PROTOCOL_VERSION];

  const registry = createSocketRegistry();
  const authRateLimiter = createAuthRateLimiter({ windowMs: gw.rateLimitWindowMs, maxPerWindow: gw.maxPreAuthPerWindow, now: theClock.now });
  const wss = new WebSocketServer({ noServer: true, maxPayload: gw.maxFrameBytes });

  let state = GW_STATE.CREATED;
  let started = false, draining = false;
  let heartbeat = null, deliveryAdapter = null, upgradeAttached = false;
  let lastConnectionAt = null, lastDisconnectAt = null, lastErrorCode = null;
  let authenticating = 0;

  const frameLimits = {
    maxFrameBytes: gw.maxFrameBytes, maxJsonDepth: gw.maxJsonDepth,
    maxArrayItems: gw.maxArrayItems, maxObjectKeys: gw.maxObjectKeys
  };

  function log(level, event, fields) { try { logger?.[level]?.(event, { component: "gateway", event, gatewayInstanceId, ...fields }); } catch { /* */ } }
  function dbReady() { try { return persistence && typeof persistence.health === "function" && persistence.isEnabled?.() === true && persistence.health().ready === true; } catch { return false; } }

  // ---------------------------------------------------------------- UPGRADE
  function onUpgrade(req, socket, head) {
    if (!enabled) return rejectUpgrade(socket, "E_GATEWAY_DISABLED");
    if (draining) return rejectUpgrade(socket, "E_GATEWAY_DRAINING");
    const path = String(req.url || "").split("?")[0];
    if (path !== gw.path) { log("info", "gateway_upgrade_rejected", { reasonCode: "UNKNOWN_PATH" }); return rejectUpgrade(socket, "E_UNKNOWN_PATH"); }
    if (!originAllowed(req)) { log("info", "gateway_upgrade_rejected", { reasonCode: "ORIGIN_FORBIDDEN" }); return rejectUpgrade(socket, "E_ORIGIN_FORBIDDEN"); }

    const remoteAddr = (config.security.trustProxy && req.headers["x-forwarded-for"]) ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : (req.socket && req.socket.remoteAddress) || "unknown";
    const remoteKey = remoteAddr;
    if (!authRateLimiter.check(remoteKey)) { log("info", "gateway_upgrade_rejected", { reasonCode: "RATE_LIMITED" }); return rejectUpgrade(socket, AUTH_CODES.RATE_LIMITED); }

    const ext = extractBearer(req.headers);
    if (!ext.ok) { authRateLimiter.record(remoteKey); log("info", "worker_auth_failed", { reasonCode: ext.code }); return rejectUpgrade(socket, ext.code); }

    authenticating += 1;
    authenticateCredential({ persistence, pepper, credential: ext.credential, now: theClock.now })
      .then((auth) => {
        authenticating -= 1;
        if (!auth.ok) { authRateLimiter.record(remoteKey); log("info", "worker_auth_failed", { reasonCode: auth.code }); return rejectUpgrade(socket, auth.code); }
        if (draining) return rejectUpgrade(socket, "E_GATEWAY_DRAINING");
        const remoteSummary = LOOPBACK.has(remoteAddr) ? "loopback" : "remote";
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, { ...auth, remoteSummary }));
        log("info", "worker_authenticated", { workspaceId: auth.workspaceId, workerId: auth.workerId });
      })
      .catch(() => { authenticating -= 1; try { rejectUpgrade(socket, "E_AUTH_FAILED"); } catch { /* */ } });
  }

  function originAllowed(req) {
    const origin = req.headers && req.headers.origin;
    if (!origin) return true; // native worker (no browser Origin)
    const allow = config.security.allowedOrigins || [];
    if (allow.length === 0) return true; // dev default
    return allow.includes(origin);
  }

  // ---------------------------------------------------------------- CONNECTION
  function onConnection(ws, auth) {
    const conn = {
      ws, auth, state: "HELLO_WAIT", entry: null, session: null, closed: false,
      helloTimer: null, inbound: { queue: [], processing: false, closed: false, windowStart: theClock.now(), count: 0 }
    };
    ws.on("error", () => { /* never crash on socket error; close handler cleans up */ });
    conn.helloTimer = setTimeout(() => { if (conn.state === "HELLO_WAIT") closeConn(conn, CLOSE.HELLO_TIMEOUT); }, gw.helloTimeoutMs);
    if (typeof conn.helloTimer.unref === "function") conn.helloTimer.unref();
    ws.once("message", (data, isBinary) => { onHello(conn, data, isBinary).catch(() => closeConn(conn, CLOSE.INTERNAL)); });
    ws.on("close", () => onSocketClose(conn));
  }

  async function onHello(conn, data, isBinary) {
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    if (conn.closed || draining) return closeConn(conn, draining ? CLOSE.DRAINING : CLOSE.NORMAL);
    const fr = validateInboundFrame(data, isBinary, { ...frameLimits });
    if (!fr.ok) { log("info", "worker_hello_rejected", { reasonCode: fr.code }); return closeConn(conn, frameClose(fr.code)); }
    const env = fr.envelope;
    if (env.type !== "WORKER_HELLO") { log("info", "worker_hello_rejected", { reasonCode: "NOT_HELLO" }); return closeConn(conn, CLOSE.BAD_HANDSHAKE); }
    // WORKER_HELLO must NOT carry a credential (defense-in-depth beyond the shipped validator).
    if (helloHasCredential(env.payload)) { log("info", "worker_hello_rejected", { reasonCode: "CREDENTIAL_IN_HELLO" }); return closeConn(conn, CLOSE.BAD_HANDSHAKE); }
    // Identity is the AUTHENTICATED connection, never trusted from the body.
    if (env.workerId !== conn.auth.workerId) { log("info", "worker_hello_rejected", { reasonCode: "WORKER_MISMATCH" }); return closeConn(conn, CLOSE.IDENTITY_MISMATCH); }
    if (env.workspaceId && env.workspaceId !== conn.auth.workspaceId) { log("info", "worker_hello_rejected", { reasonCode: "WORKSPACE_MISMATCH" }); return closeConn(conn, CLOSE.IDENTITY_MISMATCH); }
    if (!allowedProtocolVersions.includes(env.protocolVersion)) { log("info", "worker_hello_rejected", { reasonCode: "PROTOCOL_VERSION" }); return closeConn(conn, CLOSE.UNSUPPORTED_VERSION); }

    // Resume correlation (optional, advisory) — never bypasses auth, never changes identity. The
    // presented token is validated INSIDE claimSession against the session being superseded, so a
    // rotated/replayed token can never re-correlate.
    const presentedResume = (typeof env.payload?.resumeToken === "string" && isResumeTokenShaped(env.payload.resumeToken)) ? env.payload.resumeToken : null;
    const clientVersion = typeof env.payload?.workerVersion === "string" ? env.payload.workerVersion.slice(0, 64) : null;

    // Mint a NEW resume token (rotation): plaintext returned once in HELLO_ACK; only its hash stored.
    const resume = generateResumeToken();

    let claim;
    try {
      claim = await persistence.tenantTransaction(conn.auth.workspaceId, (c) => sessionRepository.claimSession(c, conn.auth.workspaceId, {
        workerId: conn.auth.workerId, gatewayInstance: gatewayInstanceId, resumeTokenHash: resume.hash,
        presentedResumeHash: presentedResume ? resumeTokenHash(presentedResume) : null,
        resumeNotBeforeIso: theClock.futureIso(-gw.resumeTokenTtlMs),
        credentialId: conn.auth.credentialId, protocolVersion: env.protocolVersion, clientVersion, remoteSummary: conn.auth.remoteSummary
      }));
    } catch (e) {
      lastErrorCode = (e && e.code) || "SESSION_CLAIM_FAILED";
      log("warn", "worker_hello_rejected", { reasonCode: "SESSION_CLAIM_FAILED" });
      return closeConn(conn, CLOSE.INTERNAL);
    }
    if (conn.closed) { // socket closed during the async claim → do not leave an orphan ACTIVE
      try { await persistence.tenantTransaction(conn.auth.workspaceId, (c) => sessionRepository.closeCurrent(c, conn.auth.workspaceId, claim.session.id, claim.session.connection_epoch, "ABANDONED")); } catch { /* */ }
      return;
    }

    const resumed = claim.resumed === true; // correlation decided transactionally in claimSession

    // Register the local socket + close a superseded LOCAL socket we owned.
    const entry = registry.register({ socket: conn.ws, workspaceId: conn.auth.workspaceId, workerId: conn.auth.workerId, sessionId: claim.session.id, epoch: claim.session.connection_epoch, gatewayInstance: gatewayInstanceId, connectedAt: theClock.now() });
    conn.entry = entry; conn.session = claim.session;
    if (claim.supersededSessionId && claim.supersededGatewayInstance === gatewayInstanceId) {
      const old = registry.getBySession(claim.supersededSessionId);
      if (old && old.socket !== conn.ws) { registry.unregister(claim.supersededSessionId); safeClose(old.socket, CLOSE.SESSION_SUPERSEDED); log("info", "worker_session_superseded", { workerId: conn.auth.workerId, connectionSessionId: claim.supersededSessionId }); }
    }

    // Wire live handlers: pong (current only), inbound queue, and (re)assert close cleanup.
    conn.ws.on("pong", () => { if (registry.isCurrent(entry.sessionId, entry.epoch)) registry.touchPong(entry.sessionId, theClock.now()); });
    conn.ws.on("message", (d, bin) => onInbound(conn, d, bin));

    conn.state = "ACTIVE";
    lastConnectionAt = theClock.nowIso();
    sendHelloAck(conn, env, resume, resumed);
    log("info", "worker_connected", { workspaceId: conn.auth.workspaceId, workerId: conn.auth.workerId, connectionSessionId: claim.session.id });
  }

  function sendHelloAck(conn, helloEnv, resume, resumed) {
    let ack;
    try {
      const ackInput = {
        type: "HELLO_ACK", workspaceId: conn.auth.workspaceId, workerId: conn.auth.workerId, sentAt: theClock.nowIso(),
        payload: {
          sessionId: conn.session.id, serverTime: theClock.nowIso(), negotiatedProtocolVersion: PROTOCOL_VERSION,
          resumeToken: resume.token, resumeTokenExpiresAt: theClock.futureIso(gw.resumeTokenTtlMs),
          hasPendingReconcile: false, resumed
        }
      };
      // Echo the HELLO's correlationId if it carried one (already validated as a corr_ id during
      // frame safety); a msg_ id is NOT a valid correlationId, so HELLO_ACK omits it otherwise and
      // is unambiguously the handshake response.
      if (typeof helloEnv.correlationId === "string") ackInput.correlationId = helloEnv.correlationId;
      ack = makeEnvelope(ackInput);
    } catch (e) { return closeConn(conn, CLOSE.INTERNAL); }
    try { conn.ws.send(JSON.stringify(ack)); } catch { closeConn(conn, CLOSE.INTERNAL); }
    log("info", "worker_hello_accepted", { connectionSessionId: conn.session.id });
    // NOTE: the plaintext resume token is NEVER logged.
  }

  // ---------------------------------------------------------------- INBOUND (bounded flow control)
  function onInbound(conn, data, isBinary) {
    if (conn.closed) return;
    // Per-connection message-rate limit (post-auth).
    const nowMs = theClock.now();
    if (nowMs - conn.inbound.windowStart >= gw.rateLimitWindowMs) { conn.inbound.windowStart = nowMs; conn.inbound.count = 0; }
    conn.inbound.count += 1;
    if (conn.inbound.count > gw.maxMessagesPerWindow) { log("info", "inbound_message_rejected", { reasonCode: "RATE_LIMITED" }); return closeConn(conn, CLOSE.RATE_LIMITED); }
    // Bounded inbound queue (transport flow control only; the durable inbox is the real queue).
    if (conn.inbound.queue.length >= gw.maxPendingInboundMessages) { log("info", "inbound_message_rejected", { reasonCode: "QUEUE_OVERFLOW" }); return closeConn(conn, CLOSE.QUEUE_OVERFLOW); }
    conn.inbound.queue.push({ data, isBinary });
    drainInbound(conn);
  }

  async function drainInbound(conn) {
    if (conn.inbound.processing) return;
    conn.inbound.processing = true;
    try {
      // Serial per connection → preserves ordering; the durable inbox guarantees correctness.
      while (conn.inbound.queue.length > 0) {
        if (conn.closed || conn.inbound.closed || draining) break;
        const { data, isBinary } = conn.inbound.queue.shift();
        // Fence: only the CURRENT local session may apply inbound (a superseded socket is closed).
        if (!conn.entry || !registry.isCurrent(conn.entry.sessionId, conn.entry.epoch)) break;
        const fr = validateInboundFrame(data, isBinary, { ...frameLimits });
        if (!fr.ok) { log("info", "inbound_message_rejected", { reasonCode: fr.code }); closeConn(conn, frameClose(fr.code)); break; }
        // TRANSPORT-ONLY: no job engine is attached, so post-HELLO job/result envelopes have no owner. They
        // must never be silently "accepted" (that would imply processing). Drop them safely (no state change,
        // no ack) — a well-behaved transport-only worker sends only HELLO + heartbeat pongs.
        if (transportOnly || !(processor && processor.inbox)) {
          log("debug", "transport_only_inbound_dropped", { workerId: conn.auth.workerId, connectionSessionId: conn.entry.sessionId, messageType: fr.envelope.type });
          continue;
        }
        try {
          const res = await processor.inbox.processInboundEnvelope({
            authenticatedWorkerId: conn.auth.workerId,           // from the connection, NOT the payload
            authenticatedWorkspaceId: conn.auth.workspaceId,
            connectionSessionId: conn.entry.sessionId,
            envelope: fr.envelope, receivedAtIso: theClock.nowIso()
          });
          log("debug", "inbound_message_accepted", { workerId: conn.auth.workerId, connectionSessionId: conn.entry.sessionId, messageType: fr.envelope.type, messageId: fr.envelope.messageId, resultCode: res && res.outcome });
        } catch (e) {
          // Infra failure processing an inbound message → safe close (the message is durable-retryable).
          lastErrorCode = (e && e.code) || "INBOUND_PROCESS_FAILED";
          log("warn", "inbound_message_rejected", { reasonCode: "PROCESS_FAILED" });
          closeConn(conn, CLOSE.INTERNAL); break;
        }
      }
    } finally { conn.inbound.processing = false; }
  }

  // ---------------------------------------------------------------- CLOSE
  function safeClose(ws, info) {
    try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(info.code, info.reason); } catch { /* */ }
    try { const t = setTimeout(() => { try { ws.terminate(); } catch { /* */ } }, 2000); if (t.unref) t.unref(); } catch { /* */ }
  }

  function closeConn(conn, info) {
    if (conn.closed) return; conn.closed = true; conn.inbound.closed = true;
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    if (conn.entry) registry.markDraining(conn.entry.sessionId);
    safeClose(conn.ws, info);
  }

  function onSocketClose(conn) {
    conn.closed = true; conn.inbound.closed = true;
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    lastDisconnectAt = theClock.nowIso();
    if (conn.entry) {
      const sid = conn.entry.sessionId, epoch = conn.entry.epoch;
      registry.unregister(sid);
      // Mark the CURRENT session CLOSED (fenced): a superseded session is left untouched.
      persistence.tenantTransaction(conn.auth.workspaceId, (c) => sessionRepository.closeCurrent(c, conn.auth.workspaceId, sid, epoch, "SOCKET_CLOSED")).catch(() => {});
      log("info", "worker_disconnected", { workspaceId: conn.auth.workspaceId, workerId: conn.auth.workerId, connectionSessionId: sid });
    }
  }

  // ---------------------------------------------------------------- LIFECYCLE
  return {
    isEnabled() { return enabled; },
    gatewayInstanceId,

    async start() {
      if (started) return;
      started = true;
      if (!enabled) { state = GW_STATE.STOPPED; log("debug", "gateway_disabled", { reasonCode: "DISABLED" }); return; }
      state = GW_STATE.INITIALIZING;
      // Full mode REQUIRES PostgreSQL + processor inbound + a credential pepper. TRANSPORT-ONLY installs NO
      // delivery adapter (the CP never pushes jobs to remote workers → no second owner of the pipeline).
      if (!transportOnly) {
        deliveryAdapter = createGatewayDeliveryAdapter({ persistence, registry, gatewayInstanceId, clock: theClock, config: gw, logger });
        if (processor && typeof processor.installDeliveryAdapter === "function") processor.installDeliveryAdapter(deliveryAdapter);
      }
      heartbeat = createHeartbeatManager({ registry, persistence, gatewayInstanceId, config: gw, clock: theClock, logger, onOffline: (entry, info) => { registry.markDraining(entry.sessionId); safeClose(entry.socket, info); } });
      heartbeat.start();
      if (httpServer && typeof httpServer.attachUpgrade === "function") { httpServer.attachUpgrade(onUpgrade); upgradeAttached = true; }
      state = GW_STATE.READY;
      log("info", "gateway_ready", { path: gw.path, reasonCode: "READY" });
    },

    async stop() { await this.drain(); },

    async drain({ timeoutMs = 5000 } = {}) {
      if (!enabled || state === GW_STATE.STOPPED) {
        state = GW_STATE.STOPPED;
        started = false;
        draining = false;
        return;
      }
      draining = true; state = GW_STATE.DRAINING;
      log("info", "gateway_draining", { reasonCode: "DRAINING" });
      if (httpServer && typeof httpServer.detachUpgrade === "function") { httpServer.detachUpgrade(); upgradeAttached = false; }
      if (!transportOnly && processor && typeof processor.installDeliveryAdapter === "function") processor.installDeliveryAdapter(null);
      if (heartbeat) { await heartbeat.stop(); heartbeat = null; }
      // Close all local sockets with a draining reason; mark their sessions disconnected.
      const entries = registry.entries();
      registry.closeAll((e) => { safeClose(e.socket, CLOSE.DRAINING); });
      await Promise.allSettled(entries.map((e) => persistence.tenantTransaction(e.workspaceId, (c) => sessionRepository.closeCurrent(c, e.workspaceId, e.sessionId, e.epoch, "GATEWAY_DRAINING")).catch(() => {})));
      try { wss.close(); } catch { /* */ }
      deliveryAdapter = null;
      state = GW_STATE.STOPPED; started = false; draining = false;
    },

    getStatus() {
      const counts = registry.counts();
      // TRANSPORT-ONLY readiness omits the processor inbox + delivery adapter (intentionally absent); it still
      // requires DB + the upgrade attached + heartbeat + credential pepper.
      const jobPlaneReady = transportOnly || (Boolean(processor && processor.inbox) && Boolean(deliveryAdapter));
      const ready = enabled && state === GW_STATE.READY && dbReady() && jobPlaneReady && upgradeAttached && Boolean(heartbeat);
      let reasonCode = "READY";
      if (!enabled) reasonCode = "DISABLED";
      else if (state === GW_STATE.DRAINING) reasonCode = "DRAINING";
      else if (!dbReady()) reasonCode = "DB_NOT_READY";
      else if (!upgradeAttached || (!transportOnly && !deliveryAdapter)) reasonCode = "INITIALIZING";
      else if (!pepper) reasonCode = "CREDENTIAL_PEPPER_MISSING";
      return {
        component: "workerGateway", enabled, initialized: started,
        ready: enabled ? ready : true, draining, reasonCode: enabled ? reasonCode : "DISABLED",
        gatewayInstanceId, path: gw.path,
        activeConnections: counts.active, authenticatingConnections: authenticating, degradedConnections: counts.degraded,
        lastConnectionAt, lastDisconnectAt, lastErrorCode
      };
    },

    // Forcibly drop a worker's authority after a credential/worker lifecycle change (Step 5C.5).
    // Called by the pairing service AFTER the revoke/rotate/disable has COMMITTED, so the DB is
    // already authoritative. Closes the local socket (if this instance owns it) and fences the
    // ACTIVE session CLOSED so any other instance stops delivering. Never throws.
    async disconnectWorker(workspaceId, workerId, reason = "CREDENTIAL_REVOKED") {
      if (!enabled) return { closed: false, reasonCode: "GATEWAY_DISABLED" };
      const info = reason === "WORKER_DISABLED" ? CLOSE.WORKER_DISABLED : CLOSE.CREDENTIAL_REVOKED;
      let closedLocal = false;
      try {
        const entry = registry.getCurrentForWorker(workerId);
        if (entry && entry.workspaceId === workspaceId) {
          registry.markDraining(entry.sessionId);
          registry.unregister(entry.sessionId);
          safeClose(entry.socket, info);
          closedLocal = true;
        }
        // Authoritative DB fence: close ANY active session for the worker (covers foreign-instance
        // ownership). closeCurrent leaves a REVOKED worker REVOKED (won't flip it back to OFFLINE).
        await persistence.tenantTransaction(workspaceId, async (c) => {
          const s = await c.query(
            "SELECT id, connection_epoch FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE' FOR UPDATE",
            [workspaceId, workerId]);
          if (s.rows[0]) await sessionRepository.closeCurrent(c, workspaceId, s.rows[0].id, s.rows[0].connection_epoch, info.reason);
        });
      } catch { /* best-effort — the credential/worker change already committed */ }
      return { closed: closedLocal };
    },

    // test/introspection handles (no sockets/credentials exposed by getStatus)
    _internals: { registry, deliveryAdapter: () => deliveryAdapter, heartbeat: () => heartbeat, onUpgrade, wss, clock: theClock }
  };
}

function helloHasCredential(payload) {
  if (!payload || typeof payload !== "object") return false;
  for (const k of Object.keys(payload)) {
    const kl = k.toLowerCase();
    if (kl === "credential" || kl === "authorization" || kl === "bearer" || kl === "token" || kl === "workercredential") return true;
  }
  return false;
}
