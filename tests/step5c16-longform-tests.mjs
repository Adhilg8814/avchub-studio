// P0 Step 5C.16 (long-form) — length presets, reading-rate, metrics, gates, section parsers (pure).
import { resolveLengthTarget, planSectionCount, readingRateFor, estimatedReadingSeconds, LENGTH_PRESETS, DEFAULT_READING_RATE_WPM } from "../lib/story/length-presets.mjs";
import { computeStoryMetrics, lengthGate, fillerScore, looksTruncated, dialogueWordCount, nearDuplicateParagraphs, DEFAULT_LENGTH_GATE_THRESHOLDS } from "../lib/story/story-metrics.mjs";
import { parseActPlanResponse, parseSectionPlanResponse, parseSectionResponse, buildSectionPrompt } from "../lib/story/story-text-stages.mjs";
import { computeScorecard } from "../lib/story/quality-scorecard.mjs";
import { validateContentBrandProfile } from "../lib/story/content-brand-profile.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log("FAIL", n); } };
const throws = (n, fn, code) => { try { fn(); failed++; console.log("FAIL(no throw)", n); } catch (e) { if (!code || e.code === code) passed++; else { failed++; console.log("FAIL(code)", n, "got", e.code); } } };
const fence = (o) => "```json\n" + JSON.stringify(o) + "\n```";

// ---- A. presets + reading rate ----
check("A LENGTH_PRESETS", LENGTH_PRESETS.join(",") === "SHORT,STANDARD,LONG,CUSTOM");
const std = resolveLengthTarget({ preset: "STANDARD", locale: "bg-BG" });
check("A STANDARD floor 1700", std.wordsMin === 1700 && std.wordsMax === 2500 && std.readingMinutesMin === 9);
const short = resolveLengthTarget({ preset: "SHORT", locale: "sv-SE" });
check("A SHORT band 900-1300", short.wordsMin === 900 && short.wordsMax === 1300);
const long = resolveLengthTarget({ preset: "LONG", locale: "da-DK" });
check("A LONG band 2500-3600", long.wordsMin === 2500 && long.wordsMax === 3600);
const custom = resolveLengthTarget({ preset: "CUSTOM", locale: "bg-BG", customReadingMinutes: [10, 12] });
check("A CUSTOM words = minutes * wpm", custom.wordsMin === 10 * 185 && custom.wordsMax === 12 * 185);
check("A locale reading rates distinct-ish", readingRateFor("bg-BG") === 185 && readingRateFor("sv-SE") === 190);
check("A profile readingRateWpm overrides", readingRateFor("bg-BG", { readingRateWpm: 220 }) === 220);
check("A reading seconds", estimatedReadingSeconds(1850, "bg-BG") === Math.round((1850 / 185) * 60));
check("A planSectionCount STANDARD >=3", planSectionCount(std) >= 3 && planSectionCount(long) >= planSectionCount(short));
check("A default preset STANDARD unknown->STANDARD", resolveLengthTarget({ preset: "NOPE", locale: "bg-BG" }).preset === "STANDARD");

// ---- B. metrics ----
const paras = Array.from({ length: 16 }, (_, i) => `Абзац ${i} с различни думи ${"дума" + i} и още съдържание за да варира дължината ${i % 3 === 0 ? "малко повече текст тук за разнообразие" : ""}.`);
const story = paras.join("\n\n");
const m = computeStoryMetrics(story, { locale: "bg-BG" });
check("B word + paragraph counts", m.actualWordCount > 100 && m.paragraphCount === 16);
check("B reading seconds present", m.estimatedReadingSeconds > 0);
check("B not truncated (ends on .)", m.truncated === false);
check("B dialogue counting", dialogueWordCount('Той каза: „това е тайна" и си тръгна.') >= 2);
check("B truncation detect (no end punct)", looksTruncated("Първи абзац.\n\nВтори абзац който спира по средата") === true);
check("B near-duplicate paragraphs", nearDuplicateParagraphs(["едно две три четири пет шест седем", "едно две три четири пет шест седем осем", "съвсем различен текст тук нищо общо няма"]) >= 1);

// ---- C. length gate ----
const tgt = { wordsMin: 1700, wordsMax: 2500 };
check("C below-min fails", lengthGate({ actualWordCount: 800, nearDuplicateParagraphs: 0, repeatedTrigramRatio: 0, truncated: false, paragraphLengthCv: 0.5, paragraphCount: 10 }, tgt).state === "BELOW_MIN");
check("C truncated fails", lengthGate({ actualWordCount: 2000, nearDuplicateParagraphs: 0, repeatedTrigramRatio: 0, truncated: true, paragraphLengthCv: 0.5, paragraphCount: 10 }, tgt).state === "TRUNCATED");
check("C padded fails", lengthGate({ actualWordCount: 2000, nearDuplicateParagraphs: 4, repeatedTrigramRatio: 0.1, truncated: false, paragraphLengthCv: 0.5, paragraphCount: 10 }, tgt).state === "PADDED");
check("C clean passes", lengthGate({ actualWordCount: 2000, nearDuplicateParagraphs: 0, repeatedTrigramRatio: 0.01, truncated: false, paragraphLengthCv: 0.5, paragraphCount: 20 }, tgt).pass === true);
check("C configurable padding relaxes", lengthGate({ actualWordCount: 2000, nearDuplicateParagraphs: 9, repeatedTrigramRatio: 0.2, truncated: false, paragraphLengthCv: 0.5, paragraphCount: 10 }, tgt, { maxNearDupPairs: 99, maxTrigramRatio: 0.9 }).pass === true);
check("C default thresholds strict", DEFAULT_LENGTH_GATE_THRESHOLDS.maxTrigramRatio === 0.05);
check("C fillerScore penalizes padding", fillerScore({ repeatedTrigramRatio: 0.1, nearDuplicateParagraphs: 3, paragraphLengthCv: 0.2, paragraphCount: 10 }) < 0.5);

// ---- D. section parsers ----
const ap = parseActPlanResponse(fence({ acts: [{ act: 1, title: "A", summary: "s1" }, { act: 2, title: "B", summary: "s2" }, { act: 3, title: "C", summary: "s3" }] }));
check("D act plan 3 acts", ap.acts.length === 3);
throws("D act plan <3 rejected", () => parseActPlanResponse(fence({ acts: [{ act: 1, summary: "x" }] })), "E_ACT_PLAN_INCOMPLETE");
const sp = parseSectionPlanResponse(fence({ sections: [{ order: 1, title: "s1", purpose: "p", beatsCovered: ["cold_open"], targetWords: 500 }, { order: 2, title: "s2", purpose: "p", targetWords: 500 }, { order: 3, title: "s3", purpose: "p", targetWords: 500 }] }), { sectionCount: 3 });
check("D section plan 3 sections renumbered", sp.sections.length === 3 && sp.sections.map((s) => s.order).join("") === "123");
throws("D section plan <3 rejected", () => parseSectionPlanResponse(fence({ sections: [{ order: 1, title: "x" }] })), "E_SECTION_PLAN_INCOMPLETE");
check("D section response parse", parseSectionResponse(fence({ section: "Достатъчно дълъг текст за секция с много думи и съдържание тук за да премине минималната дължина от сто и двадесет знака и малко отгоре." })).wordCount >= 8);
throws("D section too short rejected", () => parseSectionResponse(fence({ section: "къс" })), "E_SECTION_TEXT_EMPTY");
const profile = validateContentBrandProfile({ name: "Test", locale: "bg-BG", language: "Bulgarian" });
const dnaLite = { protagonist: "Милена", antagonistList: [{ name: "Радост" }], unforgivableQuote: "Q", reversal: "R", escalationSteps: ["a", "b", "c"], publicHumiliation: "h", consequences: ["c1"] };
const sprompt = buildSectionPrompt({ dna: dnaLite, section: { order: 2, purpose: "escalate", targetWords: 400 }, sectionPlan: { sections: [1, 2, 3] }, profile, priorContext: "…earlier…", isFirst: false, isLast: false });
check("D section prompt names locale + section", sprompt.includes("Write SECTION 2 of 3") && sprompt.includes("Bulgarian"));

// ---- E. scorecard long-form dims ----
const goodMetrics = { actualWordCount: 2000, estimatedReadingSeconds: 650, paragraphCount: 18, dialogueWordCount: 200, dialogueRatio: 0.1, avgParagraphWords: 110, longestParagraphWords: 200, paragraphLengthCv: 0.5, nearDuplicateParagraphs: 0, repeatedTrigramRatio: 0.01, truncated: false };
const scGood = computeScorecard({ storyText: story, dna: dnaLite, continuity: { violations: [], warnings: [] }, novelty: { maxOverall: 0 }, titleValidation: { valid: true, score: 0.9 }, arc: { complete: true }, locale: "bg-BG", metrics: goodMetrics, lengthTarget: tgt, lengthGateResult: { pass: true } });
// The five dimensions long-form scoring added must all be present and scored. This used to pin the TOTAL
// dimension count at 16, which said nothing about which dimensions existed and went stale the moment a
// seventeenth was added — a dimension could have been dropped and replaced without the count noticing.
const LONGFORM_DIMS = ["lengthCompliance", "lengthRestraint", "filler", "paragraphVariation", "narrativeCompleteness"];
check("E long-form dims present", LONGFORM_DIMS.every((d) => scGood.dimensions[d] !== undefined));
check("E every dimension is a score in 0..1",
  Object.values(scGood.dimensions).every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
check("E long-form adds to the base dimensions rather than replacing them",
  Object.keys(scGood.dimensions).length > LONGFORM_DIMS.length);
check("E good metrics lengthCompliance high", scGood.dimensions.lengthCompliance >= 0.9);
const badMetrics = { ...goodMetrics, actualWordCount: 700, truncated: false };
const scBad = computeScorecard({ storyText: story, dna: dnaLite, continuity: { violations: [], warnings: [] }, novelty: { maxOverall: 0 }, titleValidation: { valid: true, score: 0.9 }, arc: { complete: true }, locale: "bg-BG", metrics: badMetrics, lengthTarget: tgt, lengthGateResult: { pass: false } });
check("E below-min → lengthCompliance critical fail → not ready", scBad.dimensions.lengthCompliance < 1 && scBad.criticalFailures.includes("lengthCompliance") && scBad.ready === false);
const scNoMetrics = computeScorecard({ storyText: story, dna: dnaLite, continuity: { violations: [], warnings: [] }, novelty: { maxOverall: 0 }, titleValidation: { valid: true, score: 0.9 }, arc: { complete: true }, locale: "bg-BG" });
check("E without metrics: 12 dims (backward compatible)", Object.keys(scNoMetrics.dimensions).length === 12);

console.log(`Step 5C.16 long-form: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
