// P0 Step 5C.31 — REMOTE WORKER DELIVERY PROTOCOL (v1).
//
// The wire contract between the Studio server (the "hub", which owns the durable generation pipeline)
// and a paired remote Worker Bundle running on another Windows machine.
//
// Design rules that the whole protocol is built around:
//
//  * The hub is the ONLY source of truth. Ownership, scheduling, quota, tenancy and every state
//    transition are decided server-side. A worker frame is a REPORT or a REQUEST, never an assertion
//    of authority. In particular the worker NEVER states its workspace/customer: the hub derives that
//    from the authenticated credential and echoes it back in HELLO_ACK.
//  * Transport is at-least-once; effects are at-most-once. Every worker->hub command carries a
//    `commandId` (idempotency key) and a per-attempt `sequence`. The hub records the command inside the
//    same transaction as its effect, so a replay after reconnect is a provable no-op and an older
//    sequence for an attempt is refused.
//  * Nothing secret ever crosses in a frame: no credential (the credential authenticates the socket
//    via the Authorization header, exactly once, at upgrade time), no cookie, no proxy password, no
//    provider token, no absolute path, no full prompt in any log-bound field.
//
// Version negotiation: the hub advertises DELIVERY_PROTOCOL_VERSION and accepts the versions in
// SUPPORTED_DELIVERY_PROTOCOL_VERSIONS. An unsupported worker is refused at HELLO with a safe reason
// (INCOMPATIBLE) instead of being silently half-connected.

export const DELIVERY_PROTOCOL_VERSION = 1;
export const SUPPORTED_DELIVERY_PROTOCOL_VERSIONS = Object.freeze([1]);

// The single WSS path the studio gateway tunnels for remote workers.
export const REMOTE_WORKER_WS_PATH = "/api/worker/link";
// The HTTP prefix for artifact upload (same worker trust domain, WORKER route policy -> no browser cookie).
export const REMOTE_WORKER_HTTP_PREFIX = "/api/worker/";

export const MAX_FRAME_BYTES = 128 * 1024;
export const HELLO_TIMEOUT_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 75_000;
// A worker whose heartbeat is older than this is not eligible for a NEW offer (it may still own one).
export const ONLINE_THRESHOLD_MS = 90_000;

// ---------------------------------------------------------------- message types
// hub -> worker
export const S2W = Object.freeze({
  HELLO_ACK: "HELLO_ACK",
  OFFER: "OFFER",                 // an attempt this worker may accept (already claimed for it server-side)
  LEASE_GRANTED: "LEASE_GRANTED", // accept confirmed; the worker owns the attempt until the lease expires
  LEASE_RENEWED: "LEASE_RENEWED",
  UPLOAD_GRANT: "UPLOAD_GRANT",   // one-time, job/attempt-scoped artifact upload session
  ACK: "ACK",                     // command applied
  NACK: "NACK",                   // command refused (safe reason code); NEVER retryable by the worker alone
  DRAIN: "DRAIN",                 // stop accepting new offers; finish what you own
  CANCEL: "CANCEL",               // pre-submit cancellation only (policy-gated server-side)
  UPDATE_AVAILABLE: "UPDATE_AVAILABLE",
  PING: "PING"
});

// worker -> hub
export const W2S = Object.freeze({
  HELLO: "HELLO",
  READY: "READY",                 // "I have a free execution slot" — the hub answers with OFFER or nothing
  ACCEPT: "ACCEPT",
  REJECT: "REJECT",
  PROGRESS: "PROGRESS",
  SUBMIT_ATTEMPTED: "SUBMIT_ATTEMPTED", // recorded BEFORE the single provider click
  SUBMITTED: "SUBMITTED",
  RESULT_READY: "RESULT_READY",
  ARTIFACT_UPLOADED: "ARTIFACT_UPLOADED",
  COMPLETE: "COMPLETE",
  FAIL: "FAIL",
  RELEASE: "RELEASE",             // give the attempt back WITHOUT a terminal verdict (pre-submit only)
  DRAIN_ACK: "DRAIN_ACK",
  LEASE_RENEW: "LEASE_RENEW",
  HEARTBEAT: "HEARTBEAT",
  PONG: "PONG"
});

// Commands that mutate durable job state (recorded in remote_delivery_commands).
export const DURABLE_COMMANDS = Object.freeze(new Set([
  W2S.ACCEPT, W2S.REJECT, W2S.PROGRESS, W2S.SUBMIT_ATTEMPTED, W2S.SUBMITTED,
  W2S.RESULT_READY, W2S.ARTIFACT_UPLOADED, W2S.COMPLETE, W2S.FAIL, W2S.RELEASE, W2S.DRAIN_ACK
]));

// Safe, stable close reasons. A worker must be able to act on these without any server internals.
export const CLOSE_REASON = Object.freeze({
  NORMAL: { code: 1000, reason: "NORMAL" },
  DRAINING: { code: 4001, reason: "DRAINING" },
  SUPERSEDED: { code: 4002, reason: "SESSION_SUPERSEDED" },
  CREDENTIAL_REVOKED: { code: 4003, reason: "CREDENTIAL_REVOKED" },
  WORKER_DISABLED: { code: 4004, reason: "WORKER_DISABLED" },
  INCOMPATIBLE: { code: 4005, reason: "PROTOCOL_INCOMPATIBLE" },
  BAD_HANDSHAKE: { code: 4006, reason: "BAD_HANDSHAKE" },
  MALFORMED: { code: 4007, reason: "MALFORMED_FRAME" },
  RATE_LIMITED: { code: 4008, reason: "RATE_LIMITED" },
  HEARTBEAT_TIMEOUT: { code: 4009, reason: "HEARTBEAT_TIMEOUT" },
  INTERNAL: { code: 4010, reason: "INTERNAL" }
});

export const REMOTE_ERRORS = Object.freeze({
  E_REMOTE_PROTOCOL_VERSION: "E_REMOTE_PROTOCOL_VERSION",
  E_REMOTE_FRAME_INVALID: "E_REMOTE_FRAME_INVALID",
  E_REMOTE_NOT_OWNER: "E_REMOTE_NOT_OWNER",
  E_REMOTE_STALE_SEQUENCE: "E_REMOTE_STALE_SEQUENCE",
  E_REMOTE_DUPLICATE_COMMAND: "E_REMOTE_DUPLICATE_COMMAND",
  E_REMOTE_ATTEMPT_TERMINAL: "E_REMOTE_ATTEMPT_TERMINAL",
  E_REMOTE_LEASE_EXPIRED: "E_REMOTE_LEASE_EXPIRED",
  E_REMOTE_WORKER_NOT_APPROVED: "E_REMOTE_WORKER_NOT_APPROVED",
  E_REMOTE_WORKER_DRAINING: "E_REMOTE_WORKER_DRAINING",
  E_REMOTE_WORKER_INCOMPATIBLE: "E_REMOTE_WORKER_INCOMPATIBLE",
  E_REMOTE_TENANT_MISMATCH: "E_REMOTE_TENANT_MISMATCH",
  E_REMOTE_UPLOAD_INVALID: "E_REMOTE_UPLOAD_INVALID",
  E_REMOTE_UPLOAD_HASH_MISMATCH: "E_REMOTE_UPLOAD_HASH_MISMATCH",
  E_REMOTE_UPLOAD_SIZE_MISMATCH: "E_REMOTE_UPLOAD_SIZE_MISMATCH",
  E_REMOTE_UPLOAD_EXPIRED: "E_REMOTE_UPLOAD_EXPIRED",
  E_REMOTE_UPLOAD_FORBIDDEN: "E_REMOTE_UPLOAD_FORBIDDEN",
  E_REMOTE_NO_REMOTE_WORKER: "E_REMOTE_NO_REMOTE_WORKER"
});

const ID_RE = /^[A-Za-z0-9_.:-]{8,80}$/u;
const JOB_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/u;
const ATTEMPT_RE = /^attempt_[0-9A-HJKMNP-TV-Z]{26}$/u;
const WORKER_RE = /^wrk_[0-9A-HJKMNP-TV-Z]{26}$/u;

export function isJobId(v) { return typeof v === "string" && JOB_RE.test(v); }
export function isAttemptId(v) { return typeof v === "string" && ATTEMPT_RE.test(v); }
export function isWorkerId(v) { return typeof v === "string" && WORKER_RE.test(v); }
export function isCommandId(v) { return typeof v === "string" && ID_RE.test(v); }

// Frame keys are short on purpose: these travel over a possibly metered/tunnelled link and are logged.
//   p   protocol version      t   type              id  message id
//   cid command id (worker->hub, idempotency)       seq per-attempt sequence
//   ts  ISO timestamp         w   worker id         j   job id        a   attempt id
//   d   payload (type-specific, validated by the receiving side)
export function makeFrame({ type, messageId, commandId = null, sequence = null, workerId = null, jobId = null, attemptId = null, payload = null, now = () => new Date().toISOString() }) {
  if (typeof type !== "string" || !type) throw Object.assign(new Error("frame type required"), { code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID });
  const f = { p: DELIVERY_PROTOCOL_VERSION, t: type, id: messageId, ts: now() };
  if (commandId != null) f.cid = commandId;
  if (Number.isInteger(sequence)) f.seq = sequence;
  if (workerId) f.w = workerId;
  if (jobId) f.j = jobId;
  if (attemptId) f.a = attemptId;
  if (payload != null) f.d = payload;
  return f;
}

// Parse + shape-validate an inbound frame. Returns { ok, frame } or { ok:false, code }.
// Deliberately strict: an unparseable/oversized/binary frame closes the socket rather than being
// "best-effort" interpreted, because a half-understood delivery frame is a correctness hazard.
export function parseFrame(raw, isBinary, { maxBytes = MAX_FRAME_BYTES } = {}) {
  if (isBinary) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "BINARY" };
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
  if (buf.length === 0) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "EMPTY" };
  if (buf.length > maxBytes) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "TOO_LARGE" };
  let obj;
  try { obj = JSON.parse(buf.toString("utf8")); } catch { return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "JSON" }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "SHAPE" };
  if (!SUPPORTED_DELIVERY_PROTOCOL_VERSIONS.includes(obj.p)) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_PROTOCOL_VERSION, reason: "VERSION" };
  if (typeof obj.t !== "string" || obj.t.length > 32) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "TYPE" };
  if (obj.j != null && !isJobId(obj.j)) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "JOB_ID" };
  if (obj.a != null && !isAttemptId(obj.a)) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "ATTEMPT_ID" };
  if (obj.cid != null && !isCommandId(obj.cid)) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "COMMAND_ID" };
  if (obj.seq != null && (!Number.isInteger(obj.seq) || obj.seq < 0 || obj.seq > 1_000_000)) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "SEQUENCE" };
  if (obj.d != null && (typeof obj.d !== "object" || Array.isArray(obj.d))) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "PAYLOAD" };
  // Defense in depth: a delivery frame must never carry an authentication secret. The credential is
  // presented ONCE in the HTTP upgrade's Authorization header and nowhere else, ever.
  if (frameCarriesSecret(obj)) return { ok: false, code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID, reason: "SECRET_IN_FRAME" };
  return { ok: true, frame: obj };
}

const SECRET_KEYS = new Set(["credential", "workercredential", "authorization", "bearer", "token", "password", "cookie", "secret", "apikey", "totp"]);
export function frameCarriesSecret(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return false;
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.has(String(k).toLowerCase())) return true;
    if (v && typeof v === "object" && frameCarriesSecret(v, depth + 1)) return true;
    if (typeof v === "string" && /^wcred_/.test(v)) return true;
  }
  return false;
}

// A capabilities object reported at HELLO. Advisory only: the hub re-derives readiness from its own
// gates before Enabling a worker, and never grants authority from a self-reported flag.
export function sanitizeCapabilities(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};
  const bool = (k) => { if (typeof input[k] === "boolean") out[k] = input[k]; };
  const str = (k, max = 64) => { if (typeof input[k] === "string" && input[k].length <= max) out[k] = input[k]; };
  bool("cloakReady"); bool("ffmpegReady"); bool("interactiveSession"); bool("providerReady"); bool("daemonReady");
  str("cloakVersion"); str("chromiumVersion"); str("pythonVersion"); str("ffmpegVersion"); str("nodeVersion");
  if (Array.isArray(input.actions)) {
    out.actions = input.actions.filter((a) => typeof a === "string" && /^[A-Z_]{3,40}$/.test(a)).slice(0, 16);
  }
  if (Number.isInteger(input.maxConcurrentGenerations) && input.maxConcurrentGenerations >= 0 && input.maxConcurrentGenerations <= 8) {
    out.maxConcurrentGenerations = input.maxConcurrentGenerations;
  }
  return Object.keys(out).length ? out : null;
}

// The execution spec the hub puts in an OFFER. Deliberately minimal: everything the remote machine
// needs to run ONE Grok Imagine video generation and nothing about other tenants, other jobs, the
// database, or any credential. The provider account/profile is resolved LOCALLY on the worker (its own
// enrolled account) — the hub never ships a session, cookie or profile across the wire.
export function buildOfferPayload({ prompt, durationSeconds, aspectRatio, provider = "GROK", action = "GENERATE_IMAGINE_VIDEO", leaseExpiresAt, offerExpiresAt, providerAccountHint = null, cooldownMs = null }) {
  return {
    provider, action,
    prompt: String(prompt ?? ""),
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 6,
    aspectRatio: typeof aspectRatio === "string" && aspectRatio ? aspectRatio : "9:16",
    leaseExpiresAt: leaseExpiresAt ?? null,
    offerExpiresAt: offerExpiresAt ?? null,
    providerAccountHint: typeof providerAccountHint === "string" ? providerAccountHint : null,
    cooldownMs: Number.isInteger(cooldownMs) ? cooldownMs : null
  };
}
