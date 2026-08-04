// P0 Step 5C.2 — explicit per-connection settings (§6). Applied on every pooled connection so
// correctness never depends on server-global config. Values are integers (validated ms) or
// fixed literals — never unsafe interpolation of user input.

// A safe application_name: only [A-Za-z0-9_.-], clamped. Used to identify the pool in pg_stat.
function safeAppName(raw) {
  return String(raw || "control-plane").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 63);
}

// clampInt: coerce to a safe non-negative integer (0 = disabled for timeouts).
function clampInt(v, def) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : def;
}

// connectionSettingsSql({ appName, statementTimeoutMs, lockTimeoutMs, idleInTxnMs }): array of
// SET statements. Timeouts are inlined as integers (safe); text values are single-quoted
// fixed literals.
export function connectionSettingsSql({ appName, statementTimeoutMs = 10000, lockTimeoutMs = 5000, idleInTxnMs = 15000 } = {}) {
  const app = safeAppName(appName);
  return [
    "SET timezone = 'UTC'",
    "SET search_path = public",
    "SET client_encoding = 'UTF8'",
    `SET application_name = '${app}'`,                        // app is sanitized to a safe charset
    `SET statement_timeout = ${clampInt(statementTimeoutMs, 10000)}`,
    `SET lock_timeout = ${clampInt(lockTimeoutMs, 5000)}`,
    `SET idle_in_transaction_session_timeout = ${clampInt(idleInTxnMs, 15000)}`
  ];
}

export { safeAppName };
