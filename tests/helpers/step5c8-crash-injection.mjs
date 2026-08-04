// P0 Step 5C.8B2 — deterministic, TEST-ONLY crash / pause injection controller.
//
// SAFETY CONTRACT:
//   - Injection is enabled ONLY by env the Step 5C.8 test runner sets (S5C8_CRASH_AT / S5C8_PAUSE_AT).
//     Absent config → every hook is a NO-OP. Production entry points never import this module and
//     never expose these controls.
//   - Reaching a crash window is proven by a DURABLE MARKER FILE (never an arbitrary sleep).
//   - A crash is a real hard process exit (process.exit(137)) AFTER the marker is durably written.
//   - A pause is a deterministic wait for a RELEASE FILE the harness creates (poll a durable file),
//     used to open an exact race window (e.g. Cancel during SUBMITTING) without timing luck.
//
// Injection points (durable transition boundaries derived from source):
//   AFTER_OFFER_RECEIVED          — worker got JOB_OFFER, before it is processed/accepted (scenario 4)
//   BEFORE_MARK_SUBMITTING        — handler entered, before ctx.markSubmitting + provider (scenario 5/11)
//   AFTER_MARK_SUBMITTING         — SUBMITTING+ordinal=1 persisted, before provider invoke (scenario 6/12)
//   AFTER_INVOKE_START            — provider op started (uncertain), before submitted/media (scenario 7)
//   AFTER_LOCAL_RESULT            — media on disk + markLocalResult, before terminal emit (scenario 8)

import { mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";

export const CRASH_POINTS = Object.freeze([
  "AFTER_OFFER_RECEIVED", "BEFORE_MARK_SUBMITTING", "AFTER_MARK_SUBMITTING", "AFTER_INVOKE_START", "AFTER_LOCAL_RESULT"
]);

// createCrashController({ crashAt, pauseAt, markersDir, releaseFile, exit, now, poll }): env-driven by
// default; every field injectable for the runtime unit test (so no real process exit is needed there).
export function createCrashController({
  crashAt = process.env.S5C8_CRASH_AT || null,
  pauseAt = process.env.S5C8_PAUSE_AT || null,
  markersDir = process.env.S5C8_MARKERS || null,
  releaseFile = process.env.S5C8_RELEASE || null,
  exit = (code) => process.exit(code),
  emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`),
  sleepMs = 40
} = {}) {
  const dir = markersDir || null;
  function ensureDir() { if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true }); }
  function writeMarker(name, data) {
    if (!dir) return;
    ensureDir();
    const file = path.join(dir, `${name}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ point: name, pid: process.pid, ...data }, null, 2)}\n`, "utf8");
    renameSync(tmp, file); // atomic — the harness polls for this file
  }

  return {
    crashAt, pauseAt, armed: Boolean(crashAt || pauseAt),
    // maybeCrash(point, ctx): if this is the configured crash point, durably mark + hard-exit.
    maybeCrash(point, ctx = {}) {
      if (!crashAt || point !== crashAt) return;
      writeMarker(`crash-${point}`, { ...safe(ctx), at: "crash" });
      try { emit({ event: "crash-injected", point, ...safe(ctx) }); } catch { /* stdout may be gone */ }
      exit(137); // real hard crash — no cleanup, no terminal emission
    },
    // waitRelease(point, ctx): if this is the configured pause point, durably mark "paused" and block
    // until the harness drops the release file. Opens an exact race window deterministically.
    async waitRelease(point, ctx = {}) {
      if (!pauseAt || point !== pauseAt) return;
      writeMarker(`paused-${point}`, { ...safe(ctx), at: "pause" });
      try { emit({ event: "paused", point, ...safe(ctx) }); } catch { /* */ }
      const rel = releaseFile || (dir ? path.join(dir, `release-${point}`) : null);
      if (!rel) return;
      // Poll a durable file (no arbitrary sleep-as-proof; the harness controls the release).
      /* eslint-disable no-await-in-loop */
      for (;;) { if (existsSync(rel)) return; await new Promise((r) => setTimeout(r, sleepMs)); }
    }
  };
}

// Only allow safe, non-secret context into markers (ids + relative paths). Never credentials/paths.
function safe(ctx) {
  const out = {};
  for (const k of ["jobId", "generationAttemptId", "opId", "artifactId", "relativePath"]) {
    if (ctx && ctx[k] != null && typeof ctx[k] !== "object") out[k] = String(ctx[k]);
  }
  return out;
}
