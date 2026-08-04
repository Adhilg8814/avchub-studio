// P0 Step 5C.16 — Story DNA (pure schema + freeze + fingerprint source).
//
// Story DNA is generated + validated BEFORE any prose is written and then FROZEN: the text writer may
// choose words but must not change the facts (names, ages, relationships, amounts, timeline, the
// reversal mechanism, the quoted line). dnaChecksum() is the freeze proof; the logic guard re-extracts
// facts from the finished story and diffs them against the DNA. originalityDimensions is the canonical
// categorical vector the novelty guard fingerprints. No secrets/URLs/paths ever enter a DNA.

import { createHash } from "node:crypto";
import { storyError, assertNoSecret, cleanInline } from "./story-common.mjs";

const c = (v, max) => cleanInline(v, max);
const list = (v, n, itemMax) => Object.freeze((Array.isArray(v) ? v : []).map((x) => c(x, itemMax)).filter(Boolean).slice(0, n));

// The 13 canonical originality axes (also the novelty fingerprint dimensions).
export const ORIGINALITY_AXES = Object.freeze([
  "protagonistRole", "antagonistRelationship", "settingType", "incitingIncident", "coreConflict",
  "publicHumiliation", "quotedInsultPattern", "exploitedResource", "evidenceType", "hiddenLeverage",
  "reversalMechanism", "consequence", "emotionalResolution"
]);

export const LOCALE_CURRENCY = Object.freeze({ "bg-BG": "BGN", "sv-SE": "SEK", "da-DK": "DKK" });
export function currencyForLocale(locale) { return LOCALE_CURRENCY[locale] || "EUR"; }

function normAntagonist(a, i) {
  const o = a && typeof a === "object" ? a : { name: a };
  const name = c(o.name, 80) || `Antagonist ${i + 1}`;
  const relationship = c(o.relationship, 60);
  const role = c(o.role, 120);
  assertNoSecret(name, "antagonist.name"); assertNoSecret(role, "antagonist.role");
  return Object.freeze({ name, relationship, role });
}
function normRel(r) {
  const o = r && typeof r === "object" ? r : {};
  return Object.freeze({ a: c(o.a, 80), b: c(o.b, 80), relation: c(o.relation, 60) });
}
function normMoney(m) {
  const o = m && typeof m === "object" ? m : {};
  const amount = Number.isFinite(Number(o.amount)) ? Math.round(Number(o.amount)) : null;
  return Object.freeze({ label: c(o.label, 120), amount, currency: c(o.currency, 8) || null });
}
function normTimeline(t) {
  const o = t && typeof t === "object" ? t : { event: t };
  return Object.freeze({ when: c(o.when, 60), event: c(o.event, 200) });
}

function deriveOriginality(dna, provided) {
  const src = provided && typeof provided === "object" ? provided : {};
  const out = {};
  const fallback = {
    protagonistRole: dna.protagonistOccupation || dna.protagonist,
    antagonistRelationship: (dna.antagonistList[0] && dna.antagonistList[0].relationship) || "",
    settingType: dna.settingCityOrRegion || dna.settingCountry,
    incitingIncident: dna.incitingIncident,
    coreConflict: dna.escalationSteps[0] || dna.incitingIncident,
    publicHumiliation: dna.publicHumiliation,
    quotedInsultPattern: dna.unforgivableQuote,
    exploitedResource: dna.hiddenLeverage,
    evidenceType: dna.evidenceType,
    hiddenLeverage: dna.hiddenLeverage,
    reversalMechanism: dna.reversal,
    consequence: dna.consequences[0] || "",
    emotionalResolution: dna.emotionalResolution
  };
  for (const axis of ORIGINALITY_AXES) out[axis] = c(src[axis] ?? fallback[axis] ?? "", 200);
  return Object.freeze(out);
}

export function validateStoryDNA(input = {}, { locale = null } = {}) {
  if (!input || typeof input !== "object") throw storyError("E_DNA_INVALID", "Story DNA must be an object");
  const protagonist = c(input.protagonist, 80);
  if (protagonist.length < 1) throw storyError("E_DNA_INVALID", "protagonist is required");
  const antagonistList = Object.freeze((Array.isArray(input.antagonistList) ? input.antagonistList : []).slice(0, 8).map(normAntagonist));
  if (!antagonistList.length) throw storyError("E_DNA_INVALID", "at least one antagonist is required");

  const dna = {
    protagonist,
    protagonistAgeRange: c(input.protagonistAgeRange, 40),
    protagonistOccupation: c(input.protagonistOccupation, 120),
    protagonistCoreNeed: c(input.protagonistCoreNeed, 200),
    protagonistFlaw: c(input.protagonistFlaw, 200),
    antagonistList,
    relationshipMap: Object.freeze((Array.isArray(input.relationshipMap) ? input.relationshipMap : []).slice(0, 16).map(normRel)),
    settingCountry: c(input.settingCountry, 80),
    settingCityOrRegion: c(input.settingCityOrRegion, 120),
    socialContext: c(input.socialContext, 400),
    incitingIncident: c(input.incitingIncident, 400),
    historyOfSacrifice: c(input.historyOfSacrifice, 600),
    escalationSteps: list(input.escalationSteps, 12, 300),
    publicHumiliation: c(input.publicHumiliation, 400),
    unforgivableQuote: c(input.unforgivableQuote, 300),
    hiddenLeverage: c(input.hiddenLeverage, 400),
    evidenceType: c(input.evidenceType, 200),
    counterMove: c(input.counterMove, 400),
    reversal: c(input.reversal, 400),
    consequences: list(input.consequences, 10, 300),
    emotionalResolution: c(input.emotionalResolution, 400),
    finalBoundary: c(input.finalBoundary, 300),
    closingInsight: c(input.closingInsight, 300),
    timeline: Object.freeze((Array.isArray(input.timeline) ? input.timeline : []).slice(0, 16).map(normTimeline)),
    monetaryFacts: Object.freeze((Array.isArray(input.monetaryFacts) ? input.monetaryFacts : []).slice(0, 16).map(normMoney)),
    legalOrOwnershipFacts: list(input.legalOrOwnershipFacts, 12, 300),
    continuityFacts: list(input.continuityFacts, 20, 200)
  };

  // Required narrative spine — a DNA missing the spine can never produce a valid arc.
  for (const f of ["incitingIncident", "publicHumiliation", "hiddenLeverage", "reversal", "emotionalResolution"]) {
    if (!dna[f]) throw storyError("E_DNA_INCOMPLETE", `Story DNA is missing ${f}`);
  }
  if (!dna.escalationSteps.length) throw storyError("E_DNA_INCOMPLETE", "Story DNA needs escalationSteps");
  if (!dna.consequences.length) throw storyError("E_DNA_INCOMPLETE", "Story DNA needs consequences");

  // Secret-scan all free text.
  for (const [k, v] of Object.entries(dna)) {
    if (typeof v === "string") assertNoSecret(v, `dna.${k}`);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") assertNoSecret(x, `dna.${k}[]`);
  }

  dna.settingCountry = dna.settingCountry || (locale ? locale : "");
  dna.originalityDimensions = deriveOriginality(dna, input.originalityDimensions);
  return Object.freeze(dna);
}

// Canonical JSON (sorted keys) → sha256. The freeze proof: any change to a frozen fact changes this.
export function dnaChecksum(dna) {
  const canon = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  };
  return `sha256:${createHash("sha256").update(canon(dna), "utf8").digest("hex")}`;
}

// The immutable subset the text writer must not alter (names, ages, relationships, amounts, the
// reversal mechanism, the quoted line, ownership facts). Used by the continuity guard.
export function frozenFacts(dna) {
  return Object.freeze({
    protagonist: dna.protagonist,
    protagonistAgeRange: dna.protagonistAgeRange,
    antagonists: dna.antagonistList.map((a) => `${a.name}|${a.relationship}`),
    unforgivableQuote: dna.unforgivableQuote,
    reversal: dna.reversal,
    evidenceType: dna.evidenceType,
    monetaryFacts: dna.monetaryFacts.map((m) => `${m.label}|${m.amount ?? ""}|${m.currency ?? ""}`),
    legalOrOwnershipFacts: [...dna.legalOrOwnershipFacts],
    settingCountry: dna.settingCountry
  });
}
