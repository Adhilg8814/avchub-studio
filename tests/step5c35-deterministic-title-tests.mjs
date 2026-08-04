// P0 Step 5C.35 — DETERMINISTIC TITLE DERIVATION (pure, no provider, no database).
//
// Every title the scheduler does not have to ask a model for is one fewer browser session, one fewer
// provider lease and one fewer slot in the pacing lane. But a title is also the most visible thing about a
// story, so "free" is not a good enough reason on its own: a derived title has to clear the SAME validator
// the model's candidates clear, and it has to read like a headline rather than like the first sentence of
// the story with the full stop removed.
//
// This suite pins both halves — that the derivation works on real-shaped prose in every supported locale,
// and that it declines rather than lowering the bar when the prose cannot supply one.

import { deriveTitle, deterministicTitleCandidates, DETERMINISTIC_TITLE_MIN_SCORE } from "../lib/story/deterministic-title.mjs";
import { validateTitle } from "../lib/story/title-engine.mjs";

let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n, d); } };

const dnaFor = ({ protagonist, antagonist, city, quote, locale }) => ({
  protagonist, protagonistAgeRange: "60s", protagonistOccupation: "retired teacher",
  antagonistList: [{ name: antagonist, relationship: "son", role: "the one who took it" }],
  settingCountry: locale.slice(3), settingCityOrRegion: city,
  incitingIncident: `${antagonist} said the account was his`,
  publicHumiliation: `${antagonist} humiliated me at the dinner`,
  unforgivableQuote: quote,
  counterMove: "I printed the statements",
  emotionalResolution: `${protagonist} got her dignity back`,
  consequences: ["the transfers were reversed"],
  originalityDimensions: {}
});
const profileFor = (locale, language) => ({ locale, language, tone: "measured", genreFamily: "family drama", narrativeTense: "PAST", narratorPerspective: "FIRST" });

// Real-shaped prose: a dialogue line carrying the insult, narration naming the cast, and a closing beat.
const CASES = [
  {
    locale: "da-DK", language: "Danish", protagonist: "Karen", antagonist: "Jesper", city: "Aarhus",
    quote: "Du er bare en gammel dame med et kort",
    text: `Til midsommermiddagen sad vi tolv omkring bordet, og ingen sagde noget om kontoen.
Jesper rejste sig med glasset i hånden og så på mig, som om han allerede havde besluttet sig.
„Du er bare en gammel dame med et kort," sagde han, og der blev helt stille i stuen.
Karen lagde servietten fra sig og rejste sig langsomt uden at svare på det.
Jeg gik ud i køkkenet og stod med hænderne mod bordpladen, indtil vejrtrækningen faldt til ro igen.
Dagen efter printede jeg kontoudtogene ud og lagde dem i en mappe, side efter side, med mit navn øverst.
Karen fik sin værdighed tilbage den eftermiddag, og hun satte en grænse, som familien aldrig havde hørt før.`
  },
  {
    locale: "sv-SE", language: "Swedish", protagonist: "Sofia", antagonist: "Karl", city: "Uppsala",
    quote: "Du har alltid varit den svaga länken",
    text: `Vid middagen i Uppsala satt hela familjen samlad och ingen nämnde pengarna med ett ord.
Karl höjde rösten över bordet och vände sig mot mig med ett leende som inte nådde ögonen.
"Du har alltid varit den svaga länken," sade han, och tystnaden efteråt var värre än orden.
Sofia lade ifrån sig besticken och reste sig utan att svara honom framför de andra.
Dagen därpå skrev jag ut kontoutdragen och lade dem i en mapp med mitt namn överst på varje sida.
Sofia tog tillbaka sin värdighet den kvällen och drog en gräns som familjen aldrig hade hört förut.`
  },
  {
    locale: "bg-BG", language: "Bulgarian", protagonist: "Елена", antagonist: "Димитър", city: "Пловдив",
    quote: "Ти си просто един товар за нас всички",
    text: `На вечерята в Пловдив цялото семейство беше събрано и никой не спомена парите.
Димитър се обърна към мен през масата и заговори бавно, сякаш вече беше решил всичко.
„Ти си просто един товар за нас всички," каза той и тишината след думите беше по-тежка от тях.
Елена остави приборите и стана от масата, без да му отговори пред останалите.
На следващия ден разпечатах извлеченията и ги подредих в папка с моето име отгоре на всяка страница.
Елена си върна достойнството онази вечер и постави граница, каквато семейството не беше чувало.`
  }
];

// ================================================================ 1. it derives, in every locale
for (const c of CASES) {
  const dna = dnaFor(c);
  const profile = profileFor(c.locale, c.language);
  const cands = deterministicTitleCandidates({ storyText: c.text, dna });
  check(`T1 ${c.locale} candidates are harvested from the story itself`, cands.length >= 3, `n=${cands.length}`);
  check(`T1 ${c.locale} every candidate really appears in the story or the DNA`,
    cands.every((x) => c.text.includes(x.title.slice(0, 24)) || `${dna.incitingIncident} ${dna.publicHumiliation} ${dna.unforgivableQuote}`.includes(x.title.slice(0, 24))));
  check(`T1 ${c.locale} candidates carry where they came from`, cands.every((x) => typeof x.source === "string"));

  const d = deriveTitle({ storyText: c.text, dna, profile });
  check(`T1 ${c.locale} a title is derived with no provider call`, d !== null && typeof d.title === "string");
  if (!d) continue;
  const words = d.title.split(/\s+/u).filter(Boolean).length;
  check(`T1 ${c.locale} it is a headline, not a paragraph (${words} words)`, words >= 7 && words <= 22, d.title);
  check(`T1 ${c.locale} it does not lift the story's ENDING`, d.origin !== "CLOSING", `${d.origin}: ${d.title}`);
  check(`T1 ${c.locale} it is grounded in the story's own words`, c.text.includes(d.title.slice(0, 24)) || `${dna.incitingIncident} ${dna.publicHumiliation} ${dna.unforgivableQuote}`.includes(d.title.slice(0, 24)), d.title);
  check(`T1 ${c.locale} it clears the SAME validator the model's candidates clear`,
    validateTitle(d.title, { dna, profile, storyText: c.text }).valid === true);
  check(`T1 ${c.locale} the validator score is above the bar`, d.validatorScore >= DETERMINISTIC_TITLE_MIN_SCORE, `${d.validatorScore}`);
  check(`T1 ${c.locale} it has no dangling quotation marks or trailing punctuation`, !/["“«„”»]/u.test(d.title) && !/[.!?…,;:—–]$/u.test(d.title), d.title);
  check(`T1 ${c.locale} runners-up are offered so the owner can switch for free`, d.candidates.length >= 1);
  check(`T1 ${c.locale} it is marked as deterministic`, d.source === "DETERMINISTIC");
}

// ================================================================ 2. it is deterministic
{
  const c = CASES[0], dna = dnaFor(c), profile = profileFor(c.locale, c.language);
  const a = deriveTitle({ storyText: c.text, dna, profile });
  const b = deriveTitle({ storyText: c.text, dna, profile });
  check("T2 the same story always yields the same title", a.title === b.title);
  check("T2 and the same score", a.score === b.score);
}

// ================================================================ 3. it declines rather than lowering the bar
{
  const c = CASES[0], dna = dnaFor(c), profile = profileFor(c.locale, c.language);
  check("T3 no story text -> no title", deriveTitle({ storyText: "", dna, profile }) === null);
  check("T3 prose too short to contain a clause -> no title", deriveTitle({ storyText: "Kort. Meget kort.", dna, profile }) === null);
  // Prose in the WRONG language must not produce a "Danish" title: the validator's fluency check is the
  // thing that stops it, and the deterministic path must not be able to bypass it.
  const english = "I stayed at the table after the others had gone. There was something in the quiet that kept me from standing up and saying what I meant. My brother said that he would call me back later that evening.";
  const wrong = deriveTitle({ storyText: english, dna, profile });
  check("T3 English prose yields no Danish title", wrong === null, wrong ? wrong.title : "");
  // An impossibly high bar must be respected, not rounded down.
  check("T3 a bar nothing can clear is respected", deriveTitle({ storyText: c.text, dna, profile, minScore: 1.01 }) === null);
}

// ================================================================ 4. it avoids repeating a recent title
{
  const c = CASES[0], dna = dnaFor(c), profile = profileFor(c.locale, c.language);
  const first = deriveTitle({ storyText: c.text, dna, profile });
  const again = deriveTitle({ storyText: c.text, dna, profile, recentTitles: [first.title] });
  check("T4 a title identical to a recent one is not chosen again", again === null || again.title !== first.title, again ? again.title : "null");
}

// ================================================================ 5. malformed input never throws
{
  check("T5 a null DNA is survivable", deriveTitle({ storyText: CASES[0].text, dna: null, profile: profileFor("da-DK", "Danish") }) === null || true);
  check("T5 an empty DNA is survivable", deterministicTitleCandidates({ storyText: CASES[0].text, dna: {} }).every((x) => typeof x.title === "string"));
  check("T5 no arguments at all is survivable", deterministicTitleCandidates({}).length === 0);
}

console.log(`Step 5C.35 deterministic title: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
