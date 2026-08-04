// P0 Step 5C.45 §2 — is the voice in this clip reading OUR script?
//
// Pure. A transcript and the intended narration go in, a verdict comes out. Reuses the 5C.39 coverage
// measure, because "how much of the intended text is actually present, in order" is the same question there
// and here.
//
// THE ONE THING THIS MUST NOT DO
// ------------------------------
// Turn "we could not listen" into "it matched". Skipping ElevenLabs on a wrong verdict ships a film whose
// voice says something other than the script — the failure is silent, it is downstream of everything, and it
// is only discovered by watching. So an absent transcript is UNMEASURED_NO_STT_CAPABILITY and that verdict
// can never route to USE_GROK_NARRATION.

import { createHash } from "node:crypto";
import { verifyTranscript } from "./transcript-verification.mjs";

export const NARRATION_VERDICT = Object.freeze({
  EXACT_NARRATION_MATCH: "EXACT_NARRATION_MATCH",
  ACCEPTABLE_NARRATION_MATCH: "ACCEPTABLE_NARRATION_MATCH",
  PARTIAL_NARRATION_MATCH: "PARTIAL_NARRATION_MATCH",
  UNRELATED_DIALOGUE: "UNRELATED_DIALOGUE",
  WRONG_LANGUAGE: "WRONG_LANGUAGE",
  UNINTELLIGIBLE: "UNINTELLIGIBLE",
  NO_SPEECH: "NO_SPEECH",
  UNMEASURED_NO_STT_CAPABILITY: "UNMEASURED_NO_STT_CAPABILITY",
  // 5C.46 - the transcriber ran and does not trust its own output. Different from having no transcriber at
  // all, and different again from a confident transcript that simply does not match: this one means the words
  // on the page may not be the words in the clip, so nothing may be concluded from comparing them.
  UNMEASURED_LOW_CONFIDENCE: "UNMEASURED_LOW_CONFIDENCE"
});

// Below this the transcript is not evidence about anything. Whisper's avg_logprob maps to roughly 0.4-0.9 on
// clean speech; under 0.35 the decode is mostly the model's prior rather than the audio.
const MIN_TRANSCRIPT_CONFIDENCE = 0.35;
// A model that says it is probably not speech has overridden its own transcript.
const MAX_NO_SPEECH_PROBABILITY = 0.6;
// Words must span enough of the clip to caption it. A line covering a fifth of the shot cannot carry it.
const MIN_TIMESTAMP_COVERAGE = 0.35;

// Coverage thresholds. Exact is not string equality — a transcriber writes "twenty" for "20" and drops a
// comma — but it is close enough that nothing a listener would notice is missing.
const EXACT_COVERAGE = 0.97;
const ACCEPTABLE_COVERAGE = 0.90;
const PARTIAL_COVERAGE = 0.55;
// Below this the transcript is not a damaged version of our line, it is a different line.
const UNRELATED_COVERAGE = 0.25;
// How much of the head or tail may be missing before the take is unusable even at good coverage: a narration
// that starts three words in cannot be laid against a shot that starts at zero.
const MAX_EDGE_LOSS = 0.15;

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);

export function transcriptHash(text) {
  return `sha256:${createHash("sha256").update(norm(text), "utf8").digest("hex")}`;
}

/** How much of the START and END of the intended text is missing from the transcript. Measured separately
 *  because an edit can survive a hole in the middle and cannot survive a missing opening. */
function edgeLoss(intended, heard) {
  const a = words(intended);
  const b = new Set(words(heard));
  if (a.length === 0) return { head: 0, tail: 0 };
  const window = Math.max(1, Math.round(a.length * 0.2));
  const headMissing = a.slice(0, window).filter((w) => !b.has(w)).length / window;
  const tailMissing = a.slice(-window).filter((w) => !b.has(w)).length / window;
  return { head: Number(headMissing.toFixed(3)), tail: Number(tailMissing.toFixed(3)) };
}

/**
 * @param {object} p
 *   transcript        — what a transcriber heard, or null when nothing listened
 *   intendedNarration — what the scene's narration says
 *   expectedLanguage  — the movie's language tag/name, if known
 *   detectedLanguage  — what the transcriber reported, if anything
 *   sttAvailable      — whether a transcription capability exists at all
 *   speechDetected    — from the audio classification; false means there is nothing to transcribe
 */
export function matchNarration({
  transcript = null, intendedNarration = "", expectedLanguage = null, detectedLanguage = null,
  sttAvailable = false, speechDetected = null, intelligibility = null, characterNames = [],
  // 5C.46 - what the transcriber itself reported about its own output.
  transcriptConfidence = null, noSpeechProbability = null, timestampCoverage = null
} = {}) {
  const base = {
    intendedWords: words(intendedNarration).length,
    transcribedWords: transcript ? words(transcript).length : 0,
    expectedLanguage: expectedLanguage || null,
    detectedLanguage: detectedLanguage || null,
    transcriptHash: transcript ? transcriptHash(transcript) : null
  };
  const out = (verdict, reason, extra = {}) => Object.freeze({ verdict, reason, evidence: Object.freeze({ ...base, ...extra }) });

  if (speechDetected === false) return out(NARRATION_VERDICT.NO_SPEECH, "the audio classification found no speech to compare");
  if (!sttAvailable || transcript === null || transcript === undefined) {
    return out(NARRATION_VERDICT.UNMEASURED_NO_STT_CAPABILITY,
      sttAvailable ? "no transcript was produced for this clip" : "this runtime has no local speech-to-text capability, so nothing has listened to the audio");
  }
  if (!String(transcript).trim()) return out(NARRATION_VERDICT.NO_SPEECH, "the transcriber returned nothing");

  // Language first: a perfect reading of the right words in the wrong language is still unusable.
  if (expectedLanguage && detectedLanguage) {
    const a = String(expectedLanguage).slice(0, 2).toLowerCase();
    const b = String(detectedLanguage).slice(0, 2).toLowerCase();
    if (a !== b) return out(NARRATION_VERDICT.WRONG_LANGUAGE, `the audio is ${detectedLanguage} and the film is ${expectedLanguage}`);
  }
  // The transcriber's own opinion of its output comes before any comparison. A low-confidence decode that
  // happens to share words with the script is a coincidence, and treating it as a match is how a film ends up
  // narrated by a hallucination.
  if (Number.isFinite(noSpeechProbability) && noSpeechProbability > MAX_NO_SPEECH_PROBABILITY) {
    return out(NARRATION_VERDICT.NO_SPEECH, `the model puts the probability of no speech at ${noSpeechProbability}`, { noSpeechProbability });
  }
  if (Number.isFinite(transcriptConfidence) && transcriptConfidence < MIN_TRANSCRIPT_CONFIDENCE) {
    return out(NARRATION_VERDICT.UNMEASURED_LOW_CONFIDENCE,
      `the transcriber's confidence is ${transcriptConfidence}, too low for the transcript to be evidence either way`,
      { transcriptConfidence, noSpeechProbability });
  }
  // Only once the audio itself is settled does the absence of a script matter. Asking "does this match the
  // narration" of a clip the model says contains no speech produced UNRELATED_DIALOGUE for silence.
  if (!String(intendedNarration).trim()) {
    return out(NARRATION_VERDICT.UNRELATED_DIALOGUE, "there is speech in the clip and no narration to compare it against");
  }
  if (Number.isFinite(intelligibility) && intelligibility < 0.4) {
    return out(NARRATION_VERDICT.UNINTELLIGIBLE, `the transcriber's confidence is ${intelligibility}`, { intelligibility });
  }

  // 5C.39's verifier is the measure of record: word and sentence coverage by LCS, name and number accuracy,
  // and the truncation checks. Coverage here is the WORD coverage, which is the question "is our line in
  // there"; sentence coverage rides along as evidence.
  // verifyTranscript takes the transcriber's RECORD, not a bare string: the text plus what it reported about
  // language and confidence. Passing a string makes it return "no transcript was produced", which reads as a
  // total mismatch — coverage 0 — and would route a perfect take to UNRELATED_DIALOGUE.
  const v = verifyTranscript({
    script: intendedNarration,
    transcript: {
      text: String(transcript),
      detectedLanguage: detectedLanguage || null,
      languageProbability: Number.isFinite(intelligibility) ? intelligibility : null
    },
    expectedLocale: expectedLanguage || null,
    characterNames: Array.isArray(characterNames) ? characterNames : []
  });
  const coverage = Number.isFinite(v.wordCoverage) ? v.wordCoverage : 0;
  const edges = edgeLoss(intendedNarration, transcript);
  const extra = {
    coverage: Number(coverage.toFixed(4)),
    sentenceCoverage: v.sentenceCoverage ?? null,
    nameAccuracy: v.nameAccuracy ?? null,
    numberAccuracy: v.numberAccuracy ?? null,
    missingWords: (v.missingSegments || []).slice(0, 12),
    substitutions: (v.substitutedSegments || []).slice(0, 12),
    leadingTruncation: v.leadingTruncation === true,
    trailingTruncation: v.trailingTruncation === true,
    transcriptConfidence: v.confidence ?? null,
    headMissing: edges.head, tailMissing: edges.tail,
    intelligibility: Number.isFinite(intelligibility) ? intelligibility : null,
    transcriptConfidence: Number.isFinite(transcriptConfidence) ? transcriptConfidence : (v.confidence ?? null),
    noSpeechProbability: Number.isFinite(noSpeechProbability) ? noSpeechProbability : null,
    timestampCoverage: Number.isFinite(timestampCoverage) ? timestampCoverage : null
  };

  if (coverage < UNRELATED_COVERAGE) {
    return out(NARRATION_VERDICT.UNRELATED_DIALOGUE, `only ${Math.round(coverage * 100)}% of the narration is present — this is different speech, not a damaged take`, extra);
  }
  // A hole at either edge disqualifies an otherwise good take: the shot starts at zero and so must the line.
  if (edges.head > MAX_EDGE_LOSS || edges.tail > MAX_EDGE_LOSS || v.leadingTruncation === true || v.trailingTruncation === true) {
    const which = (edges.head > MAX_EDGE_LOSS || v.leadingTruncation === true) ? "the opening" : "the ending";
    return out(NARRATION_VERDICT.PARTIAL_NARRATION_MATCH,
      `${Math.round(coverage * 100)}% covered, but ${which} is missing`, extra);
  }
  if (coverage >= EXACT_COVERAGE) return out(NARRATION_VERDICT.EXACT_NARRATION_MATCH, `${Math.round(coverage * 100)}% of the narration is present, in order`, extra);
  if (coverage >= ACCEPTABLE_COVERAGE) return out(NARRATION_VERDICT.ACCEPTABLE_NARRATION_MATCH, `${Math.round(coverage * 100)}% of the narration is present, in order`, extra);
  if (coverage >= PARTIAL_COVERAGE) return out(NARRATION_VERDICT.PARTIAL_NARRATION_MATCH, `${Math.round(coverage * 100)}% of the narration is present`, extra);
  return out(NARRATION_VERDICT.UNRELATED_DIALOGUE, `${Math.round(coverage * 100)}% of the narration is present, too little to be this line`, extra);
}

/** The only two verdicts that may replace a synthesised narration. Everything else, including every
 *  UNMEASURED, keeps ElevenLabs. */
export const NARRATION_THRESHOLDS = Object.freeze({
  EXACT_COVERAGE, ACCEPTABLE_COVERAGE, PARTIAL_COVERAGE, UNRELATED_COVERAGE, MAX_EDGE_LOSS,
  MIN_TRANSCRIPT_CONFIDENCE, MAX_NO_SPEECH_PROBABILITY, MIN_TIMESTAMP_COVERAGE
});

export function narrationUsable(verdict) {
  return verdict === NARRATION_VERDICT.EXACT_NARRATION_MATCH || verdict === NARRATION_VERDICT.ACCEPTABLE_NARRATION_MATCH;
}

/** Verdicts where the clip contains speech that would fight a synthesised narration if left in the mix. */
export function speechConflicts(verdict) {
  return verdict === NARRATION_VERDICT.UNRELATED_DIALOGUE
    || verdict === NARRATION_VERDICT.WRONG_LANGUAGE
    || verdict === NARRATION_VERDICT.UNINTELLIGIBLE
    || verdict === NARRATION_VERDICT.PARTIAL_NARRATION_MATCH;
}
