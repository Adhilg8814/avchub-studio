// P0 Step 5C.34 — LANGUAGE-AWARE REPETITION DETECTOR + quality gate semantics (pure, provider-free).
//
// The defect this suite exists to prevent: a finished 2932-word Danish story was rejected as "padded"
// because the detector counted repeated word-trigrams without knowing what language it was reading.
// Danish and Swedish carry obligatory det/at/der/som scaffolding; Bulgarian repeats да/се/на; Vietnamese
// repeats classifiers. An English-calibrated ratio reads all of that as filler.
//
// The opposite failure is just as bad, so the suite proves BOTH directions: genuinely padded prose must
// still be caught (a detector that passes everything is not a fix, it is a removal), and legitimate
// repetition — character names, pronouns, a refrain of dialogue, a deliberate motif — must never count.

import {
  detectRepetition, repairTargets, entitiesFromDna, tokenize,
  REPETITION_BAND, REPETITION_CLASS, DEFAULT_REPETITION_BANDS, supportedLocales
} from "../lib/story/repetition-detector.mjs";
import { computeStoryMetrics, lengthGate, DEFAULT_LENGTH_GATE_THRESHOLDS } from "../lib/story/story-metrics.mjs";
import { computeScorecard, DEFAULT_QUALITY_THRESHOLDS } from "../lib/story/quality-scorecard.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };

// ================================================================ fixtures
// Natural prose in each locale: heavy on function words (as the language requires) but with no repeated
// content-bearing phrase. These are the shape of text the old detector mis-scored.
const NATURAL = {
  "da-DK": `Jeg stod i køkkenet, da telefonen ringede for tredje gang den aften. Det var min søster, og det var
tydeligt, at hun havde grædt. Hun sagde, at hun ikke kunne komme til middagen, og at det ikke var min skyld.
Jeg satte kaffen over og lyttede. Der er noget ved en stemme, der ryster, som gør alle andre lyde mindre.
Det var den samme aften, at min mor ringede og spurgte, om jeg havde hørt fra hende. Jeg sagde, at det havde
jeg, og at hun havde det godt nok. Det var ikke helt sandt, men det var det, hun havde brug for at høre.
Senere gik jeg ud i haven. Det var koldt, og der lå rim på bordet, som ingen havde tørret af siden oktober.`,
  "sv-SE": `Jag satt kvar vid bordet när de andra hade gått. Det var något med tystnaden som gjorde att jag inte
kunde resa mig. Min bror sade att han skulle ringa, men han ringde aldrig, och jag visste att han inte skulle
göra det heller. Det är så det har varit sedan pappa dog. Det som inte sägs blir tyngre än det som sägs.
Jag diskade i mörkret för att slippa se mig själv i fönstret. Sedan gick jag upp och lade mig, och jag låg
vaken och lyssnade på huset som knakade i kylan. Det var en av de nätter då man räknar timmar i stället för får.`,
  "bg-BG": `Останах на масата, след като всички си тръгнаха. Имаше нещо в тишината, което ме държеше на мястото ми.
Брат ми каза, че ще се обади, но не се обади, и аз знаех, че няма да го направи. Така е откакто почина баща ми.
Това, което не се казва, тежи повече от онова, което се казва. Измих чиниите на тъмно, за да не се виждам в
прозореца. После се качих горе и легнах, и лежах будна, докато къщата пукаше от студа навън.`,
  "vi-VN": `Tôi ngồi lại bên bàn sau khi mọi người đã về. Có một điều gì đó trong sự im lặng khiến tôi không thể
đứng dậy. Anh trai tôi nói sẽ gọi, nhưng anh không gọi, và tôi biết anh sẽ không gọi. Mọi chuyện đã như vậy
kể từ khi cha tôi mất. Những điều không nói ra thì nặng hơn những điều đã nói. Tôi rửa bát trong bóng tối để
khỏi phải nhìn thấy mình trong ô cửa kính. Sau đó tôi lên gác và nằm xuống, nghe căn nhà kêu răng rắc vì lạnh.`,
  "en-US": `I stayed at the table after the others had gone. There was something in the quiet that kept me from
standing up. My brother said he would call, but he did not call, and I knew that he would not. It has been
that way since my father died. What is not said weighs more than what is. I washed the dishes in the dark so
that I would not have to see myself in the window. Then I went upstairs and lay awake listening to the house.`
};

// Genuinely padded prose: one content-bearing sentence repeated to inflate the count. This is what the
// detector MUST still catch, in the same language that produced the false positive.
const PADDED_DA = (() => {
  const filler = "Hun kiggede på det gamle fotografi af sommerhuset ved kysten og mærkede den samme tunge sorg i brystet.";
  const varied = [
    "Jeg åbnede skuffen og fandt en kvittering fra 1998.",
    "Telefonen lå på bordet med skærmen nedad.",
    "Regnen begyndte igen ved fire-tiden om eftermiddagen."
  ];
  const out = [];
  for (let i = 0; i < 14; i += 1) { out.push(filler); out.push(varied[i % varied.length]); }
  return out.join(" ");
})();

// ================================================================ 1. natural prose must PASS in every locale
for (const [locale, text] of Object.entries(NATURAL)) {
  const r = detectRepetition(text, { locale });
  check(`Q1 ${locale} natural prose is not padding (score ${r.score}, band ${r.band})`, r.band === REPETITION_BAND.PASS);
  check(`Q1 ${locale} verdict is explainable`, typeof r.explanation === "string" && r.explanation.length > 20);
  check(`Q1 ${locale} verdict carries the locale it judged`, r.locale === locale);
}
check("Q1 every required locale is actually supported (not silently defaulted)",
  ["da-DK", "sv-SE", "bg-BG", "en-US", "vi-VN"].every((l) => supportedLocales().includes(l)));

// ================================================================ 2. the detector still has teeth
{
  const r = detectRepetition(PADDED_DA, { locale: "da-DK" });
  check(`Q2 verbatim padding is caught in da-DK (score ${r.score}, band ${r.band})`, r.band === REPETITION_BAND.HARD_REPAIR_OR_REVIEW);
  check("Q2 the repeated sentence is what gets named (not an overlapping straddle)", r.countedSpans.length > 0 && r.countedSpans[0].count >= 10);
  check("Q2 the span carries byte offsets for every occurrence", Array.isArray(r.countedSpans[0].offsets) && r.countedSpans[0].offsets.length === r.countedSpans[0].count
    && r.countedSpans[0].offsets.every((o) => Number.isInteger(o.start) && o.end > o.start));
  check("Q2 every offset points at the span it claims to be", r.countedSpans[0].offsets.every((o) =>
    PADDED_DA.slice(o.start, o.end).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === r.countedSpans[0].text));
  check("Q2 the class is a verbatim block", r.countedSpans[0].class === REPETITION_CLASS.VERBATIM_BLOCK);
  check("Q2 repairTargets exposes exactly the spans to rewrite", repairTargets(r, { max: 3 }).length > 0 && repairTargets(r, { max: 3 }).every((t) => t.text && t.count > 1));
  // A detector that only catches its own fixture is useless: the same padding in another language too.
  const sv = detectRepetition(PADDED_DA.replace(/Hun kiggede/g, "Hon tittade"), { locale: "sv-SE" });
  check("Q2 padding is caught in sv-SE as well", sv.band === REPETITION_BAND.HARD_REPAIR_OR_REVIEW);
}

// ================================================================ 3. legitimate repetition never counts
{
  // (a) character names. A story about Jesper says "Jesper" a lot, in sentence after different sentence;
  // that is the story naming its own cast, not filler. (Note the sentences DIFFER — repeating an identical
  // twenty-word block twelve times would be padding no matter whose name is in it, and the detector is
  // right to say so.)
  const withNames = NATURAL["da-DK"] + " " + [
    "Min søn Jesper kom ind uden at banke.", "Min søn Jesper satte sig ved bordet og tav.",
    "Min søn Jesper så på mig, som om han ventede noget.", "Min søn Jesper sagde ingenting om pengene.",
    "Min søn Jesper rejste sig og gik ud i gangen.", "Min søn Jesper vendte tilbage med en mappe.",
    "Min søn Jesper lagde nøglerne fra sig.", "Min søn Jesper spurgte, hvor længe det havde stået på."
  ].join(" ");
  const rn = detectRepetition(withNames, { locale: "da-DK", characterNames: ["Jesper"] });
  check("Q3a a repeated character NAME is not filler", rn.band === REPETITION_BAND.PASS);
  check("Q3a name echoes are classified, not silently dropped", (rn.classes[REPETITION_CLASS.ENTITY_ECHO] || 0) > 0);

  // (b) pronouns + function words. Repeating "det var" is Danish grammar.
  const fn = "Det var koldt. Det var sent. Det var ikke noget, jeg kunne ændre. Det var det, der gjorde ondt. ";
  const rf = detectRepetition(NATURAL["da-DK"] + " " + fn.repeat(5), { locale: "da-DK" });
  check("Q3b function-word scaffolding is not filler", rf.band === REPETITION_BAND.PASS);
  check("Q3b function echoes are visible in the class breakdown", (rf.classes[REPETITION_CLASS.FUNCTION_ECHO] || 0) > 0);

  // (c) a refrain of dialogue. A line a character keeps saying is dramatic work.
  const refrain = '"Du er ikke velkommen her," sagde hun. ';
  const rd = detectRepetition(NATURAL["da-DK"] + " " + refrain.repeat(6), { locale: "da-DK" });
  check("Q3c a repeated line of DIALOGUE is not filler", rd.band === REPETITION_BAND.PASS);
  check("Q3c the refrain is classified as dialogue", (rd.classes[REPETITION_CLASS.DIALOGUE_REFRAIN] || 0) > 0);

  // (d) a short motif. A recurring image is style; it carries only a token weight.
  const motif = "lyset over vandet ";
  const rm = detectRepetition(NATURAL["da-DK"] + " " + motif.repeat(6), { locale: "da-DK" });
  check("Q3d a short recurring MOTIF does not fail the story", rm.band !== REPETITION_BAND.HARD_REPAIR_OR_REVIEW);
}

// ================================================================ 4. bands, confidence, contract
{
  const r = detectRepetition(NATURAL["en-US"], { locale: "en-US" });
  check("Q4 bands are reported so a caller can see the thresholds used", r.bands.soft === DEFAULT_REPETITION_BANDS.soft && r.bands.hard === DEFAULT_REPETITION_BANDS.hard);
  check("Q4 confidence is bounded 0..1", r.confidence > 0 && r.confidence <= 1);
  const tiny = detectRepetition("Kort tekst. Meget kort.", { locale: "da-DK" });
  check("Q4 a tiny sample yields LOW confidence rather than a loud verdict", tiny.confidence < 0.3);
  check("Q4 the three bands are the documented ones", Object.values(REPETITION_BAND).sort().join(",") === "HARD_REPAIR_OR_REVIEW,PASS,SOFT_REPAIR");
  check("Q4 empty input does not throw", detectRepetition("", { locale: "da-DK" }).score === 0);
  check("Q4 an unknown locale still produces a verdict (never a crash)", detectRepetition(NATURAL["en-US"], { locale: "xx-XX" }).band !== undefined);
  check("Q4 tokenize preserves offsets", tokenize("Abc def").every((t) => "Abc def".slice(t.start, t.end).toLowerCase() === t.w));
}

// ================================================================ 5. entities harvested from a DNA
{
  const dna = {
    protagonist: "Karen Mikkelsen",
    antagonistList: [{ name: "Jesper", relationship: "søn" }, { name: "Bodil", relationship: "svigerdatter" }],
    incitingIncident: "Ved midsommerfesten i Skagen kaldte Jesper mig smålig."
  };
  const e = entitiesFromDna(dna);
  check("Q5 the protagonist is harvested", e.includes("karen") && e.includes("mikkelsen"));
  check("Q5 antagonists are harvested", e.includes("jesper") && e.includes("bodil"));
  check("Q5 proper nouns in free text are harvested", e.includes("skagen"));
  check("Q5 harvesting an empty DNA is safe", entitiesFromDna(null).length === 0 && entitiesFromDna({}).length === 0);
}

// ================================================================ 6. the GATE: soft is repairable, hard fails
{
  const target = { wordsMin: 100, wordsMax: 4000, idealMin: 200, idealMax: 3000 };
  const profile = { locale: "da-DK", language: "Danish" };

  const good = computeStoryMetrics(NATURAL["da-DK"], { locale: "da-DK", profile });
  const gGood = lengthGate(good, target, DEFAULT_LENGTH_GATE_THRESHOLDS);
  check("Q6 natural Danish passes the gate", gGood.pass === true && gGood.state === "PASS");
  check("Q6 the gate reports the band it used", gGood.repetitionBand === REPETITION_BAND.PASS);

  const bad = computeStoryMetrics(PADDED_DA, { locale: "da-DK", profile });
  const gBad = lengthGate(bad, target, DEFAULT_LENGTH_GATE_THRESHOLDS);
  check("Q6 real padding fails the gate", gBad.pass === false && gBad.state === "PADDED");
  check("Q6 a padded story with prose is REPAIRABLE, not a dead end", gBad.repairable === true);
  check("Q6 the failure names the repetition reason", gBad.reasons.some((r) => r.startsWith("E_STORY_PADDED_REPETITION")));

  // Truncation is the one gate failure that is NOT repairable by editing — it has to be finished.
  const cut = computeStoryMetrics(NATURAL["da-DK"].slice(0, 400).replace(/[.!?]\s*$/, "") + " og så", { locale: "da-DK", profile });
  const gCut = lengthGate(cut, target, DEFAULT_LENGTH_GATE_THRESHOLDS);
  check("Q6 a truncated draft is not marked repairable", gCut.repairable === false || gCut.pass === true);

  // Legacy metrics (no repetition result) must behave exactly as before this change.
  const legacy = { actualWordCount: 2000, nearDuplicateParagraphs: 0, repeatedTrigramRatio: 0.09, truncated: false, paragraphCount: 20, paragraphLengthCv: 0.5 };
  const gLegacy = lengthGate(legacy, target, DEFAULT_LENGTH_GATE_THRESHOLDS);
  check("Q6 metrics without a repetition result keep the historical behaviour", gLegacy.pass === false && gLegacy.reasons.some((r) => r.startsWith("E_STORY_PADDED_REPETITION")));
}

// ================================================================ 7. the SCORECARD must agree with the gate
{
  const target = { wordsMin: 1700, wordsMax: 2500, idealMin: 1900, idealMax: 2500 };
  const dna = { protagonist: "Karen", antagonistList: [{ name: "Jesper" }], escalationSteps: ["a", "b", "c"], originalityDimensions: {}, unforgivableQuote: "", reversal: "" };
  const mk = (text, locale) => computeStoryMetrics(text, { locale, profile: { locale, language: "Danish" } });

  // The filler dimension is CRITICAL. Before this change it used the same language-blind ratio as the gate,
  // so a Danish story could pass the gate and still be failed by the scorecard for the very same reason.
  // These are the MEASURED numbers from the production story this step exists to recover
  // (stp_01KYBRC56B9NMFQ3XCWSFQ9NX5, 2932 Danish words): a raw repeated-trigram ratio of 0.0577 — which the
  // historical formula turns into filler 0.538, below the critical floor of 0.6 — against a language-aware
  // score of 0.0099, which is nowhere near padding. Expressing them as data rather than as prose keeps the
  // regression pinned to the exact values that caused it.
  const REAL_TRIGRAM = 0.0577, REAL_SCORE = 0.0099;
  const m = { ...mk(NATURAL["da-DK"], "da-DK"), actualWordCount: 2932, repeatedTrigramRatio: REAL_TRIGRAM };
  m.repetition = { ...m.repetition, score: REAL_SCORE, band: REPETITION_BAND.PASS };
  check("Q7 the historical formula DID fail this story (the defect is real, not imagined)", 1 - Math.min(0.5, REAL_TRIGRAM * 8) < 0.6);
  const gate = lengthGate(m, target, DEFAULT_LENGTH_GATE_THRESHOLDS);
  const sc = computeScorecard({
    storyText: NATURAL["da-DK"], dna, continuity: { pass: true, violations: [], warnings: [] },
    novelty: { pass: true, maxOverall: 0.1 }, titleValidation: { valid: true, score: 1 },
    arc: { complete: true }, locale: "da-DK", modelScores: {}, metrics: m, lengthTarget: target, lengthGateResult: gate
  }, DEFAULT_QUALITY_THRESHOLDS);
  check("Q7 the scorecard's filler dimension no longer punishes Danish grammar", sc.dimensions.filler >= 0.6);
  check("Q7 and the story is READY once filler stops fighting the gate", sc.ready === true);

  // Over-length: the gate calls it ABOVE_MAX_SOFT and PASSES it, so it must not be a critical failure.
  const longMetrics = { ...mk(NATURAL["en-US"], "en-US"), actualWordCount: 3400 };
  const longGate = lengthGate(longMetrics, target, DEFAULT_LENGTH_GATE_THRESHOLDS);
  const scLong = computeScorecard({
    storyText: NATURAL["en-US"], dna, continuity: { pass: true, violations: [], warnings: [] },
    novelty: { pass: true, maxOverall: 0.1 }, titleValidation: { valid: true, score: 1 },
    arc: { complete: true }, locale: "en-US", modelScores: {}, metrics: longMetrics, lengthTarget: target, lengthGateResult: longGate
  }, DEFAULT_QUALITY_THRESHOLDS);
  check("Q7 the gate treats over-length as SOFT", longGate.pass === true && longGate.state === "ABOVE_MAX_SOFT");
  check("Q7 over-length is not a CRITICAL scorecard failure", !scLong.criticalFailures.includes("lengthCompliance"));
  check("Q7 over-length is still reported (as restraint), not hidden", scLong.dimensions.lengthRestraint < 1);

  // Under-length is a real defect and must STILL be critical.
  const shortMetrics = { ...mk(NATURAL["en-US"], "en-US"), actualWordCount: 900 };
  const shortGate = lengthGate(shortMetrics, target, DEFAULT_LENGTH_GATE_THRESHOLDS);
  const scShort = computeScorecard({
    storyText: NATURAL["en-US"], dna, continuity: { pass: true, violations: [], warnings: [] },
    novelty: { pass: true, maxOverall: 0.1 }, titleValidation: { valid: true, score: 1 },
    arc: { complete: true }, locale: "en-US", modelScores: {}, metrics: shortMetrics, lengthTarget: target, lengthGateResult: shortGate
  }, DEFAULT_QUALITY_THRESHOLDS);
  check("Q7 an under-length story still fails critically", scShort.criticalFailures.includes("lengthCompliance") && scShort.ready === false);

  // And real padding must still fail the scorecard's critical filler floor.
  const padMetrics = mk(PADDED_DA, "da-DK");
  const padGate = lengthGate(padMetrics, target, DEFAULT_LENGTH_GATE_THRESHOLDS);
  const scPad = computeScorecard({
    storyText: PADDED_DA, dna, continuity: { pass: true, violations: [], warnings: [] },
    novelty: { pass: true, maxOverall: 0.1 }, titleValidation: { valid: true, score: 1 },
    arc: { complete: true }, locale: "da-DK", modelScores: {}, metrics: padMetrics, lengthTarget: target, lengthGateResult: padGate
  }, DEFAULT_QUALITY_THRESHOLDS);
  check("Q7 genuinely padded prose still fails the critical filler floor", scPad.dimensions.filler < 0.6 && scPad.ready === false);
}

console.log(`Step 5C.34 story quality detector: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
