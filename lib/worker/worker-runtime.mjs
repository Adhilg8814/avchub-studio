// AVC Studio P0 Step 2 — in-memory WorkerRuntime.
//
// PURE / in-memory. No real child process, no provider calls, no fs. Receives
// JOB_OFFER / JOB_CANCEL_REQUEST from a JobTransport, validates via lib/protocol,
// runs a registered (fake, in Step 2) handler, and emits worker→cloud lifecycle
// events. Enforces the job state machine and protects paid-generation semantics
// by never running the same jobId's handler twice.
//
// Handler contract:
//   execute(input, context) -> result | { needsManualAction, reason, message }
//     context = { signal: AbortSignal, onProgress(evt), durationContext, jobId, input }
//   throws Error -> JOB_FAILED (message sanitized)
//   if context.signal.aborted -> JOB_CANCELED

import { makeEnvelope } from "../protocol/envelope.mjs";
import { assertTransition, isTerminalJobState } from "../protocol/job-states.mjs";
import { validateJobOffer, actionRequiredCapability, actionUsesDurationContext } from "../protocol/job-contracts.mjs";
import { PROTOCOL_ERRORS, protocolError } from "../protocol/errors.mjs";
import { InMemoryJobStore } from "./in-memory-job-store.mjs";
import { PROGRESS_PHASES } from "./progress-adapter.mjs";
import {
  classifyRecovery, classifyRecoveryContract, canAutoRetryGeneration, canRecoverWithoutNewGeneration,
  RECOVERY_STATES, RECOVERY_CONTRACT_STATES
} from "./recovery-classifier.mjs";

const NON_TERMINAL_ACTIVE = new Set(["DISPATCHED", "ACCEPTED", "RUNNING", "NEEDS_MANUAL_ACTION"]);
const PROGRESS_PHASE_SET = new Set(PROGRESS_PHASES);

export class WorkerRuntime {
  // `journal` (RecoveryJournal) and `pendingAck` (PendingAckStore) are OPTIONAL.
  // Without them the runtime is the pure in-memory Step 2 runtime; with them it
  // additionally persists per-job recovery state and outbound-ack durability.
  constructor({ transport, registry, workerId, capabilities = [], durationContext = undefined, journal = null, pendingAck = null } = {}) {
    if (!transport) throw new Error("WorkerRuntime requires a transport");
    if (!registry) throw new Error("WorkerRuntime requires a registry");
    if (!workerId) throw new Error("WorkerRuntime requires a workerId");
    this._transport = transport;
    this._registry = registry;
    this._workerId = workerId;
    this._capabilities = [...capabilities];
    this._capabilitySet = new Set(capabilities);
    this._durationContext = durationContext; // e.g. { supportedDurationsSec:[6,10,15], defaultDurationSec:10 }
    this._store = new InMemoryJobStore();
    this._journal = journal;       // durable recovery journal (or null → pure mode)
    this._pendingAck = pendingAck; // durable outbound-ack store (or null → pure mode)
    this._running = false;
    this._draining = false;
    this._unsub = null;
  }

  start() {
    if (this._running) return this; // idempotent
    this._running = true;
    this._draining = false;
    this._unsub = this._transport.subscribeWorker((env) => this.handleEnvelope(env));
    return this;
  }

  // stop(): HARD stop. Stop accepting offers AND cancel every active job (INTERRUPTED/
  // CANCELED). Use on shutdown-now / disconnect. Cancelled work is recoverable only if
  // it had already submitted (the journal keeps the quota-safety flag).
  stop() {
    if (!this._running && !this._draining) return this; // idempotent
    this._running = false;
    this._draining = false;
    if (this._unsub) { this._unsub(); this._unsub = null; }
    // Cancel/interrupt all active fake jobs cleanly.
    for (const job of this._store.list()) {
      if (NON_TERMINAL_ACTIVE.has(job.state)) {
        this._requestCancel(job);
        // If the handler already settled (e.g. manual-action), finalize now.
        if (!job.executing) this._finalizeCanceled(job);
      }
    }
    return this;
  }

  // drain(): GRACEFUL stop (recovery contract §8). Stop accepting NEW offers but let
  // in-flight jobs run to completion and persist normally — nothing is cancelled, no
  // paid generation is abandoned. The caller waits (e.g. on listActiveJobs()/whenIdle)
  // before finally calling stop(). Distinct from stop() precisely so a shutdown does not
  // interrupt a job that has already spent quota. Idempotent.
  drain() {
    if (!this._running) return this; // not running (or already draining) → no-op
    this._running = false;   // reject/ignore new offers
    this._draining = true;   // but keep active jobs alive
    if (this._unsub) { this._unsub(); this._unsub = null; }
    return this;
  }

  isRunning() { return this._running; }
  isDraining() { return this._draining; }
  // hasActiveJobs(): true while any job is still non-terminal (drain waits on this).
  hasActiveJobs() { return this._store.list().some((j) => NON_TERMINAL_ACTIVE.has(j.state)); }
  getCapabilities() { return [...this._capabilities]; }
  getJobState(jobId) { return this._store.get(jobId)?.state ?? null; }
  listActiveJobs() { return this._store.list().filter((j) => NON_TERMINAL_ACTIVE.has(j.state)).map((j) => j.jobId); }

  // Terminal-delivery status (CRIT-1): whether a committed terminal was published,
  // is deferred (persisted, awaiting reconnect/ack), failed to persist, or — in
  // pure mode only — could not be delivered at all. null if the job is unknown.
  getDeliveryStatus(jobId) {
    const job = this._store.get(jobId);
    if (!job) return null;
    return {
      deferred: job.deliveryDeferred === true,
      error: job.deliveryError ?? null,
      persistFailed: job.terminalPersistFailed === true,
      undelivered: job.terminalUndelivered === true
    };
  }

  // ---- inbound cloud→worker ----
  handleEnvelope(envelope) {
    switch (envelope.type) {
      case "JOB_OFFER": return this._onJobOffer(envelope);
      case "JOB_CANCEL_REQUEST": return this.cancelJob(envelope.jobId);
      case "MESSAGE_ACK": return this._onAck(envelope); // record only; never ack an ack
      default: return undefined; // ignore other control types in Step 2
    }
  }

  _onAck(envelope) {
    const job = this._store.get(envelope.jobId);
    if (job) job.lastAckMessageId = envelope.payload?.ackedMessageId ?? null;
    // Durable outbound-ack lifecycle: ACCEPTED → drop the persisted copy + mark the
    // journal acknowledged; REJECTED/VALIDATION_FAILED → moved to diagnostics by the
    // store. Persistence is removed ONLY after an ACCEPTED ack.
    if (this._pendingAck) {
      const res = this._pendingAck.onAck(envelope);
      if (res.accepted && this._journal && envelope.jobId) {
        try { this._journal.markAcknowledged(envelope.jobId); } catch { /* record may already be swept */ }
      }
    }
    // No re-emit: a MESSAGE_ACK never produces another message (no ACK loop).
  }

  _onJobOffer(offer) {
    const jobId = offer.jobId;
    const payload = offer.payload || {};
    const action = payload.action;

    // Duplicate offer handling (idempotent).
    const existing = this._store.get(jobId);
    if (existing) {
      if (isTerminalJobState(existing.state)) {
        // Re-emit the stored terminal envelope (same messageId → control dedupes).
        // A publish failure here is deferred delivery, never a state change.
        if (existing.terminalEnvelope) this._safePublish(existing, existing.terminalEnvelope);
        return;
      }
      // Active job: do NOT execute the handler again.
      return;
    }

    // Draining/stopped: accept NO new work (recovery contract §8). Existing jobs above
    // are still handled idempotently; only genuinely new offers are refused so the
    // cloud can re-route them elsewhere.
    if (!this._running) {
      this._rejectOffer(offer, PROTOCOL_ERRORS.E_WORKER_UNAVAILABLE, this._draining ? "worker draining" : "worker stopped");
      return;
    }

    // Capability check BEFORE any execution.
    const cap = actionRequiredCapability(action);
    if (cap && !this._capabilitySet.has(cap)) {
      this._rejectOffer(offer, PROTOCOL_ERRORS.E_CAPABILITY_UNAVAILABLE, `Capability "${cap}" unavailable`);
      return;
    }

    // Validate the whole JOB_OFFER payload (canonical shape: request identity at
    // payload level; `input` is action-specific business data only). Throws a
    // sanitized ProtocolError on failure.
    let normalizedPayload;
    try {
      normalizedPayload = validateJobOffer(payload, this._contextForAction(action));
    } catch (err) {
      this._rejectOffer(offer, err.code || PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, safeMessage(err));
      return;
    }
    const normalized = normalizedPayload.input;

    // Resolve handler.
    let handler;
    try {
      handler = this._registry.resolve(action);
    } catch (err) {
      this._rejectOffer(offer, err.code || PROTOCOL_ERRORS.E_UNKNOWN_ACTION, safeMessage(err));
      return;
    }

    // Handler-specific pre-execution validation (JobHandler.validate). A validation
    // failure is a PRE-acceptance rejection (JOB_REJECTED) — distinct from an
    // execute() throw (JOB_FAILED). No-op validators are backward-compatible.
    if (typeof handler.validate === "function") {
      try {
        handler.validate(normalized, this._contextForAction(action));
      } catch (err) {
        const isProtocol = err && typeof err.code === "string" && err.code.startsWith("E_");
        this._rejectOffer(offer, isProtocol ? err.code : PROTOCOL_ERRORS.E_INVALID_JOB_INPUT,
          isProtocol ? safeMessage(err) : "Handler validation failed");
        return;
      }
    }

    // Create job record; run lifecycle. Request identity lives on the record
    // (not in `input`) so the recovery journal can persist it in Part B.
    const job = this._store.create(jobId, {
      jobId, action, input: normalized, offer,
      requestIdempotencyKey: normalizedPayload.requestIdempotencyKey,
      generationAttemptId: normalizedPayload.generationAttemptId,
      parentAttemptId: normalizedPayload.parentAttemptId,
      retryOfJobId: normalizedPayload.retryOfJobId,
      acceptedBaseRevision: normalizedPayload.acceptedBaseRevision,
      quotaRisk: normalizedPayload.quotaRisk,
      workspaceId: offer.workspaceId, correlationId: offer.correlationId ?? null,
      state: "DISPATCHED", sequence: 0, abort: new AbortController(),
      cancelRequested: false, executing: false, terminalEnvelope: null,
      // Terminal-delivery bookkeeping (CRIT-1): a terminal that was durably
      // persisted but not yet published is "deferred", never a state change.
      deliveryDeferred: false, deliveryError: null,
      terminalPersistFailed: false, terminalUndelivered: false, postTerminalError: null
    });

    this._transition(job, "ACCEPTED");
    // Create the durable recovery record on accept. Request-identity + quota-risk
    // are persisted so recovery can reason about paid generations after a crash.
    if (this._journal) {
      // create() is idempotent: after a Control-Plane authorized recovery RE-OFFER of a PRE_SUBMIT
      // attempt, the SAME jobId's journal record still exists (localState RUNNING, ordinal 0). Continue
      // the runtime progress sequence from the record's last event so markProgress's strictly-increasing
      // invariant holds on the fresh (re-offered) execution — no reset needed (there is no submission
      // evidence to lose for a PRE_SUBMIT attempt, guaranteed by the CP re-offer gate).
      const rec = this._journal.create({
        jobId, action,
        requestIdempotencyKey: normalizedPayload.requestIdempotencyKey,
        generationAttemptId: normalizedPayload.generationAttemptId,
        parentAttemptId: normalizedPayload.parentAttemptId,
        retryOfJobId: normalizedPayload.retryOfJobId,
        acceptedBaseRevision: normalizedPayload.acceptedBaseRevision,
        quotaRisk: normalizedPayload.quotaRisk,
        workspaceId: offer.workspaceId,
        correlationId: offer.correlationId ?? null
      });
      if (rec && Number.isInteger(rec.lastEventSequence) && rec.lastEventSequence > job.sequence) job.sequence = rec.lastEventSequence;
    }
    this._emit(job, "JOB_ACCEPTED", { acceptedAt: nowIso() });
    this._transition(job, "RUNNING");
    if (this._journal) this._journal.markRunning(job.jobId); // RUNNING + startedAt
    this._emit(job, "JOB_STARTED", {});

    this._runHandler(job, handler);
  }

  _contextForAction(action) {
    // Generic: an action whose contract declares it uses duration context gets the
    // worker's supportedDurationsSec (so unsupported durations are rejected before
    // submission). The runtime does NOT compare provider/action strings itself.
    if (this._durationContext && actionUsesDurationContext(action)) {
      return { supportedDurationsSec: this._durationContext.supportedDurationsSec };
    }
    return undefined;
  }

  async _runHandler(job, handler) {
    job.executing = true;
    const context = {
      jobId: job.jobId,
      workerId: this._workerId,
      workspaceId: job.workspaceId,
      input: job.input,
      signal: job.abort.signal,
      durationContext: this._durationContext,
      // Request identity (payload-level, read-only) so a handler can echo it into
      // its normalized result without pulling it from the business input.
      generationAttemptId: job.generationAttemptId ?? null,
      requestIdempotencyKey: job.requestIdempotencyKey ?? null,
      onProgress: (evt) => this._onProgress(job, evt),
      // Recovery-contract barrier (Step 5.7a): a handler calls markSubmitting()
      // synchronously IMMEDIATELY BEFORE asking the provider to generate. This persists
      // SUBMITTING + generationOrdinal=1 with confidence UNKNOWN, so a crash in the
      // submit window recovers to a record that knows a paid generation may be in flight
      // and must be inspected — never blindly retried. Optional; the legacy one-step
      // path (markSubmittedToProvider alone) still books the generation.
      markSubmitting: (arg) => this._markSubmitting(job, arg),
      // Persist the quota-safety flag synchronously BEFORE the handler continues,
      // so a crash right after submission never leads to a second paid generation.
      markSubmittedToProvider: (arg) => this._markSubmitted(job, arg),
      // Additive Step 5C.9A wrappers over journal transitions that already exist.
      // They expose no new recovery state or wire contract: result availability is
      // persisted through markProgress(), and downloading uses markDownloading().
      markResultAvailable: (evt = {}) => this._markResultAvailable(job, evt),
      markDownloading: () => this._markDownloading(job),
      // Persist a downloaded/imported result as a relative ref + safe metadata only.
      markLocalResult: (resultRef, importedAssetId, resultMeta) => this._markLocalResult(job, resultRef, importedAssetId, resultMeta)
    };
    try {
      const result = await handler.execute(job.input, context);
      job.executing = false;
      if (job.cancelRequested || job.abort.signal.aborted) {
        this._finalizeCanceled(job);
        return;
      }
      if (result && result.needsManualAction) {
        this._transition(job, "NEEDS_MANUAL_ACTION");
        this._emit(job, "JOB_NEEDS_MANUAL_ACTION", {
          sequence: this._nextSeq(job),
          reason: safeString(result.reason || "MANUAL"),
          message: safeString(result.message || "Manual action required"),
          browserVisible: Boolean(result.browserVisible)
        });
        return; // stays active (non-terminal) until canceled or later resumed
      }
      // Success.
      this._transition(job, "SUCCEEDED");
      this._emitTerminal(job, "JOB_COMPLETED", {
        sequence: this._nextSeq(job),
        result: sanitizeResult(result && result.result !== undefined ? result.result : result)
      }, { code: null, error: null });
    } catch (err) {
      job.executing = false;
      // CRIT-1 guard: a terminal state is committed exactly once. If we are already
      // terminal, this error surfaced AFTER the terminal transition (a post-terminal
      // concern) — record it sanitized and return; NEVER attempt a second terminal
      // transition (which would be an illegal SUCCEEDED/CANCELED → FAILED move). With
      // the crash-safe _emitTerminal below this path is defense-in-depth.
      if (isTerminalJobState(job.state)) {
        job.postTerminalError = safeMessage(err);
        return;
      }
      if (job.cancelRequested || job.abort.signal.aborted) {
        this._finalizeCanceled(job);
        return;
      }
      // Only ProtocolErrors (designed sanitized) may surface their message. An
      // arbitrary handler Error could embed a secret/path, so it is replaced
      // with a generic message and never echoed.
      const isProtocol = err && typeof err.code === "string" && err.code.startsWith("E_");
      this._transition(job, "FAILED");
      this._emitTerminal(job, "JOB_FAILED", {
        sequence: this._nextSeq(job),
        errorCode: isProtocol ? err.code : "E_HANDLER_FAILED",
        errorMessage: isProtocol ? safeMessage(err) : "Handler failed"
      }, { code: isProtocol ? err.code : "E_HANDLER_FAILED", error: err });
    }
  }

  _onProgress(job, evt) {
    if (isTerminalJobState(job.state)) return; // ignore late progress
    let seq;
    if (evt && evt.sequence !== undefined) {
      if (!Number.isInteger(evt.sequence) || evt.sequence <= job.sequence) {
        throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Progress sequence must be increasing", { field: "sequence" });
      }
      seq = evt.sequence;
      job.sequence = seq;
    } else {
      seq = this._nextSeq(job);
    }
    let percent = evt && typeof evt.percent === "number" ? evt.percent : undefined;
    if (percent !== undefined) percent = Math.max(0, Math.min(100, percent));
    // Persist phase + last event sequence. Only known progress phases are recorded
    // as `phase`; an unknown/free-form phase still advances the sequence.
    if (this._journal) {
      const phaseArg = PROGRESS_PHASE_SET.has(evt?.phase) ? evt.phase : undefined;
      this._journal.markProgress(job.jobId, {
        phase: phaseArg,
        sequence: seq,
        percent,
        resultAvailable: evt?.resultAvailable === true
      });
    }
    this._emit(job, "JOB_PROGRESS", {
      sequence: seq,
      phase: safeString(evt?.phase || ""),
      label: safeString(evt?.label || ""),
      ...(percent !== undefined ? { percent } : {})
    });
  }

  // Persist submittedToProvider=true (quota-safety) synchronously. Accepts either a
  // bare providerSubmissionId string or a { providerSubmissionId, submittedAt, … }
  // object (real handlers pass the object; Step 4A fakes pass the string).
  _markSubmitted(job, arg) {
    job.submittedToProvider = true;
    // Pass the full arg through: journal.markSubmitted accepts a bare submissionId
    // string OR a { providerSubmissionId, submissionEvidence, submissionConfidence,
    // providerIdempotencyKey, idempotencySupport } object and records the evidence.
    if (this._journal) this._journal.markSubmitted(job.jobId, arg);
  }

  // Persist result-available evidence and emit the corresponding safe progress
  // event with the runtime's normal monotonic sequence handling.
  _markResultAvailable(job, evt = {}) {
    if (isTerminalJobState(job.state)) return;
    this._onProgress(job, { ...evt, resultAvailable: true });
  }

  // Persist the existing SUBMITTED -> DOWNLOADING transition. The handler emits
  // its own creator-safe progress separately so no provider detail is surfaced.
  _markDownloading(job) {
    if (this._journal) this._journal.markDownloading(job.jobId);
  }

  // Persist the SUBMITTING barrier BEFORE the provider call (recovery contract C3).
  // Accepts { providerIdempotencyKey, idempotencySupport }. Throws
  // E_DUPLICATE_GENERATION_ATTEMPT if this attempt already spent a generation.
  _markSubmitting(job, arg) {
    const opts = (arg && typeof arg === "object") ? arg : {};
    job.submitting = true;
    if (this._journal) this._journal.markSubmitting(job.jobId, opts);
  }

  // Persist a local/imported result (relative ref + safe metadata only).
  _markLocalResult(job, resultRef, importedAssetId, resultMeta) {
    job.localResultRef = resultRef;
    if (importedAssetId) job.importedAssetId = importedAssetId;
    if (this._journal) this._journal.markLocalResult(job.jobId, { localResultRef: resultRef, importedAssetId, resultMeta });
  }

  // ---- cancellation ----
  cancelJob(jobId) {
    const job = this._store.get(jobId);
    if (!job) return { ok: false, reason: "unknown-job" }; // safe, no throw
    if (isTerminalJobState(job.state)) return { ok: true, state: job.state }; // idempotent
    this._requestCancel(job);
    // If the handler is not currently executing (manual-action pause, or a job
    // still parked pre-run), finalize immediately. Otherwise _runHandler finalizes
    // when the aborted handler returns.
    if (!job.executing) this._finalizeCanceled(job);
    return { ok: true, state: job.state };
  }

  // Move an active job to CANCEL_REQUESTED (state machine requires this before
  // CANCELED — no direct RUNNING/NEEDS_MANUAL_ACTION → CANCELED) and signal abort.
  _requestCancel(job) {
    if (job.cancelRequested || isTerminalJobState(job.state)) return;
    job.cancelRequested = true;
    if (job.state !== "CANCEL_REQUESTED") this._transition(job, "CANCEL_REQUESTED");
    try { job.abort.abort(); } catch {}
  }

  _finalizeCanceled(job) {
    if (isTerminalJobState(job.state)) return; // already terminal (idempotent)
    if (job.state !== "CANCEL_REQUESTED") this._transition(job, "CANCEL_REQUESTED");
    this._transition(job, "CANCELED");
    this._emitTerminal(job, "JOB_CANCELED", {
      sequence: this._nextSeq(job),
      canceledAt: nowIso(),
      keptPartialFile: false
    }, { code: null, error: null });
  }

  // ---- helpers ----
  _rejectOffer(offer, errorCode, message) {
    // JOB_REJECTED does not need a stored job; build a one-off envelope.
    const env = makeEnvelope({
      type: "JOB_REJECTED", workspaceId: offer.workspaceId, workerId: this._workerId,
      jobId: offer.jobId, correlationId: offer.correlationId,
      payload: { errorCode, reason: safeString(message) }
    });
    this._transport.publishWorkerEvent(env);
  }

  _transition(job, to) {
    assertTransition(job.state, to);
    job.state = to;
  }

  _nextSeq(job) { job.sequence += 1; return job.sequence; }

  _emit(job, type, payload) {
    const env = makeEnvelope({
      type, workspaceId: job.workspaceId, workerId: this._workerId,
      jobId: job.jobId, correlationId: job.correlationId ?? undefined, payload
    });
    this._transport.publishWorkerEvent(env);
  }

  // Publish an already-built envelope without letting a transport failure escape.
  // A failed publish is recorded as DEFERRED delivery (the terminal already lives in
  // pending-ack/journal for replay on reconnect with the SAME messageId) — it never
  // flips the job state and never throws. Returns whether the publish succeeded.
  _safePublish(job, env) {
    try {
      this._transport.publishWorkerEvent(env);
      if (job) { job.deliveryDeferred = false; job.deliveryError = null; }
      return true;
    } catch (publishErr) {
      if (job) { job.deliveryDeferred = true; job.deliveryError = safeMessage(publishErr); }
      return false;
    }
  }

  // Crash-safe terminal delivery (CRIT-1). The caller has ALREADY transitioned the
  // job to its terminal state; this method persists then publishes and NEVER throws:
  //   (2) PERSIST before publish — journal terminal + pending-ack durability. If
  //       persistence fails, the durable journal stays PRE-terminal, so recovery
  //       re-drives the SAME result (submittedToProvider prevents re-generation);
  //       we do NOT publish an un-persisted terminal and do NOT re-transition.
  //   (3) PUBLISH after durable persistence. A publish failure (e.g. transport
  //       disconnected) is deferred delivery — the terminal is replayed later with
  //       the same messageId; it does NOT change SUCCEEDED→FAILED.
  _emitTerminal(job, type, payload, journalInfo = {}) {
    const env = makeEnvelope({
      type, workspaceId: job.workspaceId, workerId: this._workerId,
      jobId: job.jobId, correlationId: job.correlationId ?? undefined, payload
    });
    job.terminalEnvelope = env; // stored for idempotent duplicate-offer replay (same messageId)

    // (2) Persist BEFORE publishing.
    if (this._journal || this._pendingAck) {
      try {
        if (this._journal) {
          this._journal.markTerminal(job.jobId, {
            type, code: journalInfo.code ?? null, error: journalInfo.error ?? null, messageId: env.messageId
          });
        }
        if (this._pendingAck) {
          this._pendingAck.put(env);
          if (this._journal) this._journal.markAckPending(job.jobId, env.messageId);
        }
      } catch (persistErr) {
        // Durable persistence failed: keep the terminal recoverable via the journal's
        // pre-terminal state; do NOT publish and do NOT re-transition.
        job.terminalPersistFailed = true;
        job.deliveryDeferred = true;
        job.deliveryError = safeMessage(persistErr);
        return;
      }
    }

    // (3) Publish AFTER durable persistence (or immediately in pure mode).
    const published = this._safePublish(job, env);
    // In pure mode (no pending-ack) a failed publish cannot be replayed later.
    if (!published && !this._pendingAck) job.terminalUndelivered = true;
  }

  // recoverJobs(): read the durable journal and return structured recovery
  // candidates. It NEVER executes anything — in particular a job that was already
  // submitted to the provider is never auto-retried (that would double-charge).
  recoverJobs() {
    if (!this._journal) return { candidates: [], autoRetryable: [], recoverWithoutGeneration: [], manual: [], corrupt: [] };
    const candidates = this._journal.listRecoverable().map((rec) => ({
      jobId: rec.jobId,
      action: rec.action ?? null,
      recoveryState: classifyRecovery(rec),
      submittedToProvider: rec.submittedToProvider === true,
      canAutoRetryGeneration: canAutoRetryGeneration(rec),
      canRecoverWithoutNewGeneration: canRecoverWithoutNewGeneration(rec),
      corrupt: rec.corrupt === true
    }));
    return {
      candidates,
      // Hard guard: auto-retry ONLY when generation was never submitted.
      autoRetryable: candidates.filter((c) => c.canAutoRetryGeneration && !c.submittedToProvider),
      recoverWithoutGeneration: candidates.filter((c) => c.canRecoverWithoutNewGeneration),
      manual: candidates.filter((c) =>
        c.recoveryState === RECOVERY_STATES.MANUAL_ACTION_REQUIRED ||
        c.recoveryState === RECOVERY_STATES.UNKNOWN_NEEDS_OPERATOR),
      corrupt: candidates.filter((c) => c.corrupt)
    };
  }

  // resumeRecoverableTerminals(): P0 Step 5C.8B2 Checkpoint 6. On reconnect, promote each
  // IMPORTED/DOWNLOADED journal record (the provider ran exactly once and a local result was durably
  // committed, but the terminal was not emitted before the crash) to a durable TERMINAL_PENDING_ACK by
  // reconstructing ONE canonical JOB_COMPLETED from the journal and persisting it via markTerminal +
  // PendingAckStore. The EXISTING pending-ack replay + Control-Plane terminal settlement then completes
  // the job idempotently — with NO new provider invocation and NO regenerated media. Returns the jobIds
  // resumed. Idempotent: a record that already has a terminal (or lacks a durable relative result ref)
  // is skipped. Requires a journal + pendingAck (pure mode is a no-op).
  resumeRecoverableTerminals() {
    if (!this._journal || !this._pendingAck) return [];
    const resumed = [];
    for (const rec of this._journal.listRecoverable()) {
      const cs = classifyRecoveryContract(rec);
      if (cs !== RECOVERY_CONTRACT_STATES.IMPORTED && cs !== RECOVERY_CONTRACT_STATES.DOWNLOADED) continue;
      if (rec.terminal) continue;                    // already terminal → pending-ack path owns it
      if (!rec.localResultRef) continue;             // no durable relative result → leave for operator
      const meta = sanitizeResult(rec.resultMeta) || {};
      const asset = { assetId: rec.importedAssetId ?? null, relativePath: rec.localResultRef, ...meta };
      const env = makeEnvelope({
        type: "JOB_COMPLETED", workspaceId: rec.workspaceId, workerId: this._workerId, jobId: rec.jobId,
        correlationId: rec.correlationId ?? undefined,
        payload: { sequence: (Number.isInteger(rec.lastEventSequence) ? rec.lastEventSequence : 0) + 1, result: { asset, providerSubmissionId: rec.providerSubmissionId ?? null } }
      });
      try {
        this._journal.markTerminal(rec.jobId, { type: "JOB_COMPLETED", code: null, error: null, messageId: env.messageId });
        this._pendingAck.put(env);
        this._journal.markAckPending(rec.jobId, env.messageId);
        resumed.push(rec.jobId);
      } catch { /* markTerminal/put rejected (already terminal / illegal) → idempotent skip */ }
    }
    return resumed;
  }
}

// ---- sanitizers (never echo secret values) ----
function safeMessage(err) {
  const m = err && err.message ? String(err.message) : "handler error";
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}
function safeString(s) {
  const v = String(s ?? "");
  return v.length > 500 ? `${v.slice(0, 500)}…` : v;
}
// Shallow whitelist for result: keep only JSON-serializable plain data, drop
// functions/symbols; never include anything that looks like a secret key.
function sanitizeResult(result) {
  try {
    return JSON.parse(JSON.stringify(result ?? null));
  } catch {
    return null;
  }
}
function nowIso() { return new Date().toISOString(); }
