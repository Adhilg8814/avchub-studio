// AVC Studio P0 Step 3 — journal safety helpers (PURE).
//
// PURE MODULE. Imports only from the protocol layer (validateId, DANGEROUS_FIELDS,
// protocolError). No fs / child_process / http / net / Python / browser. Shared by
// recovery-journal.mjs, pending-ack-store.mjs and reconcile-builder.mjs to keep a
// single definition of "what may be written to disk / put on the wire".
//
// Hard invariants enforced here (defense-in-depth — writes are also safe by
// construction upstream):
//   * NO password / cookie / token / accessToken / refreshToken / proxy /
//     proxyPassword / fingerprint / profilePath — anywhere, any depth, any case.
//   * NO absolute paths and NO path traversal in any *Ref / relativePath.
//   * NO raw provider URL (url/uri/href/downloadUrl/resultUrl/…): result metadata
//     carries only checksum + size + a relative path.
//   * schemaVersion is explicit and strict.
//   * errors are sanitized to { code, message } with a clamped generic message.

import { validateId } from "../protocol/ids.mjs";
import { DANGEROUS_FIELDS } from "../protocol/job-contracts.mjs";
import { PROTOCOL_ERRORS, protocolError } from "../protocol/errors.mjs";

export const JOURNAL_SCHEMA_VERSION = 1;

// Worker-local error codes (journal/pending-ack are worker concerns, not wire
// protocol). Distinct from PROTOCOL_ERRORS so callers can react precisely.
export const WORKER_ERRORS = Object.freeze({
  E_JOURNAL_CORRUPT: "E_JOURNAL_CORRUPT",
  E_JOURNAL_NOT_FOUND: "E_JOURNAL_NOT_FOUND",
  E_JOURNAL_UNSAFE: "E_JOURNAL_UNSAFE",
  E_JOURNAL_INVALID_REF: "E_JOURNAL_INVALID_REF",
  E_JOURNAL_SCHEMA: "E_JOURNAL_SCHEMA",
  // Step 5.7a — recovery-contract hardening.
  // An attempt to move a journal record along a transition the recovery state
  // machine forbids (e.g. SUBMITTED → SUBMITTING, or any terminal → non-terminal).
  E_ILLEGAL_RECOVERY_TRANSITION: "E_ILLEGAL_RECOVERY_TRANSITION",
  // The golden-rule guard: a second paid generation was attempted for a
  // generationAttemptId that has already been submitted (this job or a sibling).
  E_DUPLICATE_GENERATION_ATTEMPT: "E_DUPLICATE_GENERATION_ATTEMPT"
});

export function workerError(code, message, details) {
  const err = new Error(String(message || code));
  err.name = "WorkerError";
  err.code = code;
  if (details && typeof details === "object") err.details = details;
  return err;
}

const DANGEROUS_SET = new Set(DANGEROUS_FIELDS.map((f) => f.toLowerCase()));
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Keys that could carry a raw provider URL / opaque remote handle. Never stored.
const URL_LIKE_KEYS = new Set([
  "url", "uri", "href", "src", "downloadurl", "resulturl", "sourceurl",
  "signedurl", "presignedurl", "endpoint", "webhook", "callbackurl"
]);

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Recursively reject dangerous / pollution / url-like keys at ANY depth.
export function assertRecordSafe(value, path = "record") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertRecordSafe(value[i], `${path}[${i}]`);
    return value;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const lower = key.toLowerCase();
      if (POLLUTION_KEYS.has(key)) {
        throw protocolError(PROTOCOL_ERRORS.E_DANGEROUS_FIELD, `Forbidden key at ${path}`, { key });
      }
      if (DANGEROUS_SET.has(lower)) {
        throw protocolError(PROTOCOL_ERRORS.E_DANGEROUS_FIELD, `Dangerous field "${key}" not allowed at ${path}`, { field: key });
      }
      if (URL_LIKE_KEYS.has(lower)) {
        throw workerError(WORKER_ERRORS.E_JOURNAL_UNSAFE, `URL-like field "${key}" not allowed at ${path}`, { field: key });
      }
      assertRecordSafe(value[key], `${path}.${key}`);
    }
  }
  return value;
}

// A local result reference must be RELATIVE (not absolute, no traversal, no drive
// letter, no UNC, no backslashes, no scheme). Sub-directories via "/" are allowed.
const RELATIVE_REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,511}$/;
export function isRelativeRef(ref) {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 512) return false;
  if (ref.includes("\\")) return false;                 // no Windows separators
  if (ref.includes("://")) return false;                // no scheme (http:, file:)
  if (/^[A-Za-z]:/.test(ref)) return false;             // no drive letter (C:)
  if (ref.startsWith("/") || ref.startsWith("~")) return false; // no absolute / home
  if (ref.split("/").some((seg) => seg === "..")) return false; // no traversal
  return RELATIVE_REF_RE.test(ref);
}

export function assertRelativeRef(ref, field = "localResultRef") {
  if (!isRelativeRef(ref)) {
    throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF,
      `${field} must be a relative reference (no absolute path / traversal / URL)`, { field });
  }
  return ref;
}

// Sanitize an error into a wire/disk-safe { code, message }. Only ProtocolError
// (designed sanitized) may surface its own message; any other Error is replaced
// with a generic string so a secret/path in err.message can never leak.
export function sanitizeErrorForJournal(err) {
  if (!err) return null;
  const code = typeof err.code === "string" && /^E_[A-Z_]+$/.test(err.code) ? err.code : "E_HANDLER_FAILED";
  const isProtocol = err.name === "ProtocolError" || err.name === "WorkerError";
  let message = isProtocol && typeof err.message === "string" ? err.message : "Handler failed";
  if (message.length > 300) message = `${message.slice(0, 300)}…`;
  return { code, message };
}

// Whitelist result metadata to a small, non-sensitive set. Everything else —
// especially any URL / absolute path — is dropped.
export function safeResultMeta(meta) {
  if (!isPlainObject(meta)) return null;
  const out = {};
  if (typeof meta.checksum === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(meta.checksum)) out.checksum = meta.checksum;
  if (Number.isInteger(meta.sizeBytes) && meta.sizeBytes >= 0) out.sizeBytes = meta.sizeBytes;
  if (typeof meta.relativePath === "string" && isRelativeRef(meta.relativePath)) out.relativePath = meta.relativePath;
  if (typeof meta.durationSec === "number" && Number.isFinite(meta.durationSec) && meta.durationSec >= 0) out.durationSec = meta.durationSec;
  if (Number.isInteger(meta.width) && meta.width >= 0) out.width = meta.width;
  if (Number.isInteger(meta.height) && meta.height >= 0) out.height = meta.height;
  if (typeof meta.mimeType === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(meta.mimeType) && meta.mimeType.length <= 80) out.mimeType = meta.mimeType;
  return Object.keys(out).length ? out : null;
}

export function clampString(s, max = 500) {
  const v = String(s ?? "");
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

// Derive a safe on-disk filename from a jobId. The jobId MUST validate as a
// prefixed ULID (job_<26 Crockford chars>) — a set with no path-significant
// characters — so path traversal is impossible by construction.
export function journalFileName(jobId) {
  if (!validateId(jobId, "job")) {
    throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "jobId must be a valid job_<ULID>", { field: "jobId" });
  }
  return `${jobId}.json`;
}

// Same guarantee for a messageId (msg_<ULID>) used to name pending-ack files.
export function ackFileName(messageId) {
  if (!validateId(messageId, "msg")) {
    throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "messageId must be a valid msg_<ULID>", { field: "messageId" });
  }
  return `${messageId}.json`;
}
