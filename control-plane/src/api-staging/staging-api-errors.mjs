// P0 Step 5C.6 — staging API error mapping.
//
// The reused ownership transactions throw internal DomainErrors; the staging surfaces throw
// ControlPlaneErrors. This maps either onto a stable, SAFE public ControlPlaneError (code + generic
// message) — a raw SQL state / constraint / stack trace never reaches the client. Every mapped code
// is client-safe (registered in errors.mjs CLIENT_SAFE_MESSAGE).

import { ControlPlaneError, CP_ERRORS, isControlPlaneErrorCode } from "../errors.mjs";
import { isDomainError } from "../persistence/domain-errors.mjs";

// DomainError code → public ControlPlaneError code. Cross-workspace / not-found collapse to safe
// not-found; invalid-argument to bad-request; DB-unavailable to dependency-not-ready.
const DOMAIN_TO_CP = Object.freeze({
  E_WORKSPACE_NOT_FOUND: CP_ERRORS.E_NOT_FOUND,
  E_PROJECT_NOT_FOUND: CP_ERRORS.E_PROJECT_NOT_FOUND,
  E_WORKER_NOT_FOUND: CP_ERRORS.E_WORKER_NOT_FOUND,
  E_WORKSPACE_MISMATCH: CP_ERRORS.E_NOT_FOUND,
  E_IDENTITY_MISMATCH: CP_ERRORS.E_INVALID_STATE_TRANSITION,
  E_REVISION_CONFLICT: CP_ERRORS.E_REVISION_CONFLICT,
  E_IDEMPOTENCY_CONFLICT: CP_ERRORS.E_IDEMPOTENCY_CONFLICT,
  E_ATTEMPT_ALREADY_OWNED: CP_ERRORS.E_ATTEMPT_ALREADY_OWNED,
  E_ATTEMPT_POSSIBLY_SUBMITTED: CP_ERRORS.E_ATTEMPT_POSSIBLY_SUBMITTED,
  E_ATTEMPT_TERMINAL: CP_ERRORS.E_ATTEMPT_TERMINAL,
  E_RECONCILIATION_REQUIRED: CP_ERRORS.E_RECONCILIATION_REQUIRED,
  E_AFFINITY_CONFLICT: CP_ERRORS.E_AFFINITY_CONFLICT,
  E_OFFER_NOT_SAFE_TO_RETRY: CP_ERRORS.E_OFFER_NOT_SAFE_TO_RETRY,
  E_PAID_APPROVAL_REQUIRED: CP_ERRORS.E_INVALID_STATE_TRANSITION,
  E_INVALID_STATE_TRANSITION: CP_ERRORS.E_INVALID_STATE_TRANSITION,
  E_INVALID_ARGUMENT: CP_ERRORS.E_BAD_REQUEST,
  E_DB_UNAVAILABLE: CP_ERRORS.E_DEPENDENCY_NOT_READY,
  E_SERIALIZATION: CP_ERRORS.E_INVALID_STATE_TRANSITION
});

const SAFE_MESSAGE = Object.freeze({
  [CP_ERRORS.E_PROJECT_NOT_FOUND]: "Project not found",
  [CP_ERRORS.E_PROJECT_ARCHIVED]: "Project is archived",
  [CP_ERRORS.E_WORKER_NOT_FOUND]: "Worker not found",
  [CP_ERRORS.E_WORKER_NOT_AVAILABLE]: "Worker not available",
  [CP_ERRORS.E_WORKER_CAPABILITY_MISMATCH]: "Worker capability mismatch",
  [CP_ERRORS.E_PROJECT_AFFINITY_REQUIRED]: "Project has no assigned Worker",
  [CP_ERRORS.E_RECONCILIATION_REQUIRED]: "Reconciliation required",
  [CP_ERRORS.E_REVISION_CONFLICT]: "Concurrent modification",
  [CP_ERRORS.E_AFFINITY_CONFLICT]: "Affinity conflict",
  [CP_ERRORS.E_IDEMPOTENCY_CONFLICT]: "Idempotency key reused with different parameters",
  [CP_ERRORS.E_JOB_NOT_FOUND]: "Job not found",
  [CP_ERRORS.E_JOB_NOT_CANCELABLE]: "Job cannot be canceled",
  [CP_ERRORS.E_JOB_NOT_RETRYABLE]: "Job cannot be retried",
  [CP_ERRORS.E_ATTEMPT_ALREADY_OWNED]: "Attempt already owned",
  [CP_ERRORS.E_ATTEMPT_POSSIBLY_SUBMITTED]: "Attempt may be submitted",
  [CP_ERRORS.E_ATTEMPT_TERMINAL]: "Attempt already terminal",
  [CP_ERRORS.E_OFFER_NOT_SAFE_TO_RETRY]: "Offer not safe to retry",
  [CP_ERRORS.E_INVALID_STATE_TRANSITION]: "Invalid state transition"
});

export function apiError(code, message) { return new ControlPlaneError(code, message || SAFE_MESSAGE[code] || "Request could not be completed"); }

// Coerce any thrown value into a SAFE public ControlPlaneError.
export function toApiError(err) {
  if (err instanceof ControlPlaneError) return err;
  if (isDomainError(err)) {
    const code = DOMAIN_TO_CP[err.code] || CP_ERRORS.E_INVALID_STATE_TRANSITION;
    return new ControlPlaneError(code, SAFE_MESSAGE[code] || "Request could not be completed");
  }
  return new ControlPlaneError(CP_ERRORS.E_INTERNAL, "Internal error");
}

// A REJECT marker carried out of a tenant transaction so a ControlPlaneError is thrown AFTER the
// txn commits its decision (never inside — the adapter would remap it to E_INTERNAL). Mirrors the
// 5C.5 pattern. `settle` throws for a reject, otherwise returns the value.
export const REJECT = (code, message) => ({ __reject: { code, message } });
export function settle(out) {
  if (out && out.__reject) throw apiError(out.__reject.code, out.__reject.message);
  return out;
}
export { isControlPlaneErrorCode };
