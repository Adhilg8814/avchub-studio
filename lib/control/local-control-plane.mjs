// AVC Studio P0 Step 5A — local Control-Plane simulator (test/dev only).
//
// A minimal, localhost-only WebSocket server that speaks Worker Protocol v1 to one
// or more Studio Workers. It authenticates via a WebSocket Authorization header
// (injected test credential → workerId/workspaceId), binds that identity to the
// connection, and validates + routes every inbound worker→cloud message. It reuses
// JobDispatcher (per worker) to offer canonical JOB_OFFER envelopes and track job
// lifecycle, and owns connection-level concerns: HELLO_ACK, heartbeat liveness,
// messageId dedupe, ACK caching + reconnect replay, and reconcile.
//
// NOT the production cloud: no UI, no DB, no real secrets, binds 127.0.0.1 only,
// no multi-tenancy, no pairing, no billing.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { makeEnvelope, validateEnvelope } from "../protocol/envelope.mjs";
import { isWorkerToCloudType } from "../protocol/message-types.mjs";
import { generateId } from "../protocol/ids.mjs";
import { PROTOCOL_ERRORS } from "../protocol/errors.mjs";
import { JobDispatcher } from "./job-dispatcher.mjs";
import { JobTransport } from "../worker/transport.mjs";
import { InMemoryCloudStore } from "./local-cloud-store.mjs";
import { toPublicError } from "./identity-errors.mjs";

const TERMINAL_JOB_EVENTS = new Set(["JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED"]);
const JOB_EVENTS = new Set(["JOB_ACCEPTED", "JOB_STARTED", "JOB_PROGRESS", "JOB_NEEDS_MANUAL_ACTION", "JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED", "JOB_REJECTED"]);

// Per-worker control-side transport handed to a JobDispatcher. Its socket is
// swapped on reconnect so the dispatcher keeps working across connections.
class ServerConnectionTransport extends JobTransport {
  constructor(plane, workerId) { super(); this._plane = plane; this._workerId = workerId; this._controlSubs = new Set(); }
  subscribeControl(handler) { this._controlSubs.add(handler); return () => this._controlSubs.delete(handler); }
  offerJob(env) { this._plane._sendToWorker(this._workerId, env); return this; }
  requestCancel(env) { this._plane._sendToWorker(this._workerId, env); return this; }
  sendToWorker(env) {
    if (env.type === "MESSAGE_ACK") this._plane._store.setAck(this._workerId, env.payload.ackedMessageId, env); // cache for replay
    this._plane._sendToWorker(this._workerId, env);
    return this;
  }
  connect() { return this; }
  disconnect() { return this; }
  isConnected() { return this._plane._isOnline(this._workerId); }
  reconcile() { return { pending: 0 }; }
  _deliverControl(env) { for (const h of [...this._controlSubs]) { try { h(env); } catch { /* subscriber errors isolated */ } } }
}

export class LocalControlPlane {
  // Step 5A back-compat: `credentials` = Map<credential,{workerId,workspaceId}> | object | fn.
  // Step 5B: pass a `pairingService` (real pairing + credential auth) instead.
  constructor({ credentials, store, host = "127.0.0.1", port = 0, clock, degradedMs = 45000, offlineMs = 90000, pairingService = null, adminEnabled = false } = {}) {
    this._credentials = credentials;
    this._pairing = pairingService;
    this._adminEnabled = adminEnabled === true; // dev-only localhost admin routes
    this._store = store || new InMemoryCloudStore();
    this._host = host;
    this._port = port;
    this._clock = typeof clock === "function" ? clock : () => Date.now();
    this._degradedMs = degradedMs;
    this._offlineMs = offlineMs;
    this._http = null;
    this._wss = null;
    this._workers = new Map(); // workerId -> { workspaceId, socket, transport, dispatcher, outbox:[] }
  }

  get port() { return this._port; }
  get store() { return this._store; }

  start() {
    return new Promise((resolve, reject) => {
      this._http = createServer((req, res) => this._onHttpRequest(req, res));
      // Cap inbound frame size (ws default is 100 MiB). Our largest payload is the
      // 1 MB reconcile batch; 2 MiB leaves margin while blocking memory-exhaustion frames.
      this._wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
      this._http.on("upgrade", (req, socket, head) => {
        const ident = this._authenticate(req);
        if (!ident) { this._store.audit("auth_rejected", { reason: "bad_or_missing_credential" }); try { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch { /* ignore */ } socket.destroy(); return; }
        this._wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws, ident));
      });
      this._http.on("error", reject);
      this._http.listen(this._port, this._host, () => { this._port = this._http.address().port; resolve({ host: this._host, port: this._port }); });
    });
  }

  async stop() {
    for (const w of this._workers.values()) { try { w.socket?.close(1001, "server-stop"); } catch { /* ignore */ } w.socket = null; }
    if (this._wss) await new Promise((r) => this._wss.close(() => r()));
    if (this._http) await new Promise((r) => this._http.close(() => r()));
    this._wss = null; this._http = null;
  }

  // ---- auth (Authorization header only; credential never logged) ----
  _authenticate(req) {
    const header = req.headers["authorization"];
    if (!header || typeof header !== "string") return null;
    const cred = header.startsWith("Bearer ") ? header.slice(7) : header;
    if (this._pairing) {
      try { const a = this._pairing.authenticate(cred); return { workerId: a.workerId, workspaceId: a.workspaceId, credentialId: a.credentialId }; }
      catch (err) { this._store.audit("AUTHENTICATION_FAILED", { reason: "credential" }); return null; }
    }
    let ident = null;
    if (typeof this._credentials === "function") ident = this._credentials(cred);
    else if (this._credentials instanceof Map) ident = this._credentials.get(cred);
    else if (this._credentials && typeof this._credentials === "object") ident = this._credentials[cred];
    if (!ident || !ident.workerId || !ident.workspaceId) return null;
    return { workerId: ident.workerId, workspaceId: ident.workspaceId };
  }

  // ---- HTTP: pairing + rotation endpoints (localhost dev API) + WS upgrade ----
  _onHttpRequest(req, res) {
    if (req.method !== "POST") { res.writeHead(426); res.end("Upgrade Required"); return; }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 16 * 1024) { try { req.destroy(); } catch { /* ignore */ } } else chunks.push(c); });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
      catch { return this._json(res, 400, { error: "E_PAIRING_PAYLOAD_INVALID" }); }
      if (!this._pairing) return this._json(res, 404, { error: "pairing disabled" });
      if (req.url === "/worker/pair") return this._handlePair(req, res, body);
      if (req.url === "/worker/credential/rotate") return this._handleRotate(req, res, body);
      if (this._adminEnabled && req.url?.startsWith("/admin/")) return this._handleAdmin(req, res, body);
      return this._json(res, 404, { error: "not found" });
    });
    req.on("error", () => { try { this._json(res, 400, { error: "bad request" }); } catch { /* ignore */ } });
  }
  _json(res, status, obj) {
    try { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); } catch { /* ignore */ }
  }
  _handlePair(req, res, body) {
    try {
      const source = req.socket?.remoteAddress || "local";
      const out = this._pairing.pair(body, { source });
      return this._json(res, 200, out); // plaintext credential returned ONCE
    } catch (err) { const p = toPublicError(err); return this._json(res, p.status, { error: p.code, message: p.message }); }
  }
  // Dev-only localhost admin API (gated by adminEnabled). Sanitized; the pairing code
  // is returned only on creation; a Worker credential is NEVER returned here.
  _handleAdmin(req, res, body) {
    try {
      if (req.url === "/admin/pair-code") { const c = this._pairing.createPairingCode({ workspaceId: body.workspaceId }); return this._json(res, 200, { code: c.code, pairingCodeId: c.pairingCodeId, expiresAt: c.expiresAt }); }
      if (req.url === "/admin/list") return this._json(res, 200, { workers: (this._pairing._store.listWorkersByWorkspace?.(body.workspaceId) || []).map((w) => ({ workerId: w.workerId, name: w.name, status: w.status, connStatus: this.getWorkerStatus(w.workerId) })) });
      if (req.url === "/admin/rotate") { const r = this.requestRotation(body.workerId); return this._json(res, 200, { rotationId: r.rotationId, sent: true }); }
      if (req.url === "/admin/revoke") { this.revokeWorker(body.workerId); return this._json(res, 200, { revoked: true }); }
      return this._json(res, 404, { error: "unknown admin route" });
    } catch (err) { return this._json(res, 400, { error: "admin error" }); }
  }
  _handleRotate(req, res, body) {
    try {
      const header = req.headers["authorization"];
      const currentCredential = header && header.startsWith("Bearer ") ? header.slice(7) : (body.currentCredential || null);
      const out = this._pairing.rotate({ rotationId: body.rotationId, currentCredential }, { source: req.socket?.remoteAddress || "local" });
      return this._json(res, 200, out); // plaintext new credential returned ONCE
    } catch (err) { const p = toPublicError(err); return this._json(res, p.status, { error: p.code, message: p.message }); }
  }

  _worker(workerId, workspaceId) {
    if (!this._workers.has(workerId)) {
      const transport = new ServerConnectionTransport(this, workerId);
      const dispatcher = new JobDispatcher({ transport, workspaceId, workerId });
      this._workers.set(workerId, { workspaceId, socket: null, transport, dispatcher, outbox: [] });
    }
    return this._workers.get(workerId);
  }

  _onConnection(ws, ident) {
    const isReconnect = this._workers.has(ident.workerId);
    const w = this._worker(ident.workerId, ident.workspaceId);
    w.socket = ws;
    w.reconnect = isReconnect;
    w.credentialId = ident.credentialId ?? null;
    this._store.bindWorkspace(ident.workerId, ident.workspaceId);
    this._store.setStatus(ident.workerId, "ONLINE");
    this._store.touch(ident.workerId, this._clock());
    this._flushOutbox(ident.workerId);
    this._store.audit("worker_connected", { workerId: ident.workerId, reconnect: isReconnect });

    ws.on("message", (data) => this._onWorkerMessage(ident, data));
    ws.on("close", () => {
      if (w.socket === ws) { w.socket = null; this._store.setStatus(ident.workerId, "OFFLINE"); }
      this._store.audit("worker_disconnected", { workerId: ident.workerId });
    });
    ws.on("error", () => { /* recorded via close; never surface stack */ });
  }

  // ---- inbound routing + validation ----
  _onWorkerMessage(ident, data) {
    const { workerId, workspaceId } = ident;
    let env;
    try { env = JSON.parse(typeof data === "string" ? data : data.toString("utf8")); }
    catch { this._store.audit("malformed_json", { workerId }); return; }
    try { validateEnvelope(env, { checkSkew: true, now: this._clock() }); }
    catch (err) { this._store.audit("invalid_envelope", { workerId, code: err.code }); this._sendError(workerId, err.code || PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "Invalid envelope"); return; }
    if (!isWorkerToCloudType(env.type)) { this._store.audit("direction_violation", { workerId, type: env.type }); this._sendError(workerId, PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "Wrong direction"); return; }

    // Connection-bound identity. Workspace mismatch is severe → close.
    if (env.workspaceId && env.workspaceId !== workspaceId) {
      this._store.audit("identity_mismatch_workspace", { workerId, envWorkspace: env.workspaceId });
      this._sendError(workerId, PROTOCOL_ERRORS.E_IDENTITY_MISMATCH, "Workspace identity mismatch");
      const w = this._workers.get(workerId); try { w?.socket?.close(1008, "identity"); } catch { /* ignore */ }
      return;
    }
    if (env.workerId && env.workerId !== workerId) {
      this._store.audit("identity_mismatch_worker", { workerId, envWorker: env.workerId });
      this._sendError(workerId, PROTOCOL_ERRORS.E_IDENTITY_MISMATCH, "Worker identity mismatch");
      return; // reject message, keep connection
    }

    // messageId dedupe + ACK replay (survives reconnect / plane restart via store).
    if (this._store.hasSeen(workerId, env.messageId)) {
      const cached = this._store.getAck(workerId, env.messageId);
      if (cached) this._sendToWorker(workerId, cached); // replay same ACK, do NOT re-process
      return;
    }
    this._store.markSeen(workerId, env.messageId);
    this._store.touch(workerId, this._clock());

    this._route(workerId, workspaceId, env);
  }

  _route(workerId, workspaceId, env) {
    switch (env.type) {
      case "WORKER_HELLO": return this._onHello(workerId, workspaceId, env);
      case "WORKER_HEARTBEAT": this._store.setStatus(workerId, "ONLINE"); return;
      case "WORKER_CAPABILITIES": this._store.setCapabilities(workerId, env.payload?.capabilities); return;
      case "WORKER_STORAGE_STATUS": this._store.setStorage(workerId, env.payload?.storage ?? env.payload); return;
      case "STATE_RECONCILE": return this._onReconcile(workerId, workspaceId, env);
      case "JOB_RECOVERY_REPORT": return this._onRecoveryReport(workerId, workspaceId, env);
      case "WORKER_GOODBYE": this._store.setStatus(workerId, "OFFLINE"); this._store.audit("worker_goodbye", { workerId }); return;
      default:
        if (JOB_EVENTS.has(env.type)) {
          if (TERMINAL_JOB_EVENTS.has(env.type)) this._store.upsertJob(workerId, env.jobId, { terminalType: env.type, terminalMessageId: env.messageId, state: env.type });
          else this._store.upsertJob(workerId, env.jobId, { state: env.type });
          const w = this._workers.get(workerId);
          w?.transport._deliverControl(env); // dispatcher tracks + ACKs terminals
          return;
        }
        this._store.audit("unhandled_type", { workerId, type: env.type });
    }
  }

  _onHello(workerId, workspaceId, env) {
    const w = this._workers.get(workerId);
    this._store.setStatus(workerId, "ONLINE");
    // Two-phase rotation completion: the worker reconnected + HELLO'd with a ROTATING
    // credential → promote it to ACTIVE and revoke the old one (end of overlap).
    if (this._pairing && w?.credentialId) { try { this._pairing.completeRotationForCredential(w.credentialId); } catch { /* ignore */ } }
    const pending = this._store.listJobs(workerId).filter((j) => j.terminalType && !j.acknowledged);
    const hasPendingReconcile = w?.reconnect === true || pending.length > 0;
    this._sendToWorker(workerId, makeEnvelope({
      type: "HELLO_ACK", workspaceId, workerId, correlationId: env.correlationId ?? undefined,
      payload: { sessionId: generateId("sess"), serverTime: new Date(this._clock()).toISOString(), negotiatedProtocolVersion: 1, hasPendingReconcile }
    }));
    if (hasPendingReconcile) this._requestReconcile(workerId, workspaceId);
  }

  _onReconcile(workerId, workspaceId, env) {
    // reconcile-builder emits a flat `items` array (each item is a safe per-job summary).
    const items = Array.isArray(env.payload?.items) ? env.payload.items : [];
    for (const item of items) {
      if (item && item.jobId) this._store.upsertJob(workerId, item.jobId, { reconciled: true, recoveryState: item.recoveryState ?? null, submittedToProvider: item.submittedToProvider === true });
    }
    this._ack(workerId, workspaceId, env.messageId, "STATE_RECONCILE", env.correlationId);
  }

  _onRecoveryReport(workerId, workspaceId, env) {
    const p = env.payload || {};
    this._store.upsertJob(workerId, env.jobId, { recovered: true, submittedToProvider: p.submittedToProvider === true, createdSecondGeneration: false });
    this._ack(workerId, workspaceId, env.messageId, "JOB_RECOVERY_REPORT", env.correlationId);
  }

  _ack(workerId, workspaceId, ackedMessageId, ackedType, correlationId) {
    const ack = makeEnvelope({
      type: "MESSAGE_ACK", workspaceId, workerId, correlationId,
      payload: { ackedMessageId, ackedType, status: "ACCEPTED", serverRevision: null, errorCode: null }
    });
    this._store.setAck(workerId, ackedMessageId, ack);
    this._sendToWorker(workerId, ack);
  }

  _sendError(workerId, code, message) {
    const w = this._workers.get(workerId);
    if (!w) return;
    const env = makeEnvelope({ type: "ERROR", workspaceId: w.workspaceId, workerId, payload: { code, message, retriable: false } });
    this._sendRaw(workerId, env);
  }

  // ---- outbound ----
  _sendToWorker(workerId, env) {
    const w = this._workers.get(workerId);
    if (!w) return;
    if (w.socket && w.socket.readyState === 1) { try { w.socket.send(JSON.stringify(env)); return; } catch { /* fall through to queue */ } }
    w.outbox.push(env); // queue while offline; flushed on reconnect
  }
  _sendRaw(workerId, env) { const w = this._workers.get(workerId); if (w?.socket && w.socket.readyState === 1) { try { w.socket.send(JSON.stringify(env)); } catch { /* ignore */ } } }
  _flushOutbox(workerId) { const w = this._workers.get(workerId); if (!w) return; const pending = w.outbox.splice(0); for (const env of pending) this._sendToWorker(workerId, env); }

  _requestReconcile(workerId, workspaceId) {
    this._sendToWorker(workerId, makeEnvelope({ type: "STATE_RECONCILE_REQUEST", workspaceId, workerId, payload: { reason: "reconnect" } }));
  }

  _isOnline(workerId) { const w = this._workers.get(workerId); return Boolean(w && w.socket && w.socket.readyState === 1); }

  // ---- test API ----
  offerJob(workerId, action, input, opts = {}) {
    const w = this._workers.get(workerId);
    if (!w) throw new Error(`Unknown worker ${workerId}`);
    // Cross-workspace guard: a job for workspace X must not be routed to a worker in Y.
    if (opts.workspaceId && w.workspaceId !== opts.workspaceId) throw new Error("E_WORKSPACE_MISMATCH");
    return w.dispatcher.dispatch(action, input, opts);
  }

  // ---- pairing / credential lifecycle (dev API) ----
  createPairingCode(args) { if (!this._pairing) throw new Error("pairing disabled"); return this._pairing.createPairingCode(args); }
  // Operator-initiated rotation: record intent + tell the worker (NO secret in the event).
  requestRotation(workerId, { reason = "operator" } = {}) {
    if (!this._pairing) throw new Error("pairing disabled");
    const { rotationId, expiresAt } = this._pairing.startRotation(workerId, { reason });
    const w = this._workers.get(workerId);
    this._sendToWorker(workerId, makeEnvelope({ type: "WORKER_CREDENTIAL_ROTATE", workspaceId: w?.workspaceId, workerId, payload: { rotationId, expiresAt, reason } }));
    return { rotationId, expiresAt };
  }
  // Revoke a worker: mark all its credentials REVOKED, tell it, and close ITS socket
  // only (other workers are unaffected).
  revokeWorker(workerId) {
    if (this._pairing) this._pairing.revokeWorker(workerId);
    const w = this._workers.get(workerId);
    if (w?.socket) { this._sendRaw(workerId, makeEnvelope({ type: "WORKER_REVOKED", workspaceId: w.workspaceId, workerId, payload: { reason: "revoked" } })); try { w.socket.close(1008, "revoked"); } catch { /* ignore */ } }
    this._store.audit("WORKER_REVOKED", { workerId });
  }
  renameWorker(workerId, name) { if (this._pairing && this._pairing._store?.renameWorker) return this._pairing._store.renameWorker(workerId, name); return false; }
  cancelJob(workerId, jobId) { const w = this._workers.get(workerId); return w ? w.dispatcher.cancel(jobId) : { ok: false }; }
  requestReconcile(workerId) { const w = this._workers.get(workerId); if (w) this._requestReconcile(workerId, w.workspaceId); }
  // Abrupt server-side drop (simulates a network cut: no clean close handshake).
  disconnectWorker(workerId) { const w = this._workers.get(workerId); if (w?.socket) { try { w.socket.terminate(); } catch { /* ignore */ } } }
  getDispatcher(workerId) { return this._workers.get(workerId)?.dispatcher ?? null; }
  // Test hook: send a (possibly duplicate/unknown) MESSAGE_ACK to a worker.
  sendAck(workerId, ackedMessageId, ackedType = "JOB_COMPLETED", jobId = undefined) {
    const w = this._workers.get(workerId);
    if (!w) return;
    this._sendToWorker(workerId, makeEnvelope({ type: "MESSAGE_ACK", workspaceId: w.workspaceId, workerId, jobId, payload: { ackedMessageId, ackedType, status: "ACCEPTED", serverRevision: null, errorCode: null } }));
  }
  connectedWorkers() { return [...this._workers.entries()].filter(([, w]) => this._isOnline(w.workspaceId ? w.workspaceId : "") || (w.socket && w.socket.readyState === 1)).map(([id]) => id); }
  getAudit() { return this._store.getAudit(); }

  // Liveness derived from last-seen vs an injectable/overridable clock.
  getWorkerStatus(workerId, nowMs = this._clock()) {
    const w = this._workers.get(workerId);
    if (!w || !w.socket || w.socket.readyState !== 1) return "OFFLINE";
    const elapsed = nowMs - this._store.lastSeenAt(workerId);
    if (elapsed < this._degradedMs) return "ONLINE";
    if (elapsed < this._offlineMs) return "DEGRADED";
    return "OFFLINE";
  }
}
