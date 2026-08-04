// P0 Step 5C.16 — logic + continuity guards (pure, deterministic).
//
// BEFORE writing: validate the DNA is internally coherent (relationships present, evidence + leverage
// established, the counter-move is grounded in that leverage — no magic/deus-ex-machina, the
// consequence is proportional to the leverage, the timeline is ordered, money has a currency).
// AFTER writing: re-extract facts from the finished prose and diff them against the frozen DNA (the
// protagonist + antagonists appear, the quoted line is present, the reversal is grounded, evidence is
// established BEFORE the reversal, the money amounts are consistent, and the story actually resolves).
// Everything is deterministic so READY can be gated on it.

import { storyError, normalizeToken, tokenSet, jaccard } from "./story-common.mjs";

const MAGIC = /\b(magic|miracle|dream|ghost|supernatural|fate intervened|out of nowhere|suddenly a stranger)\b/i;
const VIOLENCE = /\b(kill|killed|murder|stab|beat him|beat her|assault|gun|knife|blood|hit her|hit him)\b/i;
const CRIMINAL_ESCALATION = /\b(arrested|prison|jailed|police raid|handcuff)\b/i;

function tokens(s) { return new Set(normalizeToken(s).split(" ").filter((t) => t.length >= 3)); }
function overlap(a, b) { const A = tokens(a), B = tokens(b); for (const t of A) if (B.has(t)) return true; return false; }

// Cyrillic -> Latin romanization (official Bulgarian 2009 table; ъ->a, so "Димитър" -> "Dimitar").
// The model sometimes writes a DNA name in Latin transliteration while writing the prose in native
// Cyrillic; romanizing BOTH sides lets the name/quote presence checks match across scripts. It only ever
// ADDS a match (used as an OR fallback), so it can never turn a present name into an absent one.
const CYR2LAT = { "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sht", "ъ": "a", "ь": "y", "ю": "yu", "я": "ya", "ё": "e", "ы": "y", "э": "e", "і": "i", "ї": "yi", "є": "ye", "ґ": "g" };
export function romanizeCyrillic(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const lo = ch.toLowerCase();
    out += Object.prototype.hasOwnProperty.call(CYR2LAT, lo) ? CYR2LAT[lo] : ch;
  }
  return out;
}

// ---- pre-write: DNA coherence -------------------------------------------------------------------
export function validateDnaLogic(dna) {
  const errors = [], warnings = [];
  if (!dna || typeof dna !== "object") return { pass: false, errors: ["E_DNA_MISSING"], warnings };

  for (const a of dna.antagonistList) if (!a.relationship) warnings.push(`antagonist "${a.name}" has no relationship to the protagonist`);

  if (!dna.evidenceType) errors.push("E_LOGIC_NO_EVIDENCE");
  if (!dna.hiddenLeverage) errors.push("E_LOGIC_NO_LEVERAGE");
  if (!dna.counterMove) errors.push("E_LOGIC_NO_COUNTER_MOVE");

  // The reversal must be grounded in the leverage/evidence/ownership facts (no deus ex machina).
  const groundSources = [dna.hiddenLeverage, dna.evidenceType, dna.counterMove, ...(dna.legalOrOwnershipFacts || [])].join(" ");
  if (dna.reversal && !overlap(dna.reversal, groundSources)) warnings.push("E_LOGIC_REVERSAL_UNGROUNDED");
  if (MAGIC.test([dna.reversal, dna.counterMove, dna.incitingIncident].join(" "))) errors.push("E_LOGIC_DEUS_EX_MACHINA");

  // The counter-move must connect to the leverage (feasibility).
  if (dna.counterMove && dna.hiddenLeverage && !overlap(dna.counterMove, [dna.hiddenLeverage, dna.evidenceType].join(" ")))
    warnings.push("E_LOGIC_COUNTER_MOVE_UNGROUNDED");

  // Consequence proportional to leverage: quiet-justice genre — flag violence/criminal escalation.
  const consequenceText = (dna.consequences || []).join(" ");
  if (VIOLENCE.test(consequenceText) || VIOLENCE.test(dna.counterMove || "")) errors.push("E_LOGIC_DISPROPORTIONATE_VIOLENCE");
  if (CRIMINAL_ESCALATION.test(consequenceText) && !/\b(document|fraud|forgery|record|deed|contract|police report)\b/i.test(groundSources))
    warnings.push("E_LOGIC_CRIMINAL_ESCALATION_UNSUPPORTED");

  // Timeline order: if `when` values are numeric-ish years, they must be non-decreasing.
  const years = (dna.timeline || []).map((t) => { const m = /\b(19|20)\d{2}\b/.exec(t.when || t.event || ""); return m ? Number(m[0]) : null; }).filter((y) => y !== null);
  for (let i = 1; i < years.length; i += 1) if (years[i] < years[i - 1]) { warnings.push("E_LOGIC_TIMELINE_OUT_OF_ORDER"); break; }

  // Money must carry a currency.
  for (const m of dna.monetaryFacts || []) if (m.amount != null && !m.currency) warnings.push(`money "${m.label}" has an amount but no currency`);

  return { pass: errors.length === 0, errors, warnings };
}

// ---- post-write: story-vs-DNA continuity --------------------------------------------------------
// Returns { pass, violations, warnings, extracted }. Violations fail READY; warnings are advisory.
export function checkStoryContinuity(storyText, dna, { locale = null } = {}) {
  const violations = [], warnings = [];
  const text = String(storyText || "");
  const lower = text.toLowerCase();
  const lowerRoman = romanizeCyrillic(lower);
  // present either verbatim OR after romanizing both sides (Latin DNA name vs Cyrillic prose, or vice versa)
  const has = (frag) => {
    if (!frag) return false;
    const f = String(frag).toLowerCase();
    return lower.includes(f) || lowerRoman.includes(romanizeCyrillic(f));
  };

  // protagonist present (by name or occupation)
  if (dna.protagonist && !has(dna.protagonist) && !(dna.protagonistOccupation && has(dna.protagonistOccupation.split(/\s+/)[0])))
    warnings.push("E_CONTINUITY_PROTAGONIST_ABSENT");

  // every antagonist named in the DNA appears — matched by ANY significant name token (>=3 chars), since
  // native prose usually refers to a character by first name, not the full "First Last" from the DNA.
  for (const a of dna.antagonistList) {
    if (!a.name || /Antagonist \d/.test(a.name)) continue;
    const tokens = a.name.split(/\s+/).filter((t) => t.length >= 3);
    const present = tokens.length ? tokens.some((t) => has(t)) : has(a.name);
    if (!present) violations.push(`E_CONTINUITY_ANTAGONIST_ABSENT:${a.name}`);
  }

  // the unforgivable quoted line is present (loose: a distinctive slice appears, or the exact quote)
  if (dna.unforgivableQuote) {
    const slice = dna.unforgivableQuote.replace(/^["“”«»„]+|["“”«»„]+$/g, "").slice(0, 20);
    if (slice && !has(slice)) {
      // allow a paraphrase only if SOME quoted speech exists; otherwise it's a hard miss
      if (!/["“”«»„].{6,}["“”«»„]/u.test(text)) violations.push("E_CONTINUITY_QUOTE_MISSING");
      else warnings.push("E_CONTINUITY_QUOTE_PARAPHRASED");
    }
  }

  // money amounts from the DNA are consistent (each amount that appears keeps its currency nearby)
  for (const m of dna.monetaryFacts || []) {
    if (m.amount == null) continue;
    const amountStr = String(m.amount);
    const grouped = m.amount.toLocaleString("en-US");
    if (!has(amountStr) && !has(grouped)) warnings.push(`E_CONTINUITY_AMOUNT_ABSENT:${m.label}`);
  }

  // evidence must be established BEFORE the reversal (ordering in the prose)
  const evTok = dna.evidenceType ? normalizeToken(dna.evidenceType).split(" ").filter((t) => t.length >= 4)[0] : null;
  const rvTok = dna.reversal ? normalizeToken(dna.reversal).split(" ").filter((t) => t.length >= 4)[0] : null;
  if (evTok && rvTok) {
    const evIdx = lower.indexOf(evTok), rvIdx = lower.indexOf(rvTok);
    if (evIdx >= 0 && rvIdx >= 0 && evIdx > rvIdx) violations.push("E_CONTINUITY_EVIDENCE_AFTER_REVERSAL");
    if (evIdx < 0) warnings.push("E_CONTINUITY_EVIDENCE_NOT_SHOWN");
  }

  // the reversal is grounded (its wording overlaps established leverage/evidence)
  if (dna.reversal && !overlap(dna.reversal, [dna.hiddenLeverage, dna.evidenceType, ...(dna.legalOrOwnershipFacts || [])].join(" ")))
    warnings.push("E_CONTINUITY_REVERSAL_UNGROUNDED");

  // the story resolves. A truncated story (too few paragraphs) is a hard violation; a full story that
  // lacks a detectable resolution signal is only a warning (the signal words are language-dependent and
  // native prose won't match the English DNA fields, so absence != real omission).
  const paragraphCount = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length;
  const tail = text.slice(Math.floor(text.length * 0.75)).toLowerCase();
  const resolves = (dna.emotionalResolution && overlap(dna.emotionalResolution, tail)) || (dna.finalBoundary && overlap(dna.finalBoundary, tail));
  const boundaryish = /\b(boundary|no longer|from now on|never again|i was done|i chose|peace|my own|kept|distance|enough)\b/i.test(tail);
  if (paragraphCount < 6) violations.push("E_CONTINUITY_UNRESOLVED_ENDING");
  else if (!resolves && !boundaryish) warnings.push("E_CONTINUITY_RESOLUTION_SIGNAL_WEAK");

  // no deus-ex-machina/violence introduced in the prose
  if (MAGIC.test(text)) violations.push("E_CONTINUITY_DEUS_EX_MACHINA");
  if (VIOLENCE.test(text)) violations.push("E_CONTINUITY_VIOLENCE");

  return Object.freeze({
    pass: violations.length === 0,
    violations: Object.freeze(violations), warnings: Object.freeze(warnings),
    extracted: Object.freeze({ quotesPresent: /["“”«»„].{6,}["“”«»„]/u.test(text) })
  });
}

// A lexical-consistency helper: how much of the DNA's spine vocabulary made it into the prose
// (0..1). Low values suggest the writer drifted from the frozen facts.
export function dnaCoverage(storyText, dna) {
  const spine = [dna.incitingIncident, dna.publicHumiliation, dna.hiddenLeverage, dna.reversal, dna.emotionalResolution, ...(dna.escalationSteps || [])].join(" ");
  return Number(jaccard(tokenSet(storyText), tokenSet(spine)).toFixed(4));
}
