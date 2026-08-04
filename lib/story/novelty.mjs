// P0 Step 5C.16 — Novelty guard (pure, multi-signal, provider-free).
//
// Originality is enforced structurally, not just by text embedding. A fingerprint captures the 13
// canonical categorical axes (roles/relationships/mechanisms — NOT proper names), plus lexical, title
// and plot-beat token bags. Similarity blends: categorical (axis overlap), lexical (story tokens),
// title, and plot-beat. A rename-only duplicate (swap names/country/currency/mother→aunt) keeps the
// SAME categorical axes → high categorical similarity → rejected. A translation keeps the same
// categorical axes but different lexical/title → the categorical "structuralDuplicate" gate rejects it
// regardless of language. The categorical axes are canonical (English) so cross-locale comparison is
// meaningful even when the prose differs by language.

import { ORIGINALITY_AXES } from "./story-dna.mjs";
import { tokenSet, jaccard, normalizeToken, storyError } from "./story-common.mjs";

export const DEFAULT_NOVELTY_THRESHOLDS = Object.freeze({
  overall: 0.62,            // reject if blended similarity to any prior story >= this
  structuralDuplicate: 0.86, // reject outright: categorical axes almost identical (rename/translation)
  axisMatch: 0.6,           // per-axis jaccard at/above which an axis counts as "the same"
  weights: Object.freeze({ categorical: 0.45, lexical: 0.2, title: 0.15, plotBeat: 0.2 })
});

// Build a comparable fingerprint from a story candidate. `axes` are the canonical categorical values;
// lexical/title/plotBeat are precomputed token bags (stored as sorted arrays for persistence).
export function buildFingerprint({ originalityDimensions = {}, title = "", storyText = "", outlineBeats = [] } = {}) {
  const axes = {};
  for (const axis of ORIGINALITY_AXES) axes[axis] = normalizeToken(originalityDimensions[axis] || "");
  const lexical = [...tokenSet(storyText)].sort();
  const titleTokens = [...tokenSet(title, 2)].sort();
  const beatText = (Array.isArray(outlineBeats) ? outlineBeats : []).map((b) => (b && (b.summary || b.label)) || String(b)).join(" ");
  const plotBeat = [...tokenSet(beatText)].sort();
  return Object.freeze({ axes: Object.freeze(axes), lexical, titleTokens, plotBeat });
}

function axisSets(fp) {
  const out = {};
  for (const axis of ORIGINALITY_AXES) out[axis] = new Set(String(fp.axes?.[axis] || "").split(" ").filter(Boolean));
  return out;
}

// Compare two fingerprints → per-signal similarities + a blended overall + a structuralDuplicate flag.
export function compareFingerprints(a, b, thresholds = DEFAULT_NOVELTY_THRESHOLDS) {
  const aAxes = axisSets(a), bAxes = axisSets(b);
  let axisSum = 0, axisMatches = 0;
  for (const axis of ORIGINALITY_AXES) {
    const s = jaccard(aAxes[axis], bAxes[axis]);
    axisSum += s;
    if (s >= thresholds.axisMatch) axisMatches += 1;
  }
  const categorical = axisSum / ORIGINALITY_AXES.length;
  const structuralMatchRatio = axisMatches / ORIGINALITY_AXES.length;
  const lexical = jaccard(new Set(a.lexical), new Set(b.lexical));
  const title = jaccard(new Set(a.titleTokens), new Set(b.titleTokens));
  const plotBeat = jaccard(new Set(a.plotBeat), new Set(b.plotBeat));
  const w = thresholds.weights;
  const overall = w.categorical * categorical + w.lexical * lexical + w.title * title + w.plotBeat * plotBeat;
  // A structural duplicate: the categorical axes (and thus the plot machine) are almost identical, even
  // if the words/language differ. Uses the higher of average categorical and axis-match ratio.
  const structuralDuplicate = Math.max(categorical, structuralMatchRatio) >= thresholds.structuralDuplicate;
  return Object.freeze({ categorical, structuralMatchRatio, lexical, title, plotBeat, overall, structuralDuplicate });
}

// Assess a candidate against previously accepted fingerprints. Returns pass + the nearest matches +
// a structured report. `existing` = [{ storyProjectId, locale, title, fingerprint }].
export function assessNovelty({ candidate, existing = [], thresholds = DEFAULT_NOVELTY_THRESHOLDS } = {}) {
  if (!candidate || !candidate.axes) throw storyError("E_NOVELTY_INPUT", "candidate fingerprint required");
  const scored = existing.filter((e) => e && e.fingerprint).map((e) => {
    const cmp = compareFingerprints(candidate, e.fingerprint, thresholds);
    return { storyProjectId: e.storyProjectId || null, locale: e.locale || null, title: e.title || null, similarity: cmp };
  }).sort((x, y) => y.similarity.overall - x.similarity.overall);

  const worst = scored[0] || null;
  const structuralHit = scored.find((s) => s.similarity.structuralDuplicate) || null;
  const overThreshold = worst && worst.similarity.overall >= thresholds.overall;
  const pass = !structuralHit && !overThreshold;
  let reason = null;
  if (structuralHit) reason = "E_NOVELTY_STRUCTURAL_DUPLICATE";
  else if (overThreshold) reason = "E_NOVELTY_TOO_SIMILAR";

  return Object.freeze({
    pass, reason,
    maxOverall: worst ? worst.similarity.overall : 0,
    nearest: Object.freeze(scored.slice(0, 5).map((s) => Object.freeze({
      storyProjectId: s.storyProjectId, locale: s.locale, title: s.title,
      overall: Number(s.similarity.overall.toFixed(4)),
      categorical: Number(s.similarity.categorical.toFixed(4)),
      lexical: Number(s.similarity.lexical.toFixed(4)),
      title: Number(s.similarity.title.toFixed(4)),
      plotBeat: Number(s.similarity.plotBeat.toFixed(4)),
      structuralDuplicate: s.similarity.structuralDuplicate
    }))),
    thresholds: Object.freeze({ overall: thresholds.overall, structuralDuplicate: thresholds.structuralDuplicate })
  });
}
