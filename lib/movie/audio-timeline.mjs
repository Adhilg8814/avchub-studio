// P0 Step 5C.37 — AUDIO-TRUTH TIMELINE (pure, no ffmpeg, no provider).
//
// Until now every timing in a movie was an ESTIMATE. 5C.36 made those estimates honest — it stopped the
// pipeline promising a length it would not deliver — but an estimate is still not the thing. Subtitles were
// laid out by dividing a scene's duration; a cue appeared because a shot started, not because a voice said
// a word. On a good day that is close. It is never right.
//
// The narration audio is the only thing that knows when a word was actually spoken, so it becomes the
// source of truth for everything downstream:
//
//     final narration script -> TTS -> REAL character timings -> words -> sentences -> segments
//                                                                  |
//                                            shot allocation ------+------ subtitle cues
//
// ElevenLabs returns character-level alignment from the same synthesis call that produces the audio
// (`/with-timestamps`), so this costs no extra quota — the timings were always there, we simply were not
// asking for them. This module turns that character stream into the structures the rest of the pipeline
// needs, and refuses to invent anything it was not given.

export const TIMELINE_ERRORS = Object.freeze({
  NO_ALIGNMENT: "E_MOVIE_TIMELINE_NO_ALIGNMENT",
  ALIGNMENT_MISMATCH: "E_MOVIE_TIMELINE_ALIGNMENT_MISMATCH",
  NOT_COVERED: "E_MOVIE_TIMELINE_NOT_COVERED",
  SUBTITLE_DRIFT: "E_MOVIE_SUBTITLE_DRIFT"
});

// Subtitle drift budget. A cue that appears before the voice is the worst kind of wrong — the viewer reads
// the line before hearing it — so the targets are tight and measured, not asserted.
export const DRIFT_TARGETS = Object.freeze({ medianMs: 80, p95Ms: 150, maxMs: 250 });
// Readability. Two lines, and a line length that fits a 9:16 safe area at a normal caption size.
export const SUBTITLE_LIMITS = Object.freeze({ maxLines: 2, maxCharsPerLine: 42, minCueMs: 700, maxCueMs: 7000, gapMs: 40 });

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const round = (n, d = 3) => Number(Number(n).toFixed(d));

/**
 * ElevenLabs `with-timestamps` returns:
 *   { audio_base64, alignment: { characters: [...], character_start_times_seconds: [...], character_end_times_seconds: [...] } }
 * Normalise it into a character stream, refusing anything ragged rather than papering over it.
 */
export function normalizeAlignment(raw) {
  const a = raw && (raw.alignment || raw.normalized_alignment || raw);
  const chars = a && (a.characters || a.chars);
  const starts = a && (a.character_start_times_seconds || a.characterStartTimesSeconds || a.starts);
  const ends = a && (a.character_end_times_seconds || a.characterEndTimesSeconds || a.ends);
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) {
    throw err(TIMELINE_ERRORS.NO_ALIGNMENT, "the synthesis returned no character alignment");
  }
  if (chars.length !== starts.length || chars.length !== ends.length) {
    throw err(TIMELINE_ERRORS.ALIGNMENT_MISMATCH, "the alignment arrays disagree in length",
      { characters: chars.length, starts: starts.length, ends: ends.length });
  }
  if (chars.length === 0) throw err(TIMELINE_ERRORS.NO_ALIGNMENT, "the alignment is empty");
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const s = Number(starts[i]), e = Number(ends[i]);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) {
      throw err(TIMELINE_ERRORS.ALIGNMENT_MISMATCH, `character ${i} has no usable timing`, { index: i, start: starts[i], end: ends[i] });
    }
    // Timings must advance. A provider that hands back a non-monotonic stream is not something to "fix up"
    // silently — every downstream cue would inherit the confusion.
    if (s + 1e-6 < prevEnd - 0.05) {
      throw err(TIMELINE_ERRORS.ALIGNMENT_MISMATCH, `character ${i} starts before the previous one ended`, { index: i });
    }
    prevEnd = Math.max(prevEnd, e);
    out.push({ ch: String(chars[i]), startMs: Math.round(s * 1000), endMs: Math.round(e * 1000) });
  }
  return Object.freeze(out);
}

/** Group the character stream into words, keeping the exact text and the real boundaries. */
export function wordsFromCharacters(characters) {
  const words = [];
  let cur = null;
  for (const c of characters) {
    const isSpace = /\s/u.test(c.ch);
    if (isSpace) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { text: c.ch, startMs: c.startMs, endMs: c.endMs };
    else { cur.text += c.ch; cur.endMs = Math.max(cur.endMs, c.endMs); }
  }
  if (cur) words.push(cur);
  return Object.freeze(words.map((w) => Object.freeze(w)));
}

const SENTENCE_END = /[.!?…]["”»']?$/u;

/**
 * Group words into sentences using the punctuation the words themselves carry, so a "sentence" is exactly
 * what was spoken — not a guess made from the script and hoped to line up.
 */
export function sentencesFromWords(words) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (SENTENCE_END.test(w.text)) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return Object.freeze(out.map((ws, i) => Object.freeze({
    index: i,
    text: ws.map((w) => w.text).join(" "),
    startMs: ws[0].startMs,
    endMs: ws[ws.length - 1].endMs,
    words: Object.freeze(ws)
  })));
}

/**
 * The durable narration timeline: one segment per sentence, each carrying the exact text, the real audio
 * boundaries, and its words. This is what shots and subtitles are both allocated from, which is the whole
 * point — they cannot disagree if they are derived from the same measured thing.
 */
export function buildNarrationTimeline({ alignment, offsetMs = 0, beatId = null, segmentPrefix = "seg" } = {}) {
  const characters = Array.isArray(alignment) ? alignment : normalizeAlignment(alignment);
  const words = wordsFromCharacters(characters);
  if (!words.length) throw err(TIMELINE_ERRORS.NO_ALIGNMENT, "the alignment contains no words");
  const sentences = sentencesFromWords(words);
  const segments = sentences.map((s, i) => Object.freeze({
    segmentId: `${segmentPrefix}_${String(i).padStart(3, "0")}`,
    text: s.text,
    audioStartMs: s.startMs + offsetMs,
    audioEndMs: s.endMs + offsetMs,
    words: Object.freeze(s.words.map((w) => Object.freeze({ text: w.text, startMs: w.startMs + offsetMs, endMs: w.endMs + offsetMs }))),
    associatedBeatId: beatId,
    associatedShotIds: Object.freeze([])
  }));
  return Object.freeze({
    segments: Object.freeze(segments),
    startMs: segments[0].audioStartMs,
    endMs: segments[segments.length - 1].audioEndMs,
    wordCount: words.length,
    sentenceCount: segments.length
  });
}

/** Join several per-scene timelines into one film timeline, offsetting each by where its audio actually sits. */
export function concatTimelines(parts) {
  const segments = [];
  let cursor = 0;
  for (const p of parts) {
    const offset = Number.isFinite(p.offsetMs) ? p.offsetMs : cursor;
    for (const s of p.timeline.segments) {
      segments.push(Object.freeze({
        ...s,
        segmentId: `${p.prefix || "seg"}_${segments.length.toString().padStart(3, "0")}`,
        audioStartMs: s.audioStartMs + offset,
        audioEndMs: s.audioEndMs + offset,
        words: Object.freeze(s.words.map((w) => Object.freeze({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset }))),
        associatedBeatId: p.beatId ?? s.associatedBeatId
      }));
    }
    cursor = offset + (p.timeline.endMs - Math.min(0, p.timeline.startMs)) + (Number.isFinite(p.gapMs) ? p.gapMs : 0);
  }
  if (!segments.length) throw err(TIMELINE_ERRORS.NO_ALIGNMENT, "no segments to join");
  return Object.freeze({
    segments: Object.freeze(segments),
    startMs: segments[0].audioStartMs,
    endMs: segments[segments.length - 1].audioEndMs,
    wordCount: segments.reduce((a, s) => a + s.words.length, 0),
    sentenceCount: segments.length
  });
}

// ---------------------------------------------------------------- subtitles, from the audio
// Break a line at a MEANINGFUL place: after punctuation, then at the widest gap between words, then at the
// last space that fits. Never inside a word.
function splitLines(words, maxChars, maxLines) {
  const text = words.map((w) => w.text).join(" ");
  if (text.length <= maxChars || maxLines < 2) return [text];
  // Prefer a break after punctuation, and near the middle. A break that leaves the second line over the
  // limit is still better than no break at all — a caption that is slightly wide is a styling problem; a
  // caption with words missing is a lie about what was said.
  let best = -1, bestScore = Infinity;
  let run = "";
  for (let i = 0; i < words.length - 1; i += 1) {
    run += (i ? " " : "") + words[i].text;
    const rest = words.slice(i + 1).map((w) => w.text).join(" ");
    const over = Math.max(0, run.length - maxChars) + Math.max(0, rest.length - maxChars * (maxLines - 1));
    const punct = /[,;:—–]$/u.test(words[i].text) || /[.!?…]$/u.test(words[i].text) ? 0 : 1;
    const balance = Math.abs(run.length - rest.length) / maxChars;
    const score = over * 2 + punct * 1.2 + balance;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  // Whatever happens, every word survives: the join of the lines is the sentence.
  if (best < 0) best = Math.max(0, Math.floor(words.length / 2) - 1);
  return [words.slice(0, best + 1).map((w) => w.text).join(" "), words.slice(best + 1).map((w) => w.text).join(" ")];
}

/**
 * Cues built from the measured audio. A cue starts when its first word starts and ends when its last word
 * ends — the only definition that cannot drift — with a small hold so the eye can finish the line, clipped
 * so it never runs into the next cue or past the film.
 */
export function subtitleCuesFromTimeline(timeline, { limits = SUBTITLE_LIMITS, filmEndMs = null, holdMs = 300 } = {}) {
  const L = { ...SUBTITLE_LIMITS, ...limits };
  // Pack words into LINES first, then group lines into cues. Doing it the other way round — chunk by total
  // characters, then split into two — cannot guarantee either line fits, because words do not divide evenly.
  // A caption is read line by line, so the line is the unit that has to obey the width.
  const cueGroups = [];
  for (const seg of timeline.segments) {
    const lines = [];
    let cur = [], len = 0;
    for (const w of seg.words) {
      const add = (cur.length ? 1 : 0) + w.text.length;
      if (len + add > L.maxCharsPerLine && cur.length) { lines.push(cur); cur = []; len = 0; }
      cur.push(w); len += (cur.length > 1 ? 1 : 0) + w.text.length;
    }
    if (cur.length) lines.push(cur);
    for (let i = 0; i < lines.length; i += L.maxLines) {
      const group = lines.slice(i, i + L.maxLines);
      const words = group.flat();
      cueGroups.push({
        segmentId: seg.segmentId, words,
        lines: group.map((ln) => ln.map((w) => w.text).join(" ")),
        audioStartMs: words[0].startMs, audioEndMs: words[words.length - 1].endMs
      });
    }
  }
  const cues = [];
  for (let i = 0; i < cueGroups.length; i += 1) {
    const s = cueGroups[i];
    const next = cueGroups[i + 1] || null;
    let start = s.audioStartMs;
    let end = s.audioEndMs + holdMs;
    // Never overlap the next line, and never outlive the film.
    if (next) end = Math.min(end, next.audioStartMs - L.gapMs);
    if (Number.isFinite(filmEndMs)) end = Math.min(end, filmEndMs);
    if (end - start < L.minCueMs) end = Math.min(start + L.minCueMs, next ? next.audioStartMs - L.gapMs : (Number.isFinite(filmEndMs) ? filmEndMs : start + L.minCueMs));
    if (end - start > L.maxCueMs) end = start + L.maxCueMs;
    if (end <= start) end = start + 1;   // degenerate only if the audio itself is degenerate
    cues.push(Object.freeze({
      index: cues.length + 1, segmentId: s.segmentId,
      // The moment this cue's OWN first word is spoken. Drift is measured against this, so a sentence split
      // across cues is judged on each cue's real anchor rather than the sentence's.
      anchorMs: s.audioStartMs,
      startMs: Math.round(start), endMs: Math.round(end),
      lines: Object.freeze(s.lines), text: s.lines.join("\n")
    }));
  }
  return Object.freeze(cues);
}

/**
 * How far each cue sits from the voice it belongs to. This is the number that says whether the subtitles
 * are aligned or merely plausible, and it is measured against the same audio the film contains.
 */
export function subtitleDrift(cues, timeline) {
  const byId = new Map(timeline.segments.map((s) => [s.segmentId, s]));
  const deltas = [];
  const perCue = [];
  for (const c of cues) {
    const s = byId.get(c.segmentId);
    if (!s) continue;
    // A cue is judged against the word it belongs to, which for a split sentence is its own anchor.
    const anchor = Number.isFinite(c.anchorMs) ? c.anchorMs : s.audioStartMs;
    const d = Math.abs(c.startMs - anchor);
    deltas.push(d);
    perCue.push({ index: c.index, segmentId: c.segmentId, startDriftMs: c.startMs - anchor, endDriftMs: c.endMs - s.audioEndMs });
  }
  if (!deltas.length) return Object.freeze({ medianMs: 0, p95Ms: 0, maxMs: 0, count: 0, perCue: Object.freeze([]) });
  const sorted = deltas.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return Object.freeze({
    medianMs: at(0.5), p95Ms: at(0.95), maxMs: sorted[sorted.length - 1], count: deltas.length,
    perCue: Object.freeze(perCue.map((x) => Object.freeze(x)))
  });
}

/** Throw when the cues are not aligned well enough to ship. Measured, not asserted. */
export function assertSubtitleAlignment(drift, targets = DRIFT_TARGETS) {
  const t = { ...DRIFT_TARGETS, ...targets };
  const problems = [];
  if (drift.medianMs > t.medianMs) problems.push(`median ${drift.medianMs}ms > ${t.medianMs}ms`);
  if (drift.p95Ms > t.p95Ms) problems.push(`p95 ${drift.p95Ms}ms > ${t.p95Ms}ms`);
  if (drift.maxMs > t.maxMs) problems.push(`max ${drift.maxMs}ms > ${t.maxMs}ms`);
  if (problems.length) throw err(TIMELINE_ERRORS.SUBTITLE_DRIFT, `the subtitles do not follow the voice closely enough: ${problems.join(", ")}`, { drift, targets: t, problems });
  return true;
}

const fmt = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor((t % 3600000) / 60000))}:${p(Math.floor((t % 60000) / 1000))},${p(t % 1000, 3)}`;
};
const fmtVtt = (ms) => fmt(ms).replace(",", ".");

export function cuesToSrt(cues) {
  return cues.map((c) => `${c.index}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.text}\n`).join("\n");
}
export function cuesToVtt(cues) {
  return `WEBVTT\n\n${cues.map((c) => `${c.index}\n${fmtVtt(c.startMs)} --> ${fmtVtt(c.endMs)}\n${c.text}\n`).join("\n")}`;
}

/**
 * Every millisecond of narration must be covered by a shot. A gap is a moment where a voice is speaking
 * over nothing, which is the audiovisual equivalent of a dropped frame.
 */
export function assertShotsCoverTimeline(timeline, shots, { toleranceMs = 40, allowSilentGaps = true } = {}) {
  const ordered = shots.slice().sort((a, b) => a.startMs - b.startMs);
  const gaps = [];
  for (const seg of timeline.segments) {
    let cursor = seg.audioStartMs;
    for (const sh of ordered) {
      if (sh.endMs <= cursor || sh.startMs >= seg.audioEndMs) continue;
      if (sh.startMs > cursor + toleranceMs) gaps.push({ fromMs: cursor, toMs: sh.startMs, segmentId: seg.segmentId });
      cursor = Math.max(cursor, sh.endMs);
      if (cursor >= seg.audioEndMs - toleranceMs) break;
    }
    if (cursor < seg.audioEndMs - toleranceMs) gaps.push({ fromMs: cursor, toMs: seg.audioEndMs, segmentId: seg.segmentId });
  }
  if (gaps.length) {
    throw err(TIMELINE_ERRORS.NOT_COVERED, `${gaps.length} moment(s) of narration have no shot`, { gaps, allowSilentGaps });
  }
  return true;
}
