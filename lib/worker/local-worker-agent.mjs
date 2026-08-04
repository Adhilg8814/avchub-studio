// AVC Studio P0 Step 5A — Worker connection agent + WebSocket worker factory.
//
// The agent owns Protocol v1 CONNECTION lifecycle on the worker side (HELLO →
// HELLO_ACK → capabilities/storage → heartbeat → reconcile/recovery on reconnect).
// The WorkerRuntime (unchanged) owns JOB_OFFER/CANCEL/ACK + job events. Both
// subscribe to the same transport; each handles its own message types. No `ws`
// import here — WebSocket lives entirely in the transport.

import { makeEnvelope } from "../protocol/envelope.mjs";
import { WorkerRuntime } from "./worker-runtime.mjs";
import { JobRegistry } from "./job-registry.mjs";
import { registerFakeHandlers } from "./handlers/fake-handlers.mjs";
import { buildReconcileBatches, buildRecoveryReport } from "./reconcile-builder.mjs";
import { classifyRecovery, RECOVERY_STATES } from "./recovery-classifier.mjs";
import { WebSocketWorkerTransport } from "./transports/websocket-worker-transport.mjs";

export class WorkerAgent {
  constructor({ transport, runtime, journal = null, pendingAck = null, workspaceId, workerId, capabilities = [], storage = null, pairingClient = null, credentialStore = null } = {}) {
    if (!transport) throw new Error("WorkerAgent requires a transport");
    if (!runtime) throw new Error("WorkerAgent requires a runtime");
    if (!workspaceId || !workerId) throw new Error("WorkerAgent requires workspaceId + workerId");
    this._transport = transport;
    this._runtime = runtime;
    this._journal = journal;
    this._pendingAck = pendingAck;
    this._workspaceId = workspaceId;
    this._workerId = workerId;
    this._capabilities = [...capabilities];
    this._storage = storage || { rootLabel: "test-root", freeBytes: 8_000_000_000, totalBytes: 16_000_000_000 };
    this._pairingClient = pairingClient;   // Step 5B: drives credential rotation
    this._credentialStore = credentialStore;
    this._heartbeatTimer = null;
    this._unsub = null;
    this._offOpen = null;
    this._helloAcked = false;
    this._revoked = false;
    this._repairHooks = new Set();
  }

  // REPAIR_REQUIRED: fired after WORKER_REVOKED — the operator must re-pair.
  onRepairRequired(cb) { this._repairHooks.add(cb); return () => this._repairHooks.delete(cb); }
  isRepairRequired() { return this._revoked === true; }

  start() {
    this._unsub = this._transport.subscribeWorker((env) => this._onInbound(env));
    this._offOpen = this._transport.onOpen(() => this._sendHello());
    this._runtime.start();
    this._transport.connect();
    return this;
  }

  async waitReady(timeoutMs = 3000) {
    await this._transport.waitOpen(timeoutMs);
    // wait for HELLO_ACK
    const start = Date.now();
    while (!this._helloAcked && Date.now() - start < timeoutMs) await new Promise((r) => setImmediate(r));
    return this;
  }

  _mk(type, payload) { return makeEnvelope({ type, workspaceId: this._workspaceId, workerId: this._workerId, payload }); }

  _sendHello() {
    this._helloAcked = false;
    this._transport.publishWorkerEvent(this._mk("WORKER_HELLO", {
      workerVersion: "0.1.0", platform: process.platform, osVersion: "test", architecture: process.arch,
      protocolVersion: 1, capabilities: this._capabilities, storage: this._storage
    }));
  }

  _onInbound(env) {
    switch (env.type) {
      case "HELLO_ACK": return this._onHelloAck(env);
      case "STATE_RECONCILE_REQUEST": return this._sendReconcile();
      case "WORKER_CREDENTIAL_ROTATE": return void this._onRotate(env);
      case "WORKER_REVOKED": return void this._onRevoked(env);
      default: return undefined; // JOB_OFFER / JOB_CANCEL_REQUEST / MESSAGE_ACK → runtime
    }
  }

  _onHelloAck(env) {
    this._helloAcked = true;
    this._transport.publishWorkerEvent(this._mk("WORKER_CAPABILITIES", { capabilities: this._capabilities }));
    this._transport.publishWorkerEvent(this._mk("WORKER_STORAGE_STATUS", { storage: this._storage }));
    // C6: reconcile whenever the cloud flags a pending reconcile OR this Worker holds recoverable
    // journal state locally (after a crash the gateway may not know the per-job state) — so non-terminal
    // recovery evidence always reaches the Control Plane. Reconcile reports are idempotent at the CP.
    const hasLocalRecoverable = this._journal ? this._journal.listRecoverable().length > 0 : false;
    if ((env.payload && env.payload.hasPendingReconcile) || hasLocalRecoverable) this._replayPendingAndReconcile();
    // If we just authenticated with a PENDING (rotated) credential, promote it now
    // (old credential was revoked server-side after this successful HELLO).
    if (this._credentialStore) Promise.resolve().then(() => this._promotePendingIfAny()).catch(() => {});
  }

  async _promotePendingIfAny() {
    try { const p = await this._credentialStore.getPendingCredential(); if (p) await this._credentialStore.promotePendingCredential(); }
    catch { /* keep pending; retry next HELLO */ }
  }

  // Operator/expiry-driven rotation: fetch the new credential (stored PENDING) and
  // reconnect with it. The old credential stays valid during the grace overlap, so a
  // failure here is safe — no credential is logged.
  async _onRotate(env) {
    if (!this._pairingClient) return;
    try { await this._pairingClient.rotate(env.payload?.rotationId); this._transport.reconnect(); }
    catch { /* rotation failed; old credential remains valid during grace */ }
  }

  // Revocation: delete local credentials, stop reconnecting, require re-pairing.
  async _onRevoked() {
    this._revoked = true;
    this.stopHeartbeat();
    try { this._credentialStore?.deleteAll?.(); } catch { /* ignore */ }
    this._transport.disconnect();
    for (const cb of this._repairHooks) { try { cb(); } catch { /* ignore */ } }
  }

  // Reconnect recovery: (C6) first promote IMPORTED/DOWNLOADED local results to durable terminals so
  // they replay as normal terminals below; then replay ALL pending-ack terminals (SAME messageId); then
  // send per-job recovery reports for the remaining non-terminal recoverable states.
  _replayPendingAndReconcile() {
    try { this._runtime.resumeRecoverableTerminals(); } catch { /* best effort; reconcile still runs */ }
    if (this._pendingAck) {
      for (const rec of this._pendingAck.list()) {
        if (rec && rec.envelope) this._transport.publishWorkerEvent(rec.envelope);
      }
    }
    this._sendReconcile();
  }

  _sendReconcile() {
    const records = this._journal ? this._journal.listRecoverable() : [];
    const batches = buildReconcileBatches({ workspaceId: this._workspaceId, workerId: this._workerId, records });
    for (const b of batches) this._transport.publishWorkerEvent(b);
    // C6: emit a canonical per-job JOB_RECOVERY_REPORT for EVERY recoverable record (previously
    // TERMINAL_PENDING_ACK only). The Control Plane reconciles PRE_SUBMIT (proven-safe re-offer),
    // SUBMITTING_UNKNOWN / POSSIBLY_SUBMITTED (honest RECOVERING/NEEDS_ACTION), and TERMINAL_PENDING_ACK
    // (audit; terminal is delivered by the pending-ack replay above). Idempotent at the CP.
    for (const rec of records) {
      this._transport.publishWorkerEvent(buildRecoveryReport(rec.jobId, { workspaceId: this._workspaceId, workerId: this._workerId, record: rec }));
    }
  }

  // Heartbeat: manual (tests) or periodic (dev/prod). Timer is unref'd.
  sendHeartbeat() {
    this._transport.publishWorkerEvent(this._mk("WORKER_HEARTBEAT", { activeJobs: this._runtime.listActiveJobs(), freeBytes: this._storage.freeBytes ?? 0 }));
  }
  startHeartbeat(intervalMs = 20000) {
    this.stopHeartbeat();
    this._heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }
  stopHeartbeat() { if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; } }

  sendGoodbye() { this._transport.publishWorkerEvent(this._mk("WORKER_GOODBYE", { reason: "shutdown" })); }

  async stop({ goodbye = false } = {}) {
    if (goodbye && this._transport.isConnected()) this.sendGoodbye();
    this.stopHeartbeat();
    if (this._offOpen) { this._offOpen(); this._offOpen = null; }
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._runtime.stop();
    this._transport.disconnect();
  }
}

function deriveCapabilities(registry) {
  const caps = new Set();
  for (const action of registry.list()) {
    const h = registry.get(action);
    if (h && typeof h.capabilities === "function") for (const c of h.capabilities()) caps.add(c);
  }
  return [...caps];
}

// createWebSocketWorker(options): wire transport + runtime + agent over WebSocket.
// Fake handlers by default; NEVER the real Grok bridge unless explicitly injected.
export function createWebSocketWorker(options = {}) {
  const { url, credential, workspaceId, workerId } = options;
  if (!url || !credential || !workspaceId || !workerId) throw new Error("createWebSocketWorker requires url, credential, workspaceId, workerId");

  const transport = new WebSocketWorkerTransport({
    url, headers: { Authorization: `Bearer ${credential}` },
    backoffMs: options.backoffMs, autoReconnect: options.autoReconnect !== false,
    checkSkew: options.checkSkew === true, clock: options.clock
  });

  const registry = options.registry || new JobRegistry();
  if (options.handlers) { for (const [action, handler] of Object.entries(options.handlers)) registry.register(action, handler, { replace: true }); }
  else if (options.registerFakes !== false && registry.list().length === 0) registerFakeHandlers(registry, options.fakeOptions ?? {});

  const capabilities = options.capabilities ?? deriveCapabilities(registry);
  const durationContext = options.durationContext ?? { supportedDurationsSec: [6, 10, 15], defaultDurationSec: 10 };
  const runtime = new WorkerRuntime({ transport, registry, workerId, capabilities, durationContext, journal: options.journal ?? null, pendingAck: options.pendingAck ?? null });
  const agent = new WorkerAgent({ transport, runtime, journal: options.journal ?? null, pendingAck: options.pendingAck ?? null, workspaceId, workerId, capabilities, storage: options.storage });

  return { transport, registry, runtime, agent, workspaceId, workerId };
}

// createPairedWorker(options): Step 5B wiring. The transport loads its credential
// from a secure WorkerCredentialStore on EVERY connect (rotation/revocation aware);
// no plaintext credential is passed in. workspaceId/workerId come from pairing.
export function createPairedWorker(options = {}) {
  const { url, credentialStore, pairingClient, workspaceId, workerId } = options;
  if (!url || !credentialStore || !workspaceId || !workerId) throw new Error("createPairedWorker requires url, credentialStore, workspaceId, workerId");

  // Prefer a PENDING (rotated) credential during a rotation, else the ACTIVE one.
  const credentialProvider = async () => {
    const p = await credentialStore.getPendingCredential();
    if (p && p.credential) return p.credential;
    const a = await credentialStore.getActiveCredential();
    return a && a.credential ? a.credential : null;
  };

  const transport = new WebSocketWorkerTransport({
    url, credentialProvider, backoffMs: options.backoffMs,
    autoReconnect: options.autoReconnect !== false, checkSkew: options.checkSkew === true, clock: options.clock
  });

  const registry = options.registry || new JobRegistry();
  if (options.handlers) { for (const [action, handler] of Object.entries(options.handlers)) registry.register(action, handler, { replace: true }); }
  else if (options.registerFakes !== false && registry.list().length === 0) registerFakeHandlers(registry, options.fakeOptions ?? {});

  const capabilities = options.capabilities ?? deriveCapabilities(registry);
  const durationContext = options.durationContext ?? { supportedDurationsSec: [6, 10, 15], defaultDurationSec: 10 };
  const runtime = new WorkerRuntime({ transport, registry, workerId, capabilities, durationContext, journal: options.journal ?? null, pendingAck: options.pendingAck ?? null });
  const agent = new WorkerAgent({ transport, runtime, journal: options.journal ?? null, pendingAck: options.pendingAck ?? null, workspaceId, workerId, capabilities, storage: options.storage, pairingClient, credentialStore });

  return { transport, registry, runtime, agent, workspaceId, workerId };
}
