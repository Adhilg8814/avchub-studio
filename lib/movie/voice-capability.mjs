// P0 Step 5C.36 — VOICE CAPABILITY (pure, no provider call).
//
// The defect: a Danish story was narrated by an English voice and nothing said so. The voice map simply
// answered `da-DK -> Charlotte`, the pipeline synthesised, and the movie shipped with a narrator speaking
// Danish words in an English mouth. Nobody chose that. Nobody was told.
//
// A voice map answers "which voice", which is not the same question as "can this voice speak this
// language". Those are separated here, and the second one is answered BEFORE any provider call:
//
//   NATIVE      the voice's own recorded language is the requested language. The obvious case.
//   FALLBACK    a substitution is happening, and of a stated KIND:
//                 ACCENT        the model speaks the language, but the voice was recorded in another —
//                               correct words, foreign accent. This is the da-DK/Charlotte case.
//                 LANGUAGE      the model does not support the language at all; the text will be read with
//                               the wrong phonology. Usually unacceptable.
//                 UNKNOWN_VOICE the voice is not in the catalogue, so its language cannot be asserted.
//                               Unknown is reported as a fallback, never assumed to be native.
//   UNAVAILABLE no voice is mapped for the locale at all.
//
// A FALLBACK is not an error. It is a decision — one an owner may perfectly reasonably make — and the only
// unacceptable thing is making it for them silently. So the capability is reported, the automation policy
// decides whether unattended runs may accept one, and whatever is actually used gets recorded.

export const VOICE_CAPABILITY = Object.freeze({
  NATIVE: "NATIVE",
  FALLBACK: "FALLBACK",
  UNAVAILABLE: "UNAVAILABLE"
});
export const VOICE_FALLBACK_KIND = Object.freeze({
  ACCENT: "ACCENT",
  LANGUAGE: "LANGUAGE",
  UNKNOWN_VOICE: "UNKNOWN_VOICE"
});
export const VOICE_ERRORS = Object.freeze({
  UNAVAILABLE: "E_MOVIE_VOICE_UNAVAILABLE",
  FALLBACK_NOT_ALLOWED: "E_MOVIE_VOICE_FALLBACK_NOT_ALLOWED",
  FALLBACK_NOT_CONFIRMED: "E_MOVIE_VOICE_FALLBACK_NOT_CONFIRMED"
});

// Languages eleven_multilingual_v2 can pronounce. A language OUTSIDE this set is not "an accent" — the
// model does not have the phonology and the result is not the language at all.
const MULTILINGUAL_V2 = new Set([
  "en", "ja", "zh", "de", "hi", "fr", "ko", "pt", "it", "es", "id", "nl", "tr", "fil", "pl", "sv", "bg",
  "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "ru"
]);
const MONOLINGUAL_MODELS = new Set(["eleven_monolingual_v1", "eleven_english_v2", "eleven_turbo_v2"]);

// The recorded language of the premade voices this deployment actually maps. Deliberately small and
// explicit: a voice that is NOT listed is reported as UNKNOWN_VOICE rather than guessed at, because an
// optimistic guess is precisely how "Danish" ended up meaning "English with Danish words".
const VOICE_LANGUAGE = Object.freeze({
  rachel: "en", domi: "en", bella: "en", antoni: "en", elli: "en", josh: "en", arnold: "en", adam: "en",
  sam: "en", charlotte: "en", alice: "en", matilda: "en", jessica: "en", lily: "en", sarah: "en",
  laura: "en", george: "en", callum: "en", river: "en", liam: "en", charlie: "en", daniel: "en",
  will: "en", eric: "en", chris: "en", brian: "en", bill: "en"
});

// A movie project stores its language as the brand's language NAME ("Danish"), not a locale tag. Taking
// the first two letters of that happens to work for Danish and is wrong for Swedish ("sw" is Swahili) —
// so names are mapped explicitly, and anything already shaped like a tag passes through untouched.
const LANGUAGE_NAMES = Object.freeze({
  danish: "da-DK", dansk: "da-DK",
  swedish: "sv-SE", svenska: "sv-SE",
  bulgarian: "bg-BG", "български": "bg-BG",
  english: "en-US",
  vietnamese: "vi-VN", "tiếng việt": "vi-VN",
  german: "de-DE", french: "fr-FR", spanish: "es-ES", italian: "it-IT",
  dutch: "nl-NL", polish: "pl-PL", portuguese: "pt-PT", romanian: "ro-RO",
  czech: "cs-CZ", greek: "el-GR", finnish: "fi-FI", croatian: "hr-HR",
  slovak: "sk-SK", ukrainian: "uk-UA", russian: "ru-RU", turkish: "tr-TR"
});
export function normalizeLocale(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[A-Za-z]{2}-[A-Za-z]{2}$/u.test(raw)) return `${raw.slice(0, 2).toLowerCase()}-${raw.slice(3).toUpperCase()}`;
  const named = LANGUAGE_NAMES[raw.toLowerCase()];
  if (named) return named;
  if (/^[A-Za-z]{2}$/u.test(raw)) return raw.toLowerCase();
  return raw;
}
const langOf = (locale) => normalizeLocale(locale).slice(0, 2).toLowerCase();
const key = (name) => String(name || "").trim().toLowerCase();
const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** The recorded language of a voice, from the live catalogue when we have it, else the static table. */
export function voiceLanguageOf(voiceName, { catalogue = null } = {}) {
  const k = key(voiceName);
  if (!k) return null;
  if (Array.isArray(catalogue)) {
    // A catalogue entry from the provider is authoritative — it carries the voice's own labels.
    const hit = catalogue.find((v) => key(v && (v.displayName || v.name)) === k);
    const lang = hit && (hit.language || (hit.labels && (hit.labels.language || hit.labels.accent)));
    if (typeof lang === "string" && lang.trim()) return langOf(lang);
  }
  if (VOICE_LANGUAGE[k]) return VOICE_LANGUAGE[k];
  // P0 Step 5C.48 — a provider display name carries a description: "Alice - Clear, Engaging Educator" IS the
  // premade voice Alice. Matching only the whole string made every real ElevenLabs voice UNKNOWN_VOICE, which
  // reads as "we cannot say what language this is" about a voice the table has known all along — and an
  // unknown voice needs an owner's confirmation, so every narration on this deployment required one.
  const first = k.split(/[\s\-–—:,(]+/u).filter(Boolean)[0];
  return (first && VOICE_LANGUAGE[first]) || null;
}

/**
 * Decide what will actually happen if this voice narrates this locale.
 *
 * @param {object} input
 * @param {string} input.locale            requested locale, e.g. "da-DK"
 * @param {string} [input.voiceName]       resolved voice, e.g. "Charlotte"
 * @param {string} [input.voiceId]         provider voice id, when known
 * @param {string} [input.model]           synthesis model
 * @param {Array}  [input.catalogue]       live voice catalogue, when available
 * @returns {object} a full, explainable verdict — never just a boolean
 */
export function assessVoiceCapability({ locale, voiceName = null, voiceId = null, model = "eleven_multilingual_v2", catalogue = null } = {}) {
  const requestedLocale = normalizeLocale(locale);
  const lang = langOf(requestedLocale);
  const base = { requestedLocale, voiceName: voiceName || null, voiceId: voiceId || null, model: String(model || "") };

  if (!requestedLocale || !lang) {
    return Object.freeze({ ...base, capability: VOICE_CAPABILITY.UNAVAILABLE, fallbackKind: null, voiceLanguage: null,
      reason: "no locale was requested", requiresConfirmation: false });
  }
  if (!voiceName) {
    return Object.freeze({ ...base, capability: VOICE_CAPABILITY.UNAVAILABLE, fallbackKind: null, voiceLanguage: null,
      reason: `no voice is mapped for ${requestedLocale}`, requiresConfirmation: false });
  }

  const voiceLanguage = voiceLanguageOf(voiceName, { catalogue });
  const modelSpeaks = MONOLINGUAL_MODELS.has(String(model)) ? (lang === "en") : MULTILINGUAL_V2.has(lang);

  if (!modelSpeaks) {
    return Object.freeze({ ...base, capability: VOICE_CAPABILITY.FALLBACK, fallbackKind: VOICE_FALLBACK_KIND.LANGUAGE,
      voiceLanguage,
      reason: `the ${model} model does not speak ${lang}; the text would be read with another language's pronunciation`,
      requiresConfirmation: true });
  }
  if (!voiceLanguage) {
    return Object.freeze({ ...base, capability: VOICE_CAPABILITY.FALLBACK, fallbackKind: VOICE_FALLBACK_KIND.UNKNOWN_VOICE,
      voiceLanguage: null,
      reason: `"${voiceName}" is not in the voice catalogue, so its recorded language cannot be confirmed`,
      requiresConfirmation: true });
  }
  if (voiceLanguage === lang) {
    return Object.freeze({ ...base, capability: VOICE_CAPABILITY.NATIVE, fallbackKind: null, voiceLanguage,
      reason: `"${voiceName}" is recorded in ${voiceLanguage} and the model speaks ${lang}`,
      requiresConfirmation: false });
  }
  return Object.freeze({ ...base, capability: VOICE_CAPABILITY.FALLBACK, fallbackKind: VOICE_FALLBACK_KIND.ACCENT,
    voiceLanguage,
    reason: `"${voiceName}" is recorded in ${voiceLanguage}; it will speak ${lang} with a ${voiceLanguage} accent`,
    requiresConfirmation: true });
}

/** A one-line, owner-facing sentence. The UI shows this verbatim — no code, no jargon. */
export function describeCapability(v, { vi = false } = {}) {
  if (!v) return "";
  if (v.capability === VOICE_CAPABILITY.NATIVE) {
    return vi ? `Giọng "${v.voiceName}" là giọng bản ngữ ${v.requestedLocale}.`
      : `"${v.voiceName}" is a native ${v.requestedLocale} voice.`;
  }
  if (v.capability === VOICE_CAPABILITY.UNAVAILABLE) {
    return vi ? `Chưa có giọng nào cho ${v.requestedLocale}. Hãy chọn giọng trước khi dựng phim.`
      : `No voice is mapped for ${v.requestedLocale}. Choose one before producing the movie.`;
  }
  if (v.fallbackKind === VOICE_FALLBACK_KIND.LANGUAGE) {
    return vi ? `Model không nói được ${v.requestedLocale}. Giọng "${v.voiceName}" sẽ đọc sai ngữ âm.`
      : `The model cannot speak ${v.requestedLocale}. "${v.voiceName}" would read it with the wrong pronunciation.`;
  }
  if (v.fallbackKind === VOICE_FALLBACK_KIND.UNKNOWN_VOICE) {
    return vi ? `Không xác nhận được ngôn ngữ gốc của giọng "${v.voiceName}" cho ${v.requestedLocale}.`
      : `The recorded language of "${v.voiceName}" cannot be confirmed for ${v.requestedLocale}.`;
  }
  return vi
    ? `Không có giọng bản ngữ ${v.requestedLocale}. Giọng "${v.voiceName}" là giọng ${v.voiceLanguage} — sẽ đọc ${v.requestedLocale} với chất giọng ${v.voiceLanguage}.`
    : `No native ${v.requestedLocale} voice exists here. "${v.voiceName}" is a ${v.voiceLanguage} voice and will speak ${v.requestedLocale} with a ${v.voiceLanguage} accent.`;
}

/**
 * The gate. Called BEFORE the provider, so a refusal costs nothing.
 *
 * @param {object} verdict  from assessVoiceCapability
 * @param {object} policy
 * @param {boolean} [policy.allowFallbackVoice=false]  may unattended automation accept a fallback at all
 * @param {Array}   [policy.confirmedFallbacks=[]]     locales the owner has explicitly confirmed
 * @param {boolean} [policy.interactive=false]         a human is present and has confirmed in this request
 */
export function assertVoiceAllowed(verdict, { allowFallbackVoice = false, confirmedFallbacks = [], interactive = false } = {}) {
  if (!verdict) throw err(VOICE_ERRORS.UNAVAILABLE, "no voice capability verdict was produced");
  if (verdict.capability === VOICE_CAPABILITY.NATIVE) return verdict;
  if (verdict.capability === VOICE_CAPABILITY.UNAVAILABLE) {
    throw err(VOICE_ERRORS.UNAVAILABLE, `no voice is available for ${verdict.requestedLocale}`, { verdict });
  }
  // A language the model cannot pronounce is never something automation may decide on its own.
  const confirmed = interactive === true || (Array.isArray(confirmedFallbacks) && confirmedFallbacks.includes(verdict.requestedLocale));
  if (!allowFallbackVoice && !confirmed) {
    throw err(VOICE_ERRORS.FALLBACK_NOT_ALLOWED,
      `${verdict.requestedLocale} would use a fallback voice and fallbacks are not allowed for automated runs`, { verdict });
  }
  if (verdict.fallbackKind === VOICE_FALLBACK_KIND.LANGUAGE && !confirmed) {
    throw err(VOICE_ERRORS.FALLBACK_NOT_CONFIRMED,
      `${verdict.requestedLocale} is not spoken by the model; this needs an explicit confirmation, not a policy flag`, { verdict });
  }
  return verdict;
}

/** What gets written to the audit: the decision as taken, with no room to claim it was native. */
export function voiceAuditRecord(verdict, { confirmedBy = null, policy = null } = {}) {
  return Object.freeze({
    at: new Date().toISOString(),
    requestedLocale: verdict.requestedLocale,
    voiceName: verdict.voiceName,
    voiceId: verdict.voiceId,
    voiceLanguage: verdict.voiceLanguage,
    model: verdict.model,
    capability: verdict.capability,
    fallbackKind: verdict.fallbackKind,
    reason: verdict.reason,
    confirmedBy: confirmedBy || null,
    policy: policy ? { allowFallbackVoice: policy.allowFallbackVoice === true } : null
  });
}
