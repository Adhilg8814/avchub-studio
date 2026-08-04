// P0 Step 5C.11 — SpeechProvider (TTS) abstraction + Windows SAPI adapter.
//
// A local, credential-free narration source: enumerates the installed system voices and synthesizes
// a WAV per scene via System.Speech.Synthesis (PowerShell). It NEVER calls a network endpoint, asks
// for a token, or bypasses a security challenge. The adapter is injected so the control-plane facade
// stays OS-agnostic; a manual-upload provider is the fallback when no voice/language is available.
// Text is passed as base64 (never string-interpolated into the shell). Exactly-once is enforced by
// the caller (one synthesize per audioAttemptId); this module is a pure effect.

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

function err(code, message) { return Object.assign(new Error(message), { code }); }

function runPs(psPath, script, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(psPath, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true });
    let out = "", errText = "", done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(t); fn(arg); };
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish(reject, err("E_TTS_TIMEOUT", "TTS timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errText += d; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => (code === 0 ? finish(resolve, out) : finish(reject, err("E_TTS_FAILED", (errText || out).slice(-300)))));
    child.stdin.write(script); child.stdin.end();
  });
}

// WAV duration from the RIFF header (avoids a second ffprobe spawn for a simple PCM WAV).
async function wavDurationSeconds(file) {
  const { open } = await import("node:fs/promises");
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(44); await fh.read(head, 0, 44, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null;
    const byteRate = head.readUInt32LE(28);
    const info = await fh.stat();
    const dataBytes = info.size - 44;
    return byteRate > 0 ? Math.max(0, dataBytes / byteRate) : null;
  } catch { return null; } finally { await fh.close(); }
}

export function createWindowsSapiSpeechProvider({ powershellPath = "powershell.exe" } = {}) {
  async function listVoices() {
    const script = "Add-Type -AssemblyName System.Speech;(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices()|Where-Object{$_.Enabled}|ForEach-Object{$_.VoiceInfo.Name+'|'+$_.VoiceInfo.Culture.Name+'|'+$_.VoiceInfo.Gender}";
    let out = "";
    try { out = await runPs(powershellPath, script, { timeoutMs: 20_000 }); } catch { return []; }
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [name, culture, gender] = l.split("|"); return { id: name, name, culture: culture || null, gender: gender || null }; });
  }

  // Synthesize `text` to a WAV at outputPath. voiceId is a system voice name; rate is -10..10.
  async function synthesize({ text, voiceId = null, rate = 0, outputPath }) {
    if (typeof text !== "string" || text.trim().length < 1) throw err("E_TTS_EMPTY", "narration text is required");
    if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) throw err("E_TTS_OUTPUT", "absolute output path required");
    await mkdir(path.dirname(outputPath), { recursive: true });
    const b64 = Buffer.from(text, "utf8").toString("base64");
    const r = Math.max(-10, Math.min(10, Math.round(Number(rate) || 0)));
    const selectVoice = voiceId ? `try{$syn.SelectVoice([String]([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(String(voiceId), "utf8").toString("base64")}'))))}catch{}` : "";
    const outB64 = Buffer.from(outputPath, "utf8").toString("base64");
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      selectVoice,
      `$syn.Rate = ${r}`,
      `$out = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${outB64}'))`,
      "$syn.SetOutputToWaveFile($out)",
      `$txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`,
      "$syn.Speak($txt)",
      "$syn.Dispose()",
      "'OK'"
    ].join(";");
    await runPs(powershellPath, script, { timeoutMs: 120_000 });
    const info = await stat(outputPath).catch(() => null);
    if (!info || !info.isFile() || info.size <= 44) throw err("E_TTS_NO_OUTPUT", "TTS produced no audio");
    const duration = await wavDurationSeconds(outputPath);
    return { relativePathAbs: outputPath, sizeBytes: info.size, container: "wav", durationSeconds: duration };
  }

  return Object.freeze({ kind: "WINDOWS_SAPI", listVoices, synthesize });
}

// Manual/upload fallback: no synthesis; the user provides audio. Used when no system voice matches
// the language, or TTS is unavailable — the milestone must not be blocked by TTS.
export function createManualUploadSpeechProvider() {
  return Object.freeze({
    kind: "MANUAL_UPLOAD",
    async listVoices() { return []; },
    async synthesize() { throw err("E_TTS_UNAVAILABLE", "No TTS voice available; upload a voiceover instead"); }
  });
}
