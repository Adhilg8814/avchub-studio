// P0 Step 5C.1 — feature-flag evaluator (minimal boundary; NOT the final PG-backed system).
//
// Immutable-config evaluator that returns a structured reason for every decision. Two hard
// guarantees for this step:
//   * ALL flags are OFF by default.
//   * NO flag can enable real provider execution — every execution/paid flag whose backing
//     capability is not yet implemented resolves to FEATURE_UNAVAILABLE, and any `paidPath`
//     evaluation is FEATURE_UNAVAILABLE regardless of config.
//
// The interface (evaluateFlag) is shaped for later replacement by the PostgreSQL-backed
// repository (workspace/user/project targeting + kill lists), but here it is pure over an
// immutable snapshot. Paid-path evaluation is explicitly UNCACHED (the evaluator holds no
// cache at all).

import { FLAG_PREREQ } from "../config/config.mjs";

export const FLAG_REASONS = Object.freeze({
  ENABLED: "ENABLED",
  DISABLED_BY_DEFAULT: "DISABLED_BY_DEFAULT",
  PREREQUISITE_DISABLED: "PREREQUISITE_DISABLED",
  GLOBAL_KILL: "GLOBAL_KILL",
  TARGET_NOT_ALLOWED: "TARGET_NOT_ALLOWED",
  FEATURE_UNAVAILABLE: "FEATURE_UNAVAILABLE"
});

const ALL_FLAGS = Object.keys(FLAG_PREREQ);

// Flags whose backing capability IS implemented in this build. Step 5C.1 implements only the
// Control Plane process skeleton — no Worker execution, scheduler, affinity, preview, or paid
// generation. Everything else resolves to FEATURE_UNAVAILABLE.
const IMPLEMENTED_CAPABILITIES_5C1 = Object.freeze(new Set(["controlPlaneEnabled"]));

// createFeatureFlags({ featureFlags, killed?, capabilities?, isTargetAllowed? })
// - featureFlags: the immutable { flag: bool } snapshot (config.featureFlags).
// - killed: iterable of flag names under a global kill (represented; empty by default).
// - capabilities: Set of implemented flags (defaults to the 5C.1 set).
// - isTargetAllowed(flag, {workspaceId,projectId,userId}) → bool (targeting interface;
//   defaults to allow — the real allowlist store arrives with persistence).
export function createFeatureFlags({
  featureFlags = {},
  killed = [],
  capabilities = IMPLEMENTED_CAPABILITIES_5C1,
  isTargetAllowed = () => true
} = {}) {
  const snapshot = Object.freeze({ ...featureFlags });
  const killSet = new Set(killed);

  function decide({ flag, workspaceId = null, projectId = null, userId = null, paidPath = false }) {
    if (!ALL_FLAGS.includes(flag)) {
      return { flag, enabled: false, reason: FLAG_REASONS.FEATURE_UNAVAILABLE, paidPath: Boolean(paidPath) };
    }
    // 1. global kill wins.
    if (killSet.has(flag)) return { flag, enabled: false, reason: FLAG_REASONS.GLOBAL_KILL, paidPath: Boolean(paidPath) };
    // 2. off in config.
    if (snapshot[flag] !== true) return { flag, enabled: false, reason: FLAG_REASONS.DISABLED_BY_DEFAULT, paidPath: Boolean(paidPath) };
    // 3. prerequisite off (defensive; config validation also enforces the lattice).
    const prereq = FLAG_PREREQ[flag];
    if (prereq && snapshot[prereq] !== true) {
      return { flag, enabled: false, reason: FLAG_REASONS.PREREQUISITE_DISABLED, paidPath: Boolean(paidPath) };
    }
    // 4. HARD CAP: any paid-path evaluation, or any flag whose capability is not implemented
    //    this step, is unavailable. This is why no flag can enable real provider execution.
    if (paidPath || !capabilities.has(flag)) {
      return { flag, enabled: false, reason: FLAG_REASONS.FEATURE_UNAVAILABLE, paidPath: Boolean(paidPath) };
    }
    // 5. targeting interface.
    if (!isTargetAllowed(flag, { workspaceId, projectId, userId })) {
      return { flag, enabled: false, reason: FLAG_REASONS.TARGET_NOT_ALLOWED, paidPath: Boolean(paidPath) };
    }
    return { flag, enabled: true, reason: FLAG_REASONS.ENABLED, paidPath: Boolean(paidPath) };
  }

  return {
    // evaluateFlag(args): structured decision. Paid-path results are computed fresh every
    // call — there is intentionally NO cache on this path.
    evaluateFlag(args = {}) { return decide(args); },
    // Convenience: is a non-paid capability on right now?
    isEnabled(flag, target = {}) { return decide({ flag, ...target, paidPath: false }).enabled; },
    // Snapshot of raw config flags (safe — booleans only).
    snapshot() { return { ...snapshot }; },
    // getStatus() for the health registry.
    getStatus() {
      return {
        component: "featureFlags",
        enabled: true,          // the evaluator itself is always available
        initialized: true,
        ready: true,
        reasonCode: "READY",
        flags: { ...snapshot },
        killed: [...killSet]
      };
    }
  };
}

export { IMPLEMENTED_CAPABILITIES_5C1 };
