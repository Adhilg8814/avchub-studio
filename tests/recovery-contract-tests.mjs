// AVC Studio P0 Step 5.7a — recovery-contract regression tests.
//
// SAFE BY CONSTRUCTION: every test uses a throwaway temp directory under the OS temp
// dir. This suite does NOT start ui-server / a browser / Python / any provider, does
// NOT open a network socket, does NOT read credentials, does NOT touch production media,
// and does NOT consume provider quota. Every "submission" here is a journal write; no
// real generation ever runs.
//
// Covers the objective-12 scenarios: submit crash, submit timeout, provider-returns-
// later, duplicate replay, duplicate recover, manual resume, resume after reconnect,
// resume after restart, journal corruption, drain, illegal transition, attempt identity,
// provider capability.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateId } from "../lib/protocol/ids.mjs";
import { WORKER_ERRORS } from "../lib/worker/journal-safety.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import {
  LOCAL_STATES, canRecoveryTransition, assertRecoveryTransition, isTerminalLocalState,
  isPreSubmitLocalState, isPostSubmitLocalState, legalNextStates,
  SUBMISSION_STATE, SUBMISSION_CONFIDENCE, IDEMPOTENCY_SUPPORT,
  isSubmissionConfidence, isIdempotencySupport
} from "../lib/worker/recovery-states.mjs";
import {
  classifyRecoveryContract, planRecovery, assertNoAutoRegenerate,
  RECOVERY_CONTRACT_STATES, RECOVERY_ACTIONS
} from "../lib/worker/recovery-classifier.mjs";
import {
  resolveRecoveryCapabilities, RECOVERY_CAPABILITY_KEYS, GROK_RECOVERY_CAPABILITIES
} from "../lib/worker/recovery-capabilities.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function checkThrows(name, fn, code) {
  try { fn(); failures += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) {
    if (code && e.code !== code) { failures += 1; console.error(`FAIL ${name} (code ${e.code} != ${code})`); }
    else passed += 1;
  }
}

const tmpDirs = [];
const mkTmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "avc-rcx-")); tmpDirs.push(d); return d; };
// Deterministic monotonically-increasing ISO clock (so submittedAt < terminalAt etc.).
function seqClock(startMs = Date.UTC(2026, 0, 1)) { let t = startMs; return () => new Date(t += 1000).toISOString(); }
const attemptId = () => generateId("attempt");

try {
  // ============ 1. state machine: table + guards (pure) ============
  {
    check("CREATED→RUNNING legal", canRecoveryTransition("CREATED", "RUNNING"), true);
    check("RUNNING→SUBMITTING legal", canRecoveryTransition("RUNNING", "SUBMITTING"), true);
    check("SUBMITTING→SUBMITTED legal", canRecoveryTransition("SUBMITTING", "SUBMITTED"), true);
    check("SUBMITTED→DOWNLOADING legal", canRecoveryTransition("SUBMITTED", "DOWNLOADING"), true);
    check("DOWNLOADING→IMPORTED legal", canRecoveryTransition("DOWNLOADING", "IMPORTED"), true);
    check("IMPORTED→SUCCEEDED legal", canRecoveryTransition("IMPORTED", "SUCCEEDED"), true);
    // The dangerous ones the contract forbids:
    check("SUBMITTED→SUBMITTING ILLEGAL (re-submit)", canRecoveryTransition("SUBMITTED", "SUBMITTING"), false);
    check("SUBMITTING→SUBMITTING ILLEGAL (re-submit)", canRecoveryTransition("SUBMITTING", "SUBMITTING"), false);
    check("SUBMITTED→RUNNING ILLEGAL (regress)", canRecoveryTransition("SUBMITTED", "RUNNING"), false);
    check("IMPORTED→SUBMITTING ILLEGAL", canRecoveryTransition("IMPORTED", "SUBMITTING"), false);
    check("SUCCEEDED→FAILED ILLEGAL (terminal absorbing)", canRecoveryTransition("SUCCEEDED", "FAILED"), false);
    check("SUCCEEDED→SUCCEEDED ILLEGAL (terminal self)", canRecoveryTransition("SUCCEEDED", "SUCCEEDED"), false);
    check("unknown state ILLEGAL", canRecoveryTransition("RUNNING", "TELEPORT"), false);
    check("RUNNING→RUNNING idempotent legal", canRecoveryTransition("RUNNING", "RUNNING"), true);
    checkThrows("assertRecoveryTransition throws on illegal", () => assertRecoveryTransition("SUBMITTED", "SUBMITTING"), WORKER_ERRORS.E_ILLEGAL_RECOVERY_TRANSITION);
    check("isTerminalLocalState", isTerminalLocalState("CANCELED") && !isTerminalLocalState("RUNNING"), true);
    check("isPreSubmitLocalState", isPreSubmitLocalState("RUNNING") && !isPreSubmitLocalState("SUBMITTED"), true);
    check("isPostSubmitLocalState", isPostSubmitLocalState("SUBMITTING") && isPostSubmitLocalState("IMPORTED") && !isPostSubmitLocalState("RUNNING"), true);
    check("legalNextStates(SUBMITTING) excludes SUBMITTING", !legalNextStates("SUBMITTING").includes("SUBMITTING"), true);
    // enum validators
    check("isSubmissionConfidence", isSubmissionConfidence(SUBMISSION_CONFIDENCE.UNKNOWN) && !isSubmissionConfidence("MAYBE"), true);
    check("isIdempotencySupport", isIdempotencySupport(IDEMPOTENCY_SUPPORT.NATIVE) && !isIdempotencySupport("SORTA"), true);
  }

  // ============ 2. attempt identity + golden-rule bookkeeping ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job"); const att = attemptId();
    const rec0 = j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: att, attemptIndex: 0 });
    check("create attemptIndex default 0", rec0.attemptIndex, 0);
    check("create generationOrdinal 0", rec0.generationOrdinal, 0);
    check("create submissionState NOT_SUBMITTED", rec0.submissionState, SUBMISSION_STATE.NOT_SUBMITTED);
    check("create submissionConfidence NONE", rec0.submissionConfidence, SUBMISSION_CONFIDENCE.NONE);
    j.markRunning(jobId);
    const recS = j.markSubmitting(jobId, { providerIdempotencyKey: "idem-abc-123", idempotencySupport: IDEMPOTENCY_SUPPORT.NATIVE });
    check("markSubmitting localState SUBMITTING", recS.localState, "SUBMITTING");
    check("markSubmitting ordinal→1", recS.generationOrdinal, 1);
    check("markSubmitting confidence UNKNOWN", recS.submissionConfidence, SUBMISSION_CONFIDENCE.UNKNOWN);
    check("markSubmitting persisted idem key", recS.providerIdempotencyKey, "idem-abc-123");
    check("markSubmitting persisted idem support", recS.idempotencySupport, IDEMPOTENCY_SUPPORT.NATIVE);
    check("submittingAt set", typeof recS.submittingAt === "string", true);
    // second markSubmitting on the SAME job = duplicate generation → rejected
    checkThrows("2nd markSubmitting same job rejected", () => j.markSubmitting(jobId), WORKER_ERRORS.E_DUPLICATE_GENERATION_ATTEMPT);
    // confirm submission
    const sub = generateId("submission");
    const recD = j.markSubmitted(jobId, { providerSubmissionId: sub, submissionEvidence: { kind: "provider-ack", note: "queued" } });
    check("markSubmitted CONFIRMED", recD.submissionConfidence, SUBMISSION_CONFIDENCE.CONFIRMED);
    check("markSubmitted submittedToProvider", recD.submittedToProvider, true);
    check("markSubmitted submissionState SUBMITTED", recD.submissionState, SUBMISSION_STATE.SUBMITTED);
    check("markSubmitted providerSubmissionId", recD.providerSubmissionId, sub);
    check("markSubmitted evidence kept", recD.submissionEvidence && recD.submissionEvidence.kind, "provider-ack");
    check("markSubmitted ordinal stays 1", recD.generationOrdinal, 1);
    check("hasSubmittedAttempt true", j.hasSubmittedAttempt(att), true);
    check("hasSubmittedAttempt excludeJobId=self → false", j.hasSubmittedAttempt(att, { excludeJobId: jobId }), false);
    check("listByAttempt length 1", j.listByAttempt(att).length, 1);
  }

  // ============ 3. golden rule across SIBLING jobs of one attempt ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const att = attemptId();
    const a = generateId("job"), b = generateId("job");
    j.create({ jobId: a, action: "GENERATE_GROK_VIDEO", generationAttemptId: att });
    j.create({ jobId: b, action: "GENERATE_GROK_VIDEO", generationAttemptId: att });
    j.markRunning(a); j.markSubmitting(a); j.markSubmitted(a, generateId("submission"));
    // b shares the attempt and a already spent the generation → both submit paths refuse
    j.markRunning(b);
    checkThrows("sibling markSubmitting refused", () => j.markSubmitting(b), WORKER_ERRORS.E_DUPLICATE_GENERATION_ATTEMPT);
    checkThrows("sibling markSubmitted refused", () => j.markSubmitted(b, generateId("submission")), WORKER_ERRORS.E_DUPLICATE_GENERATION_ATTEMPT);
    check("attempt still has exactly one submission", j.listByAttempt(att).filter((r) => r.submittedToProvider).length, 1);
  }

  // ============ 4. submit CRASH window (SUBMITTING, no confirmation) ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(jobId);
    j.markSubmitting(jobId); // ...crash here, before markSubmitted
    // A fresh journal instance (restart) reads the same on-disk record.
    const j2 = new RecoveryJournal({ root: j._root, now: seqClock() });
    const rec = j2.read(jobId);
    check("crash-in-submit localState SUBMITTING", rec.localState, "SUBMITTING");
    const state = classifyRecoveryContract(rec);
    check("classify SUBMITTING_UNKNOWN", state, RECOVERY_CONTRACT_STATES.SUBMITTING_UNKNOWN);
    const plan = planRecovery(rec);
    check("plan INSPECT_PROVIDER", plan.action, RECOVERY_ACTIONS.INSPECT_PROVIDER);
    check("plan not safeToRetry", plan.safeToRetry, false);
    check("plan inspectProvider", plan.inspectProvider, true);
    checkThrows("assertNoAutoRegenerate refuses SUBMITTING_UNKNOWN", () => assertNoAutoRegenerate(rec), "E_DUPLICATE_GENERATION_ATTEMPT");
  }

  // ============ 5. submit TIMEOUT then provider returns LATER ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(jobId); j.markSubmitting(jobId);
    // timeout → we later CONFIRM the submission landed (provider returned), no re-submit
    j.markSubmitted(jobId, { submissionConfidence: SUBMISSION_CONFIDENCE.CONFIRMED });
    let rec = j.read(jobId);
    check("timeout→confirmed WAITING", classifyRecoveryContract(rec), RECOVERY_CONTRACT_STATES.SUBMITTED_WAITING);
    // provider result becomes available later
    j.markProgress(jobId, { sequence: 1, resultAvailable: true });
    rec = j.read(jobId);
    check("result available RESULT_AVAILABLE", classifyRecoveryContract(rec), RECOVERY_CONTRACT_STATES.RESULT_AVAILABLE);
    check("plan RESUME_DOWNLOAD", planRecovery(rec).action, RECOVERY_ACTIONS.RESUME_DOWNLOAD);
  }

  // ============ 6. download → import → terminal → ack progression ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(jobId); j.markSubmitting(jobId); j.markSubmitted(jobId, generateId("submission"));
    j.markDownloading(jobId);
    check("markDownloading → DOWNLOADING", j.read(jobId).localState, "DOWNLOADING");
    j.markLocalResult(jobId, { localResultRef: "projects/p/out.mp4", resultMeta: { checksum: "sha256:z", sizeBytes: 10, relativePath: "projects/p/out.mp4" } });
    check("downloaded DOWNLOADED", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.DOWNLOADED);
    check("plan RESUME_IMPORT", planRecovery(j.read(jobId)).action, RECOVERY_ACTIONS.RESUME_IMPORT);
    const asset = generateId("asset");
    j.markLocalResult(jobId, { localResultRef: "projects/p/out.mp4", importedAssetId: asset });
    check("imported IMPORTED", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.IMPORTED);
    j.markTerminal(jobId, { type: "JOB_COMPLETED" });
    j.markAckPending(jobId, generateId("msg"));
    check("terminal-pending TERMINAL_PENDING_ACK", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.TERMINAL_PENDING_ACK);
    check("plan REDELIVER_TERMINAL", planRecovery(j.read(jobId)).action, RECOVERY_ACTIONS.REDELIVER_TERMINAL);
    j.markAcknowledged(jobId);
    check("acked SETTLED", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.SETTLED);
    check("plan NONE", planRecovery(j.read(jobId)).action, RECOVERY_ACTIONS.NONE);
  }

  // ============ 7. PRE_SUBMIT is the only safe-to-retry state ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    const rec = j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    check("fresh record PRE_SUBMIT", classifyRecoveryContract(rec), RECOVERY_CONTRACT_STATES.PRE_SUBMIT);
    check("plan RETRY_SAFE", planRecovery(rec).action, RECOVERY_ACTIONS.RETRY_SAFE);
    check("assertNoAutoRegenerate passes PRE_SUBMIT", assertNoAutoRegenerate(rec), true);
    j.markRunning(jobId);
    check("running still PRE_SUBMIT", classifyRecoveryContract(j.read(jobId)), RECOVERY_CONTRACT_STATES.PRE_SUBMIT);
  }

  // ============ 8. duplicate replay + duplicate recover (idempotent) ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job"); const att = attemptId();
    // Duplicate create must NOT reset progress.
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: att });
    j.markRunning(jobId); j.markSubmitting(jobId); j.markSubmitted(jobId, generateId("submission"));
    const again = j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: att });
    check("duplicate create returns existing (still SUBMITTED)", again.localState, "SUBMITTED");
    check("duplicate create keeps ordinal 1", again.generationOrdinal, 1);
    // Idempotent re-commit of an already-submitted record is allowed, ordinal unchanged.
    const re = j.markSubmitted(jobId, generateId("submission"));
    check("re-commit keeps ordinal 1", re.generationOrdinal, 1);
    check("re-commit still SUBMITTED", re.localState, "SUBMITTED");
  }

  // ============ 9. manual resume (park then resume forward) ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(jobId); j.markSubmitting(jobId); j.markSubmitted(jobId, generateId("submission"));
    // Provider needs manual verification while WAITING.
    j.markProgress(jobId, { phase: "NEEDS_MANUAL_ACTION", sequence: 1 });
    let rec = j.read(jobId);
    check("parked MANUAL_ACTION_REQUIRED", classifyRecoveryContract(rec), RECOVERY_CONTRACT_STATES.MANUAL_ACTION_REQUIRED);
    check("parked plan ESCALATE_OPERATOR", planRecovery(rec).action, RECOVERY_ACTIONS.ESCALATE_OPERATOR);
    check("parked never safeToRetry", planRecovery(rec).safeToRetry, false);
    // Operator resolves → resume forward to download (NEEDS_MANUAL_ACTION → DOWNLOADING).
    j.markDownloading(jobId);
    check("resumed forward to DOWNLOADING", j.read(jobId).localState, "DOWNLOADING");
    check("resume did NOT re-book generation", j.read(jobId).generationOrdinal, 1);
  }

  // ============ 10. resume after RESTART (journal is source of truth) ============
  {
    const root = mkTmp();
    const j = new RecoveryJournal({ root, now: seqClock() });
    const jobId = generateId("job"); const att = attemptId();
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: att });
    j.markRunning(jobId); j.markSubmitting(jobId); j.markSubmitted(jobId, generateId("submission"));
    j.markLocalResult(jobId, { localResultRef: "projects/p/out.mp4" });
    // Simulate restart: brand-new instance over the same root, no in-memory state.
    const j2 = new RecoveryJournal({ root, now: seqClock() });
    const rec = j2.read(jobId);
    check("restart sees submittedToProvider", rec.submittedToProvider, true);
    check("restart sees DOWNLOADED", classifyRecoveryContract(rec), RECOVERY_CONTRACT_STATES.DOWNLOADED);
    check("restart golden rule intact", j2.hasSubmittedAttempt(att), true);
    checkThrows("restart refuses regenerate", () => assertNoAutoRegenerate(rec), "E_DUPLICATE_GENERATION_ATTEMPT");
    // listRecoverable surfaces it as unfinished work.
    check("restart listRecoverable includes it", j2.listRecoverable().some((r) => r.jobId === jobId), true);
  }

  // ============ 11. journal CORRUPTION → operator, never auto ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    mkdirSync(path.dirname(j.getPath(jobId)), { recursive: true });
    writeFileSync(j.getPath(jobId), "{ not json ", "utf8");
    const rec = j.read(jobId);
    check("corrupt marker", rec.corrupt, true);
    check("corrupt classify CORRUPT", classifyRecoveryContract(rec), RECOVERY_CONTRACT_STATES.CORRUPT);
    check("corrupt plan ESCALATE_OPERATOR", planRecovery(rec).action, RECOVERY_ACTIONS.ESCALATE_OPERATOR);
    check("corrupt never safeToRetry", planRecovery(rec).safeToRetry, false);
  }

  // ============ 12. illegal transitions rejected by the journal ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(jobId); j.markSubmitting(jobId); j.markSubmitted(jobId, generateId("submission"));
    j.markTerminal(jobId, { type: "JOB_COMPLETED" });
    // terminal → different terminal is illegal
    checkThrows("terminal→FAILED illegal", () => j.markTerminal(jobId, { type: "JOB_FAILED" }), WORKER_ERRORS.E_ILLEGAL_RECOVERY_TRANSITION);
    // idempotent same-terminal is a no-op (does not throw)
    const same = j.markTerminal(jobId, { type: "JOB_COMPLETED" });
    check("terminal→same terminal idempotent", same.localState, "SUCCEEDED");
    // markRunning after terminal is illegal
    checkThrows("terminal→RUNNING illegal", () => j.markRunning(jobId), WORKER_ERRORS.E_ILLEGAL_RECOVERY_TRANSITION);
  }

  // ============ 13. provider capability model ============
  {
    const def = resolveRecoveryCapabilities();
    check("defaults everything false", RECOVERY_CAPABILITY_KEYS.every((k) => def[k] === false), true);
    check("default idempotency NONE", def.idempotencySupport, IDEMPOTENCY_SUPPORT.NONE);
    const native = resolveRecoveryCapabilities({ idempotencySupport: IDEMPOTENCY_SUPPORT.NATIVE });
    check("NATIVE implies key", native.supportsIdempotencyKey, true);
    check("NATIVE implies submission lookup", native.supportsSubmissionLookup, true);
    const malformed = resolveRecoveryCapabilities({ supportsResume: "yes", supportsDownloadResume: 1, idempotencySupport: "BOGUS" });
    check("malformed truthy coerced to false", malformed.supportsResume === false && malformed.supportsDownloadResume === false, true);
    check("malformed idempotency falls back NONE", malformed.idempotencySupport, IDEMPOTENCY_SUPPORT.NONE);
    check("Grok preset: no lookup", GROK_RECOVERY_CAPABILITIES.supportsSubmissionLookup, false);
    check("Grok preset: no idempotency", GROK_RECOVERY_CAPABILITIES.idempotencySupport, IDEMPOTENCY_SUPPORT.NONE);
    // A SUBMITTING_UNKNOWN record + a provider that can't look up → operator, not inspect.
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(jobId); j.markSubmitting(jobId);
    const rec = j.read(jobId);
    const grokPlan = planRecovery(rec, GROK_RECOVERY_CAPABILITIES);
    check("no-lookup provider degrades to ESCALATE_OPERATOR", grokPlan.action, RECOVERY_ACTIONS.ESCALATE_OPERATOR);
    check("degradedNoLookup flagged", grokPlan.degradedNoLookup, true);
    const nativePlan = planRecovery(rec, native);
    check("lookup-capable provider keeps INSPECT_PROVIDER", nativePlan.action, RECOVERY_ACTIONS.INSPECT_PROVIDER);
  }

  // ============ 14. submission-evidence sanitization (never leaks/never throws) ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const jobId = generateId("job");
    j.create({ jobId, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(jobId); j.markSubmitting(jobId);
    // Unsafe evidence (URL + secret-ish key) must NOT throw and must NOT be stored raw.
    const rec = j.markSubmitted(jobId, {
      providerSubmissionId: generateId("submission"),
      submissionEvidence: { kind: "ack", note: "ok", url: "https://secret/x", token: "abc", detail: "https://leak" },
      providerIdempotencyKey: "https://not-a-key"
    });
    check("evidence kept safe scalars", rec.submissionEvidence.kind === "ack" && rec.submissionEvidence.note === "ok", true);
    check("evidence dropped url key", rec.submissionEvidence.url === undefined, true);
    check("evidence dropped token key", rec.submissionEvidence.token === undefined, true);
    check("evidence dropped url-shaped detail", rec.submissionEvidence.detail === undefined, true);
    check("url-shaped idem key dropped", rec.providerIdempotencyKey == null, true);
    check("no plaintext url anywhere in record", JSON.stringify(rec).includes("secret/x"), false);
  }

  // ============ 15. sweep retains until SETTLED, never mid-flight ============
  {
    const j = new RecoveryJournal({ root: mkTmp(), now: seqClock() });
    const active = generateId("job"), settled = generateId("job");
    j.create({ jobId: active, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(active); j.markSubmitting(active); j.markSubmitted(active, generateId("submission"));
    j.create({ jobId: settled, action: "GENERATE_GROK_VIDEO", generationAttemptId: attemptId() });
    j.markRunning(settled); j.markSubmitting(settled); j.markSubmitted(settled, generateId("submission"));
    j.markTerminal(settled, { type: "JOB_COMPLETED" }); j.markAcknowledged(settled);
    const removed = j.sweep({ terminalAckRetentionMs: 0, nowMs: Date.UTC(2027, 0, 1) });
    check("sweep removed the settled record", removed.includes(settled), true);
    check("sweep NEVER removed the submitted-in-flight record", removed.includes(active), false);
    check("in-flight record still there with evidence", j.read(active).submittedToProvider, true);
  }

  check("no unhandled rejection", un, false);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
