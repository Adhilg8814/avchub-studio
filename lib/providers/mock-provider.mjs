// A provider that generates nothing and costs nothing.
//
// Exists so the whole pipeline — plan, submit, poll, fetch, decode, classify, assemble — can be exercised in
// tests, in CI, and in the demo without an account anywhere. It writes a real MP4 (via the configured FFmpeg)
// at exactly the size and length that was asked for, so the asset classifier sees a genuine decoded file
// rather than a stub that would make every verdict meaningless.
//
// It is also useful as a reference: this is the smallest thing that satisfies the plugin contract.

import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../media/ffmpeg-locator.mjs";

const run = promisify(execFile);

const DIMENSIONS = Object.freeze({
  "9:16": { "480p": [480, 854], "720p": [720, 1280], "1080p": [1080, 1920] },
  "16:9": { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080] },
  "1:1": { "480p": [480, 480], "720p": [720, 720], "1080p": [1080, 1080] }
});

// Deterministic colour per submission so a human watching the demo can tell two clips apart, and so a test
// asserting "scene 2 is not scene 1" has something to assert on. No randomness: same input, same bytes.
const PALETTE = ["#1f2933", "#2b4162", "#3d5a4c", "#5c3a4e", "#4a4231"];

export function createMockProvider({ outputDir, ffmpegPath = null, clock = () => 0 } = {}) {
  if (!outputDir) throw new Error("createMockProvider requires an outputDir");
  const submissions = new Map();
  let counter = 0;

  return {
    id: "MOCK",

    describe: () => ({
      aspectRatios: Object.keys(DIMENSIONS),
      durationOptions: ["2s", "6s", "10s", "15s"],
      resolutions: ["480p", "720p", "1080p"]
    }),

    async submit({ prompt = "", plan = {} } = {}) {
      const submissionId = `mock_${String(++counter).padStart(6, "0")}`;
      submissions.set(submissionId, { state: "PENDING", prompt, plan, at: clock() });
      return { submissionId, state: "PENDING" };
    },

    // One poll is enough: nothing is actually running, and a fake delay would only make tests slower without
    // making them more truthful about a real provider's timing.
    async poll(submissionId) {
      const s = submissions.get(submissionId);
      if (!s) return { state: "FAILED", failureReason: "unknown submission" };
      s.state = "SUCCEEDED";
      return { state: "SUCCEEDED" };
    },

    async fetch(submissionId) {
      const s = submissions.get(submissionId);
      if (!s || s.state !== "SUCCEEDED") throw new Error(`submission ${submissionId} is not ready`);
      const aspect = s.plan.aspectRatio || "9:16";
      const resolution = s.plan.resolution || "720p";
      const [w, h] = DIMENSIONS[aspect]?.[resolution] || DIMENSIONS["9:16"]["720p"];
      const seconds = Number.isFinite(s.plan.durationSeconds) && s.plan.durationSeconds > 0 ? s.plan.durationSeconds : 6;
      const colour = PALETTE[(counter + submissionId.length) % PALETTE.length];

      await mkdir(outputDir, { recursive: true });
      const filePath = path.join(outputDir, `${submissionId}.mp4`);
      const ffmpeg = ffmpegPath || (await resolveFfmpeg()).ffmpeg;
      await run(ffmpeg, [
        "-y", "-f", "lavfi",
        "-i", `color=c=${colour.replace("#", "0x")}:s=${w}x${h}:d=${seconds}:r=24`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
        filePath
      ]);
      // The prompt travels beside the clip rather than inside it: a sidecar keeps the demo inspectable
      // without pretending the mock rendered any of the words.
      await writeFile(`${filePath}.prompt.txt`, s.prompt, "utf8");
      return { filePath };
    },

    async dispose() { submissions.clear(); }
  };
}

export default createMockProvider;
