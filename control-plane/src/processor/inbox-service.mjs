// P0 Step 5C.3 — durable inbound processing service.
//
// Callable later by the Step 5C.4 WSS Gateway with an ALREADY-PARSED message object (raw frame
// parsing / size enforcement belong to the gateway). Enforces the §11.2 receive order:
//   1. structural validation (NO skew) → safe messageId          (dedupe must precede skew)
//   2. worker-to-cloud direction + identity gate (authenticated connection is source of truth)
//   3. ONE tenant transaction:
//        a. durable inbox dedupe lookup → duplicate ⇒ replay cached ACK, NO business re-apply
//        b. new message ⇒ sentAt ±skew check
//        c. insert inbox row (UNIQUE(worker_id,message_id)); a concurrent duplicate loses the
//           unique race → falls back to the cached-ACK path (exactly one business apply)
//        d. apply the business transition (Step 5C.2 ownership cores) under a SAVEPOINT
//        e. record the ACK ledger row + a MESSAGE_ACK outbox row (for ack-requiring types)
//        f. commit — inbox + business + durable response are ATOMIC.
// A crash after commit but before the ACK is delivered is recovered by the outbox processor
// (the PENDING MESSAGE_ACK row is claimed and sent); business never runs twice.

import { validateEnvelope } from "../../../lib/protocol/envelope.mjs";
import { isWorkerToCloudType, requiresAcknowledgement } from "../../../lib/protocol/message-types.mjs";
import { generateId, validateId } from "../../../lib/protocol/ids.mjs";
import { DOMAIN_ERRORS, isDomainError } from "../persistence/domain-errors.mjs";
import { newId } from "../persistence/ids.mjs";
import * as OWN from "../persistence/transactions/ownership.mjs";
import { inboxRepository, ackRepository, outboxRepository } from "../persistence/repositories/protocol-repository.mjs";
import { settleLifecycleForJob, settleLifecycleForWorker, settleMessageAck } from "./settlement-service.mjs";

const TERMINAL_JOB_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELED", "EXPIRED"]);

// Only true infrastructure failures roll back the WHOLE inbox transaction (so the message is
// retried). Every business-rule rejection is a durable REJECTED ack (rolled back to SAVEPOINT).
function isInfraError(e) {
  const c = e && e.code;
  if (c === DOMAIN_ERRORS.E_DB_UNAVAILABLE || c === DOMAIN_ERRORS.E_SERIALIZATION || c === DOMAIN_ERRORS.E_NESTED_TRANSACTION) return true;
  if (typeof c === "string" && /^08/.test(c)) return true; // pg connection-exception class
  return false;
}

async function resolveAttemptId(client, ws, jobId) {
  if (!jobId) return null;
  const r = await client.query("SELECT generation_attempt_id FROM jobs WHERE workspace_id=$1 AND id=$2", [ws, jobId]);
  return r.rows[0] ? r.rows[0].generation_attempt_id : null;
}

// Build a SAFE result-asset descriptor from a JOB_COMPLETED payload, or undefined. Only a RELATIVE
// path is accepted (no absolute/drive/UNC path, no `..`, no provider URL); all fields are bounded.
// Returning undefined records no asset — it NEVER throws, so a malformed descriptor can never cause
// the terminal message to be rejected.
function safeResultAsset(result) {
  const a = result && typeof result === "object" ? (result.asset && typeof result.asset === "object" ? result.asset : null) : null;
  if (!a) return undefined;
  const rel = typeof a.relativePath === "string" ? a.relativePath.trim() : "";
  if (!rel || rel.length > 512) return undefined;
  if (/^([a-zA-Z]:[\\/]|[\\/]|\\\\)/.test(rel) || rel.includes("://") || rel.split(/[\\/]/).includes("..")) return undefined;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return {
    relativePath: rel,
    fileName: typeof a.fileName === "string" && a.fileName ? a.fileName.slice(0, 256) : rel.split(/[\\/]/).pop(),
    mimeType: typeof a.mimeType === "string" && a.mimeType ? a.mimeType.slice(0, 128) : "application/octet-stream",
    sizeBytes: num(a.sizeBytes),
    actualDurationSec: num(a.durationSeconds ?? a.actualDurationSec),
    width: int(a.width), height: int(a.height),
    // assets.checksum is NOT NULL — a fake staging result carries no real checksum, so record a
    // stable non-secret placeholder (never a provider URL / path).
    checksum: typeof a.checksum === "string" && a.checksum ? a.checksum.slice(0, 128) : "unverified",
    storageTier: "LOCAL_ONLY", liveness: "ONLINE"
  };
}

// Apply the business transition for one inbound message. Throws a DomainError on a business
// rejection (caught by the caller → REJECTED ack). MUST NOT open a transaction (runs on `client`).
async function applyBusiness(client, ws, envelope) {
  const { type, workerId, jobId } = envelope;
  const payload = envelope.payload || {};
  switch (type) {
    case "JOB_ACCEPTED":
      await OWN.applyWorkerEventCore(client, { workspaceId: ws, jobId, workerId, event: "JOB_ACCEPTED" });
      await settleLifecycleForJob(client, ws, jobId, "JOB_ACCEPTED");
      return { businessApplied: true };
    case "JOB_REJECTED":
      await OWN.applyWorkerEventCore(client, { workspaceId: ws, jobId, workerId, event: "JOB_REJECTED" });
      await settleLifecycleForJob(client, ws, jobId, "JOB_REJECTED");
      return { businessApplied: true };
    case "JOB_STARTED":
      await OWN.applyWorkerEventCore(client, { workspaceId: ws, jobId, workerId, event: "JOB_STARTED" });
      return { businessApplied: true };
    case "JOB_NEEDS_MANUAL_ACTION":
      await OWN.applyWorkerEventCore(client, { workspaceId: ws, jobId, workerId, event: "JOB_NEEDS_MANUAL_ACTION" });
      return { businessApplied: true };
    case "JOB_PROGRESS":
      return { businessApplied: false }; // advisory (sequence stream); dedupe only, no ack
    case "JOB_COMPLETED": {
      // A completed generation IS a paid generation → book the submission evidence (idempotent),
      // then the DB CHECK attempt_completed_requires_submitted is satisfied for terminal COMPLETED.
      const attemptId = await resolveAttemptId(client, ws, jobId);
      const submittedRef = payload.providerSubmissionId ?? payload.result?.providerSubmissionId ?? null;
      const providerSubmissionId = validateId(submittedRef, "submission") ? submittedRef : null;
      if (attemptId) await OWN.applySubmissionFactCore(client, { workspaceId: ws, attemptId, workerId, state: "SUBMITTED", confidence: "CONFIRMED", providerSubmissionId });
      // A completed generation MAY carry a SAFE result-asset descriptor (relative path only). It is
      // recorded by terminal application; an absent/unsafe descriptor simply records no asset (the
      // terminal itself is unaffected — never rejected for a bad descriptor).
      await OWN.applyTerminalCore(client, { workspaceId: ws, jobId, workerId, terminalType: "JOB_COMPLETED", terminalMessageId: envelope.messageId, result: payload.result ?? null, assetMeta: safeResultAsset(payload.result) });
      return { businessApplied: true };
    }
    case "JOB_FAILED": {
      const submitted = payload.recovery && payload.recovery.submittedToProvider === true;
      const attemptId = await resolveAttemptId(client, ws, jobId);
      if (submitted && attemptId) await OWN.applySubmissionFactCore(client, { workspaceId: ws, attemptId, workerId, state: "SUBMITTED", confidence: "PRESUMED" });
      await OWN.applyTerminalCore(client, { workspaceId: ws, jobId, workerId, terminalType: "JOB_FAILED", terminalMessageId: envelope.messageId, errorCode: payload.errorCode ?? null });
      return { businessApplied: true };
    }
    case "JOB_CANCELED":
      await OWN.applyTerminalCore(client, { workspaceId: ws, jobId, workerId, terminalType: "JOB_CANCELED", terminalMessageId: envelope.messageId });
      await settleLifecycleForJob(client, ws, jobId, "JOB_CANCELED");
      return { businessApplied: true };
    case "JOB_RECOVERY_REPORT":
      await recordRecoveryReport(client, ws, envelope);
      return { businessApplied: true };
    case "STATE_RECONCILE": {
      const isLast = (payload.batch && payload.batch.isLast === true) || payload.isLast === true;
      if (isLast) {
        // A STALE reconcile batch (older epoch) must NOT release a newer barrier (§10.6).
        const expectedEpoch = Number.isInteger(payload.reconcileEpoch) ? payload.reconcileEpoch : null;
        const res = await OWN.closeReconcileBarrierCore(client, { workspaceId: ws, workerId, isLast: true, expectedEpoch });
        if (res.closed) await settleLifecycleForWorker(client, ws, workerId, "STATE_RECONCILE");
      }
      return { businessApplied: true };
    }
    case "PROVIDER_SESSION_STATUS":
      await settleLifecycleForWorker(client, ws, workerId, "PROVIDER_SESSION_STATUS");
      return { businessApplied: true };
    case "MESSAGE_ACK": {
      // The worker is acking OUR outbound message (e.g. WORKER_CREDENTIAL_ROTATE). Never ack an
      // ack; settle the correlated MESSAGE_ACK-mode outbox row and record the OUTBOUND ledger row.
      const res = await settleMessageAck(client, ws, { workerId, ackedMessageId: payload.ackedMessageId, status: payload.status });
      await ackRepository.record(client, ws, { workerId, direction: "OUTBOUND", ackedMessageId: payload.ackedMessageId, ackedType: payload.ackedType, status: payload.status, errorCode: payload.errorCode ?? null, serverRevision: payload.serverRevision ?? null });
      return { businessApplied: true, settlement: res };
    }
    default:
      // WORKER_HELLO/HEARTBEAT/CAPABILITIES/STORAGE_STATUS/GOODBYE/ASSET_METADATA_UPSERT: advisory
      // or out-of-scope for the 5C.3 golden-rule path — dedupe (+ ACK if required) only.
      return { businessApplied: false };
  }
}

// Recovery-contract states that indicate the provider MAY have run (submission uncertain/started) →
// the attempt must surface an honest RECOVERING state and (for the uncertain submit window) latch
// possibly_submitted. Never auto-re-offer these.
const UNCERTAIN_RECOVERY_STATES = new Set(["SUBMITTING_UNKNOWN", "SUBMITTED_WAITING", "RESULT_AVAILABLE", "DOWNLOADED"]);

async function recordRecoveryReport(client, ws, envelope) {
  const { workerId, jobId } = envelope;
  const payload = envelope.payload || {};
  const originalMessageId = validateId(payload.originalMessageId, "msg") ? payload.originalMessageId : envelope.messageId;
  await client.query(
    `INSERT INTO job_recovery_reports (id, workspace_id, job_id, worker_id, original_message_id, local_state, submitted_to_provider, result, applied_at, created_second_generation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), false)
     ON CONFLICT (job_id, original_message_id) DO NOTHING`,
    [newId("jrr"), ws, jobId, workerId, originalMessageId, payload.localState ?? null, payload.submittedToProvider ?? null, payload.result ? JSON.stringify(payload.result) : null]);
  // Lock the job so concurrent reports for the same condition serialize to at most one durable action.
  const job = (await client.query("SELECT status, generation_attempt_id FROM jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [ws, jobId])).rows[0];
  if (!job) throw { code: DOMAIN_ERRORS.E_INVALID_ARGUMENT, message: "job not found" };
  const attemptId = job.generation_attempt_id;
  // A report may only reconcile its OWN attempt (the strict allowlist + ownership re-check below prevent
  // cross-job/cross-attempt effects; the ownership functions additionally verify assigned_worker_id).
  if (attemptId && payload.generationAttemptId && payload.generationAttemptId !== attemptId) {
    return; // report references a different attempt than the job actually has → no business effect
  }

  // Backward-compat: an explicit `result` completes without a new generation (existing §5.2 path).
  if (payload.result && !TERMINAL_JOB_STATES.has(job.status)) {
    if (attemptId) await OWN.applySubmissionFactCore(client, { workspaceId: ws, attemptId, workerId, state: "SUBMITTED", confidence: "CONFIRMED" });
    await OWN.applyTerminalCore(client, { workspaceId: ws, jobId, workerId, terminalType: "JOB_COMPLETED", terminalMessageId: originalMessageId });
    return;
  }

  // C6 reconciliation — driven by the report's recovery-contract state but GUARDED by the Control Plane's
  // own durable evidence (each ownership function re-verifies from the DB, so a report can only ROUTE,
  // never force). IMPORTED/TERMINAL_PENDING_ACK are completed by the Worker's terminal replay (pattern A)
  // and need no action here.
  if (!attemptId || TERMINAL_JOB_STATES.has(job.status)) return;
  const cs = typeof payload.recoveryContractState === "string" ? payload.recoveryContractState : null;
  if (cs === "PRE_SUBMIT") {
    // Proven-safe re-offer (idempotent; refuses unless ALL durable evidence agrees provider never ran).
    await OWN.recoveryReofferForAttemptCore(client, { workspaceId: ws, attemptId, workerId });
  } else if (cs && UNCERTAIN_RECOVERY_STATES.has(cs)) {
    // Submission uncertain/started → honest RECOVERING + latch possibly_submitted. Never auto-re-offer.
    await OWN.setAttemptRecoveringCore(client, { workspaceId: ws, attemptId, workerId, possiblySubmitted: true });
  }
}

export function createInboxService({ adapter, clock, logger, skewMs = 120000 } = {}) {
  async function replayCached(client, ws, inbox, envelope) {
    const { type, workerId, messageId } = envelope;
    let ackReplayed = false;
    if (requiresAcknowledgement(type) && inbox && inbox.ack_id) {
      const ack = (await client.query("SELECT * FROM protocol_message_acks WHERE workspace_id=$1 AND id=$2", [ws, inbox.ack_id])).rows[0];
      if (ack) {
        // Re-queue the cached ACK for delivery only if no MESSAGE_ACK for it is already in flight
        // (bounds duplicate replays). This RETURNS the cached outcome — it does not "drop".
        const inflight = (await client.query(
          "SELECT 1 FROM protocol_outbox WHERE workspace_id=$1 AND worker_id=$2 AND type='MESSAGE_ACK' AND payload->>'ackedMessageId'=$3 AND delivery_state IN ('PENDING','SENT') LIMIT 1",
          [ws, workerId, messageId])).rows[0];
        if (!inflight) {
          await outboxRepository.insert(client, ws, {
            messageId: generateId("msg"), workerId, jobId: envelope.jobId ?? null, type: "MESSAGE_ACK", settlementMode: "SEND_ONLY",
            payload: { ackedMessageId: messageId, ackedType: type, status: ack.status, serverRevision: ack.server_revision ?? null, errorCode: ack.error_code ?? null }, orderingKey: null
          });
        }
        ackReplayed = true;
      }
    }
    return { outcome: "DUPLICATE", messageId, type, duplicate: true, businessApplied: false, ackReplayed };
  }

  return {
    // processInboundEnvelope(ctx): ctx = { authenticatedWorkerId, authenticatedWorkspaceId,
    // connectionSessionId?, envelope, receivedAtIso? }. Returns a structured outcome; never throws
    // on a business rejection (it becomes a durable REJECTED ack). Infra failures propagate.
    async processInboundEnvelope({ authenticatedWorkerId, authenticatedWorkspaceId, connectionSessionId = null, envelope, receivedAtIso = null }) {
      // 1. structural validation WITHOUT skew (so a legitimately-late replay is not dropped here).
      try {
        validateEnvelope(envelope, { checkSkew: false });
      } catch (e) {
        return { outcome: "REJECTED", code: e.code || "E_SCHEMA_INVALID", messageId: envelope && envelope.messageId, type: envelope && envelope.type };
      }
      const { messageId, type, workerId, workspaceId, jobId } = envelope;
      if (!isWorkerToCloudType(type)) return { outcome: "REJECTED", code: "E_WRONG_DIRECTION", messageId, type };
      // 2. identity gate — the authenticated connection is the source of truth; never trust the body.
      if (workerId !== authenticatedWorkerId) return { outcome: "REJECTED", code: DOMAIN_ERRORS.E_IDENTITY_MISMATCH, messageId, type };
      if (workspaceId && authenticatedWorkspaceId && workspaceId !== authenticatedWorkspaceId) {
        return { outcome: "REJECTED", code: DOMAIN_ERRORS.E_IDENTITY_MISMATCH, messageId, type };
      }
      const ws = authenticatedWorkspaceId;
      const receivedMs = Date.parse(receivedAtIso || clock.nowIso());

      return adapter.tenantTransaction(ws, async (client) => {
        // 3a. dedupe lookup (BEFORE skew)
        const existing = await inboxRepository.find(client, ws, workerId, messageId);
        if (existing) return replayCached(client, ws, existing, envelope);

        // 3b. skew (new messages only)
        const sentMs = Date.parse(envelope.sentAt);
        if (!Number.isFinite(sentMs) || Math.abs(receivedMs - sentMs) > skewMs) {
          return { outcome: "REJECTED", code: "E_REPLAY", messageId, type, reason: "SKEW" };
        }

        // 3c. insert dedupe row (a concurrent duplicate loses the unique race → replay cache).
        // Populate generation_attempt_id for job-scoped messages so retention can tell whether the
        // referenced attempt is resolved (terminal) before ever sweeping this inbox row.
        const attemptForInbox = jobId ? await resolveAttemptId(client, ws, jobId) : null;
        const inbox = await inboxRepository.insert(client, ws, { workerId, jobId: jobId ?? null, generationAttemptId: attemptForInbox, messageId, type, receivedAtIso: clock.nowIso() });
        if (!inbox) {
          const winner = await inboxRepository.find(client, ws, workerId, messageId);
          return replayCached(client, ws, winner, envelope);
        }

        // 3d. business transition under a SAVEPOINT
        let ackStatus = "ACCEPTED", errorCode = null, serverRevision = null, businessApplied = false;
        await client.query("SAVEPOINT biz");
        try {
          const biz = await applyBusiness(client, ws, envelope);
          businessApplied = biz.businessApplied;
          serverRevision = biz.serverRevision ?? null;
          await client.query("RELEASE SAVEPOINT biz");
        } catch (e) {
          if (isInfraError(e)) throw e;                    // whole txn rolls back → retry
          await client.query("ROLLBACK TO SAVEPOINT biz"); // discard partial business only
          ackStatus = "REJECTED";
          errorCode = (isDomainError(e) && e.code) || (typeof e.code === "string" ? "E_REJECTED" : "E_REJECTED");
          logger?.warn?.("inbound_business_rejected", { component: "processor", event: "inbound_business_rejected", messageType: type, reasonCode: errorCode });
        }

        // 3e. ACK ledger + MESSAGE_ACK outbox (ack-requiring types only)
        let ackId = null;
        if (requiresAcknowledgement(type)) {
          const rec = await ackRepository.record(client, ws, { workerId, jobId: jobId ?? null, direction: "INBOUND", ackedMessageId: messageId, ackedType: type, status: ackStatus, errorCode, serverRevision });
          ackId = rec.ack ? rec.ack.id : null;
          await outboxRepository.insert(client, ws, {
            messageId: generateId("msg"), workerId, jobId: jobId ?? null, type: "MESSAGE_ACK", settlementMode: "SEND_ONLY",
            payload: { ackedMessageId: messageId, ackedType: type, status: ackStatus, serverRevision, errorCode }, orderingKey: null
          });
        }
        await inboxRepository.markProcessed(client, ws, inbox.id, { ackId });
        return { outcome: ackStatus === "REJECTED" ? "REJECTED" : "APPLIED", code: ackStatus === "REJECTED" ? errorCode : undefined, messageId, type, businessApplied, ackCreated: Boolean(ackId), ackStatus, duplicate: false };
      });
    }
  };
}
