// P0 Step 5C.11 — TextGenerationProvider abstraction (story writer).
//
// One pluggable contract for turning a project brief into a validated story:
//   provider = { kind, available(), generateStory(brief) -> { story, providerResultRef } }
// The LOCAL provider is deterministic and always available (wraps the 5C.10 story sources). The
// GROK_CHAT adapter (Worker-side) reuses the same contract; the pure prompt builder + response
// parser live HERE so they are provider-free-testable and shared by the real actuator. No secrets,
// URLs, or paths ever enter a prompt or a stored story.

import { createHash } from "node:crypto";
import { createStoryDraft, validateStory, assertNoSecret } from "./story.mjs";
import { paceFor, NARRATION_SAFETY } from "./duration-budget.mjs";

function err(code, message) { return Object.assign(new Error(message), { code }); }
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function storyPromptHash(prompt) { return `sha256:${createHash("sha256").update(String(prompt), "utf8").digest("hex")}`; }

// ---- deterministic story brief → chat prompt (pure; used by the GROK_CHAT adapter) --------------
// The response contract is a single JSON object in a fenced block, so the parser can correlate and
// validate without scraping prose.
export function buildStoryPrompt(brief = {}) {
  const idea = clean(brief.idea, 1200);
  if (idea.length < 3) throw err("E_TEXT_BRIEF", "The story idea is required");
  assertNoSecret(idea, "idea");
  const language = clean(brief.language, 16) || "en";
  const beats = Math.min(10, Math.max(3, Math.round(Number(brief.beatCount) || 5)));
  const parts = [
    `You are a screenwriter for short vertical videos. Write a complete short story for this idea: ${idea}.`,
    brief.genre ? `Genre: ${clean(brief.genre, 60)}.` : null,
    brief.tone ? `Tone: ${clean(brief.tone, 120)}.` : null,
    brief.visualStyle ? `Visual style: ${clean(brief.visualStyle, 300)}.` : null,
    brief.worldBible ? `World rules: ${clean(brief.worldBible, 600)}.` : null,
    `Language: ${language}. Exactly ${beats} beats.`,
    "Respond with ONLY a fenced json code block containing one JSON object with keys:",
    '{"title","synopsis","styleBible","characters":[{"name","description"}],"beats":[{"heading","narration","visual"}]}',
    "narration = one or two spoken sentences; visual = one concrete filmable shot description. No URLs, no file paths, no markdown outside the fence."
  ].filter(Boolean);
  return parts.join(" ");
}

// ---- chat response text → validated story (pure; strict, never trusts prose) --------------------
export function parseStoryResponse(text, { language = "en", genre = null } = {}) {
  const raw = String(text ?? "");
  if (raw.trim().length < 2) throw err("E_TEXT_RESPONSE_EMPTY", "The provider returned no text");
  // Prefer a fenced ```json block; fall back to the outermost {...} object.
  let jsonText = null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) jsonText = fence[1];
  else {
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) jsonText = raw.slice(start, end + 1);
  }
  if (!jsonText) throw err("E_TEXT_RESPONSE_FORMAT", "No JSON story found in the response");
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { throw err("E_TEXT_RESPONSE_FORMAT", "The story JSON did not parse"); }
  try {
    return validateStory({ ...parsed, language: parsed.language || language, genre: parsed.genre || genre });
  } catch (e) { throw err(e.code === "E_STORY_UNSAFE_TEXT" ? "E_TEXT_RESPONSE_UNSAFE" : "E_TEXT_RESPONSE_INVALID", e.message); }
}

// ---- the 3-beat adaptation (pure prompt + parser) -----------------------------------------------
//
// P0 Step 5C.48 — a 2779-word story cannot be "sampled" into a 22-second film. Somebody has to decide what
// the film IS: which moment opens it, what moves, and how it lands. That decision is a model's job and the
// artifact it produces is what every later stage reads, so the prompt states the shape exactly and the
// parser trusts nothing.
//
// The narration language is stated separately from the story's, because a film may be narrated in a
// language the source was not written in — and when it is, that has to be a decision on the record rather
// than a surprise the locale gate discovers later.
export function buildAdaptationPrompt(brief = {}) {
  const story = clean(brief.storyText, 7000);
  if (story.length < 200) throw err("E_MOVIE_ADAPTATION_BRIEF", "the source story text is required");
  assertNoSecret(story, "storyText");
  const seconds = Math.max(8, Math.min(60, Number(brief.targetDurationSeconds) || 22));
  // Words the narration may hold, from the SAME speech model the duration budget uses to decide what actually
  // gets spoken. Asking for a wider band is how a 73-word script passes every gate and then loses its last
  // five sentences to a budget that measured it at 29 s against a 20 s slot: nothing is wasted (the budget
  // decides the text before synthesis) but the film silently stops saying what the adaptation wrote.
  const pace = paceFor(brief.locale || "en-US");
  const speakable = seconds * NARRATION_SAFETY;
  const beats = Math.max(1, Math.min(8, Number(brief.beatCount) || 3));
  const maxWords = Math.max(12, Math.floor((speakable - beats * 0.25) * pace.wps));
  // …and not so few that the film is mostly silence, which is the floor the pre-spend gate enforces (1.8 words
  // per second). The band has to satisfy BOTH, or a script written to the letter of the prompt is refused by
  // the gate standing behind it.
  const minWords = Math.min(maxWords, Math.max(8, Math.ceil(seconds * 1.85)));
  // A locale tag is not an instruction a writer can follow. "en-US" is turned into "English" so the one
  // invocation we get is not spent asking a model to guess what language a BCP-47 tag means.
  const LANGUAGE_OF = {
    en: "English", da: "Danish", sv: "Swedish", bg: "Bulgarian", vi: "Vietnamese", de: "German",
    fr: "French", es: "Spanish", it: "Italian", nl: "Dutch", pl: "Polish", pt: "Portuguese",
    ro: "Romanian", cs: "Czech", el: "Greek", fi: "Finnish", hr: "Croatian", sk: "Slovak",
    uk: "Ukrainian", ru: "Russian", tr: "Turkish"
  };
  const raw = clean(brief.languageName || brief.locale, 40);
  const language = (/^[A-Za-z]{2}(-[A-Za-z]{2})?$/u.test(raw) ? LANGUAGE_OF[raw.slice(0, 2).toLowerCase()] : raw) || "English";
  const parts = [
    "You are adapting an existing short story into a vertical short-form film of exactly three shots.",
    `The film runs about ${seconds} seconds. Narration language: ${language}.`,
    "Return exactly three beats, in this order and with these roles:",
    '1. "HOOK" — the first line has to make someone stop scrolling. Open in the middle of the situation, never with background.',
    '2. "PROGRESSION" — the thing that actually happens. New information, not a restatement of the hook.',
    '3. "PAYOFF" or "CLIFFHANGER" — the landing. A payoff resolves it; a cliffhanger leaves one specific question open. Pick one.',
    `The three narrations together must be between ${minWords} and ${maxWords} words, and each beat must be a different moment of the story — never the same moment reworded.`,
    "Write the narration to be SPOKEN: plain, common words, short sentences, no digits (write numbers as words), no abbreviations, no on-screen text, no stage directions inside the narration.",
    "Keep every person and place name exactly as the story spells them.",
    brief.characterNames && brief.characterNames.length ? `These names must appear in the narration: ${brief.characterNames.slice(0, 4).map((n) => clean(n, 60)).join(", ")}.` : null,
    "Each beat also needs a filmable visual: one continuous action a camera could hold for a few seconds. No montage, no cuts inside a beat, no crowds.",
    "Describe the people once, concretely enough that three separately generated shots show the SAME person: apparent age, build, hair, face, clothing.",
    "Respond with ONLY a fenced json code block containing one JSON object with keys:",
    '{"hook","narrativeObjective","tone","audience","beats":[{"role","summary","narration","visual","emotionalBeat","location"}],'
      + '"characters":[{"name","ageRange","genderPresentation","face","hair","clothing","build"}],'
      + '"locations":[{"name","description","interiorExterior","timeOfDay","props"}],'
      + '"style":{"visualGenre","palette","lighting","lensFraming","realismLevel","motionStyle","era"}}',
    "hook = the spoken opening line, in the narration language. No markdown outside the fence, no URLs, no file paths.",
    "--- SOURCE STORY ---",
    story
  ].filter(Boolean);
  return parts.join("\n");
}

const ADAPTATION_ROLES = new Set(["HOOK", "PROGRESSION", "PAYOFF", "CLIFFHANGER", "SETUP"]);

/** Chat response text → the decisions buildAdaptation() needs. Strict: a missing beat, a role the shape does
 *  not know, or an empty narration is a refusal, because every one of them renders as a film with a hole. */
export function parseAdaptationResponse(text, { expectedBeats = 3 } = {}) {
  const raw = String(text ?? "");
  if (raw.trim().length < 2) throw err("E_MOVIE_ADAPTATION_RESPONSE_EMPTY", "the provider returned no text");
  let jsonText = null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) jsonText = fence[1];
  else {
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) jsonText = raw.slice(start, end + 1);
  }
  if (!jsonText) throw err("E_MOVIE_ADAPTATION_RESPONSE_FORMAT", "no JSON adaptation found in the response");
  let p;
  try { p = JSON.parse(jsonText); } catch { throw err("E_MOVIE_ADAPTATION_RESPONSE_FORMAT", "the adaptation JSON did not parse"); }

  const beats = Array.isArray(p.beats) ? p.beats : [];
  if (beats.length !== expectedBeats) {
    throw err("E_MOVIE_ADAPTATION_RESPONSE_INVALID", `the response has ${beats.length} beats, not ${expectedBeats}`);
  }
  const outBeats = beats.map((b, i) => {
    const role = clean(b && b.role, 20).toUpperCase();
    if (!ADAPTATION_ROLES.has(role)) throw err("E_MOVIE_ADAPTATION_RESPONSE_INVALID", `beat ${i + 1} has role "${role}", which is not a beat role`);
    const narration = clean(b && b.narration, 800);
    if (narration.length < 8) throw err("E_MOVIE_ADAPTATION_RESPONSE_INVALID", `beat ${i + 1} has no narration`);
    const visual = clean(b && (b.visual || b.summary), 400);
    if (visual.length < 8) throw err("E_MOVIE_ADAPTATION_RESPONSE_INVALID", `beat ${i + 1} has nothing to film`);
    return { role, summary: clean(b.summary || visual, 300), narration, visual, emotionalBeat: clean(b.emotionalBeat, 60), location: clean(b.location, 80) };
  });
  // Two beats saying the same thing is the exact failure this milestone exists to remove — a film that
  // repeats one moment three times reads as nothing happening.
  const seen = new Set();
  for (const b of outBeats) {
    const key = b.narration.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").split(" ").slice(0, 8).join(" ");
    if (seen.has(key)) throw err("E_MOVIE_ADAPTATION_RESPONSE_INVALID", "two beats open with the same line");
    seen.add(key);
  }
  const hook = clean(p.hook, 400) || outBeats[0].narration;
  const out = {
    hook, narrativeObjective: clean(p.narrativeObjective, 400), tone: clean(p.tone, 120), audience: clean(p.audience, 120),
    beats: outBeats,
    characters: (Array.isArray(p.characters) ? p.characters : []).slice(0, 6).map((c) => ({
      name: clean(c && c.name, 80), ageRange: clean(c && c.ageRange, 40), genderPresentation: clean(c && c.genderPresentation, 40),
      face: clean(c && c.face, 240), hair: clean(c && c.hair, 120), clothing: clean(c && c.clothing, 200), build: clean(c && c.build, 120)
    })).filter((c) => c.name),
    locations: (Array.isArray(p.locations) ? p.locations : []).slice(0, 6).map((l) => ({
      name: clean(l && l.name, 80), description: clean(l && l.description, 300),
      interiorExterior: clean(l && l.interiorExterior, 20), timeOfDay: clean(l && l.timeOfDay, 40),
      props: (Array.isArray(l && l.props) ? l.props : []).slice(0, 8).map((x) => clean(x, 60))
    })).filter((l) => l.name),
    style: p.style && typeof p.style === "object" ? {
      visualGenre: clean(p.style.visualGenre, 80), palette: clean(p.style.palette, 160), lighting: clean(p.style.lighting, 160),
      lensFraming: clean(p.style.lensFraming, 160), realismLevel: clean(p.style.realismLevel, 40),
      motionStyle: clean(p.style.motionStyle, 120), era: clean(p.style.era, 60)
    } : {}
  };
  assertNoSecret(`${out.hook} ${outBeats.map((b) => `${b.narration} ${b.visual}`).join(" ")}`, "adaptation");
  return out;
}

/** The deterministic adaptation: three beats taken from the story's own opening, middle and end. Not as good
 *  as a written one — it is a fallback and a test fixture, and it is honest about being mechanical. */
export function localAdaptationFrom({ storyText, targetDurationSeconds = 22 } = {}) {
  const sentences = String(storyText || "").split(/(?<=[.!?…])\s+/u).map((s) => s.trim()).filter((s) => s.length > 20);
  if (sentences.length < 3) throw err("E_MOVIE_ADAPTATION_BRIEF", "the story has too little prose to adapt");
  const pick = [sentences[0], sentences[Math.floor(sentences.length / 2)], sentences[sentences.length - 1]];
  const roles = ["HOOK", "PROGRESSION", "PAYOFF"];
  const budget = Math.max(30, Math.floor(Number(targetDurationSeconds) * 2.6 / 3));
  const trim = (s) => {
    const w = s.split(/\s+/u);
    return (w.length <= budget ? w : w.slice(0, budget)).join(" ").replace(/[,;:]$/u, "") + (w.length > budget ? "." : "");
  };
  return {
    hook: trim(pick[0]), narrativeObjective: "", tone: "", audience: "",
    beats: pick.map((s, i) => ({ role: roles[i], summary: trim(s), narration: trim(s), visual: trim(s), emotionalBeat: "", location: "" })),
    characters: [], locations: [], style: {}
  };
}

// ---- LOCAL provider (deterministic, always available, no side effects) --------------------------
export function createLocalTextProvider() {
  return Object.freeze({
    kind: "LOCAL",
    available: () => true,
    async adaptStory(brief = {}) {
      return { adaptation: localAdaptationFrom(brief), providerResultRef: null, promptHash: storyPromptHash("LOCAL_ADAPTATION"), responseChars: 0 };
    },
    async generateStory(brief = {}, _hooks = {}) {
      const mode = brief.mode === "PASTED" ? "PASTED" : "IDEA";
      const story = createStoryDraft({
        mode, idea: brief.idea, text: brief.pastedStory,
        language: brief.language, genre: brief.genre, visualStyle: brief.visualStyle,
        targetDurationSeconds: brief.targetDurationSeconds, characters: brief.characters || undefined
      });
      return { story, providerResultRef: null };
    }
  });
}

// ---- GROK_CHAT provider shell -------------------------------------------------------------------
// The real network/DOM work is an injected `actuator({ prompt })` (Worker-side, session-bound,
// exactly-once is enforced by the CALLER via story_text_attempts). This shell only builds the
// prompt, runs the single actuator invocation, and validates/correlates the response.
export function createGrokChatTextProvider({ actuator = null } = {}) {
  return Object.freeze({
    kind: "GROK_CHAT",
    available: () => typeof actuator === "function",
    // ONE invocation, same discipline as generateStory: the caller records the durable submit fact in
    // onBeforeSubmit, immediately before the single send, so a crash after it is UNCERTAIN and never re-sent.
    async adaptStory(brief = {}, { onBeforeSubmit = null } = {}) {
      if (typeof actuator !== "function") throw err("E_TEXT_PROVIDER_UNAVAILABLE", "Grok Chat is not configured on this runtime");
      const prompt = buildAdaptationPrompt(brief);
      const out = await actuator({ prompt, onBeforeSubmit });
      if (!out || typeof out.text !== "string") throw err("E_MOVIE_ADAPTATION_RESPONSE_EMPTY", "the provider returned no text");
      const adaptation = parseAdaptationResponse(out.text, { expectedBeats: Number(brief.beatCount) || 3 });
      const ref = typeof out.responseId === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(out.responseId) ? out.responseId : null;
      return { adaptation, providerResultRef: ref, promptHash: storyPromptHash(prompt), responseChars: out.text.length };
    },
    async generateStory(brief = {}, { onBeforeSubmit = null } = {}) {
      if (typeof actuator !== "function") throw err("E_TEXT_PROVIDER_UNAVAILABLE", "Grok Chat is not configured on this runtime");
      const prompt = buildStoryPrompt(brief);
      // The actuator must call onBeforeSubmit() exactly once IMMEDIATELY before its single send —
      // the caller records the durable submit fact there, so a crash after the click is tracked
      // read-only (UNCERTAIN), never re-submitted.
      const out = await actuator({ prompt, onBeforeSubmit });
      if (!out || typeof out.text !== "string") throw err("E_TEXT_RESPONSE_EMPTY", "The provider returned no text");
      const story = parseStoryResponse(out.text, { language: brief.language, genre: brief.genre });
      const ref = typeof out.responseId === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(out.responseId) ? out.responseId : null;
      return { story, providerResultRef: ref };
    }
  });
}
