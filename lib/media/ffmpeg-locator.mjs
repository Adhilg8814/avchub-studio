// Where FFmpeg is, without shipping it.
//
// FFmpeg is GPL. Bundling the binary would put this project's distribution under obligations it is not set up
// to meet, so the operator installs FFmpeg and this module finds it. Resolution order:
//
//   1. FFMPEG_PATH / FFPROBE_PATH   — explicit, wins over everything
//   2. the `ffmpeg-static` / `ffprobe-static` packages, IF an installation chose to add them itself
//   3. `ffmpeg` / `ffprobe` on PATH
//
// A miss is a hard, named error with the install instruction in it. Silently degrading to "no video output"
// is the failure mode this ordering exists to prevent.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// Resolved synchronously, because most call sites take the paths as default parameter values and cannot await.
// An installation that adds ffmpeg-static itself keeps working exactly as before; one that does not falls
// through to PATH.
function fromOptionalPackageSync(name) {
  try {
    const value = require(name);
    const resolved = typeof value === "string" ? value : value?.path;
    return typeof resolved === "string" && resolved.length ? resolved : null;
  } catch { return null; }
}

export const FFMPEG_ERRORS = Object.freeze({
  NOT_FOUND: "E_FFMPEG_NOT_FOUND",
  NOT_EXECUTABLE: "E_FFMPEG_NOT_EXECUTABLE"
});

const INSTALL_HINT = "install FFmpeg (https://ffmpeg.org/download.html) and put ffmpeg/ffprobe on PATH, or set FFMPEG_PATH and FFPROBE_PATH";

function err(code, message, detail = {}) { return Object.assign(new Error(message), { code, detail }); }


async function usable(binary) {
  try { await run(binary, ["-version"], { timeout: 10_000 }); return true; }
  catch { return false; }
}

let cached = null;

/**
 * Resolve both binaries once per process.
 *
 * `refresh: true` re-resolves, which matters in tests that change the environment; everything else takes the
 * cache, because probing two binaries on every scene render is wasted work.
 */
export async function resolveFfmpeg({ env = process.env, refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const ffmpeg = env.FFMPEG_PATH || fromOptionalPackageSync("ffmpeg-static") || "ffmpeg";
  const ffprobe = env.FFPROBE_PATH || fromOptionalPackageSync("ffprobe-static") || "ffprobe";

  for (const [label, binary] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe]]) {
    if (!(await usable(binary))) {
      throw err(FFMPEG_ERRORS.NOT_FOUND, `${label} was not found or would not run (${binary}) — ${INSTALL_HINT}`, { label, binary });
    }
  }

  cached = Object.freeze({ ffmpeg, ffprobe });
  return cached;
}

/** The paths without probing — for call sites that only need to spawn and will surface their own failure. */
export function ffmpegPaths(env = process.env) {
  return Object.freeze({
    ffmpeg: env.FFMPEG_PATH || fromOptionalPackageSync("ffmpeg-static") || "ffmpeg",
    ffprobe: env.FFPROBE_PATH || fromOptionalPackageSync("ffprobe-static") || "ffprobe"
  });
}

/** Test seam: forget what was resolved. */
export function resetFfmpegCache() { cached = null; }
