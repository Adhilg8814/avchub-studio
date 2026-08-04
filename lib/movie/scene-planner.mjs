// P0 Step 5C.10 — scene planner + continuity prompt builder (pure, deterministic).
//
// Turns a validated story into 3-10 ordered scenes. Each scene's videoPrompt is SELF-CONTAINED: it
// carries the character bible (appearance of every character present) + the style bible, so the
// video model renders consistent characters and a consistent look across scenes without any shared
// hidden state. No secrets/paths/URLs are ever placed in a prompt (the story is pre-sanitized).

const MIN_SCENES = 3;
const MAX_SCENES = 10;
const ASPECTS = new Set(["16:9", "9:16", "1:1", "2:3", "3:2"]);

function err(code, message) { return Object.assign(new Error(message), { code }); }
function trimTo(s, n) { const v = String(s || "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n) : v; }

// Build a self-contained, continuity-preserving video prompt for one scene.
export function buildScenePrompt({ visual, narration, characters = [], styleBible = "", aspectRatio = "9:16" }) {
  const base = trimTo(visual || narration || "A cinematic moment", 500);
  const cast = characters.filter((c) => c && c.name).slice(0, 6)
    .map((c) => (c.description ? `${c.name} (${trimTo(c.description, 160)})` : c.name)).join("; ");
  const style = trimTo(styleBible, 240) || "cinematic, natural color, filmic lighting";
  const orientation = aspectRatio === "9:16" ? "vertical" : aspectRatio === "16:9" ? "widescreen" : aspectRatio;
  const parts = [
    base,
    cast ? `Consistent characters across all scenes: ${cast}.` : null,
    `Visual style (keep identical every scene): ${style}.`,
    `${orientation} cinematic video, natural motion, coherent lighting and color continuity.`
  ].filter(Boolean);
  return trimTo(parts.join(" "), 900);
}

// Plan scenes from a validated story. One scene per beat, capped at MAX_SCENES.
//
// P0 Step 5C.41 — this used to REPEAT beats to reach a three-scene minimum, so a one-beat story became three
// identical scenes and the runtime generated all three. That cost four Grok generations nobody asked for
// during the 5C.40 cert, and it would cost them again on every short film: padding by duplication does not add
// content, it buys the same shot several times.
//
// A story with one beat is one scene. `padToMinimum` restores the old behaviour for a caller that genuinely
// wants it, and defaults OFF because "make more scenes out of nothing" has no correct use.
export function planScenes(story, opts = {}) {
  if (!story || typeof story !== "object") throw err("E_SCENE_PLAN_INVALID", "story is required");
  const aspectRatio = ASPECTS.has(opts.aspectRatio) ? opts.aspectRatio : "9:16";
  const perScene = Number.isFinite(opts.sceneDurationSeconds) ? Math.min(30, Math.max(1, Math.round(opts.sceneDurationSeconds))) : 6;
  const styleBible = trimTo(story.styleBible, 600);
  const characters = Array.isArray(story.characters) ? story.characters : [];
  let beats = Array.isArray(story.beats) ? story.beats.filter((b) => b && (b.visual || b.narration || b.heading)) : [];

  if (beats.length === 0) {
    // No beats at all: the synopsis becomes ONE scene. Fabricating several from a single sentence produces
    // several identical scenes and spends a generation on each.
    beats = [{ visual: story.synopsis || story.title, narration: story.synopsis || "" }];
  } else if (opts.padToMinimum === true && beats.length < MIN_SCENES) {
    const target = Number.isFinite(opts.targetDurationSeconds) ? Math.max(perScene * MIN_SCENES, Math.round(opts.targetDurationSeconds)) : perScene * MIN_SCENES;
    const count = Math.min(MAX_SCENES, Math.max(MIN_SCENES, Math.round(target / perScene)));
    beats = Array.from({ length: count }, (_, i) => beats[i % beats.length]);
  }
  if (beats.length > MAX_SCENES) beats = beats.slice(0, MAX_SCENES);

  return beats.map((b, i) => {
    const visualDescription = trimTo(b.visual || b.narration || story.synopsis || story.title, 600);
    const narration = trimTo(b.narration || "", 600);
    return Object.freeze({
      ordinal: i,
      heading: trimTo(b.heading || `Scene ${i + 1}`, 120),
      narration,
      visualDescription,
      videoPrompt: buildScenePrompt({ visual: visualDescription, narration, characters, styleBible, aspectRatio }),
      durationSeconds: perScene,
      aspectRatio,
      continuity: Object.freeze({
        characters: Object.freeze(characters.map((c) => c.name).filter(Boolean)),
        styleRef: styleBible.slice(0, 120),
        previousOrdinal: i > 0 ? i - 1 : null
      })
    });
  });
}

export { MIN_SCENES, MAX_SCENES };
