// P0 Step 5C.16 — Archetype library (pure, structured; NOT prompt strings).
//
// An archetype is a SELECTION SPACE, never a fixed plot. Each one offers vocabularies for the axes a
// Story DNA must pick from (protagonist role, antagonist relationship, core conflict, humiliation,
// leverage, reversal, consequence, emotional resolution) plus locale compatibility, prohibited
// combinations, and which axes carry the most novelty weight. The generator PICKS one value per axis
// (often more than one archetype's space is combined) — so two stories from the same archetype can be
// structurally very different. No secrets/URLs/paths ever appear here.

import { storyError } from "./story-common.mjs";

const ARC_RE = /^[a-z][a-z0-9-]{2,48}$/;
export const ALL_LOCALES = Object.freeze(["bg-BG", "sv-SE", "da-DK"]);

function frozenList(v) { return Object.freeze((Array.isArray(v) ? v : []).map(String)); }

export function validateArchetype(input = {}) {
  if (!input || typeof input !== "object") throw storyError("E_ARCHETYPE_INVALID", "archetype must be an object");
  const id = String(input.id || "");
  if (!ARC_RE.test(id)) throw storyError("E_ARCHETYPE_INVALID", `archetype id must be kebab-case: ${id}`);
  const name = String(input.name || "").trim();
  if (name.length < 2) throw storyError("E_ARCHETYPE_INVALID", "archetype name required");
  const compatibleLocales = frozenList(input.compatibleLocales && input.compatibleLocales.length ? input.compatibleLocales : ALL_LOCALES);
  for (const loc of compatibleLocales) if (loc !== "*" && !ALL_LOCALES.includes(loc)) throw storyError("E_ARCHETYPE_LOCALE", `unknown locale ${loc}`);
  return Object.freeze({
    id, name,
    protagonistRoles: frozenList(input.protagonistRoles),
    antagonistRelationships: frozenList(input.antagonistRelationships),
    coreConflicts: frozenList(input.coreConflicts),
    humiliationTypes: frozenList(input.humiliationTypes),
    leverageTypes: frozenList(input.leverageTypes),
    reversalTypes: frozenList(input.reversalTypes),
    consequenceTypes: frozenList(input.consequenceTypes),
    emotionalResolutionTypes: frozenList(input.emotionalResolutionTypes),
    compatibleLocales,
    prohibitedCombinations: frozenList(input.prohibitedCombinations),   // archetype ids that must not be mixed
    noveltyDimensions: frozenList(input.noveltyDimensions)
  });
}

// Shared vocabularies reused across archetypes (kept explicit so novelty comparison is stable).
const RESOLUTIONS = ["boundary set and kept", "self-respect restored", "financial independence reclaimed", "quiet distance from the family", "public dignity restored", "peace through acceptance"];
const REVERSALS = ["legal ownership proof revealed", "documented paper trail produced", "quiet transfer of control executed", "withdrawal of the support they relied on", "a witness or record surfaces", "a pre-arranged safeguard activates"];
const HUMILIATIONS = ["public insult at a gathering", "dismissive remark in front of others", "exclusion from a family event", "being talked over and belittled", "a cutting quoted line", "being blamed for someone else's failure"];

export const SEED_ARCHETYPES = Object.freeze([
  validateArchetype({
    id: "parental-favoritism", name: "Parents favor one child over another",
    protagonistRoles: ["overlooked adult child", "the dependable sibling", "the one who stayed to help"],
    antagonistRelationships: ["mother", "father", "both parents", "favored sibling"],
    coreConflicts: ["years of one-sided sacrifice ignored", "the favored sibling handed everything", "the narrator's help taken for granted"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["the narrator quietly held the real responsibility", "documented years of support", "control of a shared practical matter"],
    reversalTypes: REVERSALS, consequenceTypes: ["the family loses the help they assumed permanent", "the favored one must finally stand alone", "a fair, documented split"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["humiliation", "leverage", "consequence"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "financial-exploitation-rent", name: "A child exploits a parent's money or housing",
    protagonistRoles: ["a parent supporting an adult child", "a homeowner mother", "a retiree"],
    antagonistRelationships: ["adult daughter", "adult son", "child and their partner"],
    coreConflicts: ["rent money kept and misused", "the home treated as an entitlement", "support demanded then abused"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["the parent is the legal owner", "bank records of the transfers", "the lease is in the parent's name"],
    reversalTypes: REVERSALS, consequenceTypes: ["the arrangement quietly ends", "the child must find their own footing", "the money stops"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["leverage", "reversal", "consequence"],
    compatibleLocales: ["sv-SE", "da-DK", "bg-BG"], prohibitedCombinations: []
  }),
  validateArchetype({
    id: "ex-and-inlaw-asset-claim", name: "An ex-spouse and in-law claim assets",
    protagonistRoles: ["a divorced parent", "a homeowner after divorce", "the spouse who built the home"],
    antagonistRelationships: ["ex-spouse", "former mother-in-law", "ex-spouse and their family"],
    coreConflicts: ["a claim on property they didn't build", "using the children as leverage", "rewriting who paid for what"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["deeds and receipts", "the mortgage was always in the narrator's name", "a signed agreement they forgot about"],
    reversalTypes: REVERSALS, consequenceTypes: ["the claim collapses on paper", "custody or property stays fairly settled", "they walk away with nothing extra"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["coreConflict", "leverage", "reversal"],
    compatibleLocales: ["da-DK", "sv-SE", "bg-BG"], prohibitedCombinations: []
  }),
  validateArchetype({
    id: "forged-documents", name: "A relative forges papers",
    protagonistRoles: ["a rightful heir", "a co-owner", "a sibling kept in the dark"],
    antagonistRelationships: ["sibling", "cousin", "aunt or uncle", "a relative with access"],
    coreConflicts: ["a signature faked on a document", "an altered will or deed", "a quiet transfer done behind the narrator's back"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["the original document exists", "a notary or witness record", "a timestamped copy the forger didn't know about"],
    reversalTypes: REVERSALS, consequenceTypes: ["the forgery is exposed by the record", "the transfer is unwound", "the forger loses credibility"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["evidence", "reversal", "consequence"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "inheritance-dispute", name: "A dispute over inheritance",
    protagonistRoles: ["the caretaker heir", "the sibling who stayed", "the executor no one expected"],
    antagonistRelationships: ["siblings", "extended family", "a grasping relative"],
    coreConflicts: ["the will read differently than promised", "the one who did the caregiving cut out", "assets grabbed before the estate settled"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["the actual will", "records of who cared for the parent", "the estate paperwork"],
    reversalTypes: REVERSALS, consequenceTypes: ["the estate is settled as written", "the grab is reversed", "the caregiver is recognized"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["coreConflict", "evidence", "resolution"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "wedding-humiliation", name: "Public humiliation at a wedding",
    protagonistRoles: ["the bride or groom", "the sibling of the couple", "the one who paid for the wedding"],
    antagonistRelationships: ["a parent", "a sibling", "an in-law to be"],
    coreConflicts: ["a cruel scene at the reception", "credit for the wedding stolen", "the narrator publicly shamed on the day"],
    humiliationTypes: ["a humiliating toast", "a public accusation", "being uninvited at the last moment", "a staged embarrassment"],
    leverageTypes: ["the narrator quietly funded it", "the venue is in the narrator's name", "proof of who really arranged it"],
    reversalTypes: REVERSALS, consequenceTypes: ["the truth of who paid comes out", "the boastful party is deflated", "the narrator leaves with dignity"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["humiliation", "leverage", "resolution"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "graduation-humiliation", name: "Public humiliation at a graduation",
    protagonistRoles: ["the graduate", "a parent at the ceremony", "the sibling who supported them"],
    antagonistRelationships: ["a parent", "a sibling", "a relative"],
    coreConflicts: ["the achievement mocked in public", "credit taken for the narrator's work", "a scene that overshadows the day"],
    humiliationTypes: ["a belittling public comment", "being ignored on stage", "a relative's staged outburst", "the narrator's effort dismissed aloud"],
    leverageTypes: ["records of who did the work", "the narrator paid the tuition", "documented achievements"],
    reversalTypes: REVERSALS, consequenceTypes: ["the record speaks for itself", "the credit-taker is quietly corrected", "the narrator's work is recognized"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["humiliation", "evidence", "resolution"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "unauthorized-account-use", name: "Unauthorized use of a card or account",
    protagonistRoles: ["the account holder", "a parent whose card was used", "a sibling with a shared account"],
    antagonistRelationships: ["a family member", "a sibling", "an adult child", "an in-law"],
    coreConflicts: ["a card used without permission", "a shared account drained", "recurring charges hidden for months"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["the statements and transaction records", "the account is legally the narrator's", "bank alerts and logs"],
    reversalTypes: REVERSALS, consequenceTypes: ["access is cut cleanly", "the charges are documented and reversed", "the debt lands where it belongs"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["evidence", "reversal", "consequence"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "forced-ownership-transfer", name: "Being pressured to sign over ownership or assets",
    protagonistRoles: ["a property owner", "a business co-owner", "an elderly parent"],
    antagonistRelationships: ["a child", "a sibling", "an in-law", "a spouse's family"],
    coreConflicts: ["pressure to sign the house over", "a push to hand over a business share", "guilt used to force a transfer"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["the narrator never actually signed", "the ownership record stands", "a lawyer's letter kept quietly"],
    reversalTypes: REVERSALS, consequenceTypes: ["ownership stays where it legally is", "the pressure campaign fails", "a protective structure is revealed"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["coreConflict", "leverage", "reversal"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "sibling-credit-theft", name: "A sibling steals credit or the fruits of one's work",
    protagonistRoles: ["the sibling who did the work", "the quiet contributor", "the one who built it"],
    antagonistRelationships: ["a sibling", "a cousin", "a brother- or sister-in-law"],
    coreConflicts: ["the narrator's work claimed as another's", "a shared effort rewritten", "praise redirected to the wrong person"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["timestamps and drafts", "clients or colleagues who know the truth", "the paper trail of who did what"],
    reversalTypes: REVERSALS, consequenceTypes: ["the real author is recognized", "the credit-taker is exposed by the record", "future work is protected"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["coreConflict", "evidence", "resolution"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "family-demands-support", name: "The family demands the narrator keep funding them",
    protagonistRoles: ["the family breadwinner", "the successful one", "the one who always pays"],
    antagonistRelationships: ["parents", "siblings", "the extended family"],
    coreConflicts: ["endless demands for money", "guilt used to extract more", "the narrator treated as a permanent wallet"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["it was always the narrator's money", "records of years of giving", "control of the funds"],
    reversalTypes: ["the support is quietly withdrawn", "boundaries are set on paper", ...REVERSALS.slice(0, 3)],
    consequenceTypes: ["the demands stop", "the family adjusts to standing on their own", "the narrator keeps what they earned"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["coreConflict", "reversal", "resolution"],
    prohibitedCombinations: []
  }),
  validateArchetype({
    id: "family-eviction-push", name: "A relative tries to push the narrator out of a home or job",
    protagonistRoles: ["a co-owner of the home", "a family-business employee", "the one who lives there rightfully"],
    antagonistRelationships: ["a sibling", "an in-law", "a parent", "a relative in the business"],
    coreConflicts: ["a scheme to remove the narrator from the house", "being pushed out of the family business", "a claim meant to displace them"],
    humiliationTypes: HUMILIATIONS, leverageTypes: ["the narrator's name is on the deed or contract", "the record of their role", "a clause they were counting on"],
    reversalTypes: REVERSALS, consequenceTypes: ["the narrator stays, on firm ground", "the scheme is undone by the paperwork", "roles are settled fairly"],
    emotionalResolutionTypes: RESOLUTIONS, noveltyDimensions: ["coreConflict", "leverage", "consequence"],
    prohibitedCombinations: []
  })
]);

export const SEED_ARCHETYPE_IDS = Object.freeze(SEED_ARCHETYPES.map((a) => a.id));

// Is an archetype usable for a locale?
export function archetypeCompatibleWithLocale(archetype, locale) {
  if (!archetype) return false;
  return archetype.compatibleLocales.includes("*") || archetype.compatibleLocales.includes(locale);
}

// Deterministic archetype selection for a profile+locale. `seed` (a number/string) makes the choice
// reproducible without Math.random — the caller passes a stable seed (e.g. a hash of the request).
export function selectArchetype({ archetypes, profile, locale, requestedId = null, seed = 0 } = {}) {
  const pool = (archetypes || []).filter((a) => archetypeCompatibleWithLocale(a, locale));
  if (!pool.length) throw storyError("E_ARCHETYPE_NONE", "no archetype is compatible with this locale");
  if (requestedId) {
    const hit = pool.find((a) => a.id === requestedId);
    if (!hit) throw storyError("E_ARCHETYPE_INCOMPATIBLE", `archetype ${requestedId} is not available for ${locale}`);
    return hit;
  }
  // Prefer the profile's preferred archetypes that are compatible; else the full compatible pool.
  const preferred = (profile?.preferredArchetypes || []).map((id) => pool.find((a) => a.id === id)).filter(Boolean);
  const ranked = preferred.length ? preferred : pool;
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const idx = Math.abs(h) % ranked.length;
  return ranked[idx];
}

// Check whether two archetypes may be combined (used when a Story DNA blends two spaces).
export function archetypesCombinable(a, b) {
  if (!a || !b || a.id === b.id) return true;
  return !a.prohibitedCombinations.includes(b.id) && !b.prohibitedCombinations.includes(a.id);
}
