// P0 Step 5C.9E — shared generation-job fine-grained state machine (PURE protocol values).
//
// This is the SINGLE source of truth for the local Grok generation lifecycle, shared by both the
// Worker-local JSON store (5C.9D, lib/worker/providers/generation-job-store.mjs) and the durable
// control-plane extension repository (5C.9E,
// control-plane/src/persistence/repositories/generation-projection-repository.mjs). It lives under
// lib/protocol/ precisely because the control-plane dependency boundary (control-plane/src/boundary.mjs)
// allows importing pure lib/protocol/* modules but FORBIDS importing lib/worker/*. Keeping the state
// machine here lets both layers converge on identical states + transitions through the 5C.9D→5C.9E
// cutover, with no filesystem/provider/browser side effects at import time.

export const GENERATION_JOB_STATES = Object.freeze({
  QUEUED: "QUEUED",
  WAITING_FOR_ACCOUNT: "WAITING_FOR_ACCOUNT",
  PREPARING: "PREPARING",
  READY_TO_SUBMIT: "READY_TO_SUBMIT",
  SUBMITTED: "SUBMITTED",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED_PRE_SUBMIT: "FAILED_PRE_SUBMIT",
  SUBMIT_UNCERTAIN: "SUBMIT_UNCERTAIN",
  WAITING_FOR_MANUAL_ACTION: "WAITING_FOR_MANUAL_ACTION",
  CANCELLED_BEFORE_SUBMIT: "CANCELLED_BEFORE_SUBMIT"
});

const S = GENERATION_JOB_STATES;

// Terminal states never transition again. A submit-activated job can only reach
// COMPLETED or SUBMIT_UNCERTAIN — never anything re-submittable.
export const TERMINAL_JOB_STATES = Object.freeze([
  S.COMPLETED, S.FAILED_PRE_SUBMIT, S.SUBMIT_UNCERTAIN, S.CANCELLED_BEFORE_SUBMIT
]);
// After this line a provider invocation may have occurred: never re-run these.
export const POST_SUBMIT_JOB_STATES = Object.freeze([S.SUBMITTED, S.PROCESSING, S.COMPLETED, S.SUBMIT_UNCERTAIN]);

export const ALLOWED_TRANSITIONS = Object.freeze({
  [S.QUEUED]: [S.WAITING_FOR_ACCOUNT, S.PREPARING, S.CANCELLED_BEFORE_SUBMIT, S.FAILED_PRE_SUBMIT],
  [S.WAITING_FOR_ACCOUNT]: [S.PREPARING, S.CANCELLED_BEFORE_SUBMIT, S.FAILED_PRE_SUBMIT, S.WAITING_FOR_MANUAL_ACTION],
  // P0 Step 5C.31 - the REQUEUE edge. PREPARING/READY_TO_SUBMIT mean "claimed, nothing sent to the provider
  // yet", so an attempt whose claim is released before submission (worker drained/disconnected, or the
  // provider lane told us to back off) legitimately returns to the queue. The safety property is NOT provided
  // by the absence of this edge: it is provided by possibly_submitted / invocation_state, which every release
  // path checks first and which make a post-submit attempt unreleasable. Without the edge a deferred job was
  // stranded in PREPARING with a dead offer until the next restart.
  [S.PREPARING]: [S.READY_TO_SUBMIT, S.QUEUED, S.FAILED_PRE_SUBMIT, S.WAITING_FOR_MANUAL_ACTION, S.CANCELLED_BEFORE_SUBMIT],
  [S.READY_TO_SUBMIT]: [S.SUBMITTED, S.QUEUED, S.FAILED_PRE_SUBMIT, S.WAITING_FOR_MANUAL_ACTION],
  [S.SUBMITTED]: [S.PROCESSING, S.COMPLETED, S.SUBMIT_UNCERTAIN, S.WAITING_FOR_MANUAL_ACTION],
  [S.PROCESSING]: [S.COMPLETED, S.SUBMIT_UNCERTAIN, S.WAITING_FOR_MANUAL_ACTION],
  // WAITING_FOR_MANUAL_ACTION pauses without releasing the one-invocation fact: only
  // an operator-driven terminal transition (never an automatic re-submit) leaves it.
  [S.WAITING_FOR_MANUAL_ACTION]: [S.SUBMIT_UNCERTAIN, S.FAILED_PRE_SUBMIT, S.CANCELLED_BEFORE_SUBMIT],
  [S.COMPLETED]: [],
  [S.FAILED_PRE_SUBMIT]: [],
  [S.SUBMIT_UNCERTAIN]: [],
  [S.CANCELLED_BEFORE_SUBMIT]: []
});

export function canTransition(from, to) {
  return Array.isArray(ALLOWED_TRANSITIONS[from]) && ALLOWED_TRANSITIONS[from].includes(to);
}
export function isTerminal(state) { return TERMINAL_JOB_STATES.includes(state); }
export function isPostSubmit(state) { return POST_SUBMIT_JOB_STATES.includes(state); }
