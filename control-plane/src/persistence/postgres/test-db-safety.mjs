// P0 Step 5C.2 — test-database safety guard (§41). PURE. Live PostgreSQL tests and the
// reset:test command may run ONLY against a disposable test database. Every check must pass:
//   * an explicit test URL is provided;
//   * the database name contains "_test";
//   * CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS=true;
//   * host is a local/approved test host (loopback);
//   * NOT a production/staging hostname.
// Otherwise the target is REFUSED (no destructive action, no live test claim).

const PROD_HOST_MARKERS = [/prod/i, /staging/i, /avchub\.com/i, /amazonaws\.com/i, /rds\./i, /supabase/i, /neon\.tech/i];
const APPROVED_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "postgres", "db", "pg", "postgres-test"]);

function parseUrl(url) {
  try { return new URL(String(url)); } catch { return null; }
}

// evaluateTestDbTarget({ url, allowDestructive }): { ok, reasons: [...], host, database }.
export function evaluateTestDbTarget({ url, allowDestructive } = {}) {
  const reasons = [];
  if (!url) reasons.push("NO_TEST_URL");
  const u = parseUrl(url);
  if (url && !u) reasons.push("MALFORMED_URL");

  const host = u ? u.hostname : null;
  const database = u ? decodeURIComponent(u.pathname.replace(/^\//, "")) : null;

  if (allowDestructive !== true) reasons.push("DESTRUCTIVE_NOT_ALLOWED");
  if (u) {
    if (!database || !/_test(\b|$|_)/.test(database)) reasons.push("DB_NAME_NOT_TEST");
    if (host && PROD_HOST_MARKERS.some((re) => re.test(host))) reasons.push("PRODUCTION_LIKE_HOST");
    if (host && !APPROVED_HOSTS.has(host)) reasons.push("HOST_NOT_APPROVED");
  }
  return { ok: reasons.length === 0, reasons, host, database };
}

// assertSafeTestDb(target): throws unless the target is a verified disposable test DB.
export function assertSafeTestDb(target) {
  const r = evaluateTestDbTarget(target);
  if (!r.ok) {
    const e = new Error(`unsafe test database target: ${r.reasons.join(",")}`);
    e.code = "E_UNSAFE_TEST_DB";
    e.reasons = r.reasons;
    throw e;
  }
  return r;
}
