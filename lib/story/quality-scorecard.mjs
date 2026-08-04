// P0 Step 5C.16 — quality scorecard (pure, deterministic signals; configurable thresholds).
//
// Every dimension is computed from concrete signals (the prose, the frozen DNA, the continuity report,
// the novelty report, the title validation, the arc analysis) so READY can be gated deterministically.
// Model self-assessments are accepted ONLY for the subjective dimensions and are clamped + averaged
// with the deterministic estimate — they can never override a critical failure. A critical dimension
// below its floor makes the story NOT READY regardless of the overall average.

import { wordCount, tokenSet } from "./story-common.mjs";

export const DEFAULT_QUALITY_THRESHOLDS = Object.freeze({
  floors: Object.freeze({
    hookStrength: 0.55, emotionalEscalation: 0.55, characterConsistency: 0.7, plotCoherence: 0.7,
    realism: 0.6, twistSetup: 0.55, payoffSatisfaction: 0.6, localeFluency: 0.7, titleAccuracy: 0.6,
    novelty: 0.5, repetition: 0.6, safety: 1.0,
    // long-form gates
    lengthCompliance: 1.0, lengthRestraint: 0.6, filler: 0.6, paragraphVariation: 0.4, narrativeCompleteness: 0.6
  }),
  critical: Object.freeze(["characterConsistency", "plotCoherence", "localeFluency", "safety", "novelty", "lengthCompliance", "filler"]),
  overall: 0.66
});

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

// Cyrillic / locale-letter based language fluency (catches "wrote in English, didn't translate").
const LOCALE_SIGNALS = Object.freeze({
  "bg-BG": { script: /[Ѐ-ӿ]/g, stop: ["и", "не", "на", "да", "аз", "той", "тя", "беше", "ми", "си"] },
  "sv-SE": { letters: /[åäöÅÄÖ]/g, stop: ["och", "att", "jag", "inte", "det", "som", "var", "med", "för", "hon", "han"] },
  "da-DK": { letters: /[æøåÆØÅ]/g, stop: ["og", "at", "jeg", "ikke", "det", "som", "var", "med", "for", "hun", "han", "en"] }
});
const ENGLISH_STOP = ["the", "and", "was", "that", "with", "have", "this", "which", "would", "there"];

export function detectLocaleFluency(text, locale) {
  const s = String(text || "");
  const words = (s.toLowerCase().match(/[\p{L}]+/gu) || []);
  if (words.length < 30) return 0.3;
  const sig = LOCALE_SIGNALS[locale];
  const englishHits = ENGLISH_STOP.reduce((n, w) => n + words.filter((x) => x === w).length, 0);
  const englishRatio = englishHits / words.length;
  if (!sig) return englishRatio > 0.06 ? 0.4 : 0.7;
  let localeScore;
  if (sig.script) {
    const cyr = (s.match(sig.script) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    localeScore = cyr / Math.max(1, cyr + latin);            // Cyrillic dominance
  } else {
    const stopHits = sig.stop.reduce((n, w) => n + words.filter((x) => x === w).length, 0);
    const letterHit = (s.match(sig.letters) || []).length > 0 ? 0.25 : 0;
    localeScore = Math.min(1, stopHits / Math.max(1, words.length) * 12 + letterHit);
  }
  // Penalize English contamination.
  return clamp01(localeScore - Math.max(0, englishRatio - 0.02) * 4);
}

// Fraction of NON-repeated word trigrams (1 = no padding; low = repeated filler to hit word count).
export function repetitionScore(text) {
  const words = (String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  if (words.length < 30) return 1;
  const grams = new Map();
  let total = 0;
  for (let i = 0; i + 2 < words.length; i += 1) { const g = words[i] + " " + words[i + 1] + " " + words[i + 2]; grams.set(g, (grams.get(g) || 0) + 1); total += 1; }
  let repeated = 0;
  for (const n of grams.values()) if (n > 1) repeated += n - 1;
  return clamp01(1 - repeated / Math.max(1, total));
}

function hookStrengthOf(storyText, dna) {
  const first = String(storyText || "").split(/\n\s*\n/)[0] || "";
  const firstLower = first.toLowerCase();
  let s = 0;
  if (wordCount(first) >= 15) s += 0.3;
  if (dna && dna.antagonistList.some((a) => a.name && firstLower.includes(a.name.toLowerCase()))) s += 0.25;
  if (/["“”«»„]/.test(first)) s += 0.2;                                   // opens near a charged line
  if (dna && dna.publicHumiliation && tokenSet(first).size && [...tokenSet(dna.publicHumiliation)].some((t) => firstLower.includes(t))) s += 0.25;
  return clamp01(s || 0.4);
}

// mix(deterministic, modelScore?) — average with a clamped model score when provided.
function mix(det, model) {
  const d = clamp01(det);
  if (!Number.isFinite(model)) return d;
  return clamp01((d + clamp01(model)) / 2);
}

export function computeScorecard({ storyText = "", dna = null, continuity = null, novelty = null, titleValidation = null, arc = null, locale = null, modelScores = {}, metrics = null, lengthTarget = null, lengthGateResult = null } = {}, thresholds = DEFAULT_QUALITY_THRESHOLDS) {
  const contViol = continuity ? continuity.violations.length : 0;
  const contWarn = continuity ? continuity.warnings.length : 0;
  // Only CHARACTER-related warnings bear on character consistency — not language-dependent soft warnings
  // (amount-absent / evidence-not-shown / resolution-weak), which are about coverage, not character.
  const charWarns = continuity ? continuity.warnings.filter((w) => /PROTAGONIST|ANTAGONIST|QUOTE|CHARACTER/.test(w)).length : 0;
  const antagonistAbsent = continuity ? continuity.violations.some((v) => v.startsWith("E_CONTINUITY_ANTAGONIST_ABSENT")) : false;
  const evidenceOrderBad = continuity ? continuity.violations.includes("E_CONTINUITY_EVIDENCE_AFTER_REVERSAL") : false;
  const unresolved = continuity ? continuity.violations.includes("E_CONTINUITY_UNRESOLVED_ENDING") : false;
  const violent = continuity ? (continuity.violations.includes("E_CONTINUITY_VIOLENCE") || continuity.violations.includes("E_CONTINUITY_DEUS_EX_MACHINA")) : false;

  const dims = {
    hookStrength: mix(hookStrengthOf(storyText, dna), modelScores.hookStrength),
    emotionalEscalation: mix((dna && dna.escalationSteps.length >= 3 ? 0.7 : 0.5) + (arc && arc.complete ? 0.2 : 0), modelScores.emotionalEscalation),
    characterConsistency: clamp01(antagonistAbsent ? 0.3 : (1 - Math.min(0.3, charWarns * 0.12))),
    plotCoherence: clamp01(1 - contViol * 0.25),
    realism: clamp01((violent ? 0.2 : 0.9) - contWarn * 0.03),
    twistSetup: clamp01(evidenceOrderBad ? 0.3 : mix(0.75, modelScores.twistSetup)),
    payoffSatisfaction: clamp01(unresolved ? 0.3 : mix(0.7, modelScores.payoffSatisfaction)),
    localeFluency: detectLocaleFluency(storyText, locale),
    titleAccuracy: clamp01(titleValidation ? (titleValidation.valid ? (titleValidation.score ?? 0.8) : 0.4) : 0.7),
    novelty: clamp01(novelty ? 1 - (novelty.maxOverall ?? 0) : 0.8),
    repetition: repetitionScore(storyText),
    safety: continuity && violent ? 0 : 1
  };

  // ---- long-form dimensions (only added when metrics + lengthTarget are supplied) ----
  if (metrics && lengthTarget) {
    const w = metrics.actualWordCount, lo = lengthTarget.wordsMin, hi = lengthTarget.wordsMax;
    // lengthCompliance is CRITICAL, so it may only reflect conditions that genuinely make a story unusable:
    // it was cut off, or it never reached the floor. Being LONGER than the ideal band is not one of those —
    // the length gate itself classifies that as ABOVE_MAX_SOFT and PASSES it, and a scorecard that then
    // hard-fails the same story contradicts the component that owns length policy. Over-length is reported
    // as its own non-critical dimension, where a reviewer can see it without the story becoming unshippable.
    dims.lengthCompliance = clamp01(metrics.truncated ? 0 : w < lo ? Math.max(0, w / lo - 0.02) : 1);
    dims.lengthRestraint = clamp01(metrics.truncated ? 1 : w > hi * 1.5 ? 0.4 : w > hi * 1.25 ? 0.7 : w > hi ? 0.9 : 1);
    // P0 Step 5C.34 — filler is CRITICAL and used to be computed from a raw repeated-trigram ratio, which is
    // a measure of GRAMMAR as much as of padding: Danish and Swedish carry obligatory det/at/der scaffolding
    // that an English-calibrated ratio reads as filler. It now prefers the language-aware repetition score
    // (function-word echoes, character names and dialogue refrains carry no weight), and keeps the two
    // language-neutral structural penalties. Metrics without a repetition result keep the historical formula.
    const repScore = metrics.repetition ? metrics.repetition.score : null;
    const repPenalty = repScore != null ? Math.min(0.5, repScore * 4) : Math.min(0.5, metrics.repeatedTrigramRatio * 8);
    dims.filler = clamp01(1 - repPenalty - Math.min(0.3, metrics.nearDuplicateParagraphs * 0.15) - (metrics.paragraphLengthCv < 0.25 && metrics.paragraphCount >= 6 ? 0.2 : 0));
    dims.paragraphVariation = clamp01(Math.min(1, metrics.paragraphLengthCv / 0.55));
    dims.narrativeCompleteness = clamp01((metrics.truncated ? 0.2 : 0.6) + (arc && arc.complete ? 0.2 : 0) + (metrics.paragraphCount >= 12 ? 0.2 : 0));
    if (lengthGateResult && !lengthGateResult.pass) dims.lengthCompliance = Math.min(dims.lengthCompliance, 0.3);
  }

  const floors = thresholds.floors;
  const failures = Object.keys(dims).filter((k) => floors[k] !== undefined && dims[k] < floors[k]);
  const criticalFailures = failures.filter((k) => thresholds.critical.includes(k));
  const overallScore = Number((Object.values(dims).reduce((a, b) => a + b, 0) / Object.keys(dims).length).toFixed(4));
  const ready = criticalFailures.length === 0 && overallScore >= thresholds.overall && failures.filter((k) => thresholds.critical.includes(k)).length === 0;

  return Object.freeze({
    dimensions: Object.freeze(Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, Number(v.toFixed(4))]))),
    overallScore,
    failures: Object.freeze(failures),
    criticalFailures: Object.freeze(criticalFailures),
    ready,
    thresholds: Object.freeze({ overall: thresholds.overall, critical: [...thresholds.critical] })
  });
}
