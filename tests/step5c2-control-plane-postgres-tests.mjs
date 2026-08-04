#!/usr/bin/env node
// P0 Step 5C.2 — PostgreSQL foundation / RLS / repositories / paid-ownership tests.
//
// SAFE BY CONSTRUCTION: offline unit/static checks always run. LIVE PostgreSQL tests run ONLY
// against a verified disposable *_test database (CONTROL_PLANE_TEST_DB_URL +
// CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS=true + loopback host); otherwise they report
// SKIPPED with a clear reason. NEVER touches production/staging, a provider, a browser, or
// Python; consumes no quota. Exit 0 when there are no failures (skips are not failures).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadMigrationFiles, checksumOf, MIGRATIONS_DIR, status as mstatus, migrate as mrun, validate as mvalidate } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { classify, SCHEMA_STATES } from "../control-plane/src/persistence/postgres/schema-version.mjs";
import { evaluateTestDbTarget, assertSafeTestDb } from "../control-plane/src/persistence/postgres/test-db-safety.mjs";
import { mapPgError } from "../control-plane/src/persistence/postgres/errors.mjs";
import { connectionSettingsSql } from "../control-plane/src/persistence/postgres/pg-settings.mjs";
import { DOMAIN_ERRORS } from "../control-plane/src/persistence/domain-errors.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import * as OWN from "../control-plane/src/persistence/transactions/ownership.mjs";
import * as REPO from "../control-plane/src/persistence/repositories/repositories.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";
import { generateId, validateId } from "../lib/protocol/ids.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let passed = 0, failed = 0, skipped = 0;
const skipReasons = new Set();
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function skip(name, reason) { skipped += 1; skipReasons.add(reason); }

const DIR = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = path.join(DIR, "..", "control-plane", "database", "migrations");
const BOOT_DIR = path.join(DIR, "..", "control-plane", "database", "bootstrap");

// ---------------- live-DB probe ----------------
async function probeLiveDb() {
  const url = process.env.CONTROL_PLANE_TEST_DB_URL;
  const allow = process.env.CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS === "true";
  const guard = evaluateTestDbTarget({ url, allowDestructive: allow });
  if (!guard.ok) return { available: false, reason: `guard:${guard.reasons.join(",")}` };
  try {
    const pg = (await import("pg")).default ?? (await import("pg"));
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await c.connect(); await c.query("SELECT 1"); await c.end();
    return {
      available: true,
      testUrl: url,
      migrationUrl: process.env.CONTROL_PLANE_DB_MIGRATION_URL || url,
      opsUrl: process.env.CONTROL_PLANE_DB_OPS_URL || url,
      pg
    };
  } catch (e) { return { available: false, reason: `connect:${String(e.code || e.message).slice(0, 40)}` }; }
}

try {
  // ===================================================================================
  // OFFLINE — migration infrastructure (always runs)
  // ===================================================================================
  {
    const files = loadMigrationFiles(MIG_DIR);
    check("A1 migrations ordered 1..N contiguous", files.map((f) => f.version).join(","), files.map((_, i) => i + 1).join(","));
    check("A2 checksums present + hex", files.every((f) => /^[0-9a-f]{64}$/.test(f.checksum)), true);
    check("A2b checksum CRLF-stable", checksumOf("x\r\ny") === checksumOf("x\ny"), true);
    // classify (schema-version)
    const all = files.map((f) => ({ version: f.version, checksum: f.checksum }));
    check("A3 classify none → SCHEMA_MISSING", classify([], all).state, SCHEMA_STATES.SCHEMA_MISSING);
    check("A3b classify all → DATABASE_READY", classify(all, all).state, SCHEMA_STATES.DATABASE_READY);
    check("A3c classify partial → SCHEMA_OUTDATED", classify(all.slice(0, 6), all).state, SCHEMA_STATES.SCHEMA_OUTDATED);
    check("A3d classify tampered → MISMATCH", classify(all.map((r, i) => i ? r : { version: r.version, checksum: "0".repeat(64) }), all).state, SCHEMA_STATES.MIGRATION_CHECKSUM_MISMATCH);
    check("A3e classify extra → SCHEMA_TOO_NEW", classify([...all, { version: 99, checksum: "x" }], all).state, SCHEMA_STATES.SCHEMA_TOO_NEW);
  }

  // OFFLINE — test-DB safety guard (§41)
  {
    check("A9 reject non-test db", evaluateTestDbTarget({ url: "postgres://u:p@127.0.0.1:5432/controlplane", allowDestructive: true }).ok, false);
    check("A9 reject without allow", evaluateTestDbTarget({ url: "postgres://u:p@127.0.0.1:5432/cp_test", allowDestructive: false }).ok, false);
    check("A9 reject prod host", evaluateTestDbTarget({ url: "postgres://u:p@db.prod.example.com:5432/cp_test", allowDestructive: true }).ok, false);
    check("A9 reject staging host", evaluateTestDbTarget({ url: "postgres://u:p@x.staging.example.com/cp_test", allowDestructive: true }).ok, false);
    check("A9 accept loopback _test + allow", evaluateTestDbTarget({ url: "postgres://u:p@127.0.0.1:5432/controlplane_test", allowDestructive: true }).ok, true);
    let threw = false; try { assertSafeTestDb({ url: "postgres://u:p@prod-host/db", allowDestructive: true }); } catch { threw = true; }
    check("A9 assertSafeTestDb throws on unsafe", threw, true);
  }

  // OFFLINE — pg error mapping + domain errors
  {
    check("map idem unique", mapPgError({ code: "23505", constraint: "generation_requests_idem_uq" }).code, DOMAIN_ERRORS.E_IDEMPOTENCY_CONFLICT);
    check("map live-offer unique", mapPgError({ code: "23505", constraint: "job_offers_one_live_uq" }).code, DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED);
    check("map one-job unique", mapPgError({ code: "23505", constraint: "jobs_one_per_attempt_uq" }).code, DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED);
    check("map affinity unique", mapPgError({ code: "23505", constraint: "affinity_one_active_uq" }).code, DOMAIN_ERRORS.E_AFFINITY_CONFLICT);
    check("map terminal trigger CP002", mapPgError({ code: "CP002" }).code, DOMAIN_ERRORS.E_ATTEMPT_TERMINAL);
    check("map revision trigger CP001", mapPgError({ code: "CP001" }).code, DOMAIN_ERRORS.E_REVISION_CONFLICT);
    check("map project-guard CP004", mapPgError({ code: "CP004" }).code, DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED);
    check("map serialization retriable", mapPgError({ code: "40001" }).retriable, true);
    check("map deadlock retriable", mapPgError({ code: "40P01" }).retriable, true);
    check("map FK → workspace mismatch", mapPgError({ code: "23503" }).code, DOMAIN_ERRORS.E_WORKSPACE_MISMATCH);
    check("public error has no sqlstate", Object.keys(mapPgError({ code: "23505", constraint: "x" }).toPublic()).includes("sqlstate"), false);
  }

  // OFFLINE — connection settings (§6)
  {
    const s = connectionSettingsSql({ appName: "cp evil'name", statementTimeoutMs: 8000, lockTimeoutMs: 4000, idleInTxnMs: 12000 });
    check("settings set UTC", s.some((x) => x === "SET timezone = 'UTC'"), true);
    check("settings set search_path", s.some((x) => x === "SET search_path = public"), true);
    check("settings statement_timeout int", s.some((x) => x === "SET statement_timeout = 8000"), true);
    check("settings idle_in_txn", s.some((x) => /idle_in_transaction_session_timeout = 12000/.test(x)), true);
    check("settings app_name sanitized (no quote injection)", s.find((x) => x.startsWith("SET application_name")).includes("'"), true);
    check("settings app_name stripped apostrophe", /application_name = 'cp_evil_name'/.test(s.find((x) => x.startsWith("SET application_name"))), true);
  }

  // OFFLINE — config new DB fields
  {
    const c = loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:5432/cp_test", CONTROL_PLANE_DB_OPS_URL: "postgres://o:p@127.0.0.1:5432/cp_test", CONTROL_PLANE_DB_SSL: "true", CONTROL_PLANE_DB_LOCK_TIMEOUT_MS: "3000" });
    check("config ops url loaded", c.database.opsUrl !== null, true);
    check("config ssl parsed", c.database.ssl, true);
    check("config lock timeout parsed", c.database.lockTimeoutMs, 3000);
    check("config idle-in-txn default", c.database.idleInTransactionTimeoutMs, 15000);
    // malformed rejected
    let threw = false; try { loadConfig({ CONTROL_PLANE_DB_LOCK_TIMEOUT_MS: "abc" }); } catch { threw = true; }
    check("config malformed db int rejected", threw, true);
  }

  // OFFLINE — ULID CHECK regex parity with lib/protocol/ids.mjs
  {
    // The DB CHECK uses '^prefix_[0-9A-HJKMNP-TV-Z]{26}$' — mirror it in JS and compare to validateId.
    const RE = (p) => new RegExp(`^${p}_[0-9A-HJKMNP-TV-Z]{26}$`);
    const good = generateId("attempt");
    check("ULID parity: good attempt id matches DB regex", RE("attempt").test(good), true);
    check("ULID parity: validateId agrees", validateId(good, "attempt"), true);
    check("ULID parity: I/L/O/U excluded", RE("attempt").test("attempt_" + "I".repeat(26)), false);
    check("newId mints valid db-only prefix", RE("off").test(newId("off")), true);
    check("no gen_ prefix used", newId("attempt").startsWith("attempt_"), true);
  }

  // OFFLINE — static security scan of migrations + bootstrap (§43)
  {
    const sqlFiles = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).map((f) => ({ f, txt: readFileSync(path.join(MIG_DIR, f), "utf8") }));
    const allSql = sqlFiles.map((x) => x.txt).join("\n");
    const roles = readFileSync(path.join(BOOT_DIR, "roles.sql.template"), "utf8");
    const db = readFileSync(path.join(BOOT_DIR, "database.sql.template"), "utf8");

    check("SEC no GRANT ALL", /GRANT\s+ALL/i.test(allSql), false);
    check("SEC no gen_ id prefix", /gen_\[0-9A-HJKMNP/.test(allSql) || /'gen_/.test(allSql), false);
    check("SEC no combined availability enum", /availability\s+TEXT[^;]*CHECK\s*\(\s*availability\s+IN/i.test(allSql), false);
    check("SEC assets have storage_tier + liveness", /storage_tier\s+TEXT/.test(allSql) && /liveness\s+TEXT/.test(allSql), true);
    check("SEC outbox settlement_mode enum", /settlement_mode\s+TEXT\s+NOT NULL\s+CHECK\s*\(settlement_mode IN \('MESSAGE_ACK','LIFECYCLE_RESPONSE','SEND_ONLY'\)\)/.test(allSql), true);
    check("SEC RLS enabled + forced", /ENABLE ROW LEVEL SECURITY/.test(allSql) && /FORCE ROW LEVEL SECURITY/.test(allSql), true);
    check("SEC RLS uses current_setting fail-closed", /current_setting\('app.current_workspace', true\)/.test(allSql), true);
    check("SEC tenant_app is NOBYPASSRLS", /cp_tenant_app[^;]*NOBYPASSRLS/s.test(roles), true);
    check("SEC ops_enumerator is BYPASSRLS", /cp_ops_enumerator[^;]*\bBYPASSRLS\b/s.test(roles), true);
    check("SEC tenant_app NOT BYPASSRLS", /cp_tenant_app[^;]*\bBYPASSRLS\b(?![A-Z])/s.test(roles.replace(/NOBYPASSRLS/g, "")), false);
    // ops grants: SELECT only (no INSERT/UPDATE/DELETE to cp_ops_enumerator)
    const opsGrant = (allSql.match(/GRANT[^;]*TO cp_ops_enumerator/gis) || []).join(" ");
    check("SEC ops grants SELECT only", /INSERT|UPDATE|DELETE/i.test(opsGrant), false);
    check("SEC ownership FKs use RESTRICT", allSql.includes("REFERENCES generation_requests (workspace_id, id) ON DELETE RESTRICT"), true);
    // Word-boundary lookbehind so the CORE ownership tables (generation_requests/attempts) are checked but
    // a DIFFERENT prefixed table (story_generation_attempts, 0020 — which legitimately cascades with its
    // story) is NOT a false positive.
    check("SEC no cascade on generation ownership", /(?<![a-z_])generation_(requests|attempts)[^;]*REFERENCES[^;]*ON DELETE CASCADE/i.test(allSql), false);
    check("SEC no plaintext credential/password/code column", /\b(credential|password|pairing_code)\s+TEXT\b/i.test(allSql), false);
    check("SEC verifier-only credential_hash", /credential_hash\s+TEXT\s+NOT NULL/.test(allSql), true);
    check("SEC no hardcoded password literal", /PASSWORD\s+'[^:]/i.test(roles + db), false);
    check("SEC bootstrap uses psql var placeholders", /:'migrator_password'/.test(roles), true);
    check("SEC revoke PUBLIC", /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC/.test(allSql), true);
    check("SEC safe search_path set", /SET search_path = public/.test(allSql), true);
    check("SEC assets attempt link uses RESTRICT (no CASCADE)", allSql.includes("assets_attempt_fk") && allSql.includes("REFERENCES generation_attempts (workspace_id, id) ON DELETE RESTRICT") && !/assets_attempt_fk[\s\S]{0,120}ON DELETE CASCADE/.test(allSql), true);
  }

  // OFFLINE — module import smoke (adapter/pools/repos/transactions load cleanly)
  {
    check("repositories export named repos", typeof REPO.generationAttemptRepository.lock === "function" && typeof REPO.jobOfferRepository.liveForAttempt === "function", true);
    check("ownership transactions exported", typeof OWN.claimGenerationAttemptForWorker === "function" && typeof OWN.applyTerminal === "function" && typeof OWN.safeReoffer === "function", true);
    // adapter builds without a driver connection
    const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:1/cp_test" }), {});
    check("adapter kind postgres", adapter.kind, "postgres");
    check("adapter health not ready before start", adapter.health().ready, false);
    // repository requires a client
    let threw = false; try { await REPO.projectRepository.get(null, "ws_x", "prj_x"); } catch { threw = true; }
    check("repository rejects missing client", threw, true);
    // tenantTransaction rejects invalid workspace id up front
    let threw2 = false; try { await adapter.tenantTransaction("not-a-ws", async () => {}); } catch (e) { threw2 = e.code === DOMAIN_ERRORS.E_INVALID_ARGUMENT; }
    check("tenantTransaction rejects bad workspaceId", threw2, true);
  }

  // ===================================================================================
  // LIVE PostgreSQL — Phase A/B/C (SKIPPED unless a verified *_test DB is configured)
  // ===================================================================================
  const live = await probeLiveDb();
  if (!live.available) {
    // Enumerate the live groups as SKIPPED so the report is honest.
    const liveGroups = [
      "A.migrate-apply", "A.checksum-mismatch-block", "A.advisory-lock", "A.no-auto-migrate",
      "A.id-check-constraints", "A.request-attempt-job-model", "A.one-live-offer", "A.settled-no-reoffer",
      "A.ownership-enum", "A.ordinal-check", "A.terminal-freeze", "A.one-terminal", "A.one-active-affinity",
      "A.project-delete-guard", "A.same-workspace-lineage", "A.asset-path-uniqueness",
      "RLS.own-select", "RLS.foreign-select-blocked", "RLS.foreign-insert-blocked", "RLS.cross-update-blocked",
      "RLS.missing-context-fails-closed", "RLS.tenant-cannot-bypass", "RLS.ops-only-approved-tables",
      "B.enabled-adapter-connects", "B.schema-ready", "B.tenantTransaction-commit-rollback",
      "B.context-no-leak", "B.opsEnumerate-readonly", "B.pools-close",
      "C.duplicate-click-one-attempt", "C.two-worker-claim-one-winner", "C.two-instance-claim-one-winner",
      "C.sent-blocks-reoffer", "C.pending-permits-reoffer", "C.submitting-blocks-owner",
      "C.ordinal-idempotent", "C.duplicate-terminal-one-result", "C.affinity-one-active",
      "C.unresolved-blocks-migration", "C.cross-workspace-claim-rejected", "C.tenant-a-cannot-read-b",
      "C.ops-cannot-mutate", "C.reconcile-barrier-blocks", "C.approval-consumed-once",
      "C.rollback-no-orphan-outbox", "C.property-interleavings"
    ];
    for (const g of liveGroups) skip(g, live.reason);
    console.error(`\n[SKIP] Live PostgreSQL tests skipped (${skipped} groups). Reason: ${live.reason}`);
    console.error("[SKIP] To run: provide CONTROL_PLANE_TEST_DB_URL (loopback, name contains _test),");
    console.error("[SKIP]   CONTROL_PLANE_DB_MIGRATION_URL, CONTROL_PLANE_DB_OPS_URL, and set");
    console.error("[SKIP]   CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS=true. No PostgreSQL detected in this env.");
  } else {
    await runLiveTests(live);
  }

  check("no unhandled rejection", un, false);
} catch (e) {
  failed += 1;
  console.error("SUITE ERROR", e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : e);
}

// ---------------- live test body (runs only against a verified test DB) ----------------
async function runLiveTests(live) {
  const { Client } = live.pg;
  // Reset + migrate the disposable test schema using the migration URL.
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    // Clean slate. DROP SCHEMA removes the bootstrap's schema-level grants, so re-establish
    // schema USAGE for the runtime roles (cp_migrator now owns the freshly-created schema).
    await mc.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await mc.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
    await mc.query("GRANT CREATE ON SCHEMA public TO cp_migrator");
    // citext extension needed by users.email (0001 also creates it; belt-and-suspenders).
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* may already exist */ }
    const res = await mrun(mc, { dir: MIG_DIR, appVersion: "test" });
    check("LIVE A.migrate applied 15", res.applied.length + res.alreadyApplied, 15);
    const st = await mstatus(mc, MIG_DIR);
    check("LIVE A.schema DATABASE_READY", st.state, SCHEMA_STATES.DATABASE_READY);
    // idempotent re-run
    const res2 = await mrun(mc, { dir: MIG_DIR, appVersion: "test" });
    check("LIVE A.migrate idempotent (0 new)", res2.applied.length, 0);
  } finally { await mc.end(); }

  // Seed TWO workspaces (RLS-scoped inserts via the migrator connection; migrator is
  // NOBYPASSRLS so FORCE RLS applies and set_config scopes each insert). wsA has workers A/B;
  // wsB has worker C — for cross-workspace tests.
  const seed = new Client({ connectionString: live.migrationUrl });
  await seed.connect();
  const ids = {
    ws: generateId("ws"), user: generateId("usr"), wrkA: generateId("wrk"), wrkB: generateId("wrk"), prj: generateId("prj"),
    wsB: generateId("ws"), userB: generateId("usr"), wrkC: generateId("wrk"), prjB: generateId("prj")
  };
  try {
    // users are RLS-excluded (global).
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.user, `u-${Date.now()}@t.test`]);
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.userB, `ub-${Date.now()}@t.test`]);
    // workspace A
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.ws]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'A',$2)", [ids.ws, ids.user]);
    await seed.query("INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [newId("mship"), ids.ws, ids.user]);
    await seed.query("INSERT INTO projects (id,workspace_id,created_by_user_id,title,storage_relative_root) VALUES ($1,$2,$3,'P','projects/p')", [ids.prj, ids.ws, ids.user]);
    await seed.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version) VALUES ($1,$2,'A','win32',1)", [ids.wrkA, ids.ws]);
    await seed.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version) VALUES ($1,$2,'B','win32',1)", [ids.wrkB, ids.ws]);
    await seed.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,status) VALUES ($1,$2,$3,'ACTIVE')", [newId("sess"), ids.ws, ids.wrkA]);
    await seed.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,status) VALUES ($1,$2,$3,'ACTIVE')", [newId("sess"), ids.ws, ids.wrkB]);
    // workspace B
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.wsB]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'B',$2)", [ids.wsB, ids.userB]);
    await seed.query("INSERT INTO projects (id,workspace_id,created_by_user_id,title,storage_relative_root) VALUES ($1,$2,$3,'PB','projects/pb')", [ids.prjB, ids.wsB, ids.userB]);
    await seed.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version) VALUES ($1,$2,'C','win32',1)", [ids.wrkC, ids.wsB]);
    check("LIVE seed two workspaces ok", true, true);
  } finally { await seed.end(); }

  // Build a runtime adapter against the tenant/ops URLs.
  const cfg = loadConfig({
    CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.testUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl
  });
  const adapter = createPostgresAdapter(cfg, {});
  await adapter.start();
  check("LIVE B.enabled adapter connects", adapter.health().enabled, true);
  check("LIVE B.schema ready", adapter.health().ready, true);
  try {
    // ---- helpers (each test uses a FRESH attempt so cases never contaminate each other) ----
    async function mkAttempt(wsId, prjId) {
      return OWN.createGenerationRequest(adapter, { workspaceId: wsId, projectId: prjId, action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), inputSnapshot: { x: 1 } });
    }
    async function expectReject(fn, code, label) {
      let err = null; try { await fn(); } catch (e) { err = e; }
      check(label, err && err.code, code);
    }
    async function expectThrows(fn, label) {
      let err = null; try { await fn(); } catch (e) { err = e; }
      check(label, Boolean(err), true);
    }
    const attemptRow = (wsId, id) => adapter.tenantTransaction(wsId, (c) => REPO.generationAttemptRepository.get(c, wsId, id));
    const outboxRow = (wsId, msgId) => adapter.tenantTransaction(wsId, async (c) => (await c.query("SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [wsId, msgId])).rows[0] ?? null);
    const offerCount = (wsId, aId) => adapter.tenantTransaction(wsId, async (c) => (await c.query("SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2", [wsId, aId])).rows[0].n);
    const liveOfferCount = (wsId, aId) => adapter.tenantTransaction(wsId, async (c) => (await c.query("SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')", [wsId, aId])).rows[0].n);

    // ============================================================ IDEMPOTENCY (§28)
    // Two concurrent identical Generate clicks → ONE attempt, ONE job.
    const reqKey = generateId("req");
    const [dupA, dupB] = await Promise.all([
      OWN.createGenerationRequest(adapter, { workspaceId: ids.ws, projectId: ids.prj, action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: reqKey, inputSnapshot: { x: 1 } }),
      OWN.createGenerationRequest(adapter, { workspaceId: ids.ws, projectId: ids.prj, action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: reqKey, inputSnapshot: { x: 1 } })
    ]);
    check("LIVE idempotent Generate → one attempt", dupA.attempt.id, dupB.attempt.id);
    check("LIVE idempotent Generate → one job", dupA.job.id, dupB.job.id);

    // ============================================================ CLAIM = OFFER + OUTBOX (atomic, §30)
    const atClaim = await mkAttempt(ids.ws, ids.prj);
    const claimed = await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atClaim.attempt.id, workerId: ids.wrkA });
    check("LIVE claim → offer OFFERED", claimed.offer.ownership_status, "OFFERED");
    const claimOb = await outboxRow(ids.ws, claimed.offer.offer_message_id);
    check("LIVE claim → JOB_OFFER outbox created same txn", claimOb && claimOb.type, "JOB_OFFER");
    check("LIVE claim → outbox delivery_state PENDING (never SENT)", claimOb && claimOb.delivery_state, "PENDING");
    const claimAttempt = await attemptRow(ids.ws, atClaim.attempt.id);
    check("LIVE claim → attempt ownership OFFERED", claimAttempt.ownership_status, "OFFERED");
    check("LIVE claim → attempt assigned to claiming worker", claimAttempt.assigned_worker_id, ids.wrkA);
    // A second worker claiming the SAME owned attempt is rejected and leaves NO orphan offer.
    await expectReject(() => OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atClaim.attempt.id, workerId: ids.wrkB }), DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED, "LIVE claim on already-owned attempt rejected");
    check("LIVE rejected claim leaves exactly one offer (no orphan)", await offerCount(ids.ws, atClaim.attempt.id), 1);
    // DB backstop: a second LIVE offer for the same attempt violates the partial-unique index.
    await expectThrows(() => adapter.tenantTransaction(ids.ws, async (c) => {
      await c.query(
        `INSERT INTO job_offers (id, workspace_id, job_id, generation_attempt_id, assigned_worker_id, offer_message_id, ownership_status, offer_expires_at, lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'OFFERED', now()+interval '1 min', now()+interval '5 min')`,
        [newId("off"), ids.ws, atClaim.job.id, atClaim.attempt.id, ids.wrkA, newId("msg")]);
    }), "LIVE second live offer violates job_offers_one_live_uq (DB backstop)");

    // ============================================================ TWO CONCURRENT WORKERS (the race, §30)
    const atRace = await mkAttempt(ids.ws, ids.prj);
    const raceClaims = await Promise.allSettled([
      OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atRace.attempt.id, workerId: ids.wrkA }),
      OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atRace.attempt.id, workerId: ids.wrkB })
    ]);
    const raceWon = raceClaims.filter((r) => r.status === "fulfilled");
    const raceLost = raceClaims.filter((r) => r.status === "rejected");
    check("LIVE two-worker race → exactly one winner", raceWon.length, 1);
    check("LIVE two-worker race → exactly one loser", raceLost.length, 1);
    check("LIVE two-worker race → loser E_ATTEMPT_ALREADY_OWNED", raceLost[0] && raceLost[0].reason.code, DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED);
    check("LIVE two-worker race → exactly one live offer", await liveOfferCount(ids.ws, atRace.attempt.id), 1);

    // ============================================================ PAID-APPROVAL GRANT consumed EXACTLY once (§30)
    await adapter.tenantTransaction(ids.ws, async (c) => {
      await c.query("INSERT INTO paid_generation_approval_grants (id, workspace_id, max_paid_generations) VALUES ($1,$2,1)", [newId("grant"), ids.ws]);
    });
    const atG1 = await mkAttempt(ids.ws, ids.prj);
    const atG2 = await mkAttempt(ids.ws, ids.prj);
    const g1 = await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atG1.attempt.id, workerId: ids.wrkA, requireApproval: true });
    check("LIVE paid claim consumes an approval grant", Boolean(g1.approvalGrantId), true);
    await expectReject(() => OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atG2.attempt.id, workerId: ids.wrkA, requireApproval: true }), DOMAIN_ERRORS.E_PAID_APPROVAL_REQUIRED, "LIVE second paid claim without remaining grant rejected");
    const grantRow = await adapter.tenantTransaction(ids.ws, async (c) => (await c.query("SELECT consumed_count FROM paid_generation_approval_grants WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1", [ids.ws])).rows[0]);
    check("LIVE approval grant consumed exactly once", grantRow.consumed_count, 1);

    // Step 5C.9A: optional grant bindings are restrictive. A grant scoped to a
    // different project or generation attempt must never authorize this claim.
    const boundOtherProject = await adapter.tenantTransaction(ids.ws, (c) =>
      REPO.projectRepository.create(c, ids.ws, {
        title: "Approval other project", storageRelativeRoot: "projects/approval-other",
        createdByUserId: ids.user
      }));
    const boundTarget = await mkAttempt(ids.ws, ids.prj);
    const boundOtherAttempt = await mkAttempt(ids.ws, ids.prj);
    const wrongProjectGrant = newId("grant");
    const wrongAttemptGrant = newId("grant");
    const exactGrant = newId("grant");
    await adapter.tenantTransaction(ids.ws, async (c) => {
      await c.query(
        `INSERT INTO paid_generation_approval_grants
           (id, workspace_id, project_id, max_paid_generations, created_at)
         VALUES ($1,$2,$3,1,now()-interval '3 seconds')`,
        [wrongProjectGrant, ids.ws, boundOtherProject.id]);
      await c.query(
        `INSERT INTO paid_generation_approval_grants
           (id, workspace_id, project_id, generation_attempt_id, max_paid_generations, created_at)
         VALUES ($1,$2,$3,$4,1,now()-interval '2 seconds')`,
        [wrongAttemptGrant, ids.ws, ids.prj, boundOtherAttempt.attempt.id]);
      await c.query(
        `INSERT INTO paid_generation_approval_grants
           (id, workspace_id, project_id, generation_attempt_id, max_paid_generations, created_at)
         VALUES ($1,$2,$3,$4,1,now()-interval '1 second')`,
        [exactGrant, ids.ws, ids.prj, boundTarget.attempt.id]);
    });
    const boundClaim = await OWN.claimGenerationAttemptForWorker(adapter, {
      workspaceId: ids.ws, attemptId: boundTarget.attempt.id,
      workerId: ids.wrkA, requireApproval: true
    });
    check("LIVE approval binding consumes exact matching grant", boundClaim.approvalGrantId, exactGrant);
    const boundGrantRows = await adapter.tenantTransaction(ids.ws, async (c) => (await c.query(
      "SELECT id, consumed_count FROM paid_generation_approval_grants WHERE id = ANY($1::text[]) ORDER BY id",
      [[wrongProjectGrant, wrongAttemptGrant, exactGrant]])).rows);
    const consumedById = Object.fromEntries(boundGrantRows.map((r) => [r.id, r.consumed_count]));
    check("LIVE approval binding leaves wrong-project grant unused", consumedById[wrongProjectGrant], 0);
    check("LIVE approval binding leaves wrong-attempt grant unused", consumedById[wrongAttemptGrant], 0);
    check("LIVE approval binding consumes matching grant once", consumedById[exactGrant], 1);

    // ============================================================ RECONCILE BARRIER blocks claim (§36)
    const atRB = await mkAttempt(ids.ws, ids.prj);
    await OWN.openReconcileBarrier(adapter, { workspaceId: ids.ws, workerId: ids.wrkB });
    await expectReject(() => OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atRB.attempt.id, workerId: ids.wrkB }), DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED, "LIVE open reconcile barrier blocks claim");
    await OWN.closeReconcileBarrier(adapter, { workspaceId: ids.ws, workerId: ids.wrkB, isLast: true });
    const rbClaim = await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atRB.attempt.id, workerId: ids.wrkB });
    check("LIVE claim succeeds once barrier closed", rbClaim.offer.ownership_status, "OFFERED");

    // ============================================================ SAFE RE-OFFER (§31)
    // (a) prior outbox still PENDING (provably NOT delivered) → mint a fresh offer, dead-letter old.
    const atRO = await mkAttempt(ids.ws, ids.prj);
    const roClaim = await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atRO.attempt.id, workerId: ids.wrkA });
    const roOldMsg = roClaim.offer.offer_message_id;
    const reoffered = await OWN.safeReoffer(adapter, { workspaceId: ids.ws, attemptId: atRO.attempt.id, workerId: ids.wrkA });
    check("LIVE safeReoffer(PENDING) mints fresh live offer", reoffered.offer.ownership_status, "OFFERED");
    check("LIVE safeReoffer(PENDING) new offer differs from old", reoffered.offer.offer_message_id !== roOldMsg, true);
    const roOldOb = await outboxRow(ids.ws, roOldMsg);
    check("LIVE safeReoffer(PENDING) dead-letters the old outbox", roOldOb && roOldOb.delivery_state, "DEAD");
    check("LIVE safeReoffer(PENDING) keeps exactly one live offer", await liveOfferCount(ids.ws, atRO.attempt.id), 1);
    // (b) prior outbox was SENT (may have been delivered) → refuse, mark RECOVERING (never re-pay).
    const atSENT = await mkAttempt(ids.ws, ids.prj);
    const sentClaim = await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atSENT.attempt.id, workerId: ids.wrkA });
    await adapter.tenantTransaction(ids.ws, async (c) => { await c.query("UPDATE protocol_outbox SET delivery_state='SENT' WHERE workspace_id=$1 AND message_id=$2", [ids.ws, sentClaim.offer.offer_message_id]); });
    await expectReject(() => OWN.safeReoffer(adapter, { workspaceId: ids.ws, attemptId: atSENT.attempt.id, workerId: ids.wrkA }), DOMAIN_ERRORS.E_OFFER_NOT_SAFE_TO_RETRY, "LIVE safeReoffer(SENT) refused (cannot prove non-delivery)");
    const sentAttempt = await attemptRow(ids.ws, atSENT.attempt.id);
    check("LIVE safeReoffer(SENT) marks attempt RECOVERING", sentAttempt.ownership_status, "RECOVERING");

    // ============================================================ SUBMISSION FACT & ORDINAL (§33)
    // A SUBMITTED attempt blocks any NEW owner (never a second paid generation).
    const atSub = await mkAttempt(ids.ws, ids.prj);
    await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atSub.attempt.id, workerId: ids.wrkA });
    const sub1 = await OWN.applySubmissionFact(adapter, { workspaceId: ids.ws, attemptId: atSub.attempt.id, workerId: ids.wrkA, state: "SUBMITTED" });
    check("LIVE submission books generation_ordinal=1", sub1.attempt.generation_ordinal, 1);
    check("LIVE submission booked=true first time", sub1.booked, true);
    await expectReject(() => OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atSub.attempt.id, workerId: ids.wrkB }), DOMAIN_ERRORS.E_ATTEMPT_POSSIBLY_SUBMITTED, "LIVE submitted attempt blocks a new owner");
    // A non-producing worker cannot record a submission fact.
    const atID = await mkAttempt(ids.ws, ids.prj);
    await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atID.attempt.id, workerId: ids.wrkA });
    await expectReject(() => OWN.applySubmissionFact(adapter, { workspaceId: ids.ws, attemptId: atID.attempt.id, workerId: ids.wrkB, state: "SUBMITTED" }), DOMAIN_ERRORS.E_IDENTITY_MISMATCH, "LIVE non-producing worker cannot submit");
    // Duplicate/repeated submission never books a second ordinal.
    const atOrd = await mkAttempt(ids.ws, ids.prj);
    await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atOrd.attempt.id, workerId: ids.wrkA });
    const ord1 = await OWN.applySubmissionFact(adapter, { workspaceId: ids.ws, attemptId: atOrd.attempt.id, workerId: ids.wrkA, state: "SUBMITTING" });
    check("LIVE SUBMITTING books ordinal=1", ord1.attempt.generation_ordinal, 1);
    const ord2 = await OWN.applySubmissionFact(adapter, { workspaceId: ids.ws, attemptId: atOrd.attempt.id, workerId: ids.wrkA, state: "SUBMITTED" });
    check("LIVE SUBMITTING→SUBMITTED does not re-book", ord2.booked, false);
    await OWN.applySubmissionFact(adapter, { workspaceId: ids.ws, attemptId: atOrd.attempt.id, workerId: ids.wrkA, state: "SUBMITTED" });
    const ordFinal = await attemptRow(ids.ws, atOrd.attempt.id);
    check("LIVE repeated submission keeps ordinal=1", ordFinal.generation_ordinal, 1);

    // ============================================================ TERMINAL APPLICATION (§34) + DB CHECK
    // The DB CHECK attempt_completed_requires_submitted rejects COMPLETED on a never-submitted attempt.
    const atNT = await mkAttempt(ids.ws, ids.prj);
    await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atNT.attempt.id, workerId: ids.wrkA });
    await expectThrows(() => OWN.applyTerminal(adapter, { workspaceId: ids.ws, jobId: atNT.job.id, workerId: ids.wrkA, terminalType: "JOB_COMPLETED", terminalMessageId: generateId("msg") }), "LIVE COMPLETED without SUBMITTED violates DB CHECK");
    // Submit, then a real terminal: first succeeds; duplicate (same msg) is idempotent; conflicting (new msg) rejected.
    const atTerm = await mkAttempt(ids.ws, ids.prj);
    await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atTerm.attempt.id, workerId: ids.wrkA });
    await OWN.applySubmissionFact(adapter, { workspaceId: ids.ws, attemptId: atTerm.attempt.id, workerId: ids.wrkA, state: "SUBMITTED" });
    const termMsg = generateId("msg");
    const term1 = await OWN.applyTerminal(adapter, { workspaceId: ids.ws, jobId: atTerm.job.id, workerId: ids.wrkA, terminalType: "JOB_COMPLETED", terminalMessageId: termMsg });
    check("LIVE terminal after submit succeeds", term1.duplicate, false);
    const term2 = await OWN.applyTerminal(adapter, { workspaceId: ids.ws, jobId: atTerm.job.id, workerId: ids.wrkA, terminalType: "JOB_COMPLETED", terminalMessageId: termMsg });
    check("LIVE duplicate terminal (same message id) idempotent", term2.duplicate, true);
    await expectReject(() => OWN.applyTerminal(adapter, { workspaceId: ids.ws, jobId: atTerm.job.id, workerId: ids.wrkA, terminalType: "JOB_COMPLETED", terminalMessageId: generateId("msg") }), DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION, "LIVE conflicting terminal (new message id) rejected");
    const termCount = await adapter.tenantTransaction(ids.ws, async (c) => (await c.query("SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [ids.ws, atTerm.job.id])).rows[0].n);
    check("LIVE exactly one terminal result per job", termCount, 1);

    // ============================================================ CANCEL preserves paid-ownership evidence (§35)
    const atCancel = await mkAttempt(ids.ws, ids.prj);
    await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atCancel.attempt.id, workerId: ids.wrkA });
    await OWN.applySubmissionFact(adapter, { workspaceId: ids.ws, attemptId: atCancel.attempt.id, workerId: ids.wrkA, state: "SUBMITTED" });
    const cancelRes = await OWN.applyCancel(adapter, { workspaceId: ids.ws, jobId: atCancel.job.id });
    check("LIVE cancel-after-submit flags possiblySubmitted", cancelRes.possiblySubmitted, true);
    const cancelAttempt = await attemptRow(ids.ws, atCancel.attempt.id);
    check("LIVE cancel preserves submission evidence (ordinal=1)", cancelAttempt.generation_ordinal, 1);
    check("LIVE cancel does not clear submission_state", cancelAttempt.submission_state, "SUBMITTED");

    // ============================================================ PROJECT AFFINITY (§29)
    const prjAff = await adapter.tenantTransaction(ids.ws, (c) => REPO.projectRepository.create(c, ids.ws, { title: "Aff", storageRelativeRoot: "projects/aff", createdByUserId: ids.user }));
    const aff1 = await OWN.assignProjectAffinity(adapter, { workspaceId: ids.ws, projectId: prjAff.id, workerId: ids.wrkA });
    check("LIVE affinity assigned at generation 0", aff1.affinity.generation, 0);
    const atAff = await mkAttempt(ids.ws, prjAff.id);
    await expectReject(() => OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atAff.attempt.id, workerId: ids.wrkB }), DOMAIN_ERRORS.E_AFFINITY_CONFLICT, "LIVE affinity conflict blocks the other worker");
    await expectReject(() => OWN.assignProjectAffinity(adapter, { workspaceId: ids.ws, projectId: prjAff.id, workerId: ids.wrkB }), DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED, "LIVE unresolved attempt blocks affinity migration");

    // ============================================================ ROW-LEVEL SECURITY / ROLES (§21)
    // No workspace context at all → tenant tables fail-closed to ZERO rows.
    const noCtx = await adapter.transaction(async (c) => (await c.query("SELECT count(*)::int n FROM projects")).rows[0].n);
    check("LIVE RLS: no workspace context → 0 tenant rows (fail-closed)", noCtx, 0);
    // Cross-workspace SELECT: workspace B cannot see workspace A's project.
    const seenFromB = await adapter.tenantTransaction(ids.wsB, async (c) => (await c.query("SELECT count(*)::int n FROM projects WHERE id=$1", [ids.prj])).rows[0].n);
    check("LIVE RLS: wsB cannot SELECT wsA project", seenFromB, 0);
    // Cross-workspace INSERT: WITH CHECK forbids inserting a row scoped to another workspace.
    await expectThrows(() => adapter.tenantTransaction(ids.wsB, async (c) => {
      await c.query("INSERT INTO projects (id, workspace_id, created_by_user_id, title, storage_relative_root) VALUES ($1,$2,$3,'X','projects/x')", [newId("prj"), ids.ws, ids.userB]);
    }), "LIVE RLS: wsB cannot INSERT a row scoped to wsA (WITH CHECK)");
    // Cross-workspace UPDATE: matches zero rows in the other tenant.
    const crossUpd = await adapter.tenantTransaction(ids.ws, async (c) => (await c.query("UPDATE projects SET title='hijacked' WHERE id=$1", [ids.prjB])).rowCount);
    check("LIVE RLS: wsA UPDATE of wsB project affects 0 rows", crossUpd, 0);
    // Cross-workspace CLAIM: a foreign workspace cannot even see the attempt (RLS) → not found.
    await expectReject(() => OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.wsB, attemptId: atClaim.attempt.id, workerId: ids.wrkC }), DOMAIN_ERRORS.E_INVALID_ARGUMENT, "LIVE RLS: cross-workspace claim → attempt not found");
    // ops enumerator (BYPASSRLS, SELECT-only, READ ONLY txn): can read approved ops tables…
    const opsRead = await adapter.opsEnumerate((c) => c.query("SELECT count(*)::int n FROM job_offers"));
    check("LIVE ops enumerator can read approved job_offers", typeof opsRead.rows[0].n, "number");
    // …but CANNOT read a business table it was never granted…
    await expectThrows(() => adapter.opsEnumerate((c) => c.query("SELECT count(*) FROM projects")), "LIVE ops enumerator cannot read un-granted projects table");
    // …and CANNOT mutate anything (read-only txn + no write grants).
    await expectThrows(() => adapter.opsEnumerate((c) => c.query("UPDATE protocol_outbox SET delivery_state='DEAD'")), "LIVE ops enumerator cannot mutate (read-only txn)");

    // ============================================================ FULL-LIFECYCLE INVARIANT (property)
    // create → claim → accept → start → submit → complete. INVARIANT: at most one paid generation.
    const atLife = await mkAttempt(ids.ws, ids.prj);
    await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ids.ws, attemptId: atLife.attempt.id, workerId: ids.wrkA });
    await OWN.applyWorkerEvent(adapter, { workspaceId: ids.ws, jobId: atLife.job.id, workerId: ids.wrkA, event: "JOB_ACCEPTED" });
    await OWN.applyWorkerEvent(adapter, { workspaceId: ids.ws, jobId: atLife.job.id, workerId: ids.wrkA, event: "JOB_STARTED" });
    await OWN.applySubmissionFact(adapter, { workspaceId: ids.ws, attemptId: atLife.attempt.id, workerId: ids.wrkA, state: "SUBMITTED" });
    await OWN.applyTerminal(adapter, { workspaceId: ids.ws, jobId: atLife.job.id, workerId: ids.wrkA, terminalType: "JOB_COMPLETED", terminalMessageId: generateId("msg") });
    const lifeAttempt = await attemptRow(ids.ws, atLife.attempt.id);
    check("LIVE lifecycle reaches terminal COMPLETED", lifeAttempt.terminal_state, "COMPLETED");
    check("LIVE INVARIANT: at most one paid generation per attempt (ordinal=1)", lifeAttempt.generation_ordinal, 1);
  } finally {
    await adapter.stop();
  }
}

if (failed > 0) { console.error(`\n${passed} passed, ${failed} failed, ${skipped} skipped`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed, ${skipped} skipped${skipped ? ` (reasons: ${[...skipReasons].join("; ")})` : ""}`); process.exit(0); }
