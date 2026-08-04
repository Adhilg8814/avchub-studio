// AVC Studio P0 Step 5.7a — recovery-contract PROPERTY tests.
//
// SAFE BY CONSTRUCTION: throwaway temp dirs only; no ui-server / browser / Python /
// provider / socket / credential / production media / quota. Every "generation" is a
// journal write.
//
// These tests do not check a fixed scenario — they assert INVARIANTS hold across large
// spaces of operation sequences. The headline invariant (the golden rule):
//
//   For any sequence of lifecycle + recovery operations applied to any number of
//   sibling jobs that share one generationAttemptId, AT MOST ONE paid generation is
//   ever booked to that attempt.
//
// The adversary in the fuzz is a recovery step that, after every operation, re-reads a
// record and — if the recovery plan claims it is safe — tries to (re)generate. The
// invariant must survive that adversary for every sequence.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateId } from "../lib/protocol/ids.mjs";
import { WORKER_ERRORS } from "../lib/worker/journal-safety.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import {
  LOCAL_STATES, canRecoveryTransition, isPreSubmitLocalState, isPostSubmitLocalState,
  isTerminalLocalState
} from "../lib/worker/recovery-states.mjs";
import {
  classifyRecoveryContract, planRecovery, assertNoAutoRegenerate,
  RECOVERY_CONTRACT_STATES
} from "../lib/worker/recovery-classifier.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}

// Deterministic PRNG (mulberry32) — reproducible fuzz without Math.random.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tmpDirs = [];
const mkTmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "avc-rprop-")); tmpDirs.push(d); return d; };
function seqClock(startMs = Date.UTC(2026, 0, 1)) { let t = startMs; return () => new Date(t += 1000).toISOString(); }

// Count paid generations booked to an attempt across all its sibling records.
function paidGenerations(journal, attemptId) {
  const recs = journal.listByAttempt(attemptId);
  const byOrdinal = recs.filter((r) => (r.generationOrdinal || 0) >= 1).length;
  const bySubmitted = recs.filter((r) => r.submittedToProvider === true || isPostSubmitLocalState(r.localState)).length;
  return { byOrdinal, bySubmitted, recs };
}

try {
  // ======================================================================
  // PROPERTY 1 — the transition table can never regress past submission.
  // For EVERY ordered pair of states, if the transition is legal it must not go from a
  // post-submit state back to a pre-submit state, and SUBMITTING is never re-enterable.
  // ======================================================================
  {
    const states = Object.values(LOCAL_STATES);
    let violations = 0, regress = 0, resubmit = 0;
    for (const from of states) {
      for (const to of states) {
        if (!canRecoveryTransition(from, to)) continue;
        // legal transition — check it never regresses across the submission boundary
        if (isPostSubmitLocalState(from) && isPreSubmitLocalState(to)) { regress += 1; violations += 1; }
        // a terminal state must have no outgoing legal transition at all
        if (isTerminalLocalState(from)) { violations += 1; }
        // SUBMITTING must never be a legal TARGET from a post-submit state (re-submit)
        if (to === "SUBMITTING" && isPostSubmitLocalState(from)) { resubmit += 1; violations += 1; }
      }
    }
    check("P1 no legal transition regresses past submission", regress, 0);
    check("P1 no legal re-submit from post-submit", resubmit, 0);
    check("P1 no terminal has outgoing transitions", violations, 0);
  }

  // ======================================================================
  // PROPERTY 2 — recovery is safe-to-retry ONLY in PRE_SUBMIT, for every reachable
  // record shape. Build a representative record for each contract state and assert.
  // ======================================================================
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const mk = (build) => { const id = generateId("job"); j.create({ jobId: id, action: "GENERATE_GROK_VIDEO", generationAttemptId: generateId("attempt") }); build(id); return j.read(id); };
    const samples = [
      mk(() => {}),                                                                                   // PRE_SUBMIT (created)
      mk((id) => j.markRunning(id)),                                                                  // PRE_SUBMIT (running)
      mk((id) => { j.markRunning(id); j.markSubmitting(id); }),                                       // SUBMITTING_UNKNOWN
      mk((id) => { j.markRunning(id); j.markSubmitting(id); j.markSubmitted(id, generateId("submission")); }), // SUBMITTED_WAITING
      mk((id) => { j.markRunning(id); j.markSubmitting(id); j.markSubmitted(id, generateId("submission")); j.markProgress(id, { sequence: 1, resultAvailable: true }); }), // RESULT_AVAILABLE
      mk((id) => { j.markRunning(id); j.markSubmitting(id); j.markSubmitted(id, generateId("submission")); j.markLocalResult(id, { localResultRef: "p/out.mp4" }); }), // DOWNLOADED
      mk((id) => { j.markRunning(id); j.markSubmitting(id); j.markSubmitted(id, generateId("submission")); j.markLocalResult(id, { localResultRef: "p/out.mp4", importedAssetId: generateId("asset") }); }), // IMPORTED
      mk((id) => { j.markRunning(id); j.markSubmitting(id); j.markSubmitted(id, generateId("submission")); j.markProgress(id, { phase: "NEEDS_MANUAL_ACTION", sequence: 1 }); }), // MANUAL
      mk((id) => { j.markRunning(id); j.markSubmitted(id, generateId("submission")); j.markTerminal(id, { type: "JOB_COMPLETED" }); }), // TERMINAL_PENDING_ACK
      mk((id) => { j.markRunning(id); j.markSubmitted(id, generateId("submission")); j.markTerminal(id, { type: "JOB_COMPLETED" }); j.markAcknowledged(id); }) // SETTLED
    ];
    let badRetry = 0, badAssert = 0;
    for (const rec of samples) {
      const state = classifyRecoveryContract(rec);
      const plan = planRecovery(rec);
      const isPreSubmit = state === RECOVERY_CONTRACT_STATES.PRE_SUBMIT;
      if (plan.safeToRetry !== isPreSubmit) badRetry += 1;
      // assertNoAutoRegenerate passes iff PRE_SUBMIT
      let threw = false;
      try { assertNoAutoRegenerate(rec); } catch { threw = true; }
      if (threw === isPreSubmit) badAssert += 1; // should NOT throw for pre-submit, SHOULD throw otherwise
    }
    check("P2 safeToRetry ⇔ PRE_SUBMIT for every state", badRetry, 0);
    check("P2 assertNoAutoRegenerate ⇔ non-PRE_SUBMIT throws", badAssert, 0);
  }

  // ======================================================================
  // PROPERTY 3 — GOLDEN-RULE FUZZ. Over many random sequences against sibling jobs of
  // one attempt (including crash/restart and an adversarial recover-and-retry op), the
  // attempt never accrues more than one paid generation.
  // ======================================================================
  {
    const SEQUENCES = 3000;
    const OPS_PER = 14;
    let worstPaid = 0;
    let sawSubmit = 0;      // sequences where at least one generation was booked
    let dupRejections = 0;  // times the golden-rule guard fired
    let otherThrows = 0;    // any throw that is NOT the golden-rule guard (allowed: illegal transitions)
    let invariantBreaks = 0;

    for (let s = 0; s < SEQUENCES; s += 1) {
      const rnd = mulberry32(0x51ED + s * 2654435761);
      const root = mkTmp();
      let j = new RecoveryJournal({ root, now: seqClock(Date.UTC(2026, 0, 1) + s * 1000) });
      const attemptId = generateId("attempt");
      const nJobs = 1 + Math.floor(rnd() * 3); // 1..3 sibling jobs
      const jobs = [];
      for (let k = 0; k < nJobs; k += 1) {
        const id = generateId("job");
        j.create({ jobId: id, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId, attemptIndex: 0 });
        jobs.push(id);
      }
      const OPS = ["run", "submitting", "submitted", "download", "result", "import", "terminal", "ackpending", "ack", "recover", "restart"];
      for (let o = 0; o < OPS_PER; o += 1) {
        const job = jobs[Math.floor(rnd() * jobs.length)];
        const op = OPS[Math.floor(rnd() * OPS.length)];
        try {
          switch (op) {
            case "run": j.markRunning(job); break;
            case "submitting": j.markSubmitting(job); break;
            case "submitted": j.markSubmitted(job, generateId("submission")); break;
            case "download": j.markDownloading(job); break;
            case "result": j.markLocalResult(job, { localResultRef: "p/out.mp4" }); break;
            case "import": j.markLocalResult(job, { localResultRef: "p/out.mp4", importedAssetId: generateId("asset") }); break;
            case "terminal": j.markTerminal(job, { type: "JOB_COMPLETED" }); break;
            case "ackpending": j.markAckPending(job, generateId("msg")); break;
            case "ack": j.markAcknowledged(job); break;
            case "recover": {
              // Adversarial: re-read and, if the plan claims safe, try to (re)generate.
              const rec = j.read(job);
              if (planRecovery(rec).safeToRetry) j.markSubmitting(job);
              break;
            }
            case "restart": j = new RecoveryJournal({ root, now: seqClock(Date.UTC(2026, 1, 1) + s * 1000) }); break;
          }
        } catch (e) {
          if (e.code === WORKER_ERRORS.E_DUPLICATE_GENERATION_ATTEMPT) dupRejections += 1;
          else if (e.code === WORKER_ERRORS.E_ILLEGAL_RECOVERY_TRANSITION) { /* expected on out-of-order ops */ }
          else otherThrows += 1;
        }
      }
      const { byOrdinal, bySubmitted } = paidGenerations(j, attemptId);
      const paid = Math.max(byOrdinal, bySubmitted);
      worstPaid = Math.max(worstPaid, paid);
      if (paid >= 1) sawSubmit += 1;
      if (paid > 1) invariantBreaks += 1;
    }

    check("P3 golden rule: max 1 paid generation over ALL sequences", worstPaid <= 1, true);
    check("P3 zero invariant breaks", invariantBreaks, 0);
    check("P3 no unexpected throws (only golden-rule + illegal-transition)", otherThrows, 0);
    check("P3 fuzz actually exercised submissions", sawSubmit > 0, true);
    check("P3 golden-rule guard actually fired", dupRejections > 0, true);
  }

  // ======================================================================
  // PROPERTY 4 — CRASH-WINDOW. Drive a job step by step; at EVERY step, simulate a crash
  // (fresh journal over the same root) and assert recovery never proposes RETRY_SAFE once
  // the submit barrier (markSubmitting) has been crossed.
  // ======================================================================
  {
    let leaks = 0, checkedPostSubmit = 0;
    const steps = [
      (j, id) => {},
      (j, id) => j.markRunning(id),
      (j, id) => j.markSubmitting(id),       // barrier crossed here
      (j, id) => j.markSubmitted(id, generateId("submission")),
      (j, id) => j.markLocalResult(id, { localResultRef: "p/out.mp4" }),
      (j, id) => j.markLocalResult(id, { localResultRef: "p/out.mp4", importedAssetId: generateId("asset") }),
      (j, id) => j.markTerminal(id, { type: "JOB_COMPLETED" })
    ];
    for (let cut = 0; cut < steps.length; cut += 1) {
      const root = mkTmp();
      let j = new RecoveryJournal({ root, now: seqClock() });
      const id = generateId("job"); const att = generateId("attempt");
      j.create({ jobId: id, action: "GENERATE_GROK_VIDEO", generationAttemptId: att });
      for (let i = 0; i <= cut; i += 1) steps[i](j, id);
      // crash + restart
      const j2 = new RecoveryJournal({ root, now: seqClock() });
      const rec = j2.read(id);
      const barrierCrossed = (rec.generationOrdinal || 0) >= 1 || rec.submittedToProvider === true || rec.localState === "SUBMITTING";
      if (barrierCrossed) {
        checkedPostSubmit += 1;
        if (planRecovery(rec).safeToRetry) leaks += 1;
        try { assertNoAutoRegenerate(rec); leaks += 1; } catch { /* expected */ }
      }
    }
    check("P4 no RETRY_SAFE leak after submit barrier", leaks, 0);
    check("P4 exercised post-barrier recovery", checkedPostSubmit > 0, true);
  }

  check("no unhandled rejection", un, false);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
