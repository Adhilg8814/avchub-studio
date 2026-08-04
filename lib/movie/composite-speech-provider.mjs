// P0 Step 5C.17 / 5C.20 — composite SpeechProvider. Provider PRIORITY (owner policy): ELEVENLABS_API
// (official server-side key) is PRIMARY, ELEVENLABS_WEB (owner browser) is the fallback, and Windows SAPI
// (or manual-upload) is the local floor so the Movie Factory always has a narration path. listVoices()
// unions all providers' voices with an explicit provider-tagged id ("elevenlabs-api:<official_id>" vs
// "elevenlabs:<name>" vs "sapi:<name>") so synthesize() routes UNAMBIGUOUSLY — there is NO silent
// cross-provider fallback inside synthesize(): a tagged voice routes only to its own provider and surfaces
// that provider's error. A bare/legacy untagged voiceId routes to SAPI (that is how existing SAPI-narrated
// movies keep working).

function err(code, message) { return Object.assign(new Error(message), { code }); }

export function createCompositeSpeechProvider({ elevenLabsApi = null, elevenLabs = null, fallback = null } = {}) {
  const hasApi = elevenLabsApi && typeof elevenLabsApi.synthesize === "function";
  const hasEl = elevenLabs && typeof elevenLabs.synthesize === "function";
  const hasFb = fallback && typeof fallback.synthesize === "function";
  if (!hasApi && !hasEl && !hasFb) return null;

  async function listVoices() {
    const out = [];
    if (hasApi) { try { for (const v of await elevenLabsApi.listVoices()) out.push({ ...v, id: `elevenlabs-api:${v.id}`, provider: "ELEVENLABS_API" }); } catch { /* */ } }
    if (hasEl) { try { for (const v of await elevenLabs.listVoices()) out.push({ ...v, id: `elevenlabs:${v.id}`, provider: "ELEVENLABS_WEB" }); } catch { /* */ } }
    if (hasFb) { try { for (const v of await fallback.listVoices()) out.push({ ...v, id: `sapi:${v.id}`, provider: fallback.kind || "WINDOWS_SAPI" }); } catch { /* */ } }
    return out;
  }

  // route STRICTLY by the voiceId provider tag; default (untagged) -> SAPI fallback for back-compat.
  async function synthesize({ text, voiceId = null, rate = 0, outputPath, locale = null } = {}) {
    const vid = typeof voiceId === "string" ? voiceId : "";
    if (vid.startsWith("elevenlabs-api:")) {
      if (!hasApi) throw err("E_ELEVENLABS_API_UNAVAILABLE", "ElevenLabs API is not configured");
      return elevenLabsApi.synthesize({ text, voiceId: vid.slice("elevenlabs-api:".length), rate, outputPath, locale });
    }
    if (vid.startsWith("elevenlabs:")) {
      if (!hasEl) throw err("E_ELEVENLABS_UNAVAILABLE", "ElevenLabs Web is not configured");
      return elevenLabs.synthesize({ text, voiceId: vid.slice("elevenlabs:".length), rate, outputPath, locale });
    }
    if (vid.startsWith("sapi:")) {
      if (!hasFb) throw err("E_TTS_UNAVAILABLE", "No local TTS provider");
      return fallback.synthesize({ text, voiceId: vid.slice("sapi:".length), rate, outputPath });
    }
    // untagged: honor the historical behavior (SAPI fallback) unless there is no fallback
    if (hasFb) return fallback.synthesize({ text, voiceId: voiceId || null, rate, outputPath });
    if (hasApi) return elevenLabsApi.synthesize({ text, voiceId: voiceId || null, rate, outputPath, locale });
    return elevenLabs.synthesize({ text, voiceId: voiceId || null, rate, outputPath, locale });
  }

  // 5C.48 — aligned synthesis, routed by the same voice tag and offered only by a provider that can actually
  // do it. Present on the composite ONLY when the API provider is: a caller checks for this method to decide
  // whether the film can have a measured timeline, and answering "yes" and then returning nothing usable
  // would send it down the estimated-timing path it is trying to leave.
  const alignedApi = hasApi && typeof elevenLabsApi.synthesizeWithTimestamps === "function";
  async function synthesizeWithTimestamps({ text, voiceId = null, rate = 0, outputPath, locale = null, languageCode = null } = {}) {
    const vid = typeof voiceId === "string" ? voiceId : "";
    if (!alignedApi) return { ok: false, code: "E_ELEVENLABS_ALIGNMENT_UNSUPPORTED" };
    // A voice belonging to another provider must not be quietly re-routed to this one: the film would be
    // narrated by a different voice than the one the owner chose.
    if (vid && !vid.startsWith("elevenlabs-api:")) return { ok: false, code: "E_ELEVENLABS_ALIGNMENT_UNSUPPORTED" };
    return elevenLabsApi.synthesizeWithTimestamps({
      text, voiceId: vid ? vid.slice("elevenlabs-api:".length) : null, rate, outputPath, locale, languageCode
    });
  }

  const api = { kind: "COMPOSITE", primaryKind: hasApi ? "ELEVENLABS_API" : (hasEl ? "ELEVENLABS_WEB" : (fallback?.kind || "WINDOWS_SAPI")), listVoices, synthesize };
  if (alignedApi) api.synthesizeWithTimestamps = synthesizeWithTimestamps;
  return Object.freeze(api);
}
