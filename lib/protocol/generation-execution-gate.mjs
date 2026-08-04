// P0 Step 5C.29 Phase 0 — the GENERATION EXECUTION GATE (maintenance pause), fail-closed.
//
// A single server-side switch that stops every path capable of consuming provider quota (Grok video, Grok
// chat/story text, ElevenLabs narration, Facebook publish) WITHOUT mutating any durable record. It exists so a
// runtime can be restarted for a deploy while a stale QUEUED job, an OFFERED job, an active movie pipeline, or
// a startup reconciliation can NOT auto-resume into a real provider invocation.
//
// Design invariants:
//   • SERVER-SIDE ONLY. The value comes from the production owner config (config.generation.executionPaused,
//     threaded to the runtime as WORKER_GENERATION_EXECUTION_PAUSED). It is never client-controlled and never
//     read from a request.
//   • FAIL-CLOSED on an invalid value: anything that is not an explicit false/true (or a recognised
//     "false"/"true"/"0"/"1"/"no"/"yes"/"off"/"on" string) is treated as PAUSED. An ABSENT value keeps the
//     historical behaviour (running), so an existing deployment that never sets the flag is unchanged.
//   • PURE GATE. Pausing NEVER changes a job/movie/offer state, never cancels, never deletes, never rewrites a
//     historical record (a REVIEWED SUBMIT_UNCERTAIN stays exactly as it is). It only refuses to START new
//     provider work; everything already durable is left untouched for the owner to resume later.
//   • NOT a readiness blocker. Reads (UI, media, Story/Movie browsing), native auth, and the Platform plane are
//     unaffected — the Studio stays READY with generation in maintenance mode, surfaced explicitly in health.

export const GENERATION_EXECUTION_PAUSED = "E_GENERATION_EXECUTION_PAUSED";

const TRUE_WORDS = new Set(["true", "1", "yes", "on", "paused"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off", "running"]);

// Parse a config/env value into the boolean gate. Absent -> `defaultWhenAbsent` (false = running, preserving
// the pre-5C.29 behaviour). Present-but-unrecognised -> TRUE (fail closed: an operator typo pauses generation
// rather than silently letting a deploy auto-resume provider work).
export function parseExecutionPaused(value, { defaultWhenAbsent = false } = {}) {
  if (value === undefined || value === null) return defaultWhenAbsent === true;
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "") return defaultWhenAbsent === true;
    if (TRUE_WORDS.has(v)) return true;
    if (FALSE_WORDS.has(v)) return false;
    return true; // unrecognised string -> fail closed
  }
  return true; // number/object/anything else -> fail closed
}

export function executionPausedError(operation = "generation") {
  return Object.assign(new Error("Generation execution is paused (maintenance mode)"), {
    code: GENERATION_EXECUTION_PAUSED,
    operation: typeof operation === "string" && /^[A-Za-z0-9_.-]{1,60}$/u.test(operation) ? operation : "generation"
  });
}

// createExecutionGate({ paused }) -> a frozen gate.
//   assertRunning(op)  throws E_GENERATION_EXECUTION_PAUSED when paused (use at REQUEST/API choke points)
//   blocked()          non-throwing predicate (use in background loops so they idle silently, never crash)
export function createExecutionGate({ paused = false } = {}) {
  const isPaused = paused === true;
  return Object.freeze({
    paused: isPaused,
    isPaused: () => isPaused,
    blocked: () => isPaused,
    assertRunning(operation = "generation") { if (isPaused) throw executionPausedError(operation); }
  });
}

// A shared always-running gate: the explicit default for every call site that was not given a gate, so the
// pre-existing behaviour is byte-identical when the feature is not configured.
export const RUNNING_GATE = createExecutionGate({ paused: false });

// Normalise an optional gate argument (null/undefined -> RUNNING_GATE) so call sites can do `gate.blocked()`
// unconditionally without a null check.
export function asGate(gate) {
  return gate && typeof gate.blocked === "function" && typeof gate.assertRunning === "function" ? gate : RUNNING_GATE;
}
