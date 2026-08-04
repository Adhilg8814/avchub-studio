// AVC Studio P0 Step 3 — durable local recovery journal (filesystem-backed).
//
// This is one of the two DESIGNATED impure worker modules (it uses node:fs). It
// records, per job, exactly enough state to recover safely across a crash/restart
// WITHOUT re-spending provider quota. Everything written is safe by construction
// AND re-checked with assertRecordSafe: no password/cookie/token/proxy/fingerprint,
// no absolute paths, no browser-profile paths, no raw provider URLs.
//
// Durability model (same idea as lib/video-projects.mjs atomicWriteJson): write a
// temp file in the same directory, then rename over the target. A crash mid-write
// leaves either the old complete file or nothing — never a half-written record.
//
// On-disk layout, all under a configurable root:
//   <root>/journal/<jobId>.json        one record per job (jobId is a validated
//                                       ULID → filename-safe, traversal impossible)
//   <root>/quarantine/<jobId>.<n>.json corrupt records, moved aside not deleted
//
// Timestamps are UTC ISO-8601. The clock is injectable for deterministic tests.

import {
  mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync,
  existsSync, rmSync
} from "node:fs";
import path from "node:path";
import { generateId, validateId } from "../protocol/ids.mjs";
import {
  JOURNAL_SCHEMA_VERSION, WORKER_ERRORS, workerError, assertRecordSafe,
  assertRelativeRef, safeResultMeta, sanitizeErrorForJournal, journalFileName
} from "./journal-safety.mjs";
import { classifyRecovery, isRecoverable, RECOVERY_STATES } from "./recovery-classifier.mjs";
import { PROGRESS_PHASES } from "./progress-adapter.mjs";
import {
  assertRecoveryTransition, isTerminalLocalState, isPostSubmitLocalState,
  SUBMISSION_STATE, SUBMISSION_CONFIDENCE, IDEMPOTENCY_SUPPORT,
  isSubmissionConfidence, isIdempotencySupport
} from "./recovery-states.mjs";

const PHASE_SET = new Set(PROGRESS_PHASES);
const TERMINAL_TYPES = new Set(["JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED"]);
const TERMINAL_LOCAL_STATE = {
  JOB_COMPLETED: "SUCCEEDED", JOB_FAILED: "FAILED", JOB_CANCELED: "CANCELED"
};

export class RecoveryJournal {
  constructor({ root, now, schemaVersion } = {}) {
    if (!root || typeof root !== "string") throw new Error("RecoveryJournal requires a root directory");
    this._root = root;
    this._dir = path.join(root, "journal");
    this._quarantineDir = path.join(root, "quarantine");
    this._now = typeof now === "function" ? now : () => new Date().toISOString();
    this._schemaVersion = Number.isInteger(schemaVersion) ? schemaVersion : JOURNAL_SCHEMA_VERSION;
    this._qSeq = 0;
  }

  // ---- paths ----
  _pathFor(jobId) { return path.join(this._dir, journalFileName(jobId)); }
  getPath(jobId) { return this._pathFor(jobId); }

  _ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }

  _writeAtomic(filePath, data) {
    this._ensureDir(path.dirname(filePath));
    const tmp = path.join(path.dirname(filePath), `.tmp-${generateId("msg").slice(4)}-${path.basename(filePath)}`);
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, filePath); // atomic replace on the same filesystem
  }

  // ---- create / read / update ----

  // create(fields): idempotent. If a record already exists for jobId, the existing
  // record is returned unchanged (a duplicate offer must never reset progress).
  create(fields = {}) {
    const jobId = fields.jobId;
    if (!validateId(jobId, "job")) throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "create requires a valid jobId", { field: "jobId" });
    const existing = this._readRaw(jobId);
    if (existing && !existing.corrupt) return existing;

    const ts = this._now();
    const record = {
      schemaVersion: this._schemaVersion,
      jobId,
      action: typeof fields.action === "string" ? fields.action : null,
      requestIdempotencyKey: fields.requestIdempotencyKey ?? null,
      generationAttemptId: fields.generationAttemptId ?? null,
      parentAttemptId: fields.parentAttemptId ?? null,
      retryOfJobId: fields.retryOfJobId ?? null,
      // Step 5.7a — attempt identity. attemptIndex distinguishes retries of the SAME
      // request (0 = first attempt). generationOrdinal counts paid generations spent
      // for THIS attempt and must never exceed 1 (the golden rule, as a number).
      attemptIndex: Number.isInteger(fields.attemptIndex) ? fields.attemptIndex : 0,
      generationOrdinal: 0,
      acceptedBaseRevision: Number.isInteger(fields.acceptedBaseRevision) ? fields.acceptedBaseRevision : null,
      quotaRisk: fields.quotaRisk === true,
      workspaceId: fields.workspaceId ?? null,
      correlationId: fields.correlationId ?? null,
      localState: "CREATED",
      phase: null,
      lastEventSequence: 0,
      percent: null,
      // Step 5.7a — submission evidence. submissionState/Confidence are the authoritative
      // "was a paid generation dispatched?" signal; submittedToProvider stays as the
      // coarse boolean for backward-compatible callers/classifier.
      submissionState: SUBMISSION_STATE.NOT_SUBMITTED,
      submissionConfidence: SUBMISSION_CONFIDENCE.NONE,
      submissionEvidence: null,
      providerIdempotencyKey: null,
      idempotencySupport: IDEMPOTENCY_SUPPORT.NONE,
      submittingAt: null,
      submittedToProvider: false,
      providerSubmissionId: null,
      resultAvailable: false,
      localResultRef: null,
      importedAssetId: null,
      resultMeta: null,
      terminal: null,
      terminalMessageId: null,
      ackPending: false,
      ackMessageId: null,
      acknowledged: false,
      error: null,
      needsManualAction: false,
      createdAt: ts,
      updatedAt: ts,
      startedAt: null,
      submittedAt: null,
      terminalAt: null,
      acknowledgedAt: null
    };
    assertRecordSafe(record);
    this._writeAtomic(this._pathFor(jobId), record);
    return record;
  }

  // read(jobId): parsed record, a corrupt marker (after quarantining), or null.
  read(jobId) {
    if (!validateId(jobId, "job")) throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "read requires a valid jobId", { field: "jobId" });
    return this._readRaw(jobId);
  }

  _readRaw(jobId) {
    const file = this._pathFor(jobId);
    if (!existsSync(file)) return null;
    let text;
    try { text = readFileSync(file, "utf8"); }
    catch { return null; }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return this._quarantineCorrupt(jobId, "invalid-json"); }
    if (!parsed || typeof parsed !== "object" || parsed.jobId !== jobId) {
      return this._quarantineCorrupt(jobId, "shape-mismatch");
    }
    if (parsed.schemaVersion !== this._schemaVersion) {
      return this._quarantineCorrupt(jobId, "schema-version-mismatch");
    }
    return parsed;
  }

  // update(jobId, patch): shallow-merge allowed fields, re-check safety, bump
  // updatedAt, persist atomically. Throws if the record is missing/corrupt.
  update(jobId, patch = {}) {
    const rec = this._requireLive(jobId);
    const next = { ...rec, ...patch, jobId, schemaVersion: this._schemaVersion, updatedAt: this._now() };
    assertRecordSafe(next);
    this._writeAtomic(this._pathFor(jobId), next);
    return next;
  }

  _requireLive(jobId) {
    const rec = this._readRaw(jobId);
    if (!rec) throw workerError(WORKER_ERRORS.E_JOURNAL_NOT_FOUND, "No journal record for job", { jobId });
    if (rec.corrupt) throw workerError(WORKER_ERRORS.E_JOURNAL_CORRUPT, "Journal record is corrupt", { jobId });
    return rec;
  }

  // ---- lifecycle transitions ----
  //
  // Every state change is checked against the recovery state machine
  // (recovery-states.mjs). An illegal move throws E_ILLEGAL_RECOVERY_TRANSITION and
  // leaves the record untouched — the journal can only ever advance a record forward.

  // Assert `rec.localState → nextState` is legal, then return the patch's localState.
  _assertLocalTransition(rec, nextState) {
    assertRecoveryTransition(rec.localState, nextState, { jobId: rec.jobId });
    return nextState;
  }

  // Scan for a DIFFERENT live job that shares this generationAttemptId and has already
  // reached a post-submit state — i.e. a paid generation is already accounted to this
  // attempt. Returns the offending jobId, or null. Only meaningful when attemptId set.
  _findSubmittedSibling(generationAttemptId, selfJobId) {
    if (!generationAttemptId) return null;
    for (const rec of this.list()) {
      if (rec.corrupt) continue;
      if (rec.jobId === selfJobId) continue;
      if (rec.generationAttemptId !== generationAttemptId) continue;
      if (rec.submittedToProvider === true || isPostSubmitLocalState(rec.localState)) return rec.jobId;
    }
    return null;
  }

  markRunning(jobId) {
    const rec = this._requireLive(jobId);
    const localState = this._assertLocalTransition(rec, "RUNNING");
    return this.update(jobId, { localState, startedAt: rec.startedAt ?? this._now() });
  }

  // markSubmitting: the CRASH-WINDOW BARRIER (review item C3). Persisted BEFORE the
  // provider is asked to generate. It records generationOrdinal=1 with confidence
  // UNKNOWN, so a crash between here and markSubmitted recovers to a record that knows
  // a paid generation may be in flight and must be inspected — never blindly retried.
  //
  // The golden rule is enforced HERE, twice: (1) this record may enter SUBMITTING at
  // most once (generationOrdinal must still be 0); (2) no sibling job for the same
  // generationAttemptId may already have submitted.
  markSubmitting(jobId, { providerIdempotencyKey = null, idempotencySupport = null } = {}) {
    const rec = this._requireLive(jobId);
    if (rec.generationOrdinal >= 1) {
      throw workerError(WORKER_ERRORS.E_DUPLICATE_GENERATION_ATTEMPT,
        "generationAttemptId already has a paid generation (this job)", { jobId, generationOrdinal: rec.generationOrdinal });
    }
    const sibling = this._findSubmittedSibling(rec.generationAttemptId, jobId);
    if (sibling) {
      throw workerError(WORKER_ERRORS.E_DUPLICATE_GENERATION_ATTEMPT,
        "generationAttemptId already submitted by a sibling job", { jobId, generationAttemptId: rec.generationAttemptId, sibling });
    }
    const localState = this._assertLocalTransition(rec, "SUBMITTING");
    const patch = {
      localState,
      submissionState: SUBMISSION_STATE.SUBMITTING,
      submissionConfidence: SUBMISSION_CONFIDENCE.UNKNOWN,
      generationOrdinal: 1,
      submittingAt: this._now()
    };
    const key = this._safeIdempotencyKey(providerIdempotencyKey);
    if (key !== null) patch.providerIdempotencyKey = key;
    if (isIdempotencySupport(idempotencySupport)) patch.idempotencySupport = idempotencySupport;
    return this.update(jobId, patch);
  }

  // markSubmitted: the QUOTA-SAFETY commit. Once submittedToProvider is true the job can
  // never be auto-retried; recovery must reuse the existing generation. Accepts either a
  // bare providerSubmissionId string (Step 4A fakes) or an options object with full
  // submission evidence. If markSubmitting was not called first (legacy one-step path),
  // this still books generationOrdinal=1 so the golden rule holds.
  markSubmitted(jobId, arg = null) {
    const opts = (arg && typeof arg === "object") ? arg : { providerSubmissionId: arg };
    const providerSubmissionId = opts.providerSubmissionId ?? null;
    if (providerSubmissionId != null && !validateId(providerSubmissionId, "submission")) {
      throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "providerSubmissionId must be submission_<ULID>", { field: "providerSubmissionId" });
    }
    const rec = this._requireLive(jobId);

    // Idempotent re-commit of an already-SUBMITTED record: refresh evidence, do not
    // re-book a generation. (A handler may call markSubmittedToProvider more than once.)
    const alreadySubmitted = rec.submittedToProvider === true;
    if (!alreadySubmitted) {
      // Fresh submit: the sibling golden-rule guard applies (markSubmitting already ran
      // it when used, but the one-step legacy path lands here directly).
      const sibling = this._findSubmittedSibling(rec.generationAttemptId, jobId);
      if (sibling) {
        throw workerError(WORKER_ERRORS.E_DUPLICATE_GENERATION_ATTEMPT,
          "generationAttemptId already submitted by a sibling job", { jobId, generationAttemptId: rec.generationAttemptId, sibling });
      }
    }
    const localState = rec.localState === "SUBMITTED" ? "SUBMITTED" : this._assertLocalTransition(rec, "SUBMITTED");

    let confidence = opts.submissionConfidence;
    if (!isSubmissionConfidence(confidence)) {
      confidence = providerSubmissionId ? SUBMISSION_CONFIDENCE.CONFIRMED : SUBMISSION_CONFIDENCE.PRESUMED;
    }
    const patch = {
      submittedToProvider: true,
      providerSubmissionId: providerSubmissionId ?? rec.providerSubmissionId ?? null,
      localState,
      submissionState: SUBMISSION_STATE.SUBMITTED,
      submissionConfidence: confidence,
      generationOrdinal: Math.max(1, rec.generationOrdinal || 0),
      submittedAt: rec.submittedAt ?? this._now()
    };
    const evidence = this._safeSubmissionEvidence(opts.submissionEvidence);
    if (evidence !== null) patch.submissionEvidence = evidence;
    const key = this._safeIdempotencyKey(opts.providerIdempotencyKey);
    if (key !== null) patch.providerIdempotencyKey = key;
    if (isIdempotencySupport(opts.idempotencySupport)) patch.idempotencySupport = opts.idempotencySupport;
    return this.update(jobId, patch);
  }

  // markDownloading: the provider result is being fetched to a local ref. SUBMITTED →
  // DOWNLOADING (never re-submits). Distinct from markLocalResult, which records the
  // fetched ref; this only marks that the download has begun (crash-window between
  // "result available" and "result on disk").
  markDownloading(jobId) {
    const rec = this._requireLive(jobId);
    const localState = this._assertLocalTransition(rec, "DOWNLOADING");
    return this.update(jobId, { localState });
  }

  markProgress(jobId, { phase, sequence, percent, resultAvailable } = {}) {
    const rec = this._requireLive(jobId);
    if (phase !== undefined && (typeof phase !== "string" || !PHASE_SET.has(phase))) {
      throw workerError(WORKER_ERRORS.E_JOURNAL_UNSAFE, "Unknown progress phase", { field: "phase" });
    }
    let seq = rec.lastEventSequence;
    if (sequence !== undefined) {
      if (!Number.isInteger(sequence) || sequence <= rec.lastEventSequence) {
        throw workerError(WORKER_ERRORS.E_JOURNAL_UNSAFE, "Progress sequence must strictly increase", { field: "sequence" });
      }
      seq = sequence;
    }
    let pct = rec.percent;
    if (percent !== undefined && percent !== null) {
      const p = Number(percent);
      if (!Number.isFinite(p)) throw workerError(WORKER_ERRORS.E_JOURNAL_UNSAFE, "percent must be numeric", { field: "percent" });
      pct = Math.max(0, Math.min(100, p));
    }
    const patch = { lastEventSequence: seq, percent: pct };
    if (phase !== undefined) patch.phase = phase;
    if (resultAvailable === true) patch.resultAvailable = true;
    if (phase === "NEEDS_MANUAL_ACTION") {
      patch.needsManualAction = true;
      patch.localState = this._assertLocalTransition(rec, "NEEDS_MANUAL_ACTION");
    } else if (!rec.terminal && (rec.localState === "CREATED" || rec.localState === "RUNNING")) {
      // Progress never regresses a post-submit record back to RUNNING; it only lifts a
      // freshly-CREATED record to RUNNING. Beyond that it just updates phase/percent.
      patch.localState = this._assertLocalTransition(rec, "RUNNING");
    }
    return this.update(jobId, patch);
  }

  // markLocalResult: a downloaded/imported result lives here as a RELATIVE ref plus
  // safe metadata only (checksum/size/relative path) — never a URL or absolute path.
  markLocalResult(jobId, { localResultRef, importedAssetId, resultMeta } = {}) {
    assertRelativeRef(localResultRef, "localResultRef");
    if (importedAssetId != null && !validateId(importedAssetId, "asset")) {
      throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "importedAssetId must be asset_<ULID>", { field: "importedAssetId" });
    }
    const rec = this._requireLive(jobId);
    const nextState = importedAssetId ? "IMPORTED" : "DOWNLOADING";
    const patch = {
      localResultRef,
      resultMeta: safeResultMeta(resultMeta),
      importedAssetId: importedAssetId ?? null,
      localState: this._assertLocalTransition(rec, nextState)
    };
    return this.update(jobId, patch);
  }

  markTerminal(jobId, { type, code, error, messageId } = {}) {
    if (!TERMINAL_TYPES.has(type)) throw workerError(WORKER_ERRORS.E_JOURNAL_UNSAFE, "Unknown terminal type", { field: "type" });
    if (messageId != null && !validateId(messageId, "msg")) {
      throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "terminal messageId must be msg_<ULID>", { field: "messageId" });
    }
    const rec = this._requireLive(jobId);
    const nextState = TERMINAL_LOCAL_STATE[type];
    // Idempotent re-terminal into the SAME terminal state is a no-op; a DIFFERENT
    // terminal state on an already-terminal record is illegal (CRIT-1 defense-in-depth).
    if (isTerminalLocalState(rec.localState)) {
      if (rec.localState === nextState) return rec;
      throw workerError(WORKER_ERRORS.E_ILLEGAL_RECOVERY_TRANSITION,
        `Illegal recovery transition ${rec.localState} → ${nextState}`, { jobId, from: rec.localState, to: nextState });
    }
    this._assertLocalTransition(rec, nextState);
    const ts = this._now();
    return this.update(jobId, {
      terminal: { type, code: typeof code === "string" ? code : null, at: ts },
      terminalMessageId: messageId ?? null,
      terminalAt: ts,
      localState: nextState,
      needsManualAction: false,
      error: error ? sanitizeErrorForJournal(error) : null
    });
  }

  // ---- attempt-identity queries (golden-rule support) ----

  // listByAttempt(generationAttemptId): every live record booked to this attempt.
  listByAttempt(generationAttemptId) {
    if (!generationAttemptId) return [];
    return this.list().filter((r) => !r.corrupt && r.generationAttemptId === generationAttemptId);
  }

  // hasSubmittedAttempt(generationAttemptId, { excludeJobId }): has ANY job for this
  // attempt already spent a paid generation? Used to prove the golden rule externally.
  hasSubmittedAttempt(generationAttemptId, { excludeJobId = null } = {}) {
    if (!generationAttemptId) return false;
    return this.list().some((r) =>
      !r.corrupt &&
      r.generationAttemptId === generationAttemptId &&
      r.jobId !== excludeJobId &&
      (r.submittedToProvider === true || isPostSubmitLocalState(r.localState)));
  }

  // ---- submission-evidence sanitizers (defensive; never throw) ----

  // A provider idempotency key is an opaque provider-side token: accept only a bounded
  // plain string with no URL/scheme/absolute-path shape. Anything else → null (dropped).
  _safeIdempotencyKey(key) {
    if (typeof key !== "string") return null;
    const s = key.trim();
    if (!s || s.length > 200) return null;
    if (/:\/\//.test(s) || /^[a-z]+:/i.test(s) || /^[/\\]/.test(s) || /^[A-Za-z]:[/\\]/.test(s)) return null;
    return s;
  }

  // Submission evidence is a tiny provenance note. Keep only a whitelist of scalar
  // fields; drop anything unsafe so markSubmitted can NEVER fail on evidence (which
  // would lose the quota-safety commit). Returns a frozen object or null.
  _safeSubmissionEvidence(evidence) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
    const out = {};
    for (const k of ["kind", "note", "detail", "observedAt", "source"]) {
      const v = evidence[k];
      if (typeof v === "string") {
        const s = v.slice(0, 200);
        if (/:\/\//.test(s) || /^[A-Za-z]:[/\\]/.test(s)) continue; // no URL/absolute path
        out[k] = s;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        out[k] = v;
      } else if (typeof v === "boolean") {
        out[k] = v;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  markAckPending(jobId, messageId = null) {
    if (messageId != null && !validateId(messageId, "msg")) {
      throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "ack messageId must be msg_<ULID>", { field: "messageId" });
    }
    return this.update(jobId, { ackPending: true, ackMessageId: messageId ?? null, acknowledged: false });
  }

  markAcknowledged(jobId) {
    return this.update(jobId, { ackPending: false, acknowledged: true, acknowledgedAt: this._now() });
  }

  // ---- listings ----

  _listFiles() {
    if (!existsSync(this._dir)) return [];
    return readdirSync(this._dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
      .sort(); // deterministic order (jobId filenames sort stably)
  }

  // list(): every record, sorted by jobId. Corrupt files are quarantined and
  // surfaced as { jobId, corrupt:true, reason } markers — never silently dropped.
  list() {
    const out = [];
    for (const file of this._listFiles()) {
      const jobId = file.slice(0, -".json".length);
      if (!validateId(jobId, "job")) { this._quarantineFileName(file, "bad-filename"); continue; }
      const rec = this._readRaw(jobId);
      if (rec) out.push(rec);
    }
    return out;
  }

  // listRecoverable(): records that represent unfinished work on restart (excludes
  // SETTLED acknowledged-terminal records; includes corrupt ones for the operator).
  listRecoverable() {
    return this.list().filter((rec) => isRecoverable(rec));
  }

  classify(jobId) {
    const rec = this._readRaw(jobId);
    return classifyRecovery(rec);
  }

  // ---- removal / quarantine / retention ----

  remove(jobId) {
    if (!validateId(jobId, "job")) return false;
    const file = this._pathFor(jobId);
    let removed = false;
    for (const p of [file, `${file}.bak`]) {
      if (existsSync(p)) { rmSync(p, { force: true }); removed = true; }
    }
    return removed;
  }

  // quarantine(jobId, reason): move a record aside (never delete) for operator
  // inspection. Returns the quarantine path, or null if there was nothing to move.
  quarantine(jobId, reason = "manual") {
    if (!validateId(jobId, "job")) throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "quarantine requires a valid jobId", { jobId });
    const file = this._pathFor(jobId);
    if (!existsSync(file)) return null;
    return this._moveToQuarantine(file, journalFileName(jobId), reason);
  }

  _quarantineCorrupt(jobId, reason) {
    const file = this._pathFor(jobId);
    let qpath = null;
    try { if (existsSync(file)) qpath = this._moveToQuarantine(file, journalFileName(jobId), reason); } catch { /* best effort */ }
    return { jobId, corrupt: true, reason, quarantinePath: qpath };
  }

  _quarantineFileName(fileName, reason) {
    const src = path.join(this._dir, fileName);
    try { if (existsSync(src)) this._moveToQuarantine(src, fileName, reason); } catch { /* best effort */ }
  }

  _moveToQuarantine(srcPath, baseName, reason) {
    this._ensureDir(this._quarantineDir);
    this._qSeq += 1;
    const dest = path.join(this._quarantineDir, `${baseName}.${this._qSeq}.corrupt.json`);
    try {
      // Preserve original bytes + a small sidecar note when possible.
      renameSync(srcPath, dest);
    } catch {
      // Cross-device or locked: fall back to copy+unlink semantics via read/write.
      try {
        const bytes = readFileSync(srcPath);
        writeFileSync(dest, bytes);
        rmSync(srcPath, { force: true });
      } catch { return null; }
    }
    try {
      writeFileSync(`${dest}.note.json`, `${JSON.stringify({ reason, quarantinedAt: this._now() }, null, 2)}\n`, "utf8");
    } catch { /* note is best-effort */ }
    return dest;
  }

  listQuarantined() {
    if (!existsSync(this._quarantineDir)) return [];
    return readdirSync(this._quarantineDir).filter((f) => f.endsWith(".corrupt.json")).sort();
  }

  // sweep(options): retention. Removes acknowledged-terminal (SETTLED) records
  // whose acknowledgedAt is older than terminalAckRetentionMs. NEVER deletes media
  // and NEVER touches active/recoverable or corrupt records. Uses the injected clock.
  sweep({ terminalAckRetentionMs = 0, nowMs } = {}) {
    const removed = [];
    const cutoffNow = Number.isFinite(nowMs) ? nowMs : Date.parse(this._now());
    for (const rec of this.list()) {
      if (rec.corrupt) continue;
      if (classifyRecovery(rec) !== RECOVERY_STATES.SETTLED) continue;
      const ackAt = rec.acknowledgedAt ? Date.parse(rec.acknowledgedAt) : NaN;
      if (!Number.isFinite(ackAt)) continue;
      if (cutoffNow - ackAt >= terminalAckRetentionMs) {
        this.remove(rec.jobId);
        removed.push(rec.jobId);
      }
    }
    return removed;
  }
}
