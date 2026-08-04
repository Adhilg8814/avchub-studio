// P0 Step 5C.2 — stable internal domain errors (PURE). Public responses expose only a safe
// { code, message } — never a raw PostgreSQL constraint name or SQL. Internal diagnostics may
// retain a safe sqlstate/constraint code (attached, not thrown into public bodies).

export const DOMAIN_ERRORS = Object.freeze({
  E_WORKSPACE_NOT_FOUND: "E_WORKSPACE_NOT_FOUND",
  E_PROJECT_NOT_FOUND: "E_PROJECT_NOT_FOUND",
  E_WORKER_NOT_FOUND: "E_WORKER_NOT_FOUND",
  E_WORKSPACE_MISMATCH: "E_WORKSPACE_MISMATCH",
  E_IDENTITY_MISMATCH: "E_IDENTITY_MISMATCH",
  E_REVISION_CONFLICT: "E_REVISION_CONFLICT",
  E_IDEMPOTENCY_CONFLICT: "E_IDEMPOTENCY_CONFLICT",
  E_ATTEMPT_ALREADY_OWNED: "E_ATTEMPT_ALREADY_OWNED",
  E_ATTEMPT_POSSIBLY_SUBMITTED: "E_ATTEMPT_POSSIBLY_SUBMITTED",
  E_ATTEMPT_TERMINAL: "E_ATTEMPT_TERMINAL",
  E_RECONCILIATION_REQUIRED: "E_RECONCILIATION_REQUIRED",
  E_AFFINITY_CONFLICT: "E_AFFINITY_CONFLICT",
  E_OFFER_NOT_SAFE_TO_RETRY: "E_OFFER_NOT_SAFE_TO_RETRY",
  E_PAID_APPROVAL_REQUIRED: "E_PAID_APPROVAL_REQUIRED",
  E_INVALID_STATE_TRANSITION: "E_INVALID_STATE_TRANSITION",
  E_INVALID_ARGUMENT: "E_INVALID_ARGUMENT",
  E_NESTED_TRANSACTION: "E_NESTED_TRANSACTION",
  E_DB_UNAVAILABLE: "E_DB_UNAVAILABLE",
  E_SERIALIZATION: "E_SERIALIZATION"
});

const RETRYABLE = new Set([DOMAIN_ERRORS.E_SERIALIZATION]);

export class DomainError extends Error {
  constructor(code, message, { sqlstate = null, constraint = null, cause = null } = {}) {
    super(typeof message === "string" && message ? message : code);
    this.name = "DomainError";
    this.code = DOMAIN_ERRORS[code] ? code : DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION;
    this.retriable = RETRYABLE.has(this.code);
    // Safe internal-only diagnostics (never placed in a public response body).
    if (sqlstate) this.sqlstate = sqlstate;
    if (constraint) this.constraint = constraint;
    if (cause) this.diagCause = String(cause?.code || cause?.name || "");
  }
  // Public shape: NO sqlstate/constraint/SQL.
  toPublic({ correlationId = null } = {}) {
    return { code: this.code, message: this.message, retriable: this.retriable, correlationId };
  }
}

export function domainError(code, message, opts) { return new DomainError(code, message, opts); }
export function isDomainError(e) { return e instanceof DomainError; }
