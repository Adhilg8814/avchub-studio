// P0 Step 5C.31 — REMOTE DELIVERY SERVICE (hub side).
//
// Turns the transport-only WSS session into a real job-delivery plane WITHOUT introducing a second
// scheduler, a second claim engine, or a second owner of the pipeline.
//
// The invariant that makes this safe is structural, not procedural:
//
//     an attempt's owner is `job_offers.assigned_worker_id`, and there is exactly one such row.
//
// The local in-process worker claims only offers assigned to ITS worker id
// (generation-control-plane.claimNextForWorker filters on it); this service claims only offers
// assigned to the CONNECTED remote worker id. A job is therefore either local work or remote work —
// never both — and "who owns it" is answered by a single durable column, not by coordination.
//
// Every inbound worker command is written to remote_delivery_commands INSIDE the same transaction as
// its effect. The unique (workspace, worker, command_id) key makes a post-reconnect replay a provable
// no-op, and the per-attempt singleton index makes a second ACCEPT/SUBMIT_ATTEMPTED/SUBMITTED/COMPLETE
// for the same attempt impossible even if the worker misbehaves. That is the transport half of the
// single-submission invariant; the provider half (the one-invocation guard) stays on the machine that
// actually drives the browser.

import { createHash, randomBytes } from "node:crypto";
import { newId } from "../../../control-plane/src/persistence/ids.mjs";
import { DomainError } from "../../../control-plane/src/persistence/domain-errors.mjs";
import { generationProjectionRepository as proj } from "../../../control-plane/src/persistence/repositories/generation-projection-repository.mjs";
import { GENERATION_JOB_STATES as S, isPostSubmit, isTerminal } from "../../protocol/generation-job-states.mjs";
import { REMOTE_ERRORS, W2S, DELIVERY_PROTOCOL_VERSION } from "./remote-protocol.mjs";

const LEASE_TTL_MS = 300_000;
const UPLOAD_TTL_MS = 30 * 60_000;

// Business rejections must survive the persistence adapter. tenantTransaction PRESERVES a DomainError
// and remaps everything else through mapPgError, so a plain Error thrown inside a transaction would lose
// its code and surface as E_INVALID_STATE_TRANSITION. Subclassing DomainError (the same pattern
// PlatformError / TenantQuotaError / ResourceError use) keeps the remote error codes intact end to end.
export class RemoteDeliveryError extends DomainError {
  constructor(code, message) { super("E_INVALID_STATE_TRANSITION", message || code); this.code = code; this.name = "RemoteDeliveryError"; this.isRemoteDeliveryError = true; }
}
function rerr(code, message) { return new RemoteDeliveryError(code, message); }
const digestOf = (t) => createHash("sha256").update(String(t), "utf8").digest("hex");

// A safe error code the worker may report. Anything unrecognised collapses to a generic code so a
// remote machine can never inject arbitrary text into durable state or logs.
function sanitizeCode(v, fallback) {
  return typeof v === "string" && /^E_[A-Z0-9_]{2,60}$/u.test(v) ? v : fallback;
}
function safeHost(v) {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : null;
}

export function createRemoteDeliveryService({ persistence, resolveTenant, registry, mediaRootFor, now = () => Date.now(), logger = null } = {}) {
  if (!persistence || typeof persistence.tenantTransaction !== "function") throw new TypeError("createRemoteDeliveryService requires persistence");
  if (typeof resolveTenant !== "function") throw new TypeError("createRemoteDeliveryService requires resolveTenant(workspaceId)");
  if (!registry) throw new TypeError("createRemoteDeliveryService requires the remote worker registry");

  const tx = (wsId, fn) => persistence.tenantTransaction(wsId, fn);
  const log = (lvl, event, fields) => { try { logger?.[lvl]?.(event, fields); } catch { /* logging must never break delivery */ } };

  // ---------------------------------------------------------------- command ledger
  // Record the command FIRST inside the effect transaction. A duplicate command id (replay) violates
  // the unique key -> we surface DUPLICATE and the caller returns an ACK without re-applying anything.
  async function recordCommandCore(client, wsId, { workerId, jobId = null, attemptId = null, commandId, kind, sequence = 0 }) {
    try {
      await client.query(
        `INSERT INTO remote_delivery_commands (id, workspace_id, worker_id, job_id, generation_attempt_id, command_id, kind, sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId("rdc"), wsId, workerId, jobId, attemptId, commandId, kind, sequence]);
      return { recorded: true };
    } catch (e) {
      if (e && e.code === "23505") return { recorded: false, duplicate: true };
      throw e;
    }
  }

  // Highest sequence already accepted for this attempt. An inbound frame with a LOWER sequence is a
  // stale/reordered replay and is refused (never applied out of order).
  async function maxSequenceCore(client, wsId, attemptId) {
    const r = await client.query(
      "SELECT COALESCE(max(sequence), -1) AS s FROM remote_delivery_commands WHERE workspace_id=$1 AND generation_attempt_id=$2",
      [wsId, attemptId]);
    return Number(r.rows[0].s);
  }

  // The connected worker must be the CURRENT owner of the attempt's live offer, and the lease must not
  // have expired. This is re-checked inside every mutating transaction (a lease that expired between
  // two frames must not be able to mutate the job).
  async function requireOwnershipCore(client, wsId, { workerId, jobId, requireLive = true }) {
    const r = await client.query(
      `SELECT o.id, o.generation_attempt_id, o.assigned_worker_id, o.ownership_status, o.lease_expires_at, o.terminal_at,
              p.state AS proj_state
         FROM job_offers o JOIN generation_jobs p ON p.workspace_id=o.workspace_id AND p.id=o.job_id
        WHERE o.workspace_id=$1 AND o.job_id=$2 ORDER BY o.created_at DESC LIMIT 1 FOR UPDATE OF o`,
      [wsId, jobId]);
    const off = r.rows[0];
    if (!off) throw rerr(REMOTE_ERRORS.E_REMOTE_NOT_OWNER, "no offer for job");
    if (off.assigned_worker_id !== workerId) throw rerr(REMOTE_ERRORS.E_REMOTE_NOT_OWNER, "attempt owned by another worker");
    if (requireLive && off.terminal_at) throw rerr(REMOTE_ERRORS.E_REMOTE_ATTEMPT_TERMINAL, "attempt already terminal");
    if (requireLive && off.lease_expires_at && Date.parse(off.lease_expires_at) <= now()) {
      throw rerr(REMOTE_ERRORS.E_REMOTE_LEASE_EXPIRED, "lease expired");
    }
    return off;
  }

  // ---------------------------------------------------------------- offers
  // Offers already claimed for THIS worker that it has not accepted yet. The claim (and therefore the
  // ownership decision) happened server-side in generation-control-plane.requestStart; this only
  // decides what to put on the wire.
  async function pendingOffers(wsId, workerId, { limit = 4 } = {}) {
    return tx(wsId, async (c) => {
      const rows = (await c.query(
        `SELECT o.id, o.job_id, o.generation_attempt_id, o.offer_expires_at, o.lease_expires_at,
                p.prompt, p.duration_seconds, p.aspect_ratio, p.provider_account_id, p.state
           FROM job_offers o JOIN generation_jobs p ON p.workspace_id=o.workspace_id AND p.id=o.job_id
          WHERE o.workspace_id=$1 AND o.assigned_worker_id=$2 AND o.ownership_status='OFFERED'
            AND o.accepted_at IS NULL AND o.terminal_at IS NULL
          ORDER BY o.created_at ASC LIMIT $3`, [wsId, workerId, Math.max(1, Math.min(limit, 8))])).rows;
      return rows.map((r) => ({
        offerId: r.id, jobId: r.job_id, attemptId: r.generation_attempt_id,
        prompt: r.prompt, durationSeconds: r.duration_seconds, aspectRatio: r.aspect_ratio,
        providerAccountHint: r.provider_account_id, offerExpiresAt: r.offer_expires_at, leaseExpiresAt: r.lease_expires_at
      }));
    });
  }

  // ---------------------------------------------------------------- ACCEPT
  // Mirrors generation-control-plane.claimNextForWorker exactly, but for a REMOTE worker id. Same
  // guards (OFFERED + accepted_at IS NULL under FOR UPDATE), same state transitions, plus the durable
  // execution provenance so the cert can prove WHICH machine ran the attempt.
  async function accept(wsId, { workerId, jobId, commandId, sequence = 0, executionHost = null }) {
    return tx(wsId, async (c) => {
      // Lock the offer FIRST so the attempt id is known before the ledger row is written: the ledger is
      // append-only (INSERT grant only, by design — an idempotency record that can be rewritten is not one),
      // so the attempt id has to be correct at insert time, not patched in afterwards.
      const off = (await c.query(
        `SELECT id, job_id, generation_attempt_id, lease_expires_at FROM job_offers
          WHERE workspace_id=$1 AND job_id=$2 AND assigned_worker_id=$3 AND ownership_status='OFFERED' AND accepted_at IS NULL
          FOR UPDATE`, [wsId, jobId, workerId])).rows[0];
      if (!off) {
        // No acceptable offer. If THIS exact command was already applied, the worker is replaying after a
        // reconnect and deserves an idempotent yes; otherwise it genuinely is not the owner.
        const prior = (await c.query(
          "SELECT 1 FROM remote_delivery_commands WHERE workspace_id=$1 AND worker_id=$2 AND command_id=$3", [wsId, workerId, commandId])).rows[0];
        if (prior) return { ok: true, duplicate: true };
        throw rerr(REMOTE_ERRORS.E_REMOTE_NOT_OWNER, "no acceptable offer for this worker");
      }
      const rec = await recordCommandCore(c, wsId, { workerId, jobId, attemptId: off.generation_attempt_id, commandId, kind: "ACCEPT", sequence });
      if (rec.duplicate) return { ok: true, duplicate: true };
      const leaseExpiresAt = new Date(now() + LEASE_TTL_MS).toISOString();
      await c.query("UPDATE job_offers SET ownership_status='ACCEPTED', accepted_at=now(), lease_expires_at=$3, last_worker_event_at=now() WHERE workspace_id=$1 AND id=$2",
        [wsId, off.id, leaseExpiresAt]);
      await c.query("UPDATE generation_attempts SET ownership_status='ACCEPTED', assigned_worker_id=$3 WHERE workspace_id=$1 AND id=$2",
        [wsId, off.generation_attempt_id, workerId]);
      await c.query("UPDATE jobs SET status='ACCEPTED', worker_id=$3, accepted_at=now() WHERE workspace_id=$1 AND id=$2", [wsId, off.job_id, workerId]);
      const p = (await c.query("SELECT state, prompt, duration_seconds, aspect_ratio, provider_account_id FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [wsId, jobId])).rows[0];
      if (p && p.state === S.QUEUED) await proj.transition(c, wsId, jobId, { from: S.QUEUED, to: S.PREPARING });
      await c.query(
        "UPDATE generation_jobs SET executed_by_worker_id=$3, delivery_mode='REMOTE', execution_host=$4 WHERE workspace_id=$1 AND id=$2",
        [wsId, jobId, workerId, safeHost(executionHost)]);
      await proj.appendEvent(c, wsId, jobId, { type: "JOB_ACCEPTED_REMOTE", detail: { workerId, executionHost: safeHost(executionHost) } });
      return {
        ok: true, duplicate: false, jobId, attemptId: off.generation_attempt_id, leaseExpiresAt,
        prompt: p?.prompt ?? "", durationSeconds: p?.duration_seconds ?? 6, aspectRatio: p?.aspect_ratio ?? "9:16",
        providerAccountHint: p?.provider_account_id ?? null
      };
    });
  }

  // ---------------------------------------------------------------- lease renew / progress
  async function renewLease(wsId, { workerId, jobId }) {
    return tx(wsId, async (c) => {
      const r = await c.query(
        `UPDATE job_offers SET lease_expires_at=$4, last_worker_event_at=now()
          WHERE workspace_id=$1 AND job_id=$2 AND assigned_worker_id=$3
            AND ownership_status IN ('ACCEPTED','RUNNING','SUBMITTING') AND terminal_at IS NULL
          RETURNING lease_expires_at`,
        [wsId, jobId, workerId, new Date(now() + LEASE_TTL_MS).toISOString()]);
      if (r.rowCount !== 1) throw rerr(REMOTE_ERRORS.E_REMOTE_NOT_OWNER, "not the current owner");
      return { leaseExpiresAt: r.rows[0].lease_expires_at };
    });
  }

  async function progress(wsId, { workerId, jobId, commandId, sequence = 0, stage = null }) {
    return tx(wsId, async (c) => {
      const off = await requireOwnershipCore(c, wsId, { workerId, jobId });
      const last = await maxSequenceCore(c, wsId, off.generation_attempt_id);
      if (sequence < last) throw rerr(REMOTE_ERRORS.E_REMOTE_STALE_SEQUENCE, "stale sequence");
      const rec = await recordCommandCore(c, wsId, { workerId, jobId, attemptId: off.generation_attempt_id, commandId, kind: "PROGRESS", sequence });
      if (rec.duplicate) return { ok: true, duplicate: true };
      const safeStage = typeof stage === "string" && /^[A-Z_]{3,40}$/.test(stage) ? stage : "PROGRESS";
      // GATE_PASSED is the certified pre-submit gate: the projection advances PREPARING -> READY_TO_SUBMIT.
      if (safeStage === "GATE_PASSED" && off.proj_state === S.PREPARING) {
        await proj.transition(c, wsId, jobId, { from: S.PREPARING, to: S.READY_TO_SUBMIT });
      }
      await c.query("UPDATE job_offers SET ownership_status='RUNNING', last_worker_event_at=now() WHERE workspace_id=$1 AND id=$2 AND ownership_status='ACCEPTED'", [wsId, off.id]);
      await proj.appendEvent(c, wsId, jobId, { type: safeStage, detail: { remote: true } });
      return { ok: true, duplicate: false };
    });
  }

  // ---------------------------------------------------------------- submission facts
  // SUBMIT_ATTEMPTED is the durable "the provider may have been touched" marker and MUST be recorded
  // BEFORE the worker performs the single click. From this instant the attempt is never auto-retried.
  async function submitAttempted(wsId, { workerId, jobId, commandId, sequence = 0 }) {
    const tenant = requireTenant(wsId);
    return tx(wsId, async (c) => {
      const off = await requireOwnershipCore(c, wsId, { workerId, jobId });
      const rec = await recordCommandCore(c, wsId, { workerId, jobId, attemptId: off.generation_attempt_id, commandId, kind: "SUBMIT_ATTEMPTED", sequence });
      if (rec.duplicate) return { ok: true, duplicate: true };
      await c.query(
        `UPDATE job_offers SET ownership_status='SUBMITTING', possibly_submitted=true, last_worker_event_at=now()
          WHERE workspace_id=$1 AND id=$2 AND ownership_status IN ('ACCEPTED','RUNNING')`, [wsId, off.id]);
      await c.query("UPDATE generation_attempts SET possibly_submitted=true WHERE workspace_id=$1 AND id=$2", [wsId, off.generation_attempt_id]);
      await proj.appendEvent(c, wsId, jobId, { type: "SUBMIT_ATTEMPTED_REMOTE", detail: { remote: true } });
      return { ok: true, duplicate: false, attemptId: off.generation_attempt_id };
    }).then(async (out) => {
      // The certified submission fact (ordinal=1 + invocation ledger + projection SUBMITTED) is applied
      // through the SAME control-plane method the local worker uses — one code path, one guarantee.
      if (!out.duplicate) {
        await tenant.controlPlane.markSubmitted({ jobId, attemptId: out.attemptId, workerId }).catch((e) => {
          log("warn", "REMOTE_MARK_SUBMITTED_FAILED", { jobId, code: e?.code || null });
        });
      }
      return out;
    });
  }

  async function submitted(wsId, { workerId, jobId, commandId, sequence = 0, providerSubmissionId = null }) {
    return tx(wsId, async (c) => {
      const off = await requireOwnershipCore(c, wsId, { workerId, jobId });
      const rec = await recordCommandCore(c, wsId, { workerId, jobId, attemptId: off.generation_attempt_id, commandId, kind: "SUBMITTED", sequence });
      if (rec.duplicate) return { ok: true, duplicate: true };
      // provider_submission_id is IMMUTABLE once set: a reconnecting worker cannot rewrite the identity
      // of a submission that is already on record.
      if (typeof providerSubmissionId === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(providerSubmissionId)) {
        await c.query(
          "UPDATE generation_attempts SET provider_submission_id=COALESCE(provider_submission_id, $3) WHERE workspace_id=$1 AND id=$2",
          [wsId, off.generation_attempt_id, providerSubmissionId]);
      }
      await proj.appendEvent(c, wsId, jobId, { type: "SUBMITTED_REMOTE", detail: { hasProviderSubmissionId: Boolean(providerSubmissionId) } });
      return { ok: true, duplicate: false };
    });
  }

  // ---------------------------------------------------------------- artifact upload session
  // The worker asks for permission to upload the result of a job it owns. The grant is bound to
  // (workspace, worker, job, attempt) and carries the expected hash + size; the token is returned once.
  async function grantUpload(wsId, { workerId, jobId, sha256, sizeBytes, mime = "video/mp4" }) {
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID, "sha256 required");
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 2 * 1024 * 1024 * 1024) throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID, "size invalid");
    if (mime !== "video/mp4") throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID, "unsupported mime");
    const token = randomBytes(32).toString("base64url");
    return tx(wsId, async (c) => {
      const off = await requireOwnershipCore(c, wsId, { workerId, jobId });
      // Supersede any earlier live session for this attempt so exactly one writer exists.
      await c.query("UPDATE worker_upload_sessions SET status='ABORTED', failure_code=$3 WHERE workspace_id=$1 AND generation_attempt_id=$2 AND status='PENDING'",
        [wsId, off.generation_attempt_id, REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID]);
      const id = newId("wup");
      const relativePath = `jobs/${jobId}/generated.mp4`;
      await c.query(
        `INSERT INTO worker_upload_sessions (id, workspace_id, worker_id, job_id, generation_attempt_id, token_digest,
            expected_sha256, expected_bytes, expected_mime, relative_path, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, wsId, workerId, jobId, off.generation_attempt_id, digestOf(token), sha256, sizeBytes, mime, relativePath, new Date(now() + UPLOAD_TTL_MS).toISOString()]);
      return { uploadId: id, token, expiresAt: new Date(now() + UPLOAD_TTL_MS).toISOString(), relativePath, sha256, sizeBytes };
    });
  }

  // Resolve an upload token to its session. Used by the HTTP upload endpoint; the token NEVER appears
  // in a log, and an unknown/expired/finalized token is refused without saying which.
  async function resolveUploadToken(wsId, workerId, token) {
    return tx(wsId, async (c) => {
      const r = await c.query(
        "SELECT * FROM worker_upload_sessions WHERE workspace_id=$1 AND token_digest=$2 FOR UPDATE", [wsId, digestOf(String(token || ""))]);
      const s = r.rows[0];
      if (!s) throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN, "no such upload session");
      if (s.worker_id !== workerId) throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN, "upload session belongs to another worker");
      if (s.status !== "PENDING") throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN, "upload session not open");
      if (Date.parse(s.expires_at) <= now()) {
        await c.query("UPDATE worker_upload_sessions SET status='EXPIRED' WHERE id=$1 AND workspace_id=$2", [s.id, wsId]);
        throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_EXPIRED, "upload session expired");
      }
      return {
        uploadId: s.id, jobId: s.job_id, attemptId: s.generation_attempt_id, workerId: s.worker_id,
        expectedSha256: s.expected_sha256, expectedBytes: Number(s.expected_bytes), expectedMime: s.expected_mime,
        relativePath: s.relative_path
      };
    });
  }

  // Atomic finalize: the caller has already written the bytes to a temp file and measured them.
  // A mismatch marks the session failed (the caller discards the partial file) and NOTHING is recorded
  // against the job — a corrupt upload can never become a result.
  // Commit-then-signal: a size/hash mismatch must be RECORDED (the session is closed failed) and only then
  // reported. Throwing inside the transaction would roll the verdict back, leaving the session PENDING — and a
  // corrupt upload that can be retried into acceptance is exactly the failure this table exists to prevent.
  async function finalizeUpload(wsId, { uploadId, actualSha256, actualBytes }) {
    const out = await tx(wsId, async (c) => {
      const s = (await c.query("SELECT * FROM worker_upload_sessions WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [wsId, uploadId])).rows[0];
      if (!s) throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN, "no such upload session");
      if (s.status === "FINALIZED") {
        // Idempotent finalize: the same session finalized twice returns the same answer, no second effect.
        return { ok: true, idempotent: true, relativePath: s.relative_path, sha256: s.actual_sha256, sizeBytes: Number(s.received_bytes) };
      }
      if (s.status !== "PENDING") throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN, "upload session not open");
      if (Number(actualBytes) !== Number(s.expected_bytes)) {
        await c.query("UPDATE worker_upload_sessions SET status='ABORTED', received_bytes=$3, failure_code=$4 WHERE workspace_id=$1 AND id=$2",
          [wsId, uploadId, Number(actualBytes) || 0, REMOTE_ERRORS.E_REMOTE_UPLOAD_SIZE_MISMATCH]);
        return { __reject: REMOTE_ERRORS.E_REMOTE_UPLOAD_SIZE_MISMATCH };
      }
      if (String(actualSha256) !== s.expected_sha256) {
        await c.query("UPDATE worker_upload_sessions SET status='ABORTED', received_bytes=$3, actual_sha256=$4, failure_code=$5 WHERE workspace_id=$1 AND id=$2",
          [wsId, uploadId, Number(actualBytes) || 0, String(actualSha256).slice(0, 64), REMOTE_ERRORS.E_REMOTE_UPLOAD_HASH_MISMATCH]);
        return { __reject: REMOTE_ERRORS.E_REMOTE_UPLOAD_HASH_MISMATCH };
      }
      await c.query(
        "UPDATE worker_upload_sessions SET status='FINALIZED', received_bytes=$3, actual_sha256=$4, finalized_at=now() WHERE workspace_id=$1 AND id=$2",
        [wsId, uploadId, Number(actualBytes), String(actualSha256)]);
      return { ok: true, idempotent: false, relativePath: s.relative_path, jobId: s.job_id, sha256: String(actualSha256), sizeBytes: Number(actualBytes) };
    });
    if (out && out.__reject) throw rerr(out.__reject, "upload verification failed");
    return out;
  }

  // ---------------------------------------------------------------- terminal reports
  // COMPLETE: the artifact must already be FINALIZED for this attempt — a worker cannot declare a
  // result that no verified bytes back.
  async function complete(wsId, { workerId, jobId, commandId, sequence = 0, resultId = null, media = null }) {
    const tenant = requireTenant(wsId);
    const pre = await tx(wsId, async (c) => {
      const off = await requireOwnershipCore(c, wsId, { workerId, jobId, requireLive: false });
      const rec = await recordCommandCore(c, wsId, { workerId, jobId, attemptId: off.generation_attempt_id, commandId, kind: "COMPLETE", sequence });
      if (rec.duplicate) return { duplicate: true };
      const up = (await c.query(
        "SELECT relative_path, actual_sha256, received_bytes FROM worker_upload_sessions WHERE workspace_id=$1 AND generation_attempt_id=$2 AND status='FINALIZED' ORDER BY finalized_at DESC LIMIT 1",
        [wsId, off.generation_attempt_id])).rows[0];
      if (!up) throw rerr(REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID, "no finalized artifact for this attempt");
      return { duplicate: false, attemptId: off.generation_attempt_id, relativePath: up.relative_path, checksum: up.actual_sha256, sizeBytes: Number(up.received_bytes) };
    });
    if (pre.duplicate) return { ok: true, duplicate: true };
    const m = media && typeof media === "object" ? media : {};
    await tenant.controlPlane.complete({
      jobId, workerId,
      resultId: typeof resultId === "string" && resultId.length <= 200 ? resultId : null,
      resultAsset: typeof resultId === "string" && resultId.length <= 200 ? { resultId } : null,
      mediaMeta: {
        relativePath: pre.relativePath, sizeBytes: pre.sizeBytes, container: "mp4",
        checksum: `sha256:${pre.checksum}`,
        durationSeconds: Number.isFinite(m.durationSeconds) ? m.durationSeconds : null,
        width: Number.isInteger(m.width) ? m.width : null,
        height: Number.isInteger(m.height) ? m.height : null
      }
    });
    // A dispatch that reached the provider resets the lane interval to base (same pacing model as local).
    await tenant.controlPlane.noteSubmitOutcome({ slot: laneForWorker(workerId), outcome: "SUBMITTED" }).catch(() => {});
    return { ok: true, duplicate: false };
  }

  // FAIL: the worker reports a terminal outcome. The hub — not the worker — decides which terminal it
  // is, from the DURABLE possibly-submitted evidence. A worker can never talk a possibly-submitted
  // attempt back into a retryable failure.
  async function fail(wsId, { workerId, jobId, commandId, sequence = 0, code = null, possiblySubmitted = false }) {
    const tenant = requireTenant(wsId);
    const pre = await tx(wsId, async (c) => {
      const off = await requireOwnershipCore(c, wsId, { workerId, jobId, requireLive: false });
      const rec = await recordCommandCore(c, wsId, { workerId, jobId, attemptId: off.generation_attempt_id, commandId, kind: "FAIL", sequence });
      if (rec.duplicate) return { duplicate: true };
      const a = (await c.query("SELECT possibly_submitted, submission_state FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [wsId, off.generation_attempt_id])).rows[0];
      const p = (await c.query("SELECT state, invocation_state FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [wsId, jobId])).rows[0];
      const durablySubmitted = Boolean(a?.possibly_submitted) || (a?.submission_state && a.submission_state !== "NOT_SUBMITTED")
        || p?.invocation_state === "CONSUMED" || isPostSubmit(p?.state);
      return { duplicate: false, attemptId: off.generation_attempt_id, durablySubmitted, terminal: isTerminal(p?.state) };
    });
    if (pre.duplicate) return { ok: true, duplicate: true };
    if (pre.terminal) return { ok: true, idempotent: true };
    const safe = sanitizeCode(code, "E_GENERATION_FAILED_PRE_SUBMIT");
    if (pre.durablySubmitted || possiblySubmitted === true) {
      await tenant.controlPlane.submitUncertain({ jobId, workerId, reason: "Remote run failed after submit; not retried" });
      return { ok: true, terminal: "SUBMIT_UNCERTAIN" };
    }
    // Provably pre-submit: pacing signals are re-deferred (still QUEUED), everything else is terminal.
    const deferred = await tenant.controlPlane.deferForCooldownIfPacing?.({ jobId, code: safe, slot: laneForWorker(workerId) }).catch(() => null);
    if (deferred && deferred.deferred) {
      await releaseCore(wsId, { workerId, jobId });
      return { ok: true, deferred: true, nextEligibleAt: deferred.nextEligibleAt };
    }
    await tenant.controlPlane.failPreSubmit({ jobId, workerId, code: safe, reason: "Remote generation failed before submit" });
    return { ok: true, terminal: "FAILED_PRE_SUBMIT" };
  }

  // RELEASE: hand the attempt back WITHOUT a verdict (pre-submit only). Used when a worker drains or
  // shuts down cleanly before touching the provider — the job returns to QUEUED and may be re-offered.
  async function releaseCore(wsId, { workerId, jobId }) {
    return tx(wsId, async (c) => {
      const off = (await c.query(
        `SELECT o.id, o.generation_attempt_id, p.state, a.possibly_submitted, p.invocation_state
           FROM job_offers o JOIN generation_jobs p ON p.workspace_id=o.workspace_id AND p.id=o.job_id
           LEFT JOIN generation_attempts a ON a.workspace_id=o.workspace_id AND a.id=o.generation_attempt_id
          WHERE o.workspace_id=$1 AND o.job_id=$2 AND o.assigned_worker_id=$3 AND o.terminal_at IS NULL
          ORDER BY o.created_at DESC LIMIT 1 FOR UPDATE OF o`, [wsId, jobId, workerId])).rows[0];
      if (!off) return { released: false, reason: "NOT_OWNER" };
      // A possibly-submitted attempt is NEVER released back into the queue — that would risk a second
      // provider submission. It stays owned until it is settled (or reaches SUBMIT_UNCERTAIN).
      if (off.possibly_submitted === true || off.invocation_state === "CONSUMED" || isPostSubmit(off.state)) {
        return { released: false, reason: "POSSIBLY_SUBMITTED" };
      }
      // Return the attempt to the unowned state the pipeline already uses for a safely-expired offer
      // (expireOfferCore/safeReoffer set exactly this), so a released attempt is re-offerable by the normal
      // path instead of sitting in a state only this module understands.
      await c.query("UPDATE job_offers SET ownership_status='EXPIRED_PRE_SUBMIT', terminal_at=now() WHERE workspace_id=$1 AND id=$2", [wsId, off.id]);
      await c.query("UPDATE generation_attempts SET ownership_status='CREATED', assigned_worker_id=NULL WHERE workspace_id=$1 AND id=$2", [wsId, off.generation_attempt_id]);
      await c.query("UPDATE jobs SET status='QUEUED', worker_id=NULL WHERE workspace_id=$1 AND id=$2", [wsId, jobId]);
      if (off.state === S.PREPARING || off.state === S.READY_TO_SUBMIT) {
        await proj.transition(c, wsId, jobId, { from: off.state, to: S.QUEUED });
      }
      await proj.appendEvent(c, wsId, jobId, { type: "JOB_RELEASED_REMOTE", detail: { workerId } });
      return { released: true };
    });
  }

  async function release(wsId, { workerId, jobId, commandId, sequence = 0 }) {
    const rec = await tx(wsId, (c) => recordCommandCore(c, wsId, { workerId, jobId, commandId, kind: "RELEASE", sequence }));
    if (rec.duplicate) return { ok: true, duplicate: true };
    return { ok: true, ...(await releaseCore(wsId, { workerId, jobId })) };
  }

  // A worker that disconnects while owning a PRE-SUBMIT attempt gives it back immediately (no waiting
  // for the lease to expire) — the job simply returns to the queue and nothing was consumed. A
  // possibly-submitted attempt is deliberately left owned and untouched.
  async function releaseOnDisconnect(wsId, workerId) {
    const jobs = await tx(wsId, async (c) => (await c.query(
      `SELECT job_id FROM job_offers WHERE workspace_id=$1 AND assigned_worker_id=$2 AND terminal_at IS NULL
         AND ownership_status IN ('OFFERED','ACCEPTED','RUNNING')`, [wsId, workerId])).rows.map((r) => r.job_id));
    const out = [];
    for (const jobId of jobs) {
      try { const r = await releaseCore(wsId, { workerId, jobId }); out.push({ jobId, ...r }); } catch { /* best-effort */ }
    }
    await registry.setCurrentWork(wsId, workerId, {}).catch(() => {});
    return out;
  }

  function laneForWorker(workerId) {
    // A remote worker is its own physical submission lane: pacing/cooldown must be per MACHINE, not
    // shared with the Studio host's own Grok account.
    return { provider: "GROK", accountRef: `worker:${workerId}`, profileRef: "-" };
  }

  function requireTenant(wsId) {
    const t = resolveTenant(wsId);
    if (!t || !t.controlPlane) throw rerr(REMOTE_ERRORS.E_REMOTE_TENANT_MISMATCH, "workspace has no control plane");
    return t;
  }

  return Object.freeze({
    pendingOffers, accept, renewLease, progress, submitAttempted, submitted,
    grantUpload, resolveUploadToken, finalizeUpload,
    complete, fail, release, releaseCore, releaseOnDisconnect, laneForWorker,
    DELIVERY_PROTOCOL_VERSION,
    // exported for tests: the durable ledger primitives
    _recordCommandCore: recordCommandCore, _maxSequenceCore: maxSequenceCore, _requireOwnershipCore: requireOwnershipCore
  });
}

export const REMOTE_COMMAND_KINDS = Object.freeze({
  [W2S.ACCEPT]: "ACCEPT", [W2S.REJECT]: "REJECT", [W2S.PROGRESS]: "PROGRESS",
  [W2S.SUBMIT_ATTEMPTED]: "SUBMIT_ATTEMPTED", [W2S.SUBMITTED]: "SUBMITTED",
  [W2S.RESULT_READY]: "RESULT_READY", [W2S.ARTIFACT_UPLOADED]: "ARTIFACT_UPLOADED",
  [W2S.COMPLETE]: "COMPLETE", [W2S.FAIL]: "FAIL", [W2S.RELEASE]: "RELEASE", [W2S.DRAIN_ACK]: "DRAIN_ACK"
});
