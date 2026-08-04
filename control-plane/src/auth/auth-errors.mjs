// P0 Step 5C.21 — native auth typed error contract + shared identity helpers.
//
// Auth errors are a SEPARATE namespace from the persistence DOMAIN_ERRORS so the auth layer can carry its
// own precise, testable codes without polluting the DB contract. The PUBLIC-facing HTTP layer (a later
// increment) collapses most of these to a single generic authentication failure (§5 — no account
// enumeration); the granular code exists for the server-side security/audit trail only.

export const AUTH_ERRORS = Object.freeze({
  AUTH_INVALID_ARGUMENT: "AUTH_INVALID_ARGUMENT",
  AUTH_CONTEXT_REQUIRED: "AUTH_CONTEXT_REQUIRED",
  // identity / tenancy
  AUTH_USER_NOT_FOUND: "AUTH_USER_NOT_FOUND",
  AUTH_EMAIL_TAKEN: "AUTH_EMAIL_TAKEN",
  AUTH_USER_DISABLED: "AUTH_USER_DISABLED",
  AUTH_WORKSPACE_NOT_FOUND: "AUTH_WORKSPACE_NOT_FOUND",
  AUTH_MEMBERSHIP_NOT_FOUND: "AUTH_MEMBERSHIP_NOT_FOUND",
  AUTH_MEMBERSHIP_EXISTS: "AUTH_MEMBERSHIP_EXISTS",
  AUTH_LAST_OWNER: "AUTH_LAST_OWNER",
  AUTH_ROLE_INVALID: "AUTH_ROLE_INVALID",
  // credentials
  AUTH_CREDENTIAL_MISSING: "AUTH_CREDENTIAL_MISSING",
  AUTH_CREDENTIAL_DISABLED: "AUTH_CREDENTIAL_DISABLED",
  AUTH_CREDENTIAL_CONFLICT: "AUTH_CREDENTIAL_CONFLICT",
  AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH",
  // MFA
  AUTH_MFA_REQUIRED: "AUTH_MFA_REQUIRED",
  AUTH_MFA_ENROLLMENT_REQUIRED: "AUTH_MFA_ENROLLMENT_REQUIRED",
  AUTH_MFA_NOT_PENDING: "AUTH_MFA_NOT_PENDING",
  AUTH_MFA_ALREADY_ACTIVE: "AUTH_MFA_ALREADY_ACTIVE",
  AUTH_MFA_NOT_ACTIVE: "AUTH_MFA_NOT_ACTIVE",
  AUTH_MFA_CODE_INVALID: "AUTH_MFA_CODE_INVALID",
  AUTH_MFA_REPLAY: "AUTH_MFA_REPLAY",
  AUTH_RECOVERY_CODE_INVALID: "AUTH_RECOVERY_CODE_INVALID",
  // tokens (invitation / reset / verify / bootstrap / pre-auth challenge)
  AUTH_TOKEN_INVALID: "AUTH_TOKEN_INVALID",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_TOKEN_CONSUMED: "AUTH_TOKEN_CONSUMED",
  AUTH_TOKEN_BINDING_MISMATCH: "AUTH_TOKEN_BINDING_MISMATCH",
  // sessions
  AUTH_SESSION_INVALID: "AUTH_SESSION_INVALID",
  AUTH_SESSION_EXPIRED: "AUTH_SESSION_EXPIRED",
  AUTH_SESSION_REVOKED: "AUTH_SESSION_REVOKED",
  // rate limit
  AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
  // generic public failure (the ONLY thing an unauthenticated caller should be able to distinguish)
  AUTH_GENERIC_FAILURE: "AUTH_GENERIC_FAILURE"
});

export function authError(code, message, extra = {}) {
  const e = new Error(message || code);
  e.code = AUTH_ERRORS[code] || code;
  e.authError = true;
  return Object.assign(e, extra);
}

// The Studio role set (0022 widened workspace_members to include MEMBER). EDITOR/REVIEWER/BILLING_OWNER
// remain valid in the DB CHECK for back-compat but the native-auth layer maps to this canonical set.
export const AUTH_ROLES = Object.freeze(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
export const AUTH_ROLE_SET = new Set(AUTH_ROLES);
// Legacy → canonical mapping (0002 roles) so old rows resolve to a V1 role.
export function canonicalRole(role) {
  const r = String(role || "").toUpperCase();
  if (r === "EDITOR") return "MEMBER";
  if (r === "REVIEWER") return "VIEWER";
  if (r === "BILLING_OWNER") return "ADMIN";
  return AUTH_ROLE_SET.has(r) ? r : null;
}

// Email normalization: trim, Unicode NFKC, lowercase. CITEXT already compares case-insensitively; this
// gives a STABLE stored/compared form (and defends against whitespace / homoglyph width variants). No
// provider-specific (gmail dot/plus) rewriting — that would silently merge distinct addresses.
export function normalizeEmail(email) {
  return String(email || "").normalize("NFKC").trim().toLowerCase();
}

// Minimal shape validation (a real MX check is out of scope). Rejects whitespace, missing @, empty parts.
export function isPlausibleEmail(email) {
  const e = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}
