// P0 Step 5C.37 — MOVIE QUALITY SCORECARD + PUBLISHABLE GATE (pure).
//
// "The render succeeded" has been standing in for "the content is good", and those are different claims.
// A film can encode perfectly and still narrate the wrong words over the wrong pictures with subtitles that
// arrive early. Nothing in the pipeline was able to say so, so a COMPLETED movie looked finished.
//
// Three states, because there are three genuinely different situations:
//
//   PIPELINE_COMPLETED       every stage ran and produced a file. That is an engineering fact.
//   QUALITY_REVIEW_REQUIRED  something is either below par or UNMEASURABLE here. A human decides.
//   PUBLISHABLE              every hard dimension passed, measured, with evidence.
//
// The middle state carries real weight. This deployment has no vision model, so "does the picture show what
// the line says" cannot be measured — and the honest response to a question you cannot answer is to ask a
// person, not to score it 1.0 and move on.
//
// Hard dimensions are never averaged. One of them failing means the film is not publishable, whatever the
// other eleven say — because an average is exactly how a wrong-narration movie ships with a 0.86.

export const MOVIE_STATE = Object.freeze({
  PIPELINE_COMPLETED: "PIPELINE_COMPLETED",
  QUALITY_REVIEW_REQUIRED: "QUALITY_REVIEW_REQUIRED",
  PUBLISHABLE: "PUBLISHABLE"
});

export const DIMENSION = Object.freeze({
  STORY_ADAPTATION: "storyAdaptation",
  HOOK: "hook",
  NARRATIVE_COHERENCE: "narrativeCoherence",
  PACING: "pacing",
  SEMANTIC_IMAGE_MATCH: "semanticImageMatch",
  CHARACTER_CONTINUITY: "characterContinuity",
  VISUAL_STYLE_CONTINUITY: "visualStyleContinuity",
  VOICE_CORRECTNESS: "voiceCorrectness",
  SUBTITLE_ALIGNMENT: "subtitleAlignment",
  AUDIO_MIX: "audioMix",
  TECHNICAL_VIDEO: "technicalVideo",
  MASTERING_720P: "mastering720p"
});

// A hard dimension is one where "mostly right" is not a thing: the narration is the wrong words or it is
// not; the face changed or it did not; the file is 720p or it is not.
export const HARD_DIMENSIONS = Object.freeze([
  DIMENSION.VOICE_CORRECTNESS,
  DIMENSION.SEMANTIC_IMAGE_MATCH,
  DIMENSION.CHARACTER_CONTINUITY,
  DIMENSION.SUBTITLE_ALIGNMENT,
  DIMENSION.MASTERING_720P,
  DIMENSION.TECHNICAL_VIDEO
]);

export const FLOORS = Object.freeze({
  storyAdaptation: 0.6, hook: 0.5, narrativeCoherence: 0.6, pacing: 0.55,
  semanticImageMatch: 0.7, characterContinuity: 0.8, visualStyleContinuity: 0.65,
  voiceCorrectness: 0.95, subtitleAlignment: 0.9, audioMix: 0.6,
  technicalVideo: 0.7, mastering720p: 1.0
});

/** A dimension that could not be measured. Reported as such — never as a pass, never as a zero. */
export const UNMEASURED = Object.freeze({ score: null, measured: false });

const round = (n, d = 4) => Number(Number(n).toFixed(d));
const dim = (score, evidence = {}, { measured = true } = {}) =>
  Object.freeze({ score: score === null ? null : round(Math.max(0, Math.min(1, score))), measured, evidence: Object.freeze(evidence) });

/**
 * Build the scorecard from the evidence each stage produced. Every argument is optional; anything absent
 * becomes an UNMEASURED dimension, which is a review trigger rather than a silent pass.
 */
export function buildMovieScorecard({
  adaptation = null, adaptationValidation = null,
  transcript = null,            // { coverage, missingWords, substitutions, detectedLanguage, expectedLanguage, ok }
  subtitleDrift = null,         // { medianMs, p95Ms, maxMs }
  driftTargets = { medianMs: 80, p95Ms: 150, maxMs: 250 },
  shotFidelity = null,          // { ok, problems }
  shotSemantics = null,         // [{ shotId, semanticScore, characterScore, styleScore, ... , measured }]
  master = null,                // certifyMaster() report
  timelineCoverage = null,      // { ok, gaps }
  audioMix = null,              // { narrationLufs, musicLufs, headroomDb }
  floors = FLOORS
} = {}) {
  const d = {};

  // ---- adaptation ----
  if (adaptation) {
    const beats = adaptation.beatSheet || [];
    const roles = new Set(beats.map((b) => String(b.role || "").toUpperCase()));
    const structural = ["HOOK", "SETUP", "PROGRESSION"].filter((r) => roles.has(r)).length / 3;
    const ending = roles.has("PAYOFF") || roles.has("CLIFFHANGER") ? 1 : 0;
    d[DIMENSION.STORY_ADAPTATION] = dim(adaptationValidation === false ? 0 : 0.5 + 0.3 * structural + 0.2 * ending,
      { beats: beats.length, roles: [...roles], validatedAgainstStory: adaptationValidation !== false });
    d[DIMENSION.HOOK] = dim(adaptation.hook ? Math.min(1, 0.6 + adaptation.hook.length / 400) : 0, { hook: String(adaptation.hook || "").slice(0, 120) });
    d[DIMENSION.NARRATIVE_COHERENCE] = dim(structural * 0.6 + ending * 0.4, { roles: [...roles] });
  } else {
    d[DIMENSION.STORY_ADAPTATION] = dim(null, { reason: "no adaptation artifact" }, UNMEASURED);
    d[DIMENSION.HOOK] = dim(null, {}, UNMEASURED);
    d[DIMENSION.NARRATIVE_COHERENCE] = dim(null, {}, UNMEASURED);
  }

  // ---- pacing: are the shots the right length for what they carry ----
  if (shotFidelity && Array.isArray(shotFidelity.shots)) {
    const durs = shotFidelity.shots.map((s) => s.expectedDurationMs).filter((x) => Number.isFinite(x));
    const tooShort = durs.filter((x) => x < 900).length;
    const tooLong = durs.filter((x) => x > 9000).length;
    d[DIMENSION.PACING] = dim(durs.length ? Math.max(0, 1 - (tooShort + tooLong) / durs.length) : null,
      { shots: durs.length, tooShort, tooLong }, { measured: durs.length > 0 });
  } else d[DIMENSION.PACING] = dim(null, {}, UNMEASURED);

  // ---- voice: what the audio actually says ----
  if (transcript && typeof transcript.coverage === "number") {
    const langOk = !transcript.expectedLanguage || !transcript.detectedLanguage
      || transcript.detectedLanguage.slice(0, 2).toLowerCase() === transcript.expectedLanguage.slice(0, 2).toLowerCase();
    const score = !langOk ? 0 : transcript.coverage;
    d[DIMENSION.VOICE_CORRECTNESS] = dim(score, {
      coverage: round(transcript.coverage), missingWords: (transcript.missingWords || []).slice(0, 12),
      substitutions: (transcript.substitutions || []).slice(0, 12),
      detectedLanguage: transcript.detectedLanguage || null, expectedLanguage: transcript.expectedLanguage || null,
      languageMatches: langOk
    });
  } else d[DIMENSION.VOICE_CORRECTNESS] = dim(null, { reason: "the audio was never transcribed, so what it says is unverified" }, UNMEASURED);

  // ---- subtitles: measured against the audio, not against intent ----
  if (subtitleDrift && Number.isFinite(subtitleDrift.medianMs)) {
    const t = driftTargets;
    const norm = (v, target) => Math.max(0, Math.min(1, 1 - Math.max(0, v - target) / (target * 3)));
    const score = Math.min(norm(subtitleDrift.medianMs, t.medianMs), norm(subtitleDrift.p95Ms, t.p95Ms), norm(subtitleDrift.maxMs, t.maxMs));
    d[DIMENSION.SUBTITLE_ALIGNMENT] = dim(score, { ...subtitleDrift, targets: t, perCue: undefined });
  } else d[DIMENSION.SUBTITLE_ALIGNMENT] = dim(null, { reason: "subtitles were not measured against the audio" }, UNMEASURED);

  // ---- image ↔ narration, and the two continuity dimensions ----
  const sem = Array.isArray(shotSemantics) ? shotSemantics.filter((s) => s && s.measured !== false) : [];
  const semTotal = Array.isArray(shotSemantics) ? shotSemantics.length : 0;
  if (sem.length && sem.length === semTotal) {
    const worst = (k) => Math.min(...sem.map((s) => (Number.isFinite(s[k]) ? s[k] : 1)));
    d[DIMENSION.SEMANTIC_IMAGE_MATCH] = dim(worst("semanticScore"), { shots: sem.length, worstShot: sem.slice().sort((a, b) => a.semanticScore - b.semanticScore)[0]?.shotId || null });
    d[DIMENSION.CHARACTER_CONTINUITY] = dim(worst("characterScore"), { shots: sem.length });
    d[DIMENSION.VISUAL_STYLE_CONTINUITY] = dim(worst("styleScore"), { shots: sem.length });
  } else {
    // No vision model here. Saying so is the whole point: an unanswerable question becomes a review, and a
    // film does not become publishable because nobody looked.
    const reason = semTotal === 0
      ? "no rendered-frame analysis is available on this runtime (no vision model), so what the pictures show is unverified"
      : `${semTotal - sem.length} of ${semTotal} shots were not analysed`;
    d[DIMENSION.SEMANTIC_IMAGE_MATCH] = dim(null, { reason }, UNMEASURED);
    d[DIMENSION.CHARACTER_CONTINUITY] = dim(null, { reason }, UNMEASURED);
    d[DIMENSION.VISUAL_STYLE_CONTINUITY] = dim(null, { reason }, UNMEASURED);
  }

  // ---- audio mix ----
  if (audioMix && Number.isFinite(audioMix.narrationLufs)) {
    const headroom = Number.isFinite(audioMix.headroomDb) ? audioMix.headroomDb : (audioMix.narrationLufs - (audioMix.musicLufs ?? -60));
    d[DIMENSION.AUDIO_MIX] = dim(headroom >= 8 ? 1 : Math.max(0, headroom / 8), { ...audioMix, headroomDb: round(headroom, 2) });
  } else d[DIMENSION.AUDIO_MIX] = dim(null, {}, UNMEASURED);

  // ---- technical + mastering, both from a real decode ----
  if (master) {
    d[DIMENSION.TECHNICAL_VIDEO] = dim(master.technicalScore, {
      sharpness: master.measured.sharpness, blockiness: master.measured.blockiness, banding: master.measured.banding,
      blackFrames: master.measured.blackFrames, decodeErrors: master.integrity.decodeErrors,
      failures: master.failures.filter((f) => ["sharpness", "blockiness", "black-frames", "frozen-frames", "decode-errors", "opening-black", "trailing-black"].includes(f.check))
    });
    const profileFailures = master.failures.filter((f) => ["display-size", "sar", "rotation", "video-codec", "pixel-format", "fps", "video-bitrate", "audio-codec", "audio-sample-rate", "frame-size", "source-resolution", "source-upscale", "duration"].includes(f.check));
    d[DIMENSION.MASTERING_720P] = dim(profileFailures.length ? 0 : 1, {
      displayWidth: master.measured.displayWidth, displayHeight: master.measured.displayHeight,
      sar: master.measured.sar, rotation: master.measured.rotation, fps: master.measured.fps,
      videoBitrateBps: master.measured.videoBitrateBps, audioSampleRate: master.measured.audioSampleRate,
      sources: master.sources, failures: profileFailures
    });
  } else {
    d[DIMENSION.TECHNICAL_VIDEO] = dim(null, { reason: "the finished file was never decoded" }, UNMEASURED);
    d[DIMENSION.MASTERING_720P] = dim(null, { reason: "the finished file was never decoded" }, UNMEASURED);
  }

  // ---- the verdict ----
  const failedHard = [];
  const unmeasuredHard = [];
  for (const key of HARD_DIMENSIONS) {
    const x = d[key];
    if (!x) continue;
    if (!x.measured || x.score === null) { unmeasuredHard.push(key); continue; }
    if (x.score < (floors[key] ?? 0.7)) failedHard.push(key);
  }
  const softFailed = Object.entries(d)
    .filter(([k, x]) => !HARD_DIMENSIONS.includes(k) && x.measured && x.score !== null && x.score < (floors[k] ?? 0.6))
    .map(([k]) => k);
  const blocking = [];
  if (timelineCoverage && timelineCoverage.ok === false) blocking.push("timelineCoverage");
  if (shotFidelity && shotFidelity.ok === false) blocking.push("shotFidelity");

  const state = failedHard.length || blocking.length
    ? MOVIE_STATE.QUALITY_REVIEW_REQUIRED
    : unmeasuredHard.length || softFailed.length
      ? MOVIE_STATE.QUALITY_REVIEW_REQUIRED
      : MOVIE_STATE.PUBLISHABLE;

  // An average, for a human's sense of the whole — explicitly NOT what decides anything.
  const scored = Object.values(d).filter((x) => x.measured && x.score !== null).map((x) => x.score);
  const overall = scored.length ? round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;

  return Object.freeze({
    version: 1,
    state,
    publishable: state === MOVIE_STATE.PUBLISHABLE,
    dimensions: Object.freeze(d),
    hardDimensions: HARD_DIMENSIONS,
    failedHardDimensions: Object.freeze(failedHard),
    unmeasuredHardDimensions: Object.freeze(unmeasuredHard),
    failedSoftDimensions: Object.freeze(softFailed),
    blocking: Object.freeze(blocking),
    overallAdvisory: overall,
    reviewReasons: Object.freeze([
      ...failedHard.map((k) => ({ dimension: k, kind: "BELOW_FLOOR", score: d[k].score, floor: floors[k] })),
      ...unmeasuredHard.map((k) => ({ dimension: k, kind: "UNMEASURED", reason: d[k].evidence.reason || null })),
      ...softFailed.map((k) => ({ dimension: k, kind: "SOFT_BELOW_FLOOR", score: d[k].score, floor: floors[k] })),
      ...blocking.map((k) => ({ dimension: k, kind: "BLOCKING" }))
    ])
  });
}

/**
 * Which component to repair. A movie with one bad shot needs that shot regenerated, not the film — and
 * routing by the dimension that failed is what makes that automatic rather than a judgement call.
 */
export function repairPlanFor(scorecard) {
  const actions = [];
  const seen = new Set();
  const add = (component, reason, scope = null) => {
    const key = `${component}|${scope || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(Object.freeze({ component, reason, scope }));
  };
  for (const r of scorecard.reviewReasons) {
    switch (r.dimension) {
      case DIMENSION.VOICE_CORRECTNESS: add("NARRATION", r.kind === "UNMEASURED" ? "the audio was never verified against the script" : "the audio does not say what the script says"); break;
      case DIMENSION.SUBTITLE_ALIGNMENT: add("SUBTITLES", "the cues do not follow the voice"); break;
      case DIMENSION.SEMANTIC_IMAGE_MATCH: add("SHOT", "a shot does not show what its line says", "failed-shots"); break;
      case DIMENSION.CHARACTER_CONTINUITY: add("SHOT", "a character changed between shots; regenerate with a stronger reference", "failed-shots"); break;
      case DIMENSION.VISUAL_STYLE_CONTINUITY: add("SHOT", "the visual style drifted", "failed-shots"); break;
      case DIMENSION.TECHNICAL_VIDEO: add("CLIP", "a source clip is technically unusable"); break;
      case DIMENSION.MASTERING_720P: add("RENDER", "the master does not meet the 720p profile"); break;
      case DIMENSION.STORY_ADAPTATION:
      case DIMENSION.HOOK:
      case DIMENSION.NARRATIVE_COHERENCE: add("ADAPTATION", "the adaptation itself needs work"); break;
      case "timelineCoverage": add("SHOT_PLAN", "narration is playing over nothing"); break;
      case "shotFidelity": add("SHOT_PLAN", "a shot is not tied to the line it plays over"); break;
      default: add("REVIEW", `${r.dimension} needs a human`); break;
    }
  }
  return Object.freeze({ actions: Object.freeze(actions), wholeMovieRegeneration: false });
}
