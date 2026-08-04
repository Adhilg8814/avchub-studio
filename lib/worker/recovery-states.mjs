// AVC Studio P0 Step 5.7a — recovery state machine (PURE).
//
// PURE MODULE. Zero side effects, no fs/network/child_process. This is the single
// authoritative definition of a journal record's *local* lifecycle and of the legal
// transitions between those states. The recovery journal enforces every write against
// this table; the classifier reads it to decide what recovery is safe.
//
// The whole point of this module is to make the golden rule — at most one paid
// generation per generationAttemptId — provable by construction. Two properties do it:
//
//   1. A record can only advance FORWARD through the pipeline. It can never regress
//      from a submitted/post-submitted state back to a pre-submit state, and it can
//      never re-enter SUBMITTING once it has left it. (This table.)
//   2. Entering SUBMITTING is additionally gated on the generation ordinal, so even a
//      legal-looking NEEDS_MANUAL_ACTION → SUBMITTING resume cannot bill twice.
//      (Enforced by the journal, using generationOrdinal.)
//
// State diagram (forward pipeline; NEEDS_MANUAL_ACTION is an orthogonal pause):
//
//   CREATED → RUNNING → SUBMITTING → SUBMITTED → DOWNLOADING → IMPORTED → <terminal>
//                 │         │            │            │            │
//                 └─────────┴────────────┴────────────┴────────────┴──→ NEEDS_MANUAL_ACTION ──┐
//                                                                                             │
//                 ┌───────────────────────────────────────────────────────────────────────── ┘
//                 ↓ (operator resolves → resume forward from where it paused)
//   RUNNING / SUBMITTING / SUBMITTED / DOWNLOADING / IMPORTED / <terminal>
//
//   <terminal> = SUCCEEDED | FAILED | CANCELED  (absorbing — no exits)
//
// SUBMITTING is the crash-window closer (review item C3): it is persisted BEFORE the
// provider call, so a crash "during submit" recovers to a record that KNOWS a paid
// generation may already be in flight and must be verified, never blindly retried.

import { WORKER_ERRORS, workerError } from "./journal-safety.mjs";

export const LOCAL_STATES = Object.freeze({
  CREATED: "CREATED",
  RUNNING: "RUNNING",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  DOWNLOADING: "DOWNLOADING",
  IMPORTED: "IMPORTED",
  NEEDS_MANUAL_ACTION: "NEEDS_MANUAL_ACTION",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELED: "CANCELED"
});

export const TERMINAL_LOCAL_STATES = Object.freeze(["SUCCEEDED", "FAILED", "CANCELED"]);
const TERMINAL_SET = new Set(TERMINAL_LOCAL_STATES);

// States in which the provider has NOT yet been asked to generate. A record in one of
// these states may (subject to the classifier) be retried WITHOUT spending quota.
export const PRE_SUBMIT_LOCAL_STATES = Object.freeze(["CREATED", "RUNNING"]);
const PRE_SUBMIT_SET = new Set(PRE_SUBMIT_LOCAL_STATES);

// States in which a paid generation is presumed or confirmed to have been dispatched.
// A record in one of these states must never be auto-regenerated.
export const POST_SUBMIT_LOCAL_STATES = Object.freeze(["SUBMITTING", "SUBMITTED", "DOWNLOADING", "IMPORTED"]);
const POST_SUBMIT_SET = new Set(POST_SUBMIT_LOCAL_STATES);

// Authoritative transition table. Each key lists the states it may advance to.
// A self-transition (from === to) is treated as idempotent and always allowed EXCEPT
// for SUBMITTING (re-entering SUBMITTING is a re-submit and is rejected — see below).
const TRANSITIONS = Object.freeze({
  // CREATED may go straight to SUBMITTING/SUBMITTED for the one-step legacy path
  // (handlers/fakes that submit without a separate markRunning). The generationOrdinal
  // guard — not this table — is what stops a second billing on that path.
  CREATED: ["RUNNING", "SUBMITTING", "SUBMITTED", "NEEDS_MANUAL_ACTION", "SUCCEEDED", "FAILED", "CANCELED"],
  // RUNNING may submit (paid path), park for manual action, or finish directly for a
  // no-submit action (export/cancel/fail). RUNNING → SUBMITTED is the legacy one-step
  // path (Step 4A fakes) where SUBMITTING was not separately persisted.
  RUNNING: ["SUBMITTING", "SUBMITTED", "NEEDS_MANUAL_ACTION", "SUCCEEDED", "FAILED", "CANCELED"],
  // From SUBMITTING the only safe forward move is a confirmed SUBMITTED, a pause, or a
  // pre-acceptance failure/cancel. It can NEVER go back to RUNNING/CREATED.
  SUBMITTING: ["SUBMITTED", "NEEDS_MANUAL_ACTION", "FAILED", "CANCELED"],
  SUBMITTED: ["DOWNLOADING", "IMPORTED", "NEEDS_MANUAL_ACTION", "SUCCEEDED", "FAILED", "CANCELED"],
  DOWNLOADING: ["IMPORTED", "NEEDS_MANUAL_ACTION", "SUCCEEDED", "FAILED", "CANCELED"],
  IMPORTED: ["NEEDS_MANUAL_ACTION", "SUCCEEDED", "FAILED", "CANCELED"],
  // A paused job resumes forward from wherever it was; the generationOrdinal guard
  // (not this table) is what prevents a post-submit pause from billing again.
  NEEDS_MANUAL_ACTION: ["RUNNING", "SUBMITTING", "SUBMITTED", "DOWNLOADING", "IMPORTED", "SUCCEEDED", "FAILED", "CANCELED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: []
});

export function isTerminalLocalState(state) { return TERMINAL_SET.has(state); }
export function isPreSubmitLocalState(state) { return PRE_SUBMIT_SET.has(state); }
export function isPostSubmitLocalState(state) { return POST_SUBMIT_SET.has(state); }

// canRecoveryTransition(from, to): is `from → to` a legal move?
//   - Unknown states are illegal.
//   - Terminal states are absorbing (only the idempotent self-move is legal).
//   - Re-entering SUBMITTING (from === "SUBMITTING", to === "SUBMITTING") is illegal:
//     a second submit is exactly what the golden rule forbids.
//   - Any other self-transition is idempotent and allowed.
export function canRecoveryTransition(from, to) {
  if (!(from in TRANSITIONS) || !(to in TRANSITIONS)) return false;
  if (from === "SUBMITTING" && to === "SUBMITTING") return false;
  if (from === to) return !TERMINAL_SET.has(from); // terminal self-move is a no-op, not a transition
  return TRANSITIONS[from].includes(to);
}

// assertRecoveryTransition(from, to, ctx?): throw E_ILLEGAL_RECOVERY_TRANSITION unless legal.
export function assertRecoveryTransition(from, to, ctx = {}) {
  if (!canRecoveryTransition(from, to)) {
    throw workerError(
      WORKER_ERRORS.E_ILLEGAL_RECOVERY_TRANSITION,
      `Illegal recovery transition ${from} → ${to}`,
      { from, to, ...ctx }
    );
  }
  return to;
}

export function legalNextStates(from) {
  if (!(from in TRANSITIONS)) return [];
  return [...TRANSITIONS[from]];
}

// ---- submission evidence enums ------------------------------------------------

// How (and whether) a provider supports idempotent submission. Recovery uses this to
// decide whether an uncertain submit may be safely re-issued or must be inspected.
//   NONE    — no idempotency; a re-submit could double-charge. Must inspect provider.
//   NATIVE  — provider dedupes on our idempotency key; re-submit is safe (provider
//             collapses it to the original generation).
//   DERIVED — no native key, but the submission is discoverable by a derived lookup
//             (e.g. a client-tag / job title we can search for) before re-submitting.
export const IDEMPOTENCY_SUPPORT = Object.freeze({
  NONE: "NONE",
  NATIVE: "NATIVE",
  DERIVED: "DERIVED"
});
const IDEMPOTENCY_SET = new Set(Object.values(IDEMPOTENCY_SUPPORT));
export function isIdempotencySupport(v) { return IDEMPOTENCY_SET.has(v); }

// Coarse submission progress recorded on the record.
//   NOT_SUBMITTED — provider not yet asked.
//   SUBMITTING    — provider call started; outcome not yet persisted (crash window).
//   SUBMITTED     — provider accepted (or presumed to have accepted) the request.
export const SUBMISSION_STATE = Object.freeze({
  NOT_SUBMITTED: "NOT_SUBMITTED",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED"
});
const SUBMISSION_STATE_SET = new Set(Object.values(SUBMISSION_STATE));
export function isSubmissionState(v) { return SUBMISSION_STATE_SET.has(v); }

// How sure we are that a paid generation was actually dispatched.
//   NONE      — definitely not submitted.
//   UNKNOWN   — submit was in flight when we last persisted / crashed; we do NOT know
//               whether the provider accepted it. This is the state recovery must treat
//               as "maybe billed" — inspect, never blindly retry.
//   PRESUMED  — we sent the request and did not observe a rejection, but have no
//               provider-side confirmation id.
//   CONFIRMED — provider returned an acceptance (providerSubmissionId / evidence).
export const SUBMISSION_CONFIDENCE = Object.freeze({
  NONE: "NONE",
  UNKNOWN: "UNKNOWN",
  PRESUMED: "PRESUMED",
  CONFIRMED: "CONFIRMED"
});
const SUBMISSION_CONFIDENCE_SET = new Set(Object.values(SUBMISSION_CONFIDENCE));
export function isSubmissionConfidence(v) { return SUBMISSION_CONFIDENCE_SET.has(v); }
