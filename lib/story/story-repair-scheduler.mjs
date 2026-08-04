// P0 Step 5C.35 — story quality auto-repair scheduler (thin, durable).
//
// The repair LOGIC and every durable decision live in the story control plane (autoRepairEnqueue /
// autoRepairDue / autoRepairStep). This module is only the clock: on an interval it publishes the eligible
// set, asks which stories are due, and advances each by ONE idempotent step.
//
// It deliberately owns nothing:
//   * no provider client — the step runs inside the control plane that already holds the runtime's ONE
//     Grok Chat actuator, its account and its browser lease. There is no second launcher here and no way
//     for this file to create one.
//   * no in-memory queue — "what is due" is a query, so a restart resumes with no state handed over.
//   * no timer-based waiting — a paced story is deferred by writing a deadline, not by sleeping.
//
// Serial by design. Grok Chat is one physical lane per account; running two repairs at once would either
// contend for the browser or race the pacing slot. One story at a time, oldest first, is both simpler and
// what the provider actually permits.

import { asGate } from "../protocol/generation-execution-gate.mjs";

// Actions that mean "nothing interesting happened" — logged at debug level only, so a story waiting out a
// two-minute cooldown does not fill the log with a line every tick.
const QUIET = new Set(["NOT_CLAIMED", "SKIPPED", "IDLE"]);

export function createStoryRepairScheduler({
  story, pacing = null, tenancy = null, logger = null, executionGate = null,
  pollMs = 15_000, owner = null, enabled = false, maxPerTick = 1, now = () => Date.now()
} = {}) {
  if (!story || typeof story.autoRepairStep !== "function" || typeof story.autoRepairDue !== "function") {
    throw new TypeError("createStoryRepairScheduler requires a story control plane with autoRepairDue + autoRepairStep");
  }
  // Maintenance pause: the same gate that stops generation stops unattended repair. A paused runtime must
  // not quietly spend provider quota on background work.
  const gate = asGate(executionGate);
  const leaseOwner = owner || `sched_${Math.random().toString(36).slice(2, 10)}${process.pid}`;

  let timer = null, stopped = false, ticking = false, running = false;
  const stats = { ticks: 0, steps: 0, ready: 0, deferred: 0, errors: 0, lastAction: null, lastAt: null };

  async function tick({ wait = false } = {}) {
    if (!enabled || stopped || ticking) return [];
    if (gate.blocked()) return [];
    ticking = true;
    const done = [];
    try {
      stats.ticks += 1;
      // Publish/retire the durable eligible set first, so a story that just became repairable is visible
      // in the same tick and one that reached READY stops being asked about.
      try { await story.autoRepairEnqueue(); }
      catch (e) { logger?.warn?.("STORY_REPAIR_ENQUEUE_ERROR", { code: e?.code || null }); }

      const due = await story.autoRepairDue({ nowMs: now(), limit: Math.max(1, maxPerTick) });
      for (const row of due.slice(0, Math.max(1, maxPerTick))) {
        if (stopped) break;
        running = true;
        let r;
        try {
          r = await story.autoRepairStep(row.storyProjectId, { owner: leaseOwner, pacing, tenancy });
        } catch (e) {
          stats.errors += 1;
          r = { projectId: row.storyProjectId, action: "ERROR", code: e?.code || null };
          logger?.warn?.("STORY_REPAIR_STEP_ERROR", { storyProjectId: row.storyProjectId, code: e?.code || null });
        } finally { running = false; }
        stats.steps += 1;
        stats.lastAction = r?.action || null;
        stats.lastAt = new Date(now()).toISOString();
        if (r?.action === "READY") stats.ready += 1;
        if (r?.action === "DEFERRED") stats.deferred += 1;
        if (r && !QUIET.has(r.action)) {
          logger?.info?.("STORY_REPAIR_STEP", {
            storyProjectId: r.projectId, action: r.action, code: r.code || null,
            nextEligibleAt: r.nextEligibleAt || null, title: r.title ? String(r.title).slice(0, 60) : null
          });
        }
        done.push(r);
      }
    } catch (e) {
      logger?.warn?.("STORY_REPAIR_TICK_ERROR", { code: e?.code || null });
    } finally {
      ticking = false;
    }
    return done;
  }

  return Object.freeze({
    start() {
      if (timer || stopped || !enabled) return false;
      if (gate.blocked()) { logger?.info?.("STORY_REPAIR_PAUSED", { reason: "EXECUTION_GATE" }); return false; }
      timer = setInterval(() => { void tick(); }, Math.max(2000, pollMs));
      if (timer.unref) timer.unref();
      logger?.info?.("STORY_REPAIR_SCHEDULER_STARTED", { owner: leaseOwner, pollMs });
      return true;
    },
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    tick,
    enabled: () => enabled === true,
    busy: () => running,
    owner: leaseOwner,
    stats: () => Object.freeze({ ...stats })
  });
}
