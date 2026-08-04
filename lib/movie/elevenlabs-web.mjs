// P0 Step 5C.17 — ElevenLabs Web (browser TTS) pure helpers: voice mapping, text chunking, account
// selection. NO network, NO ElevenLabs API, NO credentials — this module is deterministic logic only;
// the actual synthesis is driven through the Python Browser Worker daemon against the owner's own,
// owner-authenticated elevenlabs.io session (the agent never signs in and never enters a credential).
//
// The web Text-to-Speech surface caps a single generation's character count and streams one MP3; long
// narration is split into sentence-aligned chunks, each synthesized as its own MP3, then concatenated by
// the caller. Voices are chosen by locale from a configurable map (the owner confirms the exact voice
// names available in their account after signing in — see ELEVENLABS_VOICE_CONFIGURATION_REQUIRED).

function err(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

// The multilingual v2 model renders any of these languages with any multilingual voice; the voice NAMES
// below are common ElevenLabs default-library voices, used only as defaults. The owner's confirmed
// per-locale voice (stored on the account) always wins — these are the fallback when none is configured.
export const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2";
export const DEFAULT_ELEVENLABS_VOICE_MAP = Object.freeze({
  "bg-BG": Object.freeze({ voiceName: "Charlotte", gender: "female", model: DEFAULT_ELEVENLABS_MODEL }),
  "sv-SE": Object.freeze({ voiceName: "Sarah", gender: "female", model: DEFAULT_ELEVENLABS_MODEL }),
  "da-DK": Object.freeze({ voiceName: "Charlotte", gender: "female", model: DEFAULT_ELEVENLABS_MODEL }),
  "en-US": Object.freeze({ voiceName: "Rachel", gender: "female", model: DEFAULT_ELEVENLABS_MODEL })
});

// A per-account voice map is a { [locale]: { voiceName, model? } } object the owner confirms post-login.
// Resolve the voice for a locale: the account's configured voice first, then the built-in default.
export function resolveVoiceForLocale(locale, { accountVoiceMap = null } = {}) {
  const loc = String(locale || "").trim();
  const fromAccount = accountVoiceMap && typeof accountVoiceMap === "object" ? accountVoiceMap[loc] : null;
  const chosen = (fromAccount && fromAccount.voiceName) ? fromAccount : DEFAULT_ELEVENLABS_VOICE_MAP[loc] || null;
  if (!chosen || !chosen.voiceName) {
    // no configured voice AND no default for this locale → the owner must map one
    return { ok: false, code: "ELEVENLABS_VOICE_CONFIGURATION_REQUIRED", locale: loc };
  }
  return Object.freeze({
    ok: true, locale: loc, voiceName: String(chosen.voiceName),
    model: String(chosen.model || DEFAULT_ELEVENLABS_MODEL),
    configured: Boolean(fromAccount && fromAccount.voiceName)
  });
}

// Split narration into sentence-aligned chunks each <= maxChars. Never splits inside a sentence unless a
// single sentence exceeds maxChars (then it is hard-split on the last whitespace before the cap). Keeps
// paragraph boundaries where possible. Deterministic; preserves Unicode (Cyrillic/Scandinavian).
export function chunkNarration(text, { maxChars = 2500 } = {}) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const cap = Math.max(200, Math.min(9000, Math.round(maxChars)));
  // sentence-ish segments: keep the terminator with the sentence; also break on hard newlines
  const segments = raw
    .split(/\n{2,}/)
    .flatMap((para) => para.match(/[^.!?…。]+[.!?…。]+["”»„']?|\S[^.!?…。]*$/gu) || [para])
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (let seg of segments) {
    // a single oversized sentence: hard-split on whitespace under the cap
    while (seg.length > cap) {
      let cut = seg.lastIndexOf(" ", cap);
      if (cut < Math.floor(cap * 0.5)) cut = cap; // no good space → hard cut at cap
      const head = seg.slice(0, cut).trim();
      if (cur) push();
      chunks.push(head);
      seg = seg.slice(cut).trim();
    }
    if (!seg) continue;
    if ((cur + (cur ? " " : "") + seg).length > cap) push();
    cur = cur ? `${cur} ${seg}` : seg;
  }
  push();
  return chunks;
}

// Account selection strategy. `accounts` = [{ id, label, authenticated, disabled, lastUsedAt, ... }].
//  MANUAL              → the caller's preferredAccountId must be an authenticated, enabled account.
//  PREFERRED_WITH_FALLBACK → preferred if usable, else the first other authenticated+enabled account.
//  AUTO_AVAILABLE      → the least-recently-used authenticated+enabled account (spreads usage/quota).
export const ELEVENLABS_SELECTION_STRATEGIES = Object.freeze(["MANUAL", "PREFERRED_WITH_FALLBACK", "AUTO_AVAILABLE"]);
export function selectElevenLabsAccount(accounts, { strategy = "AUTO_AVAILABLE", preferredAccountId = null } = {}) {
  const usable = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.authenticated === true && a.disabled !== true);
  if (usable.length === 0) return { ok: false, code: "ELEVENLABS_OWNER_LOGIN_REQUIRED" };
  const strat = ELEVENLABS_SELECTION_STRATEGIES.includes(strategy) ? strategy : "AUTO_AVAILABLE";
  const preferred = preferredAccountId ? usable.find((a) => a.id === preferredAccountId) : null;
  if (strat === "MANUAL") {
    if (!preferred) return { ok: false, code: "ELEVENLABS_PREFERRED_ACCOUNT_UNAVAILABLE" };
    return { ok: true, account: preferred, strategy: strat };
  }
  if (strat === "PREFERRED_WITH_FALLBACK" && preferred) return { ok: true, account: preferred, strategy: strat };
  // AUTO / fallback: least-recently-used (oldest lastUsedAt first; never-used counts as oldest)
  const byLru = [...usable].sort((a, b) => (Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0)) || (a.id < b.id ? -1 : 1));
  return { ok: true, account: byLru[0], strategy: strat };
}

// Estimate quota impact (characters) of a narration under a given account, for the observed-usage guard.
export function narrationCharCost(text) { return String(text ?? "").length; }

export { err as _elevenLabsErr };
