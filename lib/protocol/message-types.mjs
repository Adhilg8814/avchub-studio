// AVC Studio Worker Protocol v1 — message type allowlist + direction/ack helpers.
//
// PURE MODULE. Zero imports. Safe for both cloud and Worker.
// Spec: docs/protocol-v1.md §5 (message types), §5.1 (MESSAGE_ACK).

export const PROTOCOL_VERSION = 1;

// ---- Worker → Cloud ----
export const WORKER_TO_CLOUD = Object.freeze([
  "WORKER_HELLO",
  "WORKER_HEARTBEAT",
  "WORKER_CAPABILITIES",
  "WORKER_STORAGE_STATUS",
  "JOB_ACCEPTED",
  "JOB_REJECTED",
  "JOB_STARTED",
  "JOB_PROGRESS",
  "JOB_NEEDS_MANUAL_ACTION",
  "JOB_COMPLETED",
  "JOB_FAILED",
  "JOB_CANCELED",
  "JOB_RECOVERY_REPORT",
  "STATE_RECONCILE",
  "PROVIDER_SESSION_STATUS",
  "ASSET_METADATA_UPSERT",
  "WORKER_GOODBYE",
  "MESSAGE_ACK"          // acks travel both directions
]);

// ---- Cloud → Worker ----
export const CLOUD_TO_WORKER = Object.freeze([
  "HELLO_ACK",
  "MESSAGE_ACK",         // acks travel both directions
  "JOB_OFFER",
  "JOB_CANCEL_REQUEST",
  "SESSION_CHECK_REQUEST",
  "WORKER_CREDENTIAL_ROTATE",
  "WORKER_REVOKED",
  "STATE_RECONCILE_REQUEST",
  "PING"
]);

// ERROR is directionless (either side may emit it).
export const ERROR_TYPE = "ERROR";

const WORKER_TO_CLOUD_SET = new Set(WORKER_TO_CLOUD);
const CLOUD_TO_WORKER_SET = new Set(CLOUD_TO_WORKER);
const ALL_TYPES_SET = new Set([...WORKER_TO_CLOUD, ...CLOUD_TO_WORKER, ERROR_TYPE]);

export const ALL_MESSAGE_TYPES = Object.freeze([...ALL_TYPES_SET]);

// Message types whose delivery MUST be acknowledged with a MESSAGE_ACK
// (docs/protocol-v1.md §5.1). MESSAGE_ACK itself is NEVER acknowledged.
const REQUIRES_ACK_SET = new Set([
  "JOB_COMPLETED",
  "JOB_FAILED",
  "JOB_CANCELED",
  "JOB_RECOVERY_REPORT",
  "ASSET_METADATA_UPSERT",
  "STATE_RECONCILE",
  "WORKER_CREDENTIAL_ROTATE"
]);

export const ACK_REQUIRING_TYPES = Object.freeze([...REQUIRES_ACK_SET]);

// ---- helpers ----

export function isKnownMessageType(type) {
  return typeof type === "string" && ALL_TYPES_SET.has(type);
}

export function isWorkerToCloudType(type) {
  return typeof type === "string" && (WORKER_TO_CLOUD_SET.has(type) || type === ERROR_TYPE);
}

export function isCloudToWorkerType(type) {
  return typeof type === "string" && (CLOUD_TO_WORKER_SET.has(type) || type === ERROR_TYPE);
}

// Whether a message of this type must be acknowledged by the receiver.
export function requiresAcknowledgement(type) {
  return REQUIRES_ACK_SET.has(type);
}

// Which envelope identity fields are REQUIRED for a given message type.
// (Envelope validator consumes this; declared here to keep the type↔field
// contract in one place.) `workspaceId` is required for every contextual
// message; `workerId`/`jobId` depend on the type.
const NO_CONTEXT_TYPES = new Set(["PING", ERROR_TYPE]); // may be sent pre-identity / system-level
const JOB_SCOPED_TYPES = new Set([
  "JOB_OFFER", "JOB_ACCEPTED", "JOB_REJECTED", "JOB_STARTED", "JOB_PROGRESS",
  "JOB_NEEDS_MANUAL_ACTION", "JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED",
  "JOB_RECOVERY_REPORT", "JOB_CANCEL_REQUEST"
]);

export function requiredEnvelopeFields(type) {
  if (!isKnownMessageType(type)) return null;
  const fields = { workspaceId: false, workerId: false, jobId: false };
  if (NO_CONTEXT_TYPES.has(type)) return fields; // nothing required
  // All contextual worker/cloud messages carry workspace + worker identity.
  fields.workspaceId = true;
  fields.workerId = true;
  if (JOB_SCOPED_TYPES.has(type)) fields.jobId = true;
  return fields;
}
