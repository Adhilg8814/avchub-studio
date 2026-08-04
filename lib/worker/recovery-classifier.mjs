// AVC Studio P0 Step 3 — recovery classification (PURE).
//
// PURE MODULE. Zero side effects, no fs/network. Given a recovery-journal record,
// decides what recovery action (if any) is safe. The single most important rule:
//
//   A job that was already submitted to the provider (submittedToProvider === true)
//   MUST NEVER be auto-retried, because a retry would spend paid quota a second
//   time. Such jobs are recovered WITHOUT a new generation (wait for / re-collect
//   the existing result) or escalated to the operator.

export const RECOVERY_STATES = Object.freeze({
  NOT_SUBMITTED_SAFE_TO_RETRY: "NOT_SUBMITTED_SAFE_TO_RETRY",
  SUBMITTED_WAIT_FOR_PROVIDER: "SUBMITTED_WAIT_FOR_PROVIDER",
  SUBMITTED_RESULT_AVAILABLE: "SUBMITTED_RESULT_AVAILABLE",
  DOWNLOADED_NOT_IMPORTED: "DOWNLOADED_NOT_IMPORTED",
  IMPORTED_NOT_ACKNOWLEDGED: "IMPORTED_NOT_ACKNOWLEDGED",
  TERMINAL_PENDING_ACK: "TERMINAL_PENDING_ACK",
  MANUAL_ACTION_REQUIRED: "MANUAL_ACTION_REQUIRED",
  CORRUPT_JOURNAL: "CORRUPT_JOURNAL",
  UNKNOWN_NEEDS_OPERATOR: "UNKNOWN_NEEDS_OPERATOR",
  // Non-recovery: the cloud already acknowledged the terminal outcome, so there
  // is nothing to do. Retained only for a short diagnostic window.
  SETTLED: "SETTLED"
});

// Recovery paths that do NOT create a new paid generation.
const NO_NEW_GENERATION = new Set([
  RECOVERY_STATES.SUBMITTED_WAIT_FOR_PROVIDER,
  RECOVERY_STATES.SUBMITTED_RESULT_AVAILABLE,
  RECOVERY_STATES.DOWNLOADED_NOT_IMPORTED,
  RECOVERY_STATES.IMPORTED_NOT_ACKNOWLEDGED,
  RECOVERY_STATES.TERMINAL_PENDING_ACK
]);

function isTerminalRecord(record) {
  return record && record.terminal != null && typeof record.terminal === "object";
}

// classifyRecovery(record): one of RECOVERY_STATES.
export function classifyRecovery(record) {
  if (!record || typeof record !== "object") return RECOVERY_STATES.UNKNOWN_NEEDS_OPERATOR;
  if (record.corrupt === true) return RECOVERY_STATES.CORRUPT_JOURNAL;

  // Terminal outcomes: either already acknowledged (settled) or still owed to the
  // cloud (pending ack — must be re-delivered on recovery, never re-run).
  if (isTerminalRecord(record)) {
    if (record.acknowledged === true) return RECOVERY_STATES.SETTLED;
    return RECOVERY_STATES.TERMINAL_PENDING_ACK;
  }

  // A parked manual-action job needs the operator (e.g. provider verification).
  if (record.needsManualAction === true || record.localState === "NEEDS_MANUAL_ACTION") {
    return RECOVERY_STATES.MANUAL_ACTION_REQUIRED;
  }

  if (record.submittedToProvider === true) {
    // Paid generation already spent → recover the existing result, never re-submit.
    if (record.importedAssetId) return RECOVERY_STATES.IMPORTED_NOT_ACKNOWLEDGED;
    if (record.localResultRef) return RECOVERY_STATES.DOWNLOADED_NOT_IMPORTED;
    if (record.resultAvailable === true) return RECOVERY_STATES.SUBMITTED_RESULT_AVAILABLE;
    return RECOVERY_STATES.SUBMITTED_WAIT_FOR_PROVIDER;
  }

  // Not submitted. A local result / imported asset without a submission is an
  // inconsistent record → operator, not an auto-retry.
  if (record.importedAssetId || record.localResultRef || record.resultAvailable === true) {
    return RECOVERY_STATES.UNKNOWN_NEEDS_OPERATOR;
  }
  return RECOVERY_STATES.NOT_SUBMITTED_SAFE_TO_RETRY;
}

// canAutoRetryGeneration(record): true ONLY when a fresh paid generation is provably safe.
// P0 Step 5C.8B2 Checkpoint 6 — the conservative fine-grained planner is the SINGLE source of truth:
// a record is auto-retry-safe iff its recovery-contract state is PRE_SUBMIT (which requires localState
// NOT in {SUBMITTING,…} AND submissionState !== SUBMITTING AND not submitted AND no local result). This
// closes the SUBMITTING crash window that the coarse classifyRecovery() (keyed only on
// submittedToProvider, false during SUBMITTING) previously mis-labelled as safe-to-retry.
export function canAutoRetryGeneration(record) {
  if (record && record.submittedToProvider === true) return false; // hard guard
  return classifyRecoveryContract(record) === RECOVERY_CONTRACT_STATES.PRE_SUBMIT;
}

// canRecoverWithoutNewGeneration(record): true when recovery can proceed without
// spending quota (wait for / re-collect / re-import / re-deliver an existing result).
export function canRecoverWithoutNewGeneration(record) {
  return NO_NEW_GENERATION.has(classifyRecovery(record));
}

// isRecoverable(record): whether the record represents unfinished work that the
// worker should surface on restart (excludes SETTLED).
export function isRecoverable(record) {
  const state = classifyRecovery(record);
  return state !== RECOVERY_STATES.SETTLED;
}

// ============================================================================
// Step 5.7a — extended recovery contract.
//
// The Step 3 RECOVERY_STATES above stay exactly as they are (callers depend on them).
// The contract adds a FINER-GRAINED classification that distinguishes the crash windows
// the SUBMITTING state makes visible, plus an explicit per-state recovery PLAN. Nothing
// here ever chooses to auto-regenerate a submitted attempt; that is structurally
// impossible because no plan action is "execute".
// ============================================================================

export const RECOVERY_CONTRACT_STATES = Object.freeze({
  // No provider call has started. The only state from which a fresh generation is safe.
  PRE_SUBMIT: "PRE_SUBMIT",
  // A submit was in flight (SUBMITTING persisted) and we do NOT know if the provider
  // accepted it. Maybe billed. Must inspect the provider / lookup, never blindly retry.
  SUBMITTING_UNKNOWN: "SUBMITTING_UNKNOWN",
  // Submitted, provider is (presumably) still generating. Wait / re-attach.
  SUBMITTED_WAITING: "SUBMITTED_WAITING",
  // Submitted and the provider result is ready to collect (not yet downloaded).
  RESULT_AVAILABLE: "RESULT_AVAILABLE",
  // Result downloaded to a local ref, not yet imported as an asset.
  DOWNLOADED: "DOWNLOADED",
  // Imported as a local asset, terminal not yet emitted/acked.
  IMPORTED: "IMPORTED",
  // Terminal outcome computed but not yet acknowledged by the cloud — re-deliver.
  TERMINAL_PENDING_ACK: "TERMINAL_PENDING_ACK",
  // Manual action required (provider verification etc.) — operator, never auto.
  MANUAL_ACTION_REQUIRED: "MANUAL_ACTION_REQUIRED",
  // Fully done and acknowledged; nothing to do.
  SETTLED: "SETTLED",
  // Corrupt journal record — operator.
  CORRUPT: "CORRUPT",
  // Anything the classifier cannot place safely — operator, never auto.
  UNKNOWN: "UNKNOWN"
});

// Recovery ACTIONS a plan may prescribe. Note the absence of any "regenerate/execute"
// action: recovery may inspect, wait, resume, download, import, re-deliver, or escalate
// — it may NEVER cause a new paid generation. A new generation only ever comes from a
// brand-new job with a brand-new generationAttemptId (a user-confirmed retry).
export const RECOVERY_ACTIONS = Object.freeze({
  RETRY_SAFE: "RETRY_SAFE",             // safe to (re)start generation — PRE_SUBMIT only
  INSPECT_PROVIDER: "INSPECT_PROVIDER", // look up whether a submit landed; do NOT submit
  WAIT_FOR_PROVIDER: "WAIT_FOR_PROVIDER",
  RESUME_DOWNLOAD: "RESUME_DOWNLOAD",
  RESUME_IMPORT: "RESUME_IMPORT",
  REDELIVER_TERMINAL: "REDELIVER_TERMINAL",
  ESCALATE_OPERATOR: "ESCALATE_OPERATOR",
  NONE: "NONE"                          // SETTLED — nothing to do
});

function isTerminalRec(record) { return record && record.terminal != null && typeof record.terminal === "object"; }

// classifyRecoveryContract(record): the fine-grained state (RECOVERY_CONTRACT_STATES).
export function classifyRecoveryContract(record) {
  if (!record || typeof record !== "object") return RECOVERY_CONTRACT_STATES.UNKNOWN;
  if (record.corrupt === true) return RECOVERY_CONTRACT_STATES.CORRUPT;

  if (isTerminalRec(record)) {
    return record.acknowledged === true
      ? RECOVERY_CONTRACT_STATES.SETTLED
      : RECOVERY_CONTRACT_STATES.TERMINAL_PENDING_ACK;
  }
  if (record.needsManualAction === true || record.localState === "NEEDS_MANUAL_ACTION") {
    return RECOVERY_CONTRACT_STATES.MANUAL_ACTION_REQUIRED;
  }

  // The submit CRASH WINDOW: SUBMITTING persisted but no confirmed submission. This is
  // the whole reason the SUBMITTING state exists — treat as "maybe billed".
  if (record.localState === "SUBMITTING" || record.submissionState === "SUBMITTING") {
    return RECOVERY_CONTRACT_STATES.SUBMITTING_UNKNOWN;
  }

  if (record.submittedToProvider === true || record.submissionState === "SUBMITTED") {
    if (record.importedAssetId) return RECOVERY_CONTRACT_STATES.IMPORTED;
    if (record.localResultRef) return RECOVERY_CONTRACT_STATES.DOWNLOADED;
    if (record.resultAvailable === true) return RECOVERY_CONTRACT_STATES.RESULT_AVAILABLE;
    return RECOVERY_CONTRACT_STATES.SUBMITTED_WAITING;
  }

  // Not submitted. A local result/asset without a submission is inconsistent → operator.
  if (record.importedAssetId || record.localResultRef || record.resultAvailable === true) {
    return RECOVERY_CONTRACT_STATES.UNKNOWN;
  }
  return RECOVERY_CONTRACT_STATES.PRE_SUBMIT;
}

const S = RECOVERY_CONTRACT_STATES;
const A = RECOVERY_ACTIONS;

// The decision matrix. For each contract state: is a fresh generation safe? does it need
// the operator? can it resume without new quota? should it inspect the provider first?
const PLAN_MATRIX = Object.freeze({
  [S.PRE_SUBMIT]:            { action: A.RETRY_SAFE,         safeToRetry: true,  needsOperator: false, canResume: true,  inspectProvider: false },
  [S.SUBMITTING_UNKNOWN]:    { action: A.INSPECT_PROVIDER,   safeToRetry: false, needsOperator: true,  canResume: true,  inspectProvider: true },
  [S.SUBMITTED_WAITING]:     { action: A.WAIT_FOR_PROVIDER,  safeToRetry: false, needsOperator: false, canResume: true,  inspectProvider: false },
  [S.RESULT_AVAILABLE]:      { action: A.RESUME_DOWNLOAD,    safeToRetry: false, needsOperator: false, canResume: true,  inspectProvider: false },
  [S.DOWNLOADED]:            { action: A.RESUME_IMPORT,      safeToRetry: false, needsOperator: false, canResume: true,  inspectProvider: false },
  [S.IMPORTED]:              { action: A.REDELIVER_TERMINAL, safeToRetry: false, needsOperator: false, canResume: true,  inspectProvider: false },
  [S.TERMINAL_PENDING_ACK]: { action: A.REDELIVER_TERMINAL, safeToRetry: false, needsOperator: false, canResume: true,  inspectProvider: false },
  [S.MANUAL_ACTION_REQUIRED]:{ action: A.ESCALATE_OPERATOR, safeToRetry: false, needsOperator: true,  canResume: true,  inspectProvider: false },
  [S.SETTLED]:              { action: A.NONE,               safeToRetry: false, needsOperator: false, canResume: false, inspectProvider: false },
  [S.CORRUPT]:              { action: A.ESCALATE_OPERATOR,  safeToRetry: false, needsOperator: true,  canResume: false, inspectProvider: false },
  [S.UNKNOWN]:              { action: A.ESCALATE_OPERATOR,  safeToRetry: false, needsOperator: true,  canResume: false, inspectProvider: false }
});

// planRecovery(record, capabilities?): the recovery plan for a record. If provider
// capabilities are supplied, a plan that would INSPECT_PROVIDER but where the provider
// supports no submission lookup is downgraded to ESCALATE_OPERATOR — we must never
// pretend we can verify a submit the provider cannot tell us about.
export function planRecovery(record, capabilities = null) {
  const state = classifyRecoveryContract(record);
  const base = PLAN_MATRIX[state] || PLAN_MATRIX[S.UNKNOWN];
  const plan = { state, ...base };
  if (plan.inspectProvider && capabilities && capabilities.supportsSubmissionLookup !== true) {
    return { ...plan, action: A.ESCALATE_OPERATOR, inspectProvider: false, needsOperator: true, degradedNoLookup: true };
  }
  return plan;
}

// assertNoAutoRegenerate(record): the golden-rule assertion for recovery code paths.
// Throws if a caller is about to (re)generate for a record that has already left the
// pre-submit window. Recovery code calls this immediately before any generation branch;
// it can only ever pass for PRE_SUBMIT.
export function assertNoAutoRegenerate(record) {
  const state = classifyRecoveryContract(record);
  if (state !== RECOVERY_CONTRACT_STATES.PRE_SUBMIT) {
    const err = new Error(`Refusing to regenerate: record is ${state}, not PRE_SUBMIT (golden rule)`);
    err.name = "WorkerError";
    err.code = "E_DUPLICATE_GENERATION_ATTEMPT";
    err.details = { state, jobId: record?.jobId ?? null };
    throw err;
  }
  return true;
}
