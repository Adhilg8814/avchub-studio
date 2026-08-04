// P0 Step 5C.22 — native-auth deployment flags + fail-closed enforcement gate. Production defaults keep
// native auth entirely OFF (Cloudflare Access remains the only gate); native routes/enforcement turn on only
// in local/test harnesses or behind an explicit, precondition-checked flag.

export const NATIVE_AUTH_DEFAULTS = Object.freeze({
  nativeAuthRoutesEnabled: false,       // mount /api/auth/* JSON routes
  nativeAuthEnforcementEnabled: false,  // enforce native session on protected routes/media/WS/SSE
  nativeAuthUiEnabled: false,           // serve native login/security documents
  cloudflareCutoverConfirmed: false,    // Access removed from the normal hostname (owner action only)
  cookieSecure: true,                   // __Host- cookie requires Secure; never relax in production
  allowedOrigins: []                    // exact origin allowlist (scheme+host+port)
});

// Enforcement may ONLY be enabled when every precondition holds (§18). Any missing prerequisite fails closed.
export function canEnableNativeEnforcement({
  flags = {}, dbMigrationVersion = 0, requiredMigration = 0,
  ownerBootstrapped = false, cookieSecure = true, sessionConfigPresent = false
} = {}) {
  const reasons = [];
  if (flags.nativeAuthEnforcementEnabled !== true) reasons.push("FLAG_OFF");
  if (!(Number(dbMigrationVersion) >= Number(requiredMigration))) reasons.push("MIGRATION_BEHIND");
  if (!ownerBootstrapped) reasons.push("OWNER_BOOTSTRAP_REQUIRED");
  if (cookieSecure !== true) reasons.push("COOKIE_INSECURE");
  if (!sessionConfigPresent) reasons.push("SESSION_CONFIG_MISSING");
  return { ok: reasons.length === 0, reasons };
}
