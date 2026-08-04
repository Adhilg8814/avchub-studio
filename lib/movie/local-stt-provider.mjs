// P0 Step 5C.46 — the local ear, as a capability the pipeline can ask for.
//
// Wraps the faster-whisper runner in an isolated venv under the owner tree. The routing gate asks
// `available()` before anything else and keeps ElevenLabs when the answer is no — so a missing model degrades
// to "we did not listen", never to "there was nothing to hear".
//
// No network at inference time, no provider, no cost. The model lives on disk; transcription is CPU work on
// a host with 64 of them.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { defaultStudioHome } from "../paths.mjs";

export const STT_ERRORS = Object.freeze({
  UNAVAILABLE: "E_STT_UNAVAILABLE",
  FAILED: "E_STT_FAILED",
  TIMEOUT: "E_STT_TIMEOUT"
});

// Whisper's own codes for the languages this system produces. A model that cannot claim these is not a
// capability for this pipeline, whatever else it can do.
export const REQUIRED_LANGUAGES = Object.freeze(["da", "sv", "bg", "en", "vi"]);

/**
 * @param {object} opts
 *   ownerRoot   — AVC_STUDIO_HOME; the venv and model cache live under it, never in the repo
 *   scriptPath  — the runner
 *   model       — whisper size. `small` is the smallest multilingual weight that is honest about Bulgarian
 *                 and Vietnamese; tiny/base guess at them and a guessed transcript is worse than none.
 */
export function createLocalSttProvider({
  ownerRoot = process.env.AVC_STUDIO_HOME || defaultStudioHome(),
  repoRoot = null,
  model = "small",
  threads = 16,
  timeoutMs = 300_000
} = {}) {
  const python = path.join(ownerRoot, "stt", "venv", "Scripts", "python.exe");
  const modelRoot = path.join(ownerRoot, "stt", "models");
  const runner = repoRoot ? path.join(repoRoot, "scripts", "stt", "local-transcribe.py") : null;

  function available() {
    return Boolean(runner && existsSync(python) && existsSync(runner) && existsSync(modelRoot));
  }

  function describe() {
    return Object.freeze({
      available: available(),
      engine: "faster-whisper",
      model,
      languages: REQUIRED_LANGUAGES,
      wordTimestamps: true,
      python: existsSync(python), runner: Boolean(runner) && existsSync(runner), models: existsSync(modelRoot),
      // Stated so a capability audit can record WHY it is unavailable rather than only that it is.
      missing: [
        existsSync(python) ? null : "interpreter",
        runner && existsSync(runner) ? null : "runner",
        existsSync(modelRoot) ? null : "model cache"
      ].filter(Boolean)
    });
  }

  async function transcribeLocal({ audioPath, language = null } = {}) {
    if (!available()) throw Object.assign(new Error("local speech-to-text is not installed on this host"), { code: STT_ERRORS.UNAVAILABLE, detail: describe() });
    if (!audioPath || !existsSync(audioPath)) throw Object.assign(new Error("the media file is not present"), { code: STT_ERRORS.FAILED });

    const args = [runner, "--audio", audioPath, "--model", model, "--model-root", modelRoot, "--threads", String(threads)];
    if (language) args.push("--language", String(language).slice(0, 5));

    const out = await new Promise((resolve) => {
      // 5C.48 — UTF-8 on both ends of the pipe. The interpreter writes the transcript as UTF-8 (the runner
      // reconfigures its own streams too) and this side decodes it as UTF-8, so "søndagen" survives and a
      // Cyrillic transcript does not raise inside the child's print. Left to the Windows code page, both
      // failures are indistinguishable from a model that cannot hear the language.
      const p = spawn(python, args, { windowsHide: true, env: { ...process.env, HF_HUB_DISABLE_SYMLINKS: "1", HF_HUB_OFFLINE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
      let stdout = "", stderr = "";
      p.stdout.setEncoding("utf8");
      p.stderr.setEncoding("utf8");
      const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* already gone */ } }, timeoutMs);
      p.stdout.on("data", (d) => { stdout += d; });
      p.stderr.on("data", (d) => { stderr += d; });
      p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: String(e && e.message) }); });
      p.on("close", (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    });

    // The runner prints one JSON object on the last non-empty line; model loading writes warnings before it.
    const line = String(out.stdout || "").trim().split("\n").filter(Boolean).pop();
    let parsed = null;
    try { parsed = line ? JSON.parse(line) : null; } catch { parsed = null; }
    if (!parsed) throw Object.assign(new Error("the transcriber produced no readable result"), { code: STT_ERRORS.FAILED, detail: String(out.stderr || "").slice(0, 200) });
    if (parsed.ok !== true) throw Object.assign(new Error(parsed.detail || "transcription failed"), { code: parsed.code || STT_ERRORS.FAILED });

    return Object.freeze({
      text: String(parsed.text || ""),
      detectedLanguage: parsed.detectedLanguage || null,
      languageProbability: parsed.languageProbability ?? null,
      confidence: parsed.confidence ?? null,
      noSpeechProbability: parsed.noSpeechProbability ?? null,
      durationSeconds: parsed.durationSeconds ?? null,
      speechSeconds: parsed.speechSeconds ?? null,
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      words: Array.isArray(parsed.words) ? parsed.words : [],
      model: parsed.model || model,
      engine: parsed.engine || "faster-whisper",
      processingSeconds: parsed.processingSeconds ?? null
    });
  }

  /**
   * Word timings good enough to cut subtitles from.
   *
   * The gate asks for this separately from the transcript, because a narration nobody can align is a narration
   * that cannot carry captions — and a film whose captions were estimated is exactly what 5C.36 and 5C.39
   * spent two milestones removing.
   */
  async function alignLocal({ audioPath, language = null } = {}) {
    const t = await transcribeLocal({ audioPath, language });
    const words = t.words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
    return Object.freeze({
      available: words.length > 0,
      words, segments: t.segments,
      coverageSeconds: words.length ? Number((words[words.length - 1].end - words[0].start).toFixed(3)) : 0,
      durationSeconds: t.durationSeconds,
      // What fraction of the clip the aligned words actually span. A narration that covers a second of a
      // six-second shot is not an alignment, it is a fragment.
      timestampCoverage: t.durationSeconds && words.length
        ? Number(Math.min(1, (words[words.length - 1].end - words[0].start) / t.durationSeconds).toFixed(4))
        : 0
    });
  }

  return Object.freeze({ kind: "LOCAL_WHISPER", available, describe, transcribeLocal, alignLocal });
}
