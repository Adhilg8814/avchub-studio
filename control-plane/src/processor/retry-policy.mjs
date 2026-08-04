// P0 Step 5C.3 — deterministic retry/backoff policy + delivery-result classification.
//
// PURE. Randomness (jitter) is injected so tests are reproducible. Delivery results are a fixed
// vocabulary; the classification decides retry vs dead-letter and whether a result counts toward
// max_attempts. Paid-path uncertainty is handled CONSERVATIVELY (see outbox-processor): an
// uncertain write is NOT a "failed delivery" to retry away — it is a possibly-delivered write.

// Structured delivery-adapter result codes (Phase 3 / Phase 10).
export const DELIVERY_RESULTS = Object.freeze({
  WRITTEN: "WRITTEN",                   // confirmed local socket write
  WORKER_OFFLINE: "WORKER_OFFLINE",     // no live socket for this worker on this instance
  SESSION_STALE: "SESSION_STALE",       // the resolved session is superseded/closed — do NOT send
  SESSION_NOT_LOCAL: "SESSION_NOT_LOCAL", // ACTIVE session is owned by ANOTHER gateway instance
  BACKPRESSURE: "BACKPRESSURE",         // socket writable buffer full — retry shortly
  TRANSIENT_FAILURE: "TRANSIENT_FAILURE", // retryable send error
  PERMANENT_FAILURE: "PERMANENT_FAILURE", // non-retryable — dead-letter
  DELIVERY_UNCERTAIN: "DELIVERY_UNCERTAIN" // write may or may not have landed — stay conservative
});
const RESULT_SET = new Set(Object.values(DELIVERY_RESULTS));
export function isDeliveryResult(x) { return RESULT_SET.has(x); }

// A synthetic result the outbox processor raises when a SENT row never reached its settlement
// condition within settlementTimeoutMs (it re-sends the SAME messageId, not a new one).
export const SETTLEMENT_TIMEOUT = "SETTLEMENT_TIMEOUT";

// How each result is handled. `release` = un-claim, keep PENDING, no attempts++ (not the
// message's fault). `retry` = attempts++ + backoff. `deadLetter` = terminal DEAD.
// `offlineRelease` reschedules after a short offline re-check.
export const RESULT_DISPOSITION = Object.freeze({
  WORKER_OFFLINE:     { kind: "release", counts: false, offline: true },
  SESSION_STALE:      { kind: "release", counts: false, offline: true },
  SESSION_NOT_LOCAL:  { kind: "release", counts: false, offline: true },  // leave for the owning instance
  BACKPRESSURE:       { kind: "retry",   counts: false, dead: false },   // transient; never dead-letters
  TRANSIENT_FAILURE:  { kind: "retry",   counts: true,  dead: true },
  PERMANENT_FAILURE:  { kind: "deadLetter", counts: true, dead: true },
  DELIVERY_UNCERTAIN: { kind: "uncertain", counts: true, dead: false },  // treat as possibly-delivered
  SETTLEMENT_TIMEOUT: { kind: "resend",  counts: true,  dead: true }
});

export function dispositionFor(resultCode) {
  return RESULT_DISPOSITION[resultCode] || RESULT_DISPOSITION.TRANSIENT_FAILURE;
}

// createRetryPolicy({ initialBackoffMs, maxBackoffMs, maxAttempts, jitterRatio, rng }).
// rng() ∈ [0,1); default 0.5 → ZERO jitter (deterministic). Backoff is capped exponential.
export function createRetryPolicy({
  initialBackoffMs = 1000, maxBackoffMs = 60000, maxAttempts = 5, jitterRatio = 0.2, rng = () => 0.5
} = {}) {
  if (!(initialBackoffMs >= 0) || !(maxBackoffMs >= initialBackoffMs) || !(maxAttempts >= 1)) {
    throw new Error("invalid retry policy parameters");
  }
  // backoffMs(attempt): delay BEFORE attempt N+1, where `attempt` = attempts already made (>=1).
  function backoffMs(attempt) {
    const n = Math.max(1, attempt | 0);
    const base = Math.min(maxBackoffMs, initialBackoffMs * Math.pow(2, n - 1));
    const jitter = base * jitterRatio * (rng() * 2 - 1);   // ± jitterRatio*base
    return Math.max(0, Math.round(base + jitter));
  }
  // Whether, after this attempt count, the row should dead-letter for a counting/dead result.
  function shouldDeadLetter(attempts) { return attempts >= maxAttempts; }
  return Object.freeze({ backoffMs, shouldDeadLetter, maxAttempts, initialBackoffMs, maxBackoffMs, jitterRatio });
}
