// P0 Step 5C.35 — DETERMINISTIC TITLE DERIVATION (pure, no provider).
//
// A story that has been repaired still needs a title, and asking the model for one costs a browser session,
// a provider lease and a slot in the pacing lane — for a job that the story's own prose can usually do.
//
// The idea is narrow: a good title for this genre is a CLAUSE the story already wrote. It names the
// protagonist or the antagonist, it carries the humiliation or the counter-move, and it is in the story's
// own language by construction — which is the part a generated title most often gets wrong. So candidates
// are harvested from the prose itself (plus a few DNA-composed ones), trimmed to a headline-length clause,
// and then judged by the SAME validateTitle() the model's candidates go through. Nothing is accepted that
// the existing validator would not accept from the model.
//
// If nothing clears the bar, this returns null and the caller falls back to the TITLE provider stage. The
// point is to make the provider call unnecessary, not to make it impossible.

import { validateTitle, rankTitleCandidates } from "./title-engine.mjs";

// Headline length. validateTitle already refuses < 6 words; the upper bound here is tighter than its 40 so
// a deterministic title is a CLAUSE, never the whole opening sentence.
const MIN_WORDS = 7;
const MAX_WORDS = 22;
// Only accept a deterministic title that the validator likes clearly. Below this, a model title is worth
// the call.
export const DETERMINISTIC_TITLE_MIN_SCORE = 0.7;

const words = (s) => (String(s || "").match(/[\p{L}\p{N}’'-]+/gu) || []);

// Split into sentences without losing the text (Unicode-safe, keeps quotes attached).
function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?…])[\s ]+(?=[\p{Lu}"“«„])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Trim a sentence to a headline clause: drop a trailing subordinate tail at a comma/dash/colon when the
// sentence is too long, and strip terminal punctuation. Never invents or reorders words.
function toClause(sentence) {
  let s = String(sentence || "").trim().replace(/\s+/gu, " ");
  // Dialogue is the richest source of headlines, but the sentence splitter keeps the narration that follows
  // the closing quote ("…ikke dit." Inger nikkede langsomt). Cut at the close: the quoted line IS the title.
  const close = s.search(/["”»“](?=\s|$)/u);
  if (close > 20) s = s.slice(0, close);
  s = s
    .replace(/^[-–—•\s"“«„”»]+/u, "")
    .replace(/["“«„”»]+$/u, "")
    .replace(/[.!?…]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (words(s).length <= MAX_WORDS) return s;
  // Prefer a natural break; take the longest prefix that still fits.
  const parts = s.split(/\s*[,;:—–]\s+/u);
  let out = "";
  for (const p of parts) {
    const next = out ? `${out}, ${p}` : p;
    if (words(next).length > MAX_WORDS) break;
    out = next;
  }
  if (words(out).length >= MIN_WORDS) return out;
  return words(s).slice(0, MAX_WORDS).join(" ");
}

function nameTokens(dna) {
  const raw = [dna?.protagonist, ...(Array.isArray(dna?.antagonistList) ? dna.antagonistList.map((a) => a?.name) : [])]
    .filter((x) => typeof x === "string" && x.trim().length > 1);
  const out = new Set();
  for (const n of raw) for (const t of n.split(/\s+/u)) if (t.length > 1) out.add(t);
  return [...out];
}

/**
 * Harvest title candidates from a finished story. Ordered by how likely each source is to make a headline;
 * the caller ranks them properly with the shared validator.
 */
export function deterministicTitleCandidates({ storyText, dna } = {}) {
  const out = [];
  const seen = new Set();
  // Provenance travels with the candidate. Where a clause came from is the strongest signal about whether
  // it makes a headline — and, in particular, a clause taken from the closing beat is the ending, which is
  // the one thing a title of this genre must not give away.
  const push = (s, source) => {
    const c = toClause(s);
    const n = words(c).length;
    if (n < MIN_WORDS || n > MAX_WORDS) return;
    const key = c.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title: c, source });
  };

  const sents = sentences(storyText);
  const names = nameTokens(dna);
  const hasName = (s) => names.some((n) => s.includes(n));

  // 1. The sentence carrying the unforgivable line — the genre's natural headline.
  const quote = typeof dna?.unforgivableQuote === "string" ? dna.unforgivableQuote.trim() : "";
  if (quote.length > 8) {
    const q = quote.slice(0, 40);
    for (const s of sents) if (s.includes(q)) push(s, "QUOTE");
    push(quote, "QUOTE");
  }
  // 2. Early sentences that NAME someone: a title should say who this is about.
  for (const s of sents.slice(0, 14)) if (hasName(s)) push(s, "NAMED");
  // 3. The closing movement. Kept as a candidate — sometimes it is all the story offers — but marked, so
  //    the ranking can prefer almost anything else.
  for (const s of sents.slice(-6)) if (hasName(s)) push(s, "CLOSING");
  // 4. DNA-composed, still in the story's own language: the inciting incident is written in-locale.
  if (typeof dna?.incitingIncident === "string") push(dna.incitingIncident, "DNA");
  if (typeof dna?.publicHumiliation === "string") push(dna.publicHumiliation, "DNA");
  // 5. Any early sentence at all, as a last resort.
  for (const s of sents.slice(0, 8)) push(s, "OPENING");

  return out;
}

// validateTitle answers "is this a legitimate title" — native, grounded, no invented entity, no spoiler.
// It deliberately does not answer "is this a good HEADLINE", and on real stories it happily gives 1.0 to a
// grammatical but inert sentence. Shape scoring is the missing half: for this genre a headline names
// someone and carries the insult or the humiliation.
function shapeScore(title, { dna, quote, source }) {
  const n = words(title).length;
  let s = 0.5;
  if (quote && quote.length > 8) {
    const q = quote.slice(0, 40).toLowerCase();
    if (title.toLowerCase().includes(q)) s += 0.30;
  }
  // The ending is not a headline. validateTitle catches a title that restates the resolution verbatim, but
  // a clause LIFTED from the closing beat can slip past that check while still giving the story away.
  if (source === "CLOSING") s -= 0.35;
  if (source === "QUOTE") s += 0.10;
  if (nameTokens(dna).some((t) => title.includes(t))) s += 0.20;
  if (n >= 8 && n <= 18) s += 0.10;
  // A clause that opens with a subordinating/coordinating word reads as a fragment torn off a longer
  // sentence. Checked across the supported locales' most common openers.
  if (/^(fordi|men|og|som|der|at|når|hvis|mens|för|men|och|som|att|när|om|medan|защото|но|и|който|която|когато|ако|докато|because|but|and|which|that|when|if|while)\b/iu.test(title)) s -= 0.30;
  // A trailing comma-continuation means the clause was cut, not closed.
  if (/[,;:—–]$/u.test(title)) s -= 0.20;
  return Math.max(0, Math.min(1, s));
}

/**
 * Pick a title without calling a provider. Returns { title, score, source: 'DETERMINISTIC', candidates }
 * or null when nothing clears the bar — in which case the caller should run the TITLE stage.
 */
export function deriveTitle({ storyText, dna, profile, recentTitles = [], minScore = DETERMINISTIC_TITLE_MIN_SCORE } = {}) {
  const raw = deterministicTitleCandidates({ storyText, dna });
  if (!raw.length) return null;
  const sourceOf = new Map(raw.map((r) => [r.title.toLowerCase(), r.source]));
  let ranked;
  try {
    ranked = rankTitleCandidates(raw.map((r) => r.title), { dna, profile, storyText, recentTitles });
  } catch { return null; }
  const quote = typeof dna?.unforgivableQuote === "string" ? dna.unforgivableQuote.trim() : "";
  const scored = ranked
    .filter((r) => r.valid && r.score >= minScore)
    .map((r) => ({ ...r, source: sourceOf.get(r.title.toLowerCase()) || "OPENING" }))
    .map((r) => ({ ...r, shape: shapeScore(r.title, { dna, quote, source: r.source }) }))
    .map((r) => ({ ...r, combined: Number((r.score * 0.6 + r.shape * 0.4).toFixed(4)) }))
    .sort((a, b) => b.combined - a.combined);
  const best = scored[0] || null;
  if (!best) return null;
  return Object.freeze({
    title: best.title, score: best.combined, validatorScore: best.score, shape: best.shape,
    valid: true, source: "DETERMINISTIC", origin: best.source, reasons: best.reasons,
    // The runners-up are persisted as candidates so the owner can choose another without a provider call.
    candidates: Object.freeze(scored.slice(0, 6).map((r) => Object.freeze({ title: r.title, valid: true, score: r.combined, reasons: r.reasons })))
  });
}

export { validateTitle };
