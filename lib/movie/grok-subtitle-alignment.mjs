// P0 Step 5C.46 §5 — subtitles cut from the audio that is actually in the film.
//
// Pure. Whisper word timings in, cues out, with the drift measured against the words themselves.
//
// WHY THIS CANNOT BE SHARED WITH THE ELEVENLABS PATH
// --------------------------------------------------
// When the narration comes from ElevenLabs, the synthesis returns a character alignment for the exact audio it
// produced — the cues and the sound come from one call and cannot disagree. When the narration is the clip's
// own voice, that alignment describes a recording which is NOT in the film. Using it would put captions on a
// timeline nobody can hear, and an estimated duration is worse still: 5C.36 and 5C.39 both exist because a
// caption appeared when a shot started rather than when a word was said.
//
// So a Grok narration gets its cues from the Grok transcript, or it does not get published.

export const SUBTITLE_ERRORS = Object.freeze({
  NO_ALIGNMENT: "E_SUBTITLE_NO_REAL_ALIGNMENT",
  DRIFT_TOO_HIGH: "E_SUBTITLE_DRIFT_TOO_HIGH",
  COVERAGE_TOO_LOW: "E_SUBTITLE_TIMESTAMP_COVERAGE_TOO_LOW"
});

// The same targets the ElevenLabs path is held to, so a film does not get looser captions by changing source.
export const SUBTITLE_TARGETS = Object.freeze({ medianMs: 80, p95Ms: 150, maxMs: 250, minCoverage: 0.35 });

const CUE_MAX_CHARS = 84;
const CUE_MAX_SECONDS = 6;
// A gap this long between words is a sentence break the ear already hears.
const CUE_SPLIT_GAP_SECONDS = 0.7;

const round = (n, d = 3) => (Number.isFinite(n) ? Number(Number(n).toFixed(d)) : null);

/**
 * Group word timings into readable cues.
 *
 * Split on the pauses the speaker actually left, then on length — never on a fixed interval, because a cue
 * boundary that falls mid-phrase is the thing subtitles are judged on.
 */
export function cuesFromWords(words = [], { maxChars = CUE_MAX_CHARS, maxSeconds = CUE_MAX_SECONDS, splitGap = CUE_SPLIT_GAP_SECONDS } = {}) {
  const usable = (words || []).filter((w) => w && typeof w.word === "string" && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
  const cues = [];
  let cur = null;
  for (let i = 0; i < usable.length; i += 1) {
    const w = usable[i];
    const prev = usable[i - 1] || null;
    const gap = prev ? w.start - prev.end : 0;
    const wouldBeTooLong = cur && (`${cur.text} ${w.word}`.trim().length > maxChars || (w.end - cur.startMs / 1000) > maxSeconds);
    if (!cur || gap >= splitGap || wouldBeTooLong) {
      if (cur) cues.push(cur);
      cur = { startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000), text: w.word.trim(), words: 1 };
    } else {
      cur.endMs = Math.round(w.end * 1000);
      cur.text = `${cur.text} ${w.word.trim()}`.trim();
      cur.words += 1;
    }
  }
  if (cur) cues.push(cur);
  return Object.freeze(cues.map((c) => Object.freeze(c)));
}

/**
 * How far each cue sits from the word it is supposed to caption.
 *
 * Built by construction here — cues come FROM the words — so this is not a coincidence check but a regression
 * guard: it fails loudly if a future change starts rounding, padding or re-timing cues away from the audio.
 */
export function measureCueDrift(cues = [], words = []) {
  const usable = (words || []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
  if (!cues.length || !usable.length) {
    return Object.freeze({ measured: false, medianMs: null, p95Ms: null, maxMs: null, cues: cues.length, reason: "no cues or no word timings to measure against" });
  }
  const deltas = [];
  for (const c of cues) {
    // The word that should open this cue is the one nearest its start.
    let best = null;
    for (const w of usable) {
      const d = Math.abs(w.start * 1000 - c.startMs);
      if (best === null || d < best) best = d;
    }
    if (best !== null) deltas.push(best);
  }
  deltas.sort((a, b) => a - b);
  const at = (q) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))];
  return Object.freeze({
    measured: true,
    medianMs: round(at(0.5), 1), p95Ms: round(at(0.95), 1), maxMs: round(deltas[deltas.length - 1], 1),
    cues: cues.length, words: usable.length
  });
}

/**
 * Build the subtitle track for a scene narrated by the clip's own voice — or refuse.
 *
 * Refusing is the point. A Grok narration whose alignment is too thin or too loose produces no subtitles and
 * blocks publication, rather than shipping captions that drift away from the voice.
 */
export function buildGrokSubtitles({ transcript = null, sceneStartMs = 0, targets = SUBTITLE_TARGETS } = {}) {
  const words = transcript && Array.isArray(transcript.words) ? transcript.words : [];
  if (!words.length) {
    return Object.freeze({ ok: false, code: SUBTITLE_ERRORS.NO_ALIGNMENT, cues: [], drift: null,
      reason: "the clip's narration has no word timings, so its captions would have to be estimated" });
  }
  const duration = Number.isFinite(transcript.durationSeconds) ? transcript.durationSeconds : null;
  const span = words[words.length - 1].end - words[0].start;
  const coverage = duration && duration > 0 ? Math.min(1, span / duration) : 0;
  if (coverage < targets.minCoverage) {
    return Object.freeze({ ok: false, code: SUBTITLE_ERRORS.COVERAGE_TOO_LOW, cues: [], drift: null, timestampCoverage: round(coverage, 4),
      reason: `the aligned words span only ${Math.round(coverage * 100)}% of the shot, too little to caption it` });
  }

  const local = cuesFromWords(words);
  const drift = measureCueDrift(local, words);
  if (drift.measured && (drift.medianMs > targets.medianMs || drift.p95Ms > targets.p95Ms || drift.maxMs > targets.maxMs)) {
    return Object.freeze({ ok: false, code: SUBTITLE_ERRORS.DRIFT_TOO_HIGH, cues: [], drift, timestampCoverage: round(coverage, 4),
      reason: `cue drift is median ${drift.medianMs}ms / p95 ${drift.p95Ms}ms / max ${drift.maxMs}ms against targets ${targets.medianMs}/${targets.p95Ms}/${targets.maxMs}` });
  }

  // Shift into the film's timeline once, at the end: cue times are relative to the clip until then.
  const offset = Math.round(Number(sceneStartMs) || 0);
  return Object.freeze({
    ok: true, code: null,
    source: "GROK_AUDIO_ALIGNMENT",
    timestampCoverage: round(coverage, 4),
    drift,
    cues: Object.freeze(local.map((c) => Object.freeze({ ...c, startMs: c.startMs + offset, endMs: c.endMs + offset }))),
    reason: `cut from ${words.length} word timings in the clip's own audio`
  });
}

/** May a film narrated by Grok be published? Only when every scene produced real, in-tolerance cues. */
export function grokSubtitlesPublishable(perScene = []) {
  const failures = perScene.filter((s) => !s || s.ok !== true);
  return Object.freeze({
    publishable: perScene.length > 0 && failures.length === 0,
    scenes: perScene.length, failed: failures.length,
    codes: Object.freeze([...new Set(failures.map((f) => (f && f.code) || SUBTITLE_ERRORS.NO_ALIGNMENT))]),
    reason: failures.length === 0
      ? "every scene's captions were cut from its own audio and are inside the drift targets"
      : `${failures.length} scene(s) could not produce real captions from the clip audio`
  });
}
