// P0 Step 5C.3 — the ONE canonical outbox settlement mapping (derived from docs/protocol-v1.md
// §5/§12.1 + control-plane-architecture.md §12.1). There is NO second mapping anywhere.
//
// Each Cloud → Worker message type declares: its settlement_mode, the correlated lifecycle
// response type(s) that settle it (for LIFECYCLE_RESPONSE), its single-flight ordering key kind,
// whether it dead-letters on max attempts, and what externally bounds its retry loop.
//
// SEND_ONLY is allowed ONLY for the advisory set that the 0007 DB CHECK also permits
// (HELLO_ACK/PING/MESSAGE_ACK/WORKER_HEARTBEAT) — it is FORBIDDEN for paid ownership, cancel,
// credential lifecycle, terminal, or reconcile. assertSettlementMapSafe() proves this at import.

import { CLOUD_TO_WORKER, PROTOCOL_VERSION } from "../../../lib/protocol/message-types.mjs";

export const SETTLEMENT_MODES = Object.freeze(["MESSAGE_ACK", "LIFECYCLE_RESPONSE", "SEND_ONLY"]);
export const ORDERING = Object.freeze({ WORKER_JOB: "WORKER_JOB", WORKER: "WORKER", NONE: "NONE" });

// SEND_ONLY is permitted ONLY for these advisory types (mirrors protocol_outbox_send_only_safe).
const SEND_ONLY_ALLOWED = new Set(["HELLO_ACK", "PING", "MESSAGE_ACK", "WORKER_HEARTBEAT"]);

// boundedBy: what terminally resolves the row if it never settles normally.
//   OFFER_EXPIRY  → the offer-expiry sweep at offer_expires_at (JOB_OFFER)
//   RECONCILE     → bounded resends then reconcile_required
//   RECONNECT     → resend until the worker reconnects / reconcile completes
//   ATTEMPTS      → plain max-attempts dead-letter
//   NONE          → no retry (SEND_ONLY / server-authoritative)
const MAP = Object.freeze({
  JOB_OFFER:               { mode: "LIFECYCLE_RESPONSE", settledBy: ["JOB_ACCEPTED", "JOB_REJECTED"], ordering: ORDERING.WORKER_JOB, boundedBy: "OFFER_EXPIRY", deadLetterOnMax: false },
  JOB_CANCEL_REQUEST:      { mode: "LIFECYCLE_RESPONSE", settledBy: ["JOB_CANCELED"],                 ordering: ORDERING.WORKER_JOB, boundedBy: "RECONCILE",   deadLetterOnMax: true },
  STATE_RECONCILE_REQUEST: { mode: "LIFECYCLE_RESPONSE", settledBy: ["STATE_RECONCILE"],              ordering: ORDERING.WORKER,     boundedBy: "RECONNECT",   deadLetterOnMax: true },
  SESSION_CHECK_REQUEST:   { mode: "LIFECYCLE_RESPONSE", settledBy: ["PROVIDER_SESSION_STATUS"],      ordering: ORDERING.WORKER,     boundedBy: "ATTEMPTS",    deadLetterOnMax: true },
  WORKER_CREDENTIAL_ROTATE:{ mode: "MESSAGE_ACK",        settledBy: [],                               ordering: ORDERING.WORKER,     boundedBy: "ATTEMPTS",    deadLetterOnMax: true },
  WORKER_REVOKED:          { mode: "LIFECYCLE_RESPONSE", settledBy: [],                               ordering: ORDERING.WORKER,     boundedBy: "NONE",        deadLetterOnMax: false, serverAuthoritative: true },
  HELLO_ACK:               { mode: "SEND_ONLY",          settledBy: [],                               ordering: ORDERING.WORKER,     boundedBy: "NONE",        deadLetterOnMax: false },
  PING:                    { mode: "SEND_ONLY",          settledBy: [],                               ordering: ORDERING.WORKER,     boundedBy: "NONE",        deadLetterOnMax: false },
  MESSAGE_ACK:             { mode: "SEND_ONLY",          settledBy: [],                               ordering: ORDERING.NONE,       boundedBy: "NONE",        deadLetterOnMax: false }
});

export function settlementFor(type) { return MAP[type] || null; }

// The single-flight ordering key STRING for a concrete message (or null → no ordering).
export function orderingKeyFor(type, { workerId, jobId } = {}) {
  const d = MAP[type];
  if (!d) return null;
  if (d.ordering === ORDERING.WORKER_JOB) {
    if (!workerId || !jobId) return null;
    return `${workerId}:${jobId}`;
  }
  if (d.ordering === ORDERING.WORKER) {
    if (!workerId) return null;
    return `${workerId}`;
  }
  return null; // NONE
}

// Reverse index: which OUTBOX types an inbound response type can settle (lifecycle correlation).
const RESPONSE_TO_OUTBOX = (() => {
  const m = new Map();
  for (const [outType, d] of Object.entries(MAP)) {
    for (const resp of d.settledBy) {
      if (!m.has(resp)) m.set(resp, new Set());
      m.get(resp).add(outType);
    }
  }
  return m;
})();

// Which outbox message types (if any) a given inbound lifecycle message settles.
export function outboxTypesSettledBy(inboundType) {
  const s = RESPONSE_TO_OUTBOX.get(inboundType);
  return s ? [...s] : [];
}

// Does inbound `responseType` correlate as the settlement of an outbox row of `outboxType`?
export function isCorrelatedResponse(outboxType, responseType) {
  const d = MAP[outboxType];
  return Boolean(d && d.settledBy.includes(responseType));
}

// Prove the map is safe + complete at import time (fail fast, never ship a bad mapping).
export function assertSettlementMapSafe() {
  if (PROTOCOL_VERSION !== 1) throw new Error("settlement-map built for protocol v1");
  for (const type of CLOUD_TO_WORKER) {
    const d = MAP[type];
    if (!d) throw new Error(`settlement-map missing Cloud→Worker type: ${type}`);
    if (!SETTLEMENT_MODES.includes(d.mode)) throw new Error(`bad settlement_mode for ${type}`);
    if (d.mode === "SEND_ONLY" && !SEND_ONLY_ALLOWED.has(type)) {
      throw new Error(`SEND_ONLY forbidden for correctness-critical type ${type}`);
    }
    if (d.mode === "LIFECYCLE_RESPONSE" && d.settledBy.length === 0 && !d.serverAuthoritative) {
      throw new Error(`LIFECYCLE_RESPONSE type ${type} has no correlated response`);
    }
  }
  return true;
}

assertSettlementMapSafe();
