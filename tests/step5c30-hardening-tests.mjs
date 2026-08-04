// P0 Step 5C.30 — GENERATION OPERATIONAL HARDENING certification on REAL disposable PostgreSQL.
// Provider-free: no adapter is ever called; the clock is injected so cooldown windows are exact.
//
//  Part A — certified uncertain review: a SUBMIT_UNCERTAIN job keeps its state forever; a verdict recorded
//           ALONGSIDE it clears the operational action item without falsifying history.
//  Part B — durable provider cooldown: dispatch reserves a per-(provider,account,profile) lane; a job whose
//           lane is still cooling down is DEFERRED (stays QUEUED, holds no offer/lease, consumes no
//           invocation) with a durable ETA that survives a restart, is concurrency-safe across workers, is
//           scoped per lane (tenant A cannot block tenant B) and is FIFO within a lane.
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createGenerationControlPlane } from "../control-plane/src/api-staging/generation-control-plane.mjs";
import { createOpsSnapshot } from "../lib/ops/ops-snapshot.mjs";
import { createExecutionGate } from "../lib/protocol/generation-execution-gate.mjs";
import { classifyRunFailure, normalizeCooldownMs, reserveSlot, MAX_PROVIDER_COOLDOWN_MS, DEFAULT_PROVIDER_COOLDOWN_MS } from "../control-plane/src/api-staging/generation-cooldown.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";
import { classifyRoute } from "../control-plane/src/auth/http/auth-route-policy.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
async function throwsCode(fn, code) { try { await fn(); return false; } catch (e) { return code ? e.code === code : true; } }

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.30 hardening: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c30" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();

  const wsA = newId("ws"), wsB = newId("ws"), owner = newId("usr");
  await adapter.transaction(async (c) => {
    await c.query("INSERT INTO users (id,email) VALUES ($1,$2)", [owner, `o-${owner}@t.test`]);
    for (const w of [wsA, wsB]) { await c.query("SELECT set_config('app.current_workspace',$1,false)", [w]); await c.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'WS',$2)", [w, owner]); }
  });
  const T = (ws, fn) => adapter.tenantTransaction(ws, fn);

  // injected clock so cooldown windows are deterministic
  // Anchored to real time, not to a fixed instant. B6 asks PostgreSQL for the jobs whose eligibility is still
  // in the FUTURE (next_eligible_at > now()), and a hardcoded timestamp stops being the future the moment the
  // wall clock passes it — so the suite passed on the day it was written and failed every day after. In
  // production the writer and this reader share one clock; only the test was pinned.
  let clock = Date.now();
  const COOLDOWN = 120_000;
  const laneA = { provider: "GROK", accountRef: "pa_" + "A".repeat(26), profileRef: "profA" };
  const laneB = { provider: "GROK", accountRef: "pa_" + "B".repeat(26), profileRef: "profB" };
  let lane = laneA;
  const cfg = (ws) => ({ stagingApi: { workspaceId: ws }, generation: { providerCooldownMs: COOLDOWN } });
  const cpA = createGenerationControlPlane({ persistence: adapter, config: cfg(wsA), now: () => clock, slotResolver: () => lane });
  const cpB = createGenerationControlPlane({ persistence: adapter, config: cfg(wsB), now: () => clock, slotResolver: () => laneB });
  const enq = (cp, p) => cp.enqueue({ prompt: p, durationSeconds: 2, aspectRatio: "9:16" });

  // ================= Part A — certified uncertain review =================
  const j1 = await enq(cpA, "part A uncertain fixture one");
  const j2 = await enq(cpA, "part A uncertain fixture two");
  await T(wsA, async (c) => { for (const j of [j1.jobId, j2.jobId]) {
    await c.query("UPDATE generation_jobs SET state='SUBMIT_UNCERTAIN', invocation_state='CONSUMED', error_code='E_GENERATION_SUBMIT_UNCERTAIN', completed_at=now() WHERE id=$1", [j]);
    await c.query("UPDATE generation_attempts SET submission_state='SUBMITTED', submission_confidence='PRESUMED', possibly_submitted=true, ownership_status='FAILED', terminal_state='FAILED' WHERE id=(SELECT generation_attempt_id FROM generation_jobs WHERE id=$1)", [j]);
  } });
  const ops = createOpsSnapshot({ persistence: adapter, workspaceId: wsA, listAccounts: () => [], mediaRoot: process.env.TEMP || "/tmp", backupDir: process.env.TEMP || "/tmp", now: () => clock });
  let snap = await ops.snapshot();
  check("A1 two historical uncertain, both NEEDING review", snap.uncertain.historicalSubmissionsUncertain === 2 && snap.uncertain.uncertainNeedsReview === 2 && snap.uncertain.uncertainReviewed === 0);
  check("A2 unreviewed uncertain DEGRADES production", snap.readiness.degraded.includes("UNCERTAIN_NEEDS_REVIEW"));

  const before = await T(wsA, async (c) => (await c.query("SELECT state, invocation_state, result_id, error_code, revision FROM generation_jobs WHERE id=$1", [j1.jobId])).rows[0]);
  const rev1 = await cpA.reviewUncertain({ jobId: j1.jobId, verdict: "CONFIRMED_NOT_SUBMITTED", source: "OWNER_PROVIDER_GUI_INSPECTION", note: "owner inspected provider Projects; no matching output", evidence: { inspectedAt: "2026-07-24T20:00:00Z", surface: "grok-imagine-projects", matches: 0 }, reviewedByUserId: owner });
  check("A3 review recorded (revision 1)", rev1.ok === true && rev1.revision === 1 && rev1.idempotent === false);
  const after = await T(wsA, async (c) => (await c.query("SELECT state, invocation_state, result_id, error_code, revision FROM generation_jobs WHERE id=$1", [j1.jobId])).rows[0]);
  check("A4 the JOB ROW is byte-identical (history NOT falsified)", JSON.stringify(before) === JSON.stringify(after) && after.state === "SUBMIT_UNCERTAIN");
  snap = await ops.snapshot();
  check("A5 needsReview drops to 1, reviewed=1, historical still 2", snap.uncertain.uncertainNeedsReview === 1 && snap.uncertain.uncertainReviewed === 1 && snap.uncertain.historicalSubmissionsUncertain === 2);
  const dup = await cpA.reviewUncertain({ jobId: j1.jobId, verdict: "CONFIRMED_NOT_SUBMITTED", source: "OWNER_PROVIDER_GUI_INSPECTION", reviewedByUserId: owner });
  check("A6 replay is IDEMPOTENT (no new revision)", dup.idempotent === true && dup.revision === 1);
  const conc = await Promise.allSettled([1, 2, 3].map((i) => cpA.reviewUncertain({ jobId: j2.jobId, verdict: i === 1 ? "CONFIRMED_NOT_SUBMITTED" : "STILL_UNCERTAIN", source: "OPERATOR_ASSERTION", reviewedByUserId: owner })));
  const currents = await T(wsA, async (c) => (await c.query("SELECT count(*)::int n FROM generation_uncertain_reviews WHERE job_id=$1 AND superseded_at IS NULL", [j2.jobId])).rows[0].n);
  check("A7 concurrent reviewers -> exactly ONE current revision", Number(currents) === 1 && conc.filter((r) => r.status === "fulfilled").length >= 1);
  const history = await T(wsA, async (c) => Number((await c.query("SELECT count(*)::int n FROM generation_uncertain_reviews WHERE job_id=$1", [j2.jobId])).rows[0].n));
  check("A8 superseded revisions are KEPT as history", history >= 1);
  await cpA.reviewUncertain({ jobId: j2.jobId, verdict: "STILL_UNCERTAIN", source: "OPERATOR_ASSERTION", reviewedByUserId: owner });
  snap = await ops.snapshot();
  check("A9 STILL_UNCERTAIN keeps the action item (degraded stays)", snap.uncertain.uncertainNeedsReview === 1 && snap.readiness.degraded.includes("UNCERTAIN_NEEDS_REVIEW"));
  await cpA.reviewUncertain({ jobId: j2.jobId, verdict: "CONFIRMED_NOT_SUBMITTED", source: "OWNER_PROVIDER_GUI_INSPECTION", reviewedByUserId: owner });
  snap = await ops.snapshot();
  check("A10 both reviewed -> NO degraded, historical fact preserved", snap.uncertain.uncertainNeedsReview === 0 && snap.uncertain.historicalSubmissionsUncertain === 2 && !snap.readiness.degraded.includes("UNCERTAIN_NEEDS_REVIEW"));
  check("A11 bad verdict/source/note rejected (strict schema)",
    (await throwsCode(() => cpA.reviewUncertain({ jobId: j1.jobId, verdict: "NOPE", source: "OPERATOR_ASSERTION" }), "E_UNCERTAIN_REVIEW_VERDICT")) &&
    (await throwsCode(() => cpA.reviewUncertain({ jobId: j1.jobId, verdict: "STILL_UNCERTAIN", source: "HEARSAY" }), "E_UNCERTAIN_REVIEW_SOURCE")) &&
    (await throwsCode(() => cpA.reviewUncertain({ jobId: j1.jobId, verdict: "STILL_UNCERTAIN", source: "OPERATOR_ASSERTION", note: "x".repeat(2100) }), "E_UNCERTAIN_REVIEW_NOTE")));
  const okJob = await enq(cpA, "a normal queued job cannot be reviewed");
  check("A12 only a SUBMIT_UNCERTAIN job can be reviewed", await throwsCode(() => cpA.reviewUncertain({ jobId: okJob.jobId, verdict: "STILL_UNCERTAIN", source: "OPERATOR_ASSERTION" }), "E_UNCERTAIN_REVIEW_STATE"));
  const stored = await T(wsA, async (c) => (await c.query("SELECT evidence, review_note FROM generation_uncertain_reviews WHERE job_id=$1 AND superseded_at IS NULL", [j1.jobId])).rows[0]);
  check("A13 evidence stored contains NO secret material", !/token|cookie|password|secret|session/i.test(JSON.stringify(stored)));
  check("A14 review is workspace-scoped (tenant B sees none of A's reviews)", (await T(wsB, async (c) => Number((await c.query("SELECT count(*)::int n FROM generation_uncertain_reviews")).rows[0].n))) === 0);
  check("A15 the review route is strong-auth gated at the PDP", classifyRoute("POST", `/api/provider-management/generations/${j1.jobId}/uncertain-review`).policy !== "PUBLIC");
  check("A16 acknowledging never creates an invocation", (await T(wsA, async (c) => Number((await c.query("SELECT count(*)::int n FROM generation_jobs WHERE invocation_state='CONSUMED'")).rows[0].n))) === 2);

  // ================= Part B — durable provider cooldown =================
  check("B0 classifier: pacing signal retried, possibly-submitted + auth/policy NEVER", (() => {
    const a = classifyRunFailure({ code: "E_GROK_IMAGINE_PRE_SUBMIT", invocationConsumed: false });
    const b = classifyRunFailure({ code: "E_GROK_IMAGINE_PRE_SUBMIT", invocationConsumed: true });
    const c = classifyRunFailure({ code: "E_GENERATION_REAUTH_REQUIRED" });
    const d = classifyRunFailure({ code: "E_PROVIDER_POLICY_VIOLATION" });
    const e = classifyRunFailure({ code: "E_GROK_IMAGINE_PRE_SUBMIT", possiblySubmitted: true });
    const f = classifyRunFailure({ code: "E_SOMETHING_ELSE" });
    return a.kind === "COOLDOWN" && b.kind === "TERMINAL" && c.kind === "TERMINAL" && d.kind === "TERMINAL" && e.kind === "TERMINAL" && f.kind === "TERMINAL";
  })());
  check("B0b interval normalization is fail-safe + capped", normalizeCooldownMs(undefined) === DEFAULT_PROVIDER_COOLDOWN_MS && normalizeCooldownMs(-5) === DEFAULT_PROVIDER_COOLDOWN_MS && normalizeCooldownMs("x") === DEFAULT_PROVIDER_COOLDOWN_MS && normalizeCooldownMs(99_999_999) === MAX_PROVIDER_COOLDOWN_MS);

  const g1 = await enq(cpA, "lane job one");
  const g2 = await enq(cpA, "lane job two");
  const s1 = await cpA.requestStart({ jobId: g1.jobId });
  check("B1 first job takes the lane and is OFFERED", s1.dispatchStatus === "OFFERED");
  const s2 = await cpA.requestStart({ jobId: g2.jobId });
  check("B2 second job on the SAME lane is DEFERRED with an ETA", s2.dispatchStatus === "DEFERRED" && s2.deferred === true && new Date(s2.nextEligibleAt).getTime() === clock + COOLDOWN);
  const g2row = await T(wsA, async (c) => (await c.query("SELECT state, invocation_state, next_eligible_at, cooldown_reason, cooldown_attempt_count FROM generation_jobs WHERE id=$1", [g2.jobId])).rows[0]);
  check("B3 deferred job stays QUEUED, consumes NO invocation", g2row.state === "QUEUED" && g2row.invocation_state === null && g2row.cooldown_reason === "PROVIDER_COOLDOWN");
  const offers2 = await T(wsA, async (c) => Number((await c.query("SELECT count(*)::int n FROM job_offers WHERE generation_attempt_id=$1", [g2.generationAttemptId])).rows[0].n));
  check("B4 deferred job holds NO offer and NO lease", offers2 === 0);
  check("B5 deferred job is NOT startable before its time", (await cpA.listStartable()).every((x) => x.jobId !== g2.jobId));
  const paced = await ops.snapshot();
  check("B6 health reports the waiting count + nearest ETA", paced.generation.providerCooldownWaitingCount === 1 && typeof paced.generation.nearestProviderEligibleAt === "string");
  check("B7 waiting on pacing is NOT counted as stalled", paced.db.stalledJobs === 0);
  check("B8 pacing never blocks readiness (no cooldown/uncertain blocker)", !paced.readiness.blockers.some((b) => /COOLDOWN|UNCERTAIN|PACING/u.test(b)));

  // --- restart safety: a brand-new control plane instance still honours the durable ETA ---
  const cpRestart = createGenerationControlPlane({ persistence: adapter, config: cfg(wsA), now: () => clock, slotResolver: () => lane });
  const s2b = await cpRestart.requestStart({ jobId: g2.jobId });
  check("B9 after a RESTART the lane ETA survives (still deferred, no duplicate offer)", s2b.dispatchStatus === "DEFERRED");
  check("B10 still no offer after the restart attempt", (await T(wsA, async (c) => Number((await c.query("SELECT count(*)::int n FROM job_offers WHERE generation_attempt_id=$1", [g2.generationAttemptId])).rows[0].n))) === 0);

  // --- the lane frees up on time ---
  clock += COOLDOWN;
  check("B11 job becomes startable exactly at nextEligibleAt", (await cpA.listStartable()).some((x) => x.jobId === g2.jobId));
  const s2c = await cpA.requestStart({ jobId: g2.jobId });
  check("B12 it is dispatched once the lane is free", s2c.dispatchStatus === "OFFERED");
  check("B13 exactly ONE offer exists for it (no duplicate dispatch)", (await T(wsA, async (c) => Number((await c.query("SELECT count(*)::int n FROM job_offers WHERE generation_attempt_id=$1", [g2.generationAttemptId])).rows[0].n))) === 1);

  // --- concurrency: two racing reservations, one winner ---
  clock += COOLDOWN;
  const race = await Promise.all([1, 2, 3, 4].map(() => adapter.transaction((c) => reserveSlot(c, { ...lane, nowMs: clock, baseCooldownMs: COOLDOWN, newId }))));
  check("B14 four concurrent reservations on one lane -> exactly ONE granted", race.filter((r) => r.granted).length === 1);

  // --- per-lane scoping: another account/tenant is unaffected ---
  const b1 = await enq(cpB, "tenant B lane job");
  const sb1 = await cpB.requestStart({ jobId: b1.jobId });
  check("B15 a DIFFERENT account/profile lane is NOT blocked by lane A's cooldown", sb1.dispatchStatus === "OFFERED");

  // --- FIFO within a lane ---
  clock += COOLDOWN;
  const f1 = await enq(cpA, "fifo first");
  clock += 1000;
  const f2 = await enq(cpA, "fifo second");
  await cpA.requestStart({ jobId: f1.jobId });   // takes the lane
  await cpA.requestStart({ jobId: f2.jobId });   // deferred
  clock += COOLDOWN;
  const startable = await cpA.listStartable();
  check("B16 FIFO within a lane (oldest deferred job first)", startable.length >= 1 && startable[0].jobId === f2.jobId);

  // --- provider cooldown signal raises backoff, bounded, and never terminal-fails immediately ---
  const c1 = await enq(cpA, "cooldown signal job");
  const d1 = await cpA.deferForCooldown({ jobId: c1.jobId, slot: lane, reason: "E_GROK_IMAGINE_PRE_SUBMIT" });
  check("B17 a proven pre-submit refusal DEFERS instead of failing terminally", d1.deferred === true && d1.attempts === 1);
  const afterSignal = await T(wsA, async (c) => (await c.query("SELECT state FROM generation_jobs WHERE id=$1", [c1.jobId])).rows[0].state);
  check("B18 the job is still QUEUED (no FAILED_PRE_SUBMIT burned)", afterSignal === "QUEUED");
  const slotRow = await adapter.transaction(async (c) => (await c.query("SELECT cooldown_ms, consecutive_cooldowns FROM provider_submission_slots WHERE account_ref=$1", [lane.accountRef])).rows[0]);
  check("B19 the lane backoff GREW after a real cooldown signal", slotRow.cooldown_ms > COOLDOWN && slotRow.consecutive_cooldowns === 1);
  await cpA.noteSubmitOutcome({ slot: lane, outcome: "SUBMITTED" });
  const resetRow = await adapter.transaction(async (c) => (await c.query("SELECT cooldown_ms, consecutive_cooldowns FROM provider_submission_slots WHERE account_ref=$1", [lane.accountRef])).rows[0]);
  check("B20 a successful submit RESETS the lane to the base interval", resetRow.cooldown_ms === COOLDOWN && resetRow.consecutive_cooldowns === 0);
  let deferrals = 0;
  for (let i = 0; i < 20; i += 1) { const r = await cpA.deferForCooldown({ jobId: c1.jobId, slot: lane, reason: "E_GROK_IMAGINE_PRE_SUBMIT" }); if (r.deferred) deferrals += 1; else { check("B21 deferrals are BOUNDED (no infinite hang)", r.exhausted === true); break; } }
  check("B22 bounded retry count is sane", deferrals > 0 && deferrals <= 12);
  const capped = await adapter.transaction(async (c) => (await c.query("SELECT cooldown_ms FROM provider_submission_slots WHERE account_ref=$1", [lane.accountRef])).rows[0].cooldown_ms);
  check("B23 backoff is CAPPED", capped <= MAX_PROVIDER_COOLDOWN_MS);

  // --- pause interaction: a paused runtime dispatches nothing ---
  const cpPaused = createGenerationControlPlane({ persistence: adapter, config: cfg(wsA), now: () => clock, slotResolver: () => lane, executionGate: createExecutionGate({ paused: true }) });
  check("B24 maintenance pause still refuses dispatch (pacing does not bypass it)", await throwsCode(() => cpPaused.requestStart({ jobId: c1.jobId }), "E_GENERATION_EXECUTION_PAUSED"));

  // --- clock skew: a backwards clock must not release a lane early ---
  clock -= 60_000;
  const skew = await cpA.listStartable();
  check("B25 a backwards clock does NOT make a cooling job eligible early", skew.every((x) => x.jobId !== c1.jobId));

  // --- snapshot surface ---
  const cd = await cpA.cooldownSnapshot();
  check("B26 cooldown snapshot exposes base interval + lanes (no secrets)", cd.baseCooldownMs === COOLDOWN && Array.isArray(cd.slots) && cd.slots.length >= 2 && !/token|cookie|password|secret/i.test(JSON.stringify(cd)));

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}

main().then(() => {
  console.log(`\nStep 5C.30 hardening: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
