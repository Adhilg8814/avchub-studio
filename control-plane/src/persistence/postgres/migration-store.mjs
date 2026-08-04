// P0 Step 5C.2 — migration ledger store. The ledger (cp_schema_migrations) records every
// applied migration with a SHA-256 checksum. Only cp_migrator may touch it (0010 revokes
// runtime grants). Takes an injected pg client so it is testable with a real client.

export const MIGRATION_ADVISORY_LOCK = Object.freeze({ key1: 1347830853, key2: 1 }); // fixed ('CP','M1')

const CREATE_LEDGER = `
CREATE TABLE IF NOT EXISTS cp_schema_migrations (
  version           integer PRIMARY KEY,
  name              text NOT NULL,
  checksum          text NOT NULL,
  applied_at        timestamptz NOT NULL DEFAULT now(),
  duration_ms       integer NOT NULL,
  applied_by_version text NULL
)`;

export async function ensureLedger(client) {
  await client.query(CREATE_LEDGER);
}

export async function listApplied(client) {
  const { rows } = await client.query(
    "SELECT version, name, checksum, applied_at, duration_ms, applied_by_version FROM cp_schema_migrations ORDER BY version ASC");
  return rows.map((r) => ({
    version: Number(r.version), name: r.name, checksum: r.checksum,
    appliedAt: r.applied_at, durationMs: Number(r.duration_ms), appliedByVersion: r.applied_by_version
  }));
}

export async function recordApplied(client, { version, name, checksum, durationMs, appliedByVersion }) {
  await client.query(
    "INSERT INTO cp_schema_migrations (version, name, checksum, duration_ms, applied_by_version) VALUES ($1,$2,$3,$4,$5)",
    [version, name, checksum, durationMs, appliedByVersion ?? null]);
}

// Session-level advisory lock so two concurrent runners cannot both apply (§4). Held for the
// whole run; released explicitly (or on disconnect).
export async function acquireAdvisoryLock(client) {
  await client.query("SELECT pg_advisory_lock($1,$2)", [MIGRATION_ADVISORY_LOCK.key1, MIGRATION_ADVISORY_LOCK.key2]);
}
export async function releaseAdvisoryLock(client) {
  try { await client.query("SELECT pg_advisory_unlock($1,$2)", [MIGRATION_ADVISORY_LOCK.key1, MIGRATION_ADVISORY_LOCK.key2]); }
  catch { /* best effort; session close releases it */ }
}
