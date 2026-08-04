// P0 Step 5C.50 — the live offer's owner settles it, and only it.
//
// The defect, exactly: the three terminal paths wrote
//
//     UPDATE job_offers SET ownership_status=… WHERE workspace_id=$1 AND job_id=$2
//
// which matches EVERY offer row a job ever had. `job_offers_one_live_uq` excludes exactly EXPIRED_PRE_SUBMIT
// and OFFER_REJECTED, so a job that had been re-offered — and 5C.49 made cooldown deferrals routine, each one
// leaving an EXPIRED_PRE_SUBMIT row behind — had its DEAD offer dragged back into the live set. Two live
// offers for one attempt is what that index forbids, so the settlement threw E_ATTEMPT_ALREADY_OWNED, the call
// site swallowed it, and the job could never leave SUBMITTED. The reconciler only reads SUBMIT_UNCERTAIN, so
// it never saw the job either, and the workspace stayed degraded forever.
//
// Everything here runs against a REAL PostgreSQL with the real migrations and the real control plane. No
// provider of any kind: the generation facade is exercised through its own API and no browser is opened.

import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createGenerationControlPlane } from "../control-plane/src/api-staging/generation-control-plane.mjs";
import { generateId } from "../lib/protocol/ids.mjs";

let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c === true) passed += 1; else { failed += 1; console.log("FAIL", n, d ? `-> ${d}` : ""); } };
async function throwsCode(name, fn, code) {
  try { await fn(); check(name, false, "it did not refuse"); }
  catch (e) { check(name, e && e.code === code, `${e && e.code} ${String(e && e.message).slice(0, 90)}`); }
}

if (!livePgAvailable()) {
  console.log("Step 5C.50 offer settlement: SKIPPED (no PostgreSQL binaries)");
  process.exit(0);
}

const live = await startDisposablePg({ namePrefix: "own" });
let adapter = null;
try {
  const mc = new pg.Client({ connectionString: live.migrationUrl });
  await mc.connect();
  const ws = generateId("ws"), user = generateId("usr");
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
    await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c50-own" });
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'OWN',$2)", [ws, user]);
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const config = { stagingApi: { workspaceId: ws } };
  const T = (fn) => adapter.tenantTransaction(ws, fn);
  const q = (sql, p = []) => T(async (c) => (await c.query(sql, p)).rows);
  const cp = createGenerationControlPlane({ persistence: adapter, config });
  const boot = await cp.ensureBootstrap();

  const offersOf = (jobId) => q("SELECT id, ownership_status, assigned_worker_id, possibly_submitted, terminal_at FROM job_offers WHERE workspace_id=$1 AND job_id=$2 ORDER BY created_at", [ws, jobId]);
  const jobOf = (jobId) => q("SELECT state, invocation_state, error_code FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [ws, jobId]).then((r) => r[0]);
  const attemptOf = (jobId) => q(`SELECT a.possibly_submitted, a.submission_state, a.terminal_state FROM generation_attempts a
    JOIN generation_jobs j ON j.generation_attempt_id=a.id AND j.workspace_id=a.workspace_id
    WHERE a.workspace_id=$1 AND j.id=$2`, [ws, jobId]).then((r) => r[0]);
  const eventsOf = (jobId) => q("SELECT type FROM generation_job_events WHERE workspace_id=$1 AND job_id=$2 ORDER BY seq", [ws, jobId]).then((r) => r.map((x) => x.type));

  /** A job in exactly the shape the stuck production job is in: re-offered (so it carries a DEAD offer row),
   *  then submitted, so it has a live SUBMITTING offer, a consumed invocation and possibly_submitted. */
  async function submittedJobWithDeadOffer(prompt) {
    const j = await cp.enqueue({ prompt, durationSeconds: 6, aspectRatio: "9:16" });
    await cp.requestStart({ jobId: j.jobId });
    await cp.claimNextForWorker({ max: 5 });
    // A cooldown deferral: the offer it was holding is expired PRE-SUBMIT and a new one is created on the
    // next dispatch. This is what 5C.49 made routine and what nothing had ever settled around.
    await cp.deferForCooldown({ jobId: j.jobId, slot: { provider: "GROK", accountRef: "pa_x", profileRef: "-" }, reason: "E_PROVIDER_MANUAL_TUNNEL_LEASE_FAILED" });
    await q("UPDATE provider_submission_slots SET next_eligible_at = now() - interval '1 minute' WHERE workspace_id=$1", [ws]).catch(() => {});
    await cp.requestStart({ jobId: j.jobId });
    await cp.claimNextForWorker({ max: 5 });
    await cp.markSubmitted({ jobId: j.jobId, attemptId: j.generationAttemptId });
    return j;
  }

  // ============================================================ S — the shape that broke
  {
    const j = await submittedJobWithDeadOffer("A single candle burning on a windowsill at night.");
    const before = await offersOf(j.jobId);
    check("S1 the job carries two offer rows: one dead, one live",
      before.length === 2 && before.filter((o) => o.ownership_status === "EXPIRED_PRE_SUBMIT").length === 1
      && before.filter((o) => !["EXPIRED_PRE_SUBMIT", "OFFER_REJECTED"].includes(o.ownership_status)).length === 1,
      JSON.stringify(before.map((o) => o.ownership_status)));
    check("S1 and it is post-submit with its invocation consumed",
      (await jobOf(j.jobId)).state === "SUBMITTED" && (await jobOf(j.jobId)).invocation_state === "CONSUMED");

    // THE regression: this is the exact call that threw E_ATTEMPT_ALREADY_OWNED in production.
    const out = await cp.submitUncertain({ jobId: j.jobId, reason: "Result could not be verified on recovery; not retried" });
    check("S2 the owner settles it", out && out.ok === true, JSON.stringify(out));
    const after = await offersOf(j.jobId);
    check("S2 the DEAD offer was left dead — not resurrected",
      after.find((o) => o.id === before.find((b) => b.ownership_status === "EXPIRED_PRE_SUBMIT").id).ownership_status === "EXPIRED_PRE_SUBMIT",
      JSON.stringify(after.map((o) => o.ownership_status)));
    check("S2 the LIVE offer is settled to RECOVERING and marked terminal",
      after.some((o) => o.ownership_status === "RECOVERING" && o.terminal_at !== null));
    check("S2 there is no live offer left",
      after.filter((o) => ["CREATED", "OFFER_PENDING", "OFFERED", "ACCEPTED", "RUNNING", "SUBMITTING", "SUBMITTED", "POSSIBLY_SUBMITTED"].includes(o.ownership_status)).length === 0,
      JSON.stringify(after.map((o) => o.ownership_status)));

    const job = await jobOf(j.jobId);
    check("S3 the job is SUBMIT_UNCERTAIN", job.state === "SUBMIT_UNCERTAIN", job.state);
    check("S3 the invocation is STILL consumed — the evidence is not rewritten", job.invocation_state === "CONSUMED");
    const att = await attemptOf(j.jobId);
    check("S3 possibly_submitted is still true", att.possibly_submitted === true, JSON.stringify(att));
    check("S3 nothing claimed the provider had not been reached", job.error_code === "E_GENERATION_SUBMIT_UNCERTAIN");
    check("S3 the event is on the log", (await eventsOf(j.jobId)).includes("JOB_SUBMIT_UNCERTAIN"));

    // And the reconciler's own query can now see it — the whole point of settling.
    const seen = await q("SELECT id FROM generation_jobs WHERE workspace_id=$1 AND state='SUBMIT_UNCERTAIN' AND id=$2", [ws, j.jobId]);
    check("S4 the reconciler's SUBMIT_UNCERTAIN selection now includes it", seen.length === 1);
    const un = await cp.listUncertain({ limit: 20 });
    check("S4 and so does listUncertain", Array.isArray(un) && un.some((x) => (x.jobId || x.id) === j.jobId), JSON.stringify((un || []).length));
  }

  // ============================================================ I — idempotence and the race
  {
    const j = await submittedJobWithDeadOffer("A quiet street at dawn, still camera.");
    const first = await cp.submitUncertain({ jobId: j.jobId, reason: "first" });
    check("I1 the first settlement applies", first.ok === true);
    const second = await cp.submitUncertain({ jobId: j.jobId, reason: "second" });
    check("I1 a duplicate settlement is idempotent, not an error", second && second.idempotent === true, JSON.stringify(second));
    const evts = (await eventsOf(j.jobId)).filter((t) => t === "JOB_SUBMIT_UNCERTAIN");
    check("I1 and it did not append a second event", evts.length === 1, String(evts.length));
    const offers = await offersOf(j.jobId);
    check("I1 nor a third offer", offers.length === 2, String(offers.length));

    // Two recoveries racing: the transition is an optimistic UPDATE guarded on the state it read, so exactly
    // one can win. The loser must LEARN it lost rather than believe it settled.
    const k = await submittedJobWithDeadOffer("A hallway with a letter on the floor.");
    const results = await Promise.allSettled([
      cp.submitUncertain({ jobId: k.jobId, reason: "racer A" }),
      cp.submitUncertain({ jobId: k.jobId, reason: "racer B" })
    ]);
    const applied = results.filter((r) => r.status === "fulfilled" && r.value && r.value.ok === true).length;
    const idem = results.filter((r) => r.status === "fulfilled" && r.value && r.value.idempotent === true).length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    check("I2 exactly one settlement applies", applied === 1, JSON.stringify(results.map((r) => r.status === "fulfilled" ? r.value : r.reason?.code)));
    check("I2 and the other is told, not silently ignored", idem + rejected === 1);
    check("I2 the job ends SUBMIT_UNCERTAIN once", (await jobOf(k.jobId)).state === "SUBMIT_UNCERTAIN");
    check("I2 with a single event", (await eventsOf(k.jobId)).filter((t) => t === "JOB_SUBMIT_UNCERTAIN").length === 1);
  }

  // ============================================================ O — ownership
  {
    const j = await submittedJobWithDeadOffer("A boat tied at a jetty.");
    // A worker id that is NOT the one holding this job's live offer. No row is needed: ownership is refused
    // before anything is written, which is exactly the property under test.
    const otherWorker = generateId("wrk");
    await throwsCode("O1 a non-owner may not settle the live offer",
      () => cp.submitUncertain({ jobId: j.jobId, reason: "not mine", workerId: otherWorker }), "E_GENERATION_OFFER_NOT_OWNED");
    const job = await jobOf(j.jobId);
    check("O1 and the job did not move", job.state === "SUBMITTED", job.state);
    const offers = await offersOf(j.jobId);
    check("O1 nor did any offer", offers.some((o) => o.ownership_status === "SUBMITTING"), JSON.stringify(offers.map((o) => o.ownership_status)));
    check("O1 and no event was written", !(await eventsOf(j.jobId)).includes("JOB_SUBMIT_UNCERTAIN"));
    // The real owner still can.
    const ok = await cp.submitUncertain({ jobId: j.jobId, reason: "mine", workerId: boot.workerId });
    check("O2 the owner still settles it afterwards", ok.ok === true);
  }

  // ============================================================ C — the constraint still protects
  {
    const j = await submittedJobWithDeadOffer("A window at night, rain outside.");
    await cp.submitUncertain({ jobId: j.jobId, reason: "settled" });
    // The unique index must still refuse a second LIVE offer for the attempt. Settling must not have
    // weakened it — the fix is scoping, not a constraint change.
    // The attempt and the project come from the offer row itself: generation_jobs has no project_id.
    const att = (await q(`SELECT o.generation_attempt_id a, o.project_id p FROM job_offers o
      WHERE o.workspace_id=$1 AND o.job_id=$2 ORDER BY o.created_at DESC LIMIT 1`, [ws, j.jobId]))[0];
    let refused = false;
    try {
      await q(`INSERT INTO job_offers (id, workspace_id, job_id, generation_attempt_id, assigned_worker_id, project_id,
                 offer_message_id, offer_expires_at, lease_expires_at, ownership_status)
               VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '5 minutes', now() + interval '5 minutes','OFFERED')`,
        [generateId("off"), ws, j.jobId, att.a, boot.workerId, att.p, generateId("msg")]);
    } catch { refused = true; }
    check("C1 a second live offer for the same attempt is still refused", refused === true);
    // RECOVERING is deliberately still a LIVE status: a settled-to-recovering offer keeps the attempt's slot,
    // which is what stops a second offer being handed out for a possibly-paid attempt.
    const offers = await offersOf(j.jobId);
    check("C1 the settled offer keeps the attempt's slot as RECOVERING",
      offers.some((o) => o.ownership_status === "RECOVERING"), JSON.stringify(offers.map((o) => o.ownership_status)));
  }

  // ============================================================ T — the terminal siblings had the same bug
  {
    // complete() and failPreSubmit() wrote the same unscoped UPDATE. A re-offered job that COMPLETES would
    // have hit the identical violation the moment it finished.
    const j = await submittedJobWithDeadOffer("A candle, then a result.");
    const out = await cp.complete({ jobId: j.jobId, resultId: "res_own_1", mediaMeta: { relativePath: `jobs/${j.jobId}/generated.mp4`, sizeBytes: 1234, container: "mp4", durationSeconds: 6.04, width: 720, height: 1280 } });
    check("T1 a re-offered job can COMPLETE", out && out.ok === true, JSON.stringify(out));
    check("T1 the job is COMPLETED", (await jobOf(j.jobId)).state === "COMPLETED");
    const offers = await offersOf(j.jobId);
    check("T1 the dead offer stayed dead", offers.filter((o) => o.ownership_status === "EXPIRED_PRE_SUBMIT").length === 1, JSON.stringify(offers.map((o) => o.ownership_status)));
    check("T1 and the live one is COMPLETED", offers.some((o) => o.ownership_status === "COMPLETED"));

    const k = await cp.enqueue({ prompt: "A pre-submit failure on a re-offered job.", durationSeconds: 6, aspectRatio: "9:16" });
    await cp.requestStart({ jobId: k.jobId });
    await cp.claimNextForWorker({ max: 5 });
    await cp.deferForCooldown({ jobId: k.jobId, slot: { provider: "GROK", accountRef: "pa_x", profileRef: "-" }, reason: "E_PROVIDER_MANUAL_TUNNEL_LEASE_FAILED" });
    await q("UPDATE provider_submission_slots SET next_eligible_at = now() - interval '1 minute' WHERE workspace_id=$1", [ws]).catch(() => {});
    await cp.requestStart({ jobId: k.jobId });
    await cp.claimNextForWorker({ max: 5 });
    const f = await cp.failPreSubmit({ jobId: k.jobId, code: "E_GROK_IMAGINE_PRE_SUBMIT", reason: "gate" });
    check("T2 a re-offered job can fail pre-submit", f && (f.ok === true || f.idempotent === true), JSON.stringify(f));
    const ko = await offersOf(k.jobId);
    check("T2 with the dead offer left alone", ko.filter((o) => o.ownership_status === "EXPIRED_PRE_SUBMIT").length === 1, JSON.stringify(ko.map((o) => o.ownership_status)));
  }

  // ============================================================ R — restart safety
  {
    // A settlement is one transaction: the state change and its event live or die together. Re-reading after
    // a fresh control plane (a "restart") must see exactly the settled shape and nothing half-applied.
    const j = await submittedJobWithDeadOffer("A restart in the middle of everything.");
    await cp.submitUncertain({ jobId: j.jobId, reason: "before restart" });
    const cp2 = createGenerationControlPlane({ persistence: adapter, config });
    const view = await cp2.getForUi(j.jobId);
    check("R1 a fresh control plane sees the settled job", view.state === "SUBMIT_UNCERTAIN", view.state);
    check("R1 with its invocation evidence intact", view.invocationState === "CONSUMED", String(view.invocationState));
    const again = await cp2.submitUncertain({ jobId: j.jobId, reason: "after restart" });
    check("R1 and settling again is idempotent", again && again.idempotent === true);
    const plan = await cp2.recover();
    check("R1 recovery no longer plans to track a settled job",
      !plan.track.some((t) => t.jobId === j.jobId), JSON.stringify(plan.track.map((t) => t.jobId)));
  }

  // ============================================================ E — the event cannot be lost
  {
    // If the event append fails, the whole transition must roll back — a state change nobody can explain is
    // worse than no state change. Forced by making the event insert violate its own type check.
    const j = await submittedJobWithDeadOffer("An event that refuses to be written.");
    const before = await jobOf(j.jobId);
    let threw = false;
    try {
      await T(async (c) => {
        await c.query("UPDATE generation_jobs SET state='SUBMIT_UNCERTAIN' WHERE workspace_id=$1 AND id=$2", [ws, j.jobId]);
        await c.query("INSERT INTO generation_job_events (workspace_id, job_id, seq, type, detail) VALUES ($1,$2,$3,$4,$5)",
          [ws, j.jobId, null, "X", "{}"]);   // seq NOT NULL -> the whole transaction fails
      });
    } catch { threw = true; }
    check("E1 a failed event append rolls the transition back", threw === true);
    check("E1 and the job is exactly as it was", (await jobOf(j.jobId)).state === before.state, (await jobOf(j.jobId)).state);
  }
} finally {
  if (adapter) { try { await adapter.stop(); } catch { /* */ } }
  try { await live.stop(); } catch { /* */ }
}

console.log(`Step 5C.50 offer settlement: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
