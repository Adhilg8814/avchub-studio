#!/usr/bin/env node
// P0 Step 5C.3 — Transactional inbox/outbox PROCESSOR tests.
//
// SAFE BY CONSTRUCTION: offline unit/static checks always run. LIVE PostgreSQL tests run ONLY
// against a verified disposable *_test database (CONTROL_PLANE_TEST_DB_URL +
// CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS=true + loopback host); otherwise they report SKIPPED
// with a clear reason. NEVER opens a WSS, touches a provider/browser/Python, or consumes quota.
// Delivery uses an INJECTED deterministic fake adapter (tests/helpers). Exit 0 when no failures.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, safeConfigSummary } from "../control-plane/src/config/config.mjs";
import { evaluateTestDbTarget } from "../control-plane/src/persistence/postgres/test-db-safety.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { migrate as mrun } from "../control-plane/src/persistence/postgres/migrations.mjs";
import * as OWN from "../control-plane/src/persistence/transactions/ownership.mjs";
import { inboxRepository, outboxRepository, ackRepository } from "../control-plane/src/persistence/repositories/protocol-repository.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";
import { DOMAIN_ERRORS } from "../control-plane/src/persistence/domain-errors.mjs";

import { createClock } from "../control-plane/src/processor/clock.mjs";
import { createRetryPolicy, DELIVERY_RESULTS, dispositionFor, isDeliveryResult } from "../control-plane/src/processor/retry-policy.mjs";
import { assertSettlementMapSafe, settlementFor, orderingKeyFor, outboxTypesSettledBy, isCorrelatedResponse, ORDERING } from "../control-plane/src/processor/settlement-map.mjs";
import { createUnavailableDeliveryAdapter, isDeliveryAdapterUsable } from "../control-plane/src/processor/delivery-adapter.mjs";
import { createInboxService } from "../control-plane/src/processor/inbox-service.mjs";
import { createOutboxProcessor } from "../control-plane/src/processor/outbox-processor.mjs";
import { createOfferExpiryProcessor } from "../control-plane/src/processor/offer-expiry-processor.mjs";
import { createReconciliationProcessor } from "../control-plane/src/processor/reconciliation-processor.mjs";
import { createRetentionProcessor } from "../control-plane/src/processor/retention-processor.mjs";
import { createBackgroundProcessor } from "../control-plane/src/processor/processor.mjs";
import { CLOUD_TO_WORKER } from "../lib/protocol/message-types.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { createFakeDeliveryAdapter } from "./helpers/fake-delivery-adapter.mjs";

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
const PROC_DIR = path.join(DIR, "..", "control-plane", "src", "processor");

async function probeLiveDb() {
  const url = process.env.CONTROL_PLANE_TEST_DB_URL;
  const allow = process.env.CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS === "true";
  const guard = evaluateTestDbTarget({ url, allowDestructive: allow });
  if (!guard.ok) return { available: false, reason: `guard:${guard.reasons.join(",")}` };
  try {
    const pg = (await import("pg")).default ?? (await import("pg"));
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await c.connect(); await c.query("SELECT 1"); await c.end();
    return { available: true, testUrl: url, migrationUrl: process.env.CONTROL_PLANE_DB_MIGRATION_URL || url, opsUrl: process.env.CONTROL_PLANE_DB_OPS_URL || url, pg };
  } catch (e) { return { available: false, reason: `connect:${String(e.code || e.message).slice(0, 40)}` }; }
}

try {
  // ============================ OFFLINE — settlement map (canonical, single source) ============
  {
    check("settlement map self-check passes", assertSettlementMapSafe(), true);
    for (const t of CLOUD_TO_WORKER) check(`settlement descriptor exists: ${t}`, Boolean(settlementFor(t)), true);
    check("JOB_OFFER is LIFECYCLE_RESPONSE", settlementFor("JOB_OFFER").mode, "LIFECYCLE_RESPONSE");
    check("JOB_OFFER settled by accept/reject", settlementFor("JOB_OFFER").settledBy.join(","), "JOB_ACCEPTED,JOB_REJECTED");
    check("JOB_OFFER ordering (worker,job)", orderingKeyFor("JOB_OFFER", { workerId: "wrk_a", jobId: "job_b" }), "wrk_a:job_b");
    check("JOB_CANCEL_REQUEST ordering (worker,job)", orderingKeyFor("JOB_CANCEL_REQUEST", { workerId: "wrk_a", jobId: "job_b" }), "wrk_a:job_b");
    check("STATE_RECONCILE_REQUEST ordering (worker)", orderingKeyFor("STATE_RECONCILE_REQUEST", { workerId: "wrk_a", jobId: "job_b" }), "wrk_a");
    check("WORKER_CREDENTIAL_ROTATE is MESSAGE_ACK", settlementFor("WORKER_CREDENTIAL_ROTATE").mode, "MESSAGE_ACK");
    check("PING/HELLO_ACK/MESSAGE_ACK are SEND_ONLY", ["PING", "HELLO_ACK", "MESSAGE_ACK"].every((t) => settlementFor(t).mode === "SEND_ONLY"), true);
    // SEND_ONLY forbidden for critical types
    check("JOB_OFFER not SEND_ONLY", settlementFor("JOB_OFFER").mode !== "SEND_ONLY", true);
    check("JOB_CANCEL_REQUEST not SEND_ONLY", settlementFor("JOB_CANCEL_REQUEST").mode !== "SEND_ONLY", true);
    check("WORKER_CREDENTIAL_ROTATE not SEND_ONLY", settlementFor("WORKER_CREDENTIAL_ROTATE").mode !== "SEND_ONLY", true);
    check("JOB_ACCEPTED settles JOB_OFFER", outboxTypesSettledBy("JOB_ACCEPTED").join(","), "JOB_OFFER");
    check("JOB_CANCELED settles JOB_CANCEL_REQUEST", outboxTypesSettledBy("JOB_CANCELED").join(","), "JOB_CANCEL_REQUEST");
    check("isCorrelatedResponse JOB_OFFER/JOB_ACCEPTED", isCorrelatedResponse("JOB_OFFER", "JOB_ACCEPTED"), true);
    check("isCorrelatedResponse JOB_OFFER/JOB_CANCELED false", isCorrelatedResponse("JOB_OFFER", "JOB_CANCELED"), false);
  }

  // ============================ OFFLINE — retry policy + clock + delivery adapter ==============
  {
    const rp = createRetryPolicy({ initialBackoffMs: 1000, maxBackoffMs: 8000, maxAttempts: 5 });
    check("backoff deterministic exp (no jitter default)", [rp.backoffMs(1), rp.backoffMs(2), rp.backoffMs(3), rp.backoffMs(4)].join(","), "1000,2000,4000,8000");
    check("backoff capped at maxBackoff", rp.backoffMs(10), 8000);
    check("shouldDeadLetter at maxAttempts", rp.shouldDeadLetter(5), true);
    check("shouldDeadLetter below max false", rp.shouldDeadLetter(4), false);
    check("jitter reproducible with seeded rng", createRetryPolicy({ rng: () => 0.25 }).backoffMs(1) === createRetryPolicy({ rng: () => 0.25 }).backoffMs(1), true);
    check("WORKER_OFFLINE releases (no count)", dispositionFor("WORKER_OFFLINE").kind, "release");
    check("BACKPRESSURE retry not counted", dispositionFor("BACKPRESSURE").counts, false);
    check("TRANSIENT_FAILURE counts", dispositionFor("TRANSIENT_FAILURE").counts, true);
    check("PERMANENT_FAILURE deadLetters", dispositionFor("PERMANENT_FAILURE").kind, "deadLetter");
    check("isDeliveryResult WRITTEN", isDeliveryResult(DELIVERY_RESULTS.WRITTEN), true);
    check("isDeliveryResult junk false", isDeliveryResult("NOPE"), false);

    let t = 1_000_000;
    const clk = createClock({ now: () => t });
    check("clock now injectable", clk.now(), 1_000_000);
    check("clock futureIso advances", clk.futureIso(5000), new Date(1_005_000).toISOString());
    let slept = false; await clk.sleep(0).then(() => { slept = true; });
    check("clock sleep(0) resolves", slept, true);
    const ac = new AbortController(); ac.abort();
    let aborted = false; await createClock().sleep(1000, ac.signal).catch((e) => { aborted = e.name === "AbortError"; });
    check("clock sleep rejects on abort", aborted, true);

    const un1 = createUnavailableDeliveryAdapter();
    check("unavailable adapter not usable", isDeliveryAdapterUsable(un1), false);
    let threwSend = false; await un1.sendToWorker().catch(() => { threwSend = true; });
    check("unavailable adapter send throws", threwSend, true);
    check("fake adapter usable", isDeliveryAdapterUsable(createFakeDeliveryAdapter()), true);
  }

  // ============================ OFFLINE — config gates + processor lifecycle ===================
  {
    const off = loadConfig({});
    check("processor OFF by default", off.processor.enabled, false);
    check("delivery OFF by default", off.processor.deliveryEnabled, false);
    check("sweeps OFF by default", [off.processor.offerExpirySweepEnabled, off.processor.reconciliationSweepEnabled, off.processor.retentionSweepEnabled].some(Boolean), false);
    check("summary exposes processor (no secrets)", typeof safeConfigSummary(off).processor.enabled, "boolean");
    const reject = (env) => { try { loadConfig(env); return null; } catch (e) { return e.code; } };
    check("processor requires DB", reject({ CONTROL_PLANE_PROCESSOR_ENABLED: "true" }), "E_CONFIG_INVALID");
    check("delivery requires processor", reject({ CONTROL_PLANE_PROCESSOR_DELIVERY_ENABLED: "true" }), "E_CONFIG_INVALID");
    check("sweep requires processor", reject({ CONTROL_PLANE_PROCESSOR_OFFER_EXPIRY_SWEEP_ENABLED: "true" }), "E_CONFIG_INVALID");
    check("maxBackoff<initial rejected", reject({ CONTROL_PLANE_PROCESSOR_INITIAL_BACKOFF_MS: "5000", CONTROL_PLANE_PROCESSOR_MAX_BACKOFF_MS: "1000", CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:5/cp_test" }), "E_CONFIG_INVALID");
    check("malformed int rejected", reject({ CONTROL_PLANE_PROCESSOR_BATCH_SIZE: "abc" }), "E_CONFIG_INVALID");

    const prOff = createBackgroundProcessor(loadConfig({}), { logger: null, adapter: null });
    await prOff.start();
    check("disabled processor ready no-op", prOff.getStatus().ready, true);
    check("disabled processor DISABLED", prOff.getStatus().reasonCode, "DISABLED");
    check("disabled runOnce skips", (await prOff.runOnce()).skipped, "DISABLED");
    await prOff.stop();
    // enabled but no DB adapter → not ready (fails safely), start/stop idempotent, no leaked timer
    const prOn = createBackgroundProcessor(loadConfig({ CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:5/cp_test", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0" }), { logger: null, adapter: null });
    check("enabled+noDB not ready", prOn.getStatus().ready, false);
    check("enabled+noDB reason DB_NOT_READY", prOn.getStatus().reasonCode, "DB_NOT_READY");
    check("enabled+noDB runOnce skips", (await prOn.runOnce()).skipped, "DB_NOT_READY");
    await prOn.start(); await prOn.start(); await prOn.stop(); await prOn.stop();
    check("start/stop idempotent", true, true);
  }

  // ============================ OFFLINE — static safety scan of processor modules ==============
  {
    const files = readdirSync(PROC_DIR).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(path.join(PROC_DIR, f), "utf8"));
    const all = files.join("\n");
    const repo = readFileSync(path.join(DIR, "..", "control-plane", "src", "persistence", "repositories", "protocol-repository.mjs"), "utf8");
    const mig12 = readFileSync(path.join(MIG_DIR, "0012_processor_outbox_claims.sql"), "utf8");
    check("SEC no setInterval in processor", /setInterval\s*\(/.test(all), false);
    check("SEC no hardcoded password/credential literal", /(password|credential)\s*[:=]\s*["'][^"']+["']/i.test(all), false);
    check("SEC no Authorization header handling", /authorization/i.test(all + repo), false);
    check("SEC no console.log of payload", /console\.log\([^)]*payload/i.test(all), false);
    check("SEC 0012 no GRANT ALL", /GRANT\s+ALL/i.test(mig12), false);
    check("SEC 0012 no CASCADE", /ON DELETE CASCADE/i.test(mig12), false);
    check("SEC 0012 only ALTERs new tables (protocol_outbox/worker_connection_sessions)", /ALTER TABLE (protocol_outbox|worker_connection_sessions)/.test(mig12) && !/DROP TABLE|CREATE TABLE/i.test(mig12), true);
    check("SEC repo uses claim_token guard on settles", /claim_token=\$/.test(repo), true);
    check("SEC repo parameterized (no template-literal values in SQL)", /query\(\s*`[^`]*\$\{/.test(repo), false);
    // Migrations are sequential, contiguous and start at 0001. This used to pin the literal list up to 0030,
    // which went stale the next time a migration was added and said nothing about the property that matters:
    // a gap or a duplicate number means two branches numbered a migration the same way, and the runner would
    // silently apply only one of them. Asserted as an invariant so it stays true at any count.
    const migs = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const numbers = migs.map((f) => Number(f.slice(0, 4)));
    check("migrations start at 0001", numbers[0], 1);
    check("migration numbers are unique", new Set(numbers).size, numbers.length);
    check("migration numbers are contiguous", numbers.every((n, i) => n === i + 1), true);
    check("migration numbering matches the file count", numbers[numbers.length - 1], migs.length);
  }

  // ============================ OFFLINE — module smoke ========================================
  {
    check("factories are functions", [createInboxService, createOutboxProcessor, createOfferExpiryProcessor, createReconciliationProcessor, createRetentionProcessor].every((f) => typeof f === "function"), true);
    check("ownership cores exported", typeof OWN.applyTerminalCore === "function" && typeof OWN.expireOfferCore === "function" && typeof OWN.claimGenerationAttemptForWorkerCore === "function", true);
    check("protocol repos exported", typeof inboxRepository.insert === "function" && typeof outboxRepository.claimDue === "function" && typeof ackRepository.record === "function", true);
  }

  // ============================ LIVE (skip unless verified *_test DB) ==========================
  const live = await probeLiveDb();
  if (!live.available) {
    const groups = [
      "INBOX.apply-once", "INBOX.dup-no-reapply", "INBOX.dup-cached-outcome", "INBOX.two-proc-one-apply",
      "INBOX.atomic-commit", "INBOX.atomic-rollback", "INBOX.crash-recovers", "INBOX.dedupe-before-skew",
      "INBOX.replay-fresh-sentAt", "INBOX.bad-identity-rejected", "INBOX.assigned-mismatch-rejected", "INBOX.cross-workspace-rejected",
      "OUTBOX.two-proc-no-dup-claim", "OUTBOX.claim-token-required", "OUTBOX.stale-cannot-update", "OUTBOX.expired-lease-reclaimed",
      "OUTBOX.bounded-batch", "OUTBOX.independent-progress", "OUTBOX.ops-enumerate-no-mutate", "OUTBOX.tenant-txn-updates",
      "DELIVERY.retry-same-msgid", "DELIVERY.retry-restamps-sentAt", "DELIVERY.offline-retry", "DELIVERY.stale-not-sent",
      "DELIVERY.backpressure-retry", "DELIVERY.permanent-deadletter", "DELIVERY.uncertain-conservative", "DELIVERY.crash-before-settle-replays",
      "DELIVERY.no-secret-log", "SETTLE.ack-settles", "SETTLE.mismatch-no-settle", "SETTLE.dup-ack-idempotent",
      "SETTLE.accept-settles-offer", "SETTLE.reject-settles-offer", "SETTLE.generic-ack-not-lifecycle", "SETTLE.reconcile-complete-settles",
      "SETTLE.reconcile-partial-no-settle", "SETTLE.stale-epoch-no-settle", "SETTLE.sendonly-after-write", "SETTLE.critical-not-sendonly",
      "ORDER.single-flight", "ORDER.diff-jobs-concurrent", "ORDER.diff-workers-concurrent", "ORDER.unblock-after-settle",
      "ORDER.cancel-not-wedged", "ORDER.lifecycle-unblocks", "EXPIRY.never-sent-reoffer", "EXPIRY.sent-no-reoffer",
      "EXPIRY.uncertain-no-reoffer", "EXPIRY.two-proc-one-replacement", "EXPIRY.no-evidence-allows", "EXPIRY.reconcile-evidence-blocks",
      "RECON.barrier-blocks-offer", "RECON.matching-epoch-releases", "RECON.timeout-keeps-possibly-submitted", "RECON.stale-batch-no-release",
      "RECON.timeout-no-new-attempt", "RETAIN.terminal-safe-cleaned", "RETAIN.unresolved-retained", "RETAIN.possibly-submitted-retained",
      "RETAIN.pending-ack-retained", "RETAIN.deadletter-retained", "RETAIN.bounded", "RETAIN.ownership-never-deleted",
      "LIFE.disabled-default", "LIFE.enabled-needs-db", "LIFE.enabled-delivery-needs-adapter", "LIFE.start-stop-idempotent",
      "LIFE.drain-stops-claims", "LIFE.no-leaked-timers", "LIFE.status-correct",
      "CRASH.two-instances-no-double", "CRASH.reclaim-after-lease", "CRASH.commit-deliverable", "CRASH.write-same-msgid",
      "CRASH.settlement-race-idempotent", "CRASH.deadletter-race-one", "PROPERTY.bounded-interleavings"
    ];
    for (const g of groups) skip(g, live.reason);
    console.error(`\n[SKIP] Live PostgreSQL processor tests skipped (${skipped} groups). Reason: ${live.reason}`);
    console.error("[SKIP] To run: provide CONTROL_PLANE_TEST_DB_URL (loopback, name contains _test),");
    console.error("[SKIP]   CONTROL_PLANE_DB_MIGRATION_URL, CONTROL_PLANE_DB_OPS_URL, and set CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS=true.");
  } else {
    await runLiveTests(live);
  }

  check("no unhandled rejection", un, false);
} catch (e) {
  failed += 1;
  console.error("SUITE ERROR", e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : e);
}

if (failed > 0) { console.error(`\n${passed} passed, ${failed} failed, ${skipped} skipped`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed, ${skipped} skipped${skipped ? ` (reasons: ${[...skipReasons].join("; ")})` : ""}`); process.exit(0); }

// =================================================================================================
// LIVE TEST BODY
// =================================================================================================
async function runLiveTests(live) {
  const { Client } = live.pg;

  // ---- reset schema + migrate from clean (disposable DB) ----
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    await mc.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await mc.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
    await mc.query("GRANT CREATE ON SCHEMA public TO cp_migrator");
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    await mrun(mc, { dir: MIG_DIR, appVersion: "5c3-test" });
    check("LIVE migrate applies (incl 0012)", true, true);
  } finally { await mc.end(); }

  // ---- seed two workspaces, workers, ACTIVE sessions (gateway_instance = this instance) ----
  const INSTANCE = "cp-test-A";
  const ids = {
    ws: generateId("ws"), user: generateId("usr"), prj: generateId("prj"),
    wrkA: generateId("wrk"), wrkB: generateId("wrk"),
    wsB: generateId("ws"), userB: generateId("usr"), prjB: generateId("prj"), wrkC: generateId("wrk")
  };
  const seed = new Client({ connectionString: live.migrationUrl });
  await seed.connect();
  try {
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.user, `u-${Date.now()}@t.test`]);
    await seed.query("INSERT INTO users (id,email) VALUES ($1,$2)", [ids.userB, `ub-${Date.now()}@t.test`]);
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.ws]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'A',$2)", [ids.ws, ids.user]);
    await seed.query("INSERT INTO projects (id,workspace_id,created_by_user_id,title,storage_relative_root) VALUES ($1,$2,$3,'P','projects/p')", [ids.prj, ids.ws, ids.user]);
    await seed.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version,status) VALUES ($1,$2,'A','win32',1,'ONLINE')", [ids.wrkA, ids.ws]);
    await seed.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version,status) VALUES ($1,$2,'B','win32',1,'ONLINE')", [ids.wrkB, ids.ws]);
    await seed.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,gateway_instance,session_id,status,connected_at) VALUES ($1,$2,$3,$4,$5,'ACTIVE',now())", [newId("sess"), ids.ws, ids.wrkA, INSTANCE, newId("sid")]);
    await seed.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,gateway_instance,session_id,status,connected_at) VALUES ($1,$2,$3,$4,$5,'ACTIVE',now())", [newId("sess"), ids.ws, ids.wrkB, INSTANCE, newId("sid")]);
    await seed.query("SELECT set_config('app.current_workspace',$1,false)", [ids.wsB]);
    await seed.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'B',$2)", [ids.wsB, ids.userB]);
    await seed.query("INSERT INTO projects (id,workspace_id,created_by_user_id,title,storage_relative_root) VALUES ($1,$2,$3,'PB','projects/pb')", [ids.prjB, ids.wsB, ids.userB]);
    await seed.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version,status) VALUES ($1,$2,'C','win32',1,'ONLINE')", [ids.wrkC, ids.wsB]);
    await seed.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,gateway_instance,session_id,status,connected_at) VALUES ($1,$2,$3,$4,$5,'ACTIVE',now())", [newId("sess"), ids.wsB, ids.wrkC, INSTANCE, newId("sid")]);
    check("LIVE seed ok", true, true);
  } finally { await seed.end(); }

  // ---- build adapter + processors (real clock; time-dependent cases backdate DB timestamps) ----
  const cfg = loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.testUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl });
  const adapter = createPostgresAdapter(cfg, {});
  await adapter.start();
  const clock = createClock();
  // Large batchSize so a single runOnce drains ALL currently-due rows (targeted assertions are not
  // starved by leftover PENDING rows from earlier cases). The bounded-batch case uses its own small processor.
  // settlementTimeoutMs/reconcileTimeoutMs are set LARGE (5 min) so that only rows a case
  // explicitly backdates get swept — a whole runOnce over accumulated test rows can otherwise
  // exceed a short window and re-arm a just-delivered row (a test artifact, not a product bug;
  // production uses bounded batches). Cases that exercise timeouts backdate by >5 min (e.g. −1h).
  const pcfg = { instanceId: INSTANCE, batchSize: 500, claimLeaseMs: 60000, deliveryTimeoutMs: 5000, settlementTimeoutMs: 300000, reconcileTimeoutMs: 300000, pollIntervalMs: 0, offlineRecheckMs: 100, retentionBatchSize: 500, retentionMs: 3600000, deadLetterRetentionMs: 86400000 };
  const retry = createRetryPolicy({ initialBackoffMs: 1000, maxBackoffMs: 8000, maxAttempts: 5 });
  const fake = createFakeDeliveryAdapter({ defaultResult: DELIVERY_RESULTS.WRITTEN });
  const outbox = createOutboxProcessor({ adapter, clock, deliveryAdapter: fake, retryPolicy: retry, config: pcfg, logger: null });
  const outboxB = createOutboxProcessor({ adapter, clock, deliveryAdapter: fake, retryPolicy: retry, config: { ...pcfg, instanceId: "cp-test-B" }, logger: null });
  const inbox = createInboxService({ adapter, clock, logger: null, skewMs: 120000 });
  const offerExpiry = createOfferExpiryProcessor({ adapter, clock, config: pcfg, logger: null });
  const reconciliation = createReconciliationProcessor({ adapter, clock, config: pcfg, logger: null });
  const retention = createRetentionProcessor({ adapter, clock, config: pcfg, logger: null });

  try {
    await runProcessorLiveCases({ adapter, clock, fake, outbox, outboxB, inbox, offerExpiry, reconciliation, retention, ids, INSTANCE, live });
  } finally {
    await adapter.stop();
  }
}

async function runProcessorLiveCases(ctx) {
  const { adapter, clock, fake, outbox, outboxB, inbox, offerExpiry, reconciliation, retention, ids, INSTANCE } = ctx;
  const { ws, prj, wrkA, wrkB, wsB, prjB, wrkC } = ids;
  const R = DELIVERY_RESULTS;
  const MSG = () => generateId("msg");
  const nowIso = () => clock.nowIso();

  // ---- helpers ----
  const exec = (w, sql, params) => adapter.tenantTransaction(w, (c) => c.query(sql, params));
  const q1 = async (w, sql, params) => (await exec(w, sql, params)).rows[0] ?? null;
  const insertOutbox = (w, o) => adapter.tenantTransaction(w, (c) => outboxRepository.insert(c, w, o));
  const obByMsg = (w, m) => q1(w, "SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [w, m]);
  const obById = (w, id) => q1(w, "SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND id=$2", [w, id]);
  const attemptRow = (w, id) => q1(w, "SELECT * FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [w, id]);
  const jobRow = (w, id) => q1(w, "SELECT * FROM jobs WHERE workspace_id=$1 AND id=$2", [w, id]);
  const offerById = (w, id) => q1(w, "SELECT * FROM job_offers WHERE workspace_id=$1 AND id=$2", [w, id]);
  const liveOffers = (w, a) => q1(w, "SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')", [w, a]).then((r) => r.n);
  const terminalCount = (w, j) => q1(w, "SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [w, j]).then((r) => r.n);
  const inboxByMsg = (w, wk, m) => q1(w, "SELECT * FROM protocol_inbox WHERE workspace_id=$1 AND worker_id=$2 AND message_id=$3", [w, wk, m]);
  const sessionRow = (w, wk) => q1(w, "SELECT * FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [w, wk]);
  const settleTok = (w, id, token, method, args) => adapter.tenantTransaction(w, (c) => outboxRepository[method](c, w, id, token, args));

  async function newOffer(worker, workspace = ws, project = prj) {
    const r = await OWN.createGenerationRequest(adapter, { workspaceId: workspace, projectId: project, action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), inputSnapshot: { x: 1 } });
    const c = await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: workspace, attemptId: r.attempt.id, workerId: worker });
    return { attemptId: r.attempt.id, jobId: r.job.id, offerId: c.offer.id, offerMsg: c.offer.offer_message_id };
  }
  function envIn(type, { w = ws, worker, job = null, payload = {}, messageId = MSG(), sentAt } = {}) {
    const e = { protocolVersion: 1, messageId, type, workspaceId: w, workerId: worker, sentAt: sentAt || nowIso(), payload };
    if (job) e.jobId = job;
    return e;
  }
  const sendIn = (worker, envelope, opts = {}) => inbox.processInboundEnvelope({ authenticatedWorkerId: worker, authenticatedWorkspaceId: opts.authWs || ws, connectionSessionId: null, envelope, receivedAtIso: opts.receivedAtIso || nowIso() });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  // Extra workers: D (no session → OFFLINE path), E (foreign-instance session → SESSION_STALE).
  const wrkD = generateId("wrk"), wrkE = generateId("wrk");
  await adapter.tenantTransaction(ws, async (c) => {
    await c.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version,status) VALUES ($1,$2,'D','win32',1,'ONLINE')", [wrkD, ws]);
    await c.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version,status) VALUES ($1,$2,'E','win32',1,'ONLINE')", [wrkE, ws]);
    await c.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,gateway_instance,session_id,status,connected_at) VALUES ($1,$2,$3,'other-instance',$4,'ACTIVE',now())", [newId("sess"), ws, wrkE, newId("sid")]);
  });

  // ============================ INBOX / DEDUPE ============================
  {
    // 1 new inbound applies once; 5 atomic commit (inbox + business + response outbox together)
    const o = await newOffer(wrkA);
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: o.attemptId, workerId: wrkA, state: "SUBMITTED" });
    const mComplete = MSG();
    const r1 = await sendIn(wrkA, envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId, messageId: mComplete, payload: { sequence: 9 } }));
    check("INBOX.apply-once outcome APPLIED", r1.outcome, "APPLIED");
    check("INBOX.apply-once terminal recorded", await terminalCount(ws, o.jobId), 1);
    check("INBOX.atomic inbox row present", Boolean(await inboxByMsg(ws, wrkA, mComplete)), true);
    const ackOb = await q1(ws, "SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND type='MESSAGE_ACK' AND payload->>'ackedMessageId'=$2", [ws, mComplete]);
    check("INBOX.atomic response MESSAGE_ACK outbox present", Boolean(ackOb), true);
    check("INBOX.atomic ack outbox SEND_ONLY + PENDING", ackOb && ackOb.settlement_mode === "SEND_ONLY" && ackOb.delivery_state === "PENDING", true);

    // 2 duplicate does not reapply; 3 duplicate returns cached outcome (ack replay)
    const r2 = await sendIn(wrkA, envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId, messageId: mComplete, payload: { sequence: 9 } }));
    check("INBOX.dup outcome DUPLICATE", r2.outcome, "DUPLICATE");
    check("INBOX.dup no second terminal", await terminalCount(ws, o.jobId), 1);
    check("INBOX.dup replays cached ack", r2.ackReplayed, true);

    // 8 dedupe BEFORE skew — a stale re-send of a known messageId is a duplicate, not a reject
    const rStale = await sendIn(wrkA, envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId, messageId: mComplete, sentAt: new Date(clock.now() - 10 * 60 * 1000).toISOString() }));
    check("INBOX.dedupe-before-skew (stale dup not rejected)", rStale.outcome, "DUPLICATE");

    // 9 a genuinely new message with a fresh sentAt for the same job replays fine (dedupe by messageId)
    const rFresh = await sendIn(wrkA, envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId, messageId: mComplete }));
    check("INBOX.replay same messageId fresh sentAt valid dup", rFresh.outcome, "DUPLICATE");
  }
  {
    // Step 5C.9A: WorkerRuntime places the safe internal submission reference
    // inside payload.result. The Processor must preserve it on the attempt.
    const o = await newOffer(wrkA);
    const providerSubmissionId = generateId("submission");
    const r = await sendIn(wrkA, envIn("JOB_COMPLETED", {
      worker: wrkA,
      job: o.jobId,
      payload: { sequence: 1, result: { providerSubmissionId } }
    }));
    check("INBOX.completed nested submission reference applied", r.outcome, "APPLIED");
    const attempt = await attemptRow(ws, o.attemptId);
    check("INBOX.completed nested submission reference persisted", attempt.provider_submission_id, providerSubmissionId);
  }
  {
    // 4 two concurrent processors, same messageId → exactly one business apply
    const o = await newOffer(wrkA);
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: o.attemptId, workerId: wrkA, state: "SUBMITTED" });
    const m = MSG();
    const env = envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId, messageId: m });
    const [a, b] = await Promise.all([sendIn(wrkA, env), sendIn(wrkA, env)]);
    const outcomes = [a.outcome, b.outcome].sort().join(",");
    check("INBOX.two-proc one APPLIED one DUPLICATE", outcomes, "APPLIED,DUPLICATE");
    check("INBOX.two-proc single terminal apply", await terminalCount(ws, o.jobId), 1);
  }
  {
    // 6 atomic rollback: inbox + business + response all roll back together on a thrown failure
    const o = await newOffer(wrkA);
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: o.attemptId, workerId: wrkA, state: "SUBMITTED" });
    const m = MSG();
    let threw = false;
    try {
      await adapter.tenantTransaction(ws, async (client) => {
        await inboxRepository.insert(client, ws, { workerId: wrkA, jobId: o.jobId, messageId: m, type: "JOB_COMPLETED", receivedAtIso: nowIso() });
        await OWN.applyTerminalCore(client, { workspaceId: ws, jobId: o.jobId, workerId: wrkA, terminalType: "JOB_COMPLETED", terminalMessageId: m });
        throw new Error("simulated infra failure");
      });
    } catch { threw = true; }
    check("INBOX.atomic-rollback threw", threw, true);
    check("INBOX.atomic-rollback no inbox row", Boolean(await inboxByMsg(ws, wrkA, m)), false);
    check("INBOX.atomic-rollback no terminal", await terminalCount(ws, o.jobId), 0);

    // 7 crash after commit before send → the persisted MESSAGE_ACK is delivered on the next drain
    const r = await sendIn(wrkA, envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId }));
    check("INBOX.crash-setup applied", r.outcome, "APPLIED");
    fake.clear();
    await outbox.runOnce();     // delivers the persisted PENDING MESSAGE_ACK (business not re-run)
    const ackDelivered = fake.sent.some((s) => s.type === "MESSAGE_ACK");
    check("INBOX.crash MESSAGE_ACK delivered on recovery", ackDelivered, true);
    check("INBOX.crash no second terminal", await terminalCount(ws, o.jobId), 1);
  }
  {
    // 10 bad authenticated identity; 11 assigned-worker mismatch; 12 cross-workspace
    const o = await newOffer(wrkA);
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: o.attemptId, workerId: wrkA, state: "SUBMITTED" });
    const rId = await sendIn(wrkB, envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId }));  // authed wrkB, body wrkA
    check("INBOX.bad-identity rejected", rId.code, DOMAIN_ERRORS.E_IDENTITY_MISMATCH);
    const rAssign = await sendIn(wrkB, envIn("JOB_COMPLETED", { worker: wrkB, job: o.jobId }));  // wrkB completing wrkA's job
    check("INBOX.assigned-mismatch rejected", rAssign.outcome, "REJECTED");
    check("INBOX.assigned-mismatch identity code", rAssign.code, DOMAIN_ERRORS.E_IDENTITY_MISMATCH);
    const rCross = await sendIn(wrkA, envIn("JOB_COMPLETED", { w: ws, worker: wrkA, job: o.jobId }), { authWs: wsB });
    check("INBOX.cross-workspace rejected", rCross.code, DOMAIN_ERRORS.E_IDENTITY_MISMATCH);
    check("INBOX.mismatch left job non-terminal", (await jobRow(ws, o.jobId)).status !== "SUCCEEDED", true);
  }

  // ============================ OUTBOX CLAIMING ============================
  {
    // 13/74 two instances claim due rows → disjoint (no duplicate active claim)
    const offers = [];
    for (let i = 0; i < 4; i++) offers.push(await newOffer(wrkA));
    const [ca, cb] = await Promise.all([outbox._claimBatch(ws), outboxB._claimBatch(ws)]);
    const idsA = new Set(ca.map((r) => r.id)), idsB = new Set(cb.map((r) => r.id));
    const overlap = [...idsA].filter((x) => idsB.has(x)).length;
    check("OUTBOX.two-proc no overlapping claim", overlap, 0);
    check("OUTBOX.two-proc union covers claimable", idsA.size + idsB.size >= 4, true);
    // 20 claims persisted via tenant txn (claim_token stamped)
    const someClaimed = ca[0] || cb[0];
    check("OUTBOX.tenant-txn stamped claim_token", Boolean(someClaimed && someClaimed.claim_token), true);
    // release them back so later tests see them PENDING (settle as offline-release using their token)
    for (const r of ca) await settleTok(ws, r.id, r._token, "releaseClaim", { nextAttemptAtIso: new Date(clock.now() - 1000).toISOString(), resultCode: "TEST_RELEASE" });
    for (const r of cb) await settleTok(ws, r.id, r._token, "releaseClaim", { nextAttemptAtIso: new Date(clock.now() - 1000).toISOString(), resultCode: "TEST_RELEASE" });
  }
  {
    // 14 claim token required; 15 stale claimant cannot update; 16 expired lease reclaimed
    const o = await newOffer(wrkA);
    const claimed = (await outbox._claimBatch(ws)).find((r) => r.message_id === o.offerMsg);
    check("OUTBOX.claimed the new row", Boolean(claimed), true);
    const wrongTok = await settleTok(ws, claimed.id, "clm_wrongtoken000000000000000", "markSentSettled", { sentAtIso: nowIso(), settledAtIso: nowIso(), resultCode: "X" });
    check("OUTBOX.claim-token-required (wrong token no-op)", wrongTok, null);
    // expire the lease, reclaim with instance B → new token; A's old token can no longer settle
    await exec(ws, "UPDATE protocol_outbox SET claim_expires_at = now() - interval '1 minute' WHERE workspace_id=$1 AND id=$2", [ws, claimed.id]);
    const reclaimed = (await outboxB._claimBatch(ws)).find((r) => r.id === claimed.id);
    check("OUTBOX.expired-lease reclaimed by other instance", Boolean(reclaimed), true);
    check("OUTBOX.reclaim new token differs", reclaimed && reclaimed.claim_token !== claimed.claim_token, true);
    const staleSettle = await settleTok(ws, claimed.id, claimed._token, "markSentSettled", { sentAtIso: nowIso(), settledAtIso: nowIso(), resultCode: "X" });
    check("OUTBOX.stale-claimant cannot settle", staleSettle, null);
    // finish it cleanly with the new token
    await settleTok(ws, claimed.id, reclaimed._token, "markAwaitingSettlement", { sentAtIso: nowIso(), awaitingSinceIso: nowIso(), resultCode: "WRITTEN", incAttempts: true });
  }
  {
    // 17 bounded batch
    for (let i = 0; i < 3; i++) await newOffer(wrkB);
    const small = createOutboxProcessor({ adapter, clock, deliveryAdapter: fake, retryPolicy: createRetryPolicy({}), config: { instanceId: "cp-small", batchSize: 2, claimLeaseMs: 30000, deliveryTimeoutMs: 5000, settlementTimeoutMs: 30000, pollIntervalMs: 0, offlineRecheckMs: 100 }, logger: null });
    const claimed = await small._claimBatch(ws);
    check("OUTBOX.bounded-batch respects batchSize", claimed.length <= 2, true);
    for (const r of claimed) await settleTok(ws, r.id, r._token, "releaseClaim", { nextAttemptAtIso: new Date(clock.now() - 1000).toISOString(), resultCode: "TEST" });
    // 19 ops pool cannot mutate business state (read-only enumeration)
    let opsBlocked = false;
    try { await adapter.opsEnumerate((c) => c.query("UPDATE protocol_outbox SET attempts = attempts + 1")); } catch { opsBlocked = true; }
    check("OUTBOX.ops-enumerate cannot mutate", opsBlocked, true);
  }
  {
    // 18 unrelated workers/jobs progress independently (offline worker does not block another)
    const oOnline = await newOffer(wrkA);
    const oOffline = await newOffer(wrkD);   // wrkD has NO session → OFFLINE
    fake.clear();
    await outbox.runOnce();
    check("OUTBOX.independent online worker delivered", (await obByMsg(ws, oOnline.offerMsg)).delivery_state, "SENT");
    check("OUTBOX.independent offline worker released PENDING", (await obByMsg(ws, oOffline.offerMsg)).delivery_state, "PENDING");
    check("OUTBOX.independent offline not sent to adapter", fake.sent.some((s) => s.messageId === oOffline.offerMsg), false);
  }

  // ============================ DELIVERY ============================
  {
    // 21 retry preserves messageId; 22 retry re-stamps sentAt
    const o = await newOffer(wrkA);
    fake.clear();
    fake.setMessageResult(o.offerMsg, R.TRANSIENT_FAILURE);
    await outbox.runOnce();
    const afterFail = await obByMsg(ws, o.offerMsg);
    check("DELIVERY.transient scheduled retry (still PENDING)", afterFail.delivery_state, "PENDING");
    check("DELIVERY.transient attempts incremented", afterFail.attempts >= 1, true);
    check("DELIVERY.transient messageId unchanged", afterFail.message_id, o.offerMsg);
    await pause(4);
    await exec(ws, "UPDATE protocol_outbox SET next_attempt_at = now() - interval '1 second' WHERE workspace_id=$1 AND message_id=$2", [ws, o.offerMsg]);
    fake.setMessageResult(o.offerMsg, R.WRITTEN);
    await outbox.runOnce();
    check("DELIVERY.retry preserves messageId (sent twice, same id)", fake.countFor(o.offerMsg), 2);
    const twoSent = fake.sent.filter((s) => s.messageId === o.offerMsg);
    check("DELIVERY.retry re-stamps sentAt (differs)", twoSent[0].sentAt !== twoSent[1].sentAt, true);
    check("DELIVERY.retry eventually SENT", (await obByMsg(ws, o.offerMsg)).delivery_state, "SENT");
  }
  {
    // 23 WORKER_OFFLINE schedules retry (no attempts++); 24 SESSION_STALE not sent to wrong session
    const oOff = await newOffer(wrkD);
    fake.clear();
    await outbox.runOnce();
    const off = await obByMsg(ws, oOff.offerMsg);
    check("DELIVERY.offline PENDING", off.delivery_state, "PENDING");
    check("DELIVERY.offline no attempts++", off.attempts, 0);
    check("DELIVERY.offline next_attempt scheduled", new Date(off.next_attempt_at).getTime() > clock.now() - 2000, true);
    const oStale = await newOffer(wrkE);   // wrkE session gateway_instance='other-instance'
    fake.clear();
    await outbox.runOnce();
    check("DELIVERY.session-stale not sent", fake.sent.some((s) => s.messageId === oStale.offerMsg), false);
    check("DELIVERY.session-stale released PENDING", (await obByMsg(ws, oStale.offerMsg)).delivery_state, "PENDING");
  }
  {
    // 25 BACKPRESSURE bounded retry; 26 PERMANENT_FAILURE dead-letters; 27 DELIVERY_UNCERTAIN conservative
    const oBp = await newOffer(wrkA); fake.clear(); fake.setMessageResult(oBp.offerMsg, R.BACKPRESSURE); await outbox.runOnce();
    const bp = await obByMsg(ws, oBp.offerMsg);
    check("DELIVERY.backpressure PENDING retry", bp.delivery_state, "PENDING");
    check("DELIVERY.backpressure no attempts++", bp.attempts, 0);
    check("DELIVERY.backpressure next_attempt future", new Date(bp.next_attempt_at).getTime() > clock.now(), true);

    const oPerm = await newOffer(wrkA); fake.clear(); fake.setMessageResult(oPerm.offerMsg, R.PERMANENT_FAILURE); await outbox.runOnce();
    const perm = await obByMsg(ws, oPerm.offerMsg);
    check("DELIVERY.permanent dead-lettered", perm.delivery_state, "DEAD");
    check("DELIVERY.permanent dead_letter_code", perm.dead_letter_code, "PERMANENT_FAILURE");

    const oUnc = await newOffer(wrkA); fake.clear(); fake.setMessageResult(oUnc.offerMsg, R.DELIVERY_UNCERTAIN); await outbox.runOnce();
    const unc = await obByMsg(ws, oUnc.offerMsg);
    check("DELIVERY.uncertain SENT (possibly delivered)", unc.delivery_state, "SENT");
    check("DELIVERY.uncertain sticky flag set", unc.delivery_uncertain, true);
  }
  {
    // 28/77 crash after confirmed write before settlement → settlement-timeout re-sends SAME messageId
    const o = await newOffer(wrkA); fake.clear();
    await outbox.runOnce();  // WRITTEN → SENT awaiting settlement
    check("DELIVERY.crash-setup SENT", (await obByMsg(ws, o.offerMsg)).delivery_state, "SENT");
    await exec(ws, "UPDATE protocol_outbox SET awaiting_settlement_since = now() - interval '1 hour' WHERE workspace_id=$1 AND message_id=$2", [ws, o.offerMsg]);
    await outbox.runOnce();  // settlement-timeout sweep re-arms SENT→PENDING
    check("DELIVERY.settlement-timeout re-armed to PENDING", (await obByMsg(ws, o.offerMsg)).delivery_state, "PENDING");
    await outbox.runOnce();  // re-delivers SAME messageId
    check("DELIVERY.crash re-send preserves messageId", fake.countFor(o.offerMsg), 2);

    // 29 logger/envelope never carries payload credentials
    const secretRe = /password|authorization|cookie|bearer|token/i;
    const anyEnvelope = fake.sent.find((s) => s.envelope);
    check("DELIVERY.no-secret in delivered envelope", anyEnvelope ? !secretRe.test(JSON.stringify(anyEnvelope.envelope)) : true, true);
  }

  // ============================ SETTLEMENT ============================
  {
    // 30 MESSAGE_ACK settles a MESSAGE_ACK-mode row; 31 mismatch no settle; 32 duplicate ack idempotent
    const rotateMsg = MSG();
    await insertOutbox(ws, { messageId: rotateMsg, workerId: wrkA, type: "WORKER_CREDENTIAL_ROTATE", settlementMode: "MESSAGE_ACK", orderingKey: `${wrkA}`, payload: { rotationId: "r1" } });
    fake.clear(); await outbox.runOnce();
    check("SETTLE.rotate delivered SENT", (await obByMsg(ws, rotateMsg)).delivery_state, "SENT");
    // mismatched ack (wrong ackedMessageId) settles nothing
    const rMis = await sendIn(wrkA, envIn("MESSAGE_ACK", { worker: wrkA, payload: { ackedMessageId: MSG(), ackedType: "WORKER_CREDENTIAL_ROTATE", status: "ACCEPTED", serverRevision: null, errorCode: null } }));
    check("SETTLE.mismatch ack processed", rMis.outcome, "APPLIED");
    check("SETTLE.mismatch does not settle rotate", (await obByMsg(ws, rotateMsg)).delivery_state, "SENT");
    // correct ack settles
    const ackEnv = envIn("MESSAGE_ACK", { worker: wrkA, payload: { ackedMessageId: rotateMsg, ackedType: "WORKER_CREDENTIAL_ROTATE", status: "ACCEPTED", serverRevision: null, errorCode: null } });
    await sendIn(wrkA, ackEnv);
    check("SETTLE.correct ack settles rotate (ACKED)", (await obByMsg(ws, rotateMsg)).delivery_state, "ACKED");
    // duplicate ack idempotent (same messageId → dedupe)
    const rDup = await sendIn(wrkA, ackEnv);
    check("SETTLE.duplicate ack idempotent", rDup.outcome, "DUPLICATE");
    check("SETTLE.duplicate ack keeps ACKED", (await obByMsg(ws, rotateMsg)).delivery_state, "ACKED");
  }
  {
    // 33 JOB_ACCEPTED settles JOB_OFFER; 34 JOB_REJECTED settles JOB_OFFER; 35 generic ack does NOT
    const oAcc = await newOffer(wrkA); fake.clear(); await outbox.runOnce();
    await sendIn(wrkA, envIn("JOB_ACCEPTED", { worker: wrkA, job: oAcc.jobId, payload: { acceptedAt: nowIso() } }));
    check("SETTLE.accept settles JOB_OFFER (ACKED)", (await obByMsg(ws, oAcc.offerMsg)).delivery_state, "ACKED");
    check("SETTLE.accept sets job ACCEPTED", (await jobRow(ws, oAcc.jobId)).status, "ACCEPTED");

    const oRej = await newOffer(wrkA); await outbox.runOnce();
    await sendIn(wrkA, envIn("JOB_REJECTED", { worker: wrkA, job: oRej.jobId, payload: { reason: "BUSY" } }));
    check("SETTLE.reject settles JOB_OFFER (ACKED)", (await obByMsg(ws, oRej.offerMsg)).delivery_state, "ACKED");

    const oGen = await newOffer(wrkA); await outbox.runOnce();
    await sendIn(wrkA, envIn("MESSAGE_ACK", { worker: wrkA, job: oGen.jobId, payload: { ackedMessageId: oGen.offerMsg, ackedType: "JOB_ACCEPTED", status: "ACCEPTED", serverRevision: null, errorCode: null } }));
    check("SETTLE.generic ack does NOT settle lifecycle JOB_OFFER", (await obByMsg(ws, oGen.offerMsg)).delivery_state, "SENT");
  }
  {
    // 36 complete reconcile batch settles; 37 partial does not; 38 stale epoch does not
    const reconMsg = MSG();
    await insertOutbox(ws, { messageId: reconMsg, workerId: wrkA, type: "STATE_RECONCILE_REQUEST", settlementMode: "LIFECYCLE_RESPONSE", expectedResponseTypes: ["STATE_RECONCILE"], orderingKey: `${wrkA}`, payload: {} });
    await outbox.runOnce();
    await OWN.openReconcileBarrier(adapter, { workspaceId: ws, workerId: wrkA });
    // partial (isLast false) does not settle / does not close barrier
    await sendIn(wrkA, envIn("STATE_RECONCILE", { worker: wrkA, payload: { reconcileId: generateId("corr"), batch: { index: 0, total: 2, isLast: false } } }));
    check("SETTLE.reconcile partial does not settle", (await obByMsg(ws, reconMsg)).delivery_state, "SENT");
    check("SETTLE.reconcile partial keeps barrier open", (await sessionRow(ws, wrkA)).reconcile_barrier_open, true);
    // complete (isLast true, matching epoch 0) settles + closes
    await sendIn(wrkA, envIn("STATE_RECONCILE", { worker: wrkA, payload: { reconcileId: generateId("corr"), reconcileEpoch: 0, batch: { index: 1, total: 2, isLast: true } } }));
    check("SETTLE.reconcile complete settles request", (await obByMsg(ws, reconMsg)).delivery_state, "ACKED");
    check("SETTLE.reconcile complete closes barrier", (await sessionRow(ws, wrkA)).reconcile_barrier_open, false);
    // stale epoch cannot release a newer barrier
    await OWN.openReconcileBarrier(adapter, { workspaceId: ws, workerId: wrkA }); // epoch now 1
    await sendIn(wrkA, envIn("STATE_RECONCILE", { worker: wrkA, payload: { reconcileId: generateId("corr"), reconcileEpoch: 0, batch: { isLast: true } } }));
    check("SETTLE.stale-epoch does not release barrier", (await sessionRow(ws, wrkA)).reconcile_barrier_open, true);
    await OWN.closeReconcileBarrier(adapter, { workspaceId: ws, workerId: wrkA, isLast: true, expectedEpoch: 1 });
  }
  {
    // 39 SEND_ONLY settles after confirmed write; 40 critical type cannot be SEND_ONLY (DB CHECK)
    const pingMsg = MSG();
    await insertOutbox(ws, { messageId: pingMsg, workerId: wrkA, type: "PING", settlementMode: "SEND_ONLY", orderingKey: `${wrkA}`, payload: {} });
    fake.clear(); await outbox.runOnce();
    check("SETTLE.send-only settled on write (ACKED)", (await obByMsg(ws, pingMsg)).delivery_state, "ACKED");
    let critThrew = false;
    try { await insertOutbox(ws, { messageId: MSG(), workerId: wrkA, jobId: null, type: "JOB_OFFER", settlementMode: "SEND_ONLY", orderingKey: `${wrkA}`, payload: {} }); } catch { critThrew = true; }
    check("SETTLE.critical type cannot be SEND_ONLY (DB CHECK)", critThrew, true);
  }

  // ============================ ORDERING (single-flight) ============================
  {
    // 41 same ordering key single-flight; 44/46 unblock after settlement; 45 not wedged on generic ack
    const o = await newOffer(wrkA);  // JOB_OFFER, ordering wrkA:job
    const cancelMsg = MSG();
    await insertOutbox(ws, { messageId: cancelMsg, workerId: wrkA, jobId: o.jobId, type: "JOB_CANCEL_REQUEST", settlementMode: "LIFECYCLE_RESPONSE", expectedResponseTypes: ["JOB_CANCELED"], orderingKey: `${wrkA}:${o.jobId}`, payload: {} });
    const claimed1 = (await outbox._claimBatch(ws)).filter((r) => r.ordering_key === `${wrkA}:${o.jobId}`);
    check("ORDER.single-flight claims only head", claimed1.length, 1);
    check("ORDER.single-flight head is the JOB_OFFER", claimed1[0].type, "JOB_OFFER");
    // deliver the head (settle-awaiting), then the cancel is still blocked behind a SENT offer
    await settleTok(ws, claimed1[0].id, claimed1[0]._token, "markAwaitingSettlement", { sentAtIso: nowIso(), awaitingSinceIso: nowIso(), resultCode: "WRITTEN", incAttempts: true });
    const claimedBlocked = (await outbox._claimBatch(ws)).filter((r) => r.id === cancelMsg || (r.job_id === o.jobId && r.type === "JOB_CANCEL_REQUEST"));
    check("ORDER.cancel blocked behind SENT offer", claimedBlocked.length, 0);
    // a generic MESSAGE_ACK for the offer does NOT settle it (lifecycle), so cancel stays blocked
    await sendIn(wrkA, envIn("MESSAGE_ACK", { worker: wrkA, job: o.jobId, payload: { ackedMessageId: o.offerMsg, ackedType: "JOB_ACCEPTED", status: "ACCEPTED", serverRevision: null, errorCode: null } }));
    check("ORDER.generic-ack does not unblock cancel", (await obByMsg(ws, o.offerMsg)).delivery_state, "SENT");
    // the lifecycle response (JOB_ACCEPTED) settles the offer → cancel unblocks (not wedged)
    await sendIn(wrkA, envIn("JOB_ACCEPTED", { worker: wrkA, job: o.jobId, payload: { acceptedAt: nowIso() } }));
    check("ORDER.lifecycle response settles offer", (await obByMsg(ws, o.offerMsg)).delivery_state, "ACKED");
    const claimedAfter = (await outbox._claimBatch(ws)).filter((r) => r.type === "JOB_CANCEL_REQUEST" && r.job_id === o.jobId);
    check("ORDER.cancel unblocks after offer settles", claimedAfter.length, 1);
    if (claimedAfter[0]) await settleTok(ws, claimedAfter[0].id, claimedAfter[0]._token, "releaseClaim", { nextAttemptAtIso: new Date(clock.now() + 3600000).toISOString(), resultCode: "PARK" });
  }
  {
    // 42 different jobs concurrent; 43 different workers concurrent
    const j1 = await newOffer(wrkA), j2 = await newOffer(wrkA), w2 = await newOffer(wrkB);
    const claimed = await outbox._claimBatch(ws);
    const keys = new Set(claimed.map((r) => r.ordering_key));
    check("ORDER.different jobs both claimable", keys.has(`${wrkA}:${j1.jobId}`) && keys.has(`${wrkA}:${j2.jobId}`), true);
    check("ORDER.different workers both claimable", keys.has(`${wrkB}:${w2.jobId}`), true);
    for (const r of claimed) await settleTok(ws, r.id, r._token, "markAwaitingSettlement", { sentAtIso: nowIso(), awaitingSinceIso: nowIso(), resultCode: "WRITTEN", incAttempts: true });
  }

  // ============================ OFFER EXPIRY ============================
  {
    // 47/51 never-sent PENDING offer may re-offer; 50 two expiry sweeps → one replacement
    const o = await newOffer(wrkA);   // JOB_OFFER outbox PENDING (never delivered)
    await exec(ws, "UPDATE job_offers SET offer_expires_at = now() - interval '1 second' WHERE workspace_id=$1 AND id=$2", [ws, o.offerId]);
    const [e1, e2] = await Promise.all([offerExpiry.runOnce(), offerExpiry.runOnce()]);
    const reoffered = (e1.reoffered || 0) + (e2.reoffered || 0);
    check("EXPIRY.never-sent re-offered exactly once", reoffered, 1);
    check("EXPIRY.old offer retired EXPIRED_PRE_SUBMIT", (await offerById(ws, o.offerId)).ownership_status, "EXPIRED_PRE_SUBMIT");
    check("EXPIRY.old outbox dead-lettered", (await obByMsg(ws, o.offerMsg)).delivery_state, "DEAD");
    check("EXPIRY.exactly one live offer after re-offer", await liveOffers(ws, o.attemptId), 1);
  }
  {
    // 48 SENT offer cannot re-offer → RECOVERING; 49 uncertain cannot re-offer → RECOVERING
    const oSent = await newOffer(wrkA); fake.clear(); await outbox.runOnce();  // SENT
    await exec(ws, "UPDATE job_offers SET offer_expires_at = now() - interval '1 second' WHERE workspace_id=$1 AND id=$2", [ws, oSent.offerId]);
    const rSent = await offerExpiry.runOnce();
    check("EXPIRY.sent offer → recovering (not re-offered)", rSent.recovering >= 1 && (rSent.reoffered || 0) === 0, true);
    check("EXPIRY.sent attempt RECOVERING", (await attemptRow(ws, oSent.attemptId)).ownership_status, "RECOVERING");

    const oUnc = await newOffer(wrkA); fake.clear(); fake.setMessageResult(oUnc.offerMsg, R.DELIVERY_UNCERTAIN); await outbox.runOnce(); // SENT + uncertain
    await exec(ws, "UPDATE job_offers SET offer_expires_at = now() - interval '1 second' WHERE workspace_id=$1 AND id=$2", [ws, oUnc.offerId]);
    await offerExpiry.runOnce();
    check("EXPIRY.uncertain offer → RECOVERING", (await attemptRow(ws, oUnc.attemptId)).ownership_status, "RECOVERING");
  }
  {
    // 52 reconcile/possibly-submitted evidence blocks unsafe re-offer
    const o = await newOffer(wrkA);
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: o.attemptId, workerId: wrkA, state: "SUBMITTED" }); // possibly_submitted
    await exec(ws, "UPDATE job_offers SET offer_expires_at = now() - interval '1 second' WHERE workspace_id=$1 AND id=$2", [ws, o.offerId]);
    const r = await offerExpiry.runOnce();
    check("EXPIRY.submission evidence blocks re-offer", (r.reoffered || 0), 0);
    check("EXPIRY.submitted attempt ordinal preserved", (await attemptRow(ws, o.attemptId)).generation_ordinal, 1);
  }

  // ============================ RECONCILIATION TIMEOUT ============================
  {
    // 53 barrier blocks a new offer (ownership); 54 matching epoch releases (covered above)
    const barrierAttempt = await OWN.createGenerationRequest(adapter, { workspaceId: ws, projectId: prj, action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), inputSnapshot: {} });
    await OWN.openReconcileBarrier(adapter, { workspaceId: ws, workerId: wrkA });
    let barrierBlocked = false;
    try { await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ws, attemptId: barrierAttempt.attempt.id, workerId: wrkA }); }
    catch (e) { barrierBlocked = e.code === DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED; }
    check("RECON.open barrier blocks new offer", barrierBlocked, true);

    // 55/57 timeout keeps possibly_submitted + creates NO new offer; barrier stays open
    const subAttempt = await OWN.createGenerationRequest(adapter, { workspaceId: ws, projectId: prj, action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), inputSnapshot: {} });
    await OWN.claimGenerationAttemptForWorker(adapter, { workspaceId: ws, attemptId: subAttempt.attempt.id, workerId: wrkB });
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: subAttempt.attempt.id, workerId: wrkB, state: "SUBMITTED" });
    await OWN.openReconcileBarrier(adapter, { workspaceId: ws, workerId: wrkB });
    await exec(ws, "UPDATE worker_connection_sessions SET reconcile_barrier_opened_at = now() - interval '10 minutes' WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [ws, wrkB]);
    const offersBefore = await q1(ws, "SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2", [ws, subAttempt.attempt.id]);
    const rr = await reconciliation.runOnce();
    check("RECON.timeout flagged the stuck barrier", rr.flagged >= 1, true);
    check("RECON.timeout keeps possibly_submitted", (await attemptRow(ws, subAttempt.attempt.id)).possibly_submitted, true);
    check("RECON.timeout keeps ordinal=1", (await attemptRow(ws, subAttempt.attempt.id)).generation_ordinal, 1);
    check("RECON.timeout keeps barrier OPEN", (await sessionRow(ws, wrkB)).reconcile_barrier_open, true);
    const offersAfter = await q1(ws, "SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2", [ws, subAttempt.attempt.id]);
    check("RECON.timeout creates no new offer", offersAfter.n, offersBefore.n);
    await exec(ws, "UPDATE worker_connection_sessions SET reconcile_barrier_open=false, reconcile_barrier_opened_at=NULL WHERE workspace_id=$1 AND worker_id=$2", [ws, wrkA]);
    await exec(ws, "UPDATE worker_connection_sessions SET reconcile_barrier_open=false, reconcile_barrier_opened_at=NULL WHERE workspace_id=$1 AND worker_id=$2", [ws, wrkB]);
  }

  // ============================ RETENTION ============================
  {
    // 58 terminal-safe inbox cleaned (tombstone kept); 64 ownership never deleted
    const o = await newOffer(wrkA);
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: o.attemptId, workerId: wrkA, state: "SUBMITTED" });
    const cm = MSG();
    await sendIn(wrkA, envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId, messageId: cm }));
    await exec(ws, "UPDATE protocol_inbox SET received_at = now() - interval '2 hours' WHERE workspace_id=$1 AND message_id=$2", [ws, cm]);
    const beforeAttempts = await q1(ws, "SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1", [ws]);
    const beforeTerm = await q1(ws, "SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1", [ws]);
    await retention.runOnce();
    check("RETAIN.terminal-safe inbox cleaned", Boolean(await inboxByMsg(ws, wrkA, cm)), false);
    check("RETAIN.tombstone preserved for dedupe", Boolean(await q1(ws, "SELECT 1 FROM protocol_dedupe_tombstones WHERE workspace_id=$1 AND worker_id=$2 AND message_id=$3", [ws, wrkA, cm])), true);
    check("RETAIN.ownership attempts not deleted", (await q1(ws, "SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1", [ws])).n, beforeAttempts.n);
    check("RETAIN.terminal results not deleted", (await q1(ws, "SELECT count(*)::int n FROM job_terminal_results WHERE workspace_id=$1", [ws])).n, beforeTerm.n);
  }
  {
    // 59 unresolved retained; 60 possibly_submitted (non-terminal) retained
    const oUnres = await newOffer(wrkA); await outbox.runOnce();
    const sm = MSG();
    await sendIn(wrkA, envIn("JOB_STARTED", { worker: wrkA, job: oUnres.jobId, messageId: sm, payload: {} }));
    await exec(ws, "UPDATE protocol_inbox SET received_at = now() - interval '2 hours' WHERE workspace_id=$1 AND message_id=$2", [ws, sm]);
    await retention.runOnce();
    check("RETAIN.unresolved attempt inbox retained", Boolean(await inboxByMsg(ws, wrkA, sm)), true);

    const oSub = await newOffer(wrkA);
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: oSub.attemptId, workerId: wrkA, state: "SUBMITTED" }); // possibly_submitted, NOT terminal
    const pm = MSG();
    await sendIn(wrkA, envIn("JOB_PROGRESS", { worker: wrkA, job: oSub.jobId, messageId: pm, payload: { sequence: 3 } }));
    // link the inbox row to the attempt so the retention safety join sees it unresolved
    await exec(ws, "UPDATE protocol_inbox SET generation_attempt_id=$3, received_at = now() - interval '2 hours' WHERE workspace_id=$1 AND message_id=$2", [ws, pm, oSub.attemptId]);
    await retention.runOnce();
    check("RETAIN.possibly_submitted (non-terminal) inbox retained", Boolean(await inboxByMsg(ws, wrkA, pm)), true);
  }
  {
    // 61 pending-ACK evidence retained; 62 dead-letter retained within window, deleted past window; 63 bounded
    const o = await newOffer(wrkA);
    await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: o.attemptId, workerId: wrkA, state: "SUBMITTED" });
    const cm = MSG();
    await sendIn(wrkA, envIn("JOB_COMPLETED", { worker: wrkA, job: o.jobId, messageId: cm }));
    const ackOb = await q1(ws, "SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND type='MESSAGE_ACK' AND payload->>'ackedMessageId'=$2", [ws, cm]);
    await retention.runOnce();
    check("RETAIN.pending-ACK outbox retained (PENDING not deleted)", Boolean(await obById(ws, ackOb.id)), true);

    const oDead = await newOffer(wrkA); fake.clear(); fake.setMessageResult(oDead.offerMsg, R.PERMANENT_FAILURE); await outbox.runOnce();
    const deadRow = await obByMsg(ws, oDead.offerMsg);
    await retention.runOnce();
    check("RETAIN.dead-letter retained within window", Boolean(await obById(ws, deadRow.id)), true);
    await exec(ws, "UPDATE protocol_outbox SET settled_at = now() - interval '2 days' WHERE workspace_id=$1 AND id=$2", [ws, deadRow.id]);
    await retention.runOnce();
    check("RETAIN.dead-letter deleted past window", Boolean(await obById(ws, deadRow.id)), false);

    const smallRet = createRetentionProcessor({ adapter, clock, config: { retentionBatchSize: 1, batchSize: 1, retentionMs: 3600000, deadLetterRetentionMs: 86400000 }, logger: null });
    const c1 = await newOffer(wrkA), c2 = await newOffer(wrkA);
    for (const oo of [c1, c2]) { await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: oo.attemptId, workerId: wrkA, state: "SUBMITTED" }); const m = MSG(); await sendIn(wrkA, envIn("JOB_COMPLETED", { worker: wrkA, job: oo.jobId, messageId: m })); await exec(ws, "UPDATE protocol_inbox SET received_at = now() - interval '2 hours' WHERE workspace_id=$1 AND message_id=$2", [ws, m]); }
    const swept = await smallRet._sweepInbox(ws);
    check("RETAIN.bounded batch (<= retentionBatchSize)", swept <= 1, true);
  }

  // ============================ LIFECYCLE (live) ============================
  {
    // 66 enabled needs DB (ready when DB ready); 67 enabled delivery needs adapter; 71-73 status
    const cfgOn = loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: ctx.live.testUrl, CONTROL_PLANE_DB_OPS_URL: ctx.live.opsUrl, CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0" });
    const procReady = createBackgroundProcessor(cfgOn, { logger: null, adapter, deliveryAdapter: fake, clock });
    check("LIFE.enabled + DB ready → ready", procReady.getStatus().ready, true);
    const oneCycle = await procReady.runOnce();
    check("LIFE.runOnce returns outbox stats", Boolean(oneCycle && oneCycle.outbox), true);
    check("LIFE.status lastRunAt set after runOnce", Boolean(procReady.getStatus().lastRunAt), true);
    check("LIFE.status lastSuccessAt set", Boolean(procReady.getStatus().lastSuccessAt), true);

    const cfgDeliver = loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: ctx.live.testUrl, CONTROL_PLANE_DB_OPS_URL: ctx.live.opsUrl, CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_DELIVERY_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "0" });
    const procNoAdapter = createBackgroundProcessor(cfgDeliver, { logger: null, adapter, deliveryAdapter: createUnavailableDeliveryAdapter(), clock });
    check("LIFE.delivery enabled + unavailable adapter → NOT ready", procNoAdapter.getStatus().ready, false);
    check("LIFE.delivery unavailable reason", procNoAdapter.getStatus().reasonCode, "DELIVERY_ADAPTER_UNAVAILABLE");

    // 68 start/stop idempotent; 69 drain stops; 70 no leaked timers (drain resolves promptly)
    const cfgPoll = loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: ctx.live.testUrl, CONTROL_PLANE_DB_OPS_URL: ctx.live.opsUrl, CONTROL_PLANE_PROCESSOR_ENABLED: "true", CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS: "50" });
    const procPoll = createBackgroundProcessor(cfgPoll, { logger: null, adapter, deliveryAdapter: fake, clock });
    await procPoll.start(); await procPoll.start();
    await pause(120);
    await procPoll.drain({ timeoutMs: 2000 });
    check("LIFE.drain completes (not draining after)", procPoll.getStatus().draining, false);
    check("LIFE.start-stop idempotent (no throw)", true, true);
  }

  // ============================ MULTI-INSTANCE / CRASH ============================
  {
    // 74 two instances do not double-deliver an active claim
    const offers = []; for (let i = 0; i < 4; i++) offers.push(await newOffer(wrkA));
    fake.clear();
    await Promise.all([outbox.runOnce(), outboxB.runOnce()]);
    let doubled = 0;
    for (const o of offers) if (fake.countFor(o.offerMsg) > 1) doubled += 1;
    check("CRASH.two-instances no double-delivery", doubled, 0);

    // 78 settlement race is idempotent (two different JOB_ACCEPTED messages settle once)
    const oRace = await newOffer(wrkA); await outbox.runOnce();
    await Promise.all([
      sendIn(wrkA, envIn("JOB_ACCEPTED", { worker: wrkA, job: oRace.jobId, payload: { acceptedAt: nowIso() } })),
      sendIn(wrkA, envIn("JOB_ACCEPTED", { worker: wrkA, job: oRace.jobId, payload: { acceptedAt: nowIso() } }))
    ]);
    check("CRASH.settlement race → offer ACKED once", (await obByMsg(ws, oRace.offerMsg)).delivery_state, "ACKED");
    check("CRASH.settlement race → job ACCEPTED", (await jobRow(ws, oRace.jobId)).status, "ACCEPTED");

    // 79 dead-letter race → single final DEAD (idempotent)
    const oDl = await newOffer(wrkA);
    const claimed = (await outbox._claimBatch(ws)).find((r) => r.message_id === oDl.offerMsg);
    await settleTok(ws, claimed.id, claimed._token, "deadLetter", { code: "PERMANENT_FAILURE", reason: "x" });
    const second = await settleTok(ws, claimed.id, claimed._token, "deadLetter", { code: "PERMANENT_FAILURE", reason: "y" });
    check("CRASH.dead-letter race second is no-op (stale token)", second, null);
    check("CRASH.dead-letter final single DEAD", (await obByMsg(ws, oDl.offerMsg)).delivery_state, "DEAD");
  }

  // ============================ PROPERTY / INVARIANT ============================
  {
    // Bounded, seeded deterministic interleavings. After every sequence, invariants must hold.
    function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    const rnd = mulberry32(0xC0FFEE);
    const ops = ["written", "uncertain", "accept", "complete", "expire", "permanent", "reject"];
    let violations = 0, sequences = 0;
    for (let i = 0; i < 14; i++) {
      sequences += 1;
      const worker = rnd() < 0.5 ? wrkA : wrkB;
      const o = await newOffer(worker);
      const n = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const op = ops[Math.floor(rnd() * ops.length)];
        try {
          if (op === "written") { fake.setMessageResult(o.offerMsg, R.WRITTEN); await outbox.runOnce(); }
          else if (op === "uncertain") { fake.setMessageResult(o.offerMsg, R.DELIVERY_UNCERTAIN); await outbox.runOnce(); }
          else if (op === "permanent") { fake.setMessageResult(o.offerMsg, R.PERMANENT_FAILURE); await outbox.runOnce(); }
          else if (op === "accept") await sendIn(worker, envIn("JOB_ACCEPTED", { worker, job: o.jobId, payload: { acceptedAt: nowIso() } }));
          else if (op === "reject") await sendIn(worker, envIn("JOB_REJECTED", { worker, job: o.jobId, payload: {} }));
          else if (op === "complete") { await OWN.applySubmissionFact(adapter, { workspaceId: ws, attemptId: o.attemptId, workerId: worker, state: "SUBMITTED" }).catch(() => {}); await sendIn(worker, envIn("JOB_COMPLETED", { worker, job: o.jobId })); }
          else if (op === "expire") { await exec(ws, "UPDATE job_offers SET offer_expires_at = now() - interval '1 second' WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status='OFFERED'", [ws, o.attemptId]); await offerExpiry.runOnce(); }
        } catch { /* rejected transitions are allowed; invariants checked below */ }
      }
      // INVARIANTS
      const a = await attemptRow(ws, o.attemptId);
      const live = await liveOffers(ws, o.attemptId);
      const terms = await terminalCount(ws, o.jobId);
      if (!(a.generation_ordinal <= 1)) violations += 1;           // ≤ 1 paid generation
      if (!(live <= 1)) violations += 1;                            // at most one live offer
      if (!(terms <= 1)) violations += 1;                           // one terminal result
      // uncertain/SENT paid offer never re-offered into a 2nd live offer while uncertain
      const uncertainLive = await q1(ws, "SELECT count(*)::int n FROM protocol_outbox WHERE workspace_id=$1 AND generation_attempt_id=$2 AND type='JOB_OFFER' AND delivery_uncertain=true AND delivery_state='DEAD'", [ws, o.attemptId]);
      if (uncertainLive.n > 0) violations += 1;                     // an uncertain offer was never dead-lettered-for-reoffer
    }
    check("PROPERTY.sequences executed", sequences, 14);
    check("PROPERTY.no invariant violations across interleavings", violations, 0);
    // cross-workspace isolation invariant: wsB never mutated by wsA activity
    const bLeak = await q1(wsB, "SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1", [wsB]);
    check("PROPERTY.cross-workspace isolation (wsB untouched)", bLeak.n, 0);
  }

  check("LIVE all processor cases executed", true, true);
}
