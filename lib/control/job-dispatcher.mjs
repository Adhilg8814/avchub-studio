// AVC Studio P0 Step 2 — control-side JobDispatcher.
//
// PURE / in-memory. Builds protocol-shaped JOB_OFFER envelopes, sends them via a
// JobTransport, tracks worker→cloud lifecycle events, and resolves a terminal
// result. Owns request idempotency (in-memory, no TTL/persistence yet) so a
// repeated click does not create a second paid generation — while a deliberate
// new variant (new req_ key + attempt_ id) is allowed. Never dedupes by prompt.
//
// Acknowledges terminal worker messages with MESSAGE_ACK; never acks a
// MESSAGE_ACK (no ACK loop). No network, no fs, no timers.

import { makeEnvelope } from "../protocol/envelope.mjs";
import { generateId } from "../protocol/ids.mjs";
import {
  validateJobOffer, actionConsumesQuota, JOB_ACTIONS
} from "../protocol/job-contracts.mjs";
import { isTerminalJobState } from "../protocol/job-states.mjs";
import { PROTOCOL_ERRORS, protocolError } from "../protocol/errors.mjs";
import { InMemoryJobStore } from "../worker/in-memory-job-store.mjs";

const GENERATION_ACTIONS = new Set([
  "GENERATE_CHATGPT_IMAGE", "GENERATE_GROK_IMAGE", "GENERATE_GROK_VIDEO"
]);
const TERMINAL_WORKER_TYPES = new Set(["JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED"]);
const ACKABLE_WORKER_TYPES = new Set([
  "JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED", "JOB_RECOVERY_REPORT",
  "ASSET_METADATA_UPSERT", "STATE_RECONCILE"
]);

export class JobDispatcher {
  constructor({ transport, workspaceId, workerId, userId = undefined, durationContext = undefined } = {}) {
    if (!transport) throw new Error("JobDispatcher requires a transport");
    if (!workspaceId) throw new Error("JobDispatcher requires a workspaceId");
    if (!workerId) throw new Error("JobDispatcher requires a workerId");
    this._transport = transport;
    this._workspaceId = workspaceId;
    this._workerId = workerId;
    this._userId = userId;
    this._durationContext = durationContext;
    this._jobs = new InMemoryJobStore();      // jobId -> job record
    this._idempotency = new Map();            // requestIdempotencyKey -> jobId
    this._ackedMessageIds = new Set();        // dedupe terminal acks
    this._unsub = this._transport.subscribeControl((env) => this._onWorkerEvent(env));
  }

  dispose() { if (this._unsub) { this._unsub(); this._unsub = null; } }

  // dispatch(action, input, options?) -> handle
  //   options: { requestIdempotencyKey?, generationAttemptId?, parentAttemptId?, retryOfJobId?, durationContext? }
  dispatch(action, input = {}, options = {}) {
    if (!JOB_ACTIONS.includes(action)) {
      throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_ACTION, "Unknown job action", { field: "action" });
    }

    const isGen = GENERATION_ACTIONS.has(action);
    const requestIdempotencyKey = options.requestIdempotencyKey ?? (isGen ? generateId("req") : undefined);
    const generationAttemptId = isGen ? (options.generationAttemptId ?? generateId("attempt")) : undefined;

    // Idempotency: same request key → same logical job (no second dispatch).
    if (requestIdempotencyKey && this._idempotency.has(requestIdempotencyKey)) {
      const existingId = this._idempotency.get(requestIdempotencyKey);
      return this._handleFor(existingId);
    }

    // Canonical shape (P0 Step 3): request identity at payload level; `input`
    // is action-specific business data only. validateJobOffer validates both.
    const ctx = options.durationContext ?? this._durationContext;
    const offerPayload = {
      action,
      ...(requestIdempotencyKey ? { requestIdempotencyKey } : {}),
      ...(generationAttemptId ? { generationAttemptId } : {}),
      ...(options.parentAttemptId ? { parentAttemptId: options.parentAttemptId } : {}),
      ...(options.retryOfJobId ? { retryOfJobId: options.retryOfJobId } : {}),
      quotaRisk: actionConsumesQuota(action),
      input: { ...input }
    };
    const normalizedPayload = validateJobOffer(offerPayload, ctx ? { supportedDurationsSec: ctx.supportedDurationsSec } : undefined);

    const jobId = generateId("job");
    const correlationId = generateId("corr");

    // Dispatcher-side record + terminal promise.
    let resolveDone, rejectDone;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
    // Avoid unhandled-rejection if nobody awaits a failed job.
    done.catch(() => {});
    const record = {
      jobId, action, requestIdempotencyKey: requestIdempotencyKey ?? null,
      generationAttemptId: generationAttemptId ?? null,
      parentAttemptId: options.parentAttemptId ?? null,
      state: "QUEUED", events: [], terminal: null, subscribers: new Set(),
      resolveDone, rejectDone, done, correlationId
    };
    this._jobs.create(jobId, record);
    if (requestIdempotencyKey) this._idempotency.set(requestIdempotencyKey, jobId);

    const offer = makeEnvelope({
      type: "JOB_OFFER", userId: this._userId, workspaceId: this._workspaceId,
      workerId: this._workerId, jobId, correlationId,
      payload: {
        ...normalizedPayload
      }
    });

    record.state = "DISPATCHED";
    this._transport.offerJob(offer);
    return this._handleFor(jobId);
  }

  cancel(jobId) {
    const rec = this._jobs.get(jobId);
    if (!rec) return { ok: false, reason: "unknown-job" }; // safe, no throw
    if (rec.terminal) return { ok: true, state: rec.state };  // idempotent
    const env = makeEnvelope({
      type: "JOB_CANCEL_REQUEST", userId: this._userId, workspaceId: this._workspaceId,
      workerId: this._workerId, jobId, correlationId: rec.correlationId,
      payload: { requestedByUserId: this._userId ?? null, reason: "USER_CANCELED" }
    });
    this._transport.requestCancel(env);
    return { ok: true, state: rec.state };
  }

  getJob(jobId) {
    const rec = this._jobs.get(jobId);
    if (!rec) return null;
    return { jobId, action: rec.action, state: rec.state, terminal: rec.terminal ? { ...rec.terminal } : null };
  }

  subscribe(jobId, handler) {
    const rec = this._jobs.get(jobId);
    if (!rec) throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Unknown jobId", { field: "jobId" });
    if (typeof handler !== "function") throw new Error("subscribe handler must be a function");
    rec.subscribers.add(handler);
    return () => rec.subscribers.delete(handler);
  }

  listJobs() { return this._jobs.ids(); }

  // ---- internals ----
  _handleFor(jobId) {
    const rec = this._jobs.get(jobId);
    return {
      jobId,
      requestIdempotencyKey: rec.requestIdempotencyKey,
      generationAttemptId: rec.generationAttemptId,
      parentAttemptId: rec.parentAttemptId,
      done: rec.done,
      getState: () => this._jobs.get(jobId)?.state ?? null
    };
  }

  _onWorkerEvent(env) {
    const rec = this._jobs.get(env.jobId);
    if (!rec) return; // not ours

    // Map event → state (best-effort; runtime is the source of truth).
    const stateByType = {
      JOB_ACCEPTED: "ACCEPTED", JOB_STARTED: "RUNNING", JOB_PROGRESS: "RUNNING",
      JOB_NEEDS_MANUAL_ACTION: "NEEDS_MANUAL_ACTION",
      JOB_COMPLETED: "SUCCEEDED", JOB_FAILED: "FAILED", JOB_CANCELED: "CANCELED",
      JOB_REJECTED: "FAILED"
    };
    if (stateByType[env.type]) rec.state = stateByType[env.type];

    rec.events.push({ type: env.type, messageId: env.messageId, payload: env.payload });
    for (const h of [...rec.subscribers]) {
      try { h({ type: env.type, payload: env.payload }); } catch { /* subscriber error must not break dispatch */ }
    }

    // Acknowledge terminal / ackable worker messages with MESSAGE_ACK (once).
    if (ACKABLE_WORKER_TYPES.has(env.type)) this._ack(env);

    // Resolve the terminal promise once.
    if ((TERMINAL_WORKER_TYPES.has(env.type) || env.type === "JOB_REJECTED") && !rec.terminal) {
      rec.terminal = { type: env.type, state: rec.state, payload: env.payload };
      rec.resolveDone({ jobId: env.jobId, type: env.type, state: rec.state, payload: env.payload });
    }
  }

  _ack(env) {
    if (this._ackedMessageIds.has(env.messageId)) return; // duplicate ACK harmless
    this._ackedMessageIds.add(env.messageId);
    const ack = makeEnvelope({
      type: "MESSAGE_ACK", workspaceId: this._workspaceId, workerId: this._workerId,
      jobId: env.jobId, correlationId: env.correlationId,
      payload: { ackedMessageId: env.messageId, ackedType: env.type, status: "ACCEPTED", serverRevision: null, errorCode: null }
    });
    this._transport.sendToWorker(ack);
  }
}
