// AVC Studio P0 Step 3 — progress adapter (PURE).
//
// PURE MODULE. Turns raw automation status output into safe, structured progress
// updates. Zero side effects, no fs/child_process — it only parses strings and
// objects. It NEVER echoes secrets: free-text labels are clamped and scrubbed of
// URLs / token-like blobs, and only a fixed set of phases is accepted.
//
// A worker automation subprocess is expected to print progress lines of the form:
//   AVCPROGRESS phase=WAITING_FOR_RESULT percent=42 seq=5 label=Waiting for result
//   AVCPROGRESS {"phase":"DOWNLOADING","percent":80,"label":"Downloading"}
// Any other stdout line is ignored (parseStatusLine → { ok:false }).

import { clampString } from "./journal-safety.mjs";

export const PROGRESS_PHASES = Object.freeze([
  "VALIDATING", "OPENING_BROWSER", "UPLOADING_SOURCE", "SELECTING_DURATION",
  "SUBMITTING_PROMPT", "WAITING_FOR_RESULT", "DOWNLOADING", "VERIFYING_MEDIA", "IMPORTING",
  "SUCCEEDED", "FAILED", "NEEDS_MANUAL_ACTION", "CANCELED"
]);
const PHASE_SET = new Set(PROGRESS_PHASES);

const MARKER = "AVCPROGRESS";
const PHASE_TOKEN_RE = /^[A-Z_]{1,40}$/;

// Redact anything that looks like a URL or a long opaque token from free text.
function scrubLabel(label) {
  let s = clampString(label, 200);
  s = s.replace(/\S+:\/\/\S+/g, "[redacted-url]");           // scheme://...
  s = s.replace(/\bsk-[A-Za-z0-9]{6,}\b/g, "[redacted]");    // api-key-ish
  s = s.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");    // long token/hash blobs
  return s;
}

// normalizeProgress(input): validate + canonicalize a progress object.
// Returns { ok:true, progress:{ phase, percent?, label?, sequence? } }
//      or { ok:false, reason }.
export function normalizeProgress(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "not-an-object" };
  }
  const phase = input.phase;
  if (typeof phase !== "string" || !PHASE_TOKEN_RE.test(phase)) {
    return { ok: false, reason: "bad-phase" };
  }
  if (!PHASE_SET.has(phase)) {
    // Structured parse failure — never invent a wrong phase, never echo the raw token.
    return { ok: false, reason: "unknown-phase" };
  }

  const progress = { phase };

  if (input.percent !== undefined && input.percent !== null) {
    const p = typeof input.percent === "number" ? input.percent : Number(input.percent);
    if (!Number.isFinite(p)) return { ok: false, reason: "bad-percent" };
    progress.percent = Math.max(0, Math.min(100, p));
  }

  const seq = input.sequence !== undefined ? input.sequence
    : input.seq !== undefined ? input.seq : undefined;
  if (seq !== undefined && seq !== null) {
    const n = typeof seq === "number" ? seq : Number(seq);
    if (!Number.isInteger(n) || n < 0) return { ok: false, reason: "bad-sequence" };
    progress.sequence = n;
  }

  if (input.label !== undefined && input.label !== null) {
    progress.label = scrubLabel(input.label);
  }

  return { ok: true, progress };
}

// parseStatusLine(line): parse one raw stdout line. Ignores non-progress lines and
// rejects malformed ones — always returns a structured result, never throws.
export function parseStatusLine(line) {
  if (typeof line !== "string") return { ok: false, reason: "not-string" };
  const trimmed = line.trim();
  if (!trimmed.startsWith(MARKER)) return { ok: false, reason: "no-marker" };
  const rest = trimmed.slice(MARKER.length).trim();
  if (rest.length === 0) return { ok: false, reason: "empty" };

  // JSON form.
  if (rest.startsWith("{")) {
    let obj;
    try { obj = JSON.parse(rest); } catch { return { ok: false, reason: "bad-json" }; }
    return normalizeProgress(obj);
  }

  // key=value form. `label=` (if present) consumes the remainder of the line.
  const obj = {};
  let head = rest;
  const labelIdx = rest.indexOf("label=");
  if (labelIdx >= 0) {
    obj.label = rest.slice(labelIdx + "label=".length);
    head = rest.slice(0, labelIdx).trim();
  }
  for (const token of head.split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    if (eq <= 0) return { ok: false, reason: "bad-token" };
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === "seq" || key === "sequence") obj.sequence = value;
    else if (key === "percent") obj.percent = value;
    else if (key === "phase") obj.phase = value;
    // unknown keys are ignored (forward-compatible) but never stored
  }
  return normalizeProgress(obj);
}

// nextSequence(prev): monotonic, 1-based. prev defaults to 0; invalid prev resets to 0.
export function nextSequence(prev = 0) {
  const base = Number.isInteger(prev) && prev >= 0 ? prev : 0;
  return base + 1;
}

// toProgressPayload(progress, options): build a JOB_PROGRESS-shaped payload.
// options.previousSequence lets the caller enforce a strictly-increasing sequence
// when the progress event did not carry one (or carried a stale one).
export function toProgressPayload(progress, options = {}) {
  const norm = progress && progress.ok === true ? progress.progress
    : progress && progress.phase ? normalizeProgress(progress).progress
    : null;
  if (!norm) return null;
  const previousSequence = Number.isInteger(options.previousSequence) ? options.previousSequence : 0;
  let sequence = norm.sequence;
  if (!Number.isInteger(sequence) || sequence <= previousSequence) {
    sequence = nextSequence(previousSequence);
  }
  const payload = { sequence, phase: norm.phase };
  if (norm.label !== undefined) payload.label = norm.label;
  if (norm.percent !== undefined) payload.percent = norm.percent;
  return payload;
}
