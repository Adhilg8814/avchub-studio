// P0 Step 5C.16 (long-form) — story metrics + length gate + padding/truncation detection (pure).
//
// Turns finished prose into the durable, displayable metrics the long-form gates + dashboard need:
// word/reading-time/paragraph/dialogue/beat counts, paragraph-length variation, near-duplicate padding,
// and truncation. Everything is deterministic + Unicode-safe (Cyrillic/Scandinavian preserved).

import { wordCount, tokenSet, jaccard } from "./story-common.mjs";
import { detectRepetition, REPETITION_BAND } from "./repetition-detector.mjs";
import { estimatedReadingSeconds } from "./length-presets.mjs";

const QUOTE_OPEN = "\"“«„'‘";
const QUOTE_CLOSE = "\"”»“'’";
// Dialogue = words inside a quoted span. Match a quote-open … quote-close pair (bounded).
const DIALOGUE_RE = /["“«„][^"“”«»„]{2,600}["”»“]/gu;

export function splitParagraphs(text) {
  return String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

export function dialogueWordCount(text) {
  const spans = String(text || "").match(DIALOGUE_RE) || [];
  return spans.reduce((n, s) => n + wordCount(s), 0);
}

// Coefficient of variation of paragraph word-lengths (0 = all identical length → uniform/padded).
function paragraphLengthStats(paragraphs) {
  const lens = paragraphs.map((p) => wordCount(p)).filter((n) => n > 0);
  if (lens.length < 2) return { cv: 1, avg: lens[0] || 0, longest: lens[0] || 0 };
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length;
  const cv = avg > 0 ? Math.sqrt(variance) / avg : 0;
  return { cv: Number(cv.toFixed(4)), avg: Math.round(avg), longest: Math.max(...lens) };
}

// Near-duplicate paragraph pairs (token jaccard >= threshold) → padding by paraphrase.
export function nearDuplicateParagraphs(paragraphs, threshold = 0.7) {
  const sets = paragraphs.map((p) => tokenSet(p, 3));
  let pairs = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      if (sets[i].size >= 6 && sets[j].size >= 6 && jaccard(sets[i], sets[j]) >= threshold) pairs += 1;
    }
  }
  return pairs;
}

// Repeated word-trigram ratio (padding by verbatim repetition).
export function repeatedTrigramRatio(text) {
  const words = (String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  if (words.length < 30) return 0;
  const grams = new Map();
  let total = 0;
  for (let i = 0; i + 2 < words.length; i += 1) { const g = words[i] + " " + words[i + 1] + " " + words[i + 2]; grams.set(g, (grams.get(g) || 0) + 1); total += 1; }
  let repeated = 0;
  for (const n of grams.values()) if (n > 1) repeated += n - 1;
  return Number((repeated / Math.max(1, total)).toFixed(4));
}

// Truncation: the last non-empty paragraph must end on terminal punctuation (or a closing quote after
// terminal punctuation). Ending on a letter/comma/conjunction indicates a cut-off / streaming truncation.
export function looksTruncated(text) {
  const paras = splitParagraphs(text);
  if (!paras.length) return true;
  const last = paras[paras.length - 1];
  if (/[.!?…。]["”»“'’)]?\s*$/u.test(last)) return false;
  if (/["”»“'’]\s*$/u.test(last) && /[.!?…]["”»“'’]\s*$/u.test(last)) return false;
  return true;
}

// P0 Step 5C.34 — `characterNames` (harvested from the story DNA) lets the repetition detector tell a
// story naming its own cast apart from a story padding itself. Omitted -> the detector still runs, it
// just cannot credit entity echoes, so callers that have a DNA should always pass it.
export function computeStoryMetrics(storyText, { locale = "bg-BG", profile = null, characterNames = [] } = {}) {
  const text = String(storyText || "");
  const paragraphs = splitParagraphs(text);
  const words = wordCount(text);
  const dlgWords = dialogueWordCount(text);
  const stats = paragraphLengthStats(paragraphs);
  const sentences = (text.match(/[.!?…]+/gu) || []).length;
  return Object.freeze({
    actualWordCount: words,
    estimatedReadingSeconds: estimatedReadingSeconds(words, locale, profile),
    paragraphCount: paragraphs.length,
    sentenceCount: sentences,
    dialogueWordCount: dlgWords,
    dialogueRatio: words > 0 ? Number((dlgWords / words).toFixed(4)) : 0,
    avgParagraphWords: stats.avg,
    longestParagraphWords: stats.longest,
    paragraphLengthCv: stats.cv,
    nearDuplicateParagraphs: nearDuplicateParagraphs(paragraphs),
    // Kept for continuity of the historical metric (it is still shown and still stored); it is no
    // longer what DECIDES padding, because it cannot tell Danish grammar from filler.
    repeatedTrigramRatio: repeatedTrigramRatio(text),
    // The repetition score is about repeated SPANS. Near-duplicate paragraphs are a separate structural
    // signal with its own gate threshold (`maxNearDupPairs`) — feeding them in here too would count the
    // same defect twice and make that threshold unable to relax anything.
    repetition: detectRepetition(text, { locale, characterNames }),
    truncated: looksTruncated(text)
  });
}

// Length gate: enforces the word floor + no-truncation + no-padding. Returns { pass, state, reasons }.
// lengthGateState ∈ PASS | BELOW_MIN | TRUNCATED | PADDED | ABOVE_MAX_SOFT. Padding thresholds are
// configurable (default strict); tests that isolate orchestration from content quality may relax them.
// `repetitionHard` / `repetitionSoft` are the language-aware bands the gate actually decides on;
// `maxTrigramRatio` remains only for metrics produced without a repetition result. Both are on the
// THRESHOLDS object so a caller that relaxes the gate (a fixture, an experiment) relaxes the real
// decision rather than a vestigial one it no longer uses.
export const DEFAULT_LENGTH_GATE_THRESHOLDS = Object.freeze({ maxNearDupPairs: 1, maxTrigramRatio: 0.05, repetitionSoft: 0.05, repetitionHard: 0.12 });
// P0 Step 5C.34 — padding is decided by the LANGUAGE-AWARE detector when the metrics carry one
// (`metrics.repetition`, produced by computeStoryMetrics). Only a HARD verdict fails the gate; a SOFT
// verdict is reported as repairable rather than fatal, because a story that merely leans on a phrase
// is a story to tidy, not a story to throw away. Metrics WITHOUT a repetition result fall back to the
// historical trigram ratio, so older callers and fixtures behave exactly as before.
export function lengthGate(metrics, target, thresholds = DEFAULT_LENGTH_GATE_THRESHOLDS) {
  const th = { ...DEFAULT_LENGTH_GATE_THRESHOLDS, ...(thresholds || {}) };
  const reasons = [];
  const rep = metrics.repetition || null;
  // Band the SCORE against this call's thresholds rather than trusting the band the detector stamped with
  // its own defaults — otherwise a caller could not relax (or tighten) the gate at all.
  const hardRepetition = rep ? rep.score > th.repetitionHard : metrics.repeatedTrigramRatio > th.maxTrigramRatio;
  const softRepetition = rep ? (!hardRepetition && rep.score > th.repetitionSoft) : false;
  const band = rep ? (hardRepetition ? REPETITION_BAND.HARD_REPAIR_OR_REVIEW : softRepetition ? REPETITION_BAND.SOFT_REPAIR : REPETITION_BAND.PASS) : null;
  const paddedParagraphs = metrics.nearDuplicateParagraphs > th.maxNearDupPairs;
  const padded = paddedParagraphs || hardRepetition;
  if (metrics.truncated) reasons.push("E_STORY_TRUNCATED");
  if (metrics.actualWordCount < target.wordsMin) reasons.push(`E_STORY_BELOW_MIN:${metrics.actualWordCount}<${target.wordsMin}`);
  if (paddedParagraphs) reasons.push(`E_STORY_PADDED_PARAGRAPHS:${metrics.nearDuplicateParagraphs}`);
  if (hardRepetition) reasons.push(`E_STORY_PADDED_REPETITION:${rep ? rep.score : metrics.repeatedTrigramRatio}`);
  const state = metrics.truncated ? "TRUNCATED"
    : metrics.actualWordCount < target.wordsMin ? "BELOW_MIN"
      : padded ? "PADDED"
        : metrics.actualWordCount > target.wordsMax * 1.25 ? "ABOVE_MAX_SOFT" : "PASS";
  return Object.freeze({
    pass: reasons.length === 0, state, reasons: Object.freeze(reasons),
    repetitionBand: band,
    repetitionScore: rep ? rep.score : (metrics.repeatedTrigramRatio ?? null),
    softRepetition,
    // A gate failure that still has usable prose is REPAIRABLE: the fix is a targeted edit, never a
    // regeneration. Truncation is the exception — a cut-off draft has to be finished, not tidied.
    repairable: reasons.length > 0 && !metrics.truncated && metrics.actualWordCount > 0
  });
}

// Filler score (0..1, higher = less filler): penalizes repeated trigrams, near-dup paragraphs, and
// suspiciously uniform paragraph lengths.
export function fillerScore(metrics) {
  let s = 1;
  s -= Math.min(0.5, metrics.repeatedTrigramRatio * 8);
  s -= Math.min(0.3, metrics.nearDuplicateParagraphs * 0.15);
  if (metrics.paragraphLengthCv < 0.25 && metrics.paragraphCount >= 6) s -= 0.2; // too-uniform → padded
  return Number(Math.max(0, Math.min(1, s)).toFixed(4));
}
