// P0 Step 5C.2 — PostgreSQL connection pools (§21). Separate tenant + ops (+ optional
// observer) pools with distinct credentials. pg is LAZY-imported so the codebase loads even
// when the driver is absent. Passwords/URLs are NEVER logged. Per-connection settings applied
// on every connection.

import { connectionSettingsSql } from "./pg-settings.mjs";
import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";

let PG = null;
async function loadPg() {
  if (PG) return PG;
  try { PG = (await import("pg")).default ?? (await import("pg")); return PG; }
  catch { throw domainError(DOMAIN_ERRORS.E_DB_UNAVAILABLE, "PostgreSQL driver (pg) is not installed"); }
}

// Never expose a connection string in a log/error. Extract only host+db for diagnostics.
export function safeConnDescriptor(url) {
  try { const u = new URL(url); return { host: u.hostname, port: u.port || "5432", database: decodeURIComponent(u.pathname.replace(/^\//, "")) }; }
  catch { return { host: "?", port: "?", database: "?" }; }
}

function makePool(pg, { url, max, ssl, appName, statementTimeoutMs, lockTimeoutMs, idleInTxnMs, logger }) {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: true
  });
  const settings = connectionSettingsSql({ appName, statementTimeoutMs, lockTimeoutMs, idleInTxnMs });
  // One combined statement so the settings apply atomically on connect WITHOUT issuing
  // concurrent queries on the same client (pg forbids overlapping queries on one connection).
  const settingsSql = settings.join("; ");
  pool.on("connect", (client) => {
    client.query(settingsSql).catch(() => { /* surfaced on first real use */ });
  });
  pool.on("error", (err) => {
    // A background idle-client error must never crash the process, and never log the URL.
    try { logger?.warn?.("pg_pool_error", { component: "persistence", reasonCode: err?.code || "PG_ERROR" }); } catch { /* */ }
  });
  return pool;
}

// createPools(config, { logger }): builds (but does not connect) the pools object.
export function createPools(config, { logger } = {}) {
  const db = config.database;
  let tenant = null, ops = null, observer = null, started = false;

  return {
    async start() {
      if (started) return;
      const pg = await loadPg();
      const common = {
        ssl: db.ssl, statementTimeoutMs: db.statementTimeoutMs, lockTimeoutMs: db.lockTimeoutMs,
        idleInTxnMs: db.idleInTransactionTimeoutMs, logger
      };
      tenant = makePool(pg, { url: db.url, max: db.poolMax, appName: `${config.deployment.instanceId}-tenant`, ...common });
      if (db.opsUrl) ops = makePool(pg, { url: db.opsUrl, max: db.opsPoolMax, appName: `${config.deployment.instanceId}-ops`, ...common });
      if (db.observerUrl) observer = makePool(pg, { url: db.observerUrl, max: 2, appName: `${config.deployment.instanceId}-observer`, ...common });
      // Prove the tenant pool can actually connect (fail-safe if it cannot).
      const c = await tenant.connect();
      try { await c.query("SELECT 1"); } finally { c.release(); }
      started = true;
    },

    tenantPool() { return tenant; },
    opsPool() { return ops; },
    observerPool() { return observer; },
    hasOps() { return Boolean(ops); },

    // Read the applied migration ledger via the tenant pool (SELECT-only grant, 0010).
    async readAppliedMigrations() {
      const { rows } = await tenant.query("SELECT version, checksum FROM cp_schema_migrations ORDER BY version ASC");
      return rows.map((r) => ({ version: Number(r.version), checksum: r.checksum }));
    },

    async ping() {
      const c = await tenant.connect();
      try { await c.query("SELECT 1"); return true; } finally { c.release(); }
    },

    async stop() {
      // Idempotent + parallel; double stop is harmless.
      const pools = [tenant, ops, observer].filter(Boolean);
      tenant = ops = observer = null; started = false;
      await Promise.allSettled(pools.map((p) => p.end()));
    }
  };
}
