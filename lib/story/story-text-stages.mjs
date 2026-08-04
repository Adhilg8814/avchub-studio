// P0 Step 5C.16 — staged prompt builders + strict response parsers (pure, provider-free).
//
// The Story Factory never uses a single mega-prompt: each stage has its own prompt + strict parser so
// every model turn is a durable, idempotent, correlatable attempt. The DNA + originality axes are
// authored in a canonical language (English) so logic + cross-locale novelty are stable; the PROSE +
// the reader-facing metadata (hook/excerpt/teaser/SEO) are authored DIRECTLY in the target locale (no
// English-then-translate). Parsers never trust prose: DNA/outline/metadata/quality come back as fenced
// JSON. No secrets/URLs/paths are ever placed in a prompt or accepted out of a response.

import { createHash } from "node:crypto";
import { storyError, assertNoSecret, cleanBlock, cleanInline, wordCount } from "./story-common.mjs";
import { validateStoryDNA, currencyForLocale } from "./story-dna.mjs";
import { validateOutline } from "./story-structure.mjs";

export function stagePromptHash(prompt) { return `sha256:${createHash("sha256").update(String(prompt), "utf8").digest("hex")}`; }

function extractJson(text) {
  const raw = String(text ?? "");
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw storyError("E_STAGE_RESPONSE_FORMAT", "no JSON object in response");
  try { return JSON.parse(body.slice(start, end + 1)); } catch { throw storyError("E_STAGE_RESPONSE_FORMAT", "response JSON did not parse"); }
}

// ---- stage 1: Story DNA (canonical English structured facts) ------------------------------------
export function buildDnaPrompt({ profile, archetype, locale, seedIdea = "", noveltyAvoid = [] } = {}) {
  const avoid = (noveltyAvoid || []).slice(0, 6).map((s) => `- ${s}`).join(" ");
  return [
    "You are a story architect. Produce a STRUCTURED STORY DNA (facts only, no prose) as JSON.",
    `Genre family: ${profile.genreFamily}. Emotional arc: family betrayal -> emotional injustice -> quiet counter-move -> satisfying justice -> emotional healing.`,
    `Market: ${profile.country} (${locale}). Currency: ${currencyForLocale(locale)}. Drama intensity ${profile.dramaIntensity}/5, realism ${profile.realismLevel}.`,
    `Use this archetype as a SELECTION SPACE (do not copy a fixed plot): "${archetype.name}". Pick concrete values.`,
    seedIdea ? `Optional seed idea to honor: ${cleanInline(seedIdea, 400)}.` : "",
    avoid ? `Make it clearly DIFFERENT from these existing stories (vary role, relationship, mechanism): ${avoid}` : "",
    "IMPORTANT: write the descriptive DNA fields and ALL originalityDimensions in ENGLISH (canonical, for logic + novelty). BUT people's NAMES and the unforgivableQuote must be written in the TARGET LANGUAGE'S NATIVE SCRIPT exactly as they will appear verbatim in the story — e.g. for Bulgarian use Cyrillic (Димитър, not \"Dimitar\"); do NOT transliterate names to Latin.",
    "The counter-move must be a QUIET, legal, grounded move rooted in real leverage/evidence — no violence, no magic, no deus ex machina. The consequence must be proportional.",
    "Return ONLY a fenced json code block with keys:",
    '{"protagonist","protagonistAgeRange","protagonistOccupation","protagonistCoreNeed","protagonistFlaw",',
    '"antagonistList":[{"name","relationship","role"}],"relationshipMap":[{"a","b","relation"}],',
    '"settingCountry","settingCityOrRegion","socialContext","incitingIncident","historyOfSacrifice",',
    '"escalationSteps":["..."],"publicHumiliation","unforgivableQuote","hiddenLeverage","evidenceType",',
    '"counterMove","reversal","consequences":["..."],"emotionalResolution","finalBoundary","closingInsight",',
    '"timeline":[{"when","event"}],"monetaryFacts":[{"label","amount","currency"}],"legalOrOwnershipFacts":["..."],',
    '"continuityFacts":["..."],"originalityDimensions":{"protagonistRole","antagonistRelationship","settingType","incitingIncident","coreConflict","publicHumiliation","quotedInsultPattern","exploitedResource","evidenceType","hiddenLeverage","reversalMechanism","consequence","emotionalResolution"}}',
    "Names of people must fit the market's culture. No URLs, file paths, or secrets."
  ].filter(Boolean).join(" ");
}
export function parseDnaResponse(text, { locale = null } = {}) {
  const obj = extractJson(text);
  return validateStoryDNA(obj, { locale });
}

// ---- stage 2: outline (14-18 beats, English keys aligned to the spine) ---------------------------
export function buildOutlinePrompt({ dna, profile } = {}) {
  return [
    "Turn this Story DNA into a 14-18 beat OUTLINE (one line each) following the arc spine:",
    "cold_open, narrator_intro, history_of_help, first_exploitation, forbearance, escalation, major_betrayal,",
    "public_humiliation, unforgivable_line, controlled_response, evidence, prepare_counter, false_confidence,",
    "reversal, panic, final_confrontation, consequence, boundary_release.",
    `Honor every frozen fact. Protagonist: ${dna.protagonist}. Reversal mechanism: ${dna.reversal}. Quoted line: "${dna.unforgivableQuote}".`,
    "Evidence must be established BEFORE the reversal. Keep it grounded (no magic, no violence).",
    'Return ONLY a fenced json code block: {"beats":[{"key","label","summary"}]}. Summaries in English.'
  ].join(" ");
}
export function parseOutlineResponse(text) {
  const obj = extractJson(text);
  return validateOutline(obj);
}

// ---- long-form: ACT PLAN (English structure) -----------------------------------------------------
export function buildActPlanPrompt({ dna, profile, target, actCount = 3 } = {}) {
  return [
    `Design the ACT STRUCTURE for a long-form (${target.wordsMin}-${target.wordsMax} words) first-person family-drama story.`,
    `Exactly ${actCount} acts. Across the acts include: at least 3 escalation stages, at least ${actCount >= 4 ? 3 : 2} turning points, and at least 1 major reveal. Setup must have a payoff.`,
    `Honor the frozen DNA. Protagonist: ${dna.protagonist}. Reversal: ${dna.reversal}. Quoted line: "${dna.unforgivableQuote}".`,
    "Keep it grounded (no magic, no violence, no deus ex machina). Write act summaries in English.",
    'Return ONLY a fenced json code block: {"acts":[{"act":1,"title","summary","escalation","turningPoint","reveal"}]}.'
  ].join(" ");
}
export function parseActPlanResponse(text) {
  const o = extractJson(text);
  const acts = (Array.isArray(o.acts) ? o.acts : []).slice(0, 6).map((a, i) => ({
    act: Number(a.act) || i + 1, title: cleanInline(a.title, 120), summary: cleanInline(a.summary, 500),
    escalation: cleanInline(a.escalation, 300), turningPoint: cleanInline(a.turningPoint, 300), reveal: cleanInline(a.reveal, 300)
  })).filter((a) => a.summary || a.title);
  if (acts.length < 3) throw storyError("E_ACT_PLAN_INCOMPLETE", `need at least 3 acts, got ${acts.length}`);
  return Object.freeze({ acts: Object.freeze(acts) });
}

// ---- long-form: SECTION PLAN (maps beats+acts to N writable sections with word targets) -----------
export function buildSectionPlanPrompt({ dna, outline, actPlan, profile, target, sectionCount } = {}) {
  const beats = outline.beats.map((b, i) => `${i + 1}. ${b.key}: ${b.summary}`).join("\n");
  // Aim each section at the UPPER band share (idealMax) so that, after the model's habitual under-write,
  // the assembled total still lands comfortably above the floor.
  const perSection = Math.max(300, Math.round(target.idealMax / sectionCount));
  return [
    `Split this story into EXACTLY ${sectionCount} sequential SECTIONS to be written one at a time, totalling AT LEAST ${target.wordsMin} words (aim for ${target.idealMin}-${target.idealMax}); set each section's targetWords to ≈${perSection} (a firm minimum, never less).`,
    `Each section covers a contiguous span of the beats below and advances the plot — NO section may merely restate a previous one. Distribute the acts + turning points + the reveal across sections.`,
    "BEATS:", beats,
    `Acts: ${actPlan.acts.map((a) => `${a.act}:${a.title}`).join(", ")}.`,
    'Return ONLY a fenced json code block: {"sections":[{"order":1,"title","purpose","beatsCovered":["cold_open"],"targetWords":' + perSection + "}]}. Summaries in English."
  ].join(" ");
}
export function parseSectionPlanResponse(text, { sectionCount = 4, target = null } = {}) {
  const o = extractJson(text);
  let sections = (Array.isArray(o.sections) ? o.sections : []).map((s, i) => ({
    order: Number(s.order) || i + 1, title: cleanInline(s.title, 120), purpose: cleanInline(s.purpose, 400),
    beatsCovered: Object.freeze((Array.isArray(s.beatsCovered) ? s.beatsCovered : []).map((b) => cleanInline(b, 40)).filter(Boolean).slice(0, 12)),
    targetWords: Math.max(200, Math.min(1400, Math.round(Number(s.targetWords) || 550)))
  })).filter((s) => s.title || s.purpose).sort((a, b) => a.order - b.order);
  if (sections.length < 3) throw storyError("E_SECTION_PLAN_INCOMPLETE", `need at least 3 sections, got ${sections.length}`);
  // renumber contiguously
  sections = sections.map((s, i) => ({ ...s, order: i + 1 }));
  return Object.freeze({ sections: Object.freeze(sections) });
}

// ---- long-form: write ONE section (NATIVE prose), given prior context for continuity --------------
export function buildSectionPrompt({ dna, section, sectionPlan, profile, priorContext = "", isFirst = false, isLast = false } = {}) {
  return [
    `Write SECTION ${section.order} of ${sectionPlan.sections.length} of a first-person ${profile.language} (${profile.locale}) family-drama story. Write DIRECTLY in ${profile.language} — never English-then-translate.`,
    `Section purpose: ${section.purpose}. Write AT LEAST ${section.targetWords} words in this section — a firm minimum; aim slightly above it with real scene detail (a section that comes in short fails the length gate). ${profile.narrativeTense === "PRESENT" ? "Present" : "Past"} tense. Tone: ${profile.tone}.`,
    isFirst ? "This is the OPENING — begin with a strong cold-open hook on the shocking event; do NOT summarize." : "Continue seamlessly from the prior text; do NOT recap or repeat earlier paragraphs.",
    isLast ? "This is the FINAL section — deliver the reversal's payoff, a concrete realistic consequence, and end with the boundary + emotional healing. End on a complete sentence." : "Advance the plot and raise tension; do NOT resolve the story yet.",
    `Keep every frozen fact EXACTLY: protagonist "${dna.protagonist}", antagonists ${dna.antagonistList.map((a) => a.name).join(", ")}, the quoted line "${dna.unforgivableQuote}" (use it in the humiliation section), the reversal "${dna.reversal}", and all amounts/dates/ownership facts. Culturally natural names, money (local currency), places, family terms.`,
    "Write substantive, non-repetitive prose with varied paragraph lengths and grounded detail — NO filler, NO paraphrasing earlier paragraphs, NO magic/violence.",
    priorContext ? `CONTEXT (end of the story so far, for continuity — do not repeat it): …${priorContext.slice(-900)}` : "",
    'Return ONLY a fenced json code block: {"section":"<the section prose, \\n\\n between paragraphs>"}.'
  ].filter(Boolean).join("\n");
}
export function parseSectionResponse(text) {
  let prose;
  try { const o = extractJson(text); prose = o.section ?? o.text ?? o.story; } catch { prose = null; }
  if (typeof prose !== "string" || prose.trim().length < 120) {
    const raw = String(text || "").replace(/```[a-z]*\s*/gi, "").replace(/```/g, "").trim();
    if (raw.length >= 120) prose = raw; else throw storyError("E_SECTION_TEXT_EMPTY", "section prose too short");
  }
  const cleaned = cleanBlock(prose, 30000);
  assertNoSecret(cleaned, "section");
  return Object.freeze({ section: cleaned, wordCount: wordCount(cleaned) });
}

// ---- long-form: targeted EXPANSION of a too-thin section (deepen, never pad) ----------------------
export function buildSectionExpandPrompt({ dna, section, sectionText, profile, deficitWords } = {}) {
  return [
    `Deepen SECTION ${section.order} of this ${profile.language} story by ≈${deficitWords} more words WITHOUT padding: add grounded specific detail, interiority, a concrete scene beat or a meaningful exchange that ADVANCES the section's purpose (${section.purpose}).`,
    "Do NOT repeat or paraphrase existing sentences, do NOT restate backstory, do NOT change any fact/name/amount/quote, do NOT add a second ending.",
    'Return ONLY a fenced json code block: {"section":"<the FULL improved section prose>"}.',
    "SECTION:", sectionText.slice(0, 20000)
  ].join("\n");
}

// ---- quality repair: rewrite ONLY the repeated spans (P0 Step 5C.34) -----------------------------
// A repair is not a rewrite. The model is shown the exact phrases the detector counted - nothing else
// is up for negotiation - and is told in the strongest terms that every fact, name, quote, amount and
// beat must survive unchanged. The failure mode of an 'improve this story' prompt is a fluent
// REPLACEMENT story that no longer matches the DNA, the outline, or the movie planned from it.
export function buildQualityRepairPrompt({ dna, profile, storyText, spans = [], targetWords = null } = {}) {
  const listed = spans.slice(0, 12)
    .map((s, i) => `${i + 1}. "${String(s.text || s).slice(0, 160)}" - appears ${s.count || "several"} times`)
    .join("\n");
  const names = [dna?.protagonist, ...(Array.isArray(dna?.antagonistList) ? dna.antagonistList.map((a) => a.name) : [])].filter(Boolean).join(", ");
  return [
    `Below is a finished ${profile.language} (${profile.locale}) story. It is GOOD. Do not rewrite it, do not re-plot it, do not re-translate it.`,
    "One problem only: the phrases listed below repeat so often that they read as filler. Rewrite ONLY those repeated occurrences, varying the wording so each occurrence carries its own weight.",
    "REPEATED PHRASES:", listed || "(none listed - reduce any verbatim repetition you find)",
    "ABSOLUTE RULES - a violation makes the repair useless:",
    `- Keep the SAME language and locale (${profile.locale}). Never translate any part.`,
    `- Keep every character name exactly: ${names || "(as written)"} - a repeated NAME is not filler, leave names alone.`,
    "- Keep every fact, amount, date, place, ownership detail and quoted line EXACTLY as written.",
    "- Keep the same point of view, the same tense, the same order of events and the same ending.",
    "- Keep the same tone and voice. Keep a deliberate motif or a recurring line of dialogue if it is doing dramatic work - only remove repetition that is empty.",
    `- Keep the length within about 5% of the original${targetWords ? ` (~${targetWords} words)` : ""}. Do NOT shorten the story to remove repetition.`,
    "- Do not add a new scene, a new character, a new twist or a second ending.",
    'Return ONLY a fenced json code block: {"story":"<the FULL story with \\n\\n between paragraphs>"}.',
    "STORY:", String(storyText || "").slice(0, 60000)
  ].join("\n");
}

// ---- stage 3: full story (NATIVE language prose) -------------------------------------------------
export function buildStoryPrompt({ dna, outline, profile, wordRange = [2000, 3000] } = {}) {
  const beats = outline.beats.map((b, i) => `${i + 1}. ${b.label}: ${b.summary}`).join("\n");
  return [
    `Write the FULL STORY in ${profile.language} (${profile.locale}). Write DIRECTLY in ${profile.language} — do NOT write in English and translate.`,
    `First person, ${profile.narrativeTense === "PRESENT" ? "present" : "past"} tense. Tone: ${profile.tone}. Paragraph style: ${profile.paragraphStyle}.`,
    `Target length: ${wordRange[0]}-${wordRange[1]} words. Do NOT pad or repeat ideas to reach the count.`,
    "Follow this beat outline in order:", beats,
    `Keep every frozen fact EXACTLY: protagonist "${dna.protagonist}", antagonists ${dna.antagonistList.map((a) => a.name).join(", ")}, the quoted line "${dna.unforgivableQuote}", the reversal "${dna.reversal}", and all amounts/dates/ownership facts.`,
    "Use culturally natural names, money (local currency), places, family terms, forms of address, and everyday details for the market.",
    "Show the public humiliation and the quoted line. Establish the evidence BEFORE the reversal. End with the boundary and emotional healing. No magic, no violence, no deus ex machina.",
    'Return ONLY a fenced json code block: {"story":"<the full story text with \\n\\n between paragraphs>"}.'
  ].join(" ");
}
export function parseStoryResponseText(text, { locale = null, wordRange = null } = {}) {
  let story;
  try { const obj = extractJson(text); story = obj.story ?? obj.text ?? obj.content; } catch { story = null; }
  if (typeof story !== "string" || story.trim().length < 200) {
    // fall back to treating the whole response as prose (strip fences)
    const raw = String(text || "").replace(/```[a-z]*\s*/gi, "").replace(/```/g, "").trim();
    if (raw.length >= 200) story = raw; else throw storyError("E_STORY_TEXT_EMPTY", "story text too short");
  }
  const cleaned = cleanBlock(story, 60000);
  assertNoSecret(cleaned, "story");
  const words = wordCount(cleaned);
  return Object.freeze({ story: cleaned, wordCount: words, wordRange: wordRange || null });
}

// ---- stage 4: native-language editing pass ------------------------------------------------------
export function buildEditPrompt({ storyText, dna, profile } = {}) {
  return [
    `You are a native ${profile.language} editor. Improve fluency, rhythm and natural phrasing of this story WITHOUT changing any fact, name, amount, date, the quoted line, or the plot.`,
    "Fix any English-sounding phrasing, translated idioms, or mixed-language slips. Keep it first person and the same length band.",
    "Do not add magic, violence, or new plot elements. Keep the ending resolved.",
    'Return ONLY a fenced json code block: {"story":"<edited full story>"}.',
    "STORY:", storyText.slice(0, 40000)
  ].join("\n");
}

// ---- stage 5: metadata + teaser (NATIVE) + hero image prompt (English for the image model) -------
export function buildMetadataPrompt({ dna, profile, title, storyText } = {}) {
  return [
    `Produce publishing metadata for this ${profile.language} story titled "${title}".`,
    "Write hook, excerpt, socialTeaser, cliffhanger, cta and seoDescription in " + profile.language + " (native). The heroImagePrompt must be in ENGLISH (it feeds an image model).",
    "hook = 1-2 sentence opening hook; excerpt = 2-4 sentences; socialTeaser = 1-3 short paragraphs ending on a cliffhanger; cta = a neutral call to read more; seoDescription = <=160 chars; heroImagePrompt = a vivid, filmable single-image description (no text/watermark).",
    "Do not invent facts beyond the story. Do not spoil the full ending.",
    'Return ONLY a fenced json code block: {"hook","excerpt","socialTeaser","cliffhanger","cta","seoDescription","heroImagePrompt"}.'
  ].join(" ");
}
export function parseMetadataResponse(text) {
  const o = extractJson(text);
  const s = (v, max) => cleanBlock(v, max);
  const out = {
    hook: s(o.hook, 500), excerpt: s(o.excerpt, 800), socialTeaser: s(o.socialTeaser, 1500),
    cliffhanger: s(o.cliffhanger, 400), cta: cleanInline(o.cta, 200), seoDescription: cleanInline(o.seoDescription, 200),
    heroImagePrompt: cleanInline(o.heroImagePrompt, 900)
  };
  if (out.hook.length < 3) throw storyError("E_METADATA_INCOMPLETE", "hook is required");
  if (out.excerpt.length < 3) throw storyError("E_METADATA_INCOMPLETE", "excerpt is required");
  for (const [k, v] of Object.entries(out)) assertNoSecret(v, `metadata.${k}`);
  return Object.freeze(out);
}

// ---- stage 6 (optional): model self-assessment for the subjective quality dimensions ------------
export function buildQualityPrompt({ profile, title } = {}) {
  return [
    `Rate this ${profile.language} story titled "${title}" from 0 to 1 on each dimension. Be honest and critical.`,
    'Return ONLY a fenced json code block: {"hookStrength","emotionalEscalation","twistSetup","payoffSatisfaction"} (numbers 0..1).'
  ].join(" ");
}
export function parseQualityResponse(text) {
  try {
    const o = extractJson(text);
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined; };
    return Object.freeze({ hookStrength: num(o.hookStrength), emotionalEscalation: num(o.emotionalEscalation), twistSetup: num(o.twistSetup), payoffSatisfaction: num(o.payoffSatisfaction) });
  } catch { return Object.freeze({}); }
}
