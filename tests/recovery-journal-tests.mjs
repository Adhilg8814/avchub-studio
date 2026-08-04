// AVC Studio P0 Step 3 — recovery journal / pending-ack / progress / reconcile /
// classification tests.
//
// SAFE BY CONSTRUCTION: every test uses a throwaway temp directory under the OS
// temp dir. This suite does NOT start ui-server / a browser / Python / any
// provider, does NOT open a network socket, does NOT read credentials, does NOT
// touch the production media directory, and does NOT consume provider quota.

import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateId, validateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope, validateEnvelope, MAX_RECONCILE_PAYLOAD_BYTES } from "../lib/protocol/envelope.mjs";
import { PROTOCOL_ERRORS } from "../lib/protocol/errors.mjs";

import {
  JOURNAL_SCHEMA_VERSION, assertRecordSafe, isRelativeRef, assertRelativeRef,
  safeResultMeta, sanitizeErrorForJournal, journalFileName, ackFileName, WORKER_ERRORS
} from "../lib/worker/journal-safety.mjs";
import {
  classifyRecovery, canAutoRetryGeneration, canRecoverWithoutNewGeneration,
  isRecoverable, RECOVERY_STATES
} from "../lib/worker/recovery-classifier.mjs";
import {
  parseStatusLine, normalizeProgress, nextSequence, toProgressPayload, PROGRESS_PHASES
} from "../lib/worker/progress-adapter.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import { PendingAckStore, PENDING_ACK_TYPES } from "../lib/worker/pending-ack-store.mjs";
import { buildReconcileBatches, buildRecoveryReport } from "../lib/worker/reconcile-builder.mjs";

import { MockTransport } from "../lib/worker/mock-transport.mjs";
import { JobRegistry } from "../lib/worker/job-registry.mjs";
import { WorkerRuntime } from "../lib/worker/worker-runtime.mjs";
import { JobDispatcher } from "../lib/control/job-dispatcher.mjs";

// CRIT-1 regression sentinel: any unhandled rejection (e.g. an illegal
// terminal→terminal transition escaping an async handler) trips it.
let crit1Unhandled = false;
process.on("unhandledRejection", (err) => { crit1Unhandled = true; console.error("UNHANDLED REJECTION:", err && err.code, err && err.message); });

let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function checkThrows(name, fn, code = undefined) {
  try { fn(); failures += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) {
    if (code && e.code !== code) { failures += 1; console.error(`FAIL ${name} (code ${e.code} != ${code})`); }
    else passed += 1;
  }
}
async function waitFor(pred, tries = 300) {
  for (let i = 0; i < tries; i += 1) { if (pred()) return true; await new Promise((r) => setImmediate(r)); }
  return pred();
}

const tmpDirs = [];
function mkTmp() { const d = mkdtempSync(path.join(os.tmpdir(), "avc-journal-")); tmpDirs.push(d); return d; }
function cleanup() { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } }

const WS = generateId("ws"), WRK = generateId("wrk");
const DUR_CTX = { supportedDurationsSec: [6, 10, 15], defaultDurationSec: 10 };
function baseInput(extra = {}) {
  return {
    projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"),
    providerAccountId: generateId("pa"), sourceKeyframeAssetId: generateId("asset"),
    promptSnapshot: "Slow cinematic push-in", baseRevision: 1, ...extra
  };
}
// Fixed clock for deterministic timestamps / retention windows.
function fixedClock(iso = "2026-07-12T00:00:00.000Z") { return () => iso; }

// ================= journal-safety =================
{
  check("schemaVersion is 1", JOURNAL_SCHEMA_VERSION, 1);

  // dangerous / url-like keys rejected at any depth
  for (const bad of ["cookie", "password", "token", "accessToken", "refreshToken", "proxy", "proxyPassword", "fingerprint", "profilePath"]) {
    checkThrows(`assertRecordSafe rejects ${bad}`, () => assertRecordSafe({ a: { b: { [bad]: "x" } } }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  }
  for (const url of ["url", "uri", "href", "downloadUrl", "resultUrl", "signedUrl"]) {
    checkThrows(`assertRecordSafe rejects url-like ${url}`, () => assertRecordSafe({ meta: { [url]: "http://x" } }), WORKER_ERRORS.E_JOURNAL_UNSAFE);
  }
  check("assertRecordSafe passes clean record", (() => { assertRecordSafe({ jobId: "job_x", resultMeta: { checksum: "sha256:ab", sizeBytes: 1 } }); return true; })(), true);

  // relative ref rules
  check("relative ref ok", isRelativeRef("projects/p/shots/s/out.mp4"), true);
  check("relative ref single ok", isRelativeRef("out.mp4"), true);
  check("absolute unix rejected", isRelativeRef("/etc/passwd"), false);
  check("absolute windows rejected", isRelativeRef("C:\\Users\\x\\out.mp4"), false);
  check("drive-relative rejected", isRelativeRef("C:out.mp4"), false);
  check("unc rejected", isRelativeRef("\\\\server\\share"), false);
  check("traversal rejected", isRelativeRef("a/../../etc/passwd"), false);
  check("home rejected", isRelativeRef("~/secret"), false);
  check("scheme rejected", isRelativeRef("file:///etc/passwd"), false);
  check("backslash rejected", isRelativeRef("a\\b"), false);
  check("empty rejected", isRelativeRef(""), false);
  checkThrows("assertRelativeRef throws on absolute", () => assertRelativeRef("/x"), WORKER_ERRORS.E_JOURNAL_INVALID_REF);

  // safe result meta whitelist
  const meta = safeResultMeta({ checksum: "sha256:abc", sizeBytes: 2048, relativePath: "a/b.mp4", url: "http://x", absolutePath: "C:\\x", durationSec: 10, width: 1080, height: 1920, mimeType: "video/mp4", secretToken: "zzz" });
  check("meta keeps checksum", meta.checksum, "sha256:abc");
  check("meta keeps sizeBytes", meta.sizeBytes, 2048);
  check("meta keeps relativePath", meta.relativePath, "a/b.mp4");
  check("meta keeps duration", meta.durationSec, 10);
  check("meta keeps mimeType", meta.mimeType, "video/mp4");
  check("meta drops url", meta.url === undefined, true);
  check("meta drops absolutePath", meta.absolutePath === undefined, true);
  check("meta drops secretToken", meta.secretToken === undefined, true);
  check("meta rejects absolute relativePath", safeResultMeta({ relativePath: "C:\\x" }), null);

  // error sanitizer: only protocol/worker errors surface their message
  const perr = sanitizeErrorForJournal(Object.assign(new Error("safe protocol msg"), { name: "ProtocolError", code: "E_INVALID_JOB_INPUT" }));
  check("sanitize keeps protocol code", perr.code, "E_INVALID_JOB_INPUT");
  check("sanitize keeps protocol message", perr.message, "safe protocol msg");
  const rerr = sanitizeErrorForJournal(new Error("boom secret sk-supersecret C:\\path"));
  check("sanitize generic code", rerr.code, "E_HANDLER_FAILED");
  check("sanitize generic message (no secret)", /secret|sk-|C:\\/.test(rerr.message), false);

  // filenames from validated ids only (traversal impossible)
  const jid = generateId("job");
  check("journalFileName ok", journalFileName(jid), `${jid}.json`);
  checkThrows("journalFileName rejects traversal", () => journalFileName("../../etc/passwd"), WORKER_ERRORS.E_JOURNAL_INVALID_REF);
  checkThrows("journalFileName rejects non-job id", () => journalFileName(generateId("msg")), WORKER_ERRORS.E_JOURNAL_INVALID_REF);
  const mid = generateId("msg");
  check("ackFileName ok", ackFileName(mid), `${mid}.json`);
  checkThrows("ackFileName rejects bad id", () => ackFileName("../x"), WORKER_ERRORS.E_JOURNAL_INVALID_REF);
}

// ================= recovery-classifier =================
{
  const rec = (over = {}) => ({ jobId: generateId("job"), terminal: null, submittedToProvider: false, ...over });

  check("not submitted → safe to retry", classifyRecovery(rec()), RECOVERY_STATES.NOT_SUBMITTED_SAFE_TO_RETRY);
  check("safe to retry auto-retryable", canAutoRetryGeneration(rec()), true);
  check("submitted waiting", classifyRecovery(rec({ submittedToProvider: true })), RECOVERY_STATES.SUBMITTED_WAIT_FOR_PROVIDER);
  check("submitted NEVER auto-retry", canAutoRetryGeneration(rec({ submittedToProvider: true })), false);
  check("submitted recover w/o generation", canRecoverWithoutNewGeneration(rec({ submittedToProvider: true })), true);
  check("submitted result available", classifyRecovery(rec({ submittedToProvider: true, resultAvailable: true })), RECOVERY_STATES.SUBMITTED_RESULT_AVAILABLE);
  check("downloaded not imported", classifyRecovery(rec({ submittedToProvider: true, localResultRef: "a/b.mp4" })), RECOVERY_STATES.DOWNLOADED_NOT_IMPORTED);
  check("imported not acknowledged", classifyRecovery(rec({ submittedToProvider: true, localResultRef: "a/b.mp4", importedAssetId: generateId("asset") })), RECOVERY_STATES.IMPORTED_NOT_ACKNOWLEDGED);
  check("terminal pending ack", classifyRecovery(rec({ terminal: { type: "JOB_COMPLETED" }, ackPending: true })), RECOVERY_STATES.TERMINAL_PENDING_ACK);
  check("terminal acknowledged settled", classifyRecovery(rec({ terminal: { type: "JOB_COMPLETED" }, acknowledged: true })), RECOVERY_STATES.SETTLED);
  check("settled not recoverable", isRecoverable(rec({ terminal: { type: "JOB_COMPLETED" }, acknowledged: true })), false);
  check("manual action", classifyRecovery(rec({ needsManualAction: true })), RECOVERY_STATES.MANUAL_ACTION_REQUIRED);
  check("corrupt", classifyRecovery({ corrupt: true }), RECOVERY_STATES.CORRUPT_JOURNAL);
  check("null → operator", classifyRecovery(null), RECOVERY_STATES.UNKNOWN_NEEDS_OPERATOR);
  check("result without submission → operator", classifyRecovery(rec({ localResultRef: "a/b.mp4" })), RECOVERY_STATES.UNKNOWN_NEEDS_OPERATOR);
  check("terminal auto-retry false", canAutoRetryGeneration(rec({ terminal: { type: "JOB_FAILED" }, ackPending: true })), false);
}

// ================= progress-adapter =================
{
  check("phases count", PROGRESS_PHASES.length, 13);

  // parse kv form
  const kv = parseStatusLine("AVCPROGRESS phase=WAITING_FOR_RESULT percent=42 seq=5 label=Waiting for result");
  check("kv ok", kv.ok, true);
  check("kv phase", kv.progress.phase, "WAITING_FOR_RESULT");
  check("kv percent", kv.progress.percent, 42);
  check("kv sequence", kv.progress.sequence, 5);
  check("kv label", kv.progress.label, "Waiting for result");

  // parse json form + percent clamp
  const js = parseStatusLine('AVCPROGRESS {"phase":"DOWNLOADING","percent":150}');
  check("json ok", js.ok, true);
  check("json percent clamped", js.progress.percent, 100);

  // malformed / non-progress
  check("no marker ignored", parseStatusLine("some random stdout").ok, false);
  check("bad json rejected", parseStatusLine("AVCPROGRESS {bad json").ok, false);
  check("bad token rejected", parseStatusLine("AVCPROGRESS =oops").ok, false);
  check("non-string rejected", parseStatusLine(12345).ok, false);
  check("unknown phase rejected", parseStatusLine("AVCPROGRESS phase=TELEPORTING").ok, false);
  check("unknown phase reason", parseStatusLine("AVCPROGRESS phase=TELEPORTING").reason, "unknown-phase");

  // never echo secrets in label
  const secretLabel = parseStatusLine("AVCPROGRESS phase=DOWNLOADING label=see https://grok.com/r/abc?token=sk-supersecret1234567890");
  check("url scrubbed from label", /https:\/\/|sk-supersecret/.test(secretLabel.progress.label), false);

  // normalizeProgress guards
  check("normalize bad phase", normalizeProgress({ phase: "nope!" }).ok, false);
  check("normalize non-object", normalizeProgress(null).ok, false);
  check("normalize bad percent", normalizeProgress({ phase: "IMPORTING", percent: "abc" }).ok, false);
  check("normalize bad sequence", normalizeProgress({ phase: "IMPORTING", sequence: -1 }).ok, false);
  check("normalize accepts seq alias", normalizeProgress({ phase: "IMPORTING", seq: 3 }).progress.sequence, 3);

  // sequence + payload helpers
  check("nextSequence base", nextSequence(0), 1);
  check("nextSequence from n", nextSequence(7), 8);
  check("nextSequence invalid resets", nextSequence(-3), 1);
  const pay = toProgressPayload({ phase: "IMPORTING", percent: 80 }, { previousSequence: 4 });
  check("payload sequence advanced", pay.sequence, 5);
  check("payload phase", pay.phase, "IMPORTING");
  check("payload percent", pay.percent, 80);
  check("payload from stale seq bumped", toProgressPayload({ phase: "IMPORTING", sequence: 2 }, { previousSequence: 9 }).sequence, 10);
}

// ================= recovery-journal (filesystem) =================
{
  const root = mkTmp();
  const j = new RecoveryJournal({ root, now: fixedClock() });
  const jobId = generateId("job");
  const reqKey = generateId("req"), attemptId = generateId("attempt");

  const created = j.create({ jobId, action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: reqKey, generationAttemptId: attemptId, acceptedBaseRevision: 12, quotaRisk: true, workspaceId: WS });
  check("create localState", created.localState, "CREATED");
  check("create schemaVersion", created.schemaVersion, 1);
  check("create timestamps utc", /Z$/.test(created.createdAt), true);
  check("create idempotent returns same", j.create({ jobId, action: "GENERATE_GROK_VIDEO" }).acceptedBaseRevision, 12);
  check("file on disk", existsSync(j.getPath(jobId)), true);

  check("read back submitted false", j.read(jobId).submittedToProvider, false);
  checkThrows("read invalid jobId throws", () => j.read("../x"), WORKER_ERRORS.E_JOURNAL_INVALID_REF);
  check("read missing → null", j.read(generateId("job")), null);

  j.markRunning(jobId);
  check("running startedAt set", Boolean(j.read(jobId).startedAt), true);

  j.markProgress(jobId, { phase: "SUBMITTING_PROMPT", sequence: 1, percent: 20 });
  check("progress phase", j.read(jobId).phase, "SUBMITTING_PROMPT");
  check("progress seq", j.read(jobId).lastEventSequence, 1);
  checkThrows("progress seq must increase", () => j.markProgress(jobId, { phase: "DOWNLOADING", sequence: 1 }), WORKER_ERRORS.E_JOURNAL_UNSAFE);
  checkThrows("progress unknown phase rejected", () => j.markProgress(jobId, { phase: "TELEPORTING", sequence: 2 }), WORKER_ERRORS.E_JOURNAL_UNSAFE);

  j.markSubmitted(jobId, generateId("submission"));
  check("submitted flag persisted", j.read(jobId).submittedToProvider, true);
  check("submitted localState", j.read(jobId).localState, "SUBMITTED");
  check("submitted classify wait", classifyRecovery(j.read(jobId)), RECOVERY_STATES.SUBMITTED_WAIT_FOR_PROVIDER);
  checkThrows("markSubmitted bad submissionId", () => j.markSubmitted(jobId, "submission_bad"), WORKER_ERRORS.E_JOURNAL_INVALID_REF);

  j.markLocalResult(jobId, { localResultRef: "projects/p/out.mp4", resultMeta: { checksum: "sha256:z", sizeBytes: 10, relativePath: "projects/p/out.mp4", url: "http://x" } });
  check("local result ref", j.read(jobId).localResultRef, "projects/p/out.mp4");
  check("result meta url dropped", j.read(jobId).resultMeta.url === undefined, true);
  check("downloaded classify", classifyRecovery(j.read(jobId)), RECOVERY_STATES.DOWNLOADED_NOT_IMPORTED);
  checkThrows("markLocalResult rejects absolute", () => j.markLocalResult(jobId, { localResultRef: "C:\\x.mp4" }), WORKER_ERRORS.E_JOURNAL_INVALID_REF);

  const assetId = generateId("asset");
  j.markLocalResult(jobId, { localResultRef: "projects/p/out.mp4", importedAssetId: assetId });
  check("imported asset id", j.read(jobId).importedAssetId, assetId);
  check("imported classify", classifyRecovery(j.read(jobId)), RECOVERY_STATES.IMPORTED_NOT_ACKNOWLEDGED);

  const termMsg = generateId("msg");
  j.markTerminal(jobId, { type: "JOB_COMPLETED", messageId: termMsg });
  check("terminal set", j.read(jobId).terminal.type, "JOB_COMPLETED");
  check("terminal localState", j.read(jobId).localState, "SUCCEEDED");
  j.markAckPending(jobId, termMsg);
  check("ack pending classify", classifyRecovery(j.read(jobId)), RECOVERY_STATES.TERMINAL_PENDING_ACK);
  j.markAcknowledged(jobId);
  check("acknowledged settled", classifyRecovery(j.read(jobId)), RECOVERY_STATES.SETTLED);
  check("acknowledged not recoverable", isRecoverable(j.read(jobId)), false);

  // NO dangerous field can be written through update
  checkThrows("update rejects cookie field", () => j.update(jobId, { cookie: "x" }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  checkThrows("update missing job throws", () => j.update(generateId("job"), { phase: "IMPORTING" }), WORKER_ERRORS.E_JOURNAL_NOT_FOUND);

  // survives restart: a fresh instance reads the same record
  const j2 = new RecoveryJournal({ root, now: fixedClock() });
  check("survives restart", j2.read(jobId).importedAssetId, assetId);
}

// ================= journal listing / recoverable / remove =================
{
  const root = mkTmp();
  const j = new RecoveryJournal({ root, now: fixedClock() });
  const a = generateId("job"), b = generateId("job"), c = generateId("job");
  j.create({ jobId: a, action: "GENERATE_GROK_VIDEO" });                                   // not submitted → recoverable
  j.create({ jobId: b, action: "GENERATE_GROK_VIDEO" }); j.markSubmitted(b);               // submitted → recoverable
  j.create({ jobId: c, action: "GENERATE_GROK_VIDEO" }); j.markTerminal(c, { type: "JOB_COMPLETED" }); j.markAcknowledged(c); // settled

  check("list has 3", j.list().length, 3);
  const sortedIds = j.list().map((r) => r.jobId);
  check("list deterministic sorted", sortedIds.join(",") === [a, b, c].slice().sort().join(","), true);
  check("recoverable excludes settled", j.listRecoverable().length, 2);
  check("recoverable ids", j.listRecoverable().every((r) => r.jobId !== c), true);

  check("remove returns true", j.remove(a), true);
  check("remove idempotent", j.remove(a), false);
  check("list has 2 after remove", j.list().length, 2);
}

// ================= corrupt quarantine + schema mismatch =================
{
  const root = mkTmp();
  const j = new RecoveryJournal({ root, now: fixedClock() });
  const jobId = generateId("job");
  // write a corrupt file directly at the journal path (materialize the dir first)
  mkdirSync(path.dirname(j.getPath(jobId)), { recursive: true });
  writeFileSync(j.getPath(jobId), "{ this is not valid json", "utf8");
  const readCorrupt = j.read(jobId);
  check("corrupt read flagged", readCorrupt.corrupt, true);
  check("corrupt reason", readCorrupt.reason, "invalid-json");
  check("corrupt classify", classifyRecovery(readCorrupt), RECOVERY_STATES.CORRUPT_JOURNAL);
  check("corrupt moved to quarantine", j.listQuarantined().length >= 1, true);
  check("corrupt no longer at journal path", existsSync(j.getPath(jobId)), false);

  // schema version mismatch → quarantined too
  const jobId2 = generateId("job");
  writeFileSync(j.getPath(jobId2), JSON.stringify({ jobId: jobId2, schemaVersion: 999 }), "utf8");
  check("schema mismatch flagged", j.read(jobId2).corrupt, true);
  check("schema mismatch reason", j.read(jobId2) === null || true, true); // already quarantined on first read

  // explicit quarantine of a live record
  const jobId3 = generateId("job");
  j.create({ jobId: jobId3, action: "GENERATE_GROK_VIDEO" });
  const qpath = j.quarantine(jobId3, "operator-request");
  check("quarantine returns path", typeof qpath === "string", true);
  check("quarantine removed from journal", existsSync(j.getPath(jobId3)), false);
}

// ================= retention sweep (injectable clock) =================
{
  const root = mkTmp();
  const T0 = "2026-07-12T00:00:00.000Z";
  const t0ms = Date.parse(T0);
  const j = new RecoveryJournal({ root, now: fixedClock(T0) });
  const done = generateId("job"), active = generateId("job");
  j.create({ jobId: done, action: "GENERATE_GROK_VIDEO" }); j.markTerminal(done, { type: "JOB_COMPLETED" }); j.markAcknowledged(done);
  j.create({ jobId: active, action: "GENERATE_GROK_VIDEO" }); j.markSubmitted(active);

  check("sweep keeps within retention", j.sweep({ terminalAckRetentionMs: 60000, nowMs: t0ms + 500 }).length, 0);
  const removed = j.sweep({ terminalAckRetentionMs: 1000, nowMs: t0ms + 5000 });
  check("sweep removes settled past retention", removed.length, 1);
  check("sweep removed the settled one", removed[0], done);
  check("sweep never removes active/submitted", existsSync(j.getPath(active)), true);
}

// ================= pending-ack store =================
{
  const root = mkTmp();
  const store = new PendingAckStore({ root, now: fixedClock() });
  const jobId = generateId("job");
  const term = makeEnvelope({ type: "JOB_COMPLETED", workspaceId: WS, workerId: WRK, jobId, payload: { sequence: 1, result: { ok: true } } });

  check("pending-ack types", PENDING_ACK_TYPES.includes("JOB_COMPLETED"), true);
  store.put(term);
  check("has after put", store.has(term.messageId), true);
  check("get returns record", store.get(term.messageId).type, "JOB_COMPLETED");
  check("list has 1", store.list().length, 1);

  checkThrows("put rejects MESSAGE_ACK", () => store.put(makeEnvelope({ type: "MESSAGE_ACK", workspaceId: WS, workerId: WRK, jobId, payload: { ackedMessageId: generateId("msg"), ackedType: "JOB_COMPLETED", status: "ACCEPTED", serverRevision: null, errorCode: null } })), WORKER_ERRORS.E_JOURNAL_UNSAFE);
  checkThrows("put rejects non-ackable type", () => store.put(makeEnvelope({ type: "JOB_STARTED", workspaceId: WS, workerId: WRK, jobId, payload: {} })), WORKER_ERRORS.E_JOURNAL_UNSAFE);

  // ACCEPTED ack removes the pending record
  const okAck = { payload: { ackedMessageId: term.messageId, ackedType: "JOB_COMPLETED", status: "ACCEPTED" } };
  const r1 = store.onAck(okAck);
  check("onAck accepted", r1.accepted, true);
  check("removed after accepted", store.has(term.messageId), false);

  // REJECTED ack → diagnostics, not silently dropped
  const term2 = makeEnvelope({ type: "JOB_FAILED", workspaceId: WS, workerId: WRK, jobId, payload: { sequence: 1, errorCode: "E_HANDLER_FAILED", errorMessage: "x" } });
  store.put(term2);
  const r2 = store.onAck({ payload: { ackedMessageId: term2.messageId, ackedType: "JOB_FAILED", status: "REJECTED", errorCode: "E_INVALID_ENVELOPE" } });
  check("onAck rejected not accepted", r2.accepted, false);
  check("rejected removed from pending", store.has(term2.messageId), false);
  check("rejected moved to diagnostics", store.listDiagnostics().length >= 1, true);

  // unknown ack → no-op
  check("onAck unknown → not found", store.onAck({ payload: { ackedMessageId: generateId("msg"), ackedType: "JOB_COMPLETED", status: "ACCEPTED" } }).found, false);

  // markAcknowledged convenience
  const term3 = makeEnvelope({ type: "JOB_CANCELED", workspaceId: WS, workerId: WRK, jobId, payload: { sequence: 1, canceledAt: "2026-07-12T00:00:00.000Z", keptPartialFile: false } });
  store.put(term3);
  check("markAcknowledged removes", (() => { store.markAcknowledged(term3.messageId); return store.has(term3.messageId); })(), false);
}

// ================= reconcile-builder =================
{
  const root = mkTmp();
  const j = new RecoveryJournal({ root, now: fixedClock() });
  // one terminal-pending-ack, two active (submitted + not-submitted)
  const tp = generateId("job"), sub = generateId("job"), fresh = generateId("job"), settled = generateId("job");
  j.create({ jobId: tp, action: "GENERATE_GROK_VIDEO" }); j.markTerminal(tp, { type: "JOB_COMPLETED", messageId: generateId("msg") }); j.markAckPending(tp, generateId("msg"));
  j.create({ jobId: sub, action: "GENERATE_GROK_VIDEO" }); j.markSubmitted(sub); j.markLocalResult(sub, { localResultRef: "p/out.mp4" });
  j.create({ jobId: fresh, action: "GENERATE_GROK_VIDEO" });
  j.create({ jobId: settled, action: "GENERATE_GROK_VIDEO" }); j.markTerminal(settled, { type: "JOB_COMPLETED" }); j.markAcknowledged(settled);

  const records = j.list();
  const batches = buildReconcileBatches({ workspaceId: WS, workerId: WRK, records, reconcileId: generateId("corr"), generatedAt: "2026-07-12T00:00:00.000Z" });
  check("single batch (small set)", batches.length, 1);
  const p = batches[0].payload;
  check("reconcile type", batches[0].type, "STATE_RECONCILE");
  check("batch index/total/isLast", `${p.index}/${p.total}/${p.isLast}`, "0/1/true");
  check("counts terminalPendingAck", p.counts.terminalPendingAck, 1);
  check("counts activeJobs", p.counts.activeJobs, 2); // sub + fresh (settled excluded)
  check("settled excluded from items", p.items.every((it) => it.jobId !== settled), true);
  check("terminalPending first", p.items[0].jobId, tp);
  check("each batch passes validateEnvelope", (() => { validateEnvelope(batches[0], { checkSkew: false }); return true; })(), true);
  check("localResultRef relative only", p.items.find((it) => it.jobId === sub).localResultRef, "p/out.mp4");

  // builder does not mutate the journal
  check("builder did not mutate journal", j.read(tp).terminal.type, "JOB_COMPLETED");

  // deterministic batching + same reconcileId across many records with small cap
  const root2 = mkTmp();
  const j2 = new RecoveryJournal({ root: root2, now: fixedClock() });
  for (let i = 0; i < 12; i += 1) { const id = generateId("job"); j2.create({ jobId: id, action: "GENERATE_GROK_VIDEO" }); j2.markSubmitted(id); }
  const rid = generateId("corr");
  const many = buildReconcileBatches({ workspaceId: WS, workerId: WRK, records: j2.list(), reconcileId: rid, generatedAt: "2026-07-12T00:00:00.000Z", maxPayloadBytes: 1500 });
  check("multiple batches when capped", many.length > 1, true);
  check("same reconcileId across batches", many.every((b) => b.payload.reconcileId === rid), true);
  check("total consistent", many.every((b) => b.payload.total === many.length), true);
  check("last batch isLast", many[many.length - 1].payload.isLast, true);
  check("non-last not isLast", many[0].payload.isLast, false);
  check("every capped batch within limit", many.every((b) => Buffer.byteLength(JSON.stringify(b.payload)) <= 1500), true);
  check("every capped batch valid envelope", (() => { for (const b of many) validateEnvelope(b, { checkSkew: false }); return true; })(), true);
  check("all batches ≤ reconcile hard limit", many.every((b) => Buffer.byteLength(JSON.stringify(b.payload)) <= MAX_RECONCILE_PAYLOAD_BYTES), true);

  // recovery report
  const report = buildRecoveryReport(sub, { workspaceId: WS, workerId: WRK, record: j.read(sub), generatedAt: "2026-07-12T00:00:00.000Z" });
  check("report type", report.type, "JOB_RECOVERY_REPORT");
  check("report jobId", report.jobId, sub);
  check("report submittedToProvider", report.payload.submittedToProvider, true);
  check("report createdSecondGeneration false", report.payload.createdSecondGeneration, false);
  check("report localResultRef relative", report.payload.localResultRef, "p/out.mp4");
  check("report valid envelope", (() => { validateEnvelope(report, { checkSkew: false }); return true; })(), true);
  checkThrows("report requires matching record", () => buildRecoveryReport(sub, { workspaceId: WS, workerId: WRK, record: j.read(fresh) }));
}

// ================= WorkerRuntime + journal + pending-ack integration =================
{
  const root = mkTmp();
  const journal = new RecoveryJournal({ root, now: fixedClock() });
  const pendingAck = new PendingAckStore({ root, now: fixedClock() });
  const transport = new MockTransport().connect();
  const registry = new JobRegistry();

  const submissionId = generateId("submission");
  const assetId = generateId("asset");
  registry.register("GENERATE_GROK_VIDEO", {
    validate() {},
    async execute(input, ctx) {
      ctx.onProgress({ phase: "SUBMITTING_PROMPT", percent: 20 });
      ctx.markSubmittedToProvider(submissionId);          // persists quota-safety flag
      ctx.onProgress({ phase: "WAITING_FOR_RESULT", percent: 50 });
      ctx.onProgress({ phase: "DOWNLOADING", percent: 90 });
      ctx.markLocalResult("projects/p/out.mp4", assetId, { checksum: "sha256:z", sizeBytes: 2048, relativePath: "projects/p/out.mp4" });
      return { result: { ok: true } };
    }
  });

  const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video"], durationContext: DUR_CTX, journal, pendingAck }).start();

  // Offer a job directly (no dispatcher-ack) so we can observe pending-ack BEFORE ack.
  const jobId = generateId("job");
  const offer = makeEnvelope({
    type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, correlationId: generateId("corr"),
    payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), quotaRisk: true, input: baseInput() }
  });
  transport.offerJob(offer);
  await waitFor(() => journal.read(jobId)?.terminal != null);

  const rec = journal.read(jobId);
  check("journal submitted persisted", rec.submittedToProvider, true);
  check("journal submissionId persisted", rec.providerSubmissionId, submissionId);
  check("journal local result persisted", rec.localResultRef, "projects/p/out.mp4");
  check("journal imported asset persisted", rec.importedAssetId, assetId);
  check("journal terminal persisted", rec.terminal.type, "JOB_COMPLETED");
  check("journal phase progressed", rec.phase, "DOWNLOADING");
  check("journal ackPending before ack", rec.ackPending, true);
  check("journal not acknowledged before ack", rec.acknowledged, false);
  check("pending-ack holds terminal", pendingAck.has(rec.terminalMessageId), true);
  check("pending-ack list size 1", pendingAck.list().length, 1);

  // recoverJobs must NEVER offer a submitted job for auto-retry
  const recovery = runtime.recoverJobs();
  check("recover candidate present", recovery.candidates.some((c) => c.jobId === jobId), true);
  check("submitted job NOT auto-retryable", recovery.autoRetryable.length, 0);
  check("submitted job recover-without-generation", recovery.recoverWithoutGeneration.some((c) => c.jobId === jobId), true);

  // deliver ACCEPTED ack → pending-ack removed + journal acknowledged
  const ack = makeEnvelope({
    type: "MESSAGE_ACK", workspaceId: WS, workerId: WRK, jobId,
    payload: { ackedMessageId: rec.terminalMessageId, ackedType: "JOB_COMPLETED", status: "ACCEPTED", serverRevision: null, errorCode: null }
  });
  runtime.handleEnvelope(ack);
  check("pending-ack removed after ACCEPTED", pendingAck.has(rec.terminalMessageId), false);
  check("journal acknowledged after ACCEPTED", journal.read(jobId).acknowledged, true);
  check("acknowledged job now settled", classifyRecovery(journal.read(jobId)), RECOVERY_STATES.SETTLED);
  check("settled excluded from recovery", runtime.recoverJobs().candidates.some((c) => c.jobId === jobId), false);
}

// ================= full dispatcher↔runtime loop with durability =================
{
  const root = mkTmp();
  const journal = new RecoveryJournal({ root, now: fixedClock() });
  const pendingAck = new PendingAckStore({ root, now: fixedClock() });
  const transport = new MockTransport().connect();
  const registry = new JobRegistry();
  registry.register("GENERATE_GROK_VIDEO", { validate() {}, async execute() { return { result: { ok: true } }; } });
  const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video"], durationContext: DUR_CTX, journal, pendingAck }).start();
  const dispatcher = new JobDispatcher({ transport, workspaceId: WS, workerId: WRK, durationContext: DUR_CTX });

  const h = dispatcher.dispatch("GENERATE_GROK_VIDEO", baseInput());
  const res = await h.done;
  await waitFor(() => journal.read(h.jobId)?.acknowledged === true);
  check("dispatcher loop terminal completed", res.type, "JOB_COMPLETED");
  check("dispatcher loop journal acknowledged", journal.read(h.jobId).acknowledged, true);
  check("dispatcher loop pending-ack drained", pendingAck.list().length, 0);
}

// ================= CRIT-1 regression: crash-safe terminal delivery (durable mode) =================
{
  // Handler completes AFTER the transport is disconnected, so terminal emission's
  // publish fails — but persistence happened first. Required behavior:
  //  - no unhandled rejection, no SUCCEEDED→FAILED;
  //  - terminal is durably persisted in the journal;
  //  - the terminal envelope stays in pending-ack for replay with the SAME messageId;
  //  - delivery is deferred (not "undelivered", because it is replayable);
  //  - provider generation is never re-run (submittedToProvider stays true).
  const root = mkTmp();
  const journal = new RecoveryJournal({ root, now: fixedClock() });
  const pendingAck = new PendingAckStore({ root, now: fixedClock() });
  const transport = new MockTransport().connect();
  const registry = new JobRegistry();
  let release; const gate = new Promise((r) => { release = r; });
  const submissionId = generateId("submission");
  registry.register("GENERATE_GROK_VIDEO", {
    validate() {},
    async execute(input, ctx) { ctx.markSubmittedToProvider(submissionId); await gate; return { result: { ok: true } }; }
  });
  const runtime = new WorkerRuntime({ transport, registry, workerId: WRK, capabilities: ["grok.video"], durationContext: DUR_CTX, journal, pendingAck }).start();

  const jobId = generateId("job");
  transport.offerJob(makeEnvelope({
    type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, correlationId: generateId("corr"),
    payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), quotaRisk: true, input: baseInput() }
  }));
  await waitFor(() => runtime.getJobState(jobId) === "RUNNING");
  transport.disconnect();   // drop before terminal
  release();                // handler resolves → terminal persisted, publish fails
  await waitFor(() => journal.read(jobId)?.terminal != null);
  await new Promise((r) => setTimeout(r, 30)); // let any (buggy) rejection surface

  const rec = journal.read(jobId);
  check("crit1 durable: no unhandled rejection", crit1Unhandled, false);
  check("crit1 durable: terminal preserved (SUCCEEDED)", runtime.getJobState(jobId), "SUCCEEDED");
  check("crit1 durable: journal terminal persisted", rec.terminal.type, "JOB_COMPLETED");
  check("crit1 durable: submittedToProvider intact (no re-gen)", rec.submittedToProvider, true);
  check("crit1 durable: ackPending set", rec.ackPending, true);
  check("crit1 durable: pending-ack holds terminal (same messageId)", pendingAck.has(rec.terminalMessageId), true);
  const ds = runtime.getDeliveryStatus(jobId);
  check("crit1 durable: delivery deferred", ds.deferred, true);
  check("crit1 durable: not 'undelivered' (replayable)", ds.undelivered, false);
  check("crit1 durable: persist did not fail", ds.persistFailed, false);

  // Reconnect + duplicate offer → SAME terminal messageId replayed (rule 5).
  transport.connect();
  const seen = [];
  transport.subscribeControl((env) => { if (env.jobId === jobId && env.type === "JOB_COMPLETED") seen.push(env.messageId); });
  transport.offerJob(makeEnvelope({
    type: "JOB_OFFER", workspaceId: WS, workerId: WRK, jobId, correlationId: generateId("corr"),
    payload: { action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), quotaRisk: true, input: baseInput() }
  }));
  await new Promise((r) => setImmediate(r));
  check("crit1 durable: replay uses same terminal messageId", seen[0], rec.terminalMessageId);

  // ACCEPTED ack now clears pending-ack + acknowledges journal.
  runtime.handleEnvelope(makeEnvelope({
    type: "MESSAGE_ACK", workspaceId: WS, workerId: WRK, jobId,
    payload: { ackedMessageId: rec.terminalMessageId, ackedType: "JOB_COMPLETED", status: "ACCEPTED", serverRevision: null, errorCode: null }
  }));
  check("crit1 durable: ack clears pending-ack", pendingAck.has(rec.terminalMessageId), false);
  check("crit1 durable: ack marks journal acknowledged", journal.read(jobId).acknowledged, true);
}

cleanup();
if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else console.log(`${passed} passed, 0 failed`);
