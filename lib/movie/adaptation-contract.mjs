// P0 Step 5C.37 — MOVIE ADAPTATION CONTRACT (pure, versioned, immutable).
//
// A 2932-word story was being fed to a movie pipeline that could hold three sentences, and the "adaptation"
// was `firstSentence.slice(0, 300)` per paragraph. That is not an adaptation, it is a sampling — which is
// why the resulting film had no hook, no progression and no payoff, just three unrelated moments.
//
// An adaptation is its own artifact: a decision about what this film IS, taken once, recorded immutably,
// and referred to by everything downstream. The story is never mutated; the adaptation points at it.
//
// It also carries the two bibles that keep a film coherent shot to shot — who these people look like, and
// what this world looks like — so every shot prompt resolves from the same source instead of each one
// re-describing the character from scratch and drifting a little further each time.

export const ADAPTATION_FORMATS = Object.freeze({
  SHORT_FORM: "SHORT_FORM",   // a hook and one movement — the whole story is NOT the goal
  // P0 Step 5C.48 — the 15–30 second shape: three beats and nothing else. Hook, the thing that happens,
  // and the landing. It is a SEPARATE format rather than a relaxation of SHORT_FORM: a 40-second film with
  // no SETUP is still missing one, and the four-role rule stays exactly as strict for the shape it describes.
  SHORT_FORM_3BEAT: "SHORT_FORM_3BEAT",
  FULL_STORY: "FULL_STORY",   // the arc, compressed
  TRAILER: "TRAILER"          // tension without resolution
});

// What each shape must contain. Stated once, so the builder and the pre-spend gate cannot disagree about
// which beats a format needs — they used to hold two copies of the same list.
export const FORMAT_STRUCTURE = Object.freeze({
  SHORT_FORM: Object.freeze({ requiredRoles: Object.freeze(["HOOK", "SETUP", "PROGRESSION"]), endingRoles: Object.freeze(["PAYOFF", "CLIFFHANGER"]), exactBeats: null }),
  SHORT_FORM_3BEAT: Object.freeze({ requiredRoles: Object.freeze(["HOOK", "PROGRESSION"]), endingRoles: Object.freeze(["PAYOFF", "CLIFFHANGER"]), exactBeats: 3 }),
  FULL_STORY: Object.freeze({ requiredRoles: Object.freeze([]), endingRoles: Object.freeze([]), exactBeats: null }),
  TRAILER: Object.freeze({ requiredRoles: Object.freeze([]), endingRoles: Object.freeze([]), exactBeats: null })
});
export function formatStructure(format) {
  return FORMAT_STRUCTURE[format] || FORMAT_STRUCTURE.FULL_STORY;
}
export const ADAPTATION_ERRORS = Object.freeze({
  INVALID: "E_MOVIE_ADAPTATION_INVALID",
  FACT_DRIFT: "E_MOVIE_ADAPTATION_FACT_DRIFT",
  LOCALE_DRIFT: "E_MOVIE_ADAPTATION_LOCALE_DRIFT",
  STRUCTURE: "E_MOVIE_ADAPTATION_STRUCTURE"
});

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const clean = (v, n = 600) => String(v ?? "").replace(/\s+/gu, " ").trim().slice(0, n);
const list = (v, n = 20, len = 200) => (Array.isArray(v) ? v : []).filter(Boolean).slice(0, n).map((x) => clean(x, len));

// ---------------------------------------------------------------- bibles
/**
 * A character as the film must render them, every time. `allowedChanges` exists because a story spans time
 * — a coat comes off, a face is tear-streaked — and a validator that forbids ALL change would flag the
 * story happening. `forbiddenChanges` is the part that is never allowed to move.
 */
export function buildCharacterBible(characters = [], { locale = "en-US" } = {}) {
  const entries = (Array.isArray(characters) ? characters : []).slice(0, 8).map((c, i) => Object.freeze({
    characterId: `chr_${String(i).padStart(2, "0")}`,
    canonicalName: clean(c.name || c.canonicalName, 80),
    ageRange: clean(c.ageRange || c.age, 40) || "adult",
    genderPresentation: clean(c.genderPresentation || c.gender, 40) || "unspecified",
    face: clean(c.face || c.description, 240),
    hair: clean(c.hair, 120),
    clothing: clean(c.clothing, 200),
    build: clean(c.build || c.bodyBuild, 120),
    distinguishingFeatures: list(c.distinguishingFeatures || c.features, 6, 120),
    allowedChanges: list(c.allowedChanges, 8, 120).length ? list(c.allowedChanges, 8, 120)
      : ["expression", "posture", "lighting on the face", "whether a coat or bag is carried"],
    forbiddenChanges: list(c.forbiddenChanges, 8, 120).length ? list(c.forbiddenChanges, 8, 120)
      : ["face", "apparent age", "hair colour and length", "gender presentation", "build"]
  }));
  return Object.freeze({ version: 1, locale, characters: Object.freeze(entries) });
}

export function buildLocationBible(locations = []) {
  const entries = (Array.isArray(locations) ? locations : []).slice(0, 8).map((l, i) => Object.freeze({
    locationId: `loc_${String(i).padStart(2, "0")}`,
    name: clean(l.name, 80),
    description: clean(l.description, 300),
    interiorExterior: /out|exter/iu.test(String(l.interiorExterior || l.type || "")) ? "EXTERIOR" : "INTERIOR",
    timeOfDay: clean(l.timeOfDay, 40) || "day",
    props: list(l.props, 10, 80),
    forbidden: list(l.forbidden, 8, 80)
  }));
  return Object.freeze({ version: 1, locations: Object.freeze(entries) });
}

export function buildStyleBible(style = {}) {
  return Object.freeze({
    version: 1,
    visualGenre: clean(style.visualGenre || style.genre, 80) || "grounded contemporary drama",
    palette: clean(style.palette, 160) || "muted naturals, warm practicals, cool shadows",
    lighting: clean(style.lighting, 160) || "available light, soft key, gentle contrast",
    lensFraming: clean(style.lensFraming || style.framing, 160) || "35–50mm equivalent, eye-level, shallow depth",
    realismLevel: clean(style.realismLevel, 40) || "photoreal",
    motionStyle: clean(style.motionStyle, 120) || "slow handheld drift, no whip pans",
    era: clean(style.era, 60) || "present day",
    aspectRatio: clean(style.aspectRatio, 12) || "9:16",
    forbiddenStyles: list(style.forbiddenStyles, 10, 80).length ? list(style.forbiddenStyles, 10, 80)
      : ["cartoon", "anime", "3d render", "cgi game cinematic", "oversaturated hdr", "text overlays", "watermarks", "split screen"]
  });
}

// ---------------------------------------------------------------- the contract
/**
 * Build the adaptation. This does not call a model — it takes the decisions (from the model, or from an
 * owner) and freezes them into the artifact everything downstream reads, validating the invariants that
 * the story must not lose.
 */
export function buildAdaptation({
  sourceStoryId, targetDurationSeconds, locale, format = ADAPTATION_FORMATS.SHORT_FORM,
  audience = "", tone = "", pov = "FIRST_PERSON", hook = "", narrativeObjective = "",
  narrationScript = "", beatSheet = [], continuityConstraints = [],
  characters = [], locations = [], style = {}, version = 1,
  // 5C.48 — a film may be narrated in a language the source story was not written in, and when it is, the
  // adaptation says so and says why. Left implicit, the locale check downstream can only read it as drift.
  sourceLocale = null, localeRationale = ""
} = {}) {
  if (!sourceStoryId) throw err(ADAPTATION_ERRORS.INVALID, "an adaptation must point at the story it came from");
  const target = Number(targetDurationSeconds);
  if (!Number.isFinite(target) || target <= 0) throw err(ADAPTATION_ERRORS.INVALID, "an adaptation needs a target duration");
  if (!ADAPTATION_FORMATS[format]) throw err(ADAPTATION_ERRORS.INVALID, `unknown adaptation format ${format}`);
  const script = clean(narrationScript, 8000);
  if (!script) throw err(ADAPTATION_ERRORS.INVALID, "an adaptation needs a final narration script");

  const beats = (Array.isArray(beatSheet) ? beatSheet : []).slice(0, 24).map((b, i) => Object.freeze({
    beatId: `beat_${String(i).padStart(2, "0")}`,
    role: clean(b.role, 40) || (i === 0 ? "HOOK" : "PROGRESSION"),
    summary: clean(b.summary || b.text, 300),
    narration: clean(b.narration, 800),
    emotionalBeat: clean(b.emotionalBeat || b.emotion, 60),
    locationId: clean(b.locationId, 20) || null,
    characterIds: list(b.characterIds, 6, 20)
  }));

  // Short form is a shape, not a length. Without these the film is a clip — and the reason the first attempt
  // at this felt like nothing was happening is that it had none of them.
  const structure = formatStructure(format);
  if (structure.requiredRoles.length || structure.endingRoles.length || structure.exactBeats) {
    const roles = new Set(beats.map((b) => b.role.toUpperCase()));
    const missing = structure.requiredRoles.filter((r) => !roles.has(r));
    const hasEnding = structure.endingRoles.length === 0 || structure.endingRoles.some((r) => roles.has(r));
    if (!hook) throw err(ADAPTATION_ERRORS.STRUCTURE, "a short-form adaptation needs a hook");
    if (structure.exactBeats && beats.length !== structure.exactBeats) {
      // A fourth beat is not a bonus. The length was decided before the writing, and a beat that has to be
      // dropped later is a beat whose narration was paid for and thrown away.
      throw err(ADAPTATION_ERRORS.STRUCTURE,
        `${format} is exactly ${structure.exactBeats} beats; this one has ${beats.length}`, { beats: beats.length });
    }
    if (missing.length || !hasEnding) {
      throw err(ADAPTATION_ERRORS.STRUCTURE,
        `${format} needs ${structure.requiredRoles.join(", ")} and a ${structure.endingRoles.join(" or ")}; missing ${[...missing, hasEnding ? null : structure.endingRoles.join("|")].filter(Boolean).join(", ")}`,
        { roles: [...roles] });
    }
  }

  return Object.freeze({
    adaptationId: null,                 // assigned when it is persisted
    version, sourceStoryId,
    targetDurationSeconds: target, locale: clean(locale, 20), format,
    sourceLocale: sourceLocale ? clean(sourceLocale, 20) : null,
    localeRationale: clean(localeRationale, 300),
    audience: clean(audience, 120), tone: clean(tone, 120), pov: clean(pov, 40),
    hook: clean(hook, 400), narrativeObjective: clean(narrativeObjective, 400),
    narrationScript: script,
    beatSheet: Object.freeze(beats),
    characterBible: buildCharacterBible(characters, { locale }),
    locationBible: buildLocationBible(locations),
    styleBible: buildStyleBible(style),
    continuityConstraints: Object.freeze(list(continuityConstraints, 24, 200))
  });
}

/**
 * The invariants an adaptation may never break. Checked against the SOURCE story, because an adaptation
 * that quietly renames a character or moves a scene to another city is not an adaptation of that story.
 */
export function validateAdaptationAgainstStory(adaptation, story, { locale = null } = {}) {
  const problems = [];
  const hay = `${adaptation.narrationScript} ${adaptation.hook} ${adaptation.beatSheet.map((b) => `${b.summary} ${b.narration}`).join(" ")}`;

  // Names, places and relationships must survive.
  const names = [story?.protagonist, ...((story?.antagonistList || []).map((a) => a && a.name))].filter((x) => typeof x === "string" && x.length > 1);
  for (const nm of names) {
    if (!hay.includes(nm)) problems.push({ kind: "MISSING_CHARACTER", detail: nm });
  }
  const city = story?.settingCityOrRegion;
  if (typeof city === "string" && city.length > 2 && hay.includes(city) === false && adaptation.locationBible.locations.every((l) => !`${l.name} ${l.description}`.includes(city))) {
    problems.push({ kind: "MISSING_LOCATION", detail: city });
  }
  // Amounts and years are facts; an adaptation may omit one, never change it.
  const factNumbers = new Set();
  for (const f of (story?.monetaryFacts || [])) if (f && Number.isFinite(Number(f.amount))) factNumbers.add(String(f.amount));
  for (const t of (story?.timeline || [])) if (t && /^\d{4}$/u.test(String(t.when))) factNumbers.add(String(t.when));
  for (const m of hay.matchAll(/\b(\d{4}|\d{5,7})\b/gu)) {
    const n = m[1];
    if (/^\d{4}$/u.test(n) && Number(n) > 1900 && Number(n) < 2100 && factNumbers.size && !factNumbers.has(n)) {
      problems.push({ kind: "INVENTED_YEAR", detail: n });
    }
  }
  // Locale must not drift — an adaptation of a Danish story is in Danish.
  if (locale && adaptation.locale && adaptation.locale !== locale) {
    problems.push({ kind: "LOCALE_DRIFT", detail: `${adaptation.locale} vs ${locale}` });
  }
  if (problems.length) {
    const kind = problems.some((p) => p.kind === "LOCALE_DRIFT") ? ADAPTATION_ERRORS.LOCALE_DRIFT : ADAPTATION_ERRORS.FACT_DRIFT;
    throw err(kind, `the adaptation departs from the story in ${problems.length} way(s)`, { problems });
  }
  return true;
}

// ---------------------------------------------------------------- shot plan, from the real audio
export const SHOT_ERRORS = Object.freeze({
  OVERLOADED: "E_MOVIE_SHOT_OVERLOADED",
  NO_TIMELINE: "E_MOVIE_SHOT_NO_TIMELINE"
});

// Below this a shot cannot show an action, only a state. Above it a single shot outstays its welcome.
const MIN_SHOT_MS = 1200;
const MAX_SHOT_MS = 8000;
// Roughly how much can actually happen per second of screen time. A shot asked to show three actions in
// two seconds will show none of them.
const ACTIONS_PER_SECOND = 0.6;

const ACTION_SPLIT = /\s*(?:,\s*(?:og|och|и|and|then|så)\b|\bog\b|\boch\b|\bи\b|\band then\b|\bthen\b)\s*/iu;

/**
 * One shot per narration segment, timed by the segment's REAL audio boundaries — so a shot cannot start
 * before its line does. A segment carrying more action than its seconds can hold is split.
 */
export function buildShotPlan({ timeline, adaptation, defaults = {} } = {}) {
  if (!timeline || !Array.isArray(timeline.segments) || !timeline.segments.length) {
    throw err(SHOT_ERRORS.NO_TIMELINE, "a shot plan needs an aligned narration timeline");
  }
  const style = adaptation.styleBible;
  const chars = adaptation.characterBible.characters;
  const locs = adaptation.locationBible.locations;
  const beatById = new Map(adaptation.beatSheet.map((b) => [b.beatId, b]));
  const shots = [];

  for (const seg of timeline.segments) {
    const beat = seg.associatedBeatId ? beatById.get(seg.associatedBeatId) : null;
    const durMs = seg.audioEndMs - seg.audioStartMs;
    // How many distinct actions is this line asking for, and can the time hold them?
    const clauses = seg.text.split(ACTION_SPLIT).map((x) => x.trim()).filter((x) => x.length > 3);
    const capacity = Math.max(1, Math.floor((durMs / 1000) * ACTIONS_PER_SECOND));
    const pieces = clauses.length > capacity && durMs >= MIN_SHOT_MS * 2
      ? splitSegmentEvenly(seg, Math.min(clauses.length, Math.max(2, Math.ceil(durMs / MAX_SHOT_MS))))
      : [{ startMs: seg.audioStartMs, endMs: seg.audioEndMs, text: seg.text }];

    if (clauses.length > capacity && pieces.length === 1) {
      throw err(SHOT_ERRORS.OVERLOADED,
        `"${seg.text.slice(0, 60)}…" asks for ${clauses.length} actions in ${Math.round(durMs)}ms and cannot be shown`,
        { segmentId: seg.segmentId, actions: clauses.length, durationMs: durMs });
    }

    for (const piece of pieces) {
      // Who is in this shot. A first-person narration never says the narrator's name — "I read it in the
      // hallway" — so matching on names alone left every shot of such a film with NO character description,
      // and three separately generated shots then show three different people. The bible's first character is
      // the one the film is about, so it carries.
      const named = chars.filter((c) => piece.text.includes(c.canonicalName));
      const present = named.length ? named : chars.slice(0, 1);
      const loc = locs.find((l) => piece.text.includes(l.name)) || (beat && locs.find((l) => l.locationId === beat.locationId)) || locs[0] || null;
      const shotId = `shot_${String(shots.length).padStart(3, "0")}`;
      shots.push(Object.freeze({
        shotId,
        startMs: piece.startMs, endMs: piece.endMs,
        expectedDurationMs: piece.endMs - piece.startMs,
        narrationSegmentId: seg.segmentId,
        narrationText: piece.text,
        // What this shot must SHOW — taken from the line being spoken over it, not from the story at large.
        semanticIntent: piece.text,
        visibleCharacters: Object.freeze(present.map((c) => c.characterId)),
        characterAppearance: Object.freeze(present.map((c) => Object.freeze({
          characterId: c.characterId, canonicalName: c.canonicalName,
          mustMatch: Object.freeze({ face: c.face, hair: c.hair, clothing: c.clothing, ageRange: c.ageRange, build: c.build }),
          forbiddenChanges: c.forbiddenChanges
        }))),
        action: clean(clauses[0] || piece.text, 240),
        locationId: loc ? loc.locationId : null,
        location: loc ? loc.description || loc.name : "",
        timeOfDay: (loc && loc.timeOfDay) || (beat && beat.timeOfDay) || "day",
        cameraFraming: defaults.framing || (present.length ? "medium close-up, eye level" : "wide establishing, eye level"),
        cameraMovement: defaults.movement || style.motionStyle,
        emotionalBeat: (beat && beat.emotionalBeat) || "",
        forbiddenElements: style.forbiddenStyles,
        continuityFromPrevious: shots.length ? shots[shots.length - 1].shotId : null,
        continuityToNext: null,
        generationPrompt: buildShotPrompt({ text: piece.text, present, loc, style, beat }),
        negativePrompt: buildNegativePrompt(style),
        referenceAssets: Object.freeze([]),
        minimumSourceHeight: defaults.minimumSourceHeight || 640
      }));
    }
  }
  // Link forward now that every shot exists.
  const linked = shots.map((s, i) => Object.freeze({ ...s, continuityToNext: shots[i + 1] ? shots[i + 1].shotId : null }));
  return Object.freeze({
    version: 1,
    shots: Object.freeze(linked),
    startMs: linked[0].startMs,
    endMs: linked[linked.length - 1].endMs,
    shotCount: linked.length
  });
}

function splitSegmentEvenly(seg, pieces) {
  const out = [];
  const words = seg.words;
  const per = Math.ceil(words.length / pieces);
  for (let i = 0; i < words.length; i += per) {
    const chunk = words.slice(i, i + per);
    if (!chunk.length) continue;
    out.push({ startMs: chunk[0].startMs, endMs: chunk[chunk.length - 1].endMs, text: chunk.map((w) => w.text).join(" ") });
  }
  return out;
}

/**
 * A prompt that describes THIS moment. The character and style descriptions come from the bibles verbatim,
 * so shot 7 asks for the same person shot 1 did — which is the only way a face stays the same face.
 */
export function buildShotPrompt({ text, present = [], loc = null, style, beat = null }) {
  const cast = present.map((c) => `${c.canonicalName}: ${[c.ageRange, c.genderPresentation, c.face, c.hair, c.clothing, c.build].filter(Boolean).join(", ")}`).join("; ");
  const parts = [
    clean(text, 300),
    loc ? `Location: ${loc.description || loc.name}${loc.timeOfDay ? `, ${loc.timeOfDay}` : ""}.` : null,
    cast ? `Characters, identical in every shot — ${cast}.` : null,
    beat && beat.emotionalBeat ? `Emotional register: ${beat.emotionalBeat}.` : null,
    `Style, identical in every shot: ${style.visualGenre}; ${style.palette}; ${style.lighting}; ${style.lensFraming}; ${style.realismLevel}; ${style.era}.`,
    `${style.aspectRatio} vertical, ${style.motionStyle}, coherent lighting and colour continuity.`
  ].filter(Boolean);
  return clean(parts.join(" "), 1200);
}
export function buildNegativePrompt(style) {
  return clean([...style.forbiddenStyles, "on-screen text", "subtitles", "logo", "extra people", "changing faces", "changing clothes", "letterboxing", "black bars"].join(", "), 400);
}

/** Every millisecond of a shot must have a prompt that matches the line playing over it. */
export function validateShotFidelity(shotPlan, timeline) {
  const bySeg = new Map(timeline.segments.map((s) => [s.segmentId, s]));
  const problems = [];
  for (const sh of shotPlan.shots) {
    const seg = bySeg.get(sh.narrationSegmentId);
    if (!seg) { problems.push({ shotId: sh.shotId, kind: "ORPHAN_SHOT" }); continue; }
    if (sh.startMs < seg.audioStartMs - 1 || sh.endMs > seg.audioEndMs + 1) {
      problems.push({ shotId: sh.shotId, kind: "OUTSIDE_SEGMENT", detail: `${sh.startMs}-${sh.endMs} vs ${seg.audioStartMs}-${seg.audioEndMs}` });
    }
    if (!sh.generationPrompt.includes(sh.narrationText.slice(0, Math.min(40, sh.narrationText.length)))) {
      problems.push({ shotId: sh.shotId, kind: "PROMPT_NOT_FROM_LINE" });
    }
    if (sh.expectedDurationMs < MIN_SHOT_MS * 0.5) problems.push({ shotId: sh.shotId, kind: "SHOT_TOO_SHORT", detail: `${sh.expectedDurationMs}ms` });
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems.map((p) => Object.freeze(p))) });
}
