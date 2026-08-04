// P0 Step 5C.9E — generation_jobs EXTENSION repository (control-plane persistence).
//
// ARCHITECTURE: generation_jobs / generation_job_events / generation_media_capabilities
// (migrations 0016 + 0017) are a strict 1:1 EXTENSION of the frozen ownership pipeline
// (generation_requests → generation_attempts → jobs → job_offers). This repository owns ONLY
// Grok-specific lifecycle granularity, the selected account, invocation/submit correlation,
// result/media metadata, the redacted event log, and short-lived media capabilities. It does
// NOT schedule, claim, or lease — request/attempt/dispatch/Worker-lease remain the sole
// responsibility of ownership.mjs (createGenerationRequestCore / claimGenerationAttemptForWorkerCore
// / job_offers). Every method takes an already-open tenant transaction client (RLS-scoped) and
// returns normalized records; no absolute paths / provider URLs / secrets / raw prompt leak out
// of the redacted projections.
//
// The fine-grained state machine (states + allowed transitions + terminal/post-submit sets) is
// imported from the shared lib/protocol module so there is exactly ONE source of truth for it
// across the JSON path (5C.9D store, still live) and this durable path (5C.9E) — guaranteeing an
// identical lifecycle through the cutover. It lives under lib/protocol/ (not lib/worker/) so the
// control-plane dependency boundary (boundary.mjs) permits the import.

import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";
import { normalizeMediaEvidence } from "../../../../lib/media/media-evidence-schema.mjs";
import {
  GENERATION_JOB_STATES as S,
  TERMINAL_JOB_STATES,
  canTransition,
  isTerminal
} from "../../../../lib/protocol/generation-job-states.mjs";

const one = (r) => (r.rows[0] ?? null);
function requireClient(client) {
  if (!client || typeof client.query !== "function") {
    throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "repository requires a transaction client");
  }
}
function bad(message) { return domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, message); }

const JOB_ID_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/u;
const ATTEMPT_ID_RE = /^attempt_[0-9A-HJKMNP-TV-Z]{26}$/u;
function assertJobId(id) { if (typeof id !== "string" || !JOB_ID_RE.test(id)) throw bad("invalid job id"); }

// A reference is safe only when it is a bounded relative path fragment — never an absolute
// Windows/POSIX path, never a URL, never a parent-directory escape.
function isUnsafeRef(v) {
  return typeof v === "string" && (/^[A-Za-z]:[\\/]/.test(v) || /^[\\/]/.test(v) || /:\/\//.test(v) || v.includes(".."));
}
function assertRelative(ref, field) {
  if (typeof ref !== "string" || isUnsafeRef(ref)) throw bad(`${field} must be a safe relative reference`);
}

// Event details are a REDACTED safe knob bag: only small JSON scalars, and no string value may
// look like an absolute path, a URL, a parent escape, or a secret-bearing key. This is the last
// line of defence before an event is persisted + later surfaced in the UI timeline.
const SECRET_KEY_RE = /(token|cookie|secret|password|authorization|proxy|credential|bearer|apikey|api_key|signed)/i;
// P0 Step 5C.54 — bounded NESTING, with every rule above applied at every level.
//
// Scalars-only was silently throwing away the entire evidence programme. `PRE_SUBMIT_FAULT` is flat and has
// 7 rows; SUBMISSION_FACTS (5C.49), IMAGINE_SUBMISSION_DIAGNOSTIC (5C.49), PROVIDER_MESSAGE_AT_SUBMIT (5C.48)
// and PROVIDER_NETWORK_PATH (5C.49) all carry a nested object or an array, and across 81 jobs not one of them
// was ever written — every call site swallows the throw with `.catch(() => {})`. Three milestones of work
// that reported success and stored nothing.
//
// The redaction is not relaxed: the secret-key check, the path/URL check and the string bound apply to every
// key and value at every depth. Only the shape restriction is lifted, and only within hard limits, so an
// event still cannot become a channel for a blob.
// Sized from the payloads that actually exist. The deepest is the submission diagnostic's
// postSubmit.samples[i].state.<field> — five levels — and its sample and response lists are sliced upstream.
// The byte cap is the honest bound on what an event can cost; the depth/key/item limits only stop a
// pathological shape from getting there.
const EVENT_DETAIL_MAX_DEPTH = 6;
const EVENT_DETAIL_MAX_KEYS = 24;
const EVENT_DETAIL_MAX_ITEMS = 64;
const EVENT_DETAIL_MAX_NODES = 1200;
const EVENT_DETAIL_MAX_BYTES = 32 * 1024;

export function assertSafeEventDetail(detail) {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== "object" || Array.isArray(detail)) throw bad("event detail must be a plain object");
  const budget = { nodes: 0 };
  const safe = sanitizeEventNode(detail, "detail", 0, budget);
  // Cheap last check, on the thing that is actually stored.
  if (JSON.stringify(safe).length > EVENT_DETAIL_MAX_BYTES) throw bad("event detail is too large");
  return safe;
}

function sanitizeEventNode(value, path, depth, budget) {
  if (++budget.nodes > EVENT_DETAIL_MAX_NODES) throw bad("event detail is too large");
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "number") return Number.isFinite(value) ? value : null;   // NaN/Infinity are not valid JSON
  if (t === "boolean") return value;
  if (t === "string") {
    if (value.length > 256) throw bad(`event detail '${path}' string too long`);
    if (isUnsafeRef(value)) throw bad(`event detail '${path}' looks like a path or URL`);
    return value;
  }
  if (t !== "object") throw bad(`event detail '${path}' must be a scalar, object or array`);
  if (depth >= EVENT_DETAIL_MAX_DEPTH) throw bad(`event detail '${path}' is nested too deeply`);
  if (Array.isArray(value)) {
    if (value.length > EVENT_DETAIL_MAX_ITEMS) throw bad(`event detail '${path}' has too many items`);
    return value.map((v, i) => sanitizeEventNode(v, `${path}[${i}]`, depth + 1, budget));
  }
  const keys = Object.keys(value);
  if (keys.length > EVENT_DETAIL_MAX_KEYS) throw bad(`event detail '${path}' has too many keys`);
  const safe = {};
  for (const k of keys) {
    if (SECRET_KEY_RE.test(k)) throw bad(`event detail key '${k}' is not allowed`);
    safe[k] = sanitizeEventNode(value[k], `${path}.${k}`, depth + 1, budget);
  }
  return safe;
}

// ---- row mapping ---------------------------------------------------------------------------
// pg returns JSONB columns already parsed; guard anyway so a text driver cannot smuggle a string.
function asObj(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v;
  try { const p = JSON.parse(v); return (p && typeof p === "object") ? p : null; } catch { return null; }
}
export function mapExtensionRow(row) {
  if (!row) return null;
  return Object.freeze({
    jobId: row.id,
    workspaceId: row.workspace_id,
    generationAttemptId: row.generation_attempt_id ?? null,
    provider: row.provider,
    providerAccountId: row.provider_account_id ?? null,
    accountSelection: row.account_selection,
    affinity: asObj(row.affinity),
    prompt: row.prompt,
    promptHash: row.prompt_hash,
    mode: row.mode,
    durationSeconds: row.duration_seconds,
    aspectRatio: row.aspect_ratio,
    invocationScope: row.invocation_scope,
    state: row.state,
    invocationState: row.invocation_state ?? null,
    submitAttemptedAt: row.submit_attempted_at ?? null,
    // P0 Step 5C.30 — provider pacing metadata (additive; a deferred job is QUEUED with an ETA, not a failure).
    startIntentAt: row.start_intent_at ?? null,
    nextEligibleAt: row.next_eligible_at ?? null,
    cooldownReason: row.cooldown_reason ?? null,
    cooldownAttemptCount: row.cooldown_attempt_count ?? 0,
    providerSlotRef: row.provider_slot_ref ?? null,
    resultId: row.result_id ?? null,
    resultAsset: asObj(row.result_asset),
    mediaMeta: asObj(row.media_meta),
    manualAction: row.manual_action ?? null,
    errorCode: row.error_code ?? null,
    errorReason: row.error_reason ?? null,
    source: row.source,
    isCertificationEvidence: row.is_certification_evidence === true,
    createCommandId: row.create_command_id ?? null,
    startCommandId: row.start_command_id ?? null,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null
  });
}

// UI projection: redacts the raw prompt to a bounded preview (never the full text, never the
// hash-as-text-leak), and exposes only safe media descriptors. `startRequested` is derived from
// the OWNERSHIP pipeline (the extension no longer stores dispatch state after 0017); the caller
// passes it from the pipeline job/offer view. `media` is the safe descriptor when local media
// exists.
export function projectExtensionRowForUi(rowOrMapped, { media = null, startRequested = false } = {}) {
  const j = rowOrMapped && rowOrMapped.jobId ? rowOrMapped : mapExtensionRow(rowOrMapped);
  if (!j) return null;
  const m = media || j.mediaMeta;
  return Object.freeze({
    jobId: j.jobId,
    provider: j.provider,
    providerAccountId: j.providerAccountId,
    accountSelection: j.accountSelection,
    mode: j.mode,
    durationSeconds: j.durationSeconds,
    aspectRatio: j.aspectRatio,
    state: j.state,
    startRequested: startRequested === true,
    promptHash: j.promptHash,
    promptPreview: typeof j.prompt === "string" ? j.prompt.slice(0, 140) : "",
    generationAttemptId: j.generationAttemptId,
    invocationState: j.invocationState,
    resultId: j.resultAsset?.resultId || j.resultId || null,
    submitAttemptedAt: j.submitAttemptedAt,
    manualAction: j.manualAction || null,
    errorCode: j.errorCode || null,
    hasMedia: Boolean(m && m.sizeBytes > 0),
    // P0 Step 5C.43 - the evidence travels to the API too. This projection exposed five numbers, so every
    // reader above it - the movie pipeline, the scene refresh, the UI - could only ever see the size of the
    // file and never what was asked for, what was selected, or what the bytes actually measure.
    media: m ? Object.freeze({
      sizeBytes: m.sizeBytes, container: m.container || "mp4",
      durationSeconds: m.durationSeconds ?? null, width: m.width ?? null, height: m.height ?? null,
      checksum: m.checksum ?? null,
      decodedFromFile: m.decodedFromFile === true,
      requestedResolution: m.requestedResolution ?? null, selectedResolution: m.selectedResolution ?? null,
      selectedResolutionEvidence: m.selectedResolutionEvidence ?? null,
      requestedAspectRatio: m.requestedAspectRatio ?? null, selectedAspectRatio: m.selectedAspectRatio ?? null,
      requestedDurationSeconds: m.requestedDurationSeconds ?? null, selectedDurationSeconds: m.selectedDurationSeconds ?? null,
      selectedDurationEvidence: m.selectedDurationEvidence ?? null,
      actualDecodedWidth: m.actualDecodedWidth ?? null, actualDecodedHeight: m.actualDecodedHeight ?? null,
      actualDecodedDurationSeconds: m.actualDecodedDurationSeconds ?? null,
      actualAspectRatio: m.actualAspectRatio ?? null, actualResolutionTier: m.actualResolutionTier ?? null,
      resolutionVerdict: m.resolutionVerdict ?? null, durationVerdict: m.durationVerdict ?? null,
      durationDeltaSeconds: m.durationDeltaSeconds ?? null, sourceVerdict: m.sourceVerdict ?? null,
      providerFallbackSuspected: m.providerFallbackSuspected === true,
      sourceFrameRate: m.sourceFrameRate ?? null, sourceHash: m.sourceHash ?? null,
      reportedByPage: m.reportedByPage ?? null
    }) : null,
    isCertificationEvidence: j.isCertificationEvidence === true,
    // P0 Step 5C.30 — pacing projection for the UI: a QUEUED job with a future nextEligibleAt is WAITING on the
    // provider lane, not failed and not stalled. waitingProviderCooldown drives the Activity/Movie label.
    nextEligibleAt: j.nextEligibleAt,
    cooldownReason: j.cooldownReason || null,
    cooldownAttemptCount: j.cooldownAttemptCount || 0,
    waitingProviderCooldown: Boolean(j.state === "QUEUED" && j.nextEligibleAt && new Date(j.nextEligibleAt).getTime() > Date.now()),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    completedAt: j.completedAt
  });
}

// P0 Step 5C.43 - the declared media schema, shared with the movie repository so a scene's evidence and a
// job's evidence cannot drift apart. An undeclared field is an ERROR here rather than a silent deletion, and
// that silent deletion is exactly how 5C.38's decode verdict and 5C.42's duration record failed to reach the
// database while every layer above believed they had.
function validateMediaMeta(mediaMeta) {
  return normalizeMediaEvidence(mediaMeta, { field: "mediaMeta" });
}

function validateResultAsset(resultAsset) {
  if (resultAsset === null || resultAsset === undefined) return null;
  if (typeof resultAsset !== "object" || Array.isArray(resultAsset)) throw bad("resultAsset must be an object");
  for (const [k, v] of Object.entries(resultAsset)) {
    if (SECRET_KEY_RE.test(k)) throw bad(`resultAsset key '${k}' not allowed`);
    if (isUnsafeRef(v)) throw bad(`resultAsset '${k}' looks like a path or URL`);
  }
  return resultAsset;
}
function validateAffinity(affinity) {
  if (affinity === null || affinity === undefined) return null;
  if (typeof affinity !== "object" || Array.isArray(affinity)) throw bad("affinity must be an object");
  for (const [k, v] of Object.entries(affinity)) {
    if (SECRET_KEY_RE.test(k)) throw bad(`affinity key '${k}' not allowed`);
    if (isUnsafeRef(v)) throw bad(`affinity '${k}' looks like a path or URL`);
  }
  return affinity;
}

export const generationProjectionRepository = {
  // Create the 1:1 extension row. jobId + (optional at creation) generationAttemptId come from a
  // control-plane createGeneration that already inserted the authoritative job/attempt; the FKs
  // (0017) guarantee this row can only exist for a real pipeline job.
  async insert(client, workspaceId, spec) {
    requireClient(client);
    assertJobId(spec.jobId);
    if (spec.generationAttemptId != null && !ATTEMPT_ID_RE.test(spec.generationAttemptId)) throw bad("invalid generationAttemptId");
    if (spec.provider !== undefined && spec.provider !== "GROK") throw bad("provider must be GROK");
    if (spec.mode !== undefined && spec.mode !== "VIDEO") throw bad("mode must be VIDEO");
    if (spec.accountSelection && !["AUTO", "EXPLICIT"].includes(spec.accountSelection)) throw bad("invalid accountSelection");
    if (spec.source && !["UI", "IMPORT"].includes(spec.source)) throw bad("invalid source");
    if (typeof spec.prompt !== "string" || spec.prompt.length === 0) throw bad("prompt required");
    if (typeof spec.promptHash !== "string") throw bad("promptHash required");
    const affinity = validateAffinity(spec.affinity ?? null);
    const row = one(await client.query(
      `INSERT INTO generation_jobs
        (workspace_id, id, generation_attempt_id, provider, provider_account_id, account_selection,
         affinity, prompt, prompt_hash, mode, duration_seconds, aspect_ratio, invocation_scope,
         state, source, is_certification_evidence, create_command_id)
       VALUES ($1,$2,$3,COALESCE($4,'GROK'),$5,COALESCE($6,'AUTO'),$7,$8,$9,COALESCE($10,'VIDEO'),
               COALESCE($11,6),COALESCE($12,'9:16'),COALESCE($13,'ATTEMPT'),$14,COALESCE($15,'UI'),
               COALESCE($16,false),$17)
       RETURNING *`,
      [workspaceId, spec.jobId, spec.generationAttemptId ?? null, spec.provider ?? null,
       spec.providerAccountId ?? null, spec.accountSelection ?? null,
       affinity ? JSON.stringify(affinity) : null, spec.prompt, spec.promptHash, spec.mode ?? null,
       spec.durationSeconds ?? null, spec.aspectRatio ?? null, spec.invocationScope ?? null,
       spec.state ?? S.QUEUED, spec.source ?? null, spec.isCertificationEvidence ?? false,
       spec.createCommandId ?? null]));
    return mapExtensionRow(row);
  },

  async get(client, workspaceId, jobId) {
    requireClient(client);
    return mapExtensionRow(one(await client.query(
      "SELECT * FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [workspaceId, jobId])));
  },

  async getByAttempt(client, workspaceId, attemptId) {
    requireClient(client);
    return mapExtensionRow(one(await client.query(
      "SELECT * FROM generation_jobs WHERE workspace_id=$1 AND generation_attempt_id=$2", [workspaceId, attemptId])));
  },

  // FIFO listing (created_at asc, id tie-break) with optional state / account filters. This is a
  // read projection for the UI + the Worker's own account scheduler — NOT a claim/lease query.
  async list(client, workspaceId, { limit = 100, offset = 0, states = null, providerAccountId = null } = {}) {
    requireClient(client);
    const params = [workspaceId];
    let where = "workspace_id=$1";
    if (Array.isArray(states) && states.length > 0) { params.push(states); where += ` AND state = ANY($${params.length})`; }
    if (providerAccountId) { params.push(providerAccountId); where += ` AND provider_account_id=$${params.length}`; }
    params.push(Math.min(Math.max(1, limit), 500)); const limIdx = params.length;
    params.push(Math.max(0, offset)); const offIdx = params.length;
    const rows = (await client.query(
      `SELECT * FROM generation_jobs WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT $${limIdx} OFFSET $${offIdx}`, params)).rows;
    return rows.map(mapExtensionRow);
  },

  // Bind the pipeline attempt to the extension exactly once (at gate). Optimistic on revision.
  async bindAttempt(client, workspaceId, jobId, { generationAttemptId, expectedRevision = null }) {
    requireClient(client);
    if (!ATTEMPT_ID_RE.test(generationAttemptId)) throw bad("invalid generationAttemptId");
    const params = [workspaceId, jobId, generationAttemptId];
    let guard = "generation_attempt_id IS NULL";
    if (expectedRevision != null) { params.push(expectedRevision); guard += ` AND revision=$${params.length}`; }
    const r = await client.query(
      `UPDATE generation_jobs SET generation_attempt_id=$3, revision=revision+1, updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND ${guard} RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapExtensionRow(r.rows[0]) : await this.get(client, workspaceId, jobId) };
  },

  // Validated fine-grained transition (optimistic on from-state + optional revision). Terminal
  // states set completed_at (the 0016 CHECK requires it). Never validates a re-submit path — the
  // ALLOWED map (single source of truth) already forbids leaving a post-submit/terminal state
  // toward anything re-submittable.
  async transition(client, workspaceId, jobId, { from, to, expectedRevision = null, patch = {} } = {}) {
    requireClient(client);
    if (!Object.values(S).includes(to)) throw bad(`unknown target state ${to}`);
    if (from && !canTransition(from, to)) throw bad(`illegal transition ${from} -> ${to}`);
    const params = [workspaceId, jobId, to];
    const sets = ["state=$3", "revision=revision+1", "updated_at=now()"];
    if (isTerminal(to)) sets.push("completed_at=now()");
    if (patch.manualAction !== undefined) { params.push(patch.manualAction); sets.push(`manual_action=$${params.length}`); }
    if (patch.errorCode !== undefined) { params.push(patch.errorCode); sets.push(`error_code=$${params.length}`); }
    if (patch.errorReason !== undefined) { params.push(patch.errorReason); sets.push(`error_reason=$${params.length}`); }
    let guard = "";
    if (from) { params.push(from); guard += ` AND state=$${params.length}`; }
    if (expectedRevision != null) { params.push(expectedRevision); guard += ` AND revision=$${params.length}`; }
    const r = await client.query(
      `UPDATE generation_jobs SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2${guard} RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapExtensionRow(r.rows[0]) : await this.get(client, workspaceId, jobId) };
  },

  // Record the invocation fact (RESERVED at gate → CONSUMED at submit) + submit timestamp. This
  // is correlation metadata only; the authoritative one-invocation fact lives in the C1 guard and
  // the pipeline's generation_attempts.submission_state (via applySubmissionFactCore).
  async recordInvocation(client, workspaceId, jobId, { invocationState = null, submitAttemptedAt = null, expectedRevision = null } = {}) {
    requireClient(client);
    if (invocationState != null && !["RESERVED", "CONSUMED"].includes(invocationState)) throw bad("invalid invocationState");
    const params = [workspaceId, jobId, invocationState, submitAttemptedAt];
    let guard = "";
    if (expectedRevision != null) { params.push(expectedRevision); guard = ` AND revision=$${params.length}`; }
    const r = await client.query(
      `UPDATE generation_jobs
         SET invocation_state=COALESCE($3, invocation_state),
             submit_attempted_at=COALESCE($4, submit_attempted_at),
             revision=revision+1, updated_at=now()
       WHERE workspace_id=$1 AND id=$2${guard} RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapExtensionRow(r.rows[0]) : await this.get(client, workspaceId, jobId) };
  },

  // Record the completed result + safe media descriptor (relative path only). Provider URLs /
  // absolute paths / secrets are rejected before persistence.
  async recordResult(client, workspaceId, jobId, { resultId = null, resultAsset = null, mediaMeta = null, expectedRevision = null } = {}) {
    requireClient(client);
    const asset = validateResultAsset(resultAsset);
    const media = validateMediaMeta(mediaMeta);
    const params = [workspaceId, jobId, resultId, asset ? JSON.stringify(asset) : null, media ? JSON.stringify(media) : null];
    let guard = "";
    if (expectedRevision != null) { params.push(expectedRevision); guard = ` AND revision=$${params.length}`; }
    const r = await client.query(
      `UPDATE generation_jobs
         SET result_id=COALESCE($3, result_id), result_asset=COALESCE($4, result_asset),
             media_meta=COALESCE($5, media_meta), revision=revision+1, updated_at=now()
       WHERE workspace_id=$1 AND id=$2${guard} RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapExtensionRow(r.rows[0]) : await this.get(client, workspaceId, jobId) };
  },

  // Append-only, per-job monotonic, REDACTED event. seq computed under the tenant txn.
  async appendEvent(client, workspaceId, jobId, { type, detail = null } = {}) {
    requireClient(client);
    if (typeof type !== "string" || type.length === 0 || type.length > 64) throw bad("event type invalid");
    const safe = assertSafeEventDetail(detail);
    const row = one(await client.query(
      `INSERT INTO generation_job_events (workspace_id, job_id, seq, type, detail)
       SELECT $1,$2, COALESCE(MAX(seq),0)+1, $3, $4
         FROM generation_job_events WHERE workspace_id=$1 AND job_id=$2
       RETURNING *`,
      [workspaceId, jobId, type, safe ? JSON.stringify(safe) : null]));
    return { seq: Number(row.seq), type: row.type, at: row.at, detail: asObj(row.detail) };
  },

  async listEvents(client, workspaceId, jobId, { limit = 200, offset = 0 } = {}) {
    requireClient(client);
    const rows = (await client.query(
      `SELECT seq, type, at, detail FROM generation_job_events
       WHERE workspace_id=$1 AND job_id=$2 ORDER BY seq ASC LIMIT $3 OFFSET $4`,
      [workspaceId, jobId, Math.min(Math.max(1, limit), 1000), Math.max(0, offset)])).rows;
    return rows.map((e) => ({ seq: Number(e.seq), type: e.type, at: e.at, detail: asObj(e.detail) }));
  },

  // ---- media capability (digest-only, job-bound, short TTL) --------------------------------
  async issueMediaCapability(client, workspaceId, { jobId, capabilityDigest, expiresAt }) {
    requireClient(client);
    assertJobId(jobId);
    if (typeof capabilityDigest !== "string" || !/^[0-9a-f]{64}$/.test(capabilityDigest)) throw bad("capabilityDigest must be a sha256 hex digest");
    const row = one(await client.query(
      `INSERT INTO generation_media_capabilities (workspace_id, capability_digest, job_id, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING *`, [workspaceId, capabilityDigest, jobId, expiresAt]));
    return { jobId: row.job_id, capabilityDigest: row.capability_digest, expiresAt: row.expires_at };
  },

  // Resolve a presented digest → the bound jobId, only when live (not revoked, not expired).
  async resolveMediaCapability(client, workspaceId, { capabilityDigest, nowMs = null }) {
    requireClient(client);
    if (typeof capabilityDigest !== "string" || !/^[0-9a-f]{64}$/.test(capabilityDigest)) return null;
    const row = one(await client.query(
      `SELECT job_id, expires_at, revoked FROM generation_media_capabilities
       WHERE workspace_id=$1 AND capability_digest=$2`, [workspaceId, capabilityDigest]));
    if (!row || row.revoked) return null;
    const cutoff = nowMs != null ? new Date(nowMs) : new Date();
    if (new Date(row.expires_at).getTime() <= cutoff.getTime()) return null;
    return { jobId: row.job_id, expiresAt: row.expires_at };
  },

  async revokeMediaCapability(client, workspaceId, { capabilityDigest }) {
    requireClient(client);
    const r = await client.query(
      `UPDATE generation_media_capabilities SET revoked=true
       WHERE workspace_id=$1 AND capability_digest=$2 AND revoked=false`, [workspaceId, capabilityDigest]);
    return { revoked: r.rowCount === 1 };
  }
};

export { S as GENERATION_JOB_STATES, TERMINAL_JOB_STATES };
