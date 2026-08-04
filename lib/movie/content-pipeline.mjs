// P0 Step 5C.39 — the order the film gets made in, and the gates between the steps.
//
// The pipeline used to be: story → scenes → clips → narration → subtitles → render. Each stage produced its own
// timings, so a subtitle appeared because a shot started rather than because a voice said a word, and a shot
// was prompted from a slice of story rather than from the line playing over it. Nothing was wrong with any one
// step. The film was wrong because the steps did not share a clock or a script.
//
// This module fixes the ORDER, and the order is the design:
//
//   adaptation ─(must pass)→ narration script → TTS with real timestamps ─(must verify)→
//     one canonical timeline → shot contracts → generation → vision judge ─(may repair)→ render → scorecard
//
// The gates are placed where refusing is still free. An adaptation that invents a fact is caught before any
// provider is called at all. A recording in the wrong language is caught before a single frame is generated. A
// 480p source is caught before narration is synthesised. By the time anything expensive has been spent, the
// cheap reasons to abandon the film are already gone.
//
// Pure orchestration: this module decides WHAT happens next and WHY it may not. Providers, the database and
// ffmpeg are all injected, so the whole sequence is testable without spending anything.

import { buildAdaptation, validateAdaptationAgainstStory, buildShotPlan, ADAPTATION_ERRORS, formatStructure } from "./adaptation-contract.mjs";
import { normalizeAlignment, buildNarrationTimeline, concatTimelines, subtitleCuesFromTimeline, subtitleDrift, assertSubtitleAlignment, assertShotsCoverTimeline, cuesToSrt, DRIFT_TARGETS } from "./audio-timeline.mjs";
import { verifyTranscript, TRANSCRIPT_VERDICT } from "./transcript-verification.mjs";
import { classifyGeneratedAsset, sourceGateDecision, SOURCE_POLICY, ASSET_VERDICT } from "../media/asset-policy.mjs";
import { VISION_VERDICT } from "./vision-judge.mjs";
import { estimateSpeechSeconds, NARRATION_SAFETY } from "./duration-budget.mjs";

export const PIPELINE_ERRORS = Object.freeze({
  ADAPTATION_REQUIRED: "E_MOVIE_ADAPTATION_REQUIRED",
  ADAPTATION_REJECTED: "E_MOVIE_ADAPTATION_REJECTED",
  ALIGNMENT_UNAVAILABLE: "E_NARRATION_ALIGNMENT_UNAVAILABLE",
  TRANSCRIPT_REJECTED: "E_NARRATION_TRANSCRIPT_REJECTED",
  SUBTITLE_DRIFT: "E_SUBTITLE_DRIFT_EXCEEDED",
  SHOTS_DO_NOT_COVER: "E_SHOTS_DO_NOT_COVER_TIMELINE",
  SOURCE_REJECTED: "E_MOVIE_SOURCE_RESOLUTION_REJECTED",
  VISION_UNRESOLVED: "E_MOVIE_VISION_UNRESOLVED"
});

export const PIPELINE_STAGE = Object.freeze({
  ADAPTATION: "ADAPTATION",
  NARRATION: "NARRATION",
  ALIGNMENT: "ALIGNMENT",
  TRANSCRIPT: "TRANSCRIPT",
  SHOT_PLAN: "SHOT_PLAN",
  GENERATION: "GENERATION",
  VISION: "VISION",
  REPAIR: "REPAIR",
  RENDER: "RENDER",
  SCORECARD: "SCORECARD"
});

function err(code, message, detail = {}) { return Object.assign(new Error(message), { code, detail }); }

// ---------------------------------------------------------------------------------------------------------
// §3 — the adaptation gate
// ---------------------------------------------------------------------------------------------------------

export const ADAPTATION_GATE = Object.freeze({
  minHookChars: 40,
  maxFillerRatio: 0.18,
  // A 25-second short form is roughly 55-75 spoken words in most European languages. Far outside that and the
  // adaptation is not written for the length it claims — which no amount of careful rendering can repair.
  wordsPerSecondMin: 1.8,
  wordsPerSecondMax: 3.6
});

const FILLER = /\b(basically|actually|really|very|just|somehow|kind of|sort of|in fact|of course|obviously|liksom|ligesom|faktisk|virkelig)\b/giu;

/**
 * Is this adaptation good enough to spend provider quota on?
 *
 * Everything here is checkable without a model: structure, facts against the source story, length against the
 * target duration, locale, filler. A model could give a richer opinion, but it could also be wrong in a way
 * nobody can audit, and this gate's job is to stop the obviously-unfit before anything is spent.
 */
export function gateAdaptation({ adaptation, story, targetDurationSeconds, locale = null } = {}) {
  if (!adaptation) return Object.freeze({ ok: false, code: PIPELINE_ERRORS.ADAPTATION_REQUIRED, failures: ["no adaptation artifact exists"], warnings: [] });

  const failures = [];
  const warnings = [];

  // Structure. A short film without a hook, a middle and an ending is three unrelated moments — which is
  // exactly what shipped before this gate existed.
  //
  // 5C.48 — which beats are required comes from the FORMAT, read from the one table the builder also reads.
  // This gate previously demanded SETUP of every shape, so a three-beat film could be built and then refused
  // by the gate standing in front of the spend it was meant to protect.
  const beats = adaptation.beatSheet || [];
  const roles = new Set(beats.map((b) => String(b.role || "").toUpperCase()));
  const structure = formatStructure(adaptation.format);
  for (const need of structure.requiredRoles) {
    if (!roles.has(need)) failures.push(`the beat sheet has no ${need}`);
  }
  if (structure.endingRoles.length && !structure.endingRoles.some((r) => roles.has(r))) {
    failures.push("the film has no payoff and no cliffhanger — it simply stops");
  }
  if (structure.exactBeats && beats.length !== structure.exactBeats) {
    failures.push(`${adaptation.format} is exactly ${structure.exactBeats} beats; this one has ${beats.length}`);
  }
  if (!adaptation.hook || String(adaptation.hook).trim().length < ADAPTATION_GATE.minHookChars) {
    failures.push("the hook is missing or too thin to open on");
  }

  // Facts, against the source story. validateAdaptationAgainstStory THROWS on a departure rather than
  // returning a verdict — it is written to stop a caller proceeding, which is right for its own callers and
  // wrong here: this gate collects every problem so the owner sees all of them at once instead of fixing them
  // one refusal at a time.
  let factCheck = null;
  if (story) {
    try {
      const r = validateAdaptationAgainstStory(adaptation, story, { locale });
      factCheck = { ok: r ? r.ok !== false : true, problems: (r && r.problems) || [] };
    } catch (e) {
      factCheck = { ok: false, problems: e.problems || [{ kind: e.code || "FACT_DRIFT", detail: e.message }] };
    }
    if (factCheck.ok === false) {
      for (const pr of factCheck.problems) failures.push(`fact: ${pr.detail || pr.kind || JSON.stringify(pr)}`);
    }
  }

  // Length. The script has to be written FOR the duration, not trimmed into it afterwards.
  const script = String(adaptation.narrationScript || "");
  const words = (script.match(/[\p{L}\p{N}]+/gu) || []).length;
  if (Number.isFinite(targetDurationSeconds) && targetDurationSeconds > 0) {
    const wps = words / targetDurationSeconds;
    if (wps < ADAPTATION_GATE.wordsPerSecondMin) {
      failures.push(`only ${words} words for ${targetDurationSeconds}s — the film would be mostly silence`);
    } else if (wps > ADAPTATION_GATE.wordsPerSecondMax) {
      failures.push(`${words} words for ${targetDurationSeconds}s — this cannot be read at a listenable pace`);
    }
  }
  if (words === 0) failures.push("the narration script is empty");

  // 5C.48 — the words-per-second band above is a proxy; the duration budget has a real speech model, and when
  // the two disagree the budget wins by dropping whole sentences from the end of each beat. Nothing is wasted
  // (the budget decides the text before synthesis) but the film stops saying what the adaptation wrote, and
  // that is content loss an owner should see rather than discover in the finished file.
  if (words > 0 && Number.isFinite(targetDurationSeconds) && targetDurationSeconds > 0) {
    const speakable = targetDurationSeconds * NARRATION_SAFETY;
    const needs = estimateSpeechSeconds(script, locale || adaptation.locale || "en-US");
    if (needs > speakable) {
      warnings.push(`the narration needs about ${Math.round(needs)}s of speech and the film can hold ${Math.round(speakable)}s — `
        + "the duration budget will drop whole sentences from the end of the longer beats");
    }
  }

  // Locale.
  if (locale && adaptation.locale && String(adaptation.locale).slice(0, 2).toLowerCase() !== String(locale).slice(0, 2).toLowerCase()) {
    failures.push(`the adaptation is written in ${adaptation.locale} but the movie is ${locale}`);
  }

  // Filler.
  const fillerHits = (script.match(FILLER) || []).length;
  if (words > 0 && fillerHits / words > ADAPTATION_GATE.maxFillerRatio) {
    failures.push(`filler words make up too much of the script (${fillerHits} of ${words})`);
  }

  // An ending that trails off mid-clause reads as a broken file rather than a cliffhanger.
  const trimmed = script.trim();
  if (trimmed && !/[.!?…"'»)\]]$/u.test(trimmed)) warnings.push("the script does not end on a terminator — check it is not cut off");

  return Object.freeze({
    ok: failures.length === 0,
    code: failures.length === 0 ? null : PIPELINE_ERRORS.ADAPTATION_REJECTED,
    words, wordsPerSecond: Number.isFinite(targetDurationSeconds) && targetDurationSeconds > 0 ? Number((words / targetDurationSeconds).toFixed(2)) : null,
    beats: beats.length, roles: [...roles],
    factCheck: factCheck ? { ok: factCheck.ok, problems: factCheck.problems || [] } : null,
    failures: Object.freeze(failures), warnings: Object.freeze(warnings)
  });
}

// ---------------------------------------------------------------------------------------------------------
// §4/§5 — one canonical timeline
// ---------------------------------------------------------------------------------------------------------

/**
 * Build THE timeline from real provider alignment.
 *
 * `segments` is one entry per synthesis call. A single continuous narration is the preferred shape — one voice,
 * one rhythm, one absolute clock — but where the architecture produced several, they are concatenated into one
 * canonical timeline with absolute timestamps rather than left as several clocks that each believe they start
 * at zero.
 *
 * Refuses rather than estimating. An absent or malformed alignment is E_NARRATION_ALIGNMENT_UNAVAILABLE, never
 * an even division: a fabricated timeline renders perfectly and is wrong in a way nothing downstream can detect.
 */
export function buildCanonicalTimeline(segments = []) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw err(PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE, "no narration segments were produced");
  }
  // Each part is built at its OWN zero and told where it belongs; concatTimelines applies the offset. Building
  // at an offset AND passing one shifts every timestamp in the back half of the film twice.
  const parts = [];
  let offsetMs = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (!seg || !seg.alignment) {
      throw err(PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE,
        `segment ${i + 1} came back without character timestamps; the film will not be rendered on estimated timings`,
        { segment: i });
    }
    let norm;
    try { norm = normalizeAlignment(seg.alignment); }
    catch (e) { throw err(PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE, `segment ${i + 1} alignment is malformed`, { segment: i, cause: e.code || e.message }); }
    const t = buildNarrationTimeline({ alignment: norm, offsetMs: 0, beatId: seg.beatId ?? null, segmentPrefix: `s${i}` });
    if (segments.length === 1) return t;
    parts.push({ timeline: t, offsetMs, prefix: `s${i}`, beatId: seg.beatId ?? null });
    // The NEXT segment starts where this recording actually ENDS, measured from the file — not where the
    // alignment last character falls, which excludes any trailing silence the encoder kept. Getting this wrong
    // makes the back half of the film drift progressively earlier.
    const measured = Number.isFinite(seg.measuredDurationMs) ? seg.measuredDurationMs : t.endMs;
    offsetMs += Math.max(measured, t.endMs);
  }
  return concatTimelines(parts);
}

/** §7 — cues from the timeline, gated on measured drift. Subtitles and shots read the SAME timeline object, so
 *  they cannot disagree about when a word is spoken. */
export function buildVerifiedSubtitles(timeline, { targets = DRIFT_TARGETS, filmEndMs = null } = {}) {
  const cues = subtitleCuesFromTimeline(timeline, { filmEndMs });
  const drift = subtitleDrift(cues, timeline);
  try { assertSubtitleAlignment(drift, targets); }
  catch (e) { throw err(PIPELINE_ERRORS.SUBTITLE_DRIFT, e.message, { drift, targets }); }
  return Object.freeze({ cues, drift, srt: cuesToSrt(cues) });
}

/** §8 — shot contracts timed by the real audio, then checked to cover it. A gap in coverage is a stretch of
 *  narration with no picture behind it, which is a black screen with a voice over it. */
export function buildVerifiedShotPlan({ timeline, adaptation, defaults = {} } = {}) {
  const plan = buildShotPlan({ timeline, adaptation, defaults });
  const cover = assertShotsCoverTimeline(timeline, plan.shots || plan);
  if (cover && cover.ok === false) {
    throw err(PIPELINE_ERRORS.SHOTS_DO_NOT_COVER, "some narration has no shot behind it", { gaps: cover.gaps });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------------------
// §6 — the transcript gate
// ---------------------------------------------------------------------------------------------------------

/** Refuses the render outright on a REJECT. UNVERIFIED is allowed to proceed — it is honest about not knowing —
 *  but it is carried into the scorecard, where it blocks PUBLISHABLE. Those are different decisions and
 *  collapsing them would either stop every film or silently pass every one. */
export function gateTranscript(verification) {
  if (!verification) return Object.freeze({ ok: true, blocking: false, verdict: TRANSCRIPT_VERDICT.UNVERIFIED, reason: "no verification was attempted" });
  if (verification.verdict === TRANSCRIPT_VERDICT.REJECT) {
    return Object.freeze({ ok: false, blocking: true, code: PIPELINE_ERRORS.TRANSCRIPT_REJECTED, verdict: verification.verdict, reason: verification.reason, failures: verification.failures });
  }
  return Object.freeze({ ok: true, blocking: false, verdict: verification.verdict, reason: verification.reason });
}

// ---------------------------------------------------------------------------------------------------------
// §9 — the source gate, per scene
// ---------------------------------------------------------------------------------------------------------

/**
 * Every generated clip, decoded and judged, before narration is spent.
 *
 * Returns the per-scene verdicts and whether the film may continue. A 480p clip in a native-720p film cannot
 * be fixed downstream, so continuing would burn ElevenLabs quota narrating a picture the publish path is going
 * to refuse anyway.
 */
export function gateSources({ scenes = [], policy = SOURCE_POLICY.NATIVE_720P_REQUIRED, requested = { resolution: "720p", aspectRatio: "9:16" } } = {}) {
  const verdicts = [];
  for (const sc of scenes) {
    const classification = sc.classification || classifyGeneratedAsset({
      requested, decoded: sc.decoded || null, upscaleApplied: sc.upscaleApplied === true
    });
    const gate = sourceGateDecision({ classification, policy });
    verdicts.push(Object.freeze({
      sceneId: sc.sceneId ?? null, ordinal: sc.ordinal ?? null,
      verdict: classification.verdict, native: classification.native === true,
      width: classification.actualWidth, height: classification.actualHeight,
      aspectRatio: classification.actualAspectRatio, tier: classification.actualResolutionTier,
      accountFallbackSuspected: classification.accountFallbackSuspected === true,
      allow: gate.allow, label: gate.label, ownerActionRequired: gate.ownerActionRequired || null,
      reason: classification.reason
    }));
  }
  const rejected = verdicts.filter((v) => !v.allow);
  const capped = verdicts.filter((v) => v.accountFallbackSuspected);
  return Object.freeze({
    ok: rejected.length === 0,
    code: rejected.length === 0 ? null : PIPELINE_ERRORS.SOURCE_REJECTED,
    allNative: verdicts.length > 0 && verdicts.every((v) => v.native),
    verdicts: Object.freeze(verdicts),
    rejected: Object.freeze(rejected),
    // A repeated per-account fallback is a capability limit, not a bad generation: retrying spends the
    // allowance again on another 480p clip.
    capabilityLimited: capped.length > 0 && capped.length === rejected.length && rejected.length > 0,
    ownerActionRequired: capped.length > 0 ? "PROVIDER_QUOTA_OR_TIER" : (rejected.length ? "REGENERATE_SCENES" : null)
  });
}

// ---------------------------------------------------------------------------------------------------------
// §11 — what to do about a shot the judge rejected
// ---------------------------------------------------------------------------------------------------------

export const REPAIR_POLICY = Object.freeze({ maxAttemptsPerShot: 2 });

/**
 * Which shots to regenerate, and which to stop arguing about.
 *
 * Only the failing shot is touched. Not the story, not the adaptation, not the narration, not the subtitles,
 * and not a shot that already passed — regenerating a passing shot spends quota to replace something correct
 * with something merely different.
 */
export function planShotRepairs({ verdicts = [], attemptsSoFar = {}, policy = REPAIR_POLICY } = {}) {
  const repair = [];
  const exhausted = [];
  const review = [];
  for (const v of verdicts) {
    const used = Number(attemptsSoFar[v.sceneId] || 0);
    if (v.verdict === VISION_VERDICT.REGENERATE) {
      if (used >= policy.maxAttemptsPerShot) exhausted.push({ sceneId: v.sceneId, attempts: used, reason: v.reason });
      else repair.push({ sceneId: v.sceneId, attempt: used + 1, failedRequirements: v.failedRequirements || [], verdict: v });
    } else if (v.verdict === VISION_VERDICT.MANUAL_REVIEW || v.verdict === VISION_VERDICT.UNMEASURED || v.verdict === VISION_VERDICT.TECHNICAL_REJECT) {
      review.push({ sceneId: v.sceneId, verdict: v.verdict, reason: v.reason });
    }
  }
  return Object.freeze({
    repair: Object.freeze(repair),
    exhausted: Object.freeze(exhausted),
    review: Object.freeze(review),
    // Anything left unresolved means the film is not publishable, whatever the render looks like.
    blocksPublish: exhausted.length > 0 || review.length > 0 || repair.length > 0
  });
}

// ---------------------------------------------------------------------------------------------------------
// the stage machine
// ---------------------------------------------------------------------------------------------------------

/**
 * What the pipeline should do next, and what is stopping it.
 *
 * A single function answering "where are we" keeps the ordering in ONE place. Spread across call sites, the
 * rule "never synthesise narration before the adaptation passes" survives exactly as long as nobody adds a
 * shortcut.
 */
export function nextStage(state = {}) {
  const s = (stage, blocked = null, detail = {}) => Object.freeze({ stage, blocked, detail });

  if (!state.adaptation) return s(PIPELINE_STAGE.ADAPTATION);
  if (state.adaptationGate && state.adaptationGate.ok === false) {
    return s(PIPELINE_STAGE.ADAPTATION, PIPELINE_ERRORS.ADAPTATION_REJECTED, { failures: state.adaptationGate.failures });
  }
  if (!state.narrationAudio) return s(PIPELINE_STAGE.NARRATION);
  if (!state.timeline) return s(PIPELINE_STAGE.ALIGNMENT, PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE);
  if (state.transcriptGate && state.transcriptGate.blocking) {
    return s(PIPELINE_STAGE.TRANSCRIPT, PIPELINE_ERRORS.TRANSCRIPT_REJECTED, { reason: state.transcriptGate.reason });
  }
  if (!state.shotPlan) return s(PIPELINE_STAGE.SHOT_PLAN);
  if (!state.scenesGenerated) return s(PIPELINE_STAGE.GENERATION);
  if (state.sourceGate && state.sourceGate.ok === false) {
    return s(PIPELINE_STAGE.GENERATION, PIPELINE_ERRORS.SOURCE_REJECTED, { rejected: state.sourceGate.rejected, ownerActionRequired: state.sourceGate.ownerActionRequired });
  }
  if (!state.visionComplete) return s(PIPELINE_STAGE.VISION);
  if (state.repairPlan && state.repairPlan.repair.length > 0) return s(PIPELINE_STAGE.REPAIR, null, { shots: state.repairPlan.repair.map((r) => r.sceneId) });
  if (!state.rendered) return s(PIPELINE_STAGE.RENDER);
  return s(PIPELINE_STAGE.SCORECARD);
}
