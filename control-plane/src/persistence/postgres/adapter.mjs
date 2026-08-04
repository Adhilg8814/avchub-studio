// P0 Step 5C.2 — real PostgreSQL persistence adapter (§21–§24). Replaces the Step 5C.1
// enabled-unimplemented adapter when database.enabled=true. NEVER auto-migrates. Liveness is
// independent of the DB; readiness reflects connectivity + schema compatibility.

import { AsyncLocalStorage } from "node:async_hooks";
import { validateId } from "../../../../lib/protocol/ids.mjs";
import { createPools } from "./pools.mjs";
import { classify, SCHEMA_STATES, isReadyState } from "./schema-version.mjs";
import { loadMigrationFiles } from "./migrations.mjs";
import { mapPgError, isRetryableSqlState } from "./errors.mjs";
import { domainError, DomainError, DOMAIN_ERRORS } from "../domain-errors.mjs";

const txnContext = new AsyncLocalStorage();

function sleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); }

export function createPostgresAdapter(config, { logger, now = () => new Date().toISOString() } = {}) {
  const pools = createPools(config, { logger });
  let started = false;
  let schemaState = SCHEMA_STATES.DATABASE_CONNECTING;
  // Migration files are known at build time; used to classify the applied ledger.
  let files = [];
  try { files = loadMigrationFiles().map((f) => ({ version: f.version, checksum: f.checksum })); } catch { files = []; }

  async function refreshSchemaState() {
    try {
      const applied = await pools.readAppliedMigrations();
      schemaState = classify(applied, files).state;
    } catch (err) {
      // Cannot read the ledger (connection lost / no table) → unavailable/missing.
      schemaState = (err && /relation .* does not exist/i.test(String(err.message))) ? SCHEMA_STATES.SCHEMA_MISSING : SCHEMA_STATES.DATABASE_UNAVAILABLE;
    }
  }

  return {
    kind: "postgres",
    roles: Object.freeze({ migrator: config.database.migrationRole, tenantApp: config.database.appRole, opsEnumerator: config.database.opsRole, readonlyObserver: "cp_readonly_observer" }),
    isEnabled() { return true; },

    // start(): connect + classify schema. Does NOT throw on DB-down/schema-not-ready — it
    // marks the adapter not-ready so the process stays live (§22).
    async start() {
      if (started) return;
      started = true;
      try {
        await pools.start();
        await refreshSchemaState();
      } catch (err) {
        schemaState = SCHEMA_STATES.DATABASE_UNAVAILABLE;
        logger?.warn?.("persistence_db_unavailable", { component: "persistence", reasonCode: err?.code || "E_DB_UNAVAILABLE" });
      }
    },

    async stop() { started = false; try { await pools.stop(); } catch { /* */ } },

    health() {
      return {
        component: "persistence", enabled: true, initialized: started,
        ready: isReadyState(schemaState), reasonCode: schemaState
      };
    },

    // Recompute schema state on demand (used by readiness probes / after reconnect).
    async refresh() { if (started) await refreshSchemaState(); return schemaState; },
    schemaState() { return schemaState; },

    // -------- tenantTransaction (§23) --------------------------------------------------
    async tenantTransaction(workspaceId, fn, options = {}) {
      if (!validateId(workspaceId, "ws")) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "invalid workspaceId");
      if (typeof fn !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "fn required");
      if (txnContext.getStore()) throw domainError(DOMAIN_ERRORS.E_NESTED_TRANSACTION, "nested tenantTransaction is not allowed");
      const tenant = pools.tenantPool();
      if (!tenant) throw domainError(DOMAIN_ERRORS.E_DB_UNAVAILABLE, "tenant pool not started");

      const maxRetries = Number.isInteger(options.retrySerialization) ? Math.max(0, Math.min(5, options.retrySerialization)) : 0;
      const isolation = options.isolation === "SERIALIZABLE" ? "SERIALIZABLE"
        : options.isolation === "REPEATABLE READ" ? "REPEATABLE READ" : null;

      let attempt = 0;
      // Retry ONLY on serialization/deadlock, and ONLY when the caller opts in (assuring the
      // callback has no external/provider side effects). Otherwise a serialization failure
      // surfaces to the caller.
      for (;;) {
        const client = await tenant.connect();
        try {
          await client.query("BEGIN");
          if (isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          // SET LOCAL (txn-scoped, auto-reset on COMMIT/ROLLBACK) — no leak into the next
          // checkout. Parameterized via set_config (never string-interpolated).
          await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
          if (options.requestId) await client.query("SELECT set_config('app.request_id', $1, true)", [String(options.requestId).slice(0, 64)]);
          const result = await txnContext.run({ workspaceId }, () => fn(client));
          await client.query("COMMIT");
          return result;
        } catch (err) {
          try { await client.query("ROLLBACK"); } catch { /* */ }
          const mapped = err instanceof DomainError ? err : mapPgError(err);
          if (mapped.code === DOMAIN_ERRORS.E_SERIALIZATION && attempt < maxRetries && isRetryableSqlState(err?.code)) {
            attempt += 1;
            await sleep(5 * attempt);
            continue;                       // retry a side-effect-free transaction
          }
          throw mapped;
        } finally {
          client.release();                 // always released
        }
      }
    },

    // Plain tenant-pool transaction with NO workspace context (RLS fail-closed → only
    // non-tenant tables like feature_flags are visible). For platform/non-tenant reads.
    async transaction(fn, options = {}) {
      const tenant = pools.tenantPool();
      if (!tenant) throw domainError(DOMAIN_ERRORS.E_DB_UNAVAILABLE, "tenant pool not started");
      const client = await tenant.connect();
      try {
        await client.query("BEGIN");
        const r = await fn(client);
        await client.query("COMMIT");
        return r;
      } catch (err) { try { await client.query("ROLLBACK"); } catch { /* */ } throw (err instanceof DomainError ? err : mapPgError(err)); }
      finally { client.release(); }
    },

    // -------- opsEnumerate (§24) -------------------------------------------------------
    // READ-ONLY enumeration on the ops pool (cp_ops_enumerator, BYPASSRLS). A READ ONLY
    // transaction makes any write attempt error — belt with the role's SELECT-only grants.
    async opsEnumerate(fn, options = {}) {
      const ops = pools.opsPool();
      if (!ops) throw domainError(DOMAIN_ERRORS.E_DB_UNAVAILABLE, "ops pool not configured");
      if (typeof fn !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "fn required");
      const client = await ops.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const r = await fn(client);
        await client.query("COMMIT");
        return r;
      } catch (err) { try { await client.query("ROLLBACK"); } catch { /* */ } throw (err instanceof DomainError ? err : mapPgError(err)); }
      finally { client.release(); }
    },

    _pools: pools
  };
}
