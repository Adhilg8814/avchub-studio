// P0 Step 5C.16 — Content Brand Profile (pure, deterministic, provider-free).
//
// A ContentBrandProfile is the editable "voice" of a market: country/locale/language + the narrative
// conventions (perspective, tense, tone, emotional arc, title/hook/ending patterns, allowed
// archetypes, prohibited patterns, word ranges, drama/realism knobs). Profiles are DATA the Studio
// stores + edits (content_brand_profiles table) — they are NEVER hard-coded only inside a prompt.
// This module owns the schema + normalization + the minimum three seeds (bg-BG, sv-SE, da-DK). No
// secrets/URLs/paths ever enter a profile (assertNoSecret guards the free-text fields).

import { assertNoSecret } from "./story-common.mjs";

function err(code, message) { return Object.assign(new Error(message), { code }); }
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanList = (v, max, itemMax) => (Array.isArray(v) ? v : []).map((x) => clean(x, itemMax)).filter(Boolean).slice(0, max);

export const NARRATOR_PERSPECTIVES = Object.freeze(["FIRST_PERSON", "THIRD_PERSON"]);
export const NARRATIVE_TENSES = Object.freeze(["PAST", "PRESENT"]);
export const DIALOGUE_DENSITIES = Object.freeze(["LOW", "MEDIUM", "HIGH"]);
export const REALISM_LEVELS = Object.freeze(["GROUNDED", "BALANCED", "DRAMATIZED"]);
// The canonical emotional arc of the genre family: family betrayal → emotional injustice →
// quiet counter-move → satisfying justice → emotional healing.
export const CANONICAL_EMOTIONAL_ARC = Object.freeze(["BETRAYAL", "INJUSTICE", "QUIET_COUNTER", "JUST_CONSEQUENCE", "HEALING"]);
export const LENGTH_TIERS = Object.freeze(["short", "medium", "long"]);

const CBP_RE = /^cbp_[0-9A-HJKMNP-TV-Z]{26}$/u;

function normWordRange(v, fallback) {
  const src = v && typeof v === "object" ? v : {};
  const out = {};
  for (const tier of LENGTH_TIERS) {
    const r = Array.isArray(src[tier]) ? src[tier] : (fallback[tier] || [1200, 1800]);
    const min = Math.max(200, Math.min(20000, Math.round(Number(r[0]) || fallback[tier][0])));
    const max = Math.max(min + 100, Math.min(30000, Math.round(Number(r[1]) || fallback[tier][1])));
    out[tier] = Object.freeze([min, max]);
  }
  return Object.freeze(out);
}

const DEFAULT_WORD_RANGE = Object.freeze({ short: [1200, 1800], medium: [2000, 3000], long: [3500, 5000] });

// validateContentBrandProfile: normalize + freeze. `id`/timestamps are optional (assigned by the
// repo); everything free-text is secret-scanned; enums fall back to safe defaults.
export function validateContentBrandProfile(input = {}, { requireId = false } = {}) {
  if (!input || typeof input !== "object") throw err("E_BRAND_INVALID", "profile must be an object");
  const id = input.id != null ? String(input.id) : null;
  if (requireId && (!id || !CBP_RE.test(id))) throw err("E_BRAND_INVALID", "profile id is required");
  const name = clean(input.name, 120);
  if (name.length < 2) throw err("E_BRAND_INVALID", "profile name is required");
  const country = clean(input.country, 60);
  const locale = clean(input.locale, 16);
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) throw err("E_BRAND_LOCALE", "locale must look like bg-BG");
  const language = clean(input.language, 40) || locale.slice(0, 2);
  const audience = clean(input.audience, 200);
  const genreFamily = clean(input.genreFamily, 120) || "family betrayal / quiet justice";
  const narratorPerspective = NARRATOR_PERSPECTIVES.includes(input.narratorPerspective) ? input.narratorPerspective : "FIRST_PERSON";
  const narrativeTense = NARRATIVE_TENSES.includes(input.narrativeTense) ? input.narrativeTense : "PAST";
  const tone = clean(input.tone, 300);
  const emotionalArc = cleanList(input.emotionalArc, 12, 40).map((s) => s.toUpperCase().replace(/[^A-Z_]/g, "_"));
  const titlePattern = clean(input.titlePattern, 600);
  const hookPattern = clean(input.hookPattern, 600);
  const endingPattern = clean(input.endingPattern, 600);
  const preferredArchetypes = cleanList(input.preferredArchetypes, 40, 60);
  const prohibitedPatterns = cleanList(input.prohibitedPatterns, 60, 200);
  const targetWordRange = normWordRange(input.targetWordRange, DEFAULT_WORD_RANGE);
  const paragraphStyle = clean(input.paragraphStyle, 300);
  const readingRateWpm = Number.isFinite(Number(input.readingRateWpm)) ? Math.max(90, Math.min(400, Math.round(Number(input.readingRateWpm)))) : null;
  const dialogueDensity = DIALOGUE_DENSITIES.includes(input.dialogueDensity) ? input.dialogueDensity : "MEDIUM";
  const dramaIntensity = Math.max(1, Math.min(5, Math.round(Number(input.dramaIntensity) || 3)));
  const realismLevel = REALISM_LEVELS.includes(input.realismLevel) ? input.realismLevel : "GROUNDED";
  const visualStyle = clean(input.visualStyle, 600);

  for (const [f, v] of [["name", name], ["audience", audience], ["genreFamily", genreFamily], ["tone", tone],
    ["titlePattern", titlePattern], ["hookPattern", hookPattern], ["endingPattern", endingPattern],
    ["paragraphStyle", paragraphStyle], ["visualStyle", visualStyle]]) assertNoSecret(v, `brand.${f}`);
  for (const p of prohibitedPatterns) assertNoSecret(p, "brand.prohibitedPatterns");

  return Object.freeze({
    id, name, country, locale, language, audience, genreFamily,
    narratorPerspective, narrativeTense, tone,
    emotionalArc: Object.freeze(emotionalArc.length ? emotionalArc : [...CANONICAL_EMOTIONAL_ARC]),
    titlePattern, hookPattern, endingPattern,
    preferredArchetypes: Object.freeze(preferredArchetypes), prohibitedPatterns: Object.freeze(prohibitedPatterns),
    targetWordRange, paragraphStyle, readingRateWpm, dialogueDensity, dramaIntensity, realismLevel, visualStyle,
    createdAt: input.createdAt ?? null, updatedAt: input.updatedAt ?? null
  });
}

// Resolve a word range for a length tier, allowing a per-request override that must stay inside the
// profile's configured bounds unless the profile explicitly permits a wider band.
export function resolveWordRange(profile, tier = "medium") {
  const t = LENGTH_TIERS.includes(tier) ? tier : "medium";
  return profile.targetWordRange[t];
}

// ---- the three minimum seed profiles (bg-BG, sv-SE, da-DK) ---------------------------------------
// These are inserted by the runtime bootstrap (idempotent) and are fully editable afterward. The
// seed keys (seedKey) let bootstrap upsert-once without duplicating on every boot.
export const SEED_BRAND_PROFILES = Object.freeze([
  validateContentBrandProfile({
    name: "Bulgaria — Family Honor & Betrayal", country: "Bulgaria", readingRateWpm: 185, locale: "bg-BG", language: "Bulgarian",
    audience: "Adults 30-60, family-drama readers who value honor, loyalty and direct confrontation",
    genreFamily: "family betrayal / quiet justice",
    narratorPerspective: "FIRST_PERSON", narrativeTense: "PAST",
    tone: "Direct, emotionally charged, honor-driven; confrontation is faced head-on, not avoided",
    emotionalArc: CANONICAL_EMOTIONAL_ARC,
    titlePattern: "Long first-person title naming the event, the relative, the hurtful act and a quoted line, hinting at (not spoiling) the counter-move",
    hookPattern: "Open on the shock moment, name the relationship and the betrayal in the first two sentences",
    endingPattern: "Satisfying but realistic: dignity restored, a firm boundary set, no fairy-tale windfall",
    preferredArchetypes: ["parental-favoritism", "inheritance-dispute", "wedding-humiliation", "forced-ownership-transfer"],
    prohibitedPatterns: ["magic or supernatural resolution", "police/court deus ex machina with no setup", "violence as the counter-move", "translated English idioms"],
    targetWordRange: { short: [1200, 1800], medium: [2200, 3200], long: [3800, 5000] },
    paragraphStyle: "Medium paragraphs, strong scene beats, direct dialogue at the confrontations",
    dialogueDensity: "HIGH", dramaIntensity: 4, realismLevel: "GROUNDED",
    visualStyle: "Warm domestic interiors, Balkan family gathering, natural light, emotional close-ups"
  }),
  validateContentBrandProfile({
    name: "Sweden — Boundaries & Self-Respect", country: "Sweden", readingRateWpm: 190, locale: "sv-SE", language: "Swedish",
    audience: "Adults 30-55, readers who value calm, fairness, emotional restraint and personal autonomy",
    genreFamily: "family betrayal / quiet justice",
    narratorPerspective: "FIRST_PERSON", narrativeTense: "PAST",
    tone: "Calm, restrained, understated; conflict handled through boundaries rather than shouting",
    emotionalArc: CANONICAL_EMOTIONAL_ARC,
    titlePattern: "Measured first-person title stating the unfair act and the quiet boundary, restrained wording",
    hookPattern: "A composed observation that something crossed a line, stated plainly",
    endingPattern: "Resolution centered on autonomy and self-respect; the narrator keeps their peace and their boundary",
    preferredArchetypes: ["financial-exploitation-rent", "parental-favoritism", "sibling-credit-theft", "family-demands-support"],
    prohibitedPatterns: ["melodrama or screaming matches", "revenge that harms others", "magic resolution", "word-by-word English translation"],
    targetWordRange: { short: [1200, 1700], medium: [2000, 2800], long: [3500, 4600] },
    paragraphStyle: "Even, reflective paragraphs; sparse but pointed dialogue",
    dialogueDensity: "MEDIUM", dramaIntensity: 2, realismLevel: "GROUNDED",
    visualStyle: "Cool Scandinavian light, minimalist interiors, quiet composition, muted palette"
  }),
  validateContentBrandProfile({
    name: "Denmark — Divorce, Money & Family", country: "Denmark", readingRateWpm: 190, locale: "da-DK", language: "Danish",
    audience: "Adults 30-55, readers of everyday family conflict about divorce, money, children and property",
    genreFamily: "family betrayal / quiet justice",
    narratorPerspective: "FIRST_PERSON", narrativeTense: "PAST",
    tone: "Direct, natural, conversational; plainspoken and unsentimental",
    emotionalArc: CANONICAL_EMOTIONAL_ARC,
    titlePattern: "Natural, direct first-person title naming the ex/in-law, the money or property issue and the quiet counter-move",
    hookPattern: "Plain, direct opening that states who did what over money, children or property",
    endingPattern: "A satisfying, concrete consequence and a quiet counter-move; grounded and fair",
    preferredArchetypes: ["ex-and-inlaw-asset-claim", "forced-ownership-transfer", "unauthorized-account-use", "family-eviction-push"],
    prohibitedPatterns: ["cartoonish villains", "unearned windfall", "supernatural elements", "stiff translated phrasing"],
    targetWordRange: { short: [1200, 1800], medium: [2000, 3000], long: [3500, 4800] },
    paragraphStyle: "Short-to-medium paragraphs, natural rhythm, everyday dialogue",
    dialogueDensity: "MEDIUM", dramaIntensity: 3, realismLevel: "GROUNDED",
    visualStyle: "Everyday Danish domestic settings, natural daylight, grounded realism"
  })
]);

// Stable seed keys keyed by locale (bootstrap upsert idempotency).
export const SEED_BRAND_KEYS = Object.freeze(SEED_BRAND_PROFILES.map((p) => `seed:${p.locale}`));
