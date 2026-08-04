// P0 Step 5C.16 — title engine (pure): candidate prompt, parser, validator, ranker.
//
// The generator returns >=5 native-language candidates; this module validates + ranks them. A good
// title is first-person, long, names the event + the relative + the hurtful act (often a quoted line),
// hints at the counter-move but does NOT spoil the whole outcome, reads naturally in the target
// language (not a word-by-word English translation), matches the story's facts (no invented details),
// and is not structurally too close to recent titles.

import { cleanInline, tokenSet, jaccard, overlapCoefficient, normalizeToken, storyError } from "./story-common.mjs";
import { detectLocaleFluency } from "./quality-scorecard.mjs";

const STOP_NAMEISH = new Set(["the", "and", "a", "an", "of", "to", "at", "in", "on", "my", "i", "was", "said", "but", "just", "not"]);

export function buildTitlePrompt({ dna, profile, count = 6 } = {}) {
  const antag = dna.antagonistList.map((a) => `${a.name} (${a.relationship || "relative"})`).join(", ");
  return [
    `Write ${count} distinct ${profile.language} titles for a first-person family-drama story.`,
    `Style: ${profile.titlePattern}.`,
    `The story: protagonist ${dna.protagonist}; the relative(s) who wronged them: ${antag}.`,
    `The event: ${dna.publicHumiliation || dna.incitingIncident}. The hurtful quoted line: "${dna.unforgivableQuote}".`,
    `They did not argue — they made a quiet counter-move (hint at it, do NOT reveal the full outcome).`,
    `Each title must be long, first-person, natural in ${profile.language} (NOT a word-by-word English translation), and must not spoil the ending.`,
    "Return ONLY a fenced json code block: {\"titles\":[\"...\",\"...\"]}."
  ].join(" ");
}

export function parseTitleCandidates(text) {
  const raw = String(text || "");
  let arr = null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fence ? fence[1] : raw;
  try { const p = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)); if (Array.isArray(p.titles)) arr = p.titles; } catch { /* fall through */ }
  if (!arr) arr = raw.split(/\n+/).map((l) => l.replace(/^\s*[-*\d.)"]+\s*/, "").trim()).filter((l) => l.length > 8);
  return arr.map((t) => cleanInline(t, 240)).filter((t) => t.length >= 8).slice(0, 12);
}

// Named entities the title is allowed to reference (DNA people + setting).
function allowedEntities(dna) {
  const set = new Set();
  for (const n of [dna.protagonist, dna.settingCityOrRegion, dna.settingCountry, ...dna.antagonistList.map((a) => a.name)]) {
    for (const t of normalizeToken(n).split(" ")) if (t.length >= 3) set.add(t);
  }
  return set;
}

// Validate one title. Returns { valid, score, reasons: [...] }.
export function validateTitle(title, { dna, profile, storyText = "", recentTitles = [] } = {}) {
  const reasons = [];
  const t = cleanInline(title, 240);
  const words = (t.match(/[\p{L}\p{N}’'-]+/gu) || []);
  let score = 1;

  if (words.length < 6) { reasons.push("E_TITLE_TOO_SHORT"); score -= 0.35; }
  if (words.length > 40) { reasons.push("E_TITLE_TOO_LONG"); score -= 0.1; }

  // natural in the target language (not English word-by-word)
  const fluency = detectLocaleFluency(t + " " + t, profile.locale); // duplicate to clear the 30-word floor
  if (fluency < 0.5) { reasons.push("E_TITLE_NOT_NATIVE"); score -= 0.3; }

  // content match: how much of the TITLE's vocabulary is grounded in the story/DNA (overlap coefficient
  // — robust for a short title against a long story). The quoted line + names are the strongest anchors.
  const dnaText = [dna.incitingIncident, dna.publicHumiliation, dna.unforgivableQuote, dna.counterMove, storyText, ...dna.antagonistList.map((a) => `${a.name} ${a.relationship}`)].join(" ");
  const match = overlapCoefficient(tokenSet(t, 3), tokenSet(dnaText, 3));
  if (match < 0.15) { reasons.push("E_TITLE_CONTENT_MISMATCH"); score -= 0.3; }

  // no invented named entities: capitalized-ish tokens should be known DNA entities or common words
  const allow = allowedEntities(dna);
  for (const w of words) {
    const nt = normalizeToken(w);
    if (nt.length >= 4 && /^[A-ZÅÄÖÆØ]/.test(w) && !allow.has(nt) && !STOP_NAMEISH.has(nt)) {
      // only flag things that look like proper names (not sentence-initial common words)
      if (!/^(jag|мен|jeg|аз|min|мо|the|i)$/i.test(w) && words.indexOf(w) !== 0) { reasons.push(`E_TITLE_INVENTED_ENTITY:${w}`); score -= 0.15; break; }
    }
  }

  // no full spoiler: title must not reveal the resolution/consequence verbatim
  const resolutionTok = tokenSet([dna.emotionalResolution, ...(dna.consequences || [])].join(" "), 4);
  const spoilerOverlap = jaccard(tokenSet(t, 4), resolutionTok);
  if (spoilerOverlap > 0.35) { reasons.push("E_TITLE_SPOILS_ENDING"); score -= 0.2; }

  // not too close to a recent title
  let maxRecent = 0;
  for (const r of recentTitles) maxRecent = Math.max(maxRecent, jaccard(tokenSet(t, 3), tokenSet(r, 3)));
  if (maxRecent > 0.6) { reasons.push("E_TITLE_TOO_SIMILAR_RECENT"); score -= 0.25; }

  score = Math.max(0, Math.min(1, score));
  const valid = !reasons.some((r) => r === "E_TITLE_NOT_NATIVE" || r === "E_TITLE_CONTENT_MISMATCH" || r.startsWith("E_TITLE_INVENTED_ENTITY") || r === "E_TITLE_SPOILS_ENDING");
  return Object.freeze({ title: t, valid, score: Number(score.toFixed(4)), reasons: Object.freeze(reasons), fluency: Number(fluency.toFixed(3)), recentSimilarity: Number(maxRecent.toFixed(3)) });
}

// Rank candidates best-first. Ties broken by longer (more specific) title.
export function rankTitleCandidates(candidates, ctx = {}) {
  const scored = (candidates || []).map((t) => validateTitle(t, ctx)).sort((a, b) => (b.valid - a.valid) || (b.score - a.score) || (b.title.length - a.title.length));
  if (!scored.length) throw storyError("E_TITLE_NONE", "no title candidates");
  return Object.freeze(scored.map((s) => Object.freeze(s)));
}
