// P0 Step 5C.16 (long-form) — length presets + locale reading-rate → target word/reading-time bands.
//
// The Story Factory targets READING TIME, not a raw word count. Presets carry a reading-minute band and
// a word band (the word band is the enforced gate; the reading band is derived + shown). CUSTOM computes
// its word band from the owner's reading-minute band × the locale's reading rate. Reading rate is
// per-locale + editable (silent-reading speed differs by language); STANDARD is the production default.

export const LENGTH_PRESETS = Object.freeze(["SHORT", "STANDARD", "LONG", "CUSTOM"]);
export const DEFAULT_LENGTH_PRESET = "STANDARD";

// Words-per-minute (silent reading) per locale. Editable; sane defaults keep STANDARD ≈ 9-12 min.
export const DEFAULT_READING_RATE_WPM = Object.freeze({ "bg-BG": 185, "sv-SE": 190, "da-DK": 190 });
export function readingRateFor(locale, profile = null) {
  const fromProfile = profile && Number.isFinite(profile.readingRateWpm) ? profile.readingRateWpm : null;
  return Math.max(90, Math.min(400, Math.round(fromProfile || DEFAULT_READING_RATE_WPM[locale] || 190)));
}

// Preset word/reading bands. STANDARD floor is 1700 words (the hard long-form gate); SHORT is the only
// preset allowed below it, and only when the owner explicitly selects it.
const PRESET_BANDS = Object.freeze({
  SHORT: { readingMin: 5, readingMax: 7, wordsMin: 900, wordsMax: 1300, idealMin: 1000, idealMax: 1250 },
  STANDARD: { readingMin: 9, readingMax: 12, wordsMin: 1700, wordsMax: 2500, idealMin: 1900, idealMax: 2500 },
  LONG: { readingMin: 13, readingMax: 18, wordsMin: 2500, wordsMax: 3600, idealMin: 2700, idealMax: 3400 }
});

// Estimated reading time (seconds) for a word count at the locale's rate.
export function estimatedReadingSeconds(wordCount, locale, profile = null) {
  const wpm = readingRateFor(locale, profile);
  return Math.round((Math.max(0, Number(wordCount) || 0) / wpm) * 60);
}

// Resolve the concrete length target for a request. `preset` in LENGTH_PRESETS; for CUSTOM pass
// customReadingMinutes = [min, max]. Returns a frozen target used by the pipeline + gate + UI.
export function resolveLengthTarget({ preset = DEFAULT_LENGTH_PRESET, locale = "bg-BG", profile = null, customReadingMinutes = null } = {}) {
  const p = LENGTH_PRESETS.includes(preset) ? preset : DEFAULT_LENGTH_PRESET;
  const wpm = readingRateFor(locale, profile);
  if (p === "CUSTOM") {
    const cm = Array.isArray(customReadingMinutes) ? customReadingMinutes : [10, 12];
    const rMin = Math.max(3, Math.min(40, Math.round(Number(cm[0]) || 10)));
    const rMax = Math.max(rMin + 1, Math.min(45, Math.round(Number(cm[1]) || rMin + 2)));
    const wordsMin = Math.round(rMin * wpm);
    const wordsMax = Math.round(rMax * wpm);
    return Object.freeze({ preset: "CUSTOM", readingMinutesMin: rMin, readingMinutesMax: rMax, wordsMin, wordsMax, idealMin: Math.round((wordsMin + wordsMax) / 2 * 0.95), idealMax: wordsMax, wpm });
  }
  const b = PRESET_BANDS[p];
  return Object.freeze({ preset: p, readingMinutesMin: b.readingMin, readingMinutesMax: b.readingMax, wordsMin: b.wordsMin, wordsMax: b.wordsMax, idealMin: b.idealMin, idealMax: b.idealMax, wpm });
}

// Number of narrative sections to plan for a target, so per-section generation avoids one huge response.
// The model reliably under-writes a per-section target by ~20-25%, so we size sections SMALL (~380 words)
// and plan MORE of them — more short sections clears the floor far more reliably than few long ones.
export function planSectionCount(target) {
  const mid = (target.idealMin + target.idealMax) / 2;
  return Math.max(3, Math.min(9, Math.round(mid / 380)));
}
