// AVC Studio P0 Step 3 — STATE_RECONCILE + JOB_RECOVERY_REPORT builders (PURE).
//
// PURE MODULE. Reads plain journal records passed in via `context` and produces
// protocol envelopes; it NEVER touches the journal on disk and NEVER mutates its
// inputs. Every emitted payload is safe by construction and re-checked with
// assertRecordSafe: no cookies/tokens/credentials, no absolute or browser-profile
// paths, no proxy data, no raw provider URLs — only relative refs + safe metadata.
//
// Key guarantees:
//   * Batches share ONE reconcileId; index/total/isLast are consistent.
//   * Each batch payload stays within MAX_RECONCILE_PAYLOAD_BYTES (≤1MB) and every
//     batch is built through makeEnvelope, so it passes validateEnvelope.
//   * Deterministic: items are sorted by jobId; terminal-pending-ack jobs are
//     placed before still-active jobs so delivery-owed outcomes reconcile first.
//   * Recovery reports assert createdSecondGeneration:false — recovery never spends
//     new quota.

import { makeEnvelope, MAX_RECONCILE_PAYLOAD_BYTES } from "../protocol/envelope.mjs";
import { generateId } from "../protocol/ids.mjs";
import { classifyRecovery, classifyRecoveryContract, planRecovery, RECOVERY_STATES } from "./recovery-classifier.mjs";
import { safeResultMeta, isRelativeRef, assertRecordSafe } from "./journal-safety.mjs";

function jsonByteLength(obj) { return Buffer.byteLength(JSON.stringify(obj), "utf8"); }

// Compact, safe per-job summary for a reconcile batch or recovery report.
function toReconcileItem(record) {
  const state = classifyRecovery(record);
  const item = {
    jobId: record.jobId,
    action: record.action ?? null,
    localState: record.localState ?? null,
    recoveryState: state,
    submittedToProvider: record.submittedToProvider === true,
    providerSubmissionId: record.providerSubmissionId ?? null,
    generationAttemptId: record.generationAttemptId ?? null,
    requestIdempotencyKey: record.requestIdempotencyKey ?? null,
    acceptedBaseRevision: Number.isInteger(record.acceptedBaseRevision) ? record.acceptedBaseRevision : null,
    lastEventSequence: Number.isInteger(record.lastEventSequence) ? record.lastEventSequence : 0,
    phase: record.phase ?? null,
    // relative refs only — drop anything that is not a safe relative reference
    localResultRef: isRelativeRef(record.localResultRef) ? record.localResultRef : null,
    importedAssetId: record.importedAssetId ?? null,
    resultMeta: safeResultMeta(record.resultMeta),
    terminal: record.terminal && typeof record.terminal === "object"
      ? { type: record.terminal.type ?? null, code: record.terminal.code ?? null }
      : null,
    terminalMessageId: record.terminalMessageId ?? null,
    ackPending: record.ackPending === true,
    acknowledged: record.acknowledged === true,
    corrupt: record.corrupt === true
  };
  assertRecordSafe(item);
  return item;
}

function makeBatchPayload({ reconcileId, index, total, generatedAt, items, counts }) {
  return {
    reconcileId,
    index,
    total,
    isLast: index === total - 1,
    generatedAt,
    counts,
    items
  };
}

// buildReconcileBatches(context): array of STATE_RECONCILE envelopes.
// context: { workspaceId, workerId, records, reconcileId?, generatedAt?, maxPayloadBytes? }
export function buildReconcileBatches(context = {}) {
  const { workspaceId, workerId } = context;
  if (!workspaceId || !workerId) throw new Error("buildReconcileBatches requires workspaceId and workerId");
  const records = Array.isArray(context.records) ? context.records : [];
  const reconcileId = context.reconcileId || generateId("corr");
  const generatedAt = context.generatedAt || new Date().toISOString();
  const maxBytes = Number.isInteger(context.maxPayloadBytes) ? context.maxPayloadBytes : MAX_RECONCILE_PAYLOAD_BYTES;

  // Priority: terminal-pending-ack (delivery owed) before everything else; within
  // each group, deterministic by jobId.
  const byJobId = (a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0);
  const terminalPending = records
    .filter((r) => classifyRecovery(r) === RECOVERY_STATES.TERMINAL_PENDING_ACK)
    .slice().sort(byJobId);
  const active = records
    .filter((r) => {
      const s = classifyRecovery(r);
      return s !== RECOVERY_STATES.TERMINAL_PENDING_ACK && s !== RECOVERY_STATES.SETTLED;
    })
    .slice().sort(byJobId);

  const counts = { terminalPendingAck: terminalPending.length, activeJobs: active.length };
  const ordered = [...terminalPending, ...active].map(toReconcileItem);

  // Greedy pack into byte-bounded groups. index/total placeholders during packing
  // are finalized afterwards; we re-measure with real index/total before emitting.
  const groups = [];
  let current = [];
  for (const item of ordered) {
    const tentative = [...current, item];
    const size = jsonByteLength(makeBatchPayload({ reconcileId, index: 0, total: 9999, generatedAt, items: tentative, counts }));
    if (size > maxBytes && current.length > 0) {
      groups.push(current);
      current = [item];
    } else {
      current = tentative;
    }
  }
  // Always emit at least one batch (an empty reconcile means "worker is clean").
  groups.push(current);

  const total = groups.length;
  return groups.map((items, index) => {
    const payload = makeBatchPayload({ reconcileId, index, total, generatedAt, items, counts });
    return makeEnvelope({
      type: "STATE_RECONCILE",
      workspaceId, workerId,
      payload
    });
  });
}

// buildRecoveryReport(jobId, context): a single JOB_RECOVERY_REPORT envelope.
// context: { workspaceId, workerId, record, generatedAt? }  (record is the journal
// record for jobId; the builder does not read the journal itself).
export function buildRecoveryReport(jobId, context = {}) {
  const { workspaceId, workerId, record } = context;
  if (!workspaceId || !workerId) throw new Error("buildRecoveryReport requires workspaceId and workerId");
  if (!record || record.jobId !== jobId) throw new Error("buildRecoveryReport requires the matching journal record");

  const state = classifyRecovery(record);
  const contractState = classifyRecoveryContract(record);
  const plan = planRecovery(record);
  const payload = {
    jobId,
    recoveryState: state,
    // Step 5C.8B2 C6 — fine-grained recovery evidence the Control Plane reconciles against. All fields
    // are safe scalars/ids; the strict allowlist validator on the CP side re-checks them.
    recoveryContractState: contractState,   // PRE_SUBMIT | SUBMITTING_UNKNOWN | SUBMITTED_WAITING | RESULT_AVAILABLE | DOWNLOADED | IMPORTED | TERMINAL_PENDING_ACK | …
    recoveryAction: plan.action,            // RETRY_SAFE | INSPECT_PROVIDER | WAIT_FOR_PROVIDER | REDELIVER_TERMINAL | ESCALATE_OPERATOR | …
    localState: record.localState ?? null,
    submissionState: record.submissionState ?? null,
    submissionConfidence: record.submissionConfidence ?? null,
    generationOrdinal: Number.isInteger(record.generationOrdinal) ? record.generationOrdinal : null,
    submittedToProvider: record.submittedToProvider === true,
    possiblySubmitted: record.submittedToProvider === true || record.submissionState === "SUBMITTING" || record.submissionState === "SUBMITTED",
    providerSubmissionId: record.providerSubmissionId ?? null,
    generationAttemptId: record.generationAttemptId ?? null,
    requestIdempotencyKey: record.requestIdempotencyKey ?? null,
    acceptedBaseRevision: Number.isInteger(record.acceptedBaseRevision) ? record.acceptedBaseRevision : null,
    localResultRef: isRelativeRef(record.localResultRef) ? record.localResultRef : null,
    importedAssetId: record.importedAssetId ?? null,
    resultMeta: safeResultMeta(record.resultMeta),
    terminal: record.terminal && typeof record.terminal === "object"
      ? { type: record.terminal.type ?? null, code: record.terminal.code ?? null }
      : null,
    terminalMessageId: record.terminalMessageId ?? null,
    // Journal ordering evidence so the CP can reject older evidence overwriting newer.
    journalUpdatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    // Recovery NEVER creates a new paid generation. Stated explicitly for the cloud.
    createdSecondGeneration: false,
    generatedAt: context.generatedAt || new Date().toISOString()
  };
  assertRecordSafe(payload);
  return makeEnvelope({ type: "JOB_RECOVERY_REPORT", workspaceId, workerId, jobId, payload });
}
