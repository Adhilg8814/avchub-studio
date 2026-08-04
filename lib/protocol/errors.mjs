// AVC Studio Worker Protocol v1 — error constants + ProtocolError.
//
// PURE MODULE. Zero imports. Safe for both cloud and Worker. No fs/path/
// child_process/http/WebSocket/browser/Python/storage/env access.
//
// Error messages are SANITIZED: they may name the offending FIELD but must
// never echo the offending VALUE (a value could be a cookie/token/path). Every
// throw site passes only a safe descriptor.
//
// Spec: docs/protocol-v1.md §8, docs/local-first-saas-architecture.md.

export const PROTOCOL_ERRORS = Object.freeze({
  E_PROTOCOL_VERSION: "E_PROTOCOL_VERSION",
  E_UNKNOWN_TYPE: "E_UNKNOWN_TYPE",
  E_INVALID_ENVELOPE: "E_INVALID_ENVELOPE",
  E_INVALID_ID: "E_INVALID_ID",
  E_TIMESTAMP_SKEW: "E_TIMESTAMP_SKEW",
  E_PAYLOAD_TOO_LARGE: "E_PAYLOAD_TOO_LARGE",
  E_IDENTITY_MISMATCH: "E_IDENTITY_MISMATCH",
  E_INVALID_TRANSITION: "E_INVALID_TRANSITION",
  E_UNKNOWN_ACTION: "E_UNKNOWN_ACTION",
  E_INVALID_JOB_INPUT: "E_INVALID_JOB_INPUT",
  E_DANGEROUS_FIELD: "E_DANGEROUS_FIELD",
  E_DURATION_OPTION_UNAVAILABLE: "E_DURATION_OPTION_UNAVAILABLE",
  E_CAPABILITY_UNAVAILABLE: "E_CAPABILITY_UNAVAILABLE",
  E_DUPLICATE_REQUEST: "E_DUPLICATE_REQUEST",
  E_QUOTA_RETRY_CONFIRMATION_REQUIRED: "E_QUOTA_RETRY_CONFIRMATION_REQUIRED",
  // The worker is draining or stopped and cannot accept a new job offer; the cloud
  // should re-route the offer to another worker (recovery contract §8 — drain).
  E_WORKER_UNAVAILABLE: "E_WORKER_UNAVAILABLE"
});

const ERROR_CODE_SET = new Set(Object.values(PROTOCOL_ERRORS));

export function isProtocolErrorCode(code) {
  return ERROR_CODE_SET.has(code);
}

// A structured, throwable protocol error. `code` is one of PROTOCOL_ERRORS.
// `message` must already be sanitized (no secret/value echoing). `details` is
// an optional plain object of SAFE descriptors (field names, expected shapes),
// never raw offending values.
export class ProtocolError extends Error {
  constructor(code, message, details = undefined) {
    if (!ERROR_CODE_SET.has(code)) {
      // Defensive: an unknown code itself is a bug — surface it safely.
      super(`ProtocolError with unknown code: ${String(code)}`);
      this.code = PROTOCOL_ERRORS.E_INVALID_ENVELOPE;
    } else {
      super(String(message || code));
      this.code = code;
    }
    this.name = "ProtocolError";
    if (details && typeof details === "object") this.details = details;
  }

  // Wire-safe JSON: only code + sanitized message + safe details.
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.details) out.details = this.details;
    return out;
  }
}

// Convenience factory used by other pure modules.
export function protocolError(code, message, details) {
  return new ProtocolError(code, message, details);
}
