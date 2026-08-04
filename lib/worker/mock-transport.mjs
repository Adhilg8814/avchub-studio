// AVC Studio P0 Step 2 — in-process MockTransport.
//
// PURE / in-memory. No network, no fs, no flaky timers. Simulates the two sides
// of the Worker protocol channel in a single process, delivering protocol
// envelopes in deterministic FIFO order. Every message is validated with
// lib/protocol before delivery and rejected if it travels the wrong direction.
//
// Delivery model: a single FIFO queue drained synchronously. Nested publishes
// (a subscriber that emits while being delivered to) are enqueued and picked up
// by the same drain loop — this preserves global order without recursion or
// timers, and keeps tests deterministic. Subscriber exceptions are caught so a
// throwing handler cannot corrupt transport state or drop later messages.

import { validateEnvelope } from "../protocol/envelope.mjs";
import { isCloudToWorkerType, isWorkerToCloudType } from "../protocol/message-types.mjs";
import { JobTransport } from "./transport.mjs";

export class MockTransport extends JobTransport {
  constructor(options = {}) {
    super();
    // Skew checks off by default: tests build envelopes at "now" and we do not
    // want clock flakiness in a pure in-memory channel.
    this._checkSkew = options.checkSkew === true;
    this._state = "DISCONNECTED";
    this._controlSubs = new Set(); // receive worker→cloud
    this._workerSubs = new Set();  // receive cloud→worker
    this._queue = [];              // { direction: 'toWorker'|'toControl', envelope }
    this._draining = false;
    this._history = [];            // { direction, type, messageId, jobId } — inspection only
    this._deliveryErrors = [];     // sanitized subscriber-exception log (inspection only)
  }

  // ---- connection state ----
  connect() { this._state = "CONNECTED"; return this; }       // idempotent
  disconnect() {                                              // idempotent + deterministic cleanup
    this._state = "DISCONNECTED";
    this._queue.length = 0;
    return this;
  }
  isConnected() { return this._state === "CONNECTED"; }

  // ---- subscriptions ----
  subscribeControl(handler) { return this._subscribe(this._controlSubs, handler); }
  subscribeWorker(handler) { return this._subscribe(this._workerSubs, handler); }

  _subscribe(set, handler) {
    if (typeof handler !== "function") throw new Error("subscribe handler must be a function");
    set.add(handler);
    return () => set.delete(handler); // unsubscribe
  }

  // ---- control → worker ----
  offerJob(envelope) { return this._sendToWorker(envelope, "JOB_OFFER"); }
  requestCancel(envelope) { return this._sendToWorker(envelope, "JOB_CANCEL_REQUEST"); }

  // Generic cloud→worker send (used by offerJob/requestCancel; also usable for
  // PING/SESSION_CHECK_REQUEST/etc. in later steps).
  sendToWorker(envelope) { return this._sendToWorker(envelope, null); }

  _sendToWorker(envelope, expectedType) {
    this._assertConnected();
    this._validate(envelope);
    if (!isCloudToWorkerType(envelope.type)) {
      throw new Error(`Wrong direction: ${envelope.type} is not a cloud→worker message`);
    }
    if (expectedType && envelope.type !== expectedType) {
      throw new Error(`Expected ${expectedType}, got ${envelope.type}`);
    }
    this._enqueue("toWorker", envelope);
    return this;
  }

  // ---- worker → control ----
  publishWorkerEvent(envelope) {
    this._assertConnected();
    this._validate(envelope);
    if (!isWorkerToCloudType(envelope.type)) {
      throw new Error(`Wrong direction: ${envelope.type} is not a worker→cloud message`);
    }
    this._enqueue("toControl", envelope);
    return this;
  }

  // ---- reconcile (no durable state in Step 2) ----
  reconcile() { return { pending: [] }; }

  // ---- internals ----
  _assertConnected() {
    if (this._state !== "CONNECTED") throw new Error("Transport is not connected");
  }

  _validate(envelope) {
    validateEnvelope(envelope, { checkSkew: this._checkSkew });
  }

  _enqueue(direction, envelope) {
    this._history.push({ direction, type: envelope.type, messageId: envelope.messageId, jobId: envelope.jobId ?? null });
    this._queue.push({ direction, envelope });
    this._drain();
  }

  _drain() {
    if (this._draining) return; // re-entrant publish → let the running loop pick it up
    this._draining = true;
    try {
      while (this._queue.length > 0) {
        const { direction, envelope } = this._queue.shift();
        const subs = direction === "toWorker" ? this._workerSubs : this._controlSubs;
        for (const handler of [...subs]) {
          try {
            handler(envelope);
          } catch (err) {
            // A subscriber exception must NOT corrupt transport state or drop
            // later messages. Record a sanitized note and continue.
            this._deliveryErrors.push({ direction, type: envelope.type, error: safeErr(err) });
          }
        }
      }
    } finally {
      this._draining = false;
    }
  }

  // ---- test-only inspection (never leaks mutable internals) ----
  getHistory() { return this._history.map((h) => ({ ...h })); }
  getDeliveryErrors() { return this._deliveryErrors.map((e) => ({ ...e })); }
  get pendingCount() { return this._queue.length; }
}

function safeErr(err) {
  const msg = err && err.message ? String(err.message) : "error";
  // Never echo secrets; clamp length.
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}
