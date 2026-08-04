// P0 Step 5C.34 — LANGUAGE-AWARE repetition detection (pure).
//
// The detector this replaces counted every repeated word-trigram, in any language, as padding. On a
// 2932-word Danish story that produced 0.0577 against a 0.05 threshold and failed the story. Looking at
// what actually repeated settles the question:
//
//     at det var ×7 · fordi det var ×5 · han sagde at ×5 · jeg havde ikke ×5 · og at det ×4
//
// That is not padding, that is Danish. V2 Germanic languages carry obligatory `det`/`at`/`der`
// scaffolding, so their function-word trigram density is structurally higher than English — the
// threshold was calibrated on the wrong language. The content-bearing repeats in the same story were
// `lars og inger` (character names), `80 000 kroner` (a plot fact) and `den kommunale familierådgivning`
// (a named institution). Flagging those as filler would be worse than useless: it would push a repair
// pass to delete the very things that make the story coherent.
//
// So this detector scores only what padding actually looks like:
//   * long VERBATIM blocks of content words repeated across the text;
//   * PARAPHRASE blocks (near-duplicate paragraphs);
//   * content-bearing short spans repeated far more often than a motif would be.
//
// And it explicitly does NOT count:
//   * spans made only of function words / pronouns  -> FUNCTION_ECHO
//   * spans containing a character name or a fact   -> ENTITY_ECHO
//   * spans inside quoted dialogue                  -> DIALOGUE_REFRAIN
//   * a small number of repeats of a short content span -> MOTIF (a device, not filler)
//
// Everything is deterministic, Unicode-safe, and reports WHERE it looked so a repair pass can act on
// spans instead of rewriting a whole story.

export const REPETITION_CLASS = Object.freeze({
  FUNCTION_ECHO: "FUNCTION_ECHO",
  ENTITY_ECHO: "ENTITY_ECHO",
  DIALOGUE_REFRAIN: "DIALOGUE_REFRAIN",
  MOTIF: "MOTIF",
  VERBATIM_BLOCK: "VERBATIM_BLOCK",
  PARAPHRASE_BLOCK: "PARAPHRASE_BLOCK"
});

export const REPETITION_BAND = Object.freeze({
  PASS: "PASS",
  SOFT_REPAIR: "SOFT_REPAIR",
  HARD_REPAIR_OR_REVIEW: "HARD_REPAIR_OR_REVIEW"
});

// Function words: articles, pronouns, prepositions, conjunctions, auxiliaries, common adverbs. These
// are the words prose is MADE of; their recurrence carries no information about padding.
const STOPWORDS = Object.freeze({
  "da-DK": new Set(("og i jeg det at en den til er som på de med han af for ikke der var mig sig men et har om vi min havde ham hun nu over da fra du ud sin dem os op man hans hvor eller hvad skal selv her alle vil blev kunne ind når være dog jo denne end deres være vor blive samme hvis dig alt sit sådan hende jer hendes noget lige mit hver dette meget mine kan kun hvem hvilken efter uden mod under ved efter siden mens fordi altid aldrig igen stadig bare kom kommer gik går sagde sige").split(" ")),
  "sv-SE": new Set(("och i att det som en på är av för med den till har de inte om jag ett men var han hon vi från än dem så kan man när där eller hade sin nu efter vid över också bara mycket alla vad ska sig sitt mot skulle vara vart under genom mellan mot utan blir blev kommer kom sade säger gick går stod här nog ju samma denna dessa detta någon något några vilken vilket vilka därför eftersom medan alltid aldrig igen fortfarande").split(" ")),
  "bg-BG": new Set(("и в на да не се от че за с по като а или но то той тя те аз ти ние вие си е са бе беше бяха ще би при към през със му ѝ им ни ви ги го я този тази това тези онзи така само още вече пак пак дори защото докато когато където който която което които някой нещо всичко всеки много малко пред след над под без между срещу заради тогава сега винаги никога казах каза казаха отидох").split(" ")),
  "en-US": new Set(("the a an and or but if of to in on at for with by from as is was were be been am are do did does have has had he she it they we you i me him her them us my your his their our its this that these those there here then than so not no yes what which who whom when where why how all any some each every other another said says say went go going come came just still again already because while about into over under after before between against through").split(" ")),
  "vi-VN": new Set(("và của là có không được người một những cái này đó khi thì mà cho với ở trong ra vào lên xuống đã sẽ đang rất cũng nữa lại chỉ vẫn còn nhưng nếu vì nên để từ đến bởi tôi anh chị em ông bà họ chúng nó mình ai gì sao đâu nào mỗi các mọi hơn nhất về theo trên dưới trước sau giữa nói bảo hỏi biết thấy nghĩ").split(" "))
});
const DEFAULT_STOPWORDS = STOPWORDS["en-US"];

function stopwordsFor(locale) {
  if (STOPWORDS[locale]) return STOPWORDS[locale];
  const lang = String(locale || "").slice(0, 2).toLowerCase();
  for (const [k, v] of Object.entries(STOPWORDS)) if (k.slice(0, 2) === lang) return v;
  return DEFAULT_STOPWORDS;
}
export function supportedLocales() { return Object.keys(STOPWORDS); }

// What fraction of a text's words are function words OF A GIVEN LOCALE. A script check cannot tell Danish
// from English — both are Latin — but their function words share almost nothing, so this is what tells
// them apart.
export function stopwordDensity(text, locale) {
  const stops = stopwordsFor(locale);
  const tokens = tokenize(text);
  if (tokens.length < 20) return 0;
  let hits = 0;
  for (const t of tokens) if (stops.has(t.w)) hits += 1;
  return Number((hits / tokens.length).toFixed(4));
}

// Which of the supported locales this text most looks like. Comparing WHICH language wins is far more
// robust than comparing how function-word-dense a text is: density varies with style and with the length
// of the stopword list, but the winner does not change unless the language does.
export function dominantLocale(text) {
  let best = null, bestScore = -1;
  for (const locale of Object.keys(STOPWORDS)) {
    const d = stopwordDensity(text, locale);
    if (d > bestScore) { bestScore = d; best = locale; }
  }
  return { locale: best, density: bestScore };
}

// Tokenise keeping the character offset of every token, so a span can be reported as a real position in
// the source text and a repair can target it without re-finding it by string search.
export function tokenize(text) {
  const out = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(String(text || "")))) out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

// Character ranges covered by quoted dialogue.
function dialogueRanges(text) {
  const ranges = [];
  const re = /["“«„][^"“”«»„]{2,600}["”»“]/gu;
  let m;
  while ((m = re.exec(String(text || "")))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
const inRanges = (pos, ranges) => ranges.some(([a, b]) => pos >= a && pos < b);

// Entity vocabulary: character names from the story DNA plus anything that looks like a fact (numbers,
// currency). A span containing one of these is about the story, not about filling space.
function entityVocabulary({ characterNames = [], extraEntities = [] } = {}) {
  const v = new Set();
  for (const name of [...characterNames, ...extraEntities]) {
    for (const part of String(name || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (part.length > 1) v.add(part);
  }
  return v;
}

// Harvest proper nouns from a story DNA object of ANY shape. The DNA carries names in a protagonist
// field, in timeline events, in consequences prose — there is no single key to read. Over-collecting is
// the safe direction: an extra name can only make the detector MORE forgiving of an entity echo, and a
// missed name is what makes it accuse a story of padding for naming its own characters.
export function entitiesFromDna(dna, { max = 200 } = {}) {
  const out = new Set();
  const visit = (v, depth) => {
    if (out.size >= max || depth > 6) return;
    if (typeof v === "string") {
      const m = v.match(/\p{Lu}[\p{Ll}À-ɏ]{1,}/gu) || [];
      for (const w of m) out.add(w.toLowerCase());
      return;
    }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (v && typeof v === "object") { for (const x of Object.values(v)) visit(x, depth + 1); }
  };
  visit(dna, 0);
  return [...out];
}
const isNumberish = (w) => /^\p{N}[\p{N}.,]*$/u.test(w);

// A span only counts as padding when it carries enough MEANING to have been worth padding with.
// "jeg tænkte på at" ("I thought about that") is four words and one content word: it is how a Danish
// first-person narrator joins clauses, and a story that says it four times in 2900 words is not padded.
// The same is true of anaphora — "jeg gik på arbejde jeg lavede mad jeg…" is a deliberate device.
const VERBATIM_MIN_CONTENT_WORDS = 4;
const VERBATIM_MIN_SPAN_WORDS = 8;
const FUNCTION_DOMINANT_RATIO = 0.5;

function classifySpan(tokens, span, { stops, entities, dlgRanges }) {
  const words = span.words;
  const contentWords = words.filter((w) => !stops.has(w));
  if (contentWords.length === 0) return REPETITION_CLASS.FUNCTION_ECHO;
  const distinctContent = new Set(contentWords).size;

  // A line a character keeps saying is a device, at any length — every occurrence inside quotes.
  const everyOccurrenceInDialogue = span.offsets.every((o) => inRanges(o.start, dlgRanges));
  if (everyOccurrenceInDialogue) return REPETITION_CLASS.DIALOGUE_REFRAIN;

  // A LONG, content-bearing block repeated verbatim is padding, and this test comes FIRST on purpose.
  // A full sentence in any language is roughly half function words and usually names someone, so judging
  // a long span by its function-word ratio — or excusing it because it contains a character name or a
  // year — excuses exactly the thing the detector exists to catch. (It did: a 14-word sentence repeated
  // fourteen times scored zero as a "function echo" until this ordering was fixed.)
  if (words.length >= VERBATIM_MIN_SPAN_WORDS && distinctContent >= VERBATIM_MIN_CONTENT_WORDS) return REPETITION_CLASS.VERBATIM_BLOCK;

  // Below that length the story's own vocabulary is protected: a phrase built around a character name,
  // a place or an amount is about the story, not about filling space.
  const hasEntity = words.some((w) => entities.has(w) || isNumberish(w));
  if (hasEntity) return REPETITION_CLASS.ENTITY_ECHO;

  // Grammar scaffolding: one content word, or mostly function words. Recurrence here is a property of
  // the LANGUAGE, not of the story.
  const contentRatio = contentWords.length / words.length;
  if (contentWords.length <= 1 || contentRatio < FUNCTION_DOMINANT_RATIO) return REPETITION_CLASS.FUNCTION_ECHO;

  // Otherwise: a short content span. A few occurrences is a motif; many distinct-content repeats is filler.
  if (span.count >= 5 && distinctContent >= 3) return REPETITION_CLASS.VERBATIM_BLOCK;
  return REPETITION_CLASS.MOTIF;
}

// Weight per class: how much a repeat of this kind counts toward the padding score.
const CLASS_WEIGHT = Object.freeze({
  [REPETITION_CLASS.FUNCTION_ECHO]: 0,
  [REPETITION_CLASS.ENTITY_ECHO]: 0,
  [REPETITION_CLASS.DIALOGUE_REFRAIN]: 0,
  [REPETITION_CLASS.MOTIF]: 0.05,
  [REPETITION_CLASS.VERBATIM_BLOCK]: 1,
  [REPETITION_CLASS.PARAPHRASE_BLOCK]: 1
});

// Calibrated against the real corpus in this workspace (three ACCEPTED stories in da-DK / sv-SE / bg-BG
// plus the three that failed). Accepted stories must sit well inside PASS, or the gate is just noise.
export const DEFAULT_REPETITION_BANDS = Object.freeze({ soft: 0.05, hard: 0.12 });

// Find MAXIMAL repeated n-gram spans (longest first), so one 10-word verbatim echo is reported once
// rather than as eight overlapping trigrams.
function maximalRepeatedSpans(tokens, { minN = 3, maxN = 14 } = {}) {
  const claimed = new Set();
  const spans = [];
  for (let n = maxN; n >= minN; n -= 1) {
    if (tokens.length < n) continue;
    const buckets = new Map();
    for (let i = 0; i + n <= tokens.length; i += 1) {
      const key = tokens.slice(i, i + n).map((t) => t.w).join(" ");
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }
    // Most-repeated first within a length. Claiming is first-come, so without this the span a reader
    // actually cares about ("this sentence appears 14 times") loses its tokens to whichever overlapping
    // straddle happened to start earlier in the text, and the verdict names the wrong phrase.
    const ordered = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [key, positions] of ordered) {
      if (positions.length < 2) continue;
      const fresh = positions.filter((i) => {
        for (let k = i; k < i + n; k += 1) if (claimed.has(k)) return false;
        return true;
      });
      if (fresh.length < 2) continue;
      for (const i of fresh) for (let k = i; k < i + n; k += 1) claimed.add(k);
      spans.push({
        text: key,
        words: key.split(" "),
        count: fresh.length,
        offsets: fresh.map((i) => ({ start: tokens[i].start, end: tokens[i + n - 1].end, tokenIndex: i }))
      });
    }
  }
  return spans;
}

/**
 * detectRepetition(text, options) -> {
 *   score, band, confidence, explanation, locale,
 *   spans: [{ text, count, class, weight, offsets:[{start,end}] }],
 *   classes: { CLASS: excessCount }, contentTokens, totalTokens
 * }
 */
export function detectRepetition(text, {
  locale = "en-US", characterNames = [], extraEntities = [],
  bands = DEFAULT_REPETITION_BANDS, nearDuplicateParagraphPairs = 0
} = {}) {
  const src = String(text || "");
  const tokens = tokenize(src);
  const stops = stopwordsFor(locale);
  const entities = entityVocabulary({ characterNames, extraEntities });
  const dlgRanges = dialogueRanges(src);
  const contentTokens = tokens.filter((t) => !stops.has(t.w)).length;

  const rawSpans = maximalRepeatedSpans(tokens);
  const spans = [];
  const classes = {};
  let weightedExcessWords = 0;

  for (const span of rawSpans) {
    const cls = classifySpan(tokens, span, { stops, entities, dlgRanges });
    const weight = CLASS_WEIGHT[cls] ?? 0;
    const excessOccurrences = span.count - 1;
    const excessWords = excessOccurrences * span.words.length;
    classes[cls] = (classes[cls] || 0) + excessOccurrences;
    weightedExcessWords += weight * excessWords;
    spans.push({
      text: span.text, count: span.count, class: cls, weight,
      words: span.words.length, offsets: span.offsets.map((o) => ({ start: o.start, end: o.end }))
    });
  }

  // Near-duplicate paragraphs are paraphrase padding; they are supplied by the caller (paragraph-level
  // work already happens in story-metrics) and count at full weight.
  if (nearDuplicateParagraphPairs > 0) {
    classes[REPETITION_CLASS.PARAPHRASE_BLOCK] = nearDuplicateParagraphPairs;
    weightedExcessWords += nearDuplicateParagraphPairs * 40; // a duplicated paragraph is ~40 content words
  }

  const denominator = Math.max(60, contentTokens);
  const score = Number(Math.min(1, weightedExcessWords / denominator).toFixed(4));
  // Confidence rises with sample size: a 200-word draft cannot support a strong verdict either way.
  const confidence = Number(Math.max(0.2, Math.min(1, tokens.length / 1200)).toFixed(2));

  const band = score > bands.hard ? REPETITION_BAND.HARD_REPAIR_OR_REVIEW
    : score > bands.soft ? REPETITION_BAND.SOFT_REPAIR
      : REPETITION_BAND.PASS;

  const counted = spans.filter((s) => s.weight > 0).sort((a, b) => (b.weight * b.words * (b.count - 1)) - (a.weight * a.words * (a.count - 1)));
  const ignored = spans.filter((s) => s.weight === 0);
  const explanation = counted.length === 0
    ? `No content-bearing repetition. ${ignored.length} repeated span(s) were ignored as ${summarizeClasses(ignored)} — normal for ${locale}.`
    : `${counted.length} content-bearing repeated span(s) (${summarizeClasses(counted)}); ${ignored.length} ignored as ${summarizeClasses(ignored) || "none"}. Worst: "${counted[0].text.slice(0, 80)}" ×${counted[0].count}.`;

  return Object.freeze({
    locale, score, band, confidence, explanation,
    contentTokens, totalTokens: tokens.length,
    classes: Object.freeze(classes),
    spans: Object.freeze(spans),
    countedSpans: Object.freeze(counted),
    bands
  });
}

function summarizeClasses(spans) {
  const c = {};
  for (const s of spans) c[s.class] = (c[s.class] || 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k}×${v}`).join(", ");
}

// The spans a repair pass should rewrite: content-bearing only, worst first, bounded.
export function repairTargets(result, { max = 6 } = {}) {
  return result.countedSpans.slice(0, max).map((s) => ({
    text: s.text, count: s.count, class: s.class, offsets: s.offsets
  }));
}
