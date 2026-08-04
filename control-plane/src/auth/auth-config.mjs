// P0 Step 5C.21B — auth timing/policy configuration + public result allowlist. All timeouts are here (never
// scattered) and injectable so tests drive them with a fake clock. Defaults are security-sane and
// production-tunable; the FINAL production timeouts are locked in a later increment.

export const AUTH_CONFIG_DEFAULTS = Object.freeze({
  session: Object.freeze({
    idleTimeoutMs: 12 * 60 * 60_000,        // 12h of inactivity
    absoluteTimeoutMs: 7 * 24 * 60 * 60_000, // 7d hard cap (never extended by touch)
    touchThrottleMs: 60_000                  // write last_seen at most once/min
  }),
  preAuthChallengeTtlMs: 5 * 60_000,         // 5 min to complete MFA / enrollment
  reauthTtlMs: 5 * 60_000,                    // 5 min for a sensitive-action re-auth proof
  recoveryCodeCount: 10,                      // codes minted per set
  invitationTtlMs: 7 * 24 * 60 * 60_000,      // 7d to accept an invitation
  passwordResetTtlMs: 60 * 60_000,            // 1h to complete a reset
  emailVerifyTtlMs: 24 * 60 * 60_000,         // 24h to verify an email
  mfa: Object.freeze({ totpWindow: 1 }),     // ±1 timestep skew
  rateLimit: Object.freeze({
    email: Object.freeze({ windowMs: 15 * 60_000, maxFailures: 10 }),
    ip: Object.freeze({ windowMs: 15 * 60_000, maxFailures: 40 }),
    mfa: Object.freeze({ windowMs: 15 * 60_000, maxFailures: 8 })
  }),
  argon2Params: Object.freeze({ memoryCost: 19456, timeCost: 2, parallelism: 1 })
});

// V1 MFA policy: OWNER/ADMIN always; a per-user enforce flag always; MEMBER only if the workspace requires
// it; VIEWER optional. (WebAuthn deferred; recovery codes are managed in Checkpoint C.)
export function roleRequiresMfa(role, { userMfaEnforced = false, workspaceRequiresMfa = false } = {}) {
  if (role === "OWNER" || role === "ADMIN") return true;
  if (userMfaEnforced === true) return true;
  if (role === "MEMBER" && workspaceRequiresMfa === true) return true;
  return false;
}

// The ONLY result shapes an unauthenticated caller can distinguish (§17). Internal AUTH_* codes never leak.
export const AUTH_PUBLIC_RESULT = Object.freeze({
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  WORKSPACE_SELECTION_REQUIRED: "WORKSPACE_SELECTION_REQUIRED",
  MFA_ENROLLMENT_REQUIRED: "MFA_ENROLLMENT_REQUIRED",
  MFA_REQUIRED: "MFA_REQUIRED",
  SESSION_ISSUED: "SESSION_ISSUED",
  SESSION_ACTIVE: "SESSION_ACTIVE",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_REVOKED: "SESSION_REVOKED",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  PASSWORD_POLICY_VIOLATION: "PASSWORD_POLICY_VIOLATION",
  OK: "OK"
});
