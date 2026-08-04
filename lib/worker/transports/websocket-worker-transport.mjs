// AVC Studio P0 Step 5A — worker-side WebSocket transport (JobTransport impl).
//
// Wraps a `ws` WebSocket CLIENT and presents the JobTransport surface the
// WorkerRuntime + WorkerAgent use: subscribeWorker (inbound cloud→worker),
// publishWorkerEvent (outbound worker→cloud), connect/disconnect/isConnected, plus
// lifecycle hooks (onOpen/onClose/onReconnect) and configurable reconnect+backoff.
//
// ALL WebSocket-specific code lives here — the runtime never imports `ws`. Every
// inbound frame is JSON-parsed and validated (envelope, direction cloud→worker,
// messageId dedupe, size/skew via validateEnvelope); a malformed/invalid frame is
// recorded and dropped, never crashing and never surfacing a stack trace.
//
// The credential travels ONLY in the WebSocket Authorization header (never in a
// payload). Nothing here logs the raw credential.

import { WebSocket } from "ws";
import { validateEnvelope } from "../../protocol/envelope.mjs";
import { isCloudToWorkerType } from "../../protocol/message-types.mjs";
import { JobTransport } from "../transport.mjs";

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export class WebSocketWorkerTransport extends JobTransport {
  constructor({ url, headers = {}, credentialProvider = null, backoffMs, autoReconnect = true, checkSkew = false, clock, maxSeen = 4096 } = {}) {
    super();
    if (!url) throw new Error("WebSocketWorkerTransport requires a url");
    this._url = url;
    this._headers = headers;
    this._credentialProvider = credentialProvider; // async () => credential | null (Step 5B)
    this._authHooks = new Set();
    this._authStop = false;
    this._backoff = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : DEFAULT_BACKOFF_MS;
    this._autoReconnect = autoReconnect;
    this._checkSkew = checkSkew;
    this._clock = typeof clock === "function" ? clock : () => Date.now();
    this._ws = null;
    this._intentionalClose = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._workerSubs = new Set();
    this._outbox = [];           // queued outbound while not OPEN
    this._seen = [];             // inbound messageId dedupe (bounded)
    this._seenSet = new Set();
    this._maxSeen = maxSeen;
    this._openHooks = new Set();
    this._closeHooks = new Set();
    this._reconnectHooks = new Set();
    this._errors = [];           // sanitized inbound/handshake errors (inspection)
    this._handshakeStatus = null;
  }

  // ---- lifecycle hooks (used by the WorkerAgent) ----
  onOpen(cb) { this._openHooks.add(cb); return () => this._openHooks.delete(cb); }
  onClose(cb) { this._closeHooks.add(cb); return () => this._closeHooks.delete(cb); }
  onReconnect(cb) { this._reconnectHooks.add(cb); return () => this._reconnectHooks.delete(cb); }

  // ---- connection ----
  onAuthRequired(cb) { this._authHooks.add(cb); return () => this._authHooks.delete(cb); }
  connect() { this._intentionalClose = false; this._authStop = false; this._open(); return this; }
  // Soft reconnect (e.g. after credential rotation): drop the current socket and
  // re-dial, loading the (possibly new) credential fresh from the provider.
  reconnect() {
    this._authStop = false; this._intentionalClose = false;
    const old = this._ws; this._ws = null;
    if (old) { try { old.removeAllListeners?.(); old.close(1000, "reconnect"); } catch { /* ignore */ } }
    this._attempt = 1; this._open(true);
    return this;
  }

  async _open(forceReconnect = false) {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
    if (this._authStop) return;
    const isReconnect = forceReconnect || this._attempt > 0;
    // Load the credential fresh for this attempt (rotation/revocation aware). The
    // credential travels ONLY in the Authorization header — never a URL/query/arg.
    let headers = this._headers;
    if (typeof this._credentialProvider === "function") {
      let cred = null;
      try { cred = await this._credentialProvider(); } catch { cred = null; }
      if (!cred) { this._authStop = true; for (const cb of this._authHooks) safe(cb, { reason: "AUTH_REQUIRED" }); return; }
      headers = { ...this._headers, Authorization: `Bearer ${cred}` };
    }
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
    let ws;
    try { ws = new WebSocket(this._url, { headers, handshakeTimeout: 5000 }); }
    catch (err) { this._recordError("dial", err); this._scheduleReconnect(); return; }
    this._ws = ws;

    ws.on("open", () => {
      this._attempt = 0;
      this._flushOutbox();
      for (const cb of this._openHooks) safe(cb, { reconnect: isReconnect });
      if (isReconnect) for (const cb of this._reconnectHooks) safe(cb);
    });
    ws.on("message", (data) => this._onMessage(data));
    ws.on("unexpected-response", (_req, res) => {
      this._handshakeStatus = res.statusCode;
      this._recordError("handshake", new Error(`HTTP ${res.statusCode}`));
      if (res.statusCode === 401 || res.statusCode === 403) { this._authStop = true; for (const cb of this._authHooks) safe(cb, { reason: "AUTH_REQUIRED", status: res.statusCode }); }
      try { res.resume(); } catch { /* drain */ }
    });
    ws.on("error", (err) => this._recordError("socket", err));
    ws.on("close", (code) => {
      for (const cb of this._closeHooks) safe(cb, { code, intentional: this._intentionalClose });
      if (!this._intentionalClose && this._autoReconnect && !this._authStop) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._intentionalClose || !this._autoReconnect || this._authStop) return;
    if (this._reconnectTimer) return;
    const delay = this._backoff[Math.min(this._attempt, this._backoff.length - 1)];
    this._attempt += 1;
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._open(); }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }
  authStopped() { return this._authStop === true; }

  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._ws) { try { this._ws.close(1000, "worker-disconnect"); } catch { /* ignore */ } }
    return this;
  }

  isConnected() { return Boolean(this._ws && this._ws.readyState === WebSocket.OPEN); }
  get handshakeStatus() { return this._handshakeStatus; }
  getErrors() { return this._errors.map((e) => ({ ...e })); }

  // Resolve once the socket is OPEN (or reject on first handshake failure).
  waitOpen(timeoutMs = 3000) {
    if (this.isConnected()) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error("waitOpen timeout")); }, timeoutMs);
      if (t.unref) t.unref();
      const offOpen = this.onOpen(() => { cleanup(); resolve(this); });
      const offClose = this.onClose(() => { if (!this.isConnected()) { cleanup(); reject(new Error(`connect failed${this._handshakeStatus ? ` (HTTP ${this._handshakeStatus})` : ""}`)); } });
      function cleanup() { clearTimeout(t); offOpen(); offClose(); }
    });
  }

  // ---- JobTransport: worker side ----
  subscribeWorker(handler) {
    if (typeof handler !== "function") throw new Error("subscribeWorker handler must be a function");
    this._workerSubs.add(handler);
    return () => this._workerSubs.delete(handler);
  }

  publishWorkerEvent(envelope) {
    const data = JSON.stringify(envelope);
    if (this.isConnected()) { try { this._ws.send(data); } catch (err) { this._recordError("send", err); this._outbox.push(data); } }
    else this._outbox.push(data);
    return this;
  }

  _flushOutbox() {
    if (!this.isConnected()) return;
    const pending = this._outbox.splice(0);
    for (const data of pending) { try { this._ws.send(data); } catch (err) { this._recordError("send", err); this._outbox.push(data); } }
  }

  _onMessage(data) {
    let env;
    try { env = JSON.parse(typeof data === "string" ? data : data.toString("utf8")); }
    catch { this._recordError("parse", new Error("malformed JSON")); return; }
    try { validateEnvelope(env, { checkSkew: this._checkSkew, now: this._clock() }); }
    catch (err) { this._recordError("validate", err); return; }
    if (!isCloudToWorkerType(env.type)) { this._recordError("direction", new Error(`${env.type} is not cloud→worker`)); return; }
    if (this._seenSet.has(env.messageId)) return; // messageId dedupe (drop duplicate)
    this._remember(env.messageId);
    for (const handler of [...this._workerSubs]) safe(handler, env);
  }

  _remember(messageId) {
    this._seenSet.add(messageId);
    this._seen.push(messageId);
    if (this._seen.length > this._maxSeen) { const old = this._seen.shift(); this._seenSet.delete(old); }
  }

  _recordError(stage, err) {
    const msg = err && err.message ? String(err.message).slice(0, 200) : "error";
    this._errors.push({ stage, code: err && err.code, message: msg });
  }

  // Worker side does not offer/cancel/reconcile from cloud→worker direction.
  reconcile() { return { pending: this._outbox.length }; }
}

function safe(fn, arg) { try { fn(arg); } catch { /* subscriber/hook errors must not break the transport */ } }
