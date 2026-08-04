// P0 Step 5C.17 — tiny ffmpeg helpers for ElevenLabs narration: concatenate per-chunk MP3s into one file
// and probe an MP3's duration. Local ffmpeg (ffmpeg-static/ffprobe-static), no network, Worker-local files.

import { spawn } from "node:child_process";
import { writeFile, mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ffmpegPaths } from "../media/ffmpeg-locator.mjs";

// FFmpeg is GPL and is NOT bundled: the operator installs it and this resolves where it landed.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

function err(code, message) { return Object.assign(new Error(message), { code }); }
function run(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = "", errText = "", done = false;
    const finish = (fn, a) => { if (done) return; done = true; clearTimeout(t); fn(a); };
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish(reject, err("E_FFMPEG_TIMEOUT", "ffmpeg timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errText += d; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => (code === 0 ? finish(resolve, { out }) : finish(reject, err("E_FFMPEG_FAILED", (errText || out).slice(-300)))));
  });
}

export function createElevenLabsAudioTools({ ffmpegPath = ffmpegStatic, ffprobePath = ffprobeStaticPath } = {}) {
  if (!ffmpegPath || !ffprobePath) throw err("E_FFMPEG_MISSING", "ffmpeg/ffprobe are required");

  async function probeDuration(file) {
    const { out } = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { timeoutMs: 30000 });
    try { const j = JSON.parse(out); const d = Number(j?.format?.duration); return Number.isFinite(d) && d > 0 ? d : null; } catch { return null; }
  }

  // Concatenate MP3 parts into outputPath (re-encoded to a uniform CBR MP3 so joins are seamless even if
  // the parts differ slightly). Returns { sizeBytes, durationSeconds }.
  async function concatAudio(paths, outputPath) {
    const parts = (paths || []).filter(Boolean);
    if (parts.length === 0) throw err("E_ELEVENLABS_CONCAT_EMPTY", "no audio parts to concatenate");
    await mkdir(path.dirname(outputPath), { recursive: true });
    if (parts.length === 1) {
      await run(ffmpegPath, ["-y", "-i", parts[0], "-c:a", "libmp3lame", "-q:a", "2", outputPath]);
    } else {
      const listFile = path.join(path.dirname(outputPath), `.el-concat-${crypto.randomBytes(4).toString("hex")}.txt`);
      const body = parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
      await writeFile(listFile, body, "utf8");
      try {
        await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "libmp3lame", "-q:a", "2", outputPath]);
      } finally { try { await rm(listFile, { force: true }); } catch { /* */ } }
    }
    const info = await stat(outputPath).catch(() => null);
    if (!info || info.size <= 128) throw err("E_ELEVENLABS_CONCAT_FAILED", "concatenation produced no audio");
    const durationSeconds = await probeDuration(outputPath).catch(() => null);
    return { sizeBytes: info.size, durationSeconds };
  }

  return Object.freeze({ probeDuration, concatAudio });
}
