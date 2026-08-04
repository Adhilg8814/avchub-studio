#!/usr/bin/env node
// P0 Step 5C.8B2 — Checkpoint 1: OFFLINE recovery classifier + journal-transition suite.
//
// PURE + file-backed-journal proofs (no PostgreSQL, no socket, no browser, no provider). This is the
// deterministic foundation for the B2 crash matrix: it pins, from source, exactly how each durable
// crash window classifies and what recovery plan is safe — so the live B2 harness only has to prove
// that the real system reaches those durable states. Golden rule everywhere: a record that has left
// the pre-submit window can NEVER be auto-regenerated.
//
// Run: node tests/step5c8-recovery-classifier-tests.mjs

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateId } from "../lib/protocol/ids.mjs";
import {
  LOCAL_STATES, TERMINAL_LOCAL_STATES, PRE_SUBMIT_LOCAL_STATES, POST_SUBMIT_LOCAL_STATES,
  canRecoveryTransition, assertRecoveryTransition, legalNextStates,
  isTerminalLocalState, isPreSubmitLocalState, isPostSubmitLocalState,
  SUBMISSION_STATE, SUBMISSION_CONFIDENCE, IDEMPOTENCY_SUPPORT
} from "../lib/worker/recovery-states.mjs";
import {
  RECOVERY_STATES, RECOVERY_CONTRACT_STATES, RECOVERY_ACTIONS,
  classifyRecovery, classifyRecoveryContract, planRecovery,
  canAutoRetryGeneration, canRecoverWithoutNewGeneration, isRecoverable, assertNoAutoRegenerate
} from "../lib/worker/recovery-classifier.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import { buildRecoveryReport } from "../lib/worker/reconcile-builder.mjs";

let passed = 0, failed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function checkThrows(name, fn, code = undefined) {
  try { fn(); failed += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) { if (code && e.code !== code) { failed += 1; console.error(`FAIL ${name} (code ${e.code} != ${code})`); } else passed += 1; }
}
const ROOTS = [];
function freshJournal() { const r = mkdtempSync(path.join(os.tmpdir(), "avc5c8b2-jr-")); ROOTS.push(r); return new RecoveryJournal({ root: r }); }

// ===================== PART A — recovery state machine (pure) =====================
{
  // forward pipeline is legal
  check("CREATED→RUNNING legal", canRecoveryTransition("CREATED", "RUNNING"), true);
  check("RUNNING→SUBMITTING legal", canRecoveryTransition("RUNNING", "SUBMITTING"), true);
  check("SUBMITTING→SUBMITTED legal", canRecoveryTransition("SUBMITTING", "SUBMITTED"), true);
  check("SUBMITTED→DOWNLOADING legal", canRecoveryTransition("SUBMITTED", "DOWNLOADING"), true);
  check("DOWNLOADING→IMPORTED legal", canRecoveryTransition("DOWNLOADING", "IMPORTED"), true);
  check("IMPORTED→SUCCEEDED legal", canRecoveryTransition("IMPORTED", "SUCCEEDED"), true);

  // the golden-rule-critical ILLEGAL moves
  check("SUBMITTING→SUBMITTING illegal (no re-submit)", canRecoveryTransition("SUBMITTING", "SUBMITTING"), false);
  check("SUBMITTING→RUNNING illegal (no regress to pre-submit)", canRecoveryTransition("SUBMITTING", "RUNNING"), false);
  check("SUBMITTED→RUNNING illegal", canRecoveryTransition("SUBMITTED", "RUNNING"), false);
  check("SUBMITTED→CREATED illegal", canRecoveryTransition("SUBMITTED", "CREATED"), false);
  check("IMPORTED→SUBMITTING illegal (no re-submit after import)", canRecoveryTransition("IMPORTED", "SUBMITTING"), false);
  check("SUCCEEDED→anything illegal (terminal absorbing)", canRecoveryTransition("SUCCEEDED", "RUNNING"), false);
  check("FAILED→SUCCEEDED illegal", canRecoveryTransition("FAILED", "SUCCEEDED"), false);
  check("unknown state illegal", canRecoveryTransition("NONSENSE", "RUNNING"), false);
  // terminal self-move is a no-op (not a transition)
  check("SUCCEEDED→SUCCEEDED not a transition", canRecoveryTransition("SUCCEEDED", "SUCCEEDED"), false);
  check("RUNNING→RUNNING idempotent self-move allowed", canRecoveryTransition("RUNNING", "RUNNING"), true);
  checkThrows("assertRecoveryTransition throws on illegal", () => assertRecoveryTransition("SUBMITTED", "RUNNING"), "E_ILLEGAL_RECOVERY_TRANSITION");

  // NEEDS_MANUAL_ACTION resume can go forward to any non-pre-submit stage (ordinal guard, not table, stops re-billing)
  check("NMA→SUBMITTED legal (resume)", canRecoveryTransition("NEEDS_MANUAL_ACTION", "SUBMITTED"), true);
  check("NMA→SUBMITTING legal (resume; ordinal guards billing)", canRecoveryTransition("NEEDS_MANUAL_ACTION", "SUBMITTING"), true);

  // membership sets
  check("pre-submit set", [...PRE_SUBMIT_LOCAL_STATES].sort(), ["CREATED", "RUNNING"]);
  check("post-submit set", [...POST_SUBMIT_LOCAL_STATES].sort(), ["DOWNLOADING", "IMPORTED", "SUBMITTED", "SUBMITTING"]);
  check("terminal set", [...TERMINAL_LOCAL_STATES].sort(), ["CANCELED", "FAILED", "SUCCEEDED"]);
  check("isPostSubmit(SUBMITTING)", isPostSubmitLocalState("SUBMITTING"), true);
  check("isPreSubmit(RUNNING)", isPreSubmitLocalState("RUNNING"), true);
  check("isTerminal(CANCELED)", isTerminalLocalState("CANCELED"), true);
  check("legalNextStates(SUBMITTING) excludes RUNNING/CREATED/SUBMITTING", legalNextStates("SUBMITTING").sort(), ["CANCELED", "FAILED", "NEEDS_MANUAL_ACTION", "SUBMITTED"]);
}

// ===================== PART B — recovery classifier (pure) =====================
// hand-built records represent the durable journal state at each B2 crash window.
const REC = {
  preSubmit: { jobId: generateId("job"), localState: "RUNNING", submissionState: "NOT_SUBMITTED", submittedToProvider: false, generationOrdinal: 0 },
  submittingUnknown: { jobId: generateId("job"), localState: "SUBMITTING", submissionState: "SUBMITTING", submissionConfidence: "UNKNOWN", submittedToProvider: false, generationOrdinal: 1 },
  submittedWaiting: { jobId: generateId("job"), localState: "SUBMITTED", submissionState: "SUBMITTED", submittedToProvider: true, generationOrdinal: 1 },
  resultAvailable: { jobId: generateId("job"), submissionState: "SUBMITTED", submittedToProvider: true, resultAvailable: true, generationOrdinal: 1 },
  downloaded: { jobId: generateId("job"), submissionState: "SUBMITTED", submittedToProvider: true, localResultRef: "media/x/y.mp4", generationOrdinal: 1 },
  imported: { jobId: generateId("job"), submissionState: "SUBMITTED", submittedToProvider: true, localResultRef: "media/x/y.mp4", importedAssetId: generateId("asset"), generationOrdinal: 1 },
  terminalPending: { jobId: generateId("job"), terminal: { type: "JOB_COMPLETED", messageId: generateId("msg") }, acknowledged: false },
  settled: { jobId: generateId("job"), terminal: { type: "JOB_COMPLETED", messageId: generateId("msg") }, acknowledged: true },
  manual: { jobId: generateId("job"), localState: "NEEDS_MANUAL_ACTION", needsManualAction: true },
  corrupt: { jobId: generateId("job"), corrupt: true },
  inconsistent: { jobId: generateId("job"), submittedToProvider: false, localResultRef: "media/x/y.mp4" } // result without submit
};

// Step-3 classifier
check("classify preSubmit", classifyRecovery(REC.preSubmit), RECOVERY_STATES.NOT_SUBMITTED_SAFE_TO_RETRY);
check("classify submittedWaiting", classifyRecovery(REC.submittedWaiting), RECOVERY_STATES.SUBMITTED_WAIT_FOR_PROVIDER);
check("classify downloaded", classifyRecovery(REC.downloaded), RECOVERY_STATES.DOWNLOADED_NOT_IMPORTED);
check("classify imported", classifyRecovery(REC.imported), RECOVERY_STATES.IMPORTED_NOT_ACKNOWLEDGED);
check("classify terminalPending", classifyRecovery(REC.terminalPending), RECOVERY_STATES.TERMINAL_PENDING_ACK);
check("classify settled", classifyRecovery(REC.settled), RECOVERY_STATES.SETTLED);
check("classify manual", classifyRecovery(REC.manual), RECOVERY_STATES.MANUAL_ACTION_REQUIRED);
check("classify corrupt", classifyRecovery(REC.corrupt), RECOVERY_STATES.CORRUPT_JOURNAL);
check("classify inconsistent → operator", classifyRecovery(REC.inconsistent), RECOVERY_STATES.UNKNOWN_NEEDS_OPERATOR);

// Step-5.7a fine-grained contract (the crash windows)
check("contract preSubmit", classifyRecoveryContract(REC.preSubmit), RECOVERY_CONTRACT_STATES.PRE_SUBMIT);
check("contract submittingUnknown", classifyRecoveryContract(REC.submittingUnknown), RECOVERY_CONTRACT_STATES.SUBMITTING_UNKNOWN);
check("contract submittedWaiting", classifyRecoveryContract(REC.submittedWaiting), RECOVERY_CONTRACT_STATES.SUBMITTED_WAITING);
check("contract resultAvailable", classifyRecoveryContract(REC.resultAvailable), RECOVERY_CONTRACT_STATES.RESULT_AVAILABLE);
check("contract downloaded", classifyRecoveryContract(REC.downloaded), RECOVERY_CONTRACT_STATES.DOWNLOADED);
check("contract imported", classifyRecoveryContract(REC.imported), RECOVERY_CONTRACT_STATES.IMPORTED);
check("contract terminalPending", classifyRecoveryContract(REC.terminalPending), RECOVERY_CONTRACT_STATES.TERMINAL_PENDING_ACK);
check("contract settled", classifyRecoveryContract(REC.settled), RECOVERY_CONTRACT_STATES.SETTLED);
check("contract manual", classifyRecoveryContract(REC.manual), RECOVERY_CONTRACT_STATES.MANUAL_ACTION_REQUIRED);

// planRecovery — the safety matrix that governs B2's expected outcomes
check("plan preSubmit = RETRY_SAFE + safeToRetry", planRecovery(REC.preSubmit), { state: "PRE_SUBMIT", action: "RETRY_SAFE", safeToRetry: true, needsOperator: false, canResume: true, inspectProvider: false });
check("plan submittingUnknown = INSPECT_PROVIDER, NOT safeToRetry", (() => { const p = planRecovery(REC.submittingUnknown); return { a: p.action, s: p.safeToRetry, o: p.needsOperator }; })(), { a: "INSPECT_PROVIDER", s: false, o: true });
check("plan submittingUnknown w/o provider lookup → ESCALATE_OPERATOR", (() => { const p = planRecovery(REC.submittingUnknown, { supportsSubmissionLookup: false }); return { a: p.action, degraded: p.degradedNoLookup === true, s: p.safeToRetry }; })(), { a: "ESCALATE_OPERATOR", degraded: true, s: false });
check("plan submittedWaiting = WAIT_FOR_PROVIDER, not safeToRetry", (() => { const p = planRecovery(REC.submittedWaiting); return { a: p.action, s: p.safeToRetry }; })(), { a: "WAIT_FOR_PROVIDER", s: false });
check("plan imported = REDELIVER_TERMINAL, canResume, not safeToRetry", (() => { const p = planRecovery(REC.imported); return { a: p.action, s: p.safeToRetry, r: p.canResume }; })(), { a: "REDELIVER_TERMINAL", s: false, r: true });

// the hard guards
check("canAutoRetry only for preSubmit", canAutoRetryGeneration(REC.preSubmit), true);
// P0 Step 5C.8B2 Checkpoint 6 — the conservative fine-grained planner is now the SINGLE source of truth:
// canAutoRetryGeneration is aligned to planRecovery (only PRE_SUBMIT is auto-retry-safe). The former
// coarse/fine discrepancy for SUBMITTING_UNKNOWN is RESOLVED.
check("ALIGNED: canAutoRetry FALSE for submittingUnknown (planner is the single source of truth)", canAutoRetryGeneration(REC.submittingUnknown), false);
check("canAutoRetry AGREES with planRecovery.safeToRetry for submittingUnknown", canAutoRetryGeneration(REC.submittingUnknown), planRecovery(REC.submittingUnknown).safeToRetry);
// table-driven: for EVERY recovery class, canAutoRetryGeneration === planRecovery.safeToRetry.
for (const [name, r] of Object.entries(REC)) {
  check(`planner alignment: canAutoRetry === planRecovery.safeToRetry for ${name}`, canAutoRetryGeneration(r), planRecovery(r).safeToRetry);
}
for (const k of ["submittedWaiting", "resultAvailable", "downloaded", "imported"]) check(`canAutoRetry false for ${k} (submitted)`, canAutoRetryGeneration(REC[k]), false);
check("canRecoverWithoutNewGeneration(imported)", canRecoverWithoutNewGeneration(REC.imported), true);
check("isRecoverable(settled)=false", isRecoverable(REC.settled), false);
check("assertNoAutoRegenerate passes for preSubmit", (() => { assertNoAutoRegenerate(REC.preSubmit); return true; })(), true);
for (const k of ["submittingUnknown", "submittedWaiting", "downloaded", "imported"]) {
  checkThrows(`assertNoAutoRegenerate throws for ${k}`, () => assertNoAutoRegenerate(REC[k]), "E_DUPLICATE_GENERATION_ATTEMPT");
}

// ===================== PART C — real file-backed journal transitions (crash windows) =====================
{
  const j = freshJournal();
  const jobId = generateId("job");
  j.create({ jobId, action: "GENERATE_VIDEO", generationAttemptId: generateId("attempt"), requestIdempotencyKey: generateId("req"), quotaRisk: true });
  let rec = j.read(jobId);
  check("journal create → CREATED, ordinal 0, NOT_SUBMITTED", { s: rec.localState, o: rec.generationOrdinal, ss: rec.submissionState }, { s: "CREATED", o: 0, ss: "NOT_SUBMITTED" });
  check("fresh record classifies PRE_SUBMIT", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.PRE_SUBMIT);

  j.markRunning(jobId);
  check("markRunning → RUNNING, still PRE_SUBMIT, ordinal 0", { s: j.read(jobId).localState, c: classifyRecoveryContract(j.read(jobId)), o: j.read(jobId).generationOrdinal }, { s: "RUNNING", c: "PRE_SUBMIT", o: 0 });

  // ---- scenario 6 injection boundary: markSubmitting ----
  j.markSubmitting(jobId, { providerIdempotencyKey: null, idempotencySupport: IDEMPOTENCY_SUPPORT.NONE });
  rec = j.read(jobId);
  check("markSubmitting → SUBMITTING, ordinal 1, confidence UNKNOWN", { s: rec.submissionState, o: rec.generationOrdinal, c: rec.submissionConfidence }, { s: "SUBMITTING", o: 1, c: "UNKNOWN" });
  check("post-markSubmitting classifies SUBMITTING_UNKNOWN", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.SUBMITTING_UNKNOWN);
  check("post-markSubmitting fine-grained plan refuses retry (safeToRetry=false)", planRecovery(j.read(jobId)).safeToRetry, false);
  check("post-markSubmitting canAutoRetry=false (aligned planner)", canAutoRetryGeneration(j.read(jobId)), false);
  // golden-rule guard (defense-in-depth): a second submit on the SAME attempt is refused, ordinal stays 1
  checkThrows("second markSubmitting throws duplicate-generation", () => j.markSubmitting(jobId, {}), "E_DUPLICATE_GENERATION_ATTEMPT");
  check("ordinal stays 1 after refused second submit", j.read(jobId).generationOrdinal, 1);

  // ---- scenario 7/8 injection boundary: markSubmitted then markLocalResult ----
  j.markSubmitted(jobId, { providerSubmissionId: generateId("submission"), submissionConfidence: SUBMISSION_CONFIDENCE.CONFIRMED });
  rec = j.read(jobId);
  check("markSubmitted → SUBMITTED, submittedToProvider true, ordinal 1", { s: rec.submissionState, sp: rec.submittedToProvider, o: rec.generationOrdinal }, { s: "SUBMITTED", sp: true, o: 1 });
  check("post-markSubmitted classifies SUBMITTED_WAITING", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.SUBMITTED_WAITING);

  j.markLocalResult(jobId, { localResultRef: "media/abc/def_fake.mp4", importedAssetId: generateId("asset"), resultMeta: { sizeBytes: 1032, relativePath: "media/abc/def_fake.mp4" } });
  check("post-markLocalResult classifies IMPORTED (submitted + asset)", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.IMPORTED);
  check("IMPORTED plan never regenerates", planRecovery(j.read(jobId)).safeToRetry, false);

  // ---- terminal + pending ack (B1 scenario-5 window) → SETTLED ----
  const termMsg = generateId("msg");
  j.markTerminal(jobId, { type: "JOB_COMPLETED", code: null, error: null, messageId: termMsg });
  j.markAckPending(jobId, termMsg);
  check("terminal + ackPending classifies TERMINAL_PENDING_ACK", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.TERMINAL_PENDING_ACK);
  j.markAcknowledged(jobId);
  check("acknowledged classifies SETTLED", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.SETTLED);
  check("SETTLED is not recoverable", isRecoverable(j.read(jobId)), false);
}

// legacy one-step path: markSubmitted WITHOUT markSubmitting still books ordinal=1 (golden rule holds)
{
  const j = freshJournal();
  const jobId = generateId("job");
  j.create({ jobId, action: "GENERATE_VIDEO", generationAttemptId: generateId("attempt"), quotaRisk: true });
  j.markSubmitted(jobId, generateId("submission"));
  check("legacy one-step markSubmitted books ordinal=1", j.read(jobId).generationOrdinal, 1);
  check("legacy one-step is not auto-retryable", canAutoRetryGeneration(j.read(jobId)), false);
}

// ===================== PART D — C6 recovery-report builder (fields + safety allowlist) =====================
{
  const ws = generateId("ws"), wrk = generateId("wrk");
  const base = (over) => ({ jobId: generateId("job"), generationAttemptId: generateId("attempt"), requestIdempotencyKey: generateId("req"), workspaceId: ws, updatedAt: "2026-07-13T00:00:00.000Z", ...over });
  // SUBMITTING_UNKNOWN record → carries the fine-grained evidence + action, marks possiblySubmitted.
  const su = base({ localState: "SUBMITTING", submissionState: "SUBMITTING", submissionConfidence: "UNKNOWN", generationOrdinal: 1, submittedToProvider: false });
  const eSU = buildRecoveryReport(su.jobId, { workspaceId: ws, workerId: wrk, record: su });
  check("report type JOB_RECOVERY_REPORT", eSU.type, "JOB_RECOVERY_REPORT");
  check("report carries recoveryContractState/action", { s: eSU.payload.recoveryContractState, a: eSU.payload.recoveryAction }, { s: "SUBMITTING_UNKNOWN", a: "INSPECT_PROVIDER" });
  check("report carries submissionState/ordinal/confidence", { s: eSU.payload.submissionState, o: eSU.payload.generationOrdinal, c: eSU.payload.submissionConfidence }, { s: "SUBMITTING", o: 1, c: "UNKNOWN" });
  check("report possiblySubmitted true for SUBMITTING", eSU.payload.possiblySubmitted, true);
  check("report createdSecondGeneration is always false", eSU.payload.createdSecondGeneration, false);
  check("report carries journalUpdatedAt ordering evidence", eSU.payload.journalUpdatedAt, "2026-07-13T00:00:00.000Z");
  // PRE_SUBMIT record → RETRY_SAFE, not possiblySubmitted.
  const ps = base({ localState: "RUNNING", submissionState: "NOT_SUBMITTED", submissionConfidence: "NONE", generationOrdinal: 0, submittedToProvider: false });
  const ePS = buildRecoveryReport(ps.jobId, { workspaceId: ws, workerId: wrk, record: ps });
  check("PRE_SUBMIT report action RETRY_SAFE + not possiblySubmitted", { a: ePS.payload.recoveryAction, p: ePS.payload.possiblySubmitted, cs: ePS.payload.recoveryContractState }, { a: "RETRY_SAFE", p: false, cs: "PRE_SUBMIT" });
  // Safety allowlist: an ABSOLUTE localResultRef is dropped to null (relative refs only).
  const abs = base({ submissionState: "SUBMITTED", submittedToProvider: true, generationOrdinal: 1, localResultRef: "C:\\Users\\x\\secret.mp4", importedAssetId: generateId("asset") });
  const eAbs = buildRecoveryReport(abs.jobId, { workspaceId: ws, workerId: wrk, record: abs });
  check("absolute localResultRef dropped to null (relative refs only)", eAbs.payload.localResultRef, null);
  check("no absolute path anywhere in the report payload", /[A-Za-z]:\\/.test(JSON.stringify(eAbs.payload)), false);
  // Strict allowlist: a credential-like field on the record is EXCLUDED from the report (not copied),
  // so it can neither leak nor alter a recovery decision.
  const unsafe = base({ localState: "RUNNING", token: "sk-secret-123", cookie: "x" });
  const eUnsafe = buildRecoveryReport(unsafe.jobId, { workspaceId: ws, workerId: wrk, record: unsafe });
  check("credential-like fields are excluded from the report (strict allowlist)", /sk-secret|cookie/.test(JSON.stringify(eUnsafe.payload)), false);
  check("report payload has no token/cookie keys", ("token" in eUnsafe.payload) || ("cookie" in eUnsafe.payload), false);
}

for (const r of ROOTS) { try { rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
