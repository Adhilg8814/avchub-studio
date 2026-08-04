// P0 Step 5C.10 — movie control plane (facade). Story-to-Movie orchestration.
//
// The single source of truth for movie projects/scenes (movie_projects/movie_scenes, migration
// 0018). It REUSES the frozen 5C.9E generation control plane for scene video (each scene = ONE
// generation request/attempt/job/offer) — NEVER a second generation system — and pure lib/movie
// logic for story + scene planning. Assembly (ffmpeg) is INJECTED so control-plane/src stays free
// of media-binary imports; the local runtime provides the assembler + owner media root. PostgreSQL
// is authoritative; restart-safety comes from re-reading the durable state.

import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { stat, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { movieRepository as repo } from "../persistence/repositories/movie-repository.mjs";
import { resolveWithinOrNull, isWithin } from "../../../lib/ops/canonical-path.mjs";
import { planDurationBudget, verifyAgainstMeasured, subtitlesFromPlan, DURATION_ERRORS } from "../../../lib/movie/duration-budget.mjs";
import { assessVoiceCapability, assertVoiceAllowed, voiceAuditRecord, describeCapability, normalizeLocale, VOICE_CAPABILITY } from "../../../lib/movie/voice-capability.mjs";
import { certifyMaster, VERTICAL_720P } from "../../../lib/movie/media-master.mjs";
import { SOURCE_POLICY } from "../../../lib/media/asset-policy.mjs";
import { movieArtifactRepository as arepo, ARTIFACT_KIND, CREATOR } from "../persistence/repositories/movie-artifact-repository.mjs";
import { newId as newArtifactId_ } from "../persistence/ids.mjs";
const newArtifactId = () => newArtifactId_("art");
const newRepairId = () => newArtifactId_("msr");
import {
  gateAdaptation, buildCanonicalTimeline, buildVerifiedSubtitles, buildVerifiedShotPlan, gateTranscript, gateSources,
  planShotRepairs, nextStage, PIPELINE_ERRORS, PIPELINE_STAGE, REPAIR_POLICY
} from "../../../lib/movie/content-pipeline.mjs";
import { buildAdaptation, buildShotPrompt, ADAPTATION_FORMATS } from "../../../lib/movie/adaptation-contract.mjs";
import { verifyTranscript, TRANSCRIPT_VERDICT } from "../../../lib/movie/transcript-verification.mjs";
import { judgeShot, visionArtifactBody, visionIdempotencyKey, VISION_ERRORS } from "../../../lib/movie/scene-vision-runner.mjs";
import { refineShotPrompt } from "../../../lib/movie/vision-judge.mjs";
import { measureAudio } from "../../../lib/movie/source-audio-probe.mjs";
import { classifySourceAudio, SOURCE_AUDIO_CLASS, needsTranscript } from "../../../lib/movie/source-audio-class.mjs";
import { matchNarration, NARRATION_VERDICT } from "../../../lib/movie/narration-match.mjs";
import { decideSceneAudio, decideMovieAudio, subtitleSourceFor, ttsSavings, applyFilmDecision, AUDIO_POLICY, AUDIO_DECISION, NARRATION_SOURCE } from "../../../lib/movie/audio-source-policy.mjs";
import { VISION_VERDICT } from "../../../lib/movie/vision-judge.mjs";
import { buildMovieScorecard, MOVIE_STATE, FLOORS } from "../../../lib/movie/movie-scorecard.mjs";
import { asGate } from "../../../lib/protocol/generation-execution-gate.mjs";
import { contentRepository as crepo } from "../persistence/repositories/content-repository.mjs";
import { createStoryDraft, validateStory, assertNoSecret } from "../../../lib/movie/story.mjs";
import { planScenes } from "../../../lib/movie/scene-planner.mjs";
import { buildSrt, parseSrtCues } from "../../../lib/movie/subtitles.mjs";
import { storyPromptHash, buildStoryPrompt } from "../../../lib/movie/text-provider.mjs";
import { buildPublishingPackage, sha256File } from "../../../lib/movie/package-builder.mjs";
import { PUBLISH_AUDIENCES } from "../../../lib/movie/publisher-provider.mjs";

function cpErr(code, message) { return Object.assign(new Error(message), { code }); }
const MOV = /^mov_[0-9A-HJKMNP-TV-Z]{26}$/u;
const MSC = /^msc_[0-9A-HJKMNP-TV-Z]{26}$/u;

// Map a 5C.9E generation projection state → a scene state.
function sceneStateFromGeneration(genState) {
  switch (genState) {
    case "COMPLETED": return "COMPLETED";
    case "SUBMIT_UNCERTAIN": return "UNCERTAIN";
    case "FAILED_PRE_SUBMIT": case "CANCELLED_BEFORE_SUBMIT": return "FAILED";
    case "SUBMITTED": case "PROCESSING": case "READY_TO_SUBMIT": case "PREPARING": case "QUEUED": case "WAITING_FOR_ACCOUNT": return "GENERATING";
    default: return "GENERATING";
  }
}

// 5C.11 Content Studio deps (all optional; endpoints degrade with a clear error when absent):
// speech = SpeechProvider (listVoices/synthesize), textProviders = { LOCAL, GROK_CHAT? }, and
// publishers = { PACKAGE?, FACEBOOK? } built on lib/movie/publisher-provider.mjs.
export function createMovieControlPlane({ persistence, config, generation, assembler = null, ownerMediaRoot = null, speech = null, textProviders = null, publishers = null, now = () => Date.now(), tenantGuard = null, executionGate = null,
  // 5C.37 — decode the finished master and measure it, instead of reading a size off the container header.
  // Defaults ON: a gate that ships disabled is a gate nobody is holding. Off only for suites that render
  // synthetic clips whose picture is not the thing under test.
  masteringEnabled = true,
  // 5C.38 — default NATIVE_720P_REQUIRED. A workspace may opt into upscaled footage; it is then labelled
  // UPSCALED everywhere and never NATIVE.
  sourcePolicy = SOURCE_POLICY.NATIVE_720P_REQUIRED,
  // 5C.39 — the content-alignment pipeline. Behind a flag for the staged rollout: with it off the movie
  // pipeline behaves exactly as it did before, which is what makes the 9 existing movies safe to leave alone.
  contentAlignmentEnabled = true,
  // 5C.40 — the SAME Grok Chat actuator the story factory holds. Injected rather than constructed here: there
  // is one Grok Chat capability on this runtime and this must not become a second way to reach it.
  visionActuator = null,
  // 5C.36 — what the runtime knows about the voices it can actually use. The catalogue lets a voice PROVE
  // it is native; the resolver turns an opaque provider voice id into the name that identifies it. Both are
  // optional, and their absence makes a voice UNKNOWN — which is reported as a fallback, never as native.
  voiceCatalogue = null, resolveVoiceName = null ,
  // 5C.46 - the local ear. Absent it, every clip reads as UNMEASURED and ElevenLabs is kept, which is
  // the safe behaviour rather than a degraded one.
  stt = null
} = {}) {
  // P0 Step 5C.29 Phase 0 — maintenance pause: every method below that can reach a PROVIDER (Grok scene video,
  // Grok-chat story text, ElevenLabs narration, Facebook publish) or that DRIVES the auto-pipeline refuses with
  // E_GENERATION_EXECUTION_PAUSED. Reads, edits, subtitles, timeline, packaging and render stay untouched here —
  // only provider-reaching + auto-scheduling paths are gated, and no durable state is modified by the refusal.
  const execGate = asGate(executionGate);
  if (!persistence || typeof persistence.tenantTransaction !== "function") throw new TypeError("createMovieControlPlane requires a persistence adapter");
  if (!generation || typeof generation.enqueue !== "function") throw new TypeError("createMovieControlPlane requires the 5C.9E generation facade");
  const ws = config?.stagingApi?.workspaceId;
  if (typeof ws !== "string" || !/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(ws)) throw cpErr("E_MOVIE_WORKSPACE", "A configured staging workspace is required");
  const tx = (fn, opts) => persistence.tenantTransaction(ws, fn, opts);
  const reject = (code, message) => ({ __reject: { code, message } });
  async function txReject(fn, opts) { const out = await tx(fn, opts); if (out && out.__reject) throw cpErr(out.__reject.code, out.__reject.message); return out; }

  async function ensureWs() { await generation.ensureBootstrap(); } // seeds workspace + owner + worker/project/affinity

  // ---------------------------------------------------------------- projects
  async function createProject(input = {}) {
    await ensureWs();
    const title = String(input.title ?? "").trim();
    if (title.length < 1) throw cpErr("E_MOVIE_TITLE", "Project title is required");
    return tx(async (client) => {
      // P0 Step 5C.29 Phase 8 — customer lifecycle + max_active_movies quota (RLS-scoped count, advisory-locked
      // so concurrent creates near the limit serialize). No-op for an unmanaged (existing-owner) workspace.
      if (tenantGuard) {
        await tenantGuard.assertCanCreateMovie(client, {
          workspaceId: ws,
          countActiveMovies: async (c) => Number((await c.query("SELECT count(*)::int n FROM movie_projects WHERE archived_at IS NULL")).rows[0].n)
        });
      }
      const p = await repo.insertProject(client, ws, {
        title, genre: input.genre ?? null, language: input.language ?? "en",
        targetDurationSeconds: input.targetDurationSeconds ?? 30, aspectRatio: input.aspectRatio ?? "9:16",
        visualStyle: input.visualStyle ?? null, characterBible: input.characterBible ?? null,
        inputMode: input.inputMode === "PASTED" ? "PASTED" : "IDEA",
        idea: input.idea ?? null, pastedStory: input.pastedStory ?? null, source: "UI"
      });
      await repo.appendEvent(client, ws, p.id, { type: "PROJECT_CREATED", detail: { inputMode: p.inputMode } });
      return p;
    });
  }
  async function listProjects(opts = {}) { return tx((client) => repo.listProjects(client, ws, opts)); }
  async function getProject(projectId) { return tx((client) => repo.getProject(client, ws, projectId)); }
  async function updateProject({ projectId, patch, expectedRevision = null }) {
    return txReject(async (client) => {
      const cur = await repo.getProject(client, ws, projectId);
      if (!cur) return reject("E_MOVIE_NOT_FOUND", "Project not found");
      const out = await repo.updateProject(client, ws, projectId, { patch, expectedRevision });
      await repo.appendEvent(client, ws, projectId, { type: "PROJECT_UPDATED", detail: {} });
      return out.row;
    });
  }
  async function archiveProject(projectId) {
    return txReject(async (client) => {
      const cur = await repo.getProject(client, ws, projectId);
      if (!cur) return reject("E_MOVIE_NOT_FOUND", "Project not found");
      await repo.archiveProject(client, ws, projectId);
      await repo.appendEvent(client, ws, projectId, { type: "PROJECT_ARCHIVED", detail: {} });
      return { archived: true };
    });
  }

  // ---------------------------------------------------------------- story
  // Draft a story from the project's idea/pasted text (local, provider-free) — the user then edits.
  async function draftStory({ projectId, mode = null } = {}) {
    return txReject(async (client) => {
      const p = await repo.getProject(client, ws, projectId);
      if (!p) return reject("E_MOVIE_NOT_FOUND", "Project not found");
      const useMode = mode || p.inputMode || "IDEA";
      let story;
      try {
        story = createStoryDraft({
          mode: useMode, idea: p.idea, text: p.pastedStory,
          language: p.language, genre: p.genre, visualStyle: p.visualStyle,
          targetDurationSeconds: p.targetDurationSeconds, characters: p.characterBible || undefined
        });
      } catch (e) { return reject(e.code || "E_MOVIE_STORY_DRAFT", e.message || "Could not draft the story"); }
      await repo.updateProject(client, ws, projectId, { patch: { story, synopsis: story.synopsis, visualStyle: story.styleBible, characterBible: story.characters, status: "STORY_READY" } });
      await repo.appendEvent(client, ws, projectId, { type: "STORY_DRAFTED", detail: { mode: useMode, characters: story.characters.length, beats: story.beats.length } });
      return story;
    });
  }
  // Persist an edited story (validated) — the user's authoritative version.
  async function setStory({ projectId, story }) {
    return txReject(async (client) => {
      const p = await repo.getProject(client, ws, projectId);
      if (!p) return reject("E_MOVIE_NOT_FOUND", "Project not found");
      let valid;
      try { valid = validateStory(story); } catch (e) { return reject(e.code || "E_MOVIE_STORY_INVALID", e.message); }
      await repo.updateProject(client, ws, projectId, { patch: { story: valid, synopsis: valid.synopsis, visualStyle: valid.styleBible, characterBible: valid.characters, status: "STORY_READY" } });
      await repo.appendEvent(client, ws, projectId, { type: "STORY_SET", detail: { beats: valid.beats.length } });
      return valid;
    });
  }

  // ---------------------------------------------------------------- storyboard (scenes)
  async function planStoryboard({ projectId } = {}) {
    return txReject(async (client) => {
      const p = await repo.getProject(client, ws, projectId);
      if (!p) return reject("E_MOVIE_NOT_FOUND", "Project not found");
      if (!p.story) return reject("E_MOVIE_NO_STORY", "Draft or set a story before planning the storyboard");
      const planned = planScenes(p.story, { aspectRatio: p.aspectRatio, targetDurationSeconds: p.targetDurationSeconds, sceneDurationSeconds: 6 });
      const scenes = await repo.replaceScenes(client, ws, projectId, planned);
      await repo.updateProject(client, ws, projectId, { patch: { status: "STORYBOARD_READY" } });
      await repo.appendEvent(client, ws, projectId, { type: "STORYBOARD_PLANNED", detail: { scenes: scenes.length } });
      return scenes;
    });
  }
  /**
   * P0 Step 5C.48 — the adaptation stage. The decision about what this film IS, taken once, on the record.
   *
   * Everything downstream has been reading an ADAPTATION artifact since 5C.39 and no code has ever written
   * one, so every film's story dimensions were UNMEASURED and the shot prompts came from a storyboard that
   * had sampled the story rather than adapted it.
   *
   * ONE provider invocation, through the same TextGenerationProvider contract the story writer uses, with the
   * submit fact recorded before the send — so a crash after it is UNCERTAIN and never re-sent. Then the
   * pre-spend gate runs: structure, facts against the source story, length against the target duration,
   * locale, filler. Refusing here costs nothing; refusing after narration costs the quota.
   *
   * The scenes are written FROM the beats, one per beat, replacing any storyboard. A film that generated more
   * scenes than the adaptation has beats is a film paying for shots nothing asked for.
   */
  async function adaptMovieContent({ projectId, provider = "GROK_CHAT", format = "SHORT_FORM_3BEAT", beatCount = 3,
    // Stated by the caller, never inferred: a film narrated in a language its source story was not written in
    // is a decision, and the reason belongs in the artifact rather than in whoever remembers making it.
    sourceLocale = null, localeRationale = "", force = false } = {}) {
    execGate.assertRunning("adaptMovieContent");
    await ensureWs();
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const existing = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.ADAPTATION }));
    if (existing && !force) {
      return Object.freeze({ projectId, idempotent: true, artifactId: existing.id, revision: existing.revision, beats: (existing.body.beatSheet || []).length });
    }
    const fullText = String(project.pastedStory || "").trim() || storyProseFrom(project.story);
    if (fullText.length < 200) throw cpErr("E_MOVIE_ADAPTATION_SOURCE_REQUIRED", "this project has no story prose to adapt");
    // A three-thousand-word story does not fit in one prompt, and truncating it takes the ENDING away — which
    // is exactly the beat the film needs for its payoff. So a long story is excerpted from both ends, with the
    // cut stated, rather than cut off.
    const storyText = fullText.length <= 6800 ? fullText
      : `${fullText.slice(0, 4300)}\n\n[...the middle of the story is omitted for length...]\n\n${fullText.slice(-2400)}`;

    const provKey = provider === "LOCAL" ? "LOCAL" : "GROK_CHAT";
    const tp = textProviders && textProviders[provKey] ? textProviders[provKey] : null;
    if (!tp || typeof tp.adaptStory !== "function" || !tp.available()) {
      throw cpErr("E_MOVIE_TEXT_PROVIDER_UNAVAILABLE", `the ${provKey} adaptation provider is not available on this runtime`);
    }
    const locale = normalizeLocale(project.language) || "en-US";
    const srcLocale = normalizeLocale(sourceLocale || "") || null;
    const names = [project.story?.protagonist, ...((project.story?.antagonistList || []).map((a) => a && a.name))]
      .filter((x) => typeof x === "string" && x.trim().length > 1);
    const brief = {
      storyText, title: project.title, locale, languageName: project.language,
      targetDurationSeconds: project.targetDurationSeconds, beatCount, characterNames: names
    };

    // The durable submit fact rides on the same ledger the story writer uses: one attempt row, one reserved
    // invocation, consumed at the submit.
    const attempt = await tx(async (client) => {
      const a = await crepo.insertStoryAttempt(client, ws, { movieProjectId: projectId, provider: provKey, promptHash: `sha256:${sha256Text(`adaptation|${projectId}|${format}|${beatCount}|${sha256Text(storyText)}`)}` });
      await crepo.reserveStoryInvocation(client, ws, a.id);
      await crepo.updateStoryAttempt(client, ws, a.id, { patch: { state: "RUNNING" } });
      await repo.appendEvent(client, ws, projectId, { type: "ADAPTATION_STARTED", detail: { provider: provKey, format, beats: beatCount } });
      return a;
    });
    const onBeforeSubmit = async () => {
      await tx(async (client) => {
        await crepo.updateStoryAttempt(client, ws, attempt.id, { patch: { submitState: "SUBMITTED" } });
        await crepo.consumeStoryInvocation(client, ws, attempt.id);
      });
    };
    let out;
    try {
      out = await tp.adaptStory(brief, { onBeforeSubmit });
    } catch (e) {
      const row = await tx((client) => crepo.getStoryAttempt(client, ws, attempt.id));
      const submitted = Boolean(row && row.submitState === "SUBMITTED");
      await tx(async (client) => {
        await crepo.updateStoryAttempt(client, ws, attempt.id, { patch: submitted
          ? { state: "UNCERTAIN", submitState: "UNCERTAIN", errorCode: e.code || "E_MOVIE_ADAPTATION_UNCERTAIN" }
          : { state: "FAILED", errorCode: e.code || "E_MOVIE_ADAPTATION_FAILED" } });
        await repo.appendEvent(client, ws, projectId, { type: submitted ? "ADAPTATION_UNCERTAIN" : "ADAPTATION_FAILED", detail: { provider: provKey, code: e.code || null } });
      });
      throw cpErr(e.code || "E_MOVIE_ADAPTATION_FAILED", submitted
        ? "the adaptation request outcome is uncertain; it will NOT be retried automatically"
        : (e.message || "the adaptation failed"));
    }

    const d = out.adaptation;
    const narrationScript = d.beats.map((b) => b.narration).join(" ");
    let adaptation;
    try {
      adaptation = buildAdaptation({
        sourceStoryId: project.id, targetDurationSeconds: project.targetDurationSeconds, locale, format,
        sourceLocale: srcLocale && srcLocale !== locale ? srcLocale : null,
        localeRationale: srcLocale && srcLocale !== locale
          ? (String(localeRationale || "").trim() || "the narration language was chosen for the film, not inherited from the source story")
          : "",
        audience: d.audience, tone: d.tone || project.tone || "", hook: d.hook, narrativeObjective: d.narrativeObjective,
        narrationScript,
        // Each beat keeps the place the model put it in. buildLocationBible assigns ids in array order, so the
        // model's location NAME resolves to an id — and dropping it (which this did) sends every shot to
        // locations[0]: a letter read in a hallway prompted as the municipal meeting room of the first beat.
        beatSheet: d.beats.map((b) => {
          const idx = (d.locations || []).findIndex((l) => l.name && String(l.name).toLowerCase() === String(b.location || "").toLowerCase());
          return { role: b.role, summary: b.summary, narration: b.narration, emotionalBeat: b.emotionalBeat,
            locationId: idx >= 0 ? `loc_${String(idx).padStart(2, "0")}` : null, characterIds: [] };
        }),
        characters: d.characters, locations: d.locations, style: { ...d.style, aspectRatio: project.aspectRatio }
      });
    } catch (e) {
      await tx(async (client) => {
        await crepo.updateStoryAttempt(client, ws, attempt.id, { patch: { state: "FAILED", errorCode: e.code || "E_MOVIE_ADAPTATION_INVALID" } });
        await repo.appendEvent(client, ws, projectId, { type: "ADAPTATION_REJECTED", detail: { code: e.code || null, reason: String(e.message || "").slice(0, 200) } });
      });
      throw cpErr(e.code || "E_MOVIE_ADAPTATION_INVALID", e.message);
    }

    // The gate that decides whether this is worth spending on. Its verdict is stored WITH the adaptation, so
    // the scorecard reads a validated artifact rather than re-deriving the judgement.
    const gate = gateAdaptation({ adaptation, story: project.story, targetDurationSeconds: project.targetDurationSeconds, locale });
    if (!gate.ok) {
      await tx(async (client) => {
        await crepo.updateStoryAttempt(client, ws, attempt.id, { patch: { state: "FAILED", errorCode: gate.code || PIPELINE_ERRORS.ADAPTATION_REJECTED } });
        await repo.appendEvent(client, ws, projectId, { type: "ADAPTATION_REJECTED", detail: { failures: gate.failures.slice(0, 6), words: gate.words, wordsPerSecond: gate.wordsPerSecond } });
      });
      throw cpErr(gate.code || PIPELINE_ERRORS.ADAPTATION_REJECTED, `the adaptation was refused before anything was spent: ${gate.failures.join("; ")}`);
    }

    const written = await tx(async (client) => {
      const a = await arepo.putArtifact(client, ws, {
        id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.ADAPTATION,
        body: { ...adaptation, gate: { ok: true, words: gate.words, wordsPerSecond: gate.wordsPerSecond, roles: gate.roles, warnings: gate.warnings } },
        creator: CREATOR.SYSTEM, provider: provKey,
        providerAttemptId: attempt.id
      });
      await crepo.updateStoryAttempt(client, ws, attempt.id, { patch: { state: "COMPLETED", submitState: "SUBMITTED", responseHash: `sha256:${sha256Text(JSON.stringify(d))}`, providerResultRef: out.providerResultRef ?? null } });
      // One scene per beat. The visual is the beat's own filmable line; the prompt is replaced later by the
      // shot contract, which can only be cut once the narration has a measured length.
      const planned = d.beats.map((b, i) => ({
        heading: `${b.role}`, narration: b.narration, visualDescription: b.visual,
        videoPrompt: b.visual, durationSeconds: null, aspectRatio: project.aspectRatio,
        continuity: { beat: i, role: b.role }
      }));
      const scenes = await repo.replaceScenes(client, ws, projectId, planned);
      await repo.updateProject(client, ws, projectId, { patch: { synopsis: adaptation.narrativeObjective || project.synopsis, visualStyle: adaptation.styleBible.visualGenre, status: "STORYBOARD_READY" } });
      await repo.appendEvent(client, ws, projectId, { type: "ADAPTATION_COMPLETED", detail: {
        provider: provKey, format, beats: adaptation.beatSheet.length, roles: gate.roles,
        words: gate.words, wordsPerSecond: gate.wordsPerSecond, scenes: scenes.length,
        locale, sourceLocale: adaptation.sourceLocale
      } });
      return { artifact: a.artifact, scenes };
    });

    return Object.freeze({
      projectId, idempotent: false, provider: provKey, format,
      artifactId: written.artifact.id, revision: written.artifact.revision,
      beats: adaptation.beatSheet.map((b) => ({ beatId: b.beatId, role: b.role, words: (b.narration.match(/[\p{L}\p{N}]+/gu) || []).length })),
      scenes: written.scenes.length, words: gate.words, wordsPerSecond: gate.wordsPerSecond,
      hook: adaptation.hook, locale, sourceLocale: adaptation.sourceLocale
    });
  }

  // The story prose a movie project holds. A pasted story is the prose itself; a drafted one keeps its beats.
  function storyProseFrom(story) {
    if (!story) return "";
    const beats = Array.isArray(story.beats) ? story.beats : [];
    return [story.synopsis || "", ...beats.map((b) => `${b.heading || ""} ${b.narration || ""} ${b.visual || ""}`.trim())]
      .filter(Boolean).join("\n").trim();
  }

  async function listScenes(projectId) { return tx((client) => repo.listScenes(client, ws, projectId)); }
  async function updateScene({ sceneId, patch, expectedRevision = null }) {
    return txReject(async (client) => {
      const cur = await repo.getScene(client, ws, sceneId);
      if (!cur) return reject("E_MOVIE_SCENE_NOT_FOUND", "Scene not found");
      if (["QUEUED", "GENERATING", "COMPLETED"].includes(cur.state) && (patch.videoPrompt !== undefined || patch.durationSeconds !== undefined)) return reject("E_MOVIE_SCENE_LOCKED", "Cannot edit a scene that is generating or complete");
      const out = await repo.updateScene(client, ws, sceneId, { patch, expectedRevision });
      return out.row;
    });
  }
  async function deleteScene({ sceneId }) {
    return txReject(async (client) => {
      const out = await repo.deleteScene(client, ws, sceneId);
      if (!out.deleted) return reject("E_MOVIE_SCENE_LOCKED", "Only planned/failed scenes can be deleted");
      return { deleted: true };
    });
  }

  /**
   * P0 Step 5C.48 — the shot contracts, cut from the audio that exists.
   *
   * This is the stage that makes a shot's LENGTH a consequence of its line rather than a guess: each scene's
   * contract is timed by the measured boundaries of its own narration, so a five-second sentence never gets a
   * three-second picture and no shot starts before its line does.
   *
   * It runs AFTER narration and BEFORE generation, which is the only order in which either fact is available
   * in time to matter — the duration reaches Grok as a request, not as a trim afterwards.
   *
   * Refuses rather than estimating. Without an alignment for every scene there is no timeline, and a shot plan
   * built on an even division is exactly the fabricated clock 5C.39 removed.
   */
  async function planShotContracts({ projectId, force = false } = {}) {
    await ensureWs();
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const adaptationArt = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.ADAPTATION }));
    if (!adaptationArt) throw cpErr(PIPELINE_ERRORS.ADAPTATION_REQUIRED, "shot contracts are cut from an adaptation; this film has none");
    const scenes = (await tx((client) => repo.listScenes(client, ws, projectId))).slice().sort((a, b) => a.ordinal - b.ordinal);
    if (!scenes.length) throw cpErr("E_MOVIE_NO_SCENES", "No scenes to plan");

    const alignments = [];
    for (const sc of scenes) {
      const a = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.AUDIO_ALIGNMENT, sceneId: sc.id }));
      if (!a || !a.body || !a.body.alignment) {
        throw cpErr(PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE, `scene ${sc.ordinal + 1} has no measured narration alignment`);
      }
      alignments.push({
        alignment: a.body.alignment, beatId: sc.id,
        measuredDurationMs: Number.isFinite(a.body.measuredDurationSeconds) ? Math.round(a.body.measuredDurationSeconds * 1000) : null
      });
    }
    const timeline = buildCanonicalTimeline(alignments);
    // One shot per narration segment, checked to cover the timeline: narration with no picture behind it is a
    // black screen with a voice over it.
    const plan = buildVerifiedShotPlan({
      timeline, adaptation: adaptationArt.body,
      defaults: { minimumSourceHeight: 1280 }
    });

    // The plan's shots are keyed to segments; each segment carries the scene it was built from.
    const bySegment = new Map(timeline.segments.map((s) => [s.segmentId, s]));
    const adaptation = adaptationArt.body;
    const written = [];
    for (const sc of scenes) {
      const shots = plan.shots.filter((sh) => {
        const seg = bySegment.get(sh.narrationSegmentId);
        return seg && seg.associatedBeatId === sc.id;
      });
      if (!shots.length) throw cpErr(PIPELINE_ERRORS.SHOTS_DO_NOT_COVER, `scene ${sc.ordinal + 1} ended up with no shot`);

      // One clip per scene. The planner cuts one shot per SENTENCE, so a two-sentence beat arrives here as two
      // shots of the same scene; they are merged into a single contract spanning the scene's whole audio and
      // the prompt is rebuilt from the merged line. Taking the first shot's prompt instead would ask for a
      // picture that matches half of what the viewer hears.
      const first = shots[0], last = shots[shots.length - 1];
      const mergedText = shots.map((s) => s.narrationText).join(" ");
      const beat = adaptation.beatSheet[Number(sc.continuity && sc.continuity.beat) >= 0 ? Number(sc.continuity.beat) : sc.ordinal] || null;
      const present = (adaptation.characterBible.characters || []).filter((c) => c.canonicalName && mergedText.includes(c.canonicalName));
      const locs = adaptation.locationBible.locations || [];
      const loc = locs.find((l) => l.name && mergedText.includes(l.name))
        || (beat && locs.find((l) => l.locationId === beat.locationId)) || locs[0] || null;
      const sh = shots.length === 1 ? first : Object.freeze({
        ...first,
        startMs: first.startMs, endMs: last.endMs, expectedDurationMs: last.endMs - first.startMs,
        narrationText: mergedText, semanticIntent: mergedText,
        generationPrompt: buildShotPrompt({ text: mergedText, present, loc, style: adaptation.styleBible, beat }),
        mergedShotIds: shots.map((s) => s.shotId), mergedSegmentIds: shots.map((s) => s.narrationSegmentId)
      });

      const existing = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId: sc.id }));
      if (existing && !force) { written.push({ sceneId: sc.id, revision: existing.revision, idempotent: true, durationSeconds: existing.body.durationSeconds ?? null }); continue; }
      const durationSeconds = Number((sh.expectedDurationMs / 1000).toFixed(3));
      const body = {
        ...sh,
        // The number generateScene reads. Stated in seconds because that is what the provider's control asks
        // for, and stated HERE because the audio is the only thing that knows it.
        durationSeconds,
        adaptationRevision: adaptationArt.revision,
        narrationSource: NARRATION_SOURCE.ELEVENLABS
      };
      const art = await tx(async (client) => {
        const a = await arepo.putArtifact(client, ws, {
          id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId: sc.id,
          body, creator: CREATOR.SYSTEM,
          sourceKind: ARTIFACT_KIND.ADAPTATION, sourceArtifactId: adaptationArt.id, sourceRevision: adaptationArt.revision
        });
        // The scene row carries the same words, so the UI and the assembler agree with the artifact instead of
        // holding the storyboard's guess. Its duration column is an INTEGER, so it rounds UP: the contract
        // keeps the measured length to the millisecond, and a scene row that rounded DOWN would describe a
        // shot shorter than the line spoken over it.
        await repo.updateScene(client, ws, sc.id, { patch: {
          videoPrompt: sh.generationPrompt, visualDescription: sh.semanticIntent,
          durationSeconds: Math.max(1, Math.min(30, Math.ceil(durationSeconds)))
        } });
        return a.artifact;
      });
      written.push({ sceneId: sc.id, revision: art.revision, idempotent: false, durationSeconds, expectedDurationMs: sh.expectedDurationMs });
    }
    await tx((client) => repo.appendEvent(client, ws, projectId, { type: "SHOT_CONTRACTS_PLANNED", detail: {
      scenes: written.length, timelineMs: timeline.endMs - timeline.startMs,
      durations: written.map((w) => w.durationSeconds)
    } }));
    return Object.freeze({ projectId, shots: Object.freeze(written), timelineMs: timeline.endMs - timeline.startMs, filmSeconds: Number(((timeline.endMs - timeline.startMs) / 1000).toFixed(3)) });
  }

  // ---------------------------------------------------------------- scene generation (via 5C.9E)
  // Each scene becomes ONE generation job through the frozen pipeline. A scene that is already
  // generating/completed is not re-run; a FAILED scene can start a NEW attempt (history is kept via
  // attempt_count). No executor is ever called here — the Worker's 5C.9E claim loop does the work.
  async function generateScene({ sceneId }) {
    execGate.assertRunning("generateScene");
    await ensureWs();
    const scene = await tx((client) => repo.getScene(client, ws, sceneId));
    if (!scene) throw cpErr("E_MOVIE_SCENE_NOT_FOUND", "Scene not found");
    if (["QUEUED", "GENERATING", "COMPLETED"].includes(scene.state)) return { sceneId, state: scene.state, idempotent: true };

    // P0 Step 5C.42 — the length comes from the ACTIVE shot contract when there is one.
    //
    // The contract is the revision the judge assessed and the repair rewrote, so it is the only place that
    // knows how long THIS attempt's shot is meant to be. A regeneration reading the scene row instead would
    // silently re-use the length that belonged to the clip being replaced, and a contract revision that
    // shortens a shot would never take effect.
    const contract = await tx((client) => arepo.getActive(client, ws, { movieProjectId: scene.movieProjectId, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId }));
    const contractSeconds = contract && contract.body ? Number(contract.body.durationSeconds) : NaN;
    const durationSeconds = Number.isFinite(contractSeconds) && contractSeconds > 0 ? contractSeconds : scene.durationSeconds;
    const durationSource = Number.isFinite(contractSeconds) && contractSeconds > 0 ? "SHOT_CONTRACT" : "SCENE";

    // P0 Step 5C.48 — the PROMPT comes from the active shot contract too.
    //
    // The contract is the revision the judge assessed and the repair rewrote. Reading the scene row instead
    // made a targeted repair work only by side effect: it had to write the refined prompt onto the scene
    // first, and any path that touched scene.videoPrompt afterwards would silently regenerate the shot from
    // words no contract revision ever contained. Now the artifact is the source and the scene row is a cache.
    const contractPrompt = contract && contract.body && typeof contract.body.generationPrompt === "string"
      ? contract.body.generationPrompt.trim() : "";
    const prompt = contractPrompt || scene.videoPrompt;
    const promptSource = contractPrompt ? "SHOT_CONTRACT" : "SCENE";
    const promptSha256 = `sha256:${sha256Text(String(prompt || ""))}`;

    // Create the generation job via the 5C.9E facade (its own transactions), then link it.
    const job = await generation.enqueue({ prompt, durationSeconds, aspectRatio: scene.aspectRatio });
    await generation.requestStart({ jobId: job.jobId });
    return tx(async (client) => {
      await repo.updateScene(client, ws, sceneId, { patch: { generationJobId: job.jobId, generationAttemptId: job.generationAttemptId, state: "QUEUED", errorCode: null, incrementAttempt: true } });
      await repo.appendEvent(client, ws, scene.movieProjectId, { type: "SCENE_GENERATION_STARTED", detail: { ordinal: scene.ordinal, jobId: job.jobId, durationSeconds, durationSource, promptSource, promptSha256, shotContractRevision: contract ? contract.revision : null } });
      await repo.updateProject(client, ws, scene.movieProjectId, { patch: { status: "GENERATING" } });
      return { sceneId, jobId: job.jobId, generationAttemptId: job.generationAttemptId, state: "QUEUED",
               durationSeconds, durationSource, promptSource, promptSha256,
               shotContractId: contract ? contract.id : null, shotContractRevision: contract ? contract.revision : null };
    });
  }
  async function generateAllScenes({ projectId }) {
    execGate.assertRunning("generateAllScenes");
    const scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    const started = [];
    for (const s of scenes) if (!["QUEUED", "GENERATING", "COMPLETED"].includes(s.state)) { try { started.push(await generateScene({ sceneId: s.id })); } catch { /* per-scene best effort */ } }
    return { started: started.length };
  }

  // Refresh scene states from the 5C.9E generation projection (durable truth). Copies media + result
  // correlation when a scene's job completes. Never re-runs anything.
  async function refreshScenes({ projectId }) {
    const scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    for (const s of scenes) {
      if (!s.generationJobId || s.state === "COMPLETED") continue;
      let gen = null;
      try { gen = await generation.getForUi(s.generationJobId); } catch { gen = null; }
      if (!gen) continue;
      const next = sceneStateFromGeneration(gen.state);
      if (next === s.state && s.state !== "COMPLETED") { /* still generating; skip write */ if (next !== "COMPLETED") continue; }
      const patch = { state: next };
      // 5C.43 - copy the whole evidence record, not five numbers. The scene projection has always READ
      // sourceVerdict / providerFallbackSuspected off this object, and this line is where they were being
      // dropped: the movie has never seen what the generation actually measured.
      if (next === "COMPLETED" && gen.hasMedia) {
        const gm = gen.media || {};
        patch.mediaMeta = { ...gm, relativePath: `jobs/${s.generationJobId}/generated.mp4`, sizeBytes: gm.sizeBytes ?? 0, container: gm.container || "mp4" };
        patch.resultId = gen.resultId || null;
      }
      if (next === "UNCERTAIN") patch.errorCode = "E_SCENE_SUBMIT_UNCERTAIN";
      if (next === "FAILED") patch.errorCode = gen.errorCode || "E_SCENE_FAILED";
      await tx(async (client) => { await repo.updateScene(client, ws, s.id, { patch }); if (next !== s.state) await repo.appendEvent(client, ws, projectId, { type: `SCENE_${next}`, detail: { ordinal: s.ordinal } }); });
    }
    return tx((client) => repo.listScenes(client, ws, projectId));
  }

  // ---------------------------------------------------------------- assembly (injected ffmpeg)
  async function assembleMovie({ projectId }) {
    await ensureWs();
    if (!assembler || !ownerMediaRoot) throw cpErr("E_MOVIE_ASSEMBLER_UNAVAILABLE", "Assembly is not configured on this runtime");
    const scenes = await refreshScenes({ projectId });
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const ordered = scenes.slice().sort((a, b) => a.ordinal - b.ordinal);
    if (ordered.length === 0) throw cpErr("E_MOVIE_NO_SCENES", "No scenes to assemble");
    const incomplete = ordered.filter((s) => s.state !== "COMPLETED" || !s.mediaMeta);
    if (incomplete.length) throw cpErr("E_MOVIE_SCENES_INCOMPLETE", `${incomplete.length} scene(s) are not completed yet`);
    const clips = ordered.map((s) => ({ path: path.join(ownerMediaRoot, s.mediaMeta.relativePath.split("/").join(path.sep)), narration: s.narration || s.heading || "", heading: s.heading || "", durationSeconds: s.durationSeconds }));
    for (const c of clips) if (!existsSync(c.path)) throw cpErr("E_MOVIE_CLIP_MISSING", "A completed scene's clip file is missing");

    await tx(async (client) => { await repo.updateProject(client, ws, projectId, { patch: { status: "ASSEMBLING" } }); await repo.appendEvent(client, ws, projectId, { type: "ASSEMBLY_STARTED", detail: { scenes: clips.length } }); });
    const outDir = path.join(ownerMediaRoot, "movies", projectId);
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, "final.mp4");
    let result;
    try {
      result = await assembler.assemble({ clips, workDir: path.join(outDir, "work"), outputPath: outPath, title: project.title, aspectRatio: project.aspectRatio });
    } catch (e) {
      await tx(async (client) => { await repo.updateProject(client, ws, projectId, { patch: { status: "FAILED" } }); await repo.appendEvent(client, ws, projectId, { type: "ASSEMBLY_FAILED", detail: { code: e.code || "E_ASSEMBLE" } }); });
      throw cpErr(e.code || "E_MOVIE_ASSEMBLY_FAILED", "Movie assembly failed");
    }
    const finalMedia = { relativePath: `movies/${projectId}/final.mp4`, sizeBytes: result.sizeBytes, container: "mp4", durationSeconds: result.durationSeconds, width: result.width, height: result.height, sceneCount: result.sceneCount, hasSubtitles: result.hasSubtitles };
    await tx(async (client) => { await repo.updateProject(client, ws, projectId, { patch: { finalMedia, status: "COMPLETED" } }); await repo.appendEvent(client, ws, projectId, { type: "MOVIE_COMPLETED", detail: { sizeBytes: result.sizeBytes, sceneCount: result.sceneCount } }); });
    return finalMedia;
  }

  // Resolve the final movie file for streaming (traversal-guarded), mirroring the generation media path.
  async function finalMediaFor(projectId) {
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project || !project.finalMedia || !ownerMediaRoot) return null;
    const abs = resolveWithinOrNull(ownerMediaRoot, project.finalMedia.relativePath, { followLinks: true });
    if (!abs) return null;
    try { const info = await stat(abs); if (!info.isFile() || info.size <= 0) return null; return { path: abs, sizeBytes: info.size, contentType: "video/mp4" }; } catch { return null; }
  }

  // ================================================================ 5C.11 Content Studio
  const sha256Text = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");
  const newTempId = () => randomBytes(12).toString("hex");
  // Owner-tree path resolution. Containment is decided by the canonical helper, not by a string prefix:
  // a prefix compare is wrong on separators (a root written "E:/x\\y" prefixes nothing that path.join
  // produces, so every clip is rejected and reported as MISSING), wrong on a sibling that merely shares a
  // name ("generated-media-old"), and wrong on Windows casing.
  function absOwner(rel, { followLinks = false } = {}) {
    return resolveWithinOrNull(ownerMediaRoot, rel, { followLinks });
  }
  async function resolveOwnerFile(rel, contentType, fileName) {
    const abs = absOwner(rel);
    if (!abs) return null;
    try { const info = await stat(abs); if (!info.isFile() || info.size <= 0) return null; return { path: abs, sizeBytes: info.size, contentType, fileName }; } catch { return null; }
  }
  // Effective scene duration after timeline trim (used for subtitle timing previews).
  const effDur = (s) => (Number.isFinite(s.trimOut) && s.trimOut > (Number.isFinite(s.trimIn) ? s.trimIn : 0)
    ? s.trimOut - (Number.isFinite(s.trimIn) ? s.trimIn : 0) : s.durationSeconds);

  // ---------------------------------------------------------------- story via TextGenerationProvider
  // One durable story_text_attempts row per call; its single invocation is RESERVED up front and
  // CONSUMED at the submit fact (network providers) or completion (LOCAL). A submitted-but-unverified
  // outcome terminates as UNCERTAIN and is NEVER retried automatically.
  async function draftStoryViaProvider({ projectId, provider = "LOCAL", mode = null } = {}) {
    execGate.assertRunning("draftStoryViaProvider");
    await ensureWs();
    const p = await tx((client) => repo.getProject(client, ws, projectId));
    if (!p) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const provKey = provider === null || provider === undefined ? "LOCAL" : provider;
    if (!["LOCAL", "GROK_CHAT"].includes(provKey)) throw cpErr("E_MOVIE_TEXT_PROVIDER_UNAVAILABLE", "Unknown story provider");
    const tp = textProviders && textProviders[provKey] ? textProviders[provKey] : null;
    if (!tp || !tp.available()) throw cpErr("E_MOVIE_TEXT_PROVIDER_UNAVAILABLE", `The ${provKey} story provider is not available on this runtime`);
    const brief = {
      mode: mode || p.inputMode || "IDEA", idea: p.idea, pastedStory: p.pastedStory,
      language: p.language, genre: p.genre, visualStyle: p.visualStyle, tone: p.tone, worldBible: p.worldBible,
      targetDurationSeconds: p.targetDurationSeconds, characters: p.characterBible || undefined,
      beatCount: Math.min(10, Math.max(3, Math.round((p.targetDurationSeconds || 30) / 6)))
    };
    const promptHash = provKey === "GROK_CHAT"
      ? storyPromptHash(buildStoryPrompt(brief))
      : storyPromptHash(JSON.stringify({ v: 1, mode: brief.mode, idea: p.idea ?? null, pastedStory: p.pastedStory ?? null }));
    const attempt = await tx(async (client) => {
      const a = await crepo.insertStoryAttempt(client, ws, { movieProjectId: projectId, provider: provKey, promptHash });
      await crepo.reserveStoryInvocation(client, ws, a.id);
      await crepo.updateStoryAttempt(client, ws, a.id, { patch: { state: "RUNNING" } });
      await repo.appendEvent(client, ws, projectId, { type: "STORY_ATTEMPT_STARTED", detail: { provider: provKey } });
      return a;
    });
    // Durable submit fact BEFORE the provider's single irreversible send (network providers only).
    const onBeforeSubmit = async () => {
      await tx(async (client) => {
        await crepo.updateStoryAttempt(client, ws, attempt.id, { patch: { submitState: "SUBMITTED" } });
        await crepo.consumeStoryInvocation(client, ws, attempt.id);
      });
    };
    let out;
    try {
      out = await tp.generateStory(brief, { onBeforeSubmit });
    } catch (e) {
      const row = await tx((client) => crepo.getStoryAttempt(client, ws, attempt.id));
      const submitted = Boolean(row && row.submitState === "SUBMITTED");
      await tx(async (client) => {
        await crepo.updateStoryAttempt(client, ws, attempt.id, {
          patch: submitted
            ? { state: "UNCERTAIN", submitState: "UNCERTAIN", errorCode: e.code || "E_STORY_ATTEMPT_UNCERTAIN" }
            : { state: "FAILED", errorCode: e.code || "E_STORY_ATTEMPT_FAILED" }
        });
        await repo.appendEvent(client, ws, projectId, { type: submitted ? "STORY_ATTEMPT_UNCERTAIN" : "STORY_ATTEMPT_FAILED", detail: { provider: provKey, code: e.code || null } });
      });
      throw cpErr(e.code || "E_MOVIE_STORY_ATTEMPT", submitted ? "The story request outcome is uncertain; it will NOT be retried automatically" : (e.message || "Story generation failed"));
    }
    let valid;
    try { valid = validateStory(out.story); } catch (e) {
      await tx(async (client) => { await crepo.updateStoryAttempt(client, ws, attempt.id, { patch: { state: "FAILED", errorCode: e.code || "E_STORY_INVALID" } }); });
      throw cpErr(e.code || "E_MOVIE_STORY_INVALID", e.message);
    }
    await tx(async (client) => {
      await crepo.consumeStoryInvocation(client, ws, attempt.id); // LOCAL path (no-op after a submit fact)
      await crepo.updateStoryAttempt(client, ws, attempt.id, {
        patch: {
          state: "COMPLETED", submitState: "SUBMITTED", result: valid,
          responseHash: `sha256:${sha256Text(JSON.stringify(valid))}`,
          providerResultRef: out.providerResultRef ?? null
        }
      });
      await repo.updateProject(client, ws, projectId, { patch: { story: valid, synopsis: valid.synopsis, visualStyle: valid.styleBible, characterBible: valid.characters, status: "STORY_READY", textProvider: provKey } });
      await repo.appendEvent(client, ws, projectId, { type: "STORY_ATTEMPT_COMPLETED", detail: { provider: provKey, beats: valid.beats.length } });
    });
    return { attemptId: attempt.id, provider: provKey, story: valid };
  }

  // ---------------------------------------------------------------- narration (SpeechProvider)
  async function listVoices() {
    if (!speech || typeof speech.listVoices !== "function") return [];
    try { return await speech.listVoices(); } catch { return []; }
  }
  // One scene_audio_assets attempt per synthesized scene; a COMPLETED narration whose
  // voice+rate+text are unchanged is reused (skipped), a changed text/voice makes a NEW asset.
  async function generateNarration({ projectId, sceneId = null, voiceId = null, rate = 0, force = false, allowFallbackVoice = false, confirmedFallbackLocales = [], interactive = false } = {}) {
    execGate.assertRunning("generateNarration");
    await ensureWs();
    if (!speech || !ownerMediaRoot) throw cpErr("E_MOVIE_TTS_UNAVAILABLE", "Narration (TTS) is not configured on this runtime");
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");

    // ---- voice capability, decided BEFORE the provider is called ----
    // The old path asked the voice map "which voice for da-DK", got an English one, and synthesised. The
    // question it never asked is whether that voice can speak Danish at all.
    const voiceVerdict = assessMovieVoice({ locale: project.language, voiceId, voiceName: voiceNameFor(voiceId) });
    try {
      assertVoiceAllowed(voiceVerdict, { allowFallbackVoice, confirmedFallbacks: confirmedFallbackLocales, interactive });
    } catch (e) {
      // Nothing has been spent at this point, and nothing will be.
      throw cpErr(e.code || "E_MOVIE_VOICE_UNAVAILABLE", `${describeCapability(voiceVerdict)} ${e.message}`);
    }
    if (voiceVerdict.capability !== VOICE_CAPABILITY.NATIVE) {
      await tx((client) => repo.appendEvent(client, ws, projectId, {
        type: "NARRATION_VOICE_FALLBACK",
        detail: voiceAuditRecord(voiceVerdict, { confirmedBy: interactive ? "OWNER" : (allowFallbackVoice ? "POLICY" : null), policy: { allowFallbackVoice } })
      }));
    }
    const scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    const targets = scenes.filter((s) => (sceneId ? s.id === sceneId : true)).filter((s) => String(s.narration || "").trim());
    if (sceneId && targets.length === 0) throw cpErr("E_MOVIE_SCENE_NOT_FOUND", "Scene not found or it has no narration text");
    if (targets.length === 0) throw cpErr("E_MOVIE_NO_NARRATION_TEXT", "No scene has narration text");

    // ---- what actually gets said (5C.36) ----------------------------------------------------------
    // The budget decides the text, not the storyboard. Synthesising the raw scene text and then trimming
    // the audio is exactly the mid-sentence cut this step exists to remove — and it also wastes a provider
    // call on words that will never be heard. A scene the plan silenced is skipped entirely.
    let plannedText = null;
    try {
      const dp = await planMovieDuration({ projectId });
      plannedText = new Map(dp.scenes.map((x) => [x.ordinal, x.narrationText || ""]));
    } catch (e) {
      // An unsatisfiable budget must not be discovered later, at render time, after the quota is gone.
      if (e && e.code === DURATION_ERRORS.UNSATISFIABLE) throw cpErr(e.code, e.message);
      plannedText = null;   // planning unavailable (no scenes yet): fall back to the storyboard text
    }
    const textFor = (sc) => (plannedText && plannedText.has(sc.ordinal) ? plannedText.get(sc.ordinal) : String(sc.narration || ""));

    const existing = await tx((client) => crepo.listAudioAssets(client, ws, projectId, { kind: "NARRATION" }));

    // P0 Step 5C.45 - listen to the clips BEFORE deciding to pay for a voice.
    //
    // Decided for the whole film in one pass, not per scene inside the loop: the narration source has to be
    // the same in every shot, and that cannot be known while still half way through synthesising.
    let routing = null;
    try { routing = await planMovieAudioRouting({ projectId }); }
    catch { routing = null; }   // a clip that cannot be inspected must not block synthesis: the safe path is to speak
    const grokNarrates = routing && routing.narrationSource === NARRATION_SOURCE.GROK;
    const skippedByRouting = [];

    const done = [], failed = [], skipped = [], alignedScenes = [];
    for (const s of targets) {
      const speakText = textFor(s);
      if (!speakText.trim()) { skipped.push(s.id); continue; }   // the plan gave this shot no line
      const eff = routing ? routing.scenes.find((x) => x.sceneId === s.id) : null;
      if (grokNarrates && eff && eff.sceneActuallySkipped === true) {
        // The clip's own voice reads this line, and the whole film agrees. No provider call is made.
        skippedByRouting.push(s.id);
        await tx((client) => repo.updateScene(client, ws, s.id, { patch: { audioMeta: {
          ...(s.audioMeta || {}),
          narrationSource: NARRATION_SOURCE.GROK, elevenLabsSkipped: true,
          elevenLabsSkipReason: (routing.scenes.find((x) => x.sceneId === s.id) || {}).reason || "the clip's own voice reads the narration",
          spokenText: speakText
        } } }));
        continue;
      }
      const textHash = sha256Text(`${voiceId || ""}|${Number(rate) || 0}|${speakText}`);
      const cur = s.audioMeta;
      if (!force && cur && cur.textHash === textHash && cur.narrationAssetId) {
        const a = existing.find((x) => x.id === cur.narrationAssetId && x.state === "COMPLETED" && x.mediaMeta);
        const abs = a ? absOwner(a.mediaMeta.relativePath) : null;
        if (abs && existsSync(abs)) { skipped.push(s.id); continue; }
      }
      const asset = await tx(async (client) => {
        const a = await crepo.insertAudioAsset(client, ws, { movieProjectId: projectId, sceneId: s.id, kind: "NARRATION", provider: voiceId || speech.kind || "TTS" });
        await crepo.reserveAudioInvocation(client, ws, a.id);
        await crepo.updateAudioAsset(client, ws, a.id, { patch: { state: "GENERATING" } });
        return a;
      });
      const rel = `movies/${projectId}/audio/${asset.id}.wav`;
      try {
        // P0 Step 5C.39 — ask for the timestamps. /with-timestamps is the SAME synthesis as the plain
        // endpoint: same voice, same model, same single unit of quota, plus a character-level alignment. There
        // was never a reason to call the other one for narration. Without it every timing downstream is an
        // estimate, and the subtitle track and the shot cuts each guess at it separately — which is how a
        // caption comes to appear because a shot started rather than because a voice said a word.
        //
        // A provider that cannot align falls back to plain synthesis, and the ABSENCE is recorded rather than
        // papered over: the render gate refuses a film whose timeline was never measured.
        let synth = null;
        let alignment = null;
        if (typeof speech.synthesizeWithTimestamps === "function") {
          const aligned = await speech.synthesizeWithTimestamps({ text: speakText, voiceId, rate, outputPath: absOwner(rel), languageCode: normalizeLocale(project.language) });
          if (aligned && aligned.ok !== false) {
            synth = aligned;
            alignment = aligned.alignment || null;
          }
        }
        if (!synth) synth = await speech.synthesize({ text: speakText, voiceId, rate, outputPath: absOwner(rel) });
        const sha = await sha256File(absOwner(rel));
        await tx(async (client) => {
          await crepo.consumeAudioInvocation(client, ws, asset.id);
          await crepo.updateAudioAsset(client, ws, asset.id, { patch: { state: "COMPLETED", mediaMeta: { relativePath: rel, sizeBytes: synth.sizeBytes, container: synth.container || "wav", durationSeconds: synth.durationSeconds, sha256: sha } } });
          await repo.updateScene(client, ws, s.id, { patch: { audioMeta: {
            narrationAssetId: asset.id, textHash, voiceId: voiceId || null, rate: Number(rate) || 0,
            durationSeconds: synth.durationSeconds ?? null,
            // The exact text sent, so a transcript can be compared against what was actually asked for rather
            // than against whatever the scene says now.
            spokenText: speakText,
            alignmentAvailable: Boolean(alignment),
            audioSha256: synth.sha256 || null
          } } });
          // The alignment itself is an artifact: immutable, hashed, and the thing subtitles and shots are both
          // cut from. Storing it only in memory is how three independent timelines happened in the first place.
          if (alignment) {
            await arepo.putArtifact(client, ws, {
              id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.AUDIO_ALIGNMENT, sceneId: s.id,
              body: { alignment, spokenText: speakText, voiceId: voiceId || null, audioSha256: synth.sha256 || null, measuredDurationSeconds: synth.durationSeconds ?? null,
                      alignmentSource: synth.alignmentSource || null },
              creator: CREATOR.SYSTEM, provider: speech.kind || "TTS", providerAttemptId: synth.idempotencyKey || null
            });
            alignedScenes.push(s.id);
          }
        });
        done.push(s.id);
      } catch (e) {
        await tx(async (client) => {
          await crepo.consumeAudioInvocation(client, ws, asset.id);
          await crepo.updateAudioAsset(client, ws, asset.id, { patch: { state: "FAILED", errorCode: e.code || "E_TTS_FAILED" } });
        });
        failed.push({ sceneId: s.id, code: e.code || "E_TTS_FAILED" });
      }
    }
    // ---- P0 Step 5C.48: listen back, before anything expensive happens -----------------------------------
    //
    // The alignment proves the provider TIMED the text it was handed; only a transcript proves the recording
    // says it. This runs here, on the local ear, for nothing — and it runs BEFORE the first Grok Imagine call,
    // which is the whole reason it is here rather than only after the render: a film whose voice reads the
    // wrong words must not spend the video budget on pictures for it.
    const verified = [];
    if (stt && typeof stt.available === "function" && stt.available() && done.length) {
      const expectedLocale = normalizeLocale(project.language) || null;
      const lang = expectedLocale ? expectedLocale.slice(0, 2).toLowerCase() : null;
      const fresh = await tx((client) => crepo.listAudioAssets(client, ws, projectId, { kind: "NARRATION" }));
      for (const sceneIdDone of done) {
        const sc = (await tx((client) => repo.listScenes(client, ws, projectId))).find((x) => x.id === sceneIdDone);
        const meta = sc && sc.audioMeta ? sc.audioMeta : null;
        const a = meta && meta.narrationAssetId ? fresh.find((x) => x.id === meta.narrationAssetId) : null;
        const abs = a && a.mediaMeta ? absOwner(a.mediaMeta.relativePath) : null;
        if (!abs || !existsSync(abs)) continue;
        let tr = null, measure = null, code = null;
        try { tr = await stt.transcribeLocal({ audioPath: abs, language: lang }); }
        catch (e) { code = String(e && e.code ? e.code : "E_STT_FAILED").slice(0, 40); }
        try { measure = await measureAudio(abs); } catch { measure = null; }
        const v = verifyTranscript({
          script: meta.spokenText || sc.narration || "", transcript: tr, expectedLocale,
          audio: measure ? { durationSeconds: measure.audioDurationSeconds, leadingSilenceMs: measure.leadingSilenceMs, trailingSilenceMs: measure.trailingSilenceMs, maxInternalSilenceMs: measure.maxInternalSilenceMs } : null
        });
        verified.push({ sceneId: sceneIdDone, ordinal: sc.ordinal, verdict: v.verdict, coverage: v.wordCoverage, sentenceCoverage: v.sentenceCoverage, detected: v.detectedLanguage, code });
        await tx((client) => repo.updateScene(client, ws, sceneIdDone, { patch: { audioMeta: {
          ...meta,
          // Measurements only. The transcript text itself is deliberately NOT stored: an operational record
          // does not need a copy of every word the film says.
          narrationVerdict: v.verdict, narrationCoverage: v.wordCoverage, narrationSentenceCoverage: v.sentenceCoverage,
          narrationDetectedLanguage: v.detectedLanguage, narrationLanguageMatch: v.languageMatch,
          narrationLeadingTruncation: v.leadingTruncation === true, narrationTrailingTruncation: v.trailingTruncation === true,
          narrationTranscriptSha256: tr ? `sha256:${sha256Text(String(tr.text || ""))}` : null,
          narrationVerifiedBy: tr ? `${tr.engine || "local"}:${tr.model || ""}` : null,
          narrationVerifyError: code
        } } }));
      }
    }
    const worstCoverage = verified.filter((v) => Number.isFinite(v.coverage)).reduce((a, v) => Math.min(a, v.coverage), 1);

    await tx(async (client) => {
      await repo.updateProject(client, ws, projectId, { patch: { narrationSettings: { voiceId: voiceId || null, rate: Number(rate) || 0, enabled: true,
        // What was ACTUALLY used, so nobody has to infer it later from a voice map that may since have changed.
        voice: { name: voiceVerdict.voiceName, language: voiceVerdict.voiceLanguage, capability: voiceVerdict.capability, fallbackKind: voiceVerdict.fallbackKind } } } });
      await repo.appendEvent(client, ws, projectId, { type: "NARRATION_GENERATED", detail: {
        generated: done.length, failed: failed.length, skipped: skipped.length,
        // 5C.45 - the provider calls this run did NOT make, and why.
        skippedByRouting: skippedByRouting.length,
        narrationSource: routing ? routing.narrationSource : "ELEVENLABS",
        // 5C.48 - what the recordings actually say, measured locally before the video budget is touched.
        verifiedScenes: verified.length,
        worstCoverage: verified.length ? Number(worstCoverage.toFixed(4)) : null,
        rejected: verified.filter((v) => v.verdict === TRANSCRIPT_VERDICT.REJECT).length,
        aligned: alignedScenes.length
      } });
    });
    return {
      generated: done.length, skipped: skipped.length, failed,
      narrationVerification: Object.freeze(verified),
      worstCoverage: verified.length ? Number(worstCoverage.toFixed(4)) : null,
      alignedScenes: alignedScenes.length,
      narrationSource: routing ? routing.narrationSource : NARRATION_SOURCE.ELEVENLABS,
      elevenLabsSkipped: skippedByRouting.length,
      elevenLabsSkippedScenes: skippedByRouting,
      audioRouting: routing ? { consistent: routing.consistent, requiresReview: routing.requiresReview === true, reason: routing.reason, subtitleSource: routing.subtitles.source, unmeasuredScenes: routing.savings.unmeasuredScenes } : null
    };
  }

  // ---------------------------------------------------------------- music (ambient bed / upload)
  async function setMusic({ projectId, source = "NONE", style = "CALM", volume = 0.4 } = {}) {
    await ensureWs();
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const vol = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.4;
    if (source === "NONE") {
      await tx(async (client) => {
        await repo.updateProject(client, ws, projectId, { patch: { musicSettings: { source: "NONE" } } });
        await repo.appendEvent(client, ws, projectId, { type: "MUSIC_SET", detail: { source: "NONE" } });
      });
      return { source: "NONE" };
    }
    if (source !== "AMBIENT") throw cpErr("E_MOVIE_MUSIC_SOURCE", "source must be NONE, AMBIENT, or an upload");
    if (!assembler || typeof assembler.makeAmbientBed !== "function" || !ownerMediaRoot) throw cpErr("E_MOVIE_ASSEMBLER_UNAVAILABLE", "Music synthesis is not configured on this runtime");
    const scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    const seconds = Math.max(8, Math.round(scenes.reduce((t, s) => t + (effDur(s) || 6), 0)) + 4);
    const asset = await tx(async (client) => {
      const a = await crepo.insertAudioAsset(client, ws, { movieProjectId: projectId, sceneId: null, kind: "MUSIC", provider: "AMBIENT" });
      await crepo.reserveAudioInvocation(client, ws, a.id);
      await crepo.updateAudioAsset(client, ws, a.id, { patch: { state: "GENERATING" } });
      return a;
    });
    const rel = `movies/${projectId}/audio/${asset.id}.m4a`;
    try {
      const bed = await assembler.makeAmbientBed({ outputPath: absOwner(rel), seconds, style });
      const sha = await sha256File(absOwner(rel));
      await tx(async (client) => {
        await crepo.consumeAudioInvocation(client, ws, asset.id);
        await crepo.updateAudioAsset(client, ws, asset.id, { patch: { state: "COMPLETED", mediaMeta: { relativePath: rel, sizeBytes: bed.sizeBytes, container: "m4a", durationSeconds: bed.durationSeconds, sha256: sha } } });
        await repo.updateProject(client, ws, projectId, { patch: { musicSettings: { source: "AMBIENT", style: String(style || "CALM").toUpperCase(), volume: vol, assetId: asset.id } } });
        await repo.appendEvent(client, ws, projectId, { type: "MUSIC_SET", detail: { source: "AMBIENT", style: String(style || "CALM").toUpperCase() } });
      });
      return { source: "AMBIENT", assetId: asset.id, durationSeconds: bed.durationSeconds };
    } catch (e) {
      await tx(async (client) => {
        await crepo.consumeAudioInvocation(client, ws, asset.id);
        await crepo.updateAudioAsset(client, ws, asset.id, { patch: { state: "FAILED", errorCode: e.code || "E_MUSIC_FAILED" } });
      });
      throw cpErr(e.code || "E_MOVIE_MUSIC_FAILED", "Music bed synthesis failed");
    }
  }
  // Attach an uploaded music file the channel has already streamed to a temp file under the owner
  // tree. Validated with ffprobe (must contain audio), then moved into the project's audio folder.
  async function attachMusicUpload({ projectId, tempPath, volume = 0.4 } = {}) {
    await ensureWs();
    if (!assembler || !ownerMediaRoot) throw cpErr("E_MOVIE_ASSEMBLER_UNAVAILABLE", "Uploads are not configured on this runtime");
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    // An upload temp path is produced by this system, so it is checked as an ABSOLUTE path — but with the
    // same containment rules, because "starts with the root" accepts a sibling directory.
    if (typeof tempPath !== "string" || !isWithin(ownerMediaRoot, tempPath) || !existsSync(tempPath)) throw cpErr("E_MOVIE_MUSIC_UPLOAD", "The uploaded file is missing");
    let info;
    try { info = await assembler.inspectMedia(tempPath); } catch (e) { throw cpErr(e.code || "E_MOVIE_MUSIC_INVALID", "The uploaded file could not be read"); }
    if (!info.hasAudio) { try { await unlink(tempPath); } catch { /* */ } throw cpErr("E_MOVIE_MUSIC_INVALID", "The uploaded file has no audio track"); }
    const vol = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.4;
    const asset = await tx(async (client) => {
      const a = await crepo.insertAudioAsset(client, ws, { movieProjectId: projectId, sceneId: null, kind: "MUSIC", provider: "UPLOAD" });
      await crepo.reserveAudioInvocation(client, ws, a.id);
      await crepo.consumeAudioInvocation(client, ws, a.id);
      return a;
    });
    const rel = `movies/${projectId}/audio/${asset.id}.m4a`;
    await mkdir(path.dirname(absOwner(rel)), { recursive: true });
    await rename(tempPath, absOwner(rel));
    const sizeBytes = (await stat(absOwner(rel))).size;
    const sha = await sha256File(absOwner(rel));
    await tx(async (client) => {
      await crepo.updateAudioAsset(client, ws, asset.id, { patch: { state: "COMPLETED", mediaMeta: { relativePath: rel, sizeBytes, container: "m4a", durationSeconds: info.durationSeconds ?? null, sha256: sha } } });
      await repo.updateProject(client, ws, projectId, { patch: { musicSettings: { source: "UPLOAD", volume: vol, assetId: asset.id } } });
      await repo.appendEvent(client, ws, projectId, { type: "MUSIC_SET", detail: { source: "UPLOAD", sizeBytes } });
    });
    return { source: "UPLOAD", assetId: asset.id, durationSeconds: info.durationSeconds ?? null };
  }

  // ---------------------------------------------------------------- subtitles
  async function buildSubtitles({ projectId } = {}) {
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const scenes = (await tx((client) => repo.listScenes(client, ws, projectId))).slice().sort((a, b) => a.ordinal - b.ordinal);
    if (scenes.length === 0) throw cpErr("E_MOVIE_NO_SCENES", "Plan the storyboard first");
    const text = buildSrt(scenes.map((s) => ({ durationSeconds: effDur(s), narration: s.narration || s.heading || "" })));
    const mode = project.subtitleSettings?.mode || "embed";
    const settings = { mode, text, edited: false };
    await tx(async (client) => {
      await repo.updateProject(client, ws, projectId, { patch: { subtitleSettings: settings } });
      await repo.appendEvent(client, ws, projectId, { type: "SUBTITLES_BUILT", detail: { cues: scenes.filter((s) => s.narration || s.heading).length } });
    });
    return settings;
  }
  async function setSubtitles({ projectId, srtText = null, mode = null } = {}) {
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const settings = { ...(project.subtitleSettings || { mode: "embed" }) };
    if (mode !== null) {
      if (!["embed", "burn", "none"].includes(mode)) throw cpErr("E_MOVIE_SUBTITLE_MODE", "mode must be embed, burn, or none");
      settings.mode = mode;
    }
    if (srtText !== null) {
      const cues = parseSrtCues(srtText); // throws E_SRT_INVALID on structural problems
      assertNoSecret(String(srtText), "subtitles");
      settings.text = String(srtText).slice(0, 20000);
      settings.edited = true;
      settings.cueCount = cues.length;
    }
    await tx(async (client) => {
      await repo.updateProject(client, ws, projectId, { patch: { subtitleSettings: settings } });
      await repo.appendEvent(client, ws, projectId, { type: "SUBTITLES_SET", detail: { mode: settings.mode, edited: settings.edited === true } });
    });
    return settings;
  }

  // ---------------------------------------------------------------- timeline (trim/transition)
  async function updateTimeline({ projectId, entries = [] } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) throw cpErr("E_MOVIE_TIMELINE_EMPTY", "No timeline entries");
    return txReject(async (client) => {
      const project = await repo.getProject(client, ws, projectId);
      if (!project) return reject("E_MOVIE_NOT_FOUND", "Project not found");
      const scenes = await repo.listScenes(client, ws, projectId);
      const byId = new Map(scenes.map((s) => [s.id, s]));
      for (const e of entries) {
        if (!e || !byId.has(e.sceneId)) return reject("E_MOVIE_SCENE_NOT_FOUND", "Timeline entry references an unknown scene");
        const patch = {};
        if (e.trimIn !== undefined) patch.trimIn = e.trimIn === null ? null : Number(e.trimIn);
        if (e.trimOut !== undefined) patch.trimOut = e.trimOut === null ? null : Number(e.trimOut);
        if (e.transitionType !== undefined) patch.transitionType = e.transitionType;
        if (e.transitionSeconds !== undefined) patch.transitionSeconds = e.transitionSeconds === null ? null : Number(e.transitionSeconds);
        if (patch.trimIn != null && patch.trimOut != null && patch.trimOut <= patch.trimIn) return reject("E_MOVIE_TIMELINE_TRIM", "trimOut must be greater than trimIn");
        await repo.updateScene(client, ws, e.sceneId, { patch });
      }
      await repo.appendEvent(client, ws, projectId, { type: "TIMELINE_UPDATED", detail: { entries: entries.length } });
      return repo.listScenes(client, ws, projectId);
    });
  }

  // ---------------------------------------------------------------- render versions (audio-mixed)
  // renderHash covers every render input; an unchanged hash returns the existing COMPLETED render
  // (never re-renders). Each render is a NEW immutable version under movies/<id>/renders/v<N>/.
  async function renderMovie({ projectId } = {}) {
    await ensureWs();
    if (!assembler || typeof assembler.assembleWithAudio !== "function" || !ownerMediaRoot) throw cpErr("E_MOVIE_ASSEMBLER_UNAVAILABLE", "Rendering is not configured on this runtime");
    const scenes = await refreshScenes({ projectId });
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const ordered = scenes.slice().sort((a, b) => a.ordinal - b.ordinal);
    if (ordered.length === 0) throw cpErr("E_MOVIE_NO_SCENES", "No scenes to render");
    const incomplete = ordered.filter((s) => s.state !== "COMPLETED" || !s.mediaMeta);
    if (incomplete.length) throw cpErr("E_MOVIE_SCENES_INCOMPLETE", `${incomplete.length} scene(s) are not completed yet`);
    const audio = await tx((client) => crepo.listAudioAssets(client, ws, projectId));
    const narrFor = (s) => {
      const wanted = s.audioMeta?.narrationAssetId;
      const a = wanted ? audio.find((x) => x.id === wanted && x.kind === "NARRATION" && x.state === "COMPLETED" && x.mediaMeta) : null;
      return a && absOwner(a.mediaMeta.relativePath) && existsSync(absOwner(a.mediaMeta.relativePath)) ? a : null;
    };
    const ms = project.musicSettings || null;
    let music = null;
    if (ms && ms.source && ms.source !== "NONE" && ms.assetId) {
      const a = audio.find((x) => x.id === ms.assetId && x.kind === "MUSIC" && x.state === "COMPLETED" && x.mediaMeta);
      const abs = a ? absOwner(a.mediaMeta.relativePath) : null;
      if (abs && existsSync(abs)) music = { path: abs, volume: Number.isFinite(ms.volume) ? ms.volume : 0.4, rel: a.mediaMeta.relativePath };
    }
    const subs = project.subtitleSettings || {};
    const clips = ordered.map((s) => {
      const narr = narrFor(s);
      return {
        path: absOwner(s.mediaMeta.relativePath),
        narrationPath: narr ? absOwner(narr.mediaMeta.relativePath) : null,
        narration: s.narration || s.heading || "", heading: s.heading || "",
        durationSeconds: s.durationSeconds, trimIn: s.trimIn, trimOut: s.trimOut,
        fadeSeconds: s.transitionType === "CUT" ? 0 : (Number.isFinite(s.transitionSeconds) ? s.transitionSeconds : 0.3),
        _rel: s.mediaMeta.relativePath, _narrRel: narr ? narr.mediaMeta.relativePath : null
      };
    });
    for (const c of clips) if (!c.path || !existsSync(c.path)) throw cpErr("E_MOVIE_CLIP_MISSING", "A completed scene's clip file is missing");

    // ---- duration budget (5C.36) ------------------------------------------------------------------
    // The render does not get to decide the length of the film. The plan does — computed from the same
    // durable inputs, from the measured clips, BEFORE a frame is written. A scene that has been trimmed by
    // hand keeps its trim; everything else follows the plan.
    let durationPlan = null;
    if (project.durationBudgetEnabled !== false) {
      const measuredClips = ordered.map((sc) => {
        const d = sc.mediaMeta && Number(sc.mediaMeta.durationSeconds);
        return Number.isFinite(d) && d > 0 ? d : null;
      });
      try {
        durationPlan = planDurationBudget({
          targetDurationSeconds: project.targetDurationSeconds,
          scenes: ordered.map((sc) => ({ ordinal: sc.ordinal, narration: sc.narration, heading: sc.heading })),
          locale: normalizeLocale(project.language) || "en-US",
          clipDurations: measuredClips.some((x) => Number.isFinite(x)) ? measuredClips : null
        });
      } catch (e) {
        // An impossible budget is refused here, before ffmpeg runs — not worked around by cutting speech.
        throw cpErr(e.code || DURATION_ERRORS.UNSATISFIABLE, e.message);
      }
      // Real narration audio has a real length. If it will not fit its slot, the film would have to cut a
      // sentence — so it refuses instead.
      verifyAgainstMeasured(durationPlan, ordered.map((sc) => {
        const d = sc.audioMeta && Number(sc.audioMeta.durationSeconds);
        return Number.isFinite(d) && d > 0 ? d : null;
      }));
      for (let i = 0; i < clips.length; i += 1) {
        const planned = durationPlan.scenes[i];
        if (!planned) continue;
        // A hand-set trim is an explicit owner decision and outranks the plan.
        const handTrimmed = Number.isFinite(ordered[i].trimIn) || Number.isFinite(ordered[i].trimOut);
        if (!handTrimmed) { clips[i].trimIn = planned.trimIn; clips[i].trimOut = planned.trimOut; }
        clips[i].durationSeconds = planned.allocatedSeconds;
        clips[i].narration = planned.narrationText || "";
      }
    }

    const renderInputs = {
      v: 2, aspect: project.aspectRatio, includeTitleCard: false,
      clips: clips.map((c) => ({ rel: c._rel, narr: c._narrRel, trimIn: c.trimIn ?? null, trimOut: c.trimOut ?? null, fade: c.fadeSeconds, text: c.narration })),
      music: music ? { rel: music.rel, volume: music.volume } : null,
      subtitles: { mode: subs.mode || "embed", textHash: subs.edited && subs.text ? sha256Text(subs.text) : null },
      plan: durationPlan ? { target: durationPlan.targetSeconds, planned: durationPlan.plannedSeconds } : null
    };
    const renderHash = `sha256:${sha256Text(JSON.stringify(renderInputs))}`;
    const existing = await tx((client) => crepo.findCompletedRenderByHash(client, ws, projectId, renderHash));
    if (existing) return { idempotent: true, render: existing };
    const render = await tx(async (client) => {
      const r = await crepo.insertRender(client, ws, { movieProjectId: projectId, renderHash });
      await repo.appendEvent(client, ws, projectId, { type: "RENDER_STARTED", detail: { version: r.version } });
      return r;
    });
    // ---- 5C.39 the aligned timeline ---------------------------------------------------------------------
    // Built from what the provider actually measured. When every scene has an alignment artifact the film gets
    // one canonical clock; when none do, the old duration plan still drives the render and the scorecard
    // records the timeline as UNVERIFIED, which blocks PUBLISHABLE without blocking the render. Those are
    // deliberately different decisions: refusing every legacy film would be unusable, passing them would lie.
    let alignedSubtitles = null;
    let narrationTimeline = null;
    let subtitleDriftReport = null;
    if (contentAlignmentEnabled) {
      try {
        const alignments = [];
        for (const sc of ordered) {
          const a = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.AUDIO_ALIGNMENT, sceneId: sc.id }));
          if (!a || !a.body || !a.body.alignment) { alignments.length = 0; break; }
          alignments.push({
            alignment: a.body.alignment,
            measuredDurationMs: Number.isFinite(a.body.measuredDurationSeconds) ? Math.round(a.body.measuredDurationSeconds * 1000) : null,
            beatId: sc.id
          });
        }
        if (alignments.length === ordered.length && alignments.length > 0) {
          narrationTimeline = buildCanonicalTimeline(alignments);
          alignedSubtitles = buildVerifiedSubtitles(narrationTimeline);
          subtitleDriftReport = alignedSubtitles.drift;
        }
      } catch (e) {
        // A drift failure is a real refusal: cues that do not match the voice are worse than no cues, because
        // they look authoritative. An alignment that is merely absent is not an error — it is the legacy path.
        if (e.code === PIPELINE_ERRORS.SUBTITLE_DRIFT) throw cpErr(e.code, e.message);
        narrationTimeline = null; alignedSubtitles = null;
      }
    }

    const outDirRel = `movies/${projectId}/renders/v${render.version}`;
    await mkdir(absOwner(outDirRel), { recursive: true });
    const outputPath = path.join(absOwner(outDirRel), "final.mp4");
    let result;
    try {
      result = await assembler.assembleWithAudio({
        clips, workDir: path.join(absOwner(outDirRel), "work"), outputPath,
        title: project.title, includeTitleCard: false, aspectRatio: project.aspectRatio,

        music: music ? { path: music.path, volume: music.volume } : null,
        subtitleMode: subs.mode || "embed",
        // Cues built FROM the plan — same slots, same text — so a subtitle can never outlive its shot.
        // An owner-edited SRT still wins: it is an explicit decision.
        // P0 Step 5C.39 — subtitles cut from the REAL audio alignment when one exists. subtitlesFromPlan
        // divides a scene's duration, so a cue appears because a shot started rather than because a voice said
        // a word; the aligned cues carry each word's measured time and are gated on drift before they are used.
        // An owner-edited SRT still wins: that is an explicit decision.
        subtitleText: subs.edited && subs.text ? subs.text
          : (alignedSubtitles ? alignedSubtitles.srt : (durationPlan ? subtitlesFromPlan(durationPlan) : null))
      });
    } catch (e) {
      await tx(async (client) => {
        await crepo.updateRender(client, ws, render.id, { patch: { state: "FAILED", errorCode: e.code || "E_RENDER_FAILED" } });
        await repo.appendEvent(client, ws, projectId, { type: "RENDER_FAILED", detail: { version: render.version, code: e.code || null } });
      });
      throw cpErr(e.code || "E_MOVIE_RENDER_FAILED", "Movie render failed");
    }
    const sha = await sha256File(outputPath);
    const finalMedia = { relativePath: `${outDirRel}/final.mp4`, sizeBytes: result.sizeBytes, container: "mp4", durationSeconds: result.durationSeconds, width: result.width, height: result.height, sha256: sha };
    const subtitleMedia = result.srtPath && existsSync(result.srtPath) ? { relativePath: `${outDirRel}/final.srt`, sizeBytes: (await stat(result.srtPath)).size, container: "srt" } : null;
    const thumbnailMedia = result.thumbnailPath && existsSync(result.thumbnailPath) ? { relativePath: `${outDirRel}/final.jpg`, sizeBytes: (await stat(result.thumbnailPath)).size, container: "jpg" } : null;
    // ---- 720p mastering gate (5C.37) ------------------------------------------------------------------
    // The render exiting zero is an engineering fact and says nothing about the picture. Decode the file that
    // was just written and measure it: display geometry after SAR, rotation, codec / CFR / pixel format /
    // sample rate, a bitrate that is not starving the image, black or frozen or broken frames, sharpness and
    // blockiness — plus every SOURCE clip's real resolution, so an upscale is recorded rather than performed
    // quietly. The verdict rides with the render because the render is what it describes.
    let master = null;
    if (masteringEnabled) {
      try {
        master = await certifyMaster(outputPath, {
          profile: VERTICAL_720P,
          expectedDurationSeconds: durationPlan ? durationPlan.plannedSeconds : null,
          sourceClips: ordered.map((sc, i) => ({ path: clips[i] ? clips[i].path : null, ordinal: sc.ordinal })).filter((x) => x.path)
        });
      } catch (e) {
        // A gate that could not run must say so. Passing by default is how an unmeasured film becomes a
        // "certified" one. The code only — a message can carry a path, and none belongs in the database.
        master = { pass: false, failures: [{ check: "gate-unavailable", detail: String(e && e.code ? e.code : "E_MASTER_GATE_FAILED") }], warnings: [], technicalScore: 0, measured: {}, integrity: {}, sources: [] };
      }
    }
    // ---- 5C.48 the transcript gate, on the file that shipped ------------------------------------------
    //
    // voiceCorrectness is a HARD scorecard dimension and its artifact has never been written by anything, so
    // every film in this system has been UNMEASURED on the one question a viewer notices first: does the
    // narration say the script. It is measured HERE, on the rendered master rather than on the narration
    // assets, because that is the audio an audience hears — it catches a lost sentence head, a dropped tail
    // and a mix that buries a line, none of which are visible in the source recordings.
    //
    // Local ear, no provider, no cost. Absent one, the verdict is UNVERIFIED and the film stays out of
    // PUBLISHABLE — which is the honest answer to a question nobody listened to.
    let transcriptVerification = null;
    let audioMixVerdict = null;
    if (contentAlignmentEnabled) {
      const spoken = ordered.map((sc) => String((sc.audioMeta && sc.audioMeta.spokenText) || sc.narration || "").trim()).filter(Boolean).join(" ");
      const expectedLocale = normalizeLocale(project.language) || null;
      let measure = null;
      try { measure = await measureAudio(outputPath); } catch { measure = null; }
      let tr = null, sttCode = null;
      if (spoken && stt && typeof stt.available === "function" && stt.available()) {
        try { tr = await stt.transcribeLocal({ audioPath: outputPath, language: expectedLocale ? expectedLocale.slice(0, 2).toLowerCase() : null }); }
        catch (e) { sttCode = String(e && e.code ? e.code : "E_STT_FAILED").slice(0, 40); }
      }
      const characterNames = ((project.characterBible || []).map((c) => c && (c.name || c.canonicalName))).filter((x) => typeof x === "string" && x.length > 1);
      const v = verifyTranscript({
        script: spoken, transcript: tr, expectedLocale, characterNames,
        audio: measure ? { durationSeconds: measure.audioDurationSeconds, leadingSilenceMs: measure.leadingSilenceMs, trailingSilenceMs: measure.trailingSilenceMs, maxInternalSilenceMs: measure.maxInternalSilenceMs } : null,
        expectedDurationSeconds: durationPlan ? durationPlan.plannedSeconds : null
      });
      const gate = gateTranscript(v);
      transcriptVerification = {
        // The shape the scorecard reads. `coverage` is the word coverage: how much of the script appears, in
        // order, in what the recording actually says.
        coverage: v.wordCoverage, sentenceCoverage: v.sentenceCoverage,
        missingWords: (v.missingSegments || []).map((m) => m.text).slice(0, 12),
        substitutions: (v.substitutedSegments || []).slice(0, 12),
        detectedLanguage: v.detectedLanguage, expectedLanguage: expectedLocale,
        ok: v.verdict === TRANSCRIPT_VERDICT.PASS,
        verdict: v.verdict, transcribed: v.transcribed === true, confidence: v.confidence,
        nameAccuracy: v.nameAccuracy, numberAccuracy: v.numberAccuracy,
        leadingTruncation: v.leadingTruncation === true, trailingTruncation: v.trailingTruncation === true,
        scriptWords: (spoken.match(/[\p{L}\p{N}]+/gu) || []).length,
        audio: v.audio || {}, failures: (v.failures || []).map((f) => f.check),
        // Provenance without the transcript itself: enough to prove a measurement happened and to detect a
        // different reading later, without keeping a copy of the film's every word in the database.
        transcriptSha256: tr ? `sha256:${sha256Text(String(tr.text || ""))}` : null,
        engine: tr ? `${tr.engine || "local"}:${tr.model || ""}` : null,
        sttErrorCode: sttCode, blocking: gate.blocking === true
      };
      if (measure && measure.decoded) {
        audioMixVerdict = {
          narrationLufs: measure.integratedLufs, truePeakDbtp: measure.truePeakDbtp,
          loudnessRange: measure.loudnessRange, sampleRate: measure.sampleRate, channels: measure.channels,
          // No music bed in this film: there is nothing for the narration to be buried under, and saying so is
          // more useful than a headroom figure computed against silence.
          musicPresent: Boolean(music), musicLufs: null,
          silenceRatio: measure.silenceRatio, clipping: Number.isFinite(measure.truePeakDbtp) && measure.truePeakDbtp > -0.5
        };
      }
    }

    const probe = {
      videoCodec: result.videoCodec, audioCodec: result.audioCodec, hasAudio: result.hasAudio,
      hasSubtitles: result.hasSubtitles, hasMusic: result.hasMusic, sha256: sha,
      transcript: transcriptVerification ? {
        verdict: transcriptVerification.verdict, coverage: transcriptVerification.coverage,
        detectedLanguage: transcriptVerification.detectedLanguage
      } : null,
      master: master ? {
        pass: master.pass === true, technicalScore: master.technicalScore,
        profile: master.profile || VERTICAL_720P.name,
        measured: master.measured || {}, integrity: master.integrity || {},
        failures: (master.failures || []).map((f) => ({ ...f, detail: undefined })),
        warnings: (master.warnings || []).map((f) => ({ ...f, detail: undefined })),
        sources: master.sources || []
      } : null
    };
    await tx(async (client) => {
      await crepo.updateRender(client, ws, render.id, { patch: { state: "COMPLETED", finalMedia, subtitleMedia, thumbnailMedia, probe } });
      // 5C.39 — bind the exact artifact revisions this file was made from. Asked later why a shot shows a
      // street while the narration says otherwise, the answer is now readable instead of lost.
      if (contentAlignmentEnabled) {
        try {
          const used = await arepo.listActive(client, ws, projectId);
          if (used.length) await arepo.recordRenderProvenance(client, ws, { renderId: render.id, artifacts: used });
          // 5C.48 — the two verdicts the scorecard has always read and nothing has ever written.
          if (transcriptVerification) {
            await arepo.putArtifact(client, ws, {
              id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.TRANSCRIPT_VERIFICATION,
              body: { ...transcriptVerification, renderVersion: render.version },
              creator: CREATOR.SYSTEM, provider: transcriptVerification.engine || "LOCAL_STT"
            });
          }
          if (audioMixVerdict) {
            await arepo.putArtifact(client, ws, {
              id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.AUDIO_MIX_VERDICT,
              body: { ...audioMixVerdict, renderVersion: render.version }, creator: CREATOR.SYSTEM
            });
          }
          if (subtitleDriftReport) {
            await arepo.putArtifact(client, ws, {
              id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.SUBTITLE_TIMELINE,
              // 5C.45 - subtitles must name the audio they were cut from. When the film's narration comes from
              // the clip's own voice, ElevenLabs timestamps describe a recording that is not in the film, and
              // an estimated duration describes nothing at all.
              body: {
                drift: subtitleDriftReport, cues: alignedSubtitles ? alignedSubtitles.cues.length : 0,
                source: subtitleSourceFor(project.narrationSource || NARRATION_SOURCE.ELEVENLABS).source,
                narrationSource: project.narrationSource || NARRATION_SOURCE.ELEVENLABS
              },
              creator: CREATOR.SYSTEM
            });
          }
        } catch { /* provenance must never be the reason a finished render is lost */ }
      }
      await repo.updateProject(client, ws, projectId, {
        patch: {
          finalMedia: { relativePath: finalMedia.relativePath, sizeBytes: finalMedia.sizeBytes, container: "mp4", durationSeconds: finalMedia.durationSeconds, width: finalMedia.width, height: finalMedia.height, sceneCount: result.sceneCount, hasSubtitles: result.hasSubtitles },
          status: "COMPLETED", renderSettings: { latestRenderId: render.id, latestVersion: render.version }
        }
      });
      await repo.appendEvent(client, ws, projectId, { type: "RENDER_COMPLETED", detail: { version: render.version, sizeBytes: result.sizeBytes, hasAudio: result.hasAudio === true,
        transcriptVerdict: transcriptVerification ? transcriptVerification.verdict : null,
        transcriptCoverage: transcriptVerification ? transcriptVerification.coverage : null,
        audioSampleRate: audioMixVerdict ? audioMixVerdict.sampleRate : null } });
      // A rendered file that does not say the script is not a failed render — the file is fine. It is a film
      // that must not be published, which the scorecard decides. Recording it as its own event is what makes
      // that visible without pretending the render broke.
      if (transcriptVerification && transcriptVerification.blocking) {
        await repo.appendEvent(client, ws, projectId, { type: "TRANSCRIPT_REJECTED", detail: {
          version: render.version, coverage: transcriptVerification.coverage, failures: transcriptVerification.failures.slice(0, 6)
        } });
      }
    });
    return { idempotent: false, render: await tx((client) => crepo.getRender(client, ws, render.id)) };
  }
  async function listRenders(projectId) { return tx((client) => crepo.listRenders(client, ws, projectId)); }

  // ---------------------------------------------------------------- publishing package (downloadable)
  async function buildPackage({ projectId, renderId = null, caption = null } = {}) {
    await ensureWs();
    if (!ownerMediaRoot) throw cpErr("E_MOVIE_ASSEMBLER_UNAVAILABLE", "Packaging is not configured on this runtime");
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const renders = await tx((client) => crepo.listRenders(client, ws, projectId));
    const render = renderId ? renders.find((r) => r.id === renderId) : renders.find((r) => r.state === "COMPLETED");
    if (!render || render.state !== "COMPLETED" || !render.finalMedia) throw cpErr("E_MOVIE_NO_RENDER", "Render the movie before building the package");
    const scenes = (await tx((client) => repo.listScenes(client, ws, projectId))).slice().sort((a, b) => a.ordinal - b.ordinal);
    const cap = String(caption !== null && caption !== undefined ? caption : (project.publishingMetadata?.caption ?? project.synopsis ?? project.title ?? "")).slice(0, 4000);
    assertNoSecret(cap, "caption");
    const outDirRel = `movies/${projectId}/renders/v${render.version}/package`;
    const out = await buildPublishingPackage({
      packageDir: absOwner(outDirRel),
      finalPath: absOwner(render.finalMedia.relativePath),
      thumbnailPath: render.thumbnailMedia ? absOwner(render.thumbnailMedia.relativePath) : null,
      srtPath: render.subtitleMedia ? absOwner(render.subtitleMedia.relativePath) : null,
      caption: cap, title: project.title, project: { id: project.id },
      scenes, render, now: () => new Date(now())
    });
    const zipRel = `${outDirRel}/package.zip`;
    const zipSha = await sha256File(absOwner(zipRel));
    await tx(async (client) => {
      await crepo.updateRender(client, ws, render.id, { patch: { packageMedia: { relativePath: zipRel, sizeBytes: out.zipSizeBytes, container: "zip", sha256: zipSha } } });
      await repo.updateProject(client, ws, projectId, { patch: { publishingMetadata: { ...(project.publishingMetadata || {}), caption: cap, packagedRenderId: render.id, packagedVersion: render.version, files: out.files } } });
      await repo.appendEvent(client, ws, projectId, { type: "PACKAGE_BUILT", detail: { version: render.version, files: out.files.length, zipSizeBytes: out.zipSizeBytes } });
    });
    return { packageRef: zipRel, files: out.files, zipSizeBytes: out.zipSizeBytes, renderId: render.id, version: render.version };
  }

  // ---------------------------------------------------------------- publish attempts (exactly-once)
  // target PACKAGE = the Facebook-independent path (always available). target FACEBOOK requires a
  // configured publisher provider with a READY account; Draft/Only-Me ONLY; an uncertain submit is
  // terminal and never retried.
  async function publishMovie({ projectId, target = "PACKAGE", audience = null, renderId = null, caption = null } = {}) {
    execGate.assertRunning("publishMovie");
    await ensureWs();
    if (!["PACKAGE", "FACEBOOK"].includes(target)) throw cpErr("E_MOVIE_PUBLISH_TARGET", "target must be PACKAGE or FACEBOOK");
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    if (target === "FACEBOOK" && !PUBLISH_AUDIENCES.includes(audience)) throw cpErr("E_PUBLISH_AUDIENCE", "Only Draft or Only-Me publishing is allowed");
    const attempt = await tx(async (client) => {
      const a = await crepo.insertPublishAttempt(client, ws, { movieProjectId: projectId, renderId, target, audience: target === "FACEBOOK" ? audience : null });
      await crepo.reservePublishInvocation(client, ws, a.id);
      await crepo.updatePublishAttempt(client, ws, a.id, { patch: { state: "RUNNING" } });
      await repo.appendEvent(client, ws, projectId, { type: "PUBLISH_STARTED", detail: { target } });
      return a;
    });
    const onBeforeSubmit = async () => {
      await tx(async (client) => {
        await crepo.updatePublishAttempt(client, ws, attempt.id, { patch: { submitState: "SUBMITTED" } });
        await crepo.consumePublishInvocation(client, ws, attempt.id);
      });
    };
    try {
      let postRef = null;
      if (target === "PACKAGE") {
        await onBeforeSubmit(); // building a local package is safe; the life-cycle stays uniform
        const built = await buildPackage({ projectId, renderId, caption });
        postRef = built.packageRef;
      } else {
        const fb = publishers && publishers.FACEBOOK;
        if (!fb || !fb.available()) {
          await tx(async (client) => { await crepo.updatePublishAttempt(client, ws, attempt.id, { patch: { state: "FAILED", errorCode: "E_PUBLISH_FB_UNAVAILABLE" } }); });
          throw cpErr("E_PUBLISH_FB_UNAVAILABLE", "No READY Facebook account is enrolled on this runtime");
        }
        const built = await buildPackage({ projectId, renderId, caption });
        const out = await fb.publish({
          packageDir: absOwner(`movies/${projectId}/renders/v${built.version}/package`),
          caption: caption ?? project.publishingMetadata?.caption ?? "", audience, onBeforeSubmit
        });
        postRef = out.postRef;
      }
      await tx(async (client) => {
        await crepo.updatePublishAttempt(client, ws, attempt.id, { patch: { state: "COMPLETED", postRef } });
        await repo.appendEvent(client, ws, projectId, { type: "PUBLISH_COMPLETED", detail: { target } });
      });
      return { attemptId: attempt.id, state: "COMPLETED", target, postRef };
    } catch (e) {
      const row = await tx((client) => crepo.getPublishAttempt(client, ws, attempt.id));
      if (row && ["FAILED", "UNCERTAIN", "COMPLETED"].includes(row.state)) throw cpErr(e.code || "E_MOVIE_PUBLISH_FAILED", e.message || "Publish failed");
      const uncertain = Boolean(row && row.submitState === "SUBMITTED") || e.code === "E_PUBLISH_UNCERTAIN";
      await tx(async (client) => {
        await crepo.updatePublishAttempt(client, ws, attempt.id, {
          patch: uncertain
            ? { state: "UNCERTAIN", submitState: "UNCERTAIN", errorCode: e.code || "E_PUBLISH_UNCERTAIN" }
            : { state: "FAILED", errorCode: e.code || "E_PUBLISH_FAILED" }
        });
        await repo.appendEvent(client, ws, projectId, { type: uncertain ? "PUBLISH_UNCERTAIN" : "PUBLISH_FAILED", detail: { target, code: e.code || null } });
      });
      throw cpErr(e.code || "E_MOVIE_PUBLISH_FAILED", uncertain ? "Publish outcome uncertain; it will NOT be retried" : (e.message || "Publish failed"));
    }
  }
  async function listPublishes(projectId) { return tx((client) => crepo.listPublishAttempts(client, ws, projectId)); }

  // A Worker-local temp target for the channel's bounded music-upload stream (owner tree only; the
  // upload is validated + moved by attachMusicUpload, or deleted on failure).
  async function uploadTempTarget() {
    if (!ownerMediaRoot) return null;
    const rel = `uploads/tmp-${newTempId()}.bin`;
    await mkdir(path.dirname(absOwner(rel)), { recursive: true });
    return absOwner(rel);
  }

  // ---------------------------------------------------------------- content media resolution (channel streaming)
  async function audioMediaFor(projectId, audioId) {
    const a = await tx((client) => crepo.getAudioAsset(client, ws, audioId));
    if (!a || a.movieProjectId !== projectId || a.state !== "COMPLETED" || !a.mediaMeta) return null;
    const type = a.mediaMeta.container === "wav" ? "audio/wav" : "audio/mp4";
    return resolveOwnerFile(a.mediaMeta.relativePath, type, `audio-${a.id}.${a.mediaMeta.container || "m4a"}`);
  }
  async function renderMediaFor(projectId, renderId, part = "final") {
    const r = await tx((client) => crepo.getRender(client, ws, renderId));
    if (!r || r.movieProjectId !== projectId) return null;
    if (part === "final" && r.finalMedia) return resolveOwnerFile(r.finalMedia.relativePath, "video/mp4", `movie-${projectId}-v${r.version}.mp4`);
    if (part === "thumbnail" && r.thumbnailMedia) return resolveOwnerFile(r.thumbnailMedia.relativePath, "image/jpeg", `thumbnail-v${r.version}.jpg`);
    if (part === "srt" && r.subtitleMedia) return resolveOwnerFile(r.subtitleMedia.relativePath, "text/plain; charset=utf-8", `subtitles-v${r.version}.srt`);
    if (part === "package" && r.packageMedia) return resolveOwnerFile(r.packageMedia.relativePath, "application/zip", `package-${projectId}-v${r.version}.zip`);
    return null;
  }

  // ---------------------------------------------------------------- UI view (project + scenes + progress + events)
  async function getProjectView(projectId, { refresh = true } = {}) {
    if (refresh) { try { await refreshScenes({ projectId }); } catch { /* best-effort */ } }
    return tx(async (client) => {
      const project = await repo.getProject(client, ws, projectId);
      if (!project) return null;
      const scenes = await repo.listScenes(client, ws, projectId);
      const completed = scenes.filter((s) => s.state === "COMPLETED").length;
      const failed = scenes.filter((s) => ["FAILED", "UNCERTAIN"].includes(s.state)).length;
      const generating = scenes.filter((s) => ["QUEUED", "GENERATING"].includes(s.state)).length;
      const events = await repo.listEvents(client, ws, projectId, { limit: 100 });
      const audioAssets = await crepo.listAudioAssets(client, ws, projectId);
      const renders = await crepo.listRenders(client, ws, projectId);
      const publishes = await crepo.listPublishAttempts(client, ws, projectId, { limit: 20 });
      const storyAttempts = await crepo.listStoryAttempts(client, ws, projectId, { limit: 10 });
      // 5C.48 — the per-shot verdicts, attached to the scenes they describe. The vision verdict, the contract
      // revision and the repair history all live in artifacts, and until now nothing carried them to a reader:
      // a rejected shot and a passing one looked identical in the UI.
      const artifacts = await arepo.listActive(client, ws, projectId);
      const verdictOf = new Map(artifacts.filter((a) => a.kind === ARTIFACT_KIND.SCENE_VISION_VERDICT && a.sceneId).map((a) => [a.sceneId, a]));
      const contractOf = new Map(artifacts.filter((a) => a.kind === ARTIFACT_KIND.SHOT_CONTRACT && a.sceneId).map((a) => [a.sceneId, a]));
      const repairRows = (await client.query(
        `SELECT scene_id, attempt, state, error_code FROM movie_shot_repairs
          WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY attempt`, [ws, projectId])).rows;
      const withVerdicts = scenes.map((s) => {
        const base = sceneForUi(s);
        const v = verdictOf.get(s.id), c = contractOf.get(s.id);
        return Object.freeze({
          ...base,
          visionVerdict: v ? Object.freeze({ verdict: v.body.verdict ?? null, measured: v.body.measured === true, scores: v.body.scores ?? null, blocker: v.body.blocker ?? null, revision: v.revision }) : null,
          shotContract: c ? Object.freeze({ revision: c.revision, durationSeconds: c.body.durationSeconds ?? null, expectedDurationMs: c.body.expectedDurationMs ?? null, repairedFrom: c.body.repairedFrom ?? null, repairAttempt: c.body.repairAttempt ?? null }) : null,
          repairs: Object.freeze(repairRows.filter((r) => r.scene_id === s.id).map((r) => Object.freeze({ attempt: r.attempt, state: r.state, errorCode: r.error_code }))),
          sourceMedia: s.mediaMeta ? Object.freeze({
            width: s.mediaMeta.width ?? null, height: s.mediaMeta.height ?? null, durationSeconds: s.mediaMeta.durationSeconds ?? null,
            requestedDurationSeconds: s.mediaMeta.requestedDurationSeconds ?? null, selectedDurationSeconds: s.mediaMeta.selectedDurationSeconds ?? null,
            durationVerdict: s.mediaMeta.durationVerdict ?? null, sourceVerdict: s.mediaMeta.sourceVerdict ?? null
          }) : null
        });
      });
      return {
        // 5C.38 — what the film was actually BUILT from. The final container is 720x1280 for every movie ever
        // made here, including the ones assembled from 464x688 footage, so the container cannot be the answer.
        project: Object.freeze({ ...projectForUi(project), sourceResolution: sourceResolutionOf(scenes) }),
        scenes: withVerdicts,
        progress: { total: scenes.length, completed, failed, generating, readyToAssemble: scenes.length > 0 && completed === scenes.length },
        content: {
          narration: audioAssets.filter((a) => a.kind === "NARRATION").map(audioForUi),
          music: audioAssets.filter((a) => a.kind === "MUSIC").map(audioForUi),
          renders: renders.map(renderForUi),
          publishes: publishes.map(publishForUi),
          storyAttempts: storyAttempts.map(storyAttemptForUi)
        },
        events
      };
    });
  }
  async function listProjectsView(opts = {}) { const items = await listProjects(opts); return items.map(projectForUi); }

  /**
   * The source footage this movie stands on, taken from each scene's DECODED media rather than from anything
   * the provider page said. The weakest clip decides: one 480p scene in a six-scene film means the film is not
   * native 720p, and averaging that away is how "720p" ended up meaning nothing.
   */
  function sourceResolutionOf(scenes) {
    const clips = (scenes || []).map((s) => s.mediaMeta).filter((m) => m && Number.isFinite(m.width) && Number.isFinite(m.height) && m.height > 0);
    if (clips.length === 0) return null;
    const weakest = clips.reduce((a, b) => (Math.min(b.width, b.height) < Math.min(a.width, a.height) ? b : a));
    const anyFallback = clips.some((m) => m.providerFallbackSuspected === true);
    const verdicts = clips.map((m) => m.sourceVerdict).filter(Boolean);
    // 5C.43 - derived from the verdict rather than from a second field saying the same thing twice.
    const allNative = clips.length > 0 && clips.every((m) => m.sourceVerdict === "NATIVE_720P");
    return Object.freeze({
      clips: clips.length,
      minWidth: weakest.width, minHeight: weakest.height,
      native: allNative,
      // An older clip carries no verdict because it predates the check. That is UNVERIFIED, which is not the
      // same as a pass — the UI says so rather than showing a reassuring blank.
      verdict: verdicts.length === clips.length ? (allNative ? "NATIVE_720P" : (verdicts.find((v) => v !== "NATIVE_720P") || null)) : "UNVERIFIED",
      providerFallbackSuspected: anyFallback,
      decodedFromFile: clips.every((m) => m.decodedFromFile === true)
    });
  }

  function projectForUi(p) {
    if (!p) return null;
    return Object.freeze({
      id: p.id, title: p.title, genre: p.genre, language: p.language, targetDurationSeconds: p.targetDurationSeconds,
      aspectRatio: p.aspectRatio, visualStyle: p.visualStyle, characterBible: p.characterBible, inputMode: p.inputMode,
      idea: p.idea, pastedStory: p.pastedStory, synopsis: p.synopsis, story: p.story, status: p.status,
      hasFinalMovie: Boolean(p.finalMedia && p.finalMedia.sizeBytes > 0),
      finalMovie: p.finalMedia ? Object.freeze({ sizeBytes: p.finalMedia.sizeBytes, durationSeconds: p.finalMedia.durationSeconds ?? null, width: p.finalMedia.width ?? null, height: p.finalMedia.height ?? null, sceneCount: p.finalMedia.sceneCount ?? null, hasSubtitles: p.finalMedia.hasSubtitles ?? null }) : null,
      tone: p.tone, targetPlatform: p.targetPlatform, worldBible: p.worldBible,
      storyApproved: p.storyApproved === true, textProvider: p.textProvider,
      narrationSettings: p.narrationSettings, musicSettings: p.musicSettings,
      subtitleSettings: p.subtitleSettings, renderSettings: p.renderSettings, publishingMetadata: p.publishingMetadata,
      revision: p.revision, createdAt: p.createdAt, updatedAt: p.updatedAt,
      // 5C.39 — PIPELINE_COMPLETED / QUALITY_REVIEW_REQUIRED / PUBLISHABLE. Null means never assessed, which
      // is what every movie made before this milestone has, and it reads as unverified rather than as a pass.
      qualityState: p.qualityState ?? null,
      // 5C.45 — which voice the film uses and under what policy. Null narrationSource means nobody has
      // decided yet; it is never inferred from whichever scene happened to run first.
      audioPolicy: p.audioPolicy || "AUTO",
      narrationSource: p.narrationSource ?? null,
      allowMixedVoices: p.allowMixedVoices === true
    });
  }
  function audioForUi(a) {
    return Object.freeze({
      id: a.id, sceneId: a.sceneId, kind: a.kind, provider: a.provider, state: a.state, errorCode: a.errorCode,
      hasMedia: Boolean(a.mediaMeta && a.mediaMeta.sizeBytes > 0),
      media: a.mediaMeta ? Object.freeze({ sizeBytes: a.mediaMeta.sizeBytes, durationSeconds: a.mediaMeta.durationSeconds ?? null, container: a.mediaMeta.container ?? null }) : null,
      createdAt: a.createdAt
    });
  }
  function renderForUi(r) {
    return Object.freeze({
      id: r.id, version: r.version, renderHash: r.renderHash, state: r.state, errorCode: r.errorCode,
      hasFinal: Boolean(r.finalMedia && r.finalMedia.sizeBytes > 0),
      final: r.finalMedia ? Object.freeze({ sizeBytes: r.finalMedia.sizeBytes, durationSeconds: r.finalMedia.durationSeconds ?? null, width: r.finalMedia.width ?? null, height: r.finalMedia.height ?? null }) : null,
      hasThumbnail: Boolean(r.thumbnailMedia), hasSubtitleFile: Boolean(r.subtitleMedia),
      hasPackage: Boolean(r.packageMedia && r.packageMedia.sizeBytes > 0),
      packageSizeBytes: r.packageMedia?.sizeBytes ?? null,
      probe: r.probe ? Object.freeze({ videoCodec: r.probe.videoCodec ?? null, audioCodec: r.probe.audioCodec ?? null, hasAudio: r.probe.hasAudio === true, hasSubtitles: r.probe.hasSubtitles === true, hasMusic: r.probe.hasMusic === true }) : null,
      createdAt: r.createdAt
    });
  }
  function publishForUi(a) {
    return Object.freeze({
      id: a.id, target: a.target, audience: a.audience, state: a.state, submitState: a.submitState,
      postRef: a.postRef, renderId: a.renderId, errorCode: a.errorCode, createdAt: a.createdAt
    });
  }
  function storyAttemptForUi(a) {
    return Object.freeze({ id: a.id, provider: a.provider, state: a.state, submitState: a.submitState, errorCode: a.errorCode, createdAt: a.createdAt });
  }
  function sceneForUi(s) {
    return Object.freeze({
      // 5C.45 — what the clip's own audio turned out to be, and what that meant for the TTS bill.
      sourceAudio: s.audioMeta ? Object.freeze({
        audioClass: s.audioMeta.sourceAudioClass ?? null,
        speechVerdict: s.audioMeta.sourceSpeechVerdict ?? null,
        detectedLanguage: s.audioMeta.detectedLanguage ?? null,
        narrationSource: s.audioMeta.narrationSource ?? null,
        elevenLabsSkipped: s.audioMeta.elevenLabsSkipped === true,
        elevenLabsSkipReason: s.audioMeta.elevenLabsSkipReason ?? null,
        // 5C.47 - eligible and actual are DIFFERENT numbers and are shown as such.
        eligibleForTtsSkip: s.audioMeta.sceneEligibleForTtsSkip === true,
        actuallySkipped: s.audioMeta.sceneActuallySkipped === true,
        filmOverrideReason: s.audioMeta.filmOverrideReason ?? null,
        sourceSpeechMuted: s.audioMeta.muteSourceSpeech === true,
        ambienceRetained: s.audioMeta.ambienceRetained === true
      }) : null,
      id: s.id, ordinal: s.ordinal, heading: s.heading, narration: s.narration, visualDescription: s.visualDescription,
      videoPrompt: s.videoPrompt, durationSeconds: s.durationSeconds, aspectRatio: s.aspectRatio, continuity: s.continuity,
      state: s.state, attemptCount: s.attemptCount, errorCode: s.errorCode, generationJobId: s.generationJobId,
      generationAttemptId: s.generationAttemptId, resultId: s.resultId,
      hasMedia: Boolean(s.mediaMeta && s.mediaMeta.sizeBytes > 0),
      media: s.mediaMeta ? Object.freeze({ sizeBytes: s.mediaMeta.sizeBytes, durationSeconds: s.mediaMeta.durationSeconds ?? null, width: s.mediaMeta.width ?? null, height: s.mediaMeta.height ?? null }) : null,
      trimIn: s.trimIn, trimOut: s.trimOut, transitionType: s.transitionType, transitionSeconds: s.transitionSeconds,
      audioMeta: s.audioMeta ? Object.freeze({ narrationAssetId: s.audioMeta.narrationAssetId ?? null, voiceId: s.audioMeta.voiceId ?? null, durationSeconds: s.audioMeta.durationSeconds ?? null }) : null,
      // 5C.48 — what the narration for THIS scene was measured to say. A coverage figure beside the line is
      // the difference between "a voice was synthesised" and "the voice says this".
      narrationCheck: s.audioMeta && s.audioMeta.narrationVerdict ? Object.freeze({
        verdict: s.audioMeta.narrationVerdict, coverage: s.audioMeta.narrationCoverage ?? null,
        sentenceCoverage: s.audioMeta.narrationSentenceCoverage ?? null,
        detectedLanguage: s.audioMeta.narrationDetectedLanguage ?? null,
        languageMatch: s.audioMeta.narrationLanguageMatch ?? null,
        leadingTruncation: s.audioMeta.narrationLeadingTruncation === true,
        trailingTruncation: s.audioMeta.narrationTrailingTruncation === true,
        verifiedBy: s.audioMeta.narrationVerifiedBy ?? null, errorCode: s.audioMeta.narrationVerifyError ?? null
      }) : null,
      dialogue: s.dialogue, camera: s.camera, lighting: s.lighting,
      revision: s.revision
    });
  }

  /**
   * 5C.48 — the per-scene verdicts a person needs to decide whether to publish: what the judge said about the
   * picture, which contract revision produced it, whether it was repaired, and what the source really was.
   *
   * Read from the artifacts and the repair ledger rather than recomputed, so the UI and the pipeline are
   * quoting the same record.
   */
  async function sceneVerdicts(projectId) {
    const scenes = (await tx((client) => repo.listScenes(client, ws, projectId))).slice().sort((a, b) => a.ordinal - b.ordinal);
    const artifacts = await tx((client) => arepo.listActive(client, ws, projectId));
    const repairs = await tx(async (client) => (await client.query(
      `SELECT scene_id, attempt, state, error_code, generated_contract_id FROM movie_shot_repairs
        WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY attempt`, [ws, projectId])).rows);
    const verdictOf = new Map(artifacts.filter((a) => a.kind === ARTIFACT_KIND.SCENE_VISION_VERDICT).map((a) => [a.sceneId, a]));
    const contractOf = new Map(artifacts.filter((a) => a.kind === ARTIFACT_KIND.SHOT_CONTRACT).map((a) => [a.sceneId, a]));
    return Object.freeze(scenes.map((s) => {
      const v = verdictOf.get(s.id) || null;
      const c = contractOf.get(s.id) || null;
      const rs = repairs.filter((r) => r.scene_id === s.id);
      return Object.freeze({
        sceneId: s.id, ordinal: s.ordinal, heading: s.heading,
        vision: v ? Object.freeze({
          verdict: v.body.verdict ?? null, measured: v.body.measured === true,
          scores: v.body.scores ?? null, blocker: v.body.blocker ?? null, revision: v.revision,
          failedRequirements: (v.body.failedRequirements || []).slice(0, 6)
        }) : null,
        shotContract: c ? Object.freeze({
          revision: c.revision, durationSeconds: c.body.durationSeconds ?? null,
          expectedDurationMs: c.body.expectedDurationMs ?? null,
          repairedFrom: c.body.repairedFrom ?? null, repairAttempt: c.body.repairAttempt ?? null,
          promptSha256: `sha256:${sha256Text(String(c.body.generationPrompt || ""))}`
        }) : null,
        repairs: Object.freeze(rs.map((r) => Object.freeze({ attempt: r.attempt, state: r.state, errorCode: r.error_code, generatedContractId: r.generated_contract_id }))),
        source: s.mediaMeta ? Object.freeze({
          width: s.mediaMeta.width ?? null, height: s.mediaMeta.height ?? null,
          durationSeconds: s.mediaMeta.durationSeconds ?? null,
          requestedDurationSeconds: s.mediaMeta.requestedDurationSeconds ?? null,
          selectedDurationSeconds: s.mediaMeta.selectedDurationSeconds ?? null,
          durationVerdict: s.mediaMeta.durationVerdict ?? null,
          sourceVerdict: s.mediaMeta.sourceVerdict ?? null,
          resolutionSelected: s.mediaMeta.resolutionSelected ?? null
        }) : null
      });
    }));
  }

  // ---------------------------------------------------------------- 5C.26 auto-pipeline orchestration
  // The movie-level durable driver. startMoviePipeline records a PIPELINE_STARTED marker (with presets) and
  // enqueues the PLANNED scenes; advanceMoviePipeline performs ONE idempotent step toward COMPLETED, deriving
  // the current stage purely from durable truth (events + scene states + renders) so it is resume-safe. It
  // NEVER double-submits: scene video uses the frozen invocation guard, it enqueues only PLANNED scenes (never
  // auto-retries FAILED/UNCERTAIN — those BLOCK for an explicit owner retry), and narration/render de-dupe.
  const latestOf = (events, ...types) => { for (let i = events.length - 1; i >= 0; i--) if (types.includes(events[i].type)) return events[i]; return null; };
  const hasEvent = (events, type) => events.some((e) => e.type === type);

  // ============================ duration budget (5C.36) ============================
  //
  // The plan is computed from the SAME durable inputs the render will use, so a preview and a render can
  // never disagree, and it is computed BEFORE any provider call — an impossible budget is a planning
  // answer, not a render failure.
  /**
   * What the finished film actually IS — assembled from the evidence each stage left behind rather than from
   * the pipeline having reached its last step. Two different questions get two different answers here:
   * PIPELINE_COMPLETED (the machine finished) and PUBLISHABLE (the result is good enough to publish).
   *
   * Where this deployment cannot measure a dimension, the dimension reports UNMEASURED and the film goes to a
   * human. Nothing becomes publishable because nobody looked at it.
   */
  /**
   * Judge one scene's picture against the line of narration that plays over it.
   *
   * One real provider call. The claim is written to the database BEFORE the call and the verdict after it, so
   * a crash in between leaves a visible in-flight record rather than an invisible spend — and the idempotency
   * key means the retry resolves to the same judgement instead of buying a second one.
   */
  async function judgeSceneVision({ projectId, sceneId, force = false } = {}) {
    if (!visionActuator) throw cpErr(VISION_ERRORS.NO_ACTUATOR, "This runtime has no vision-capable Grok Chat actuator");
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene) throw cpErr("E_MOVIE_SCENE_NOT_FOUND", "Scene not found");
    if (!scene.mediaMeta || !scene.mediaMeta.relativePath) throw cpErr("E_MOVIE_CLIP_MISSING", "This scene has no generated clip to look at");

    const clipAbs = absOwner(scene.mediaMeta.relativePath);
    if (!existsSync(clipAbs)) throw cpErr("E_MOVIE_CLIP_MISSING", "The scene clip is missing on disk");

    const contract = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId }));
    const shot = contract ? contract.body : {
      // No contract yet: judge against what the scene itself says it should show. Weaker than a contract, and
      // recorded as such by the absent revision — but refusing to look at all would be worse.
      shotId: sceneId, semanticIntent: scene.visualDescription || scene.heading || "", action: scene.visualDescription || "",
      location: null, timeOfDay: null, visibleCharacters: [], requiredObjects: [],
      emotion: null, framing: null, visualStyle: project.visualStyle || null,
      generationPrompt: scene.videoPrompt || scene.visualDescription || ""
    };

    const idempotencyKey = visionIdempotencyKey({
      movieProjectId: projectId, sceneId,
      shotRevision: contract ? contract.revision : 0,
      clipSha256: scene.mediaMeta.sha256 || scene.mediaMeta.relativePath
    });

    // Already judged this exact clip against this exact contract? Then the answer is on file and asking again
    // would spend quota to re-learn it.
    const existing = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sceneId }));
    // Same reasoning on the idempotency short-circuit: replaying a judgement that never happened is not a
    // duplicate call, it is the first one.
    if (!force && existing && existing.body && existing.body.idempotencyKey === idempotencyKey && !existing.body.blocker) {
      return Object.freeze({ projectId, sceneId, idempotent: true, verdict: existing.body.verdict, artifactId: existing.id, revision: existing.revision });
    }

    const adaptation = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.ADAPTATION }));
    const bible = adaptation && adaptation.body ? adaptation.body : {};
    const sheetRel = `movies/${projectId}/vision/${sceneId}.jpg`;
    await mkdir(path.dirname(absOwner(sheetRel)), { recursive: true });

    const result = await judgeShot({
      actuator: visionActuator,
      clipPath: clipAbs,
      sheetPath: absOwner(sheetRel),
      shot,
      narrationText: scene.narration || "",
      characterBible: bible.characterBible || [],
      locationBible: bible.locationBible || [],
      styleBible: bible.styleBible || project.visualStyle || null,
      forbidden: shot.forbiddenElements || []
    });

    if (!result.ok) {
      // A capability failure is recorded as a verdict too. A shot nobody could look at must keep the film out
      // of PUBLISHABLE, and it can only do that if the UNMEASURED verdict is on record.
      const body = { ...visionArtifactBody({ result, shot, narrationText: scene.narration }), idempotencyKey, blocker: result.code };
      const written = await tx((client) => arepo.putArtifact(client, ws, {
        id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sceneId,
        body, creator: CREATOR.SYSTEM, provider: "GROK_CHAT",
        sourceKind: contract ? ARTIFACT_KIND.SHOT_CONTRACT : null,
        sourceArtifactId: contract ? contract.id : null, sourceRevision: contract ? contract.revision : null
      }));
      throw cpErr(result.code, result.reason || "The vision judge could not produce a verdict", { artifactId: written.artifact.id });
    }

    const body = { ...visionArtifactBody({ result, shot, narrationText: scene.narration }), idempotencyKey };
    const written = await tx(async (client) => {
      const a = await arepo.putArtifact(client, ws, {
        id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sceneId,
        body, creator: CREATOR.SYSTEM, provider: "GROK_CHAT",
        sourceKind: contract ? ARTIFACT_KIND.SHOT_CONTRACT : null,
        sourceArtifactId: contract ? contract.id : null, sourceRevision: contract ? contract.revision : null
      });
      await repo.appendEvent(client, ws, projectId, { type: "SCENE_VISION_JUDGED", detail: { sceneId, verdict: body.verdict, measured: body.measured } });
      return a;
    });

    return Object.freeze({
      projectId, sceneId, idempotent: false,
      verdict: body.verdict, measured: body.measured, scores: body.scores,
      failedRequirements: body.failedRequirements, evidence: body.evidence,
      artifactId: written.artifact.id, revision: written.artifact.revision,
      contactSheet: sheetRel
    });
  }

  /**
   * P0 Step 5C.41 - regenerate ONE shot the vision judge rejected.
   *
   * Narrow by construction. The story, the adaptation, the narration, the subtitles and every passing shot are
   * untouched: regenerating any of them would spend quota replacing something correct with something merely
   * different, and would throw away the one thing that makes a repair cheap - that only one thing is wrong.
   *
   * The refined prompt is built from what the judge actually said: the failed requirements plus what it saw
   * instead. Re-sending the original is how a two-attempt budget buys the same wrong shot twice.
   *
   * Durability rides on the ledger that already exists. The claim is written BEFORE the provider call, so a
   * crash leaves a visible in-flight row rather than an invisible spend, and the unique index on
   * (workspace, movie, scene) WHERE state IN (PENDING, CLAIMED, SUBMITTED) means two workers cannot both be
   * regenerating the same shot.
   */
  /**
   * P0 Step 5C.48 — close out repairs whose generation has finished, and recover the ones a crash abandoned.
   *
   * Nothing did this. A repair reached SUBMITTED and stayed there forever, and the partial unique index that
   * stops two workers regenerating the same shot then stopped the SECOND repair attempt too: a film whose
   * first repair produced another rejected shot could never have a second look at it, and the pipeline
   * swallowed E_MOVIE_REPAIR_IN_FLIGHT and rendered the rejected shot.
   *
   * A SUBMIT_UNCERTAIN generation becomes ABANDONED, not FAILED and not retried: the row counts as an
   * attempt, so nothing re-sends a request that may already have been charged.
   */
  async function settleShotRepairs({ projectId } = {}) {
    const rows = await tx(async (client) => (await client.query(
      `SELECT id, scene_id, attempt, state, generation_job_id, generated_contract_id,
              (lease_expires_at IS NOT NULL AND lease_expires_at < now()) AS lease_expired
         FROM movie_shot_repairs
        WHERE workspace_id=$1 AND movie_project_id=$2 AND state IN ('PENDING','CLAIMED','SUBMITTED')`,
      [ws, projectId])).rows);
    const settled = [];
    for (const r of rows) {
      if (r.state === "SUBMITTED" && r.generation_job_id) {
        let gen = null;
        try { gen = await generation.getForUi(r.generation_job_id); } catch { gen = null; }
        if (!gen) continue;
        const next = gen.state === "COMPLETED" ? "COMPLETED"
          : (gen.state === "SUBMIT_UNCERTAIN" ? "ABANDONED"
            : (["FAILED_PRE_SUBMIT", "CANCELLED_BEFORE_SUBMIT", "FAILED"].includes(gen.state) ? "FAILED" : null));
        if (!next) continue;
        await tx(async (client) => {
          await client.query(
            `UPDATE movie_shot_repairs SET state=$3, error_code=$4, completed_at=now(), updated_at=now(),
                    lease_owner=NULL, lease_expires_at=NULL, revision=revision+1
              WHERE workspace_id=$1 AND id=$2 AND state='SUBMITTED'`,
            [ws, r.id, next, next === "COMPLETED" ? null : (gen.errorCode || (next === "ABANDONED" ? "E_SCENE_SUBMIT_UNCERTAIN" : "E_SCENE_FAILED"))]);
          await repo.appendEvent(client, ws, projectId, { type: "SCENE_REPAIR_SETTLED", detail: { sceneId: r.scene_id, attempt: r.attempt, state: next } });
        });
        settled.push({ repairId: r.id, sceneId: r.scene_id, state: next });
        continue;
      }
      // A claim whose lease has expired with nothing generated: the runtime died between the claim and the
      // provider call. Nothing was spent, so the row stays claimable rather than blocking the shot forever.
      if (r.state !== "SUBMITTED" && r.lease_expired === true && !r.generated_contract_id) {
        await tx(async (client) => {
          await client.query(
            `UPDATE movie_shot_repairs SET lease_owner=NULL, lease_expires_at=NULL, updated_at=now(), revision=revision+1
              WHERE workspace_id=$1 AND id=$2 AND state IN ('PENDING','CLAIMED')`, [ws, r.id]);
        });
        settled.push({ repairId: r.id, sceneId: r.scene_id, state: "RECLAIMABLE" });
      }
    }
    return Object.freeze({ projectId, settled: Object.freeze(settled) });
  }

  async function repairScene({ projectId, sceneId, leaseOwner = "movie-pipeline", leaseMs = 15 * 60 * 1000 } = {}) {
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    // Finished and abandoned repairs are closed out FIRST, so the in-flight guard below is answering a
    // question about now rather than about a runtime that is no longer running.
    await settleShotRepairs({ projectId });
    const scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    const scene = scenes.find((x) => x.id === sceneId);
    if (!scene) throw cpErr("E_MOVIE_SCENE_NOT_FOUND", "Scene not found");

    const verdictArt = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sceneId }));
    const verdict = verdictArt ? verdictArt.body : null;
    if (!verdict || verdict.verdict !== VISION_VERDICT.REGENERATE) {
      // Only a shot the judge actually rejected is repaired. A PASS is left alone and an UNMEASURED goes to a
      // human, because "we could not look" is not evidence that the picture is wrong.
      throw cpErr("E_MOVIE_SCENE_NOT_REPAIRABLE", `scene verdict is ${verdict ? verdict.verdict : "absent"}, not REGENERATE`);
    }

    const contract = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId }));
    const adaptation = await tx((client) => arepo.getActive(client, ws, { movieProjectId: projectId, kind: ARTIFACT_KIND.ADAPTATION }));

    // Claim state is read BEFORE the prompt is refined, because a resumed attempt must not refine again: the
    // active contract would then be the already-refined revision and refining it a second time produces a
    // third set of words that no ledger row was decided from.
    const existing = await tx(async (client) => (await client.query(
      `SELECT id, attempt, state, generated_contract_id FROM movie_shot_repairs
        WHERE workspace_id=$1 AND movie_project_id=$2 AND scene_id=$3 AND state IN ('PENDING','CLAIMED','SUBMITTED')
        ORDER BY attempt DESC LIMIT 1`, [ws, projectId, sceneId])).rows[0] || null);
    if (existing && (existing.state === "SUBMITTED" || existing.generated_contract_id)) {
      throw cpErr("E_MOVIE_REPAIR_IN_FLIGHT", "a repair for this shot is already in flight");
    }
    const prior = await tx(async (client) => (await client.query(
      "SELECT count(*)::int n FROM movie_shot_repairs WHERE workspace_id=$1 AND movie_project_id=$2 AND scene_id=$3", [ws, projectId, sceneId])).rows[0].n);
    const resuming = Boolean(existing);
    const attempt = resuming ? Number(existing.attempt) : Number(prior) + 1;
    if (attempt > REPAIR_POLICY.maxAttemptsPerShot) {
      throw cpErr("E_MOVIE_REPAIR_EXHAUSTED", `this shot has already been repaired ${prior} times`);
    }

    // The revision this attempt already wrote, if a crash interrupted it after that point. Identified by the
    // attempt number it carries — no second column needed, and two revisions can never claim the same attempt.
    const ownContract = resuming && contract && contract.body && Number(contract.body.repairAttempt) === attempt ? contract : null;

    const shot = ownContract ? ownContract.body : (contract ? contract.body : {
      shotId: sceneId, semanticIntent: scene.visualDescription || "", action: scene.visualDescription || "",
      visibleCharacters: [], requiredObjects: [], visualStyle: project.visualStyle || null,
      generationPrompt: scene.videoPrompt || scene.visualDescription || "",
      // 5C.42 — a contract without a length is a contract the regeneration cannot honour, so revision 1 states
      // it explicitly even when it is only inheriting what the scene already said.
      durationSeconds: scene.durationSeconds
    });

    const refined = ownContract ? String(ownContract.body.generationPrompt || "") : refineShotPrompt({
      shot, verdict: { failedDimensions: (verdict.failedRequirements || []).map((r) => ({ dimension: String(r).split(" ")[0], detail: r })), evidence: verdict.evidence || [] },
      characterBible: (adaptation && adaptation.body && adaptation.body.characterBible) || []
    });
    if (!refined || (!ownContract && refined === shot.generationPrompt)) {
      throw cpErr("E_MOVIE_REPAIR_PROMPT_UNCHANGED", "the retry prompt is identical to the one that already failed");
    }
    const idem = sha256Text(`repair|${projectId}|${sceneId}|${contract ? contract.revision : 0}|${attempt}`);

    const claim = resuming
      ? await tx(async (client) => {
        // Re-take the lease only while it is still free: two workers arriving together must not both proceed.
        const r = await client.query(
          `UPDATE movie_shot_repairs SET state='CLAIMED', lease_owner=$3,
                  lease_expires_at = now() + ($4 || ' milliseconds')::interval, updated_at=now(), revision=revision+1
            WHERE workspace_id=$1 AND id=$2 AND state IN ('PENDING','CLAIMED')
              AND (lease_expires_at IS NULL OR lease_expires_at < now()) RETURNING id`,
          [ws, existing.id, leaseOwner, String(leaseMs)]);
        return r.rowCount === 1 ? r.rows[0].id : null;
      })
      : await tx(async (client) => {
        const r = await client.query(
          `INSERT INTO movie_shot_repairs
             (workspace_id, id, movie_project_id, scene_id, attempt, idempotency_key, reason, failed_requirements,
              vision_verdict_id, shot_contract_id, state, lease_owner, lease_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CLAIMED',$11, now() + ($12 || ' milliseconds')::interval)
           ON CONFLICT DO NOTHING RETURNING id`,
          [ws, newRepairId(), projectId, sceneId, attempt, idem, "VISION_REGENERATE",
           JSON.stringify(verdict.failedRequirements || []), verdictArt ? verdictArt.id : null,
           contract ? contract.id : null, leaseOwner, String(leaseMs)]);
        return r.rowCount === 1 ? r.rows[0].id : null;
      });
    if (!claim) throw cpErr("E_MOVIE_REPAIR_IN_FLIGHT", "a repair for this shot is already in flight");

    // The prompt is an artifact too: a new shot-contract revision, so the old one stays readable and the new
    // clip can be traced to the words that produced it.
    //
    // On a resume the revision this attempt already wrote is REUSED. Writing another would leave two revisions
    // claiming to be attempt N and make "one invocation per revision" unprovable.
    const newContract = ownContract ? { artifact: ownContract } : await tx((client) => arepo.putArtifact(client, ws, {
      id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId,
      body: { ...shot, generationPrompt: refined, repairedFrom: contract ? contract.revision : null, repairAttempt: attempt,
              // Stated, never inherited by accident: the regeneration reads its length from THIS revision, so a
              // revision that does not carry one would send the repair back to the scene row — the length that
              // belonged to the clip being replaced.
              durationSeconds: Number.isFinite(Number(shot.durationSeconds)) && Number(shot.durationSeconds) > 0
                ? Number(shot.durationSeconds) : scene.durationSeconds,
              failedRequirements: verdict.failedRequirements || [] },
      creator: CREATOR.SCHEDULER,
      sourceKind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sourceArtifactId: verdictArt ? verdictArt.id : null,
      sourceRevision: verdictArt ? verdictArt.revision : null
    }));

    // Regenerate exactly this scene, through the path that already selects 720p and 9:16 and reserves the one
    // invocation. Nothing else about the movie is touched.
    //
    // 5C.48 — generateScene now reads the prompt from the ACTIVE contract, which is the revision just written,
    // so the regeneration is asking for the refined shot by construction rather than by side effect. The scene
    // row is still updated: it is what the UI reads, and leaving it stale would show the failed prompt beside
    // the new clip. The scene is reopened because generateScene is idempotent for a COMPLETED scene.
    //
    // The previous clip is not lost: it stays on disk, and the shot-contract revision that produced it stays
    // readable, so the old attempt remains explicable after the new one overwrites the scene's media pointer.
    const refinedSha = `sha256:${sha256Text(refined)}`;
    // A resumed repair may already have enqueued its generation before the crash. If the scene is holding a
    // live job for exactly these words, that job IS this repair — adopting it is the difference between
    // restart-safety and paying twice.
    const liveJob = resuming && scene.generationJobId && sha256Text(String(scene.videoPrompt || "")) === sha256Text(refined)
      && ["QUEUED", "GENERATING", "COMPLETED"].includes(scene.state) ? scene.generationJobId : null;

    if (!liveJob) {
      await tx(async (client) => {
        await repo.updateScene(client, ws, sceneId, { patch: { videoPrompt: refined, state: "PLANNED", errorCode: null } });
      });
    }

    let out;
    try {
      out = liveJob ? { sceneId, jobId: liveJob, adopted: true, promptSource: "SHOT_CONTRACT", promptSha256: refinedSha }
        : await generateScene({ projectId, sceneId });
      // A repair that enqueued nothing is a failure, not a submission. Marking it SUBMITTED regardless is what
      // made the first attempt look like it had worked.
      if (!out || !out.jobId) {
        throw cpErr("E_MOVIE_REPAIR_NOT_ENQUEUED", `generateScene did not start a job (${out ? JSON.stringify(out).slice(0, 120) : "no result"})`);
      }
      // And a repair that enqueued the WRONG WORDS is a failure too. This is the assertion the first
      // implementation lacked: it reported SUBMITTED for a job carrying the prompt that had already failed.
      if (out.promptSha256 && out.promptSha256 !== refinedSha) {
        throw cpErr("E_MOVIE_REPAIR_PROMPT_NOT_USED", "the generation did not carry the refined prompt of the active contract revision");
      }
    } catch (e) {
      await tx((client) => client.query(
        "UPDATE movie_shot_repairs SET state='FAILED', error_code=$3, updated_at=now(), revision=revision+1 WHERE workspace_id=$1 AND id=$2",
        [ws, claim, String(e.code || "E_MOVIE_REPAIR_GENERATION_FAILED").slice(0, 60)]));
      throw e;
    }

    await tx(async (client) => {
      // generated_contract_id is UNIQUE per workspace: this write is what makes "one provider invocation per
      // shot-contract revision" a fact the database enforces rather than a property of the happy path.
      await client.query(
        `UPDATE movie_shot_repairs SET state='SUBMITTED', generation_job_id=$3, generated_contract_id=$4,
                updated_at=now(), revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
        [ws, claim, out.jobId, newContract.artifact.id]);
      await repo.appendEvent(client, ws, projectId, { type: "SCENE_REPAIR_SUBMITTED", detail: { sceneId, attempt, contractRevision: newContract.artifact.revision, durationSeconds: newContract.artifact.body.durationSeconds ?? null, promptSha256: refinedSha, adopted: out.adopted === true } });
    });

    return Object.freeze({
      projectId, sceneId, attempt, repairId: claim,
      shotContractRevision: newContract.artifact.revision,
      shotContractId: newContract.artifact.id,
      previousContractRevision: contract ? contract.revision : null,
      durationSeconds: newContract.artifact.body.durationSeconds ?? null,
      refinedPrompt: refined.slice(0, 400), refinedPromptSha256: refinedSha,
      promptSource: out.promptSource || null,
      resumed: resuming, adoptedExistingJob: out.adopted === true,
      failedRequirements: verdict.failedRequirements || [],
      jobId: out.jobId
    });
  }


  /**
   * P0 Step 5C.45 - listen to the clip before paying to speak over it.
   *
   * Every Grok clip carries an audio track. Until this gate existed the pipeline synthesised narration for
   * every scene without ever decoding one, which is either a wasted TTS call or a film with two voices in it,
   * and nobody could tell which because nobody had listened.
   *
   * Read-only and local: ffmpeg over a file already on disk. No provider call of any kind happens here - that
   * is the entire point, since this runs BEFORE the decision to call one.
   *
   * The verdict is deliberately hard to satisfy. Only a transcript that demonstrably reads this scene's
   * narration can turn ElevenLabs off; everything else, including every "we could not measure it", keeps the
   * synthesised voice. Being wrong in that direction costs a few cents. Being wrong in the other direction
   * ships a film that says the wrong words.
   */
  async function inspectSceneSourceAudio({ projectId, sceneId, transcriptProvider = undefined } = {}) {
    const stts = transcriptProvider === undefined ? stt : transcriptProvider;
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    const scene = scenes.find((x) => x.id === sceneId);
    if (!scene) throw cpErr("E_MOVIE_SCENE_NOT_FOUND", "Scene not found");
    if (!scene.mediaMeta || !scene.mediaMeta.relativePath) {
      throw cpErr("E_MOVIE_CLIP_MISSING", "This scene has no generated clip whose audio could be inspected");
    }
    const clip = absOwner(scene.mediaMeta.relativePath);
    if (!existsSync(clip)) throw cpErr("E_MOVIE_CLIP_MISSING", "The scene clip is missing on disk");

    let measurement = null, measureError = null;
    try { measurement = await measureAudio(clip); }
    catch (e) { measureError = String(e && (e.code || e.message)).slice(0, 80); }

    const intended = String(scene.narration || "");
    const klass = classifySourceAudio(measurement, { intendedNarration: intended });

    // A transcript, if and ONLY if this runtime has a local capability. There is none today, and the absence
    // is recorded as a verdict rather than quietly skipped - "nobody listened" has to be visible, because it
    // is the reason ElevenLabs is still being paid.
    let transcript = null, sttAvailable = false, detectedLanguage = null, intelligibility = null, sttRecord = null;
    if (stts && typeof stts.transcribeLocal === "function" && (typeof stts.available !== "function" || stts.available()) && needsTranscript(klass.class)) {
      try {
        const t = await stts.transcribeLocal({ audioPath: clip });
        if (t && typeof t.text === "string") {
          transcript = t.text; sttAvailable = true;
          detectedLanguage = t.detectedLanguage || null;
          intelligibility = Number.isFinite(t.confidence) ? t.confidence : null;
          sttRecord = t;
        }
      } catch { transcript = null; sttAvailable = false; }
    }

    const match = matchNarration({
      transcript, intendedNarration: intended,
      expectedLanguage: project.language || null, detectedLanguage,
      sttAvailable, intelligibility,
      transcriptConfidence: sttRecord ? sttRecord.confidence : null,
      noSpeechProbability: sttRecord ? sttRecord.noSpeechProbability : null,
      timestampCoverage: sttRecord && sttRecord.words && sttRecord.words.length && sttRecord.durationSeconds
        ? Math.min(1, (sttRecord.words[sttRecord.words.length - 1].end - sttRecord.words[0].start) / sttRecord.durationSeconds) : null,
      // A class the energy already settled as having no voice reads NO_SPEECH rather than "nobody
      // listened": the transcript was skipped because the question was already answered.
      speechDetected: [SOURCE_AUDIO_CLASS.SILENCE, SOURCE_AUDIO_CLASS.NONE, SOURCE_AUDIO_CLASS.AMBIENCE_ONLY,
        SOURCE_AUDIO_CLASS.SFX_ONLY, SOURCE_AUDIO_CLASS.AMBIENCE_AND_SFX].includes(klass.class) ? false : null,
      characterNames: Array.isArray(project.characterBible) ? project.characterBible.map((c) => c && c.name).filter(Boolean) : []
    });

    const decision = decideSceneAudio({
      audioClass: klass.class, narrationVerdict: match.verdict,
      hasIntendedNarration: intended.trim().length > 0,
      policy: project.audioPolicy || AUDIO_POLICY.AUTO,
      // Subtitles can only be cut from the clip's own audio if something aligned it. Nothing has.
      // Real word timings spanning enough of the shot to caption it - not merely "a provider exists".
      alignmentAvailable: Boolean(sttRecord && Array.isArray(sttRecord.words) && sttRecord.words.length > 0
        && sttRecord.durationSeconds && ((sttRecord.words[sttRecord.words.length - 1].end - sttRecord.words[0].start) / sttRecord.durationSeconds) >= 0.35)
    });

    const body = {
      sceneId, ordinal: scene.ordinal,
      sourceHash: scene.mediaMeta.sha256 || scene.mediaMeta.sourceHash || null,
      measurement: measurement ? {
        hasAudio: measurement.hasAudio, audioCodec: measurement.audioCodec, sampleRate: measurement.sampleRate,
        channels: measurement.channels, channelLayout: measurement.channelLayout,
        audioDurationSeconds: measurement.audioDurationSeconds, videoDurationSeconds: measurement.videoDurationSeconds,
        audioVideoDriftSeconds: measurement.audioVideoDriftSeconds,
        silenceRatio: measurement.silenceRatio, integratedLufs: measurement.integratedLufs,
        truePeakDbtp: measurement.truePeakDbtp, loudnessRange: measurement.loudnessRange,
        rmsDb: measurement.rmsDb, speechBandRatio: measurement.speechBandRatio
      } : null,
      measureError,
      sourceAudioClass: klass.class, sourceAudioReason: klass.reason,
      sourceSpeechVerdict: match.verdict, sourceSpeechReason: match.reason,
      // The transcript itself is NOT written here. Only its hash: an operational record must not become the
      // place a private transcript lives, and the artifact store has its own rules for content.
      sourceTranscriptHash: match.evidence.transcriptHash || null,
      detectedLanguage: match.evidence.detectedLanguage || null,
      transcriptConfidence: sttRecord ? sttRecord.confidence : null,
      noSpeechProbability: sttRecord ? sttRecord.noSpeechProbability : null,
      timestampCoverage: match.evidence.timestampCoverage ?? null,
      sttEngine: sttRecord ? `${sttRecord.engine}:${sttRecord.model}` : null,
      sttProcessingSeconds: sttRecord ? sttRecord.processingSeconds : null,
      wordCount: sttRecord && Array.isArray(sttRecord.words) ? sttRecord.words.length : 0,
      segmentCount: sttRecord && Array.isArray(sttRecord.segments) ? sttRecord.segments.length : 0,
      expectedLanguage: match.evidence.expectedLanguage || null,
      coverage: match.evidence.coverage ?? null,
      selectedAudioPolicy: decision.policy, sceneDecision: decision.decision,
      narrationSource: decision.narrationSource,
      elevenLabsSkipped: decision.elevenLabsSkipped === true,
      elevenLabsSkipReason: decision.elevenLabsSkipReason || null,
      sourceAudioGainDb: decision.sourceAudioGainDb, duckingApplied: decision.duckingApplied === true,
      muteSourceSpeech: decision.muteSourceSpeech === true
    };

    const written = await tx(async (client) => {
      const a = await arepo.putArtifact(client, ws, {
        id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.SOURCE_AUDIO_AUDIT, sceneId,
        body, creator: CREATOR.SYSTEM
      });
      // The compact findings ride on the scene too, so the UI can show what the clip's audio turned out to be
      // without joining the artifact store for every row.
      await repo.updateScene(client, ws, sceneId, { patch: { audioMeta: {
        ...(scene.audioMeta || {}),
        sourceAudioClass: body.sourceAudioClass,
        sourceSpeechVerdict: body.sourceSpeechVerdict,
        sourceTranscriptHash: body.sourceTranscriptHash,
        detectedLanguage: body.detectedLanguage,
        selectedAudioPolicy: body.selectedAudioPolicy,
        narrationSource: body.narrationSource,
        elevenLabsSkipped: body.elevenLabsSkipped,
        elevenLabsSkipReason: body.elevenLabsSkipReason,
        sourceAudioGainDb: body.sourceAudioGainDb,
        duckingApplied: body.duckingApplied,
        muteSourceSpeech: body.muteSourceSpeech
      } } });
      return a;
    });
    return Object.freeze({ ...decision, sceneId, ordinal: scene.ordinal, audioClass: klass.class, narrationVerdict: match.verdict, artifactId: written.artifact.id, body });
  }

  /**
   * The whole film's audio routing, decided once.
   *
   * A narration source is a property of the film. One scene in the clip's own voice and the next in a
   * synthesised one is not a style, it is a defect, so a single scene that cannot use its own audio pulls
   * every other scene onto the safe source.
   */
  async function planMovieAudioRouting({ projectId, transcriptProvider = undefined } = {}) {
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const scenes = (await tx((client) => repo.listScenes(client, ws, projectId))).slice().sort((a, b) => a.ordinal - b.ordinal);
    const perScene = [];
    for (const sc of scenes) {
      if (!sc.mediaMeta || !sc.mediaMeta.relativePath) continue;
      try { perScene.push(await inspectSceneSourceAudio({ projectId, sceneId: sc.id, transcriptProvider })); }
      catch (e) { perScene.push(Object.freeze({ sceneId: sc.id, ordinal: sc.ordinal, decision: AUDIO_DECISION.UNMEASURED, narrationSource: NARRATION_SOURCE.ELEVENLABS, elevenLabsSkipped: false, reason: String(e && (e.code || e.message)).slice(0, 80) })); }
    }
    const movie = decideMovieAudio({
      sceneDecisions: perScene, policy: project.audioPolicy || AUDIO_POLICY.AUTO,
      allowMixedVoices: project.allowMixedVoices === true
    });
    // 5C.47 - the film overrules the scene, and the ledger records what HAPPENED rather than what was
    // possible. Counting the raw scene decisions reported a saving for a scene that was then synthesised
    // anyway, which is how a report comes to disagree with the invoice.
    const effective = applyFilmDecision(perScene, movie);
    const subtitles = subtitleSourceFor(movie.narrationSource);
    const savings = ttsSavings(effective);

    await tx(async (client) => {
      await arepo.putArtifact(client, ws, {
        id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.AUDIO_ROUTING_DECISION,
        body: {
          policy: project.audioPolicy || AUDIO_POLICY.AUTO,
          narrationSource: movie.narrationSource, consistent: movie.consistent === true,
          requiresReview: movie.requiresReview === true, reason: movie.reason,
          overriddenScenes: movie.overridden || [],
          subtitleSource: subtitles.source, subtitleReason: subtitles.reason,
          scenes: effective.map((d) => ({
            sceneId: d.sceneId, ordinal: d.ordinal, decision: d.decision,
            audioClass: d.audioClass || null, narrationVerdict: d.narrationVerdict || null,
            sceneEligibleForTtsSkip: d.sceneEligibleForTtsSkip === true,
            sceneActuallySkipped: d.sceneActuallySkipped === true,
            filmOverrideReason: d.filmOverrideReason || null,
            sourceSpeechMuted: d.effectiveMuteSourceSpeech === true,
            ambienceRetained: d.effectiveKeepSourceAudio === true
          })),
          ttsCallsRequired: savings.ttsCallsRequired,
          eligibleTtsSkips: savings.eligibleForSkip, actualTtsSkips: savings.actualSkipped,
          overriddenByFilm: savings.overriddenByFilm, unmeasuredScenes: savings.unmeasuredScenes
        },
        creator: CREATOR.SYSTEM
      });
      await repo.updateProject(client, ws, projectId, { patch: { narrationSource: movie.narrationSource } });
      await repo.appendEvent(client, ws, projectId, { type: "AUDIO_ROUTING_DECIDED", detail: { narrationSource: movie.narrationSource, ttsSkipped: savings.elevenLabsSkipped, scenes: perScene.length } });
    });

    // Write the effective per-scene outcome back, so the UI and the assembler read the same story.
    for (const d of effective) {
      if (!d || !d.sceneId) continue;
      const sc = scenes.find((x) => x.id === d.sceneId);
      if (!sc) continue;
      await tx((client) => repo.updateScene(client, ws, d.sceneId, { patch: { audioMeta: {
        ...(sc.audioMeta || {}),
        narrationSource: d.effectiveNarrationSource,
        sceneEligibleForTtsSkip: d.sceneEligibleForTtsSkip === true,
        sceneActuallySkipped: d.sceneActuallySkipped === true,
        elevenLabsSkipped: d.sceneActuallySkipped === true,
        filmOverrideReason: d.filmOverrideReason || null,
        muteSourceSpeech: d.effectiveMuteSourceSpeech === true,
        ambienceRetained: d.effectiveKeepSourceAudio === true
      } } }));
    }
    return Object.freeze({ projectId, ...movie, subtitles, savings, scenes: effective });
  }

  async function movieQuality({ projectId } = {}) {
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const renders = await tx((client) => crepo.listRenders(client, ws, projectId));
    const latest = renders.filter((r) => r.state === "COMPLETED").sort((a, b) => b.version - a.version)[0] || null;
    const master = latest && latest.probe && latest.probe.master ? latest.probe.master : null;
    let plan = null;
    try { plan = await planMovieDuration({ projectId }); } catch { plan = null; }
    let voice = null;
    try { voice = assessMovieVoice({ locale: project.language, voiceId: (project.narrationSettings || {}).voiceId || null }); } catch { voice = null; }
    // 5C.39 — the scorecard now reads real artifacts. Anything with no artifact stays null, and null is
    // UNMEASURED: a review trigger, never a pass. That is the whole difference between "the pipeline finished"
    // and "someone can defend this".
    const artifacts = await tx((client) => arepo.listActive(client, ws, projectId));
    const byKind = new Map(artifacts.filter((a) => !a.sceneId).map((a) => [a.kind, a]));
    const perScene = artifacts.filter((a) => a.sceneId);

    const adaptationArtifact = byKind.get(ARTIFACT_KIND.ADAPTATION) || null;
    const transcriptArtifact = byKind.get(ARTIFACT_KIND.TRANSCRIPT_VERIFICATION) || null;
    const subtitleArtifact = byKind.get(ARTIFACT_KIND.SUBTITLE_TIMELINE) || null;

    // One vision verdict per scene. A film is only as verified as its least-verified shot, so a single
    // UNMEASURED scene keeps the whole film out of PUBLISHABLE rather than being averaged away.
    const visionVerdicts = perScene
      .filter((a) => a.kind === ARTIFACT_KIND.SCENE_VISION_VERDICT)
      .map((a) => ({ shotId: a.sceneId, ...(a.body || {}) }));
    const shotContracts = perScene.filter((a) => a.kind === ARTIFACT_KIND.SHOT_CONTRACT);

    const scorecard = buildMovieScorecard({
      adaptation: adaptationArtifact ? adaptationArtifact.body : null,
      adaptationValidation: adaptationArtifact ? (adaptationArtifact.body?.gate?.ok !== false) : null,
      transcript: transcriptArtifact ? transcriptArtifact.body : null,
      subtitleDrift: subtitleArtifact ? subtitleArtifact.body.drift : null,
      shotFidelity: shotContracts.length ? { ok: true, shots: shotContracts.map((a) => ({ expectedDurationMs: a.body?.expectedDurationMs ?? null })) } : null,
      shotSemantics: visionVerdicts.map((v) => ({
        shotId: v.shotId,
        semanticScore: v.scores?.semanticMatch ?? null,
        characterScore: v.scores?.characterMatch ?? null,
        styleScore: v.scores?.styleMatch ?? null,
        // measured:false is what makes an unjudged shot block publication instead of vanishing from the average.
        measured: v.measured === true
      })),
      timelineCoverage: subtitleArtifact ? { ok: true } : null,
      audioMix: byKind.has(ARTIFACT_KIND.AUDIO_MIX_VERDICT) ? byKind.get(ARTIFACT_KIND.AUDIO_MIX_VERDICT).body : null,
      master
    });
    // The voice verdict rides alongside rather than inside: capability says the voice CAN speak the locale,
    // which is a different claim from what the finished audio actually says. Only a transcript settles that,
    // and until one exists voiceCorrectness stays UNMEASURED.
    // Persist the verdict. A scorecard computed and thrown away is a scorecard nobody can be held to, and the
    // UI, the publish path and the owner all need to read the same answer.
    let persisted = null;
    if (contentAlignmentEnabled && latest) {
      try {
        persisted = await tx(async (client) => {
          const card = await arepo.putArtifact(client, ws, {
            id: newArtifactId(), movieProjectId: projectId, kind: ARTIFACT_KIND.MOVIE_SCORECARD,
            body: { state: scorecard.state, publishable: scorecard.publishable === true,
                    blocking: scorecard.blocking, failedHard: scorecard.failedHardDimensions,
                    unmeasuredHard: scorecard.unmeasuredHardDimensions, renderVersion: latest.version },
            creator: CREATOR.SYSTEM
          });
          await arepo.setQualityState(client, ws, projectId, { state: scorecard.state, scorecardId: card.artifact.id });
          return card.artifact.id;
        });
      } catch { persisted = null; }
    }

    return Object.freeze({
      projectId, state: scorecard.state,
      publishable: scorecard.publishable === true,
      renderVersion: latest ? latest.version : null,
      scorecardId: persisted,
      artifacts: Object.freeze(artifacts.map((a) => ({ kind: a.kind, sceneId: a.sceneId, revision: a.revision, contentHash: a.contentHash, creator: a.creator }))),
      visionVerdicts: Object.freeze(visionVerdicts.map((v) => ({ shotId: v.shotId, verdict: v.verdict ?? null, measured: v.measured === true }))),
      scorecard, master, voice, plan
    });
  }

  async function planMovieDuration({ projectId, targetDurationSeconds = null, clipDurations = null } = {}) {
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    const scenes = (await tx((client) => repo.listScenes(client, ws, projectId))).slice().sort((a, b) => a.ordinal - b.ordinal);
    if (!scenes.length) throw cpErr("E_MOVIE_NO_SCENES", "No scenes to plan");
    // Measured clip lengths when the clips exist; nulls before generation, which the planner handles.
    const measured = Array.isArray(clipDurations) ? clipDurations : scenes.map((sc) => {
      const d = sc.mediaMeta && Number(sc.mediaMeta.durationSeconds);
      return Number.isFinite(d) && d > 0 ? d : null;
    });
    return planDurationBudget({
      targetDurationSeconds: Number(targetDurationSeconds) || project.targetDurationSeconds,
      scenes: scenes.map((sc) => ({ ordinal: sc.ordinal, narration: sc.narration, heading: sc.heading })),
      locale: normalizeLocale(project.language) || "en-US",
      clipDurations: measured.some((x) => Number.isFinite(x)) ? measured : null
    });
  }

  // The voice question, answered before the provider is touched. A fallback is a decision the owner makes,
  // not one the pipeline makes quietly on their behalf.
  function voiceNameFor(voiceId) {
    if (typeof resolveVoiceName === "function") {
      try { const nm = resolveVoiceName(voiceId); if (typeof nm === "string" && nm.trim()) return nm.trim(); } catch { /* a resolver failure means UNKNOWN, not native */ }
    }
    if (Array.isArray(voiceCatalogue) && typeof voiceId === "string") {
      const id = voiceId.includes(":") ? voiceId.split(":").pop() : voiceId;
      const hit = voiceCatalogue.find((v) => v && (v.voiceId === id || v.id === id));
      if (hit && (hit.displayName || hit.name)) return String(hit.displayName || hit.name);
    }
    return null;
  }

  function assessMovieVoice({ locale, voiceId = null, voiceName = null }) {
    // A voiceId of the form "elevenlabs-api:<id>" carries no language; the NAME is what identifies the
    // recorded voice, so the id is resolved first and an unresolvable one is reported as an unknown voice
    // rather than assumed native.
    const name = voiceName || voiceNameFor(voiceId) || (typeof voiceId === "string" && voiceId.includes(":") ? null : voiceId);
    return assessVoiceCapability({ locale: normalizeLocale(locale), voiceName: name, voiceId, catalogue: voiceCatalogue });
  }

  function normalizePresets(p = {}) {
    const narrationEnabled = p.narrationEnabled !== false;
    const m = p.music || {};
    return {
      // P0 Step 5C.48 — run the CONTENT stages before generation: adaptation, narration, alignment,
      // subtitles, shot contracts, and only then Grok Imagine.
      //
      // Opt-in, because the order is not a preference — it changes what is knowable when. A shot's length can
      // only come from its narration's measured length if the narration exists first, and a film that
      // generates pictures first can never do anything but trim them afterwards. It is a FLAG rather than the
      // new default so the pipelines already on this deployment keep the exact behaviour they have today.
      contentFirst: p.contentFirst === true,
      adaptationProvider: p.adaptationProvider === "LOCAL" ? "LOCAL" : "GROK_CHAT",
      adaptationFormat: ADAPTATION_FORMATS[p.adaptationFormat] || ADAPTATION_FORMATS.SHORT_FORM_3BEAT,
      beatCount: Number.isFinite(p.beatCount) ? Math.max(2, Math.min(8, Math.round(p.beatCount))) : 3,
      sourceLocale: typeof p.sourceLocale === "string" && p.sourceLocale ? p.sourceLocale.slice(0, 12) : null,
      localeRationale: typeof p.localeRationale === "string" ? p.localeRationale.slice(0, 300) : "",
      narrationEnabled,
      voiceId: narrationEnabled && typeof p.voiceId === "string" && p.voiceId ? p.voiceId : null,
      rate: Number.isFinite(p.rate) ? Number(p.rate) : 0,
      subtitleEnabled: p.subtitleEnabled !== false,
      subtitleMode: p.subtitleMode === "burn" || p.subtitleMode === "none" ? p.subtitleMode : "embed",
      music: m.source && String(m.source).toUpperCase() !== "NONE"
        ? { source: "AMBIENT", style: String(m.style || "CALM").toUpperCase(), volume: Number.isFinite(m.volume) ? m.volume : 0.4 }
        : { source: "NONE" },
      // 5C.36 — whether an unattended run may accept a non-native voice, and which locales the owner has
      // already looked at and agreed to. Both default to "no": silence is not consent.
      allowFallbackVoice: p.allowFallbackVoice === true,
      confirmedFallbackLocales: Array.isArray(p.confirmedFallbackLocales)
        ? p.confirmedFallbackLocales.filter((x) => typeof x === "string" && /^[a-z]{2}-[A-Z]{2}$/u.test(x)).slice(0, 20)
        : []
    };
  }

  async function enqueuePlannedScenes({ projectId }) {
    const scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    let started = 0;
    for (const s of scenes) if (s.state === "PLANNED") { try { await generateScene({ sceneId: s.id }); started += 1; } catch { /* per-scene best-effort; a straggler re-enqueues next tick */ } }
    return { started };
  }

  // Stop auto-progression for a project. SAFE by design: it only records a PIPELINE_CANCELLED marker (the
  // orchestrator then skips it — no more narration/music/subtitles/render). It does NOT abort in-flight Grok
  // scene generations, because a possibly-submitted attempt must never be blind-cancelled (double-charge
  // risk); those complete durably and are simply not rendered. Already-COMPLETED work + artifacts are kept.
  async function cancelMoviePipeline({ projectId } = {}) {
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    await tx(async (client) => { await repo.appendEvent(client, ws, projectId, { type: "PIPELINE_CANCELLED", detail: {} }); });
    return { projectId, cancelled: true };
  }

  async function startMoviePipeline({ projectId, presets = {} } = {}) {
    execGate.assertRunning("startMoviePipeline");
    await ensureWs();
    const project = await tx((client) => repo.getProject(client, ws, projectId));
    if (!project) throw cpErr("E_MOVIE_NOT_FOUND", "Project not found");
    if (!project.story) throw cpErr("E_MOVIE_STORY_REQUIRED", "The project has no story to adapt into a movie");
    const norm = normalizePresets(presets);
    let scenes = await tx((client) => repo.listScenes(client, ws, projectId));
    // A content-first film has its scenes written by the ADAPTATION stage, one per beat. Planning a storyboard
    // here would create scenes the adaptation never asked for and then generate pictures for them.
    if (scenes.length === 0 && !norm.contentFirst) { await planStoryboard({ projectId }); scenes = await tx((client) => repo.listScenes(client, ws, projectId)); }
    if (scenes.length === 0 && !norm.contentFirst) throw cpErr("E_MOVIE_NO_SCENES", "Storyboard planning produced no scenes");
    await tx(async (client) => { await repo.appendEvent(client, ws, projectId, { type: "PIPELINE_STARTED", detail: norm }); await repo.updateProject(client, ws, projectId, { patch: { status: "GENERATING" } }); });
    // Nothing is enqueued for a content-first film until its shot contracts exist: the length of each shot is
    // decided by its narration, and enqueueing first would ask for a clip whose duration nobody has measured.
    if (!norm.contentFirst) await enqueuePlannedScenes({ projectId });
    return { projectId, presets: norm, scenes: scenes.length, contentFirst: norm.contentFirst };
  }

  // Candidate projects an orchestrator should advance (status filter is cheap; advance() no-ops non-pipelines).
  async function listActivePipelines() {
    // Includes COMPLETED: renderMovie sets status=COMPLETED, but the pipeline still needs one more advance to
    // build the package + record PIPELINE_DONE. advanceMoviePipeline no-ops (NOT_AUTO / DONE) for projects that
    // are not pipelines or are already finalized, so scanning COMPLETED projects is cheap + terminates.
    const projects = await tx((client) => repo.listProjects(client, ws, {}));
    return projects.filter((p) => ["STORYBOARD_READY", "GENERATING", "ASSEMBLING", "COMPLETED"].includes(p.status)).map((p) => p.id);
  }

  async function block(projectId, events, stage, reason, extra = {}) {
    const last = latestOf(events, "PIPELINE_BLOCKED", "PIPELINE_STARTED", "SCENE_COMPLETED", "NARRATION_GENERATED", "RENDER_COMPLETED");
    if (!(last && last.type === "PIPELINE_BLOCKED" && last.detail && last.detail.stage === stage && last.detail.reason === reason)) {
      await tx(async (client) => { await repo.appendEvent(client, ws, projectId, { type: "PIPELINE_BLOCKED", detail: { stage, reason, ...extra } }); });
    }
    return { projectId, action: "BLOCKED", stage, reason };
  }
  async function runStage(projectId, events, stage, fn) {
    try { await fn(); return { projectId, action: stage }; }
    catch (e) { return block(projectId, events, stage, e.code || "E_STAGE_FAILED"); }
  }

  // ONE idempotent step toward COMPLETED. Returns { action } describing what it did (WAIT_SCENES / ENQUEUE_SCENES
  // / NARRATION / MUSIC / SUBTITLES / RENDER / DONE / BLOCKED / NOT_AUTO / DONE). Safe to call repeatedly.
  async function advanceMoviePipeline({ projectId } = {}) {
    execGate.assertRunning("advanceMoviePipeline");
    const view = await getProjectView(projectId, { refresh: true });
    if (!view) return { projectId, action: "NOT_FOUND" };
    const events = view.events || [];
    if (!hasEvent(events, "PIPELINE_STARTED")) return { projectId, action: "NOT_AUTO" };
    const terminal = latestOf(events, "PIPELINE_STARTED", "PIPELINE_DONE", "PIPELINE_CANCELLED");
    if (terminal?.type === "PIPELINE_DONE") return { projectId, action: "DONE" };
    if (terminal?.type === "PIPELINE_CANCELLED") return { projectId, action: "CANCELLED" };
    const presets = latestOf(events, "PIPELINE_STARTED")?.detail || {};
    const prog = view.progress;

    // ---- 5C.48 content-first stages -------------------------------------------------------------------
    //
    // adaptation → narration → alignment → subtitles → shot contracts, all BEFORE the first Grok Imagine
    // call. Every one of them either produces something the next stage needs or refuses while refusing is
    // still free: the video budget is the expensive part and it is spent last.
    if (presets.contentFirst === true) {
      // 1. the adaptation. One Grok Chat call, and the scenes are written from its beats.
      if (!hasEvent(events, "ADAPTATION_COMPLETED")) {
        if (hasEvent(events, "ADAPTATION_UNCERTAIN")) return block(projectId, events, "ADAPTATION", "ADAPTATION_UNCERTAIN");
        return runStage(projectId, events, "ADAPTATION", () => adaptMovieContent({
          projectId, provider: presets.adaptationProvider || "GROK_CHAT", format: presets.adaptationFormat || "SHORT_FORM_3BEAT",
          beatCount: presets.beatCount || 3, sourceLocale: presets.sourceLocale || null, localeRationale: presets.localeRationale || ""
        }));
      }
      // 2. narration, with the alignment. The film's clock comes from this and nothing else.
      const anyLine = view.scenes.some((s) => String(s.narration || "").trim());
      if (presets.narrationEnabled !== false && anyLine && !hasEvent(events, "NARRATION_GENERATED")) {
        return runStage(projectId, events, "NARRATION", () => generateNarration({ projectId, voiceId: presets.voiceId, rate: presets.rate,
          allowFallbackVoice: presets.allowFallbackVoice === true, confirmedFallbackLocales: presets.confirmedFallbackLocales || [] }));
      }
      const nev = latestOf(events, "NARRATION_GENERATED");
      if (nev && nev.detail) {
        if (Number(nev.detail.failed) > 0) return block(projectId, events, "NARRATION", "NARRATION_FAILED", { failed: nev.detail.failed });
        // A film cannot be measured against its script without an aligned narration, and subtitleAlignment is
        // a hard dimension: continuing would spend the whole video budget on a film that cannot be published.
        if (Number(nev.detail.aligned || 0) < view.scenes.filter((s) => String(s.narration || "").trim()).length) {
          return block(projectId, events, "NARRATION", "NARRATION_ALIGNMENT_UNAVAILABLE", { aligned: nev.detail.aligned ?? 0, scenes: view.scenes.length });
        }
        // What the recording actually says, measured locally at no cost. Below the floor the scorecard will
        // apply anyway, this film is not publishable — and the honest moment to stop is before the pictures.
        const worst = nev.detail.worstCoverage;
        if (Number.isFinite(worst) && worst < FLOORS.voiceCorrectness) {
          return block(projectId, events, "NARRATION", "NARRATION_COVERAGE_BELOW_FLOOR", { worstCoverage: worst, floor: FLOORS.voiceCorrectness });
        }
      }
      // 3. the shot contracts, timed by that clock. This is what makes the duration a request rather than a trim.
      if (!hasEvent(events, "SHOT_CONTRACTS_PLANNED")) {
        return runStage(projectId, events, "SHOT_CONTRACTS", () => planShotContracts({ projectId }));
      }
    }

    // --- SCENES ---
    if (prog.total === 0) return block(projectId, events, "SCENES", "NO_SCENES");
    const planned = view.scenes.filter((s) => s.state === "PLANNED").length;
    if (planned > 0) { await enqueuePlannedScenes({ projectId }); return { projectId, action: "ENQUEUE_SCENES", planned }; }
    if (prog.generating > 0) return { projectId, action: "WAIT_SCENES", progress: prog };
    if (prog.failed > 0 && (prog.completed + prog.failed) === prog.total) return block(projectId, events, "SCENES", "SCENES_FAILED", { failed: prog.failed });
    if (!prog.readyToAssemble) return { projectId, action: "WAIT_SCENES", progress: prog };
    // --- post-production (all scenes COMPLETED) ---
    // ---- 5C.38 source-resolution gate -------------------------------------------------------------------
    // Every scene is now generated and decoded, and nothing has been spent on speech yet. This is the last
    // moment where refusing is free. A film built on 480p footage cannot become native 720p later; letting it
    // run would burn ElevenLabs quota to narrate a picture the publish path will reject anyway.
    const srcRes = view.project.sourceResolution;
    if (srcRes && sourcePolicy === SOURCE_POLICY.NATIVE_720P_REQUIRED && srcRes.native !== true && srcRes.verdict !== "UNVERIFIED") {
      return block(projectId, events, "SOURCE_RESOLUTION", "SOURCE_RESOLUTION_REJECTED", {
        verdict: srcRes.verdict, minWidth: srcRes.minWidth, minHeight: srcRes.minHeight,
        accountFallbackSuspected: srcRes.accountFallbackSuspected === true,
        // Retrying a per-account 720p cap just spends the allowance again on another 480p clip.
        ownerAction: srcRes.accountFallbackSuspected ? "PROVIDER_QUOTA_OR_TIER" : "REGENERATE_SCENES"
      });
    }

    // ---- 5C.40 vision judging --------------------------------------------------------------------------
    // Runs INSIDE the runtime that owns the Grok Chat actuator, driven by the same pipeline scheduler that
    // drives generation. An ops script cannot do this: it would have to build a second runtime, and a second
    // runtime means a second browser against the same profile.
    //
    // One scene per advance. Judging is a provider call, and doing them one at a time keeps them inside the
    // pacing lane the account already has rather than firing a burst that the cooldown will refuse.
    if (visionActuator && view.project.qualityState !== "PUBLISHABLE") {
      const judged = await tx((client) => arepo.listActive(client, ws, projectId));
      // A verdict that records a BLOCKER is not an answer - it says the shot could not be looked at. Once the
      // obstacle is gone the shot must be judged, or a transient failure would permanently mark a film as
      // unjudgeable and no amount of fixing would ever revisit it.
      const haveVerdict = new Set(judged
        .filter((a) => a.kind === ARTIFACT_KIND.SCENE_VISION_VERDICT && !(a.body && a.body.blocker))
        .map((a) => a.sceneId));
      const needs = view.scenes.filter((sc) => sc.state === "COMPLETED" && !haveVerdict.has(sc.id));
      if (needs.length > 0) {
        const target = needs[0];
        try {
          const r = await judgeSceneVision({ projectId, sceneId: target.id });
          return { projectId, action: "SCENE_VISION_JUDGED", sceneId: target.id, verdict: r.verdict, remaining: needs.length - 1 };
        } catch (e) {
          // A capability refusal is terminal for this film: the composer will refuse the next sheet the same
          // way, and each attempt costs a browser session. Blocking here is what turns it into a reportable
          // finding instead of an infinite retry.
          return block(projectId, events, "VISION", e.code || "E_VISION_FAILED", { sceneId: target.id, reason: e.message });
        }
      }
    }

    // ---- 5C.41 targeted repair --------------------------------------------------------------------------
    // Every scene has been judged by now. A shot the judge REJECTED is regenerated - one at a time, only that
    // shot, and only while attempts remain. A PASS is never touched and an UNMEASURED goes to a human.
    {
      // 5C.48 — settle first. A repair left SUBMITTED forever holds the per-scene in-flight guard, and that
      // guard is what silently skipped the SECOND repair of a shot the first repair failed to fix.
      try { await settleShotRepairs({ projectId }); } catch { /* a settlement failure must not stall the film */ }
      const verdictArts = (await tx((client) => arepo.listActive(client, ws, projectId)))
        .filter((a) => a.kind === ARTIFACT_KIND.SCENE_VISION_VERDICT && a.body && !a.body.blocker);
      const completedScenes = view.scenes.filter((sc) => sc.state === "COMPLETED").length;
      // The repair stage does NOT depend on the vision actuator: regenerating a shot is a Grok Imagine call,
      // and gating it on the chat capability meant a runtime that could generate but not judge would silently
      // skip repair and render the rejected shot anyway. It needs verdicts, which are already on record.
      if (verdictArts.length === 0 || verdictArts.length !== completedScenes) {
        // Say why rather than fall through silently. A stage that skips itself without a word is the reason
        // this took a deploy cycle to diagnose.
        await tx((client) => repo.appendEvent(client, ws, projectId, {
          type: "REPAIR_STAGE_SKIPPED", detail: { verdicts: verdictArts.length, completedScenes }
        })).catch(() => {});
      }
      if (verdictArts.length > 0 && verdictArts.length === completedScenes) {
        const attemptsSoFar = await tx(async (client) => Object.fromEntries((await client.query(
          "SELECT scene_id, count(*)::int n FROM movie_shot_repairs WHERE workspace_id=$1 AND movie_project_id=$2 GROUP BY scene_id",
          [ws, projectId])).rows.map((r) => [r.scene_id, Number(r.n)])));
        const plan = planShotRepairs({
          verdicts: verdictArts.map((a) => ({ sceneId: a.sceneId, verdict: a.body.verdict, failedRequirements: a.body.failedRequirements || [], reason: a.body.reason })),
          attemptsSoFar
        });
        if (plan.repair.length > 0) {
          const first = plan.repair[0];
          try {
            const r = await repairScene({ projectId, sceneId: first.sceneId });
            return { projectId, action: "SCENE_REPAIR_STARTED", sceneId: first.sceneId, attempt: r.attempt, contractRevision: r.shotContractRevision };
          } catch (e) {
            if (e.code !== "E_MOVIE_REPAIR_IN_FLIGHT") {
              return block(projectId, events, "REPAIR", e.code || "E_MOVIE_REPAIR_FAILED", { sceneId: first.sceneId, reason: e.message });
            }
          }
        }
        if (plan.exhausted.length > 0 || plan.review.length > 0) {
          // Out of attempts, or something nobody could judge. The film is not publishable and saying so is the
          // whole point - looping here would spend the rest of the budget on a shot that is not improving.
          return block(projectId, events, "QUALITY", "E_MOVIE_QUALITY_REVIEW_REQUIRED",
            { exhausted: plan.exhausted.map((x) => x.sceneId), review: plan.review.map((x) => x.sceneId) });
        }
      }
    }

    const anyNarration = view.scenes.some((s) => String(s.narration || "").trim());
    if (presets.narrationEnabled && anyNarration) {
      const nev = latestOf(events, "NARRATION_GENERATED");
      if (!nev) return runStage(projectId, events, "NARRATION", () => generateNarration({ projectId, voiceId: presets.voiceId, rate: presets.rate,
        allowFallbackVoice: presets.allowFallbackVoice === true, confirmedFallbackLocales: presets.confirmedFallbackLocales || [] }));
      if (nev.detail && Number(nev.detail.failed) > 0) return block(projectId, events, "NARRATION", "NARRATION_FAILED", { failed: nev.detail.failed });
    }
    if (presets.music && presets.music.source && presets.music.source !== "NONE" && !hasEvent(events, "MUSIC_SET")) {
      return runStage(projectId, events, "MUSIC", () => setMusic({ projectId, source: presets.music.source, style: presets.music.style, volume: presets.music.volume }));
    }
    if (presets.subtitleEnabled && !hasEvent(events, "SUBTITLES_BUILT") && !hasEvent(events, "SUBTITLES_SET")) {
      return runStage(projectId, events, "SUBTITLES", () => buildSubtitles({ projectId }));
    }
    const renders = await tx((client) => crepo.listRenders(client, ws, projectId));
    const completedRender = renders.find((r) => r.state === "COMPLETED" && r.finalMedia);
    if (!completedRender) return runStage(projectId, events, "RENDER", () => renderMovie({ projectId }));
    // PACKAGE: bundle the downloadable ZIP (final.mp4 + caption + metadata + thumbnail + srt) once, before DONE.
    if (!(completedRender.packageMedia && completedRender.packageMedia.sizeBytes > 0) && !hasEvent(events, "PACKAGE_BUILT")) {
      return runStage(projectId, events, "PACKAGE", () => buildPackage({ projectId, renderId: completedRender.id }));
    }
    // 5C.48 — the scorecard is a STAGE, not something a person remembers to run.
    //
    // "The pipeline finished" and "this film can be published" are different claims, and until the second one
    // is on the record the film has only the first. It is a local computation over the artifacts every earlier
    // stage left behind — no provider, no cost — so there is no reason for it not to be the last step.
    if (contentAlignmentEnabled && view.project.qualityState === null) {
      return runStage(projectId, events, "SCORECARD", () => movieQuality({ projectId }));
    }
    await tx(async (client) => { await repo.appendEvent(client, ws, projectId, { type: "PIPELINE_DONE", detail: {} }); await repo.updateProject(client, ws, projectId, { patch: { status: "COMPLETED" } }); });
    return { projectId, action: "DONE" };
  }

  return Object.freeze({
    createProject, listProjects: listProjectsView, getProject, updateProject, archiveProject,
    draftStory, setStory, planStoryboard, listScenes, updateScene, deleteScene,
    generateScene, generateAllScenes, refreshScenes, assembleMovie, finalMediaFor,
    // 5C.11 Content Studio
    draftStoryViaProvider, listVoices, generateNarration, setMusic, attachMusicUpload,
    buildSubtitles, setSubtitles, updateTimeline, renderMovie, listRenders,
    planMovieDuration, assessMovieVoice, movieQuality, judgeSceneVision, repairScene,
    inspectSceneSourceAudio, planMovieAudioRouting,
    // 5C.48 — the content stages that run before the video budget is touched, and the repair ledger settlement.
    adaptMovieContent, planShotContracts, settleShotRepairs, sceneVerdicts,
    buildPackage, publishMovie, listPublishes, audioMediaFor, renderMediaFor, uploadTempTarget,
    // 5C.26 auto-pipeline orchestration
    startMoviePipeline, cancelMoviePipeline, advanceMoviePipeline, listActivePipelines, enqueuePlannedScenes,
    getProjectView, _workspaceId: ws
  });
}
