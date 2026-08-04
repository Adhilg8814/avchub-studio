// P0 Step 5C.20 — ElevenLabs API SpeechProvider (kind ELEVENLABS_API).
//
// Presents the SAME SpeechProvider contract the Movie Factory consumes ({ kind, listVoices, synthesize })
// but produces narration by calling the OFFICIAL ElevenLabs HTTPS API (server-side, DPAPI-encrypted key)
// through the certified createElevenLabsApiProvider — NOT the browser. This is the PRIMARY TTS provider;
// ELEVENLABS_WEB is the fallback and Windows SAPI the local floor. There is NO silent cross-provider
// fallback here: a failure surfaces its provider code so the caller (and the TTS job ledger) sees exactly
// which provider was selected and why.
//
// Voice identity is the OFFICIAL voice_id (canonical), never a display name or a web-observed avatar token.
// A tagged voiceId ("<official_id>") wins; otherwise the locale is resolved against the persisted voice map.

import path from "node:path";
import { createHash } from "node:crypto";
import { chunkNarration } from "./elevenlabs-web.mjs";

function err(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

export function createElevenLabsApiSpeechProvider({
  apiProvider,            // certified provider: { synthesize({text, officialVoiceId, modelId, outputFormat, outputPath, idempotencyKey}) }
  accountId,              // el_… the key belongs to (for provenance; the provider already binds the key)
  voiceMap = {},          // { "<locale>": { officialVoiceId, displayName, ... } } — persisted resolution
  model = "eleven_multilingual_v2",
  outputFormat = "mp3_44100_128",
  probeDuration = null,   // async (path) => seconds | null
  concatAudio = null,     // async (paths[], outputPath) => { sizeBytes, durationSeconds }
  markUsed = null,        // async ({ chars }) => void
  maxCharsPerChunk = 2500
} = {}) {
  if (!apiProvider || typeof apiProvider.synthesize !== "function") return null;
  const VALID_ID = /^[A-Za-z0-9]{16,40}$/; // ElevenLabs official voice_id shape

  // The selectable voices = every mapped locale's official voice (id = official voice_id).
  function listVoices() {
    const out = new Map();
    for (const [locale, v] of Object.entries(voiceMap || {})) {
      if (v && v.officialVoiceId) out.set(`${v.officialVoiceId}|${locale}`, { id: v.officialVoiceId, name: v.displayName || v.officialVoiceId, culture: locale, model, source: "api-map", accountId });
    }
    return Array.from(out.values());
  }

  // Resolve the official voice_id: an explicit tagged voiceId wins; else the locale map. Never a display name.
  function resolveOfficialVoiceId(voiceId, locale) {
    const vid = (typeof voiceId === "string" ? voiceId.trim() : "");
    if (vid && VALID_ID.test(vid)) return vid;
    const m = locale && voiceMap && voiceMap[locale] ? voiceMap[locale] : null;
    if (m && m.officialVoiceId) return m.officialVoiceId;
    return null;
  }

  async function synthesize({ text, voiceId = null, rate = 0, outputPath, locale = null } = {}) {
    if (typeof text !== "string" || text.trim().length < 1) throw err("E_TTS_EMPTY", "narration text is required");
    if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) throw err("E_TTS_OUTPUT", "absolute output path required");
    const officialVoiceId = resolveOfficialVoiceId(voiceId, locale);
    if (!officialVoiceId) throw err("E_ELEVENLABS_VOICE_CONFIGURATION_REQUIRED", "No ElevenLabs API voice mapped for this locale/voice", { locale });

    const chunks = chunkNarration(text, { maxChars: maxCharsPerChunk });
    if (chunks.length === 0) throw err("E_TTS_EMPTY", "narration produced no synthesizable text");

    const dir = path.dirname(outputPath);
    const partPaths = [];
    let totalBytes = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      const partOut = chunks.length === 1 ? outputPath : path.join(dir, `${path.basename(outputPath, path.extname(outputPath))}.part${String(i + 1).padStart(3, "0")}.mp3`);
      const idk = createHash("sha256").update(`${officialVoiceId}|${model}|${outputFormat}|${chunks[i]}|${partOut}`).digest("hex");
      const r = await apiProvider.synthesize({ text: chunks[i], officialVoiceId, modelId: model, outputFormat, outputPath: partOut, idempotencyKey: idk });
      if (!r || r.ok === false || !(Number(r.sizeBytes) > 0)) throw err(r && r.code ? `E_ELEVENLABS_API_${r.code}` : "E_ELEVENLABS_API_SYNTHESIS_FAILED", `chunk ${i + 1}/${chunks.length} produced no audio`, { providerCode: r && r.code });
      partPaths.push(r.path || partOut);
      totalBytes += Number(r.sizeBytes || 0);
    }

    let finalBytes = totalBytes, finalDuration = 0;
    if (chunks.length > 1) {
      if (typeof concatAudio !== "function") throw err("E_ELEVENLABS_CONCAT_UNAVAILABLE", "multi-chunk narration needs an audio concatenator");
      const cat = await concatAudio(partPaths, outputPath);
      finalBytes = Number(cat && cat.sizeBytes) > 0 ? Number(cat.sizeBytes) : totalBytes;
      if (Number(cat && cat.durationSeconds) > 0) finalDuration = Number(cat.durationSeconds);
    }
    if (!(finalDuration > 0) && typeof probeDuration === "function") { try { const d = await probeDuration(outputPath); if (Number(d) > 0) finalDuration = Number(d); } catch { /* */ } }

    if (typeof markUsed === "function") { try { await markUsed({ chars: text.length }); } catch { /* usage accounting is best-effort */ } }
    return Object.freeze({ relativePathAbs: outputPath, sizeBytes: finalBytes, container: "mp3", durationSeconds: finalDuration > 0 ? finalDuration : null, provider: "ELEVENLABS_API", accountId: accountId || null, voiceName: officialVoiceId, chunks: chunks.length });
  }

  /**
   * P0 Step 5C.48 — the alignment the pipeline has been asking for since 5C.39.
   *
   * `/with-timestamps` is the SAME synthesis as the plain endpoint: same voice, same model, one unit of
   * quota, plus the character timings. The certified provider has been able to call it since 5C.39, but this
   * shell — the object the movie control plane actually holds — never exposed it, so the control plane's
   * `typeof speech.synthesizeWithTimestamps === "function"` check was false on every real runtime and every
   * film fell back to plain synthesis. No alignment artifact, no measured subtitles, and subtitleAlignment
   * permanently UNMEASURED, which is a hard dimension: no film could become PUBLISHABLE.
   *
   * ONE call, deliberately. Chunked narration would return several alignments, each believing it starts at
   * zero, and stitching them is how a film's back half drifts. Text that would need chunking is refused here
   * rather than silently aligned wrongly — a short-form beat is never near the limit.
   */
  async function synthesizeWithTimestamps({ text, voiceId = null, rate = 0, outputPath, locale = null, languageCode = null } = {}) {
    if (typeof apiProvider.synthesizeWithTimestamps !== "function") return { ok: false, code: "E_ELEVENLABS_ALIGNMENT_UNSUPPORTED" };
    if (typeof text !== "string" || text.trim().length < 1) throw err("E_TTS_EMPTY", "narration text is required");
    if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) throw err("E_TTS_OUTPUT", "absolute output path required");
    const officialVoiceId = resolveOfficialVoiceId(voiceId, locale);
    if (!officialVoiceId) throw err("E_ELEVENLABS_VOICE_CONFIGURATION_REQUIRED", "No ElevenLabs API voice mapped for this locale/voice", { locale });
    if (chunkNarration(text, { maxChars: maxCharsPerChunk }).length > 1) {
      return { ok: false, code: "E_ELEVENLABS_ALIGNMENT_TOO_LONG" };
    }
    const idk = createHash("sha256").update(`ts|${officialVoiceId}|${model}|${outputFormat}|${text}|${outputPath}`).digest("hex");
    // The language the voice is being ASKED to speak. Passed through because the provider uses it to select
    // pronunciation, and leaving it out is how a multilingual model reads Danish as English — but as the
    // ISO-639-1 subtag the API actually accepts. "en-US" is a locale, not a language code.
    const wanted = String(languageCode || locale || "").slice(0, 2).toLowerCase();
    const lang = /^[a-z]{2}$/u.test(wanted) ? wanted : null;
    let r = await apiProvider.synthesizeWithTimestamps({
      text, officialVoiceId, modelId: model, outputFormat, outputPath, idempotencyKey: idk, languageCode: lang
    });
    // A model that refuses to be pinned to a language rejects the REQUEST — no audio, no credits — so asking
    // again without the hint costs nothing and is the difference between a film with a measured timeline and a
    // film that silently falls back to estimated timings.
    if ((!r || r.ok !== true) && lang) {
      r = await apiProvider.synthesizeWithTimestamps({
        text, officialVoiceId, modelId: model, outputFormat, outputPath,
        idempotencyKey: `${idk}-nolang`, languageCode: null
      });
    }
    if (!r || r.ok !== true) return { ok: false, code: r && r.code ? `E_ELEVENLABS_API_${r.code}` : "E_ELEVENLABS_API_SYNTHESIS_FAILED" };
    let durationSeconds = null;
    if (typeof probeDuration === "function") { try { const d = await probeDuration(outputPath); if (Number(d) > 0) durationSeconds = Number(d); } catch { /* the alignment still stands */ } }
    if (typeof markUsed === "function") { try { await markUsed({ chars: text.length }); } catch { /* usage accounting is best-effort */ } }
    return Object.freeze({
      ok: true, relativePathAbs: outputPath, sizeBytes: r.sizeBytes, container: "mp3",
      durationSeconds, provider: "ELEVENLABS_API", accountId: accountId || null, voiceName: officialVoiceId,
      chunks: 1, sha256: r.sha256 || null, idempotencyKey: r.idempotencyKey || idk,
      alignment: r.alignment || null, alignmentSource: r.alignmentSource || null,
      alignmentAvailable: r.alignmentAvailable === true
    });
  }

  return Object.freeze({ kind: "ELEVENLABS_API", listVoices, synthesize, synthesizeWithTimestamps });
}
