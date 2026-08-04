// P0 Step 5C.19 — ElevenLabs API provider (ELEVENLABS_API), a SERVER-SIDE HTTPS adapter.
//
// Distinct from ELEVENLABS_WEB (which drives the owner's browser). This talks to api.elevenlabs.io directly
// with the `xi-api-key` header read from the DPAPI-encrypted key store — NEVER from the frontend, never a
// direct browser call. All failures are classified (never a silent Web↔API fallback). Synthesis is durable:
// one request per idempotencyKey, bounded safe retry only on transient network/5xx, audio validated + SHA-256'd.
// The key is fetched per call and never returned/logged.

import { createHash } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://api.elevenlabs.io";

// Map an HTTP status + body to a stable provider error code.
function classify(status, bodyText) {
  const b = String(bodyText || "").toLowerCase();
  if (status === 401) return "API_KEY_INVALID";
  if (status === 403) return (b.includes("ip") || b.includes("address")) ? "IP_NOT_ALLOWED" : "API_PERMISSION_DENIED";
  if (status === 422 && b.includes("voice")) return "VOICE_NOT_FOUND";
  if (status === 429 || b.includes("quota") || b.includes("limit")) return "API_QUOTA_EXHAUSTED";
  return "PROVIDER_ERROR";
}

export function createElevenLabsApiProvider({
  keyStore, fetchImpl = globalThis.fetch, apiBase = API_BASE, ledger = null, now = () => Date.now()
} = {}) {
  if (!keyStore || typeof fetchImpl !== "function") return null;
  const idem = new Map(); // idempotencyKey -> result (in-memory de-dupe within a run)

  async function call(pathname, { method = "GET", json = null, form = null, raw = false, timeoutMs = 30000 } = {}) {
    const key = await keyStore.getKey();
    if (!key) return { ok: false, code: "API_KEY_NOT_CONFIGURED" };
    const headers = { "xi-api-key": key, "accept": raw ? "audio/mpeg" : "application/json" };
    if (json) headers["content-type"] = "application/json";
    // multipart: the runtime sets content-type with its own boundary, so setting it here would corrupt the body.
    let res;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* */ } }, timeoutMs) : null;
    if (timer && typeof timer.unref === "function") timer.unref(); // never keep the process alive / crash on exit
    try {
      res = await fetchImpl(`${apiBase}${pathname}`, { method, headers, body: form || (json ? JSON.stringify(json) : undefined), signal: ctrl ? ctrl.signal : undefined });
    } catch { if (timer) clearTimeout(timer); return { ok: false, code: "PROVIDER_ERROR", transient: true }; }
    finally { if (timer) clearTimeout(timer); }
    if (res.status >= 200 && res.status < 300) {
      // Parse JSON here for callers that want a body rather than a stream. `res` is left untouched so every
      // existing caller keeps working exactly as before.
      if (raw) return { ok: true, res };
      let parsed = null;
      try { parsed = await res.clone().json(); } catch { parsed = null; }
      return { ok: true, res, json: parsed };
    }
    let text = "";
    try { text = await res.text(); } catch { /* */ }
    return { ok: false, code: classify(res.status, text), status: res.status, transient: res.status >= 500 };
  }

  // Auth check WITHOUT generating audio, permission-tolerant: a RESTRICTED key (text_to_speech / voices
  // only) cannot read /v1/user/subscription (needs user_read) — fall back to /v1/voices for the auth proof.
  async function testConnection() {
    const sub = await call("/v1/user/subscription");
    if (sub.ok) {
      let s = null; try { s = await sub.res.json(); } catch { /* */ }
      try { await keyStore.setHealth({ lastHealth: "ok" }); } catch { /* */ }
      return { ok: true, usage: s ? { characterCount: s.character_count, characterLimit: s.character_limit, tier: s.tier } : null };
    }
    // subscription is unreadable for a restricted key — prove auth + voices access instead
    const vs = await call("/v1/voices");
    if (vs.ok) { try { await keyStore.setHealth({ lastHealth: "ok" }); } catch { /* */ } return { ok: true, usage: null, note: "restricted_key_no_user_read" }; }
    // both failed: a 401 anywhere means the key itself is invalid; otherwise surface the voices error
    const code = (sub.code === "API_KEY_INVALID" || vs.code === "API_KEY_INVALID") ? "API_KEY_INVALID" : vs.code;
    try { await keyStore.setHealth({ lastHealth: code }); } catch { /* */ }
    return { ok: false, code };
  }

  // Official voice list (voice_id is the CANONICAL identity — never the web-observed avatar token).
  async function listVoices() {
    const r = await call("/v1/voices");
    if (!r.ok) return { ok: false, code: r.code, voices: [] };
    let j = null; try { j = await r.res.json(); } catch { /* */ }
    const voices = ((j && j.voices) || []).map((v) => ({
      officialVoiceId: v.voice_id, displayName: v.name || "",
      category: v.category || null, previewUrl: v.preview_url ? "present" : null,
      labels: v.labels && typeof v.labels === "object" ? Object.keys(v.labels).slice(0, 6) : []
    }));
    return { ok: true, voices };
  }

  // Resolve a display name to ONE official voice_id. Ambiguity is reported, never guessed.
  async function resolveVoice(name) {
    const r = await listVoices();
    if (!r.ok) return { ok: false, code: r.code };
    const want = String(name || "").trim().toLowerCase();
    const exact = r.voices.filter((v) => v.displayName.toLowerCase() === want);
    const cands = exact.length ? exact : r.voices.filter((v) => v.displayName.toLowerCase().startsWith(want));
    if (cands.length === 0) return { ok: false, code: "VOICE_NOT_FOUND", name };
    if (cands.length > 1) return { ok: false, code: "VOICE_AMBIGUOUS", name, candidates: cands.map((v) => ({ officialVoiceId: v.officialVoiceId, displayName: v.displayName, category: v.category })) };
    return { ok: true, voice: cands[0] };
  }

  // Durable TTS: one submit per idempotencyKey; bounded retry only on transient errors; audio validated.
  async function synthesize({ text, officialVoiceId, modelId = "eleven_multilingual_v2", outputFormat = "mp3_44100_128", outputPath, idempotencyKey } = {}) {
    if (!text || !officialVoiceId || !outputPath) return { ok: false, code: "PROVIDER_ERROR", detail: "text/voice/output required" };
    const idk = idempotencyKey || createHash("sha256").update(`${officialVoiceId}|${modelId}|${outputFormat}|${text}`).digest("hex");
    if (idem.has(idk)) return idem.get(idk);
    const body = { text: String(text), model_id: modelId };
    let last = { ok: false, code: "PROVIDER_ERROR" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (ledger) { try { await ledger({ event: "TTS_ATTEMPT", idempotencyKey: idk, voiceId: officialVoiceId, chars: String(text).length, attempt, at: now() }); } catch { /* */ } }
      const r = await call(`/v1/text-to-speech/${encodeURIComponent(officialVoiceId)}?output_format=${encodeURIComponent(outputFormat)}`, { method: "POST", json: body, raw: true, timeoutMs: 120000 });
      if (r.ok) {
        let buf;
        try { buf = Buffer.from(await r.res.arrayBuffer()); } catch { last = { ok: false, code: "PROVIDER_ERROR" }; break; }
        const isMp3 = buf.length > 256 && (buf.slice(0, 3).toString("latin1") === "ID3" || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0));
        if (!isMp3) { last = { ok: false, code: "PROVIDER_ERROR", detail: "audio invalid" }; break; }
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, buf);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        const out = { ok: true, path: outputPath, sizeBytes: buf.length, sha256, container: "mp3", voiceId: officialVoiceId, idempotencyKey: idk };
        idem.set(idk, out);
        if (ledger) { try { await ledger({ event: "TTS_DONE", idempotencyKey: idk, sizeBytes: buf.length, sha256, at: now() }); } catch { /* */ } }
        return out;
      }
      last = { ok: false, code: r.code };
      if (!r.transient) break; // only retry transient network/5xx — never a 4xx auth/quota/voice error
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
    if (ledger) { try { await ledger({ event: "TTS_FAILED", idempotencyKey: idk, code: last.code, at: now() }); } catch { /* */ } }
    return last;
  }

  /**
   * Synthesis that also returns WHEN each character is spoken.
   *
   * `/with-timestamps` is the same synthesis as `synthesize` — same voice, same model, same text, same one
   * unit of quota. It returns the audio base64-encoded alongside a character-level alignment. There is no
   * reason to ever call the plain endpoint for narration: the timings are free, and without them every
   * downstream timing in the film is an estimate that the subtitle track and the shot cuts each guess at
   * separately, which is how a caption comes to appear because a shot started rather than because a voice
   * said a word.
   *
   * Returns the RAW provider alignment. Interpreting it — characters into words into sentences — belongs in
   * lib/movie/audio-timeline.mjs, which is pure and testable; this function's job is to fetch honestly and to
   * refuse to invent anything the provider did not send.
   */
  async function synthesizeWithTimestamps({ text, officialVoiceId, modelId = "eleven_multilingual_v2", outputFormat = "mp3_44100_128", outputPath, idempotencyKey, languageCode = null } = {}) {
    if (!text || !officialVoiceId || !outputPath) return { ok: false, code: "PROVIDER_ERROR", detail: "text/voice/output required" };
    const idk = idempotencyKey || createHash("sha256").update(`ts|${officialVoiceId}|${modelId}|${outputFormat}|${text}`).digest("hex");
    if (idem.has(idk)) return idem.get(idk);
    const body = { text: String(text), model_id: modelId };
    if (languageCode) body.language_code = languageCode;
    let last = { ok: false, code: "PROVIDER_ERROR" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (ledger) { try { await ledger({ event: "TTS_ALIGNED_ATTEMPT", idempotencyKey: idk, voiceId: officialVoiceId, chars: String(text).length, attempt, at: now() }); } catch { /* */ } }
      const r = await call(`/v1/text-to-speech/${encodeURIComponent(officialVoiceId)}/with-timestamps?output_format=${encodeURIComponent(outputFormat)}`,
        { method: "POST", json: body, timeoutMs: 180000 });
      if (r.ok) {
        const j = r.json || {};
        const b64 = j.audio_base64 || j.audioBase64 || null;
        // The alignment key has appeared under two spellings across provider versions; accept either, and
        // prefer the NORMALIZED one when both are present because it corresponds to what was actually spoken
        // rather than to the raw input characters.
        const al = j.normalized_alignment || j.alignment || j.normalizedAlignment || null;
        if (!b64) { last = { ok: false, code: "PROVIDER_ERROR", detail: "no audio in response" }; break; }
        let buf;
        try { buf = Buffer.from(b64, "base64"); } catch { last = { ok: false, code: "PROVIDER_ERROR", detail: "audio undecodable" }; break; }
        const isMp3 = buf.length > 256 && (buf.slice(0, 3).toString("latin1") === "ID3" || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0));
        if (!isMp3) { last = { ok: false, code: "PROVIDER_ERROR", detail: "audio invalid" }; break; }
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, buf);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        // Alignment is reported EXACTLY as received, including absent. A caller that needs timings must be
        // able to tell "the provider did not send any" from "the provider sent these" — silently substituting
        // an even division here would reintroduce the estimated timeline this whole path exists to remove.
        const chars = al && Array.isArray(al.characters) ? al.characters : null;
        const starts = al && Array.isArray(al.character_start_times_seconds) ? al.character_start_times_seconds : (al && Array.isArray(al.characterStartTimesSeconds) ? al.characterStartTimesSeconds : null);
        const ends = al && Array.isArray(al.character_end_times_seconds) ? al.character_end_times_seconds : (al && Array.isArray(al.characterEndTimesSeconds) ? al.characterEndTimesSeconds : null);
        const alignmentOk = Boolean(chars && starts && ends && chars.length > 0 && chars.length === starts.length && chars.length === ends.length);
        const out = {
          ok: true, path: outputPath, sizeBytes: buf.length, sha256, container: "mp3",
          voiceId: officialVoiceId, modelId, outputFormat, idempotencyKey: idk,
          requestedText: String(text),
          alignment: alignmentOk ? Object.freeze({ characters: chars, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends }) : null,
          alignmentSource: alignmentOk ? (j.normalized_alignment ? "normalized" : "raw") : null,
          alignmentAvailable: alignmentOk
        };
        idem.set(idk, out);
        if (ledger) { try { await ledger({ event: "TTS_ALIGNED_DONE", idempotencyKey: idk, sizeBytes: buf.length, sha256, alignment: alignmentOk, at: now() }); } catch { /* */ } }
        return out;
      }
      last = { ok: false, code: r.code };
      if (!r.transient) break;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
    if (ledger) { try { await ledger({ event: "TTS_ALIGNED_FAILED", idempotencyKey: idk, code: last.code, at: now() }); } catch { /* */ } }
    return last;
  }

  /**
   * Listen back to what was produced. Synthesis alignment proves the provider TIMED the text it was given; it
   * does not prove the audio says it — a wrong-language voice returns a perfectly aligned recording of the
   * wrong sounds. Only a transcript settles that, and it is one extra call.
   */
  async function transcribe({ audioPath, modelId = "scribe_v1", languageCode = null, idempotencyKey } = {}) {
    if (!audioPath) return { ok: false, code: "PROVIDER_ERROR", detail: "audioPath required" };
    let buf;
    try { buf = await readFile(audioPath); } catch { return { ok: false, code: "PROVIDER_ERROR", detail: "audio unreadable" }; }
    const idk = idempotencyKey || createHash("sha256").update(`stt|${modelId}|${createHash("sha256").update(buf).digest("hex")}`).digest("hex");
    if (idem.has(idk)) return idem.get(idk);

    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mpeg" }), path.basename(audioPath));
    form.append("model_id", modelId);
    if (languageCode) form.append("language_code", languageCode);
    if (ledger) { try { await ledger({ event: "STT_ATTEMPT", idempotencyKey: idk, bytes: buf.length, at: now() }); } catch { /* */ } }
    const r = await call("/v1/speech-to-text", { method: "POST", form, timeoutMs: 180000 });
    if (!r.ok) {
      if (ledger) { try { await ledger({ event: "STT_FAILED", idempotencyKey: idk, code: r.code, at: now() }); } catch { /* */ } }
      return { ok: false, code: r.code };
    }
    const j = r.json || {};
    const out = {
      ok: true, idempotencyKey: idk,
      text: typeof j.text === "string" ? j.text : "",
      detectedLanguage: j.language_code || j.detected_language || null,
      languageProbability: Number.isFinite(j.language_probability) ? j.language_probability : null,
      words: Array.isArray(j.words) ? j.words : []
    };
    idem.set(idk, out);
    if (ledger) { try { await ledger({ event: "STT_DONE", idempotencyKey: idk, chars: out.text.length, language: out.detectedLanguage, at: now() }); } catch { /* */ } }
    return out;
  }

  return Object.freeze({ kind: "ELEVENLABS_API", testConnection, listVoices, resolveVoice, synthesize, synthesizeWithTimestamps, transcribe });
}
