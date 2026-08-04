// P0 Step 5C.45 — what kind of sound is in a Grok clip.
//
// Pure: measurements in, a class out. No ffmpeg, no files.
//
// THE RULE THAT MATTERS
// --------------------
// "There is an audio stream" is not "there is narration". Those are separated by two whole questions — is
// there any sound at all, and is that sound a voice reading our script — and a pipeline that collapses them
// either pays ElevenLabs for narration it already has, or ships a film with no voice.
//
// So this classifier is allowed to say NONE, SILENCE and AMBIENCE_ONLY on measurements alone, because those
// are claims about ENERGY. It is NOT allowed to say SPEECH_PRESENT or NARRATION_CANDIDATE from energy: a
// band ratio is not a voice detector, and asserting speech from one would be inventing evidence. Where the
// numbers are consistent with speech but nothing has listened, the answer is UNKNOWN and the reason says
// exactly what is missing.

export const SOURCE_AUDIO_CLASS = Object.freeze({
  NONE: "NONE",
  SILENCE: "SILENCE",
  AMBIENCE_ONLY: "AMBIENCE_ONLY",
  SFX_ONLY: "SFX_ONLY",
  AMBIENCE_AND_SFX: "AMBIENCE_AND_SFX",
  SPEECH_PRESENT: "SPEECH_PRESENT",
  NARRATION_CANDIDATE: "NARRATION_CANDIDATE",
  UNKNOWN: "UNKNOWN"
});

// Below this the track is inaudible in any normal playback: a −60 LUFS "sound" is an encoder artefact.
const INAUDIBLE_LUFS = -60;
// A track that is silent for essentially its whole length is silence, whatever a stray sample says.
const SILENT_RATIO = 0.97;
// Speech energy lives mostly between 300 Hz and 3.4 kHz. A ratio far below this cannot be a voice; a ratio
// above it is merely CONSISTENT with one, which is not the same as being one.
const SPEECH_BAND_FLOOR = 0.35;
// Sustained, low-variation energy is room tone. Speech and effects both move a lot more than this.
const AMBIENCE_MAX_LOUDNESS_RANGE = 4;
// A track dominated by short loud events with quiet between them behaves like effects rather than a bed.
const SFX_MIN_LOUDNESS_RANGE = 9;

/**
 * @param {object} m the output of measureAudio()
 * @param {object} opts.speechDetector an OPTIONAL certified detector's finding:
 *        { available: true, speechDetected: boolean, confidence: number, method: string }
 *        Only this can produce SPEECH_PRESENT / NARRATION_CANDIDATE.
 */
export function classifySourceAudio(m, { speechDetector = null, intendedNarration = "" } = {}) {
  const ev = {
    hasAudio: Boolean(m && m.hasAudio),
    silenceRatio: m ? m.silenceRatio ?? null : null,
    integratedLufs: m ? m.integratedLufs ?? null : null,
    loudnessRange: m ? m.loudnessRange ?? null : null,
    rmsDb: m ? m.rmsDb ?? null : null,
    speechBandRatio: m ? m.speechBandRatio ?? null : null,
    detector: speechDetector && speechDetector.available === true ? speechDetector.method || "detector" : null
  };
  const out = (klass, reason, extra = {}) => Object.freeze({ class: klass, reason, evidence: Object.freeze({ ...ev, ...extra }) });

  if (!m || m.measured !== true) return out(SOURCE_AUDIO_CLASS.UNKNOWN, "the audio was never measured");
  if (!m.hasAudio) return out(SOURCE_AUDIO_CLASS.NONE, "the file carries no audio stream");
  if (m.decoded !== true) return out(SOURCE_AUDIO_CLASS.UNKNOWN, "the audio stream could not be decoded");

  // ---- is there any sound at all? --------------------------------------------------------------------
  const inaudible = Number.isFinite(m.integratedLufs) && m.integratedLufs <= INAUDIBLE_LUFS;
  const mostlySilent = Number.isFinite(m.silenceRatio) && m.silenceRatio >= SILENT_RATIO;
  if (inaudible || mostlySilent) {
    return out(SOURCE_AUDIO_CLASS.SILENCE,
      inaudible ? `integrated loudness ${m.integratedLufs} LUFS is below the audible floor`
        : `${Math.round((m.silenceRatio || 0) * 100)}% of the track is below the silence threshold`);
  }

  // ---- a certified detector is the ONLY thing that may assert speech ---------------------------------
  if (speechDetector && speechDetector.available === true) {
    if (speechDetector.speechDetected === true) {
      // Narration candidate needs a script to be a candidate FOR. Without one it is speech and nothing more.
      const hasIntent = typeof intendedNarration === "string" && intendedNarration.trim().length > 0;
      return out(hasIntent ? SOURCE_AUDIO_CLASS.NARRATION_CANDIDATE : SOURCE_AUDIO_CLASS.SPEECH_PRESENT,
        `${speechDetector.method || "the detector"} found speech${hasIntent ? " and this scene has narration to compare it against" : ""}`,
        { detectorConfidence: speechDetector.confidence ?? null });
    }
    // The detector listened and heard no voice: the remaining sound is ambience or effects.
    return classifyNonSpeech(m, out, "a speech detector listened and found none");
  }

  // ---- no detector: energy can describe the sound but cannot name a voice ----------------------------
  const bandConsistent = Number.isFinite(m.speechBandRatio) && m.speechBandRatio >= SPEECH_BAND_FLOOR;
  if (bandConsistent) {
    return out(SOURCE_AUDIO_CLASS.UNKNOWN,
      "there is audible sound with energy in the speech band, but nothing has listened to it — a band ratio is not a voice detector",
      { needsTranscript: true });
  }
  return classifyNonSpeech(m, out, `speech-band energy is only ${m.speechBandRatio ?? "?"} of the total, too little to be a voice`);
}

/** Sound that is not a voice: a bed, discrete events, or both. Decided from how much the level moves. */
function classifyNonSpeech(m, out, why) {
  const lra = Number.isFinite(m.loudnessRange) ? m.loudnessRange : null;
  if (lra === null) return out(SOURCE_AUDIO_CLASS.UNKNOWN, `${why}, and the loudness range could not be measured`);
  if (lra <= AMBIENCE_MAX_LOUDNESS_RANGE) return out(SOURCE_AUDIO_CLASS.AMBIENCE_ONLY, `${why}; the level barely moves (LRA ${lra} LU), which is a bed`);
  if (lra >= SFX_MIN_LOUDNESS_RANGE) return out(SOURCE_AUDIO_CLASS.SFX_ONLY, `${why}; the level jumps (LRA ${lra} LU), which is discrete events`);
  return out(SOURCE_AUDIO_CLASS.AMBIENCE_AND_SFX, `${why}; the level moves moderately (LRA ${lra} LU), a bed with events over it`);
}

/** Classes that mean "a voice might be saying our words" and therefore need a transcript before any decision
 *  about ElevenLabs can be made. UNKNOWN is included deliberately: not knowing is a reason to look, never a
 *  reason to skip. */
export function needsTranscript(klass) {
  return klass === SOURCE_AUDIO_CLASS.SPEECH_PRESENT
    || klass === SOURCE_AUDIO_CLASS.NARRATION_CANDIDATE
    || klass === SOURCE_AUDIO_CLASS.UNKNOWN;
}

/** Classes that carry sound worth keeping under a synthesised narration. */
export function carriesUsableAmbience(klass) {
  return klass === SOURCE_AUDIO_CLASS.AMBIENCE_ONLY
    || klass === SOURCE_AUDIO_CLASS.SFX_ONLY
    || klass === SOURCE_AUDIO_CLASS.AMBIENCE_AND_SFX;
}
