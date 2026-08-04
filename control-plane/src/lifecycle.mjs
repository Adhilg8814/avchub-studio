// P0 Step 5C.1 — Control Plane PROCESS lifecycle states (pure constants).
//
// This is the Control Plane service lifecycle only. It is NOT the Worker/job lifecycle and
// NEVER calls WorkerRuntime.stop().

export const LIFECYCLE = Object.freeze({
  CREATED: "CREATED",
  INITIALIZING: "INITIALIZING",
  READY: "READY",
  DRAINING: "DRAINING",
  STOPPED: "STOPPED",
  FAILED: "FAILED"
});

export const TERMINAL_LIFECYCLE = Object.freeze(new Set([LIFECYCLE.STOPPED, LIFECYCLE.FAILED]));

// Legal forward transitions for the process lifecycle.
const TRANSITIONS = Object.freeze({
  CREATED: ["INITIALIZING", "FAILED", "STOPPED"],
  INITIALIZING: ["READY", "DRAINING", "FAILED", "STOPPED"],
  READY: ["DRAINING", "FAILED"],
  DRAINING: ["STOPPED", "FAILED"],
  STOPPED: [],
  FAILED: []
});

export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}
