// P0 Step 5C.10 — story schema + scene planner + continuity prompt (pure logic, no DB/ffmpeg/provider).
import assert from "node:assert/strict";
import { validateStory, parsePastedStory, draftStoryFromIdea, createStoryDraft } from "../lib/movie/story.mjs";
import { planScenes, buildScenePrompt, MIN_SCENES, MAX_SCENES } from "../lib/movie/scene-planner.mjs";

let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }
function throwsWith(name, fn, frag) { try { fn(); assert.fail(name + " expected throw"); } catch (e) { if (e instanceof assert.AssertionError && /expected throw/.test(e.message)) throw e; check(name, `${e.code || ""} ${e.message || ""}`.includes(frag), true); } }

// ---- story schema ----
{
  const s = validateStory({ title: "  Quiet Lake  ", synopsis: "A boat at dawn.", visualStyle: "cinematic mist", characters: [{ name: "Mai", description: "a young rower" }], beats: [{ narration: "She rows", visual: "boat on lake" }] });
  check("A1 title trimmed", s.title, "Quiet Lake");
  check("A1 styleBible from visualStyle", s.styleBible, "cinematic mist");
  check("A1 language defaults en", s.language, "en");
  check("A1 characters kept", s.characters[0].name, "Mai");
  check("A1 beats kept", s.beats.length, 1);
  throwsWith("A2 missing title rejects", () => validateStory({ synopsis: "x" }), "title is required");
  throwsWith("A2 URL in text rejects", () => validateStory({ title: "T", synopsis: "see https://x.com/y" }), "E_STORY_UNSAFE_TEXT");
  throwsWith("A2 secret in character rejects", () => validateStory({ title: "T", characters: [{ name: "A", description: "token: abc" }] }), "E_STORY_UNSAFE_TEXT");
  check("A3 caps characters at 12", validateStory({ title: "T", characters: Array.from({ length: 30 }, (_, i) => ({ name: "C" + i })) }).characters.length, 12);
}

// ---- pasted story ----
{
  const pasted = "The old lighthouse stood alone.\n\nEvery night the keeper climbed the stairs.\n\nOne evening a ship appeared on the horizon.";
  const s = parsePastedStory(pasted, { language: "en" });
  check("B1 paragraphs become beats", s.beats.length, 3);
  check("B1 title derived from first line", s.title.length > 0, true);
  throwsWith("B2 too-short paste rejects", () => parsePastedStory("hi"), "E_STORY_TOO_SHORT");
  const oneLine = parsePastedStory("First sentence here. Second sentence follows. Third one ends it.");
  check("B3 single paragraph splits into sentences", oneLine.beats.length >= 3, true);
}

// ---- idea draft ----
{
  const s = draftStoryFromIdea("a lonely robot learns to paint", { genre: "sci-fi", targetDurationSeconds: 18, sceneDurationSeconds: 6 });
  check("C1 idea yields >=3 beats", s.beats.length >= MIN_SCENES, true);
  check("C1 beat count sized to duration (18/6=3)", s.beats.length, 3);
  check("C1 has a default protagonist", s.characters.length >= 1, true);
  check("C1 styleBible present", s.styleBible.length > 0, true);
  throwsWith("C2 too-short idea rejects", () => draftStoryFromIdea("a"), "E_STORY_IDEA_TOO_SHORT");
  const big = draftStoryFromIdea("an epic voyage across many seas", { targetDurationSeconds: 600, sceneDurationSeconds: 6 });
  check("C3 beat count clamped to 10 max", big.beats.length, MAX_SCENES);
  check("C4 createStoryDraft routes IDEA", createStoryDraft({ mode: "IDEA", idea: "a quiet town" }).beats.length >= 3, true);
  throwsWith("C4 bad mode rejects", () => createStoryDraft({ mode: "NOPE" }), "E_STORY_MODE");
}

// ---- scene planner + continuity ----
{
  const story = validateStory({
    title: "The Rower", synopsis: "A rower crosses a misty lake.", visualStyle: "soft mist, golden sunrise, filmic",
    characters: [{ name: "Mai", description: "a young woman in a red scarf" }, { name: "Old Bao", description: "an elderly fisherman" }],
    beats: [{ narration: "Mai unties the boat", visual: "a small boat at a wooden dock" }, { narration: "She rows into the mist", visual: "oars cutting still water" }, { narration: "Bao waves from the shore", visual: "an old man on the misty bank" }]
  });
  const scenes = planScenes(story, { aspectRatio: "9:16", sceneDurationSeconds: 6, targetDurationSeconds: 18 });
  check("D1 3 beats -> 3 scenes", scenes.length, 3);
  check("D1 ordinals sequential", scenes.map((s) => s.ordinal).join(","), "0,1,2");
  check("D1 each scene has a self-contained videoPrompt", scenes.every((s) => s.videoPrompt.length > 20), true);
  check("D1 prompt carries the style bible", scenes[0].videoPrompt.includes("soft mist"), true);
  check("D1 prompt carries character appearance (continuity)", scenes[0].videoPrompt.includes("red scarf"), true);
  check("D1 continuity lists characters", scenes[0].continuity.characters.join(","), "Mai,Old Bao");
  check("D1 continuity links previous scene", [scenes[0].continuity.previousOrdinal, scenes[1].continuity.previousOrdinal], [null, 0]);
  check("D1 aspect + duration carried", [scenes[0].aspectRatio, scenes[0].durationSeconds], ["9:16", 6]);

  // ---- D2: a thin story is NOT padded into several identical scenes ----
  //
  // These assertions used to require 5 scenes for a story with no beats, because the planner reached a
  // three-scene minimum by REPEATING beats. That was deliberately removed: padding by duplication does not
  // add content, it buys the same shot several times, and every duplicate is a paid provider generation.
  // See the contract comment above `planScenes` in lib/movie/scene-planner.mjs.
  //
  // The contract now: scene count follows the CONTENT. Duration shapes each scene's length, never how many
  // there are. Callers who genuinely want padding opt in with `padToMinimum`.
  const thin = validateStory({ title: "Solo", synopsis: "One quiet moment.", beats: [] });
  const planned = planScenes(thin, { sceneDurationSeconds: 6, targetDurationSeconds: 30 });
  check("D2 no beats -> exactly one scene from the synopsis", planned.length, 1);
  check("D2 the one scene carries the synopsis", planned[0].visualDescription.includes("One quiet moment"), true);
  // The load-bearing assertion: a 30 s target must NOT become five scenes. If duration ever drives the count
  // again, this is the line that goes red.
  check("D2 target duration does not multiply scenes", planned.length, 1);
  check("D2 padToMinimum cannot fabricate scenes from nothing",
    planScenes(thin, { sceneDurationSeconds: 6, targetDurationSeconds: 30, padToMinimum: true }).length, 1);

  // One real beat is one scene, however long the film is meant to be.
  const oneBeat = validateStory({ title: "Solo", synopsis: "One quiet moment.", beats: [{ visual: "a boat at a dock" }] });
  check("D2 one beat -> one scene", planScenes(oneBeat, { sceneDurationSeconds: 6, targetDurationSeconds: 60 }).length, 1);
  check("D2 scenes are distinct by default",
    new Set(planScenes(validateStory({ title: "T", synopsis: "S", beats: [{ visual: "a" }, { visual: "b" }] }),
      { sceneDurationSeconds: 6 }).map((s) => s.visualDescription)).size, 2);

  // The opt-in path still works, and still repeats by design — that is what the caller asked for.
  const padded = planScenes(oneBeat, { sceneDurationSeconds: 6, targetDurationSeconds: 30, padToMinimum: true });
  check("D2 padToMinimum on request -> duration-derived count", padded.length, 5);
  check("D2 padded scenes are within the planner's bounds", padded.length >= MIN_SCENES && padded.length <= MAX_SCENES, true);
  check("D2 padToMinimum is capped at MAX_SCENES",
    planScenes(oneBeat, { sceneDurationSeconds: 6, targetDurationSeconds: 3000, padToMinimum: true }).length, MAX_SCENES);
  check("D2 padToMinimum floors at MIN_SCENES when no target is given",
    planScenes(oneBeat, { sceneDurationSeconds: 6, padToMinimum: true }).length, MIN_SCENES);

  // More beats than the planner will render are truncated, not merged.
  const many = validateStory({ title: "T", synopsis: "S", beats: Array.from({ length: MAX_SCENES + 4 }, (_, i) => ({ visual: `beat ${i}` })) });
  check("D2 beats beyond MAX_SCENES are truncated", planScenes(many, { sceneDurationSeconds: 6 }).length, MAX_SCENES);

  // continuity prompt does not leak secrets (story pre-sanitized; builder stays safe)
  const p = buildScenePrompt({ visual: "a market street", characters: [{ name: "Lan", description: "a baker" }], styleBible: "warm morning light", aspectRatio: "9:16" });
  check("D3 buildScenePrompt includes character + style", p.includes("Lan") && p.includes("warm morning light"), true);
}

console.log(`Step 5C.10 story + scene planner: ${passed} passed, 0 failed`);
