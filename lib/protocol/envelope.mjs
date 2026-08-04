// AVC Studio Worker Protocol v1 — message envelope + MESSAGE_ACK validation.
//
// PURE MODULE. Imports only sibling pure modules. No fs/net/env. Safe for
// cloud + Worker. This layer validates STRUCTURE only. Connection-bound
// identity validation (E_IDENTITY_MISMATCH: does the message workerId match the
// authenticated WSS credential?) is DEFERRED to the future transport/server
// layer — it needs the authenticated connection, which does not exist here.
//
// Spec: docs/protocol-v1.md §3 (envelope), §5.1 (MESSAGE_ACK).

import { PROTOCOL_ERRORS, protocolError } from "./errors.mjs";
import { generateId, validateId, isKnownPrefix } from "./ids.mjs";
import {
  PROTOCOL_VERSION, isKnownMessageType, requiredEnvelopeFields
} from "./message-types.mjs";
import { isJobState } from "./job-states.mjs";

// Size limits (docs §3). Serialized UTF-8 byte length of `payload`.
export const MAX_PAYLOAD_BYTES = 256 * 1024;             // normal
export const MAX_RECONCILE_PAYLOAD_BYTES = 1024 * 1024;  // STATE_RECONCILE + allowed batch
const RECONCILE_TYPES = new Set(["STATE_RECONCILE"]);

export const DEFAULT_SKEW_MS = 120 * 1000; // ±120s

// Keys that enable prototype pollution — forbidden at ANY depth of the payload.
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// Top-level envelope fields allowed (no unknowns).
const ENVELOPE_FIELDS = new Set([
  "protocolVersion", "messageId", "type", "userId", "workspaceId",
  "workerId", "jobId", "sentAt", "correlationId", "payload"
]);

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Recursively assert no prototype-pollution keys anywhere in a value.
function assertNoPollution(value, path = "payload") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertNoPollution(value[i], `${path}[${i}]`);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (POLLUTION_KEYS.has(key)) {
        throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE,
          `Forbidden key at ${path}`, { key });
      }
      assertNoPollution(value[key], `${path}.${key}`);
    }
    // Also guard against non-plain nested objects carrying a tampered prototype.
    if (!Array.isArray(value) && !isPlainObject(value)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE,
        `Non-plain object at ${path}`, { path });
    }
  }
}

// UTF-8 byte length without Buffer (Buffer is fine in Node but we keep this
// dependency-free/portable): TextEncoder is a global standard.
const ENCODER = new TextEncoder();
function jsonByteLength(value) {
  return ENCODER.encode(JSON.stringify(value)).length;
}

// makeEnvelope(input): build a well-formed envelope, generating messageId/sentAt
// if omitted. Does NOT set identity fields you don't pass. Validates the result.
export function makeEnvelope(input) {
  if (!isPlainObject(input)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "makeEnvelope requires a plain object", {});
  }
  const env = {
    protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
    messageId: input.messageId ?? generateId("msg"),
    type: input.type,
    sentAt: input.sentAt ?? new Date().toISOString(),
    payload: input.payload ?? {}
  };
  for (const f of ["userId", "workspaceId", "workerId", "jobId", "correlationId"]) {
    if (input[f] !== undefined) env[f] = input[f];
  }
  // Validate without skew check (sentAt just generated may equal now); caller
  // can re-validate with skew on receive.
  validateEnvelope(env, { checkSkew: false });
  return env;
}

// isEnvelope(value): cheap boolean structural check (no throw).
export function isEnvelope(value) {
  try {
    validateEnvelope(value, { checkSkew: false });
    return true;
  } catch {
    return false;
  }
}

// validateEnvelope(value, options): throws ProtocolError on any violation.
// options: { checkSkew=true, skewMs=DEFAULT_SKEW_MS, now=Date.now() }
export function validateEnvelope(value, options = {}) {
  const { checkSkew = true, skewMs = DEFAULT_SKEW_MS, now = Date.now() } = options;

  if (!isPlainObject(value)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "Envelope must be a plain object", {});
  }

  // No unknown top-level fields.
  for (const key of Object.keys(value)) {
    if (POLLUTION_KEYS.has(key)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "Forbidden top-level key", { key });
    }
    if (!ENVELOPE_FIELDS.has(key)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, `Unknown envelope field: "${key}"`, { field: key });
    }
  }

  // protocolVersion
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw protocolError(PROTOCOL_ERRORS.E_PROTOCOL_VERSION,
      `Unsupported protocolVersion (expected ${PROTOCOL_VERSION})`, { expected: PROTOCOL_VERSION });
  }

  // messageId
  if (!validateId(value.messageId, "msg")) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, "Invalid messageId", { field: "messageId" });
  }

  // type
  if (!isKnownMessageType(value.type)) {
    throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_TYPE, "Unknown message type", { field: "type" });
  }

  // optional userId
  if (value.userId !== undefined && !validateId(value.userId, "usr")) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, "Invalid userId", { field: "userId" });
  }
  // optional correlationId
  if (value.correlationId !== undefined && !validateId(value.correlationId, "corr")) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, "Invalid correlationId", { field: "correlationId" });
  }

  // required identity fields per message type
  const req = requiredEnvelopeFields(value.type);
  // workspaceId / workerId / jobId
  checkIdField(value, "workspaceId", "ws", req.workspaceId);
  checkIdField(value, "workerId", "wrk", req.workerId);
  checkIdField(value, "jobId", "job", req.jobId);

  // sentAt
  if (typeof value.sentAt !== "string" || !ISO_UTC_RE.test(value.sentAt)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "sentAt must be ISO-8601 UTC (…Z)", { field: "sentAt" });
  }
  const t = Date.parse(value.sentAt);
  if (Number.isNaN(t)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "sentAt is not a parseable timestamp", { field: "sentAt" });
  }
  if (checkSkew && Math.abs(now - t) > skewMs) {
    throw protocolError(PROTOCOL_ERRORS.E_TIMESTAMP_SKEW,
      "sentAt outside allowed skew window", { skewMs });
  }

  // payload
  if (!isPlainObject(value.payload)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "payload must be a plain object", { field: "payload" });
  }
  assertNoPollution(value.payload);

  const limit = RECONCILE_TYPES.has(value.type) ? MAX_RECONCILE_PAYLOAD_BYTES : MAX_PAYLOAD_BYTES;
  const size = jsonByteLength(value.payload);
  if (size > limit) {
    throw protocolError(PROTOCOL_ERRORS.E_PAYLOAD_TOO_LARGE,
      `payload exceeds ${limit} bytes`, { limit, size });
  }

  // MESSAGE_ACK payload contract
  if (value.type === "MESSAGE_ACK") {
    validateMessageAckPayload(value.payload);
  }

  return value;
}

function checkIdField(value, field, prefix, required) {
  const present = value[field] !== undefined;
  if (required && !present) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, `Missing required ${field}`, { field });
  }
  if (present && !validateId(value[field], prefix)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, `Invalid ${field}`, { field });
  }
}

// ---- MESSAGE_ACK payload (docs §5.1) ----
export const ACK_STATUSES = Object.freeze(["ACCEPTED", "REJECTED", "VALIDATION_FAILED"]);
const ACK_STATUS_SET = new Set(ACK_STATUSES);
const ACK_FIELDS = new Set(["ackedMessageId", "ackedType", "status", "serverRevision", "errorCode"]);

// validateMessageAckPayload(payload): throws on any violation. Enforces:
//  - ackedMessageId is a valid msg_ id
//  - ackedType is a KNOWN protocol type and NOT "MESSAGE_ACK" (no ack loops)
//  - status ∈ ACK_STATUSES; ACCEPTED ⇒ errorCode null; REJECTED/VALIDATION_FAILED ⇒ errorCode string
//  - serverRevision integer or null
export function validateMessageAckPayload(payload) {
  if (!isPlainObject(payload)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "MESSAGE_ACK payload must be an object", {});
  }
  for (const key of Object.keys(payload)) {
    if (!ACK_FIELDS.has(key)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, `Unknown MESSAGE_ACK field: "${key}"`, { field: key });
    }
  }
  if (!validateId(payload.ackedMessageId, "msg")) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, "Invalid ackedMessageId", { field: "ackedMessageId" });
  }
  if (!isKnownMessageType(payload.ackedType)) {
    throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_TYPE, "ackedType is not a known protocol type", { field: "ackedType" });
  }
  if (payload.ackedType === "MESSAGE_ACK") {
    // Default reject: a MESSAGE_ACK must never acknowledge another MESSAGE_ACK.
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE,
      "MESSAGE_ACK cannot acknowledge a MESSAGE_ACK (ack loop)", { field: "ackedType" });
  }
  if (!ACK_STATUS_SET.has(payload.status)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "Invalid MESSAGE_ACK status", { field: "status" });
  }
  const rev = payload.serverRevision;
  if (!(rev === null || (Number.isInteger(rev)))) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "serverRevision must be integer or null", { field: "serverRevision" });
  }
  const err = payload.errorCode;
  if (payload.status === "ACCEPTED") {
    if (err !== null && err !== undefined) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, "ACCEPTED ack must have errorCode null", { field: "errorCode" });
    }
  } else {
    // REJECTED / VALIDATION_FAILED must carry a safe non-empty errorCode string.
    if (typeof err !== "string" || err.trim() === "") {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_ENVELOPE, `${payload.status} ack requires errorCode string`, { field: "errorCode" });
    }
  }
  return payload;
}

// Optional helper for callers building result payloads that carry a job state.
export function isValidJobStateValue(state) {
  return isJobState(state);
}

// Re-export for convenience so the transport layer has one import site.
export { isKnownPrefix };
