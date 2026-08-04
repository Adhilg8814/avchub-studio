// P0 Step 5C.45 §3/§4 — which voice ends up in the film, and whether ElevenLabs is called at all.
//
// Pure. Classification and narration verdict in, a routing decision out.
//
// WHY THIS IS A GATE AND NOT AN OPTIMISATION
// ------------------------------------------
// Every Grok clip carries an audio track. The tempting rule — "it has audio, so skip the TTS" — produces a
// film whose voice is whatever the video model felt like generating: possibly nothing audible, possibly a
// different language, possibly two people talking over the narration. The cost of being wrong is not a wasted
// API call, it is a finished film that says the wrong words.
//
// So the gate is asymmetric on purpose. Calling ElevenLabs when the Grok audio would have done wastes a few
// cents. Skipping it wrongly wastes the film. Every uncertain path therefore routes to ElevenLabs, and only
// two verdicts — EXACT and ACCEPTABLE — can turn it off.

import { SOURCE_AUDIO_CLASS, carriesUsableAmbience } from "./source-audio-class.mjs";
import { NARRATION_VERDICT, narrationUsable, speechConflicts } from "./narration-match.mjs";

export const AUDIO_POLICY = Object.freeze({
  AUTO: "AUTO",
  PREFER_GROK_NATIVE: "PREFER_GROK_NATIVE",
  PREFER_ELEVENLABS: "PREFER_ELEVENLABS",
  MUTE_GROK_SPEECH: "MUTE_GROK_SPEECH",
  KEEP_GROK_AMBIENCE: "KEEP_GROK_AMBIENCE"
});

export const AUDIO_DECISION = Object.freeze({
  USE_GROK_NARRATION: "USE_GROK_NARRATION",
  KEEP_GROK_AMBIENCE_USE_ELEVENLABS: "KEEP_GROK_AMBIENCE_USE_ELEVENLABS",
  MUTE_GROK_SPEECH_USE_ELEVENLABS: "MUTE_GROK_SPEECH_USE_ELEVENLABS",
  USE_ELEVENLABS_ONLY: "USE_ELEVENLABS_ONLY",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  UNMEASURED: "UNMEASURED"
});

export const NARRATION_SOURCE = Object.freeze({ GROK: "GROK", ELEVENLABS: "ELEVENLABS", NONE: "NONE" });

// Mix levels. Ambience sits far enough under a voice to be felt rather than heard, and ducking is applied
// only when there is a narration to duck under.
export const MIX_DEFAULTS = Object.freeze({
  sourceAudioGainDb: -18,      // Grok ambience kept under a synthesised narration
  sourceAudioSoloGainDb: 0,    // Grok audio IS the narration
  musicGainDb: -22,
  duckDb: -8
});

/**
 * One scene.
 *
 * `movieDecision` is applied afterwards — a scene may be individually capable of using Grok narration and
 * still be overridden, because a film cannot change voice halfway through.
 */
export function decideSceneAudio({
  audioClass = SOURCE_AUDIO_CLASS.UNKNOWN,
  narrationVerdict = NARRATION_VERDICT.UNMEASURED_NO_STT_CAPABILITY,
  hasIntendedNarration = true,
  policy = AUDIO_POLICY.AUTO,
  alignmentAvailable = false      // can subtitles be cut from the Grok audio at all?
} = {}) {
  const usableAmbience = carriesUsableAmbience(audioClass);
  const out = (decision, narrationSource, reason, extra = {}) => Object.freeze({
    decision, narrationSource,
    elevenLabsRequired: narrationSource === NARRATION_SOURCE.ELEVENLABS,
    elevenLabsSkipped: narrationSource === NARRATION_SOURCE.GROK,
    elevenLabsSkipReason: narrationSource === NARRATION_SOURCE.GROK ? reason : null,
    keepSourceAudio: decision === AUDIO_DECISION.USE_GROK_NARRATION || decision === AUDIO_DECISION.KEEP_GROK_AMBIENCE_USE_ELEVENLABS,
    muteSourceSpeech: decision === AUDIO_DECISION.MUTE_GROK_SPEECH_USE_ELEVENLABS,
    sourceAudioGainDb: decision === AUDIO_DECISION.USE_GROK_NARRATION ? MIX_DEFAULTS.sourceAudioSoloGainDb
      : decision === AUDIO_DECISION.KEEP_GROK_AMBIENCE_USE_ELEVENLABS ? MIX_DEFAULTS.sourceAudioGainDb : null,
    duckingApplied: decision === AUDIO_DECISION.KEEP_GROK_AMBIENCE_USE_ELEVENLABS,
    reason, policy, audioClass, narrationVerdict, ...extra
  });

  // ---- explicit policies override the reading, but never invent evidence -----------------------------
  if (policy === AUDIO_POLICY.PREFER_ELEVENLABS) {
    return usableAmbience
      ? out(AUDIO_DECISION.KEEP_GROK_AMBIENCE_USE_ELEVENLABS, NARRATION_SOURCE.ELEVENLABS, "policy prefers ElevenLabs; the clip's ambience is kept under it")
      : out(AUDIO_DECISION.USE_ELEVENLABS_ONLY, NARRATION_SOURCE.ELEVENLABS, "policy prefers ElevenLabs");
  }
  if (policy === AUDIO_POLICY.MUTE_GROK_SPEECH) {
    return out(AUDIO_DECISION.MUTE_GROK_SPEECH_USE_ELEVENLABS, NARRATION_SOURCE.ELEVENLABS, "policy mutes the clip's own speech");
  }
  if (policy === AUDIO_POLICY.KEEP_GROK_AMBIENCE) {
    return out(AUDIO_DECISION.KEEP_GROK_AMBIENCE_USE_ELEVENLABS, NARRATION_SOURCE.ELEVENLABS, "policy keeps the clip's ambience under a synthesised narration");
  }
  if (policy === AUDIO_POLICY.PREFER_GROK_NATIVE) {
    // Even here the evidence rules. "Prefer" cannot mean "assume".
    if (!narrationUsable(narrationVerdict)) {
      return out(AUDIO_DECISION.MANUAL_REVIEW, NARRATION_SOURCE.ELEVENLABS,
        `policy prefers the clip's own voice, but the narration verdict is ${narrationVerdict}`);
    }
    if (!alignmentAvailable) {
      return out(AUDIO_DECISION.MANUAL_REVIEW, NARRATION_SOURCE.ELEVENLABS,
        "policy prefers the clip's own voice, but there is no alignment to cut subtitles from");
    }
    return out(AUDIO_DECISION.USE_GROK_NARRATION, NARRATION_SOURCE.GROK, "the clip's own voice reads the narration and policy prefers it");
  }

  // ---- AUTO -------------------------------------------------------------------------------------------
  if (!hasIntendedNarration) {
    // Nothing to say. Whatever the clip carries is the whole soundtrack, and no TTS is needed either way.
    return usableAmbience
      ? out(AUDIO_DECISION.KEEP_GROK_AMBIENCE_USE_ELEVENLABS, NARRATION_SOURCE.NONE, "this scene has no narration; the clip's ambience stands alone")
      : out(AUDIO_DECISION.USE_ELEVENLABS_ONLY, NARRATION_SOURCE.NONE, "this scene has no narration");
  }

  // A. the clip already reads our line
  if (narrationUsable(narrationVerdict)) {
    if (!alignmentAvailable) {
      // Subtitles must come from the audio that is actually in the film. Without alignment we would be
      // guessing cue times, which 5C.36/5C.39 established as never acceptable.
      return out(AUDIO_DECISION.MANUAL_REVIEW, NARRATION_SOURCE.ELEVENLABS,
        `the clip's voice matches the narration (${narrationVerdict}) but nothing can align it for subtitles`);
    }
    return out(AUDIO_DECISION.USE_GROK_NARRATION, NARRATION_SOURCE.GROK, `the clip's own voice reads the narration (${narrationVerdict})`);
  }

  // C. speech that fights the narration
  if (speechConflicts(narrationVerdict)) {
    // D. partial is called out separately: it is not patched together, a single source is chosen.
    const partial = narrationVerdict === NARRATION_VERDICT.PARTIAL_NARRATION_MATCH;
    return out(AUDIO_DECISION.MUTE_GROK_SPEECH_USE_ELEVENLABS, NARRATION_SOURCE.ELEVENLABS,
      partial ? "the clip reads only part of the narration; the two are never spliced, so its speech is muted and one source is used"
        : `the clip contains speech that is not this narration (${narrationVerdict}); it is muted so two voices never overlap`);
  }

  // B. no speech, but there is a soundtrack worth keeping
  if (narrationVerdict === NARRATION_VERDICT.NO_SPEECH || audioClass === SOURCE_AUDIO_CLASS.SILENCE || audioClass === SOURCE_AUDIO_CLASS.NONE) {
    return usableAmbience
      ? out(AUDIO_DECISION.KEEP_GROK_AMBIENCE_USE_ELEVENLABS, NARRATION_SOURCE.ELEVENLABS, "the clip carries ambience and no speech; it is kept under a synthesised narration")
      : out(AUDIO_DECISION.USE_ELEVENLABS_ONLY, NARRATION_SOURCE.ELEVENLABS, "the clip carries nothing audible to keep");
  }

  // E. nobody listened
  return out(AUDIO_DECISION.UNMEASURED, NARRATION_SOURCE.ELEVENLABS,
    `the clip's audio has not been transcribed (${narrationVerdict}), so the safe behaviour is kept: synthesise the narration`,
    { unmeasured: true });
}

/**
 * The film, not the scene.
 *
 * A narration source is a property of the film. Scene one in a video model's voice, scene two in a synthesised
 * one and scene three in a third is not a stylistic choice, it is a defect the viewer notices immediately.
 * So a single dissenting scene pulls the whole film onto the safe source — unless the format is explicitly
 * multi-voice and the policy says so.
 */
export function decideMovieAudio({ sceneDecisions = [], policy = AUDIO_POLICY.AUTO, allowMixedVoices = false } = {}) {
  const decisions = sceneDecisions.filter(Boolean);
  if (decisions.length === 0) {
    return Object.freeze({ narrationSource: NARRATION_SOURCE.ELEVENLABS, consistent: true, overridden: [], reason: "no scenes to decide", policy });
  }
  const sources = new Set(decisions.map((d) => d.narrationSource).filter((s) => s !== NARRATION_SOURCE.NONE));
  const anyManual = decisions.some((d) => d.decision === AUDIO_DECISION.MANUAL_REVIEW);

  if (anyManual) {
    return Object.freeze({
      narrationSource: NARRATION_SOURCE.ELEVENLABS, consistent: true, requiresReview: true,
      overridden: decisions.filter((d) => d.narrationSource === NARRATION_SOURCE.GROK).map((d, i) => i),
      reason: "at least one scene needs a human decision, so the film keeps the safe narration source until it is made",
      policy
    });
  }
  if (sources.size <= 1) {
    const only = [...sources][0] || NARRATION_SOURCE.ELEVENLABS;
    return Object.freeze({ narrationSource: only, consistent: true, overridden: [], reason: `every scene agrees on ${only}`, policy });
  }
  if (allowMixedVoices) {
    return Object.freeze({
      narrationSource: NARRATION_SOURCE.GROK, consistent: false, mixedAllowed: true, overridden: [],
      reason: "the format is explicitly multi-voice and policy allows scenes to differ", policy
    });
  }
  // Mixed and not allowed: the safe source wins, and the scenes that lose are named.
  const overridden = decisions.map((d, i) => (d.narrationSource === NARRATION_SOURCE.GROK ? i : -1)).filter((i) => i >= 0);
  return Object.freeze({
    narrationSource: NARRATION_SOURCE.ELEVENLABS, consistent: true, overridden,
    reason: `scenes disagreed on the narration source, so the whole film uses ElevenLabs; ${overridden.length} scene(s) that could have used the clip's own voice were overridden`,
    policy
  });
}

/** Where subtitles must be cut from, once the narration source is settled. */
export function subtitleSourceFor(narrationSource) {
  if (narrationSource === NARRATION_SOURCE.GROK) {
    return Object.freeze({
      source: "GROK_AUDIO_ALIGNMENT",
      requiresRealAlignment: true,
      reason: "subtitles must be cut from the audio that is actually in the film, so they come from the clip's own transcript alignment — never from ElevenLabs timestamps and never from an estimated duration"
    });
  }
  if (narrationSource === NARRATION_SOURCE.ELEVENLABS) {
    return Object.freeze({ source: "ELEVENLABS_WITH_TIMESTAMPS", requiresRealAlignment: true, reason: "the synthesis returns character alignment from the same call" });
  }
  return Object.freeze({ source: "NONE", requiresRealAlignment: false, reason: "ambience carries no words, so it produces no subtitles" });
}

export const FILM_OVERRIDE = Object.freeze({
  VOICE_SOURCE_INCONSISTENCY: "VOICE_SOURCE_INCONSISTENCY",
  MANUAL_REVIEW_PENDING: "MANUAL_REVIEW_PENDING",
  POLICY: "POLICY"
});

/**
 * P0 Step 5C.47 — what a scene was ELIGIBLE for, against what actually happened to it.
 *
 * The scene decision is provisional: it answers "could this clip narrate itself?". The film decision is
 * final, and it can overrule a perfectly good scene because a film may not change voice halfway through.
 *
 * Keeping only the scene decision made the ledger lie. 5C.46 reported "1 TTS call avoidable" for a film that
 * then synthesised all six scenes anyway — the one eligible scene was overridden and the report never noticed.
 * An eligible scene whose film went the other way costs exactly as much as any other scene, and saying
 * otherwise is inventing a saving.
 */
export function applyFilmDecision(sceneDecisions = [], movieDecision = null) {
  const filmSource = movieDecision ? movieDecision.narrationSource : NARRATION_SOURCE.ELEVENLABS;
  const mixedAllowed = Boolean(movieDecision && movieDecision.mixedAllowed === true);
  const overrideReason = movieDecision && movieDecision.requiresReview === true
    ? FILM_OVERRIDE.MANUAL_REVIEW_PENDING
    : FILM_OVERRIDE.VOICE_SOURCE_INCONSISTENCY;

  return Object.freeze((sceneDecisions || []).map((d) => {
    if (!d) return null;
    const eligible = d.elevenLabsSkipped === true;
    // A film that allows mixed voices honours each scene; otherwise the film's source wins outright.
    const effectiveSource = mixedAllowed ? d.narrationSource : (d.narrationSource === NARRATION_SOURCE.NONE ? NARRATION_SOURCE.NONE : filmSource);
    const actuallySkipped = effectiveSource === NARRATION_SOURCE.GROK && eligible;
    const overridden = eligible && !actuallySkipped;
    return Object.freeze({
      ...d,
      sceneEligibleForTtsSkip: eligible,
      sceneActuallySkipped: actuallySkipped,
      filmOverrideReason: overridden ? overrideReason : null,
      effectiveNarrationSource: effectiveSource,
      // What the assembler must do, once the film has spoken. An overridden Grok scene keeps its ambience at
      // most: its speech would fight the synthesised narration that is now being used instead.
      effectiveMuteSourceSpeech: overridden ? true : d.muteSourceSpeech === true,
      effectiveKeepSourceAudio: overridden ? false : d.keepSourceAudio === true,
      // The skip flags follow what HAPPENED, not what was possible.
      elevenLabsSkipped: actuallySkipped,
      elevenLabsRequired: !actuallySkipped && effectiveSource !== NARRATION_SOURCE.NONE,
      elevenLabsSkipReason: actuallySkipped ? d.elevenLabsSkipReason : null
    });
  }).filter(Boolean));
}

/**
 * What the TTS bill would have been, and what it actually is.
 *
 * Takes the EFFECTIVE decisions — the ones that survived the film-level rule. Given raw scene decisions it
 * still works, but the caller is then measuring possibility rather than outcome, which is the mistake this
 * function exists to make impossible.
 */
export function ttsSavings(sceneDecisions = []) {
  const total = sceneDecisions.length;
  const actual = sceneDecisions.filter((d) => d && d.sceneActuallySkipped === true).length;
  // Fall back to the raw flag only when the film decision has not been applied at all.
  const skipped = sceneDecisions.some((d) => d && d.sceneActuallySkipped !== undefined)
    ? actual
    : sceneDecisions.filter((d) => d && d.elevenLabsSkipped === true).length;
  const eligible = sceneDecisions.filter((d) => d && (d.sceneEligibleForTtsSkip === true || (d.sceneEligibleForTtsSkip === undefined && d.elevenLabsSkipped === true))).length;
  const overridden = sceneDecisions.filter((d) => d && d.filmOverrideReason).length;
  const unmeasured = sceneDecisions.filter((d) => d && d.decision === AUDIO_DECISION.UNMEASURED).length;
  const needsNarration = sceneDecisions.filter((d) => d && d.narrationSource !== NARRATION_SOURCE.NONE).length;
  return Object.freeze({
    scenes: total,
    // Every scene that still needs a voice synthesised. This is the number that gets billed.
    ttsCallsRequired: needsNarration - skipped,
    elevenLabsCalls: needsNarration - skipped,
    elevenLabsSkipped: skipped,
    actualSkipped: skipped,
    eligibleForSkip: eligible,
    overriddenByFilm: overridden,
    unmeasuredScenes: unmeasured,
    // Scenes that MIGHT become skippable once something listens to them. Potential, never a saving.
    potentiallySkippable: unmeasured
  });
}
