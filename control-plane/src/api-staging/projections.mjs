// P0 Step 5C.6 — staging API projections (PURE).
//
// Maps internal database rows + the full internal state machine onto SMALL, STABLE, camelCase,
// UTC-ISO projections for the future Studio UI. These are the ONLY shapes the API returns — a raw
// database row is never leaked, and nothing here exposes a credential, verifier, token, provider
// URL, absolute path, SQL state, or raw protocol payload.

function iso(v) { return v == null ? null : new Date(v).toISOString(); }
function safeStr(v, max = 2000) { return typeof v === "string" ? v.slice(0, max) : null; }

// ---- worker (safe metadata only) -------------------------------------------------------------
// Internal workers.status ∈ {ONLINE,OFFLINE,DEGRADED,REVOKED}; a disabled worker (REVOKED /
// disabled_at) projects as DISABLED so the UI never sees the raw terminal state.
export function projectWorkerStatus(row) {
  if (!row) return null;
  if (row.status === "REVOKED" || row.disabled_at) return "DISABLED";
  if (row.status === "ONLINE" || row.status === "DEGRADED" || row.status === "OFFLINE") return row.status;
  return "OFFLINE";
}
export function projectWorker(row, { capabilities = [], reconcileBarrierOpen = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    label: safeStr(row.name, 128),
    status: projectWorkerStatus(row),
    protocolVersion: row.protocol_version ?? null,
    workerVersion: safeStr(row.worker_version, 64),
    capabilities: Array.isArray(capabilities) ? capabilities.map((c) => safeStr(c, 64)).filter(Boolean) : [],
    lastSeenAt: iso(row.last_seen_at),
    reconciling: Boolean(reconcileBarrierOpen)
  };
}
// True only when the worker can safely receive a NEW dispatch (used for QUEUED vs WAITING).
export function workerDispatchable(row) {
  return Boolean(row) && row.status !== "REVOKED" && !row.disabled_at && (row.status === "ONLINE" || row.status === "DEGRADED");
}

// ---- project ---------------------------------------------------------------------------------
export function projectProject(row, { worker = null, counts = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    title: safeStr(row.title, 200),
    description: safeStr(row.description, 4000),
    status: row.archived_at ? "ARCHIVED" : (row.status || "DRAFT"),
    revision: row.revision ?? 0,
    defaults: sanitizeSettings(row.default_settings),
    worker: worker || null,
    counts: counts || { jobs: 0, completed: 0, failed: 0, active: 0 },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: iso(row.archived_at)
  };
}
// Settings are a SAFE knob bag — echo only allow-listed keys (never arbitrary metadata).
export function sanitizeSettings(s) {
  const o = s && typeof s === "object" ? s : {};
  const out = {};
  if (typeof o.aspectRatio === "string") out.aspectRatio = o.aspectRatio.slice(0, 16);
  if (Number.isFinite(o.durationSeconds)) out.durationSeconds = o.durationSeconds;
  if (typeof o.outputFormat === "string") out.outputFormat = o.outputFormat.slice(0, 16);
  if (typeof o.promptDefault === "string") out.promptDefault = o.promptDefault.slice(0, 2000);
  if (Number.isInteger(o.outputCount)) out.outputCount = o.outputCount;
  return out;
}

// ---- job UI status --------------------------------------------------------------------------
// The small stable projection (QUEUED / WAITING_FOR_WORKER / OFFERED / RUNNING / NEEDS_ACTION /
// RECOVERING / COMPLETED / FAILED / CANCELED). COMPLETED is reported ONLY when the job is terminal
// SUCCEEDED — which applyTerminal sets in the SAME transaction as the terminal result + asset, so
// COMPLETED never precedes committed result metadata.
export function projectJobStatus({ job, attempt, workerAvailable = false }) {
  const js = job.status;
  const os = attempt ? attempt.ownership_status : null;
  if (js === "SUCCEEDED") return "COMPLETED";
  if (js === "FAILED" || js === "EXPIRED" || js === "INTERRUPTED") return "FAILED";
  if (js === "CANCELED") return "CANCELED";
  if (os === "RECOVERING") return "RECOVERING";
  if (js === "CANCEL_REQUESTED") return "CANCELED";
  if (js === "NEEDS_MANUAL_ACTION" || os === "MANUAL_ACTION_REQUIRED") return "NEEDS_ACTION";
  if (js === "RUNNING" || js === "ACCEPTED" || os === "RUNNING" || os === "SUBMITTING" || os === "SUBMITTED" || os === "POSSIBLY_SUBMITTED") return "RUNNING";
  if (js === "DISPATCHED" || os === "OFFERED" || os === "OFFER_PENDING") return "OFFERED";
  if (js === "QUEUED") return workerAvailable ? "QUEUED" : "WAITING_FOR_WORKER";
  return "QUEUED";
}

function projectProgress(job, uiStatus) {
  const p = job.progress && typeof job.progress === "object" ? job.progress : {};
  let percent = Number.isFinite(p.percent) ? Math.max(0, Math.min(100, Math.round(p.percent))) : (uiStatus === "COMPLETED" ? 100 : 0);
  // Never let raw progress claim 100% before the job is truly terminal-complete.
  if (uiStatus !== "COMPLETED" && percent >= 100) percent = 99;
  if (uiStatus === "COMPLETED") percent = 100;
  return { percent, stage: safeStr(p.stage, 64), message: safeStr(p.message, 512) };
}

export function projectJob({ job, attempt, worker = null, workerAvailable = false, resultCount = 0 }) {
  const uiStatus = projectJobStatus({ job, attempt, workerAvailable });
  let error = null;
  if (job.error_code) error = { code: safeStr(job.error_code, 64), message: safeStr(job.error_message, 512), retriable: false };
  return {
    id: job.id,
    // requestId is attached by the service from the generation_request row (not on the job row).
    generationAttemptId: job.generation_attempt_id || null,
    projectId: job.project_id || null,
    status: uiStatus,
    progress: projectProgress(job, uiStatus),
    worker: worker || null,
    createdAt: iso(job.created_at),
    startedAt: iso(job.started_at),
    completedAt: iso(job.finished_at),
    error,
    resultCount: Number.isInteger(resultCount) ? resultCount : 0,
    revision: attempt ? (attempt.revision ?? 0) : 0
  };
}

// ---- asset / result (safe metadata only) ----------------------------------------------------
// storageTier (where the bytes live) and liveness (is the producing worker reachable NOW) are
// SEPARATE concepts and are never collapsed. Liveness is computed at read time from the producing
// worker's current session so a COMPLETED generation with an offline worker still reads COMPLETED
// while its asset liveness projects WORKER_OFFLINE.
export function projectAsset(row, { workerOnline = null } = {}) {
  if (!row) return null;
  let liveness = row.liveness || "ONLINE";
  if (workerOnline === false) liveness = "WORKER_OFFLINE";
  else if (workerOnline === true && (liveness === "WORKER_OFFLINE" || !row.liveness)) liveness = "ONLINE";
  return {
    id: row.id,
    mediaType: safeStr(row.mime_type, 128),
    relativePath: safeStr(row.relative_path, 512),   // relative-to-project only (never absolute)
    fileName: safeStr(row.file_name, 256),
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    width: row.width ?? null,
    height: row.height ?? null,
    durationSeconds: row.actual_duration_sec ?? null,
    storageTier: row.storage_tier || "LOCAL_ONLY",
    liveness,
    reviewStatus: row.review_status || "UNREVIEWED",
    selected: Boolean(row.selected),
    approved: Boolean(row.approved),
    producingWorkerId: row.producing_worker_id || null,
    generationAttemptId: row.generation_attempt_id || null,
    revision: row.revision ?? 0,
    createdAt: iso(row.created_at)
  };
}

// ---- synthesized job event timeline ----------------------------------------------------------
// A sanitized, stable, chronologically-ordered timeline derived from the job's own timestamped
// transitions + the terminal outcome. No raw protocol envelope, outbox payload, provider response,
// stack trace, credential, or absolute path is ever included.
export function projectJobEvents({ job, attempt }) {
  const events = [];
  const add = (at, type, uiStatus, extra = {}) => { if (at) events.push({ at: iso(at), type, status: uiStatus, ...extra }); };
  add(job.created_at, "CREATED", "QUEUED");
  add(job.dispatched_at, "DISPATCHED", "OFFERED", { workerId: job.worker_id || null });
  add(job.accepted_at, "ACCEPTED", "RUNNING", { workerId: job.worker_id || null });
  add(job.started_at, "STARTED", "RUNNING", { workerId: job.worker_id || null });
  if (attempt && attempt.ownership_status === "RECOVERING") add(job.dispatched_at, "RECOVERING", "RECOVERING", { reasonCode: "RECONCILE_REQUIRED" });
  add(job.canceled_at, "CANCELED", "CANCELED");
  if (job.status === "SUCCEEDED") add(job.finished_at, "COMPLETED", "COMPLETED");
  else if (job.status === "FAILED" || job.status === "EXPIRED") add(job.finished_at, "FAILED", "FAILED", { reasonCode: safeStr(job.error_code, 64) });
  const pct = job.progress && Number.isFinite(job.progress.percent) ? Math.round(job.progress.percent) : null;
  if (pct != null && job.status === "RUNNING") add(job.started_at, "PROGRESS", "RUNNING", { percent: Math.max(0, Math.min(99, pct)) });
  return events.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
}
