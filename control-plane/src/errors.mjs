// P0 Step 5C.1 — Control Plane error model (PURE).
//
// One stable error shape for the whole Control Plane skeleton. Public responses expose
// ONLY { code, message, retriable, correlationId } — never a stack trace, never a raw
// value. Internal logs may carry a sanitized diagnostic summary (see logging/redact.mjs).
//
// This module has zero side effects and imports nothing — safe to use everywhere.

export const CP_ERRORS = Object.freeze({
  E_NOT_FOUND: "E_NOT_FOUND",
  E_METHOD_NOT_ALLOWED: "E_METHOD_NOT_ALLOWED",
  E_BAD_REQUEST: "E_BAD_REQUEST",
  E_PAYLOAD_TOO_LARGE: "E_PAYLOAD_TOO_LARGE",
  E_CONFIG_INVALID: "E_CONFIG_INVALID",
  E_DEPENDENCY_NOT_READY: "E_DEPENDENCY_NOT_READY",
  E_FEATURE_DISABLED: "E_FEATURE_DISABLED",
  E_NOT_IMPLEMENTED: "E_NOT_IMPLEMENTED",
  E_INTERNAL: "E_INTERNAL",
  // P0 Step 5C.5 — pairing / credential lifecycle (operator + worker-facing).
  E_OPERATOR_UNAUTHORIZED: "E_OPERATOR_UNAUTHORIZED",
  E_OPERATOR_FORBIDDEN: "E_OPERATOR_FORBIDDEN",
  E_PAIRING_DISABLED: "E_PAIRING_DISABLED",
  E_PAIRING_INVALID: "E_PAIRING_INVALID",       // generic (invalid/expired/consumed/revoked) — never distinguishes
  E_PAIRING_RATE_LIMITED: "E_PAIRING_RATE_LIMITED",
  E_WORKER_DISABLED: "E_WORKER_DISABLED",
  E_CREDENTIAL_REVOKED: "E_CREDENTIAL_REVOKED",
  E_CREDENTIAL_EXPIRED: "E_CREDENTIAL_EXPIRED",
  E_CREDENTIAL_ROTATION_REQUIRED: "E_CREDENTIAL_ROTATION_REQUIRED",
  E_IDEMPOTENCY_CONFLICT: "E_IDEMPOTENCY_CONFLICT",
  // P0 Step 5C.6 — staging Project/Generation/Job/Result API (operator-facing, safe/generic).
  E_STAGING_API_DISABLED: "E_STAGING_API_DISABLED",
  E_PROJECT_NOT_FOUND: "E_PROJECT_NOT_FOUND",
  E_PROJECT_ARCHIVED: "E_PROJECT_ARCHIVED",
  E_WORKER_NOT_FOUND: "E_WORKER_NOT_FOUND",
  E_WORKER_NOT_AVAILABLE: "E_WORKER_NOT_AVAILABLE",
  E_WORKER_CAPABILITY_MISMATCH: "E_WORKER_CAPABILITY_MISMATCH",
  E_PROJECT_AFFINITY_REQUIRED: "E_PROJECT_AFFINITY_REQUIRED",
  E_RECONCILIATION_REQUIRED: "E_RECONCILIATION_REQUIRED",
  E_REVISION_CONFLICT: "E_REVISION_CONFLICT",
  E_AFFINITY_CONFLICT: "E_AFFINITY_CONFLICT",
  E_JOB_NOT_FOUND: "E_JOB_NOT_FOUND",
  E_JOB_NOT_CANCELABLE: "E_JOB_NOT_CANCELABLE",
  E_JOB_NOT_RETRYABLE: "E_JOB_NOT_RETRYABLE",
  E_ATTEMPT_ALREADY_OWNED: "E_ATTEMPT_ALREADY_OWNED",
  E_ATTEMPT_POSSIBLY_SUBMITTED: "E_ATTEMPT_POSSIBLY_SUBMITTED",
  E_ATTEMPT_TERMINAL: "E_ATTEMPT_TERMINAL",
  E_OFFER_NOT_SAFE_TO_RETRY: "E_OFFER_NOT_SAFE_TO_RETRY",
  E_INVALID_STATE_TRANSITION: "E_INVALID_STATE_TRANSITION"
});

const CODE_SET = new Set(Object.values(CP_ERRORS));

// Default HTTP status per error code (a router may override).
const HTTP_STATUS = Object.freeze({
  E_NOT_FOUND: 404,
  E_METHOD_NOT_ALLOWED: 405,
  E_BAD_REQUEST: 400,
  E_PAYLOAD_TOO_LARGE: 413,
  E_CONFIG_INVALID: 500,
  E_DEPENDENCY_NOT_READY: 503,
  E_FEATURE_DISABLED: 403,
  E_NOT_IMPLEMENTED: 501,
  E_INTERNAL: 500,
  E_OPERATOR_UNAUTHORIZED: 401,
  E_OPERATOR_FORBIDDEN: 403,
  E_PAIRING_DISABLED: 403,
  E_PAIRING_INVALID: 400,
  E_PAIRING_RATE_LIMITED: 429,
  E_WORKER_DISABLED: 403,
  E_CREDENTIAL_REVOKED: 401,
  E_CREDENTIAL_EXPIRED: 401,
  E_CREDENTIAL_ROTATION_REQUIRED: 409,
  E_IDEMPOTENCY_CONFLICT: 409,
  E_STAGING_API_DISABLED: 403,
  E_PROJECT_NOT_FOUND: 404,
  E_PROJECT_ARCHIVED: 409,
  E_WORKER_NOT_FOUND: 404,
  E_WORKER_NOT_AVAILABLE: 409,
  E_WORKER_CAPABILITY_MISMATCH: 409,
  E_PROJECT_AFFINITY_REQUIRED: 409,
  E_RECONCILIATION_REQUIRED: 409,
  E_REVISION_CONFLICT: 409,
  E_AFFINITY_CONFLICT: 409,
  E_JOB_NOT_FOUND: 404,
  E_JOB_NOT_CANCELABLE: 409,
  E_JOB_NOT_RETRYABLE: 409,
  E_ATTEMPT_ALREADY_OWNED: 409,
  E_ATTEMPT_POSSIBLY_SUBMITTED: 409,
  E_ATTEMPT_TERMINAL: 409,
  E_OFFER_NOT_SAFE_TO_RETRY: 409,
  E_INVALID_STATE_TRANSITION: 409
});

// Codes whose *message* is safe to show the client verbatim. E_INTERNAL and
// E_CONFIG_INVALID are NEVER echoed with detail in production (generic text instead).
const CLIENT_SAFE_MESSAGE = new Set([
  "E_NOT_FOUND", "E_METHOD_NOT_ALLOWED", "E_BAD_REQUEST", "E_PAYLOAD_TOO_LARGE",
  "E_DEPENDENCY_NOT_READY", "E_FEATURE_DISABLED", "E_NOT_IMPLEMENTED",
  // pairing/operator codes carry only GENERIC messages (never reveal token/code validity detail)
  "E_OPERATOR_UNAUTHORIZED", "E_OPERATOR_FORBIDDEN", "E_PAIRING_DISABLED", "E_PAIRING_INVALID",
  "E_PAIRING_RATE_LIMITED", "E_WORKER_DISABLED", "E_CREDENTIAL_REVOKED", "E_CREDENTIAL_EXPIRED",
  "E_CREDENTIAL_ROTATION_REQUIRED", "E_IDEMPOTENCY_CONFLICT",
  // 5C.6 staging API — all carry only GENERIC, safe messages (stable codes, no internal detail)
  "E_STAGING_API_DISABLED", "E_PROJECT_NOT_FOUND", "E_PROJECT_ARCHIVED", "E_WORKER_NOT_FOUND",
  "E_WORKER_NOT_AVAILABLE", "E_WORKER_CAPABILITY_MISMATCH", "E_PROJECT_AFFINITY_REQUIRED",
  "E_RECONCILIATION_REQUIRED", "E_REVISION_CONFLICT", "E_AFFINITY_CONFLICT", "E_JOB_NOT_FOUND",
  "E_JOB_NOT_CANCELABLE", "E_JOB_NOT_RETRYABLE", "E_ATTEMPT_ALREADY_OWNED",
  "E_ATTEMPT_POSSIBLY_SUBMITTED", "E_ATTEMPT_TERMINAL", "E_OFFER_NOT_SAFE_TO_RETRY",
  "E_INVALID_STATE_TRANSITION"
]);

const RETRIABLE = new Set(["E_DEPENDENCY_NOT_READY", "E_INTERNAL"]);

export function isControlPlaneErrorCode(code) { return CODE_SET.has(code); }
export function httpStatusForCode(code) { return HTTP_STATUS[code] ?? 500; }

// A structured, throwable Control Plane error. `message` must already be sanitized by the
// throw site (no secret/value echo). `details` is an optional plain object of SAFE
// descriptors (field names, reason codes) for internal logging only — never sent public.
export class ControlPlaneError extends Error {
  constructor(code, message, details = undefined) {
    const safeCode = CODE_SET.has(code) ? code : CP_ERRORS.E_INTERNAL;
    super(typeof message === "string" && message ? message : safeCode);
    this.name = "ControlPlaneError";
    this.code = safeCode;
    this.retriable = RETRIABLE.has(safeCode);
    this.httpStatus = httpStatusForCode(safeCode);
    if (details && typeof details === "object") this.details = details;
  }

  // Public wire shape. In production, non-client-safe codes get a generic message so no
  // internal detail leaks. `correlationId` ties the response to a log line.
  toPublic({ correlationId = null, production = false } = {}) {
    let message = this.message;
    if (production && !CLIENT_SAFE_MESSAGE.has(this.code)) {
      message = this.code === CP_ERRORS.E_INTERNAL ? "Internal error" : "Request could not be completed";
    }
    return { code: this.code, message, retriable: this.retriable, correlationId };
  }
}

// Coerce any thrown value into a ControlPlaneError WITHOUT leaking its message.
// An arbitrary Error could embed a secret/path, so only a ControlPlaneError keeps its
// message; everything else collapses to a generic E_INTERNAL.
export function toControlPlaneError(err) {
  if (err instanceof ControlPlaneError) return err;
  return new ControlPlaneError(CP_ERRORS.E_INTERNAL, "Internal error");
}

// Build the public error body directly (used by the router for fixed responses).
export function publicError(code, message, { correlationId = null, production = false } = {}) {
  return new ControlPlaneError(code, message).toPublic({ correlationId, production });
}
