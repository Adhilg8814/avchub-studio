// P0 Step 5C.2 — migration loader + runner. The loader + checksum are PURE (fs only, no pg)
// so they are testable offline. The runner takes an injected, already-connected pg client
// (the migrator connection) and applies pending migrations in order, each in its own
// transaction, under a session advisory lock. Normal service startup NEVER calls migrate().

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  ensureLedger, listApplied, recordApplied, acquireAdvisoryLock, releaseAdvisoryLock
} from "./migration-store.mjs";
import { classify, SCHEMA_STATES } from "./schema-version.mjs";

export const MIGRATIONS_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "database", "migrations");

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

// Stable checksum: SHA-256 over LF-normalized bytes (immune to CRLF / git autocrlf drift).
export function checksumOf(sqlText) {
  const normalized = String(sqlText).replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// loadMigrationFiles(dir?): ordered [{ version, name, filename, path, sql, checksum }].
export function loadMigrationFiles(dir = MIGRATIONS_DIR) {
  const entries = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  const seen = new Set();
  const out = [];
  for (const filename of entries) {
    const m = FILE_RE.exec(filename);
    const version = Number(m[1]);
    if (seen.has(version)) throw new Error(`duplicate migration version ${version} (${filename})`);
    seen.add(version);
    const full = path.join(dir, filename);
    const sql = readFileSync(full, "utf8");
    out.push({ version, name: filename.replace(/\.sql$/, ""), filename, path: full, sql, checksum: checksumOf(sql) });
  }
  // Contiguity check: versions must be 1..N with no gaps (ordered, immutable).
  out.forEach((f, i) => { if (f.version !== i + 1) throw new Error(`migration version gap at ${f.filename} (expected ${i + 1})`); });
  return out;
}

// status(client, dir?): { state, current, latest, pending, applied, files }.
export async function status(client, dir = MIGRATIONS_DIR) {
  await ensureLedger(client);
  const files = loadMigrationFiles(dir);
  const applied = await listApplied(client);
  const cls = classify(applied.map((a) => ({ version: a.version, checksum: a.checksum })),
    files.map((f) => ({ version: f.version, checksum: f.checksum })));
  return { ...cls, appliedCount: applied.length, fileCount: files.length, applied, files: files.map((f) => ({ version: f.version, name: f.name, checksum: f.checksum })) };
}

// validate(client, dir?): checksum-verify + classify, NO apply. Throws on checksum mismatch
// (a mismatch is a hard error — a migration was edited after being applied).
export async function validate(client, dir = MIGRATIONS_DIR) {
  const s = await status(client, dir);
  if (s.state === SCHEMA_STATES.MIGRATION_CHECKSUM_MISMATCH) {
    const e = new Error("migration checksum mismatch");
    e.code = "E_MIGRATION_CHECKSUM_MISMATCH";
    throw e;
  }
  return s;
}

// migrate(client, { dir, appVersion }): apply pending migrations in order. Returns a summary.
export async function migrate(client, { dir = MIGRATIONS_DIR, appVersion = null } = {}) {
  await acquireAdvisoryLock(client);       // §4: concurrent runners cannot both apply
  try {
    await ensureLedger(client);
    const files = loadMigrationFiles(dir);
    const applied = await listApplied(client);
    const appliedByV = new Map(applied.map((a) => [a.version, a.checksum]));

    // Verify checksums of everything already applied BEFORE applying anything new.
    for (const f of files) {
      if (appliedByV.has(f.version) && appliedByV.get(f.version) !== f.checksum) {
        const e = new Error(`checksum mismatch for migration ${f.filename}`);
        e.code = "E_MIGRATION_CHECKSUM_MISMATCH";
        throw e;
      }
    }

    const appliedNow = [];
    for (const f of files) {
      if (appliedByV.has(f.version)) continue;   // already applied
      const started = process.hrtime.bigint();
      try {
        await client.query("BEGIN");
        await client.query(f.sql);               // whole file as one simple-protocol query
        const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
        await recordApplied(client, { version: f.version, name: f.name, checksum: f.checksum, durationMs, appliedByVersion: appVersion });
        await client.query("COMMIT");
        appliedNow.push({ version: f.version, name: f.name, durationMs });
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch { /* */ }
        // Do NOT leak SQL text; surface a safe, versioned failure.
        const e = new Error(`migration ${f.filename} failed`);
        e.code = "E_MIGRATION_FAILED";
        e.version = f.version;
        e.sqlstate = err && err.code ? String(err.code) : null;
        throw e;
      }
    }
    return { applied: appliedNow, totalFiles: files.length, alreadyApplied: applied.length };
  } finally {
    await releaseAdvisoryLock(client);
  }
}
