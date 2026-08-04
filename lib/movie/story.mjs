// P0 Step 5C.10 — story schema + local story sources (pure, deterministic, provider-free).
//
// The story is the editable source of truth the user works with before generating video. It has a
// validated schema; two local sources produce a DRAFT the user then edits: parse a PASTED story, or
// expand an IDEA into a structured draft. A Grok text adapter can be plugged behind the same
// createStoryDraft(...) shape later — the manual/pasted + local-idea sources work independently and
// never touch a provider, credentials, or the network. No secrets/URLs/paths are ever stored.

const MAX_TITLE = 160;
const MAX_SYNOPSIS = 2000;
const MAX_TEXT = 8000;
const SECRETish = /(https?:\/\/|[A-Za-z]:[\\/]|\bcookie\b|\btoken\b|\bpassword\b|\bproxy\b|Bearer\s)/i;

function err(code, message) { return Object.assign(new Error(message), { code }); }
// Collapse ALL whitespace (incl. newlines + control chars) to single spaces, trim, and cap length.
function clean(v, max) {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}
function titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }
export function assertNoSecret(value, field) {
  if (typeof value === "string" && SECRETish.test(value)) throw err("E_STORY_UNSAFE_TEXT", `${field} must not contain URLs, paths, or secrets`);
}

// ---- schema ------------------------------------------------------------------------------
// Story = { title, synopsis, language, genre?, styleBible, characters:[{name,description}], beats:[{heading,narration,visual}] }
export function validateStory(input) {
  if (!input || typeof input !== "object") throw err("E_STORY_INVALID", "story must be an object");
  const title = clean(input.title, MAX_TITLE);
  if (title.length < 1) throw err("E_STORY_INVALID", "story title is required");
  const synopsis = clean(input.synopsis, MAX_SYNOPSIS);
  const styleBible = clean(input.styleBible ?? input.visualStyle ?? "", 600);
  const language = clean(input.language, 16) || "en";
  const genre = input.genre != null ? clean(input.genre, 60) : null;
  const characters = Array.isArray(input.characters) ? input.characters.slice(0, 12).map((c, i) => {
    const name = clean(c && c.name, 80) || `Character ${i + 1}`;
    const description = clean(c && c.description, 400);
    assertNoSecret(name, "character.name"); assertNoSecret(description, "character.description");
    return { name, description };
  }) : [];
  const beats = Array.isArray(input.beats) ? input.beats.slice(0, 20).map((b) => ({
    heading: clean(b && b.heading, 120),
    narration: clean(b && b.narration, 600),
    visual: clean(b && b.visual, 600)
  })).filter((b) => b.narration || b.visual || b.heading) : [];
  for (const f of [title, synopsis, styleBible]) assertNoSecret(f, "story text");
  return Object.freeze({ title, synopsis, language, genre, styleBible, characters: Object.freeze(characters), beats: Object.freeze(beats) });
}

// ---- source 1: parse a PASTED story into the schema --------------------------------------
export function parsePastedStory(text, opts = {}) {
  if (typeof text !== "string" || text.trim().length < 10) throw err("E_STORY_TOO_SHORT", "Paste at least a few sentences of story");
  const raw = text.slice(0, MAX_TEXT);
  assertNoSecret(raw, "pasted story");
  const paragraphs = raw.split(/\n\s*\n/).map((p) => clean(p, 600)).filter(Boolean);
  const chunks = paragraphs.length >= 2 ? paragraphs : clean(raw, MAX_TEXT).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const title = clean(opts.title, MAX_TITLE) || titleCase(chunks[0].split(/\s+/).slice(0, 7).join(" "));
  const synopsis = chunks.slice(0, 2).join(" ").slice(0, MAX_SYNOPSIS);
  const beats = chunks.map((c) => ({ heading: "", narration: c.slice(0, 600), visual: c.slice(0, 600) }));
  return validateStory({ title, synopsis, language: opts.language || "en", genre: opts.genre || null, styleBible: opts.visualStyle || "cinematic, natural lighting, filmic color", characters: opts.characters || [], beats });
}

// ---- source 2: expand an IDEA into a structured DRAFT (deterministic, editable) ----------
// A local, provider-free starting point: it never claims to be a finished screenplay — it gives the
// user a coherent skeleton (title, synopsis, a protagonist, style, and beats sized to the target
// duration) that they then edit before generating video.
export function draftStoryFromIdea(idea, opts = {}) {
  const seed = clean(idea, MAX_TEXT);
  if (seed.length < 3) throw err("E_STORY_IDEA_TOO_SHORT", "Describe the idea in a few words");
  assertNoSecret(seed, "idea");
  const words = seed.split(/\s+/);
  const title = clean(opts.title, MAX_TITLE) || titleCase(words.slice(0, 7).join(" "));
  const language = opts.language || "en";
  const genre = opts.genre || null;
  const styleBible = clean(opts.visualStyle, 600) || "cinematic, natural color, soft depth of field, filmic lighting";
  const targetDuration = Number.isFinite(opts.targetDurationSeconds) ? Math.min(1200, Math.max(6, Math.round(opts.targetDurationSeconds))) : 36;
  const perScene = Number.isFinite(opts.sceneDurationSeconds) ? Math.max(3, Math.round(opts.sceneDurationSeconds)) : 6;
  const beatCount = Math.min(10, Math.max(3, Math.round(targetDuration / perScene)));
  const protagonist = clean(opts.protagonist, 80) || titleCase(words.slice(0, 2).join(" ")) || "The traveler";
  const characters = Array.isArray(opts.characters) && opts.characters.length ? opts.characters
    : [{ name: protagonist, description: `The central figure of "${title}", consistent in appearance across every scene.` }];
  const synopsis = `${title}: ${seed}. A short ${genre ? genre + " " : ""}piece told across ${beatCount} scenes with a consistent look.`.slice(0, MAX_SYNOPSIS);
  const ARC = ["Opening", "Inciting moment", "Rising tension", "Turn", "Crisis", "Climax", "Falling action", "Resolution", "Reflection", "Closing image"];
  const beats = Array.from({ length: beatCount }, (_, i) => {
    const stage = ARC[Math.min(i, ARC.length - 1)];
    return {
      heading: `Scene ${i + 1} - ${stage}`,
      narration: `${stage}: ${seed}`.slice(0, 600),
      visual: `${stage} of "${title}". ${seed}. ${styleBible}.`.slice(0, 600)
    };
  });
  return validateStory({ title, synopsis, language, genre, styleBible, characters, beats });
}

// createStoryDraft is the pluggable seam: mode 'PASTED' | 'IDEA' (local, always available). A future
// 'GROK' text adapter can be added here behind the same return shape.
export function createStoryDraft({ mode, text, idea, ...opts } = {}) {
  if (mode === "PASTED") return parsePastedStory(text, opts);
  if (mode === "IDEA") return draftStoryFromIdea(idea, opts);
  throw err("E_STORY_MODE", "mode must be PASTED or IDEA");
}
