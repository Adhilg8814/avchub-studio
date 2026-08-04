#!/usr/bin/env node
// P0 Step 5C.8B2 Checkpoint 6 — focused TRANSACTIONAL PostgreSQL tests for the recovery reconciliation
// transitions (recoveryReofferForAttemptCore, setAttemptRecoveringCore). Exercises the guard matrix
// directly against real PostgreSQL + RLS + the real ownership repositories — proving a proven-PRE_SUBMIT
// attempt re-offers exactly once, and every unsafe-evidence variant REFUSES. Complements the live B2
// suite (which drives the same cores through the real inbox). Fail-closed without a live DB.
//
// Run: node tests/step5c8-recovery-transaction-tests.mjs   (needs the disposable *_test DB env)

import { Client } from "pg";
import { createApp } from "../control-plane/src/app.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { migrate } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { evaluateTestDbTarget } from "../control-plane/src/persistence/postgres/test-db-safety.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateId } from "../lib/protocol/ids.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";
import { credentialVerifier } from "../control-plane/src/gateway/credential-verifier.mjs";
import * as OWN from "../control-plane/src/persistence/transactions/ownership.mjs";

let passed = 0, failed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "control-plane", "database", "migrations");
const CRED_PEPPER = "step5c8b2-tx-credential-pepper-fixed-1", PAIR_PEPPER = "step5c8b2-tx-pairing-pepper-fixed-2", OP = "step5c8b2-tx-op-fixed-3";

async function main() {
  const url = process.env.CONTROL_PLANE_TEST_DB_URL;
  const guard = evaluateTestDbTarget({ url, allowDestructive: process.env.CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS === "true" });
  if (!guard.ok) { console.log(`[SKIP] live PG unavailable (guard:${guard.reasons.join(",")})`); process.exit(0); }
  const migrationUrl = process.env.CONTROL_PLANE_DB_MIGRATION_URL || url, opsUrl = process.env.CONTROL_PLANE_DB_OPS_URL || url;

  const mig = new Client({ connectionString: migrationUrl }); await mig.connect();
  await mig.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  await mig.query("GRANT USAGE ON SCHEMA public TO cp_tenant_app, cp_ops_enumerator, cp_readonly_observer");
  await mig.query("GRANT CREATE, USAGE ON SCHEMA public TO cp_migrator");
  try { await mig.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
  await migrate(mig, { dir: MIGRATIONS, appVersion: "5c8b2-tx" });
  const ws = generateId("ws"), userId = generateId("usr"), workerId = generateId("wrk"), projectId = generateId("prj");
  await mig.query("INSERT INTO users (id,email) VALUES ($1,$2)", [userId, "tx-" + Date.now() + "@local.test"]);
  await mig.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
  await mig.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'TX',$2)", [ws, userId]);
  await mig.query("INSERT INTO workers (id,workspace_id,name,platform,protocol_version,status,paired_at,first_seen_at) VALUES ($1,$2,'tx-worker','win32',1,'ONLINE',now(),now())", [workerId, ws]);
  await mig.query("INSERT INTO worker_credentials (id,workspace_id,worker_id,credential_hash,status,expires_at) VALUES ($1,$2,$3,$4,'ACTIVE', now()+interval '365 days')", [newId("cred"), ws, workerId, credentialVerifier(CRED_PEPPER, "x")]);
  await mig.query("INSERT INTO worker_connection_sessions (id,workspace_id,worker_id,gateway_instance,session_id,status,connection_epoch,connected_at,authenticated_at,last_seen_at) VALUES ($1,$2,$3,'seed',$1,'ACTIVE',0,now(),now(),now())", [newId("sess"), ws, workerId]);
  await mig.query("INSERT INTO projects (id,workspace_id,title,home_worker_id,created_by_user_id,storage_relative_root) VALUES ($1,$2,'P',$3,$4,'projects/tx')", [projectId, ws, workerId, userId]);
  await mig.query("INSERT INTO project_worker_affinity (id,workspace_id,project_id,worker_id,status,generation) VALUES ($1,$2,$3,$4,'ACTIVE',0)", [newId("aff"), ws, projectId, workerId]);
  await mig.end();

  const app = await createApp({ config: loadConfig({
    CONTROL_PLANE_ENV: "test", CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: "0", CONTROL_PLANE_INSTANCE_ID: "tx",
    CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: url, CONTROL_PLANE_DB_OPS_URL: opsUrl, CONTROL_PLANE_CREDENTIAL_PEPPER: CRED_PEPPER
  }), logger: (() => { const n = () => {}; const l = { debug: n, info: n, warn: n, error: n }; l.child = () => l; return l; })() });
  await app.start();
  const persistence = app.modules.persistence;
  const tq = (sql, p = []) => persistence.tenantTransaction(ws, async (c) => (await c.query(sql, p)).rows);

  // Build a fresh accepted-but-PRE_SUBMIT attempt: create request → claim (mints offer) → JOB_ACCEPTED.
  async function freshAcceptedAttempt(prompt) {
    const reqKey = newId("req");
    const gen = await persistence.tenantTransaction(ws, (c) => OWN.createGenerationRequestCore(c, { workspaceId: ws, projectId, requestIdempotencyKey: reqKey, action: "GENERATE_VIDEO", inputSnapshot: { kind: "VIDEO", prompt, durationSeconds: 5, aspectRatio: "16:9", outputCount: 1 }, quotaRisk: false }));
    const attemptId = gen.attempt.id, jobId = gen.job.id;
    await persistence.tenantTransaction(ws, (c) => OWN.claimGenerationAttemptForWorkerCore(c, { workspaceId: ws, attemptId, workerId }));
    await persistence.tenantTransaction(ws, (c) => OWN.applyWorkerEventCore(c, { workspaceId: ws, jobId, workerId, event: "JOB_ACCEPTED" }));
    return { attemptId, jobId };
  }
  const attemptRow = async (attemptId) => (await tq("SELECT generation_ordinal, submission_state, possibly_submitted, ownership_status, terminal_state FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, attemptId]))[0];
  const offerCount = async (attemptId) => (await tq("SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2", [ws, attemptId]))[0].n;
  const liveOfferCount = async (attemptId) => (await tq("SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND generation_attempt_id=$2 AND ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')", [ws, attemptId]))[0].n;

  try {
    // ---- proven PRE_SUBMIT: re-offer succeeds exactly once ----
    {
      const { attemptId } = await freshAcceptedAttempt("clean pre-submit");
      check("setup: attempt is PRE_SUBMIT (ordinal 0, NOT_SUBMITTED)", (await attemptRow(attemptId)).submission_state, "NOT_SUBMITTED");
      const r1 = await OWN.recoveryReofferForAttempt(persistence, { workspaceId: ws, attemptId, workerId });
      check("proven PRE_SUBMIT → reoffered", r1.reoffered, true);
      check("re-offer minted a NEW offer messageId", /^msg_/.test(String(r1.newOfferMessageId)), true);
      check("original offer preserved as audit (2 offer rows)", await offerCount(attemptId), 2);
      check("exactly one LIVE offer after re-offer", await liveOfferCount(attemptId), 1);
      // idempotency: a second re-offer is refused (already re-offered)
      const r2 = await OWN.recoveryReofferForAttempt(persistence, { workspaceId: ws, attemptId, workerId });
      check("second re-offer refused (already_reoffered)", { reoffered: r2.reoffered, reason: r2.reason }, { reoffered: false, reason: "already_reoffered" });
      check("still exactly one live offer (idempotent)", await liveOfferCount(attemptId), 1);
    }
    // ---- unsafe evidence variants: re-offer MUST refuse ----
    {
      const { attemptId } = await freshAcceptedAttempt("possibly submitted");
      await OWN.applySubmissionFact(persistence, { workspaceId: ws, attemptId, workerId, state: "SUBMITTING", confidence: "UNKNOWN" });
      const r = await OWN.recoveryReofferForAttempt(persistence, { workspaceId: ws, attemptId, workerId });
      check("possibly_submitted attempt → re-offer REFUSED (may_be_submitted)", { reoffered: r.reoffered, reason: r.reason }, { reoffered: false, reason: "may_be_submitted" });
      check("no re-offer created for possibly-submitted attempt", await offerCount(attemptId), 1);
    }
    {
      const { attemptId, jobId } = await freshAcceptedAttempt("has terminal");
      await OWN.applySubmissionFact(persistence, { workspaceId: ws, attemptId, workerId, state: "SUBMITTED", confidence: "CONFIRMED" });
      await OWN.applyTerminal(persistence, { workspaceId: ws, jobId, workerId, terminalType: "JOB_COMPLETED", terminalMessageId: generateId("msg"), result: { asset: { relativePath: "media/x/y.mp4", mimeType: "video/mp4", sizeBytes: 10 } } });
      const r = await OWN.recoveryReofferForAttempt(persistence, { workspaceId: ws, attemptId, workerId });
      check("terminal attempt → re-offer REFUSED", r.reoffered, false);
    }
    {
      const { attemptId } = await freshAcceptedAttempt("foreign worker");
      const r = await OWN.recoveryReofferForAttempt(persistence, { workspaceId: ws, attemptId, workerId: generateId("wrk") });
      check("foreign worker → re-offer REFUSED (not_producing_worker)", { reoffered: r.reoffered, reason: r.reason }, { reoffered: false, reason: "not_producing_worker" });
    }
    // ---- setAttemptRecovering: RECOVERING + monotonic possibly_submitted ----
    {
      const { attemptId } = await freshAcceptedAttempt("recovering");
      await persistence.tenantTransaction(ws, (c) => OWN.setAttemptRecoveringCore(c, { workspaceId: ws, attemptId, workerId, possiblySubmitted: true }));
      let row = await attemptRow(attemptId);
      check("setAttemptRecovering → ownership RECOVERING + possibly_submitted true", { o: row.ownership_status, p: row.possibly_submitted }, { o: "RECOVERING", p: true });
      // monotonic: a later report claiming NOT possibly-submitted cannot regress it to false
      await persistence.tenantTransaction(ws, (c) => OWN.setAttemptRecoveringCore(c, { workspaceId: ws, attemptId, workerId, possiblySubmitted: false }));
      row = await attemptRow(attemptId);
      check("possibly_submitted is monotonic (stays true)", row.possibly_submitted, true);
      // foreign worker cannot move another worker's attempt
      const rf = await persistence.tenantTransaction(ws, (c) => OWN.setAttemptRecoveringCore(c, { workspaceId: ws, attemptId, workerId: generateId("wrk"), possiblySubmitted: true }));
      check("foreign worker cannot set RECOVERING (not_producing_worker)", rf.reason, "not_producing_worker");
    }
  } finally {
    try { await app.stop(); } catch { /* */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST ERROR", e && e.stack ? e.stack : e); process.exit(1); });
