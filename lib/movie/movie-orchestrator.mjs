// P0 Step 5C.26 — movie auto-pipeline orchestrator (thin, durable scheduler).
//
// The pipeline LOGIC lives in the movie control plane (startMoviePipeline / advanceMoviePipeline /
// listActivePipelines) which owns the durable Postgres truth. This module is only the scheduler: on an
// interval it asks the control plane for active pipelines and advances each by ONE idempotent step. It keeps
// a per-project in-flight guard so a slow inline stage (ElevenLabs narration, FFmpeg render) on one project
// never blocks another project's progress, and overlapping ticks are coalesced. Resume-safe: every step is
// re-derived from durable state, so a runtime restart simply re-adopts and continues in-progress pipelines.
//
// No provider work happens here directly — scene video is driven by the frozen 5C.9E generation loop; this
// orchestrator only sequences the movie-level stages (scenes -> narration -> music -> subtitles -> render).

import { asGate } from "../protocol/generation-execution-gate.mjs";

const NOISE_ACTIONS = new Set(["NOT_AUTO", "WAIT_SCENES", "NOT_FOUND", "DONE"]);

export function createMovieOrchestrator({ movie, pollMs = 4000, logger = null, executionGate = null } = {}) {
  if (!movie || typeof movie.advanceMoviePipeline !== "function" || typeof movie.listActivePipelines !== "function") {
    throw new TypeError("createMovieOrchestrator requires a movie control plane with listActivePipelines + advanceMoviePipeline");
  }
  // P0 Step 5C.29 Phase 0 — maintenance pause. A paused orchestrator NEVER advances a pipeline, so a movie
  // left in GENERATING (with PLANNED scenes) cannot schedule scene generation, narration, or a render on a
  // restart. The movie's durable state is untouched — it simply stops being driven until execution resumes.
  const gate = asGate(executionGate);
  let timer = null;
  let stopped = false;
  let ticking = false;
  const inFlight = new Set();

  async function advanceOne(projectId) {
    if (inFlight.has(projectId)) return null;
    inFlight.add(projectId);
    try {
      const r = await movie.advanceMoviePipeline({ projectId });
      if (r && r.action && !NOISE_ACTIONS.has(r.action)) {
        logger?.info?.("MOVIE_PIPELINE_STEP", { projectId, action: r.action, stage: r.stage || null, reason: r.reason || null });
      }
      return r;
    } catch (e) {
      logger?.warn?.("MOVIE_PIPELINE_ERROR", { projectId, code: (e && e.code) || null });
      return { projectId, action: "ERROR", code: (e && e.code) || null };
    } finally {
      inFlight.delete(projectId);
    }
  }

  // One scheduling pass. Launches per-project advances (each guarded so it never overlaps itself). By default
  // it is fire-and-forget so a long render on one project does not stall the loop; pass { wait:true } (tests)
  // to await every advance started this pass.
  async function tick({ wait = false } = {}) {
    if (gate.blocked()) return []; // maintenance pause: never advance any pipeline (no scene/narration/render)
    if (ticking || stopped) return [];
    ticking = true;
    let started = [];
    try {
      const ids = await movie.listActivePipelines();
      const promises = [];
      for (const id of ids) {
        if (inFlight.has(id)) continue;
        started.push(id);
        const p = advanceOne(id);
        promises.push(p);
      }
      if (wait) return await Promise.all(promises);
    } catch (e) {
      logger?.warn?.("MOVIE_PIPELINE_TICK_ERROR", { code: (e && e.code) || null });
    } finally {
      ticking = false;
    }
    return started;
  }

  return Object.freeze({
    start() {
      if (timer || stopped) return;
      if (gate.blocked()) { logger?.info?.("MOVIE_PIPELINE_PAUSED", { startupAutoResumeBlocked: true }); return; }
      timer = setInterval(() => { void tick(); }, Math.max(1000, pollMs));
      if (timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    tick,
    _inFlight: inFlight
  });
}
