// P0 Step 5C.39 — did the audio actually say the script?
//
// Synthesis alignment proves the provider TIMED the text it was handed. It does not prove the recording says
// it. A voice with no Danish returns a perfectly aligned recording of Danish words pronounced as English, and
// every timestamp in it is correct. The alignment cannot detect that, by construction: it is a statement about
// the input, not about the output.
//
// So the audio gets listened back to. Where a transcript is available it is compared word by word against the
// final script. Where one is not, the audio is still MEASURED — length against expectation, silence, missing
// head or tail — and the verdict says plainly which of those two situations produced it. An unverifiable
// recording is UNVERIFIED, never a pass.
//
// Pure: strings and numbers in, a verdict out. No provider, no ffmpeg.

export const TRANSCRIPT_VERDICT = Object.freeze({
  PASS: "PASS",
  REJECT: "REJECT",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  UNVERIFIED: "UNVERIFIED"
});

export const TRANSCRIPT_THRESHOLDS = Object.freeze({
  wordCoverage: 0.92,        // a few function words lost to transcription noise is normal; a clause is not
  sentenceCoverage: 0.95,    // a missing SENTENCE is a different failure from a missing word
  nameAccuracy: 0.85,        // a mispronounced character name is the one error a viewer always notices
  numberAccuracy: 0.95,      // "seventeen" for "seventy" changes the story
  minLanguageProbability: 0.60,
  maxLeadingSilenceMs: 1200,
  maxTrailingSilenceMs: 2000,
  maxInternalSilenceMs: 3000
});

const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Words, lowercased and stripped of punctuation, for comparison only — never for display. */
export function wordsOf(text) {
  return String(text || "").toLowerCase().match(WORD_RE) || [];
}

/** Sentences, kept in order. Abbreviations are not special-cased: over-splitting costs a little precision in
 *  coverage, while under-splitting could hide a whole missing clause, and only one of those is dangerous. */
export function sentencesOf(text) {
  return String(text || "")
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Longest common subsequence over word arrays. Not a set intersection: word ORDER carries meaning, and a
 * transcript containing every expected word in a scrambled order is not the script being read.
 */
function lcsLength(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  // Rolling row: the full matrix for a 3000-word script would be 9M cells for no benefit.
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
    cur.fill(0);
  }
  return prev[b.length];
}

/** How much of `expected` appears, in order, in `actual`. */
export function coverageOf(expectedWords, actualWords) {
  if (expectedWords.length === 0) return 1;
  return lcsLength(expectedWords, actualWords) / expectedWords.length;
}

/** Which of the named entities survived. A character's name is the thing a viewer notices instantly, so it is
 *  scored separately rather than being diluted among a few hundred ordinary words. */
export function nameAccuracyOf(names, actualWords) {
  const wanted = (names || []).map((n) => wordsOf(n)).filter((w) => w.length > 0);
  if (wanted.length === 0) return { score: null, missing: [], measured: false };
  const actual = new Set(actualWords);
  const missing = [];
  let hit = 0;
  for (const parts of wanted) {
    // A multi-word name counts as present when its distinctive parts are there; requiring an exact adjacent
    // match would fail on ordinary transcription spacing.
    const present = parts.filter((p) => actual.has(p)).length;
    if (present >= Math.ceil(parts.length / 2)) hit += 1; else missing.push(parts.join(" "));
  }
  return { score: hit / wanted.length, missing, measured: true };
}

export function numberAccuracyOf(expectedWords, actualWords) {
  const nums = (w) => w.filter((x) => /^\d+$/u.test(x));
  const want = nums(expectedWords);
  if (want.length === 0) return { score: null, missing: [], measured: false };
  const actual = new Set(nums(actualWords));
  const missing = want.filter((x) => !actual.has(x));
  return { score: (want.length - missing.length) / want.length, missing, measured: true };
}

/**
 * The verdict.
 *
 * `transcript` may be null — that is the "no STT available" case, and it produces UNVERIFIED with whatever the
 * audio measurements alone can establish. It never produces PASS: a recording nobody listened to has not been
 * verified, and calling it verified is the exact failure this module exists to prevent.
 */
export function verifyTranscript({
  script,
  transcript = null,
  expectedLocale = null,
  characterNames = [],
  audio = null,               // { durationSeconds, leadingSilenceMs, trailingSilenceMs, maxInternalSilenceMs, rms }
  expectedDurationSeconds = null,
  thresholds = TRANSCRIPT_THRESHOLDS
} = {}) {
  const T = { ...TRANSCRIPT_THRESHOLDS, ...thresholds };
  const expectedWords = wordsOf(script);
  const expectedSentences = sentencesOf(script);
  const failures = [];
  const warnings = [];

  // ---- what the audio itself shows, transcript or not ----------------------------------------------------
  const audioChecks = {};
  if (audio) {
    audioChecks.durationSeconds = audio.durationSeconds ?? null;
    audioChecks.leadingSilenceMs = audio.leadingSilenceMs ?? null;
    audioChecks.trailingSilenceMs = audio.trailingSilenceMs ?? null;
    audioChecks.maxInternalSilenceMs = audio.maxInternalSilenceMs ?? null;

    if (!Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0.2) {
      failures.push({ check: "audio-empty", detail: "the recording has no usable length" });
    }
    // A recording that starts a second and a half late has lost its opening, which reads as a missing line.
    if (Number.isFinite(audio.leadingSilenceMs) && audio.leadingSilenceMs > T.maxLeadingSilenceMs) {
      failures.push({ check: "leading-truncation", actual: audio.leadingSilenceMs, max: T.maxLeadingSilenceMs });
    }
    if (Number.isFinite(audio.trailingSilenceMs) && audio.trailingSilenceMs > T.maxTrailingSilenceMs) {
      warnings.push({ check: "trailing-silence", actual: audio.trailingSilenceMs, max: T.maxTrailingSilenceMs });
    }
    if (Number.isFinite(audio.maxInternalSilenceMs) && audio.maxInternalSilenceMs > T.maxInternalSilenceMs) {
      failures.push({ check: "internal-silence", actual: audio.maxInternalSilenceMs, max: T.maxInternalSilenceMs,
        detail: "a gap this long inside narration is a dropout, not a pause" });
    }
    // Wildly short audio for the text is the signature of a truncated synthesis.
    if (Number.isFinite(expectedDurationSeconds) && expectedDurationSeconds > 0 && Number.isFinite(audio.durationSeconds)) {
      const ratio = audio.durationSeconds / expectedDurationSeconds;
      audioChecks.durationRatio = Number(ratio.toFixed(3));
      if (ratio < 0.6) failures.push({ check: "audio-too-short", actual: audio.durationSeconds, expected: expectedDurationSeconds });
      else if (ratio > 1.6) warnings.push({ check: "audio-longer-than-planned", actual: audio.durationSeconds, expected: expectedDurationSeconds });
    }
  }

  // ---- no transcript: measured, but not verified ---------------------------------------------------------
  if (!transcript || typeof transcript.text !== "string" || transcript.text.trim().length === 0) {
    return Object.freeze({
      verdict: failures.length ? TRANSCRIPT_VERDICT.REJECT : TRANSCRIPT_VERDICT.UNVERIFIED,
      transcribed: false,
      detectedLanguage: null, languageMatch: null, languageProbability: null,
      wordCoverage: null, sentenceCoverage: null, nameAccuracy: null, numberAccuracy: null,
      missingSegments: [], substitutedSegments: [],
      leadingTruncation: audioChecks.leadingSilenceMs != null ? audioChecks.leadingSilenceMs > T.maxLeadingSilenceMs : null,
      trailingTruncation: null,
      confidence: 0,
      audio: Object.freeze(audioChecks),
      failures: Object.freeze(failures), warnings: Object.freeze(warnings),
      reason: failures.length
        ? "the audio failed its own measurements"
        : "no transcript was produced, so what the audio says is unverified — measured, not confirmed"
    });
  }

  // ---- transcript present: compare -----------------------------------------------------------------------
  const actualWords = wordsOf(transcript.text);
  const wordCoverage = coverageOf(expectedWords, actualWords);
  const detected = transcript.detectedLanguage || null;
  const langProb = Number.isFinite(transcript.languageProbability) ? transcript.languageProbability : null;

  // Compare the language SUBTAG: a provider saying "da" and a movie asking for "da-DK" agree.
  const base = (t) => String(t || "").toLowerCase().split(/[-_]/u)[0];
  const languageMatch = expectedLocale && detected ? base(detected) === base(expectedLocale) : null;
  if (languageMatch === false) {
    failures.push({ check: "language", expected: expectedLocale, actual: detected,
      detail: "the recording is not in the language the movie is written in" });
  }
  if (langProb != null && langProb < T.minLanguageProbability) {
    warnings.push({ check: "language-confidence", actual: langProb, min: T.minLanguageProbability });
  }

  // Sentence coverage: which sentences of the script can be found in the transcript. A missing sentence is a
  // structurally different failure from scattered missing words, and it is the one that ruins a film.
  const missingSegments = [];
  let sentenceHits = 0;
  for (let i = 0; i < expectedSentences.length; i += 1) {
    const sw = wordsOf(expectedSentences[i]);
    if (sw.length === 0) { sentenceHits += 1; continue; }
    const cov = coverageOf(sw, actualWords);
    if (cov >= 0.7) sentenceHits += 1;
    else missingSegments.push({ index: i, coverage: Number(cov.toFixed(3)), text: expectedSentences[i].slice(0, 120) });
  }
  const sentenceCoverage = expectedSentences.length === 0 ? 1 : sentenceHits / expectedSentences.length;

  // Head and tail, checked directly: losing the first or last line is both common and invisible in an average.
  const headWords = expectedWords.slice(0, Math.min(8, expectedWords.length));
  const tailWords = expectedWords.slice(Math.max(0, expectedWords.length - 8));
  const leadingTruncation = headWords.length > 0 && coverageOf(headWords, actualWords.slice(0, Math.max(16, headWords.length * 3))) < 0.5;
  const trailingTruncation = tailWords.length > 0 && coverageOf(tailWords, actualWords.slice(-Math.max(16, tailWords.length * 3))) < 0.5;

  const nameAcc = nameAccuracyOf(characterNames, actualWords);
  const numAcc = numberAccuracyOf(expectedWords, actualWords);

  if (wordCoverage < T.wordCoverage) failures.push({ check: "word-coverage", actual: Number(wordCoverage.toFixed(3)), floor: T.wordCoverage });
  if (sentenceCoverage < T.sentenceCoverage) failures.push({ check: "sentence-coverage", actual: Number(sentenceCoverage.toFixed(3)), floor: T.sentenceCoverage, missing: missingSegments.length });
  if (leadingTruncation) failures.push({ check: "leading-truncation", detail: "the opening words are not in the recording" });
  if (trailingTruncation) failures.push({ check: "trailing-truncation", detail: "the closing words are not in the recording" });
  if (nameAcc.measured && nameAcc.score < T.nameAccuracy) failures.push({ check: "name-accuracy", actual: Number(nameAcc.score.toFixed(3)), floor: T.nameAccuracy, missing: nameAcc.missing });
  if (numAcc.measured && numAcc.score < T.numberAccuracy) failures.push({ check: "number-accuracy", actual: Number(numAcc.score.toFixed(3)), floor: T.numberAccuracy, missing: numAcc.missing });

  // Substitutions: expected words absent while the transcript is otherwise dense — a proxy for "said something
  // else here", reported as evidence rather than scored, because a proxy should not become a number.
  const actualSet = new Set(actualWords);
  const substitutedSegments = expectedWords.filter((w) => w.length > 3 && !actualSet.has(w)).slice(0, 25);

  const confidence = Math.max(0, Math.min(1,
    0.45 * wordCoverage + 0.35 * sentenceCoverage +
    0.10 * (nameAcc.measured ? nameAcc.score : 1) +
    0.10 * (langProb == null ? 1 : langProb)));

  return Object.freeze({
    verdict: failures.length === 0 ? TRANSCRIPT_VERDICT.PASS : TRANSCRIPT_VERDICT.REJECT,
    transcribed: true,
    detectedLanguage: detected, languageMatch, languageProbability: langProb,
    wordCoverage: Number(wordCoverage.toFixed(4)),
    sentenceCoverage: Number(sentenceCoverage.toFixed(4)),
    nameAccuracy: nameAcc.measured ? Number(nameAcc.score.toFixed(4)) : null,
    numberAccuracy: numAcc.measured ? Number(numAcc.score.toFixed(4)) : null,
    missingSegments: Object.freeze(missingSegments),
    substitutedSegments: Object.freeze(substitutedSegments),
    leadingTruncation, trailingTruncation,
    confidence: Number(confidence.toFixed(4)),
    audio: Object.freeze(audioChecks),
    failures: Object.freeze(failures), warnings: Object.freeze(warnings),
    reason: failures.length === 0
      ? "the recording says what the script says"
      : failures.map((f) => f.check).join(", ")
  });
}
