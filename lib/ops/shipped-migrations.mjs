// P0 Step 5C.29 Phase 0 — the number of migrations THIS build ships.
//
// Operational checks (health readiness, restore drills) must compare a database's applied-migration count
// against what the deployed code actually carries, NOT a hard-coded number: a hard-coded expectation silently
// turns every future migration into a false "not ready" / "drill failed" verdict at exactly the moment a
// deploy adds one. Derived from the repository migrations directory — the same source of truth the migrator
// itself uses. Fail-SAFE: when the directory cannot be read we return null and callers skip the comparison
// rather than fabricating a failure.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/u;
let cache;

export function shippedMigrationCount() {
  if (cache !== undefined) return cache;
  try {
    const dir = fileURLToPath(new URL("../../control-plane/database/migrations/", import.meta.url));
    cache = readdirSync(dir).filter((f) => MIGRATION_FILE.test(f)).length || null;
  } catch { cache = null; }
  return cache;
}
