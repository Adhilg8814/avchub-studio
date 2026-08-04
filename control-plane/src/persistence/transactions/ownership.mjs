// P0 Step 5C.2 — paid-generation ownership transactions (the heart of Step 5C.2).
//
// GOLDEN RULE: at most one paid provider generation per generationAttemptId. Enforced by
//   (a) locking the generation_attempt row FOR UPDATE (serialization point),
//   (b) current-state predicates (never own an already-submitted/terminal/owned attempt),
//   (c) the partial-unique live-offer index (DB backstop),
//   (d) creating the JOB_OFFER outbox row in the SAME transaction (never SENT here).
//
// P0 Step 5C.3 refactor: every business transition is exposed BOTH as a public wrapper
// `f(adapter, args)` (opens its own tenantTransaction — used by Step 5C.2 + direct callers) AND
// as a client-taking core `fCore(client, args)` (runs on an already-open transaction client).
// The Step 5C.3 inbox service composes several cores inside ONE tenant transaction so that the
// inbox row, the business transition, and the durable ACK/response commit atomically — without
// nesting tenantTransaction (which is rejected) and WITHOUT duplicating this logic.

import { newId } from "../ids.mjs";
import { validateId } from "../../../../lib/protocol/ids.mjs";
import { getJobContract } from "../../../../lib/protocol/job-contracts.mjs";
import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";
import * as R from "../repositories/repositories.mjs";

// P0 Step 5C.8A — build the canonical generation JOB_OFFER payload from the DURABLE job +
// attempt rows. The offer carries `input` = an ALLOWLISTED snapshot of the exact job's stored
// business input, keyed by the action's protocol contract fields — NEVER the raw DB row, and
// NEVER reconstructed from mutable project defaults. Request identity (requestIdempotencyKey /
// generationAttemptId / lineage) lives at the payload level (canonical shape). The function is
// PURE + deterministic: same (job, attempt) → byte-equivalent payload, so once this payload is
// persisted in the outbox row the processor retry / worker reconnect replay the IDENTICAL offer
// (same messageId on the outbox row, same action, byte-equivalent input) with no refetch. The
// worker re-validates it via validateJobOffer, which re-applies assertNoDangerousFields.
export function buildGenerationOfferPayload(job, attempt) {
  const action = job.type;
  const contract = getJobContract(action);
  const raw = (job.input && typeof job.input === "object" && !Array.isArray(job.input)) ? job.input : {};
  const input = {};
  if (contract) {
    const allowed = new Set([...Object.keys(contract.required), ...Object.keys(contract.optional)]);
    // Preserve the durable stored value byte-for-byte for every contract-allowed field that is
    // present; silently drop anything else (defense-in-depth vs a raw/enriched row leaking in).
    for (const key of Object.keys(raw)) {
      if (allowed.has(key)) input[key] = raw[key];
    }
  }
  const payload = {
    action,
    requestIdempotencyKey: job.request_idempotency_key ?? null,
    generationAttemptId: (attempt && attempt.id) ? attempt.id : (job.generation_attempt_id ?? null),
    input
  };
  if (attempt && attempt.parent_attempt_id) payload.parentAttemptId = attempt.parent_attempt_id;
  if (attempt && attempt.retry_of_job_id) payload.retryOfJobId = attempt.retry_of_job_id;
  return payload;
}

const OWNED_STATES = new Set([
  "OFFERED", "ACCEPTED", "RUNNING", "SUBMITTING", "POSSIBLY_SUBMITTED", "SUBMITTED",
  "RECOVERING", "RESULT_AVAILABLE", "IMPORTED", "TERMINAL_PENDING_ACK",
  "COMPLETED", "FAILED", "CANCELED", "MANUAL_ACTION_REQUIRED"
]);

function assertWs(workspaceId) {
  if (!validateId(workspaceId, "ws")) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "invalid workspaceId");
}

// ------------------------------------------------------------- createGenerationRequest (§28)
// Atomic: one generation_request → one generation_attempt → one job. Same requestIdempotencyKey
// returns the ORIGINAL outcome (no second attempt). A retry uses a NEW key ⇒ new attempt.
export async function createGenerationRequestCore(client, args) {
  const { workspaceId, projectId, requestIdempotencyKey } = args;
  assertWs(workspaceId);
  if (!validateId(requestIdempotencyKey, "req")) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "invalid requestIdempotencyKey");
  const project = await R.projectRepository.get(client, workspaceId, projectId);
  if (!project) throw domainError(DOMAIN_ERRORS.E_PROJECT_NOT_FOUND, "Project not found");

  const requestId = newId("req");
  // Insert the request; ON CONFLICT (workspace_id, request_idempotency_key) DO NOTHING makes a
  // concurrent duplicate BLOCK on the unique tuple then return no row (idempotent).
  const ins = await client.query(
    `INSERT INTO generation_requests (id, workspace_id, project_id, shot_id, created_by_user_id, action, request_idempotency_key, input_snapshot, quota_risk)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, request_idempotency_key) DO NOTHING RETURNING *`,
    [requestId, workspaceId, projectId, args.shotId ?? null, args.createdByUserId ?? null, args.action, requestIdempotencyKey, JSON.stringify(args.inputSnapshot ?? {}), args.quotaRisk ?? false]);

  if (ins.rowCount === 0) {
    // Duplicate click: return the ORIGINAL request/attempt/job.
    const existing = await R.generationRequestRepository.findByIdemKey(client, workspaceId, requestIdempotencyKey);
    const attempt = existing ? (await client.query("SELECT * FROM generation_attempts WHERE workspace_id=$1 AND generation_request_id=$2", [workspaceId, existing.id])).rows[0] : null;
    const job = attempt ? await R.jobRepository.getByAttempt(client, workspaceId, attempt.id) : null;
    return { request: existing, attempt, job, duplicate: true };
  }

  const request = ins.rows[0];
  const attemptId = newId("attempt");
  const attempt = await R.generationAttemptRepository.create(client, workspaceId, {
    attemptId, generationRequestId: request.id, requestIdempotencyKey,
    parentAttemptId: args.parentAttemptId ?? null, retryOfJobId: args.retryOfJobId ?? null,
    attemptIndex: args.attemptIndex ?? 0, providerId: args.providerId ?? null, providerAccountRef: args.providerAccountRef ?? null
  });
  const jobId = newId("job");
  const job = await R.jobRepository.create(client, workspaceId, {
    jobId, projectId, shotId: args.shotId ?? null, generationAttemptId: attempt.id,
    createdByUserId: args.createdByUserId ?? null, type: args.action,
    requestIdempotencyKey, input: args.inputSnapshot ?? {}, quotaRisk: args.quotaRisk ?? false
  });
  if (args.audit) await R.auditRepository.record(client, { workspaceId, actorType: "USER", actorId: args.createdByUserId ?? null, action: "generation_request.create", targetType: "attempt", targetId: attempt.id });
  return { request, attempt, job, duplicate: false };
}

export async function createGenerationRequest(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => createGenerationRequestCore(client, args));
}

// ------------------------------------------------------------- claimGenerationAttemptForWorker (§30)
export async function claimGenerationAttemptForWorkerCore(client, args) {
  const { workspaceId, attemptId, workerId } = args;
  assertWs(workspaceId);
  const attempt = await R.generationAttemptRepository.lock(client, workspaceId, attemptId);       // FOR UPDATE
  if (!attempt) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "attempt not found");
  if (attempt.terminal_state) throw domainError(DOMAIN_ERRORS.E_ATTEMPT_TERMINAL, "Attempt already terminal");
  if (attempt.submission_state !== "NOT_SUBMITTED" || attempt.possibly_submitted) throw domainError(DOMAIN_ERRORS.E_ATTEMPT_POSSIBLY_SUBMITTED, "Attempt may be submitted");
  if (OWNED_STATES.has(attempt.ownership_status)) throw domainError(DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED, "Attempt already owned");

  if (!(await R.workerRepository.belongsToWorkspace(client, workspaceId, workerId))) throw domainError(DOMAIN_ERRORS.E_WORKER_NOT_FOUND, "Worker not in workspace");

  // Reconcile barrier: refuse a new offer while the worker's reconcile is open (§36).
  const session = await R.workerRepository.activeSession(client, workspaceId, workerId);
  if (session && session.reconcile_barrier_open) throw domainError(DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED, "Worker reconcile in progress");

  const job = await R.jobRepository.getByAttempt(client, workspaceId, attemptId);
  if (!job) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "job for attempt not found");

  // Project affinity: if an ACTIVE affinity exists it must be this worker.
  if (job.project_id) {
    const aff = (await client.query("SELECT worker_id FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'", [workspaceId, job.project_id])).rows[0];
    if (aff && aff.worker_id !== workerId) throw domainError(DOMAIN_ERRORS.E_AFFINITY_CONFLICT, "Project assigned to another worker");
  }

  // A live offer already exists (backstop; the row lock usually catches this first).
  const live = await R.jobOfferRepository.liveForAttempt(client, workspaceId, attemptId);
  if (live) throw domainError(DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED, "Attempt already has a live offer");

  // One-shot paid approval (consumed in THIS txn; rollback un-consumes it).
  let approvalGrantId = null;
  if (args.requireApproval) {
    approvalGrantId = await R.featureFlagRepository.consumeApprovalGrant(client, workspaceId, {
      attemptId,
      projectId: job.project_id ?? null
    });
    if (!approvalGrantId) throw domainError(DOMAIN_ERRORS.E_PAID_APPROVAL_REQUIRED, "Paid approval required");
  }

  const offerId = newId("off");
  const offerMessageId = newId("msg");
  const now = Date.now();
  const offer = await R.jobOfferRepository.create(client, workspaceId, {
    offerId, jobId: job.id, generationAttemptId: attemptId, assignedWorkerId: workerId, projectId: job.project_id,
    offerMessageId, ownershipStatus: "OFFERED",
    offerExpiresAt: new Date(now + (args.offerTtlMs ?? 60000)).toISOString(),
    leaseExpiresAt: new Date(now + (args.leaseTtlMs ?? 300000)).toISOString()
  });
  await R.generationAttemptRepository.setOwnership(client, workspaceId, attemptId, { ownershipStatus: "OFFERED", assignedWorkerId: workerId });
  await R.jobRepository.setStatus(client, workspaceId, job.id, "DISPATCHED", { workerId });

  // JOB_OFFER outbox row — same transaction, delivery_state PENDING, settlement LIFECYCLE_RESPONSE.
  const outbox = await R.protocolRepository.createOutbox(client, workspaceId, {
    messageId: offerMessageId, workerId, jobId: job.id, generationAttemptId: attemptId,
    type: "JOB_OFFER", settlementMode: "LIFECYCLE_RESPONSE",
    expectedResponseTypes: ["JOB_ACCEPTED", "JOB_REJECTED"], orderingKey: `${workerId}:${job.id}`,
    // Canonical generation offer: { action, requestIdempotencyKey, generationAttemptId, input }
    // built once from the durable job/attempt (Step 5C.8A). Stored immutably in the outbox row so
    // every redelivery/reconnect replays byte-equivalent input without re-reading mutable state.
    payload: buildGenerationOfferPayload(job, attempt)
  });
  return { offer, outbox, attemptId, workerId, approvalGrantId };
}

export async function claimGenerationAttemptForWorker(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => claimGenerationAttemptForWorkerCore(client, args), { retrySerialization: args.retrySerialization ?? 0 });
}

// ------------------------------------------------------------- safe re-offer (§31)
// Re-offer ONLY when provable the previous offer was never delivered (outbox never SENT).
export async function safeReoffer(adapter, args) {
  const { workspaceId, attemptId, workerId } = args;
  assertWs(workspaceId);
  // The quarantine transition (below) and the caller-facing E_OFFER_NOT_SAFE_TO_RETRY must NOT
  // share a transaction: writing RECOVERING and then throwing in the same txn rolls the write
  // back (the attempt would stay OFFERED with no durable reconcile signal). So the txn COMMITS
  // its decision and returns a discriminator; we translate "recovering" into the thrown error
  // AFTER the commit — preserving the caller contract while persisting the quarantine.
  const outcome = await adapter.tenantTransaction(workspaceId, async (client) => {
    const attempt = await R.generationAttemptRepository.lock(client, workspaceId, attemptId);
    if (!attempt) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "attempt not found");
    if (attempt.terminal_state) throw domainError(DOMAIN_ERRORS.E_ATTEMPT_TERMINAL, "Attempt terminal");
    if (attempt.possibly_submitted || attempt.submission_state !== "NOT_SUBMITTED" || attempt.generation_ordinal !== 0) {
      throw domainError(DOMAIN_ERRORS.E_OFFER_NOT_SAFE_TO_RETRY, "Attempt may be submitted");
    }
    const live = await R.jobOfferRepository.liveForAttempt(client, workspaceId, attemptId);
    if (!live) throw domainError(DOMAIN_ERRORS.E_OFFER_NOT_SAFE_TO_RETRY, "No prior live offer");
    if (live.accepted_at) throw domainError(DOMAIN_ERRORS.E_OFFER_NOT_SAFE_TO_RETRY, "Prior offer was accepted");

    // The proof: the prior offer's outbox row must still be PENDING (never SENT) and NOT flagged
    // delivery_uncertain. If it was ever SENT/uncertain (or is missing), we cannot prove
    // non-delivery → RECOVERING, not re-offer.
    const ob = (await client.query("SELECT delivery_state, delivery_uncertain FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [workspaceId, live.offer_message_id])).rows[0];
    if (!ob || ob.delivery_state !== "PENDING" || ob.delivery_uncertain === true) {
      await R.jobOfferRepository.setStatus(client, workspaceId, live.id, "RECOVERING", { reconcileRequired: true, possiblySubmitted: true });
      await R.generationAttemptRepository.setOwnership(client, workspaceId, attemptId, { ownershipStatus: "RECOVERING", assignedWorkerId: attempt.assigned_worker_id });
      return { recovering: true };   // COMMIT the quarantine, then signal the caller below.
    }
    // Retire the old offer (provably not delivered), dead-letter its outbox row, and RESET the
    // attempt's ownership to CREATED so the in-transaction re-claim can mint a fresh offer
    // (otherwise the re-claim would see ownership_status='OFFERED' and reject as already-owned).
    await R.jobOfferRepository.setStatus(client, workspaceId, live.id, "EXPIRED_PRE_SUBMIT", {});
    await client.query("UPDATE protocol_outbox SET delivery_state='DEAD', dead_letter_reason='reoffer_undelivered', dead_letter_code='REOFFER_UNDELIVERED' WHERE workspace_id=$1 AND message_id=$2", [workspaceId, live.offer_message_id]);
    await R.generationAttemptRepository.setOwnership(client, workspaceId, attemptId, { ownershipStatus: "CREATED", assignedWorkerId: null });
    const claim = await claimGenerationAttemptForWorkerCore(client, { workspaceId, attemptId, workerId, offerTtlMs: args.offerTtlMs, leaseTtlMs: args.leaseTtlMs });
    return { recovering: false, claim };
  });
  if (outcome.recovering) throw domainError(DOMAIN_ERRORS.E_OFFER_NOT_SAFE_TO_RETRY, "Prior offer was delivered; reconcile required");
  return outcome.claim;
}

// ------------------------------------------------------------- offer expiry (§7 / §12.1)
// Handle expiry of ONE specific offer, keyed by offerId (not by attempt) so two racing expiry
// processors produce EXACTLY ONE replacement: each locks the same offer row; the winner retires
// it (→ EXPIRED_PRE_SUBMIT) and the loser then reads it as not-live and skips. Case A (provably
// never delivered) re-mints one fresh offer atomically; Case B (SENT/uncertain/possibly-submitted)
// quarantines to RECOVERING and never re-offers.
export async function expireOfferCore(client, { workspaceId, offerId, nowMs = null }) {
  assertWs(workspaceId);
  const offer = (await client.query("SELECT * FROM job_offers WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, offerId])).rows[0];
  if (!offer) return { skipped: true, reason: "not_found" };
  if (offer.ownership_status !== "OFFERED" || offer.accepted_at) return { skipped: true, reason: "not_live" };
  if (nowMs != null && new Date(offer.offer_expires_at).getTime() > nowMs) return { skipped: true, reason: "not_expired" };

  const attemptId = offer.generation_attempt_id;
  const workerId = offer.assigned_worker_id;
  const attempt = await R.generationAttemptRepository.lock(client, workspaceId, attemptId);
  if (!attempt) return { skipped: true, reason: "no_attempt" };

  const unsafeAttempt = Boolean(attempt.terminal_state) || attempt.possibly_submitted || attempt.submission_state !== "NOT_SUBMITTED" || attempt.generation_ordinal !== 0;
  const ob = (await client.query("SELECT delivery_state, delivery_uncertain FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [workspaceId, offer.offer_message_id])).rows[0];
  const provablyNotDelivered = Boolean(ob) && ob.delivery_state === "PENDING" && ob.delivery_uncertain !== true;

  if (unsafeAttempt || !provablyNotDelivered) {
    // Case B — cannot prove non-delivery (SENT/uncertain) or the attempt may be submitted:
    // quarantine to RECOVERING; NEVER re-offer (no duplicate paid generation).
    await R.jobOfferRepository.setStatus(client, workspaceId, offer.id, "RECOVERING", { reconcileRequired: true, possiblySubmitted: true });
    await R.generationAttemptRepository.setOwnership(client, workspaceId, attemptId, { ownershipStatus: "RECOVERING", assignedWorkerId: attempt.assigned_worker_id });
    return { recovering: true };
  }
  // Case A — provably never delivered: retire this offer, dead-letter its outbox, reset ownership,
  // and re-mint exactly ONE fresh offer/outbox in the same transaction.
  await R.jobOfferRepository.setStatus(client, workspaceId, offer.id, "EXPIRED_PRE_SUBMIT", {});
  await client.query("UPDATE protocol_outbox SET delivery_state='DEAD', dead_letter_reason='offer_expired_undelivered', dead_letter_code='OFFER_EXPIRED_PRE_SUBMIT' WHERE workspace_id=$1 AND message_id=$2", [workspaceId, offer.offer_message_id]);
  await R.generationAttemptRepository.setOwnership(client, workspaceId, attemptId, { ownershipStatus: "CREATED", assignedWorkerId: null });
  const claim = await claimGenerationAttemptForWorkerCore(client, { workspaceId, attemptId, workerId });
  return { reoffered: true, claim };
}
export async function handleOfferExpiry(adapter, { workspaceId, offerId, nowMs = null }) {
  assertWs(workspaceId);
  return adapter.tenantTransaction(workspaceId, (client) => expireOfferCore(client, { workspaceId, offerId, nowMs }));
}

// ------------------------------------------------------------- submission fact (§33)
export async function applySubmissionFactCore(client, args) {
  const { workspaceId, attemptId, workerId, state } = args;   // state: 'SUBMITTING' | 'SUBMITTED'
  assertWs(workspaceId);
  if (!["SUBMITTING", "SUBMITTED"].includes(state)) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "state must be SUBMITTING|SUBMITTED");
  const attempt = await R.generationAttemptRepository.lock(client, workspaceId, attemptId);
  if (!attempt) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "attempt not found");
  if (attempt.assigned_worker_id && attempt.assigned_worker_id !== workerId) throw domainError(DOMAIN_ERRORS.E_IDENTITY_MISMATCH, "Not the producing worker");
  if (attempt.terminal_state) throw domainError(DOMAIN_ERRORS.E_ATTEMPT_TERMINAL, "Attempt terminal");

  // Idempotent ordinal: booked ONLY on NOT_SUBMITTED → (SUBMITTING|SUBMITTED).
  const r = await client.query(
    `UPDATE generation_attempts
       SET generation_ordinal = 1, submission_state = $3, possibly_submitted = true,
           submission_confidence = COALESCE($4, submission_confidence),
           provider_submission_id = COALESCE($5, provider_submission_id),
           submitted_at = now(), ownership_status = $3
     WHERE workspace_id = $1 AND id = $2 AND submission_state = 'NOT_SUBMITTED' RETURNING *`,
    [workspaceId, attemptId, state, args.confidence ?? null, args.providerSubmissionId ?? null]);
  if (r.rowCount === 1) return { attempt: r.rows[0], booked: true };

  // Already submitting/submitted → idempotent. Advance SUBMITTING→SUBMITTED without re-booking.
  if (attempt.submission_state === "SUBMITTING" && state === "SUBMITTED") {
    const up = await client.query(
      `UPDATE generation_attempts SET submission_state='SUBMITTED', ownership_status='SUBMITTED',
         provider_submission_id = COALESCE($3, provider_submission_id), submission_confidence = COALESCE($4, submission_confidence)
       WHERE workspace_id=$1 AND id=$2 RETURNING *`, [workspaceId, attemptId, args.providerSubmissionId ?? null, args.confidence ?? null]);
    return { attempt: up.rows[0], booked: false };
  }
  return { attempt, booked: false, idempotent: true };
}

export async function applySubmissionFact(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => applySubmissionFactCore(client, args));
}

// ------------------------------------------------------------- terminal application (§34)
export async function applyTerminalCore(client, args) {
  const { workspaceId, jobId, workerId, terminalType, terminalMessageId } = args;
  assertWs(workspaceId);
  const attemptTerminal = { JOB_COMPLETED: "COMPLETED", JOB_FAILED: "FAILED", JOB_CANCELED: "CANCELED" }[terminalType];
  const jobStatus = { JOB_COMPLETED: "SUCCEEDED", JOB_FAILED: "FAILED", JOB_CANCELED: "CANCELED" }[terminalType];
  if (!attemptTerminal) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "invalid terminalType");
  if (!validateId(terminalMessageId, "msg")) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "invalid terminalMessageId");
  const job = await R.jobRepository.lock(client, workspaceId, jobId);
  if (!job) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "job not found");
  const attempt = job.generation_attempt_id ? await R.generationAttemptRepository.lock(client, workspaceId, job.generation_attempt_id) : null;
  // Producing-worker verification (facts accepted from the recorded producing worker).
  const producing = attempt ? attempt.assigned_worker_id : job.worker_id;
  if (producing && workerId && producing !== workerId) throw domainError(DOMAIN_ERRORS.E_IDENTITY_MISMATCH, "Not the producing worker");

  const existing = await R.terminalResultRepository.get(client, workspaceId, jobId);
  if (existing) {
    if (existing.terminal_message_id === terminalMessageId) return { result: existing, duplicate: true };  // idempotent cached
    throw domainError(DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION, "Conflicting terminal");
  }

  const result = await R.terminalResultRepository.create(client, workspaceId, {
    jobId, terminalType, terminalMessageId, result: args.result ?? null, errorCode: args.errorCode ?? null
  });
  await R.jobRepository.setStatus(client, workspaceId, jobId, jobStatus, { finishedAt: new Date().toISOString() });
  if (attempt) {
    await client.query("UPDATE generation_attempts SET terminal_state=$3, ownership_status=$3 WHERE workspace_id=$1 AND id=$2", [workspaceId, attempt.id, attemptTerminal]);
  }
  let asset = null;
  // Terminal application MAY record one result asset (safe metadata only). Default the ownership
  // fields (project / producing worker) from the job/attempt so callers pass only media descriptors;
  // explicit assetMeta values still win. upsertSafe re-validates that the path is relative and no
  // provider URL is present, so an unsafe descriptor can never be persisted here.
  if (args.assetMeta) asset = await R.assetRepository.upsertSafe(client, workspaceId, {
    projectId: job.project_id, producingWorkerId: (producing ?? workerId ?? null),
    ...args.assetMeta, generationAttemptId: attempt?.id ?? null
  });
  return { result, asset, duplicate: false };
}

export async function applyTerminal(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => applyTerminalCore(client, args));
}

// ------------------------------------------------------------- cancel (§35)
export async function applyCancelCore(client, args) {
  const { workspaceId, jobId } = args;
  assertWs(workspaceId);
  const job = await R.jobRepository.lock(client, workspaceId, jobId);
  if (!job) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "job not found");
  if (["SUCCEEDED", "FAILED", "CANCELED", "EXPIRED"].includes(job.status)) return { job, idempotent: true }; // terminal: no-op
  const attempt = job.generation_attempt_id ? await R.generationAttemptRepository.get(client, workspaceId, job.generation_attempt_id) : null;
  // Cancellation after submission preserves paid-ownership evidence (never clears submission).
  const possiblySubmitted = attempt ? (attempt.possibly_submitted || attempt.submission_state !== "NOT_SUBMITTED") : false;
  await client.query("UPDATE jobs SET cancel_requested = true, status = 'CANCEL_REQUESTED' WHERE workspace_id=$1 AND id=$2", [workspaceId, jobId]);
  return { job: await R.jobRepository.get(client, workspaceId, jobId), possiblySubmitted, attempt };
}

export async function applyCancel(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => applyCancelCore(client, args));
}

// ------------------------------------------------------------- project affinity (§29)
export async function assignProjectAffinity(adapter, args) {
  const { workspaceId, projectId, workerId } = args;
  assertWs(workspaceId);
  return adapter.tenantTransaction(workspaceId, async (client) => {
    const project = await R.projectRepository.get(client, workspaceId, projectId);
    if (!project) throw domainError(DOMAIN_ERRORS.E_PROJECT_NOT_FOUND, "Project not found");
    if (!(await R.workerRepository.belongsToWorkspace(client, workspaceId, workerId))) throw domainError(DOMAIN_ERRORS.E_WORKER_NOT_FOUND, "Worker not in workspace");

    // Lock the current ACTIVE affinity (if any).
    const current = (await client.query("SELECT * FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE' FOR UPDATE", [workspaceId, projectId])).rows[0];
    if (current) {
      if (current.worker_id === workerId) return { affinity: current, unchanged: true };
      // Migration: block while any attempt for the project is unresolved or TERMINAL_PENDING_ACK.
      const unresolved = (await client.query(
        `SELECT 1 FROM generation_attempts a JOIN generation_requests r ON r.id=a.generation_request_id AND r.workspace_id=a.workspace_id
          WHERE r.workspace_id=$1 AND r.project_id=$2
            AND (a.terminal_state IS NULL OR a.possibly_submitted OR a.ownership_status='TERMINAL_PENDING_ACK') LIMIT 1`, [workspaceId, projectId])).rows[0];
      if (unresolved) throw domainError(DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED, "Unresolved attempts block migration");
      if (typeof args.expectedGeneration === "number" && current.generation !== args.expectedGeneration) throw domainError(DOMAIN_ERRORS.E_AFFINITY_CONFLICT, "Affinity generation conflict");
      // NOTE (P0 Step 5C.31): this statement previously bound four parameters but referenced only $1/$3/$4,
      // leaving $2 with no site - PostgreSQL cannot infer its type and rejects the whole statement with
      // SQLSTATE 42P18. The migration branch therefore never worked; it was simply never exercised, because
      // until remote delivery existed every caller re-assigned affinity to the SAME worker, which takes the
      // "unchanged" early return above. Parameters are now positional and complete.
      await client.query("UPDATE project_worker_affinity SET status='RELEASED', released_at=now(), release_reason=$2 WHERE id=$1 AND workspace_id=$3", [current.id, args.releaseReason ?? "migration", workspaceId]);
    }
    const affId = newId("aff");
    const nextGen = (current?.generation ?? -1) + 1;
    const affinity = (await client.query(
      `INSERT INTO project_worker_affinity (id, workspace_id, project_id, worker_id, assigned_by, status, generation)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6) RETURNING *`,
      [affId, workspaceId, projectId, workerId, args.assignedBy ?? null, nextGen])).rows[0];
    await client.query("UPDATE projects SET home_worker_id=$3, revision=revision+1 WHERE workspace_id=$1 AND id=$2", [workspaceId, projectId, workerId]);
    return { affinity, migrated: Boolean(current) };
  });
}

// ------------------------------------------------------------- reconcile barrier (§36)
export async function openReconcileBarrierCore(client, { workspaceId, workerId }) {
  assertWs(workspaceId);
  await client.query("UPDATE worker_connection_sessions SET reconcile_barrier_open=true, reconcile_barrier_opened_at=now() WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, workerId]);
  return { open: true };
}
export async function openReconcileBarrier(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => openReconcileBarrierCore(client, args));
}
// closeReconcileBarrierCore: closing ONLY on the last batch. `expectedEpoch` (optional) enforces
// that a STALE reconcile batch (an epoch older than the session's current one) cannot release a
// NEWER barrier — the epoch must match. Closing bumps reconcile_epoch so the next reconcile is a
// fresh epoch. Returns { closed } reflecting whether a row was actually released.
export async function closeReconcileBarrierCore(client, { workspaceId, workerId, isLast, expectedEpoch = null }) {
  assertWs(workspaceId);
  if (!isLast) return { closed: false };
  const r = await client.query(
    `UPDATE worker_connection_sessions
       SET reconcile_barrier_open=false, reconcile_barrier_opened_at=NULL, reconcile_epoch=reconcile_epoch+1
     WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'
       AND ($3::int IS NULL OR reconcile_epoch = $3)`,
    [workspaceId, workerId, expectedEpoch]);
  return { closed: r.rowCount === 1 };
}
export async function closeReconcileBarrier(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => closeReconcileBarrierCore(client, args));
}

// ------------------------------------------------------------- worker lifecycle events (§32)
export async function applyWorkerEventCore(client, args) {
  const { workspaceId, jobId, workerId, event } = args;  // event: JOB_ACCEPTED|JOB_REJECTED|JOB_STARTED|JOB_NEEDS_MANUAL_ACTION
  assertWs(workspaceId);
  const job = await R.jobRepository.lock(client, workspaceId, jobId);
  if (!job) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "job not found");
  if (job.worker_id && workerId && job.worker_id !== workerId) throw domainError(DOMAIN_ERRORS.E_IDENTITY_MISMATCH, "Not the assigned worker");
  const attempt = job.generation_attempt_id ? await R.generationAttemptRepository.lock(client, workspaceId, job.generation_attempt_id) : null;
  const now = new Date().toISOString();
  if (event === "JOB_ACCEPTED") {
    await R.jobRepository.setStatus(client, workspaceId, jobId, "ACCEPTED", { acceptedAt: now, workerId });
    if (attempt) await R.generationAttemptRepository.setOwnership(client, workspaceId, attempt.id, { ownershipStatus: "ACCEPTED", assignedWorkerId: attempt.assigned_worker_id });
  } else if (event === "JOB_REJECTED") {
    await R.jobRepository.setStatus(client, workspaceId, jobId, "QUEUED", {});
    const live = attempt ? await R.jobOfferRepository.liveForAttempt(client, workspaceId, attempt.id) : null;
    if (live) await R.jobOfferRepository.setStatus(client, workspaceId, live.id, "OFFER_REJECTED", {});
    if (attempt) await R.generationAttemptRepository.setOwnership(client, workspaceId, attempt.id, { ownershipStatus: "CREATED", assignedWorkerId: null });
  } else if (event === "JOB_STARTED") {
    await R.jobRepository.setStatus(client, workspaceId, jobId, "RUNNING", { startedAt: now, workerId });
    if (attempt && attempt.ownership_status === "ACCEPTED") await R.generationAttemptRepository.setOwnership(client, workspaceId, attempt.id, { ownershipStatus: "RUNNING", assignedWorkerId: attempt.assigned_worker_id });
  } else if (event === "JOB_NEEDS_MANUAL_ACTION") {
    await R.jobRepository.setStatus(client, workspaceId, jobId, "NEEDS_MANUAL_ACTION", {});
    if (attempt) await R.generationAttemptRepository.setOwnership(client, workspaceId, attempt.id, { ownershipStatus: "MANUAL_ACTION_REQUIRED", assignedWorkerId: attempt.assigned_worker_id });
  } else {
    throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "unknown worker event");
  }
  return { job: await R.jobRepository.get(client, workspaceId, jobId) };
}

export async function applyWorkerEvent(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => applyWorkerEventCore(client, args));
}

// ------------------------------------------------------------- recovery-gated safe re-offer (§C6)
// P0 Step 5C.8B2 Checkpoint 6 — authorize ONE re-offer of a PRE_SUBMIT attempt driven by a validated
// Worker recovery report, EVEN AFTER the prior offer was accepted, but ONLY when every piece of durable
// evidence proves the provider was never invoked. This does NOT relax safeReoffer for ordinary accepted
// offers — it is a separate, fully-guarded path. Runs inside the inbox transaction (RLS + authenticated
// worker + fencing already applied upstream). Idempotent: if a recovery re-offer is already pending
// (an unaccepted live offer) it is a no-op; repeated recovery reports never mint more than one re-offer.
export async function recoveryReofferForAttemptCore(client, args) {
  const { workspaceId, attemptId, workerId } = args;
  assertWs(workspaceId);
  const attempt = await R.generationAttemptRepository.lock(client, workspaceId, attemptId);   // FOR UPDATE (serialization)
  if (!attempt) return { reoffered: false, reason: "attempt_not_found" };
  // FULL proven-PRE_SUBMIT gate from Control-Plane durable evidence — any doubt → refuse.
  if (attempt.terminal_state) return { reoffered: false, reason: "terminal" };
  if (attempt.assigned_worker_id && attempt.assigned_worker_id !== workerId) return { reoffered: false, reason: "not_producing_worker" };
  if (attempt.possibly_submitted || attempt.submission_state !== "NOT_SUBMITTED" || attempt.generation_ordinal !== 0) return { reoffered: false, reason: "may_be_submitted" };
  const job = await R.jobRepository.getByAttempt(client, workspaceId, attemptId);
  if (!job) return { reoffered: false, reason: "job_not_found" };
  if (await R.terminalResultRepository.get(client, workspaceId, job.id)) return { reoffered: false, reason: "terminal_result_exists" };
  if ((await client.query("SELECT 1 FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2 LIMIT 1", [workspaceId, attemptId])).rows[0]) return { reoffered: false, reason: "asset_exists" };
  const session = await R.workerRepository.activeSession(client, workspaceId, workerId);
  if (session && session.reconcile_barrier_open) return { reoffered: false, reason: "reconcile_barrier_open" };

  // Idempotency: AT MOST ONE recovery re-offer per attempt. The first re-offer retires the original
  // offer (→ EXPIRED_PRE_SUBMIT); once any retired offer exists for this attempt, a re-offer already
  // ran (its fresh offer is live and the worker will run it) → no-op. (JOB_ACCEPTED does not set the
  // offer's accepted_at, so a retired-marker is the reliable idempotency signal.)
  const retired = (await client.query("SELECT count(*)::int AS n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status='EXPIRED_PRE_SUBMIT'", [workspaceId, attemptId])).rows[0].n;
  if (retired > 0) return { reoffered: false, reason: "already_reoffered" };
  const live = await R.jobOfferRepository.liveForAttempt(client, workspaceId, attemptId);      // FOR UPDATE
  // Retire the prior offer as AUDIT evidence (EXPIRED_PRE_SUBMIT → no longer live; the outbox
  // row + job_offers row remain for audit), reset ownership, and mint ONE fresh recovery offer with a NEW
  // messageId built from the DURABLE job/attempt (same immutable normalized input, same GENERATE_VIDEO
  // action, same jobId + generationAttemptId — no new request, no reconstruction from project defaults).
  if (live) await R.jobOfferRepository.setStatus(client, workspaceId, live.id, "EXPIRED_PRE_SUBMIT", {});
  await R.generationAttemptRepository.setOwnership(client, workspaceId, attemptId, { ownershipStatus: "CREATED", assignedWorkerId: null });
  await R.jobRepository.setStatus(client, workspaceId, job.id, "QUEUED", {});
  const claim = await claimGenerationAttemptForWorkerCore(client, { workspaceId, attemptId, workerId, offerTtlMs: args.offerTtlMs, leaseTtlMs: args.leaseTtlMs });
  return { reoffered: true, claim, priorOfferMessageId: live?.offer_message_id ?? null, newOfferMessageId: claim.offer?.offer_message_id ?? claim.outbox?.message_id ?? null };
}

export async function recoveryReofferForAttempt(adapter, args) {
  assertWs(args.workspaceId);
  return adapter.tenantTransaction(args.workspaceId, (client) => recoveryReofferForAttemptCore(client, args));
}

// setAttemptRecovering(client, …): mark an attempt as RECOVERING (creator-visible) and, when the report
// communicates submission uncertainty, latch possibly_submitted=true (monotonic — never regressed).
export async function setAttemptRecoveringCore(client, { workspaceId, attemptId, workerId, possiblySubmitted = false }) {
  assertWs(workspaceId);
  const attempt = await R.generationAttemptRepository.lock(client, workspaceId, attemptId);
  if (!attempt) return { updated: false, reason: "attempt_not_found" };
  if (attempt.assigned_worker_id && attempt.assigned_worker_id !== workerId) return { updated: false, reason: "not_producing_worker" };
  if (attempt.terminal_state) return { updated: false, reason: "terminal" };   // never regress a terminal
  // possibly_submitted is monotonic: latch to true, never back to false.
  const nextPossibly = attempt.possibly_submitted === true || possiblySubmitted === true;
  await client.query(
    "UPDATE generation_attempts SET ownership_status='RECOVERING', possibly_submitted=$3 WHERE workspace_id=$1 AND id=$2",
    [workspaceId, attemptId, nextPossibly]);
  // Reflect RECOVERING on the live offer row too, so the creator projection reads it consistently.
  const live = await R.jobOfferRepository.liveForAttempt(client, workspaceId, attemptId);
  if (live) await R.jobOfferRepository.setStatus(client, workspaceId, live.id, "RECOVERING", { reconcileRequired: true, possiblySubmitted: nextPossibly });
  return { updated: true, possiblySubmitted: nextPossibly };
}
