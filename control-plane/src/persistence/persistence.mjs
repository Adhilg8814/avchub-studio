// P0 Step 5C.1/5C.2 — persistence BOUNDARY.
//
//   * database.enabled === false → a clear DISABLED adapter (ready/non-blocking; operations
//     throw E_DEPENDENCY_NOT_READY). Preserved from Step 5C.1.
//   * database.enabled === true  → the real PostgreSQL adapter (Step 5C.2): separate tenant +
//     ops pools, tenantTransaction / opsEnumerate primitives, schema-compat readiness, NEVER
//     auto-migrates. Readiness is false until connected + schema is DATABASE_READY. If the pg
//     driver is absent or the DB is unreachable it fails SAFELY (not-ready), never faking a
//     connection.
//
// Role separation (implemented in 5C.2 bootstrap + 0010 grants):
//   cp_migrator          — owns/applies migrations (command-only; not in the running app)
//   cp_tenant_app        — NOBYPASSRLS; business transactions; app.current_workspace per txn
//   cp_ops_enumerator    — BYPASSRLS; SELECT-only on protocol/sweep tables; enumerate only
//   cp_readonly_observer — optional sanitized metric/health reads

import { ControlPlaneError, CP_ERRORS } from "../errors.mjs";
import { createPostgresAdapter } from "./postgres/adapter.mjs";

function rolesFrom(config) {
  return Object.freeze({
    migrator: config.database.migrationRole,
    tenantApp: config.database.appRole,
    opsEnumerator: config.database.opsRole,
    readonlyObserver: "cp_readonly_observer"
  });
}

function makeDisabledAdapter(config) {
  const roles = rolesFrom(config);
  const reject = () => { throw new ControlPlaneError(CP_ERRORS.E_DEPENDENCY_NOT_READY, "Persistence is disabled"); };
  return {
    kind: "disabled",
    roles,
    isEnabled() { return false; },
    async start() { /* no-op: nothing to connect */ },
    async stop() { /* no-op */ },
    health() {
      return {
        component: "persistence", enabled: false, initialized: true, ready: true,
        reasonCode: "DISABLED"
      };
    },
    async transaction() { return reject(); },
    async tenantTransaction() { return reject(); },
    async opsEnumerate() { return reject(); }
  };
}

// createPersistence(config, deps?): choose the adapter from config. DISABLED when the DB is
// off; the real PostgreSQL adapter when enabled (Step 5C.2). No driver is loaded until start().
export function createPersistence(config, deps = {}) {
  return config.database.enabled ? createPostgresAdapter(config, deps) : makeDisabledAdapter(config);
}
