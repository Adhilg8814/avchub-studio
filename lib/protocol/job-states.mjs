// AVC Studio Worker Protocol v1 — job state machine.
//
// PURE MODULE. Only imports sibling pure modules (errors). Safe for cloud+Worker.
// Spec: docs/local-first-saas-architecture.md §I (job state machine).

import { PROTOCOL_ERRORS, protocolError } from "./errors.mjs";

export const JOB_STATES = Object.freeze([
  "QUEUED",
  "DISPATCHED",
  "ACCEPTED",
  "RUNNING",
  "NEEDS_MANUAL_ACTION",
  "SUCCEEDED",
  "FAILED",
  "CANCEL_REQUESTED",
  "CANCELED",
  "INTERRUPTED",
  "EXPIRED"
]);
const JOB_STATE_SET = new Set(JOB_STATES);

export const TERMINAL_JOB_STATES = Object.freeze(["SUCCEEDED", "FAILED", "CANCELED", "EXPIRED"]);
const TERMINAL_SET = new Set(TERMINAL_JOB_STATES);

// Allowed forward/back transitions (docs §I). A state may always "stay put"
// (from === to) — that is not a transition and is handled separately.
// INTERRUPTED is a reconcile-only outcome: a job whose result is unknown after
// the Worker died mid-run; it needs recovery, NOT auto-run — so it does NOT
// transition back to RUNNING.
const TRANSITIONS = Object.freeze({
  QUEUED: ["DISPATCHED", "CANCEL_REQUESTED", "EXPIRED"],
  DISPATCHED: ["ACCEPTED", "QUEUED", "EXPIRED", "CANCEL_REQUESTED", "FAILED"],
  ACCEPTED: ["RUNNING", "FAILED", "CANCEL_REQUESTED", "INTERRUPTED"],
  RUNNING: ["NEEDS_MANUAL_ACTION", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "INTERRUPTED"],
  NEEDS_MANUAL_ACTION: ["RUNNING", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED"],
  CANCEL_REQUESTED: ["CANCELED", "SUCCEEDED", "FAILED"], // late result may still land
  INTERRUPTED: ["SUCCEEDED", "FAILED", "CANCELED"],      // resolved ONLY by recovery, never RUNNING
  // terminal states: no outgoing transitions
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
  EXPIRED: []
});

export function isJobState(state) {
  return JOB_STATE_SET.has(state);
}

export function isTerminalJobState(state) {
  return TERMINAL_SET.has(state);
}

// canTransition(from, to): true if `to` is reachable from `from`.
// Same-state (from === to) is allowed as an idempotent no-op EXCEPT for
// terminal states, where re-asserting the same terminal is also fine (idempotent)
// but a terminal → different-state (esp. RUNNING) is NEVER allowed.
export function canTransition(from, to) {
  if (!JOB_STATE_SET.has(from) || !JOB_STATE_SET.has(to)) return false;
  if (from === to) return true; // idempotent no-op
  if (TERMINAL_SET.has(from)) return false; // terminal → anything else is forbidden
  return TRANSITIONS[from].includes(to);
}

// assertTransition(from, to): throws ProtocolError(E_INVALID_TRANSITION) if invalid.
export function assertTransition(from, to) {
  if (!JOB_STATE_SET.has(from)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_TRANSITION, `Unknown from-state`, { field: "from" });
  }
  if (!JOB_STATE_SET.has(to)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_TRANSITION, `Unknown to-state`, { field: "to" });
  }
  if (!canTransition(from, to)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_TRANSITION,
      `Illegal job transition ${from} → ${to}`, { from, to });
  }
  return true;
}

// Which side initiates each transition (documentation/introspection helper).
export const TRANSITION_INITIATOR = Object.freeze({
  "QUEUED->DISPATCHED": "cloud",
  "DISPATCHED->ACCEPTED": "worker",
  "DISPATCHED->QUEUED": "cloud",
  "ACCEPTED->RUNNING": "worker",
  "RUNNING->NEEDS_MANUAL_ACTION": "worker",
  "RUNNING->SUCCEEDED": "worker",
  "RUNNING->FAILED": "worker",
  "QUEUED->CANCEL_REQUESTED": "cloud",
  "CANCEL_REQUESTED->CANCELED": "worker",
  "QUEUED->EXPIRED": "cloud",
  "DISPATCHED->EXPIRED": "cloud",
  "RUNNING->INTERRUPTED": "cloud",
  "INTERRUPTED->SUCCEEDED": "cloud"
});
