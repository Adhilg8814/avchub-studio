// AVC Studio P0 Step 5B — stable, sanitized identity/pairing/credential errors.
//
// These are worker/control-local error codes (not wire-protocol envelope errors).
// Messages are generic and never echo a pairing code, credential, verifier, or
// Authorization header. Public authentication failures intentionally collapse
// several internal causes into a generic unauthorized result (see toPublic()).

export const IDENTITY_ERRORS = Object.freeze({
  E_PAIRING_CODE_INVALID: "E_PAIRING_CODE_INVALID",
  E_PAIRING_CODE_EXPIRED: "E_PAIRING_CODE_EXPIRED",
  E_PAIRING_CODE_USED: "E_PAIRING_CODE_USED",
  E_PAIRING_CODE_REVOKED: "E_PAIRING_CODE_REVOKED",
  E_PAIRING_RATE_LIMITED: "E_PAIRING_RATE_LIMITED",
  E_PAIRING_ATTEMPTS_EXCEEDED: "E_PAIRING_ATTEMPTS_EXCEEDED",
  E_PAIRING_PAYLOAD_INVALID: "E_PAIRING_PAYLOAD_INVALID",
  E_CREDENTIAL_INVALID: "E_CREDENTIAL_INVALID",
  E_CREDENTIAL_EXPIRED: "E_CREDENTIAL_EXPIRED",
  E_CREDENTIAL_REVOKED: "E_CREDENTIAL_REVOKED",
  E_CREDENTIAL_ROTATION_REQUIRED: "E_CREDENTIAL_ROTATION_REQUIRED",
  E_CREDENTIAL_ROTATION_INVALID: "E_CREDENTIAL_ROTATION_INVALID",
  E_CREDENTIAL_STORE_FAILED: "E_CREDENTIAL_STORE_FAILED",
  E_WORKER_REVOKED: "E_WORKER_REVOKED",
  E_REPAIR_REQUIRED: "E_REPAIR_REQUIRED",
  E_WORKSPACE_MISMATCH: "E_WORKSPACE_MISMATCH",
  E_RATE_LIMITED: "E_RATE_LIMITED"
});

export function identityError(code, message, details = undefined) {
  const err = new Error(String(message || code));
  err.name = "IdentityError";
  err.code = code;
  if (details && typeof details === "object") err.details = details;
  return err;
}

// Public-safe projection: never reveals whether a code/worker exists. Pairing
// failures collapse to a single "invalid" unless rate-limited; auth failures to
// a generic unauthorized. HTTP status is advisory for the local dev endpoint.
const PAIRING_GENERIC = new Set([
  IDENTITY_ERRORS.E_PAIRING_CODE_INVALID, IDENTITY_ERRORS.E_PAIRING_CODE_EXPIRED,
  IDENTITY_ERRORS.E_PAIRING_CODE_USED, IDENTITY_ERRORS.E_PAIRING_CODE_REVOKED
]);
export function toPublicError(err) {
  const code = err && err.code;
  if (PAIRING_GENERIC.has(code)) return { code: IDENTITY_ERRORS.E_PAIRING_CODE_INVALID, message: "Pairing code is invalid or expired", status: 401 };
  if (code === IDENTITY_ERRORS.E_PAIRING_RATE_LIMITED || code === IDENTITY_ERRORS.E_PAIRING_ATTEMPTS_EXCEEDED || code === IDENTITY_ERRORS.E_RATE_LIMITED) return { code: IDENTITY_ERRORS.E_PAIRING_RATE_LIMITED, message: "Too many attempts, try again later", status: 429 };
  if (code === IDENTITY_ERRORS.E_PAIRING_PAYLOAD_INVALID) return { code, message: "Invalid pairing request", status: 400 };
  if (code === IDENTITY_ERRORS.E_CREDENTIAL_INVALID || code === IDENTITY_ERRORS.E_CREDENTIAL_EXPIRED || code === IDENTITY_ERRORS.E_CREDENTIAL_REVOKED || code === IDENTITY_ERRORS.E_WORKER_REVOKED) return { code: IDENTITY_ERRORS.E_CREDENTIAL_INVALID, message: "Unauthorized", status: 401 };
  if (code === IDENTITY_ERRORS.E_CREDENTIAL_ROTATION_INVALID) return { code, message: "Rotation request invalid", status: 409 };
  return { code: IDENTITY_ERRORS.E_CREDENTIAL_INVALID, message: "Unauthorized", status: 401 };
}
