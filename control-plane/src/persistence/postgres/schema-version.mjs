// P0 Step 5C.2 — schema compatibility classification (PURE; no pg). Compares the applied
// ledger against the migration files on disk and returns a stable state used by readiness
// (§22). No SQL text or credentials appear in the output.

export const SCHEMA_STATES = Object.freeze({
  DATABASE_CONNECTING: "DATABASE_CONNECTING",
  DATABASE_READY: "DATABASE_READY",
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  SCHEMA_MISSING: "SCHEMA_MISSING",
  SCHEMA_OUTDATED: "SCHEMA_OUTDATED",
  SCHEMA_TOO_NEW: "SCHEMA_TOO_NEW",
  MIGRATION_CHECKSUM_MISMATCH: "MIGRATION_CHECKSUM_MISMATCH"
});

// A schema state is "ready" only when it exactly matches the files with valid checksums.
export function isReadyState(state) { return state === SCHEMA_STATES.DATABASE_READY; }

// classify(appliedRows, files):
//   appliedRows: [{ version, checksum }]  (from cp_schema_migrations)
//   files:       [{ version, checksum }]  (from disk, ordered)
export function classify(appliedRows, files) {
  const appliedByV = new Map(appliedRows.map((r) => [r.version, r.checksum]));
  const fileByV = new Map(files.map((f) => [f.version, f.checksum]));
  const latest = files.length ? Math.max(...files.map((f) => f.version)) : 0;
  const current = appliedRows.length ? Math.max(...appliedRows.map((r) => r.version)) : 0;

  if (appliedRows.length === 0 && files.length > 0) {
    return summary(SCHEMA_STATES.SCHEMA_MISSING, current, latest, files, appliedByV);
  }
  // Any applied version we do not have a file for → the DB is ahead of this build.
  for (const [v] of appliedByV) {
    if (!fileByV.has(v)) return summary(SCHEMA_STATES.SCHEMA_TOO_NEW, current, latest, files, appliedByV);
  }
  // Checksum mismatch on any applied version → tampered/edited migration.
  for (const [v, sum] of appliedByV) {
    if (fileByV.get(v) !== sum) return summary(SCHEMA_STATES.MIGRATION_CHECKSUM_MISMATCH, current, latest, files, appliedByV);
  }
  if (appliedByV.size < fileByV.size) return summary(SCHEMA_STATES.SCHEMA_OUTDATED, current, latest, files, appliedByV);
  if (appliedByV.size > fileByV.size) return summary(SCHEMA_STATES.SCHEMA_TOO_NEW, current, latest, files, appliedByV);
  return summary(SCHEMA_STATES.DATABASE_READY, current, latest, files, appliedByV);
}

function summary(state, current, latest, files, appliedByV) {
  const pending = files.filter((f) => !appliedByV.has(f.version)).map((f) => f.version);
  return { state, current, latest, pending, ready: state === SCHEMA_STATES.DATABASE_READY };
}
