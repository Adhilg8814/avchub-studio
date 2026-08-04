// P0 Step 5C.45 — what is actually in the audio track of a Grok clip.
//
// Every clip this system has ever downloaded carries an AAC stereo stream, and the pipeline has been
// synthesising ElevenLabs narration over the top of it without once listening. That stream might be silence,
// it might be room tone, it might be a voice reading the script. Those lead to three different bills.
//
// This module MEASURES. It decodes the audio and reports numbers; it does not decide what they mean, and it
// never reports a speech probability it cannot defend — a classifier that guesses "probably speech" is worse
// than one that says UNKNOWN, because the first one gets believed.
//
// Every measurement comes from ffmpeg filters run over the real samples:
//   silencedetect  — how much of the track is below an audible floor
//   ebur128        — integrated loudness and true peak, the broadcast measures
//   astats         — RMS, peak, dynamic range, zero-crossing rate, per channel
//   band RMS       — energy inside the speech band vs the whole, from two filtered passes
//
// The band ratio is the only feature here that points at speech, and it is reported as what it is: a ratio.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { ffmpegPaths } from "../media/ffmpeg-locator.mjs";

// FFmpeg is GPL and is NOT bundled: the operator installs it and this resolves where it landed.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

const FFMPEG = ffmpegStatic;
const FFPROBE = ffprobeStaticPath;

export const AUDIO_PROBE_ERRORS = Object.freeze({
  UNREADABLE: "E_SOURCE_AUDIO_UNREADABLE",
  NO_TOOLS: "E_SOURCE_AUDIO_TOOLS_UNAVAILABLE"
});

function err(code, message, detail = {}) { return Object.assign(new Error(message), { code, detail }); }
const round = (n, d = 3) => (Number.isFinite(n) ? Number(Number(n).toFixed(d)) : null);

function run(bin, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = "", errOut = "";
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* already gone */ } }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { errOut += d; });
    p.on("error", () => { clearTimeout(t); resolve({ code: -1, out, err: errOut }); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err: errOut }); });
  });
}

/** The audio stream as the container declares it. Facts about the file, not about the sound. */
export async function probeAudioStream(file) {
  if (!FFPROBE) throw err(AUDIO_PROBE_ERRORS.NO_TOOLS, "ffprobe is unavailable");
  if (!file || !existsSync(file)) throw err(AUDIO_PROBE_ERRORS.UNREADABLE, "the media file is not present");
  const r = await run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  if (r.code !== 0) throw err(AUDIO_PROBE_ERRORS.UNREADABLE, "the media file could not be probed");
  let j;
  try { j = JSON.parse(r.out); } catch { throw err(AUDIO_PROBE_ERRORS.UNREADABLE, "the probe output could not be read"); }
  const a = (j.streams || []).find((s) => s.codec_type === "audio") || null;
  const v = (j.streams || []).find((s) => s.codec_type === "video") || null;
  return Object.freeze({
    hasAudio: Boolean(a),
    audioCodec: a ? a.codec_name || null : null,
    sampleRate: a && a.sample_rate ? Number(a.sample_rate) : null,
    channels: a && a.channels ? Number(a.channels) : null,
    channelLayout: a ? a.channel_layout || null : null,
    audioBitrateBps: a && a.bit_rate ? Number(a.bit_rate) : null,
    audioDurationSeconds: a && a.duration ? round(Number(a.duration)) : null,
    videoDurationSeconds: v && v.duration ? round(Number(v.duration)) : null,
    containerDurationSeconds: j.format && j.format.duration ? round(Number(j.format.duration)) : null
  });
}

const num = (re, text) => { const m = re.exec(text); return m ? Number(m[1]) : null; };

/**
 * Decode the audio and measure it.
 *
 * `silenceThresholdDb` is the floor below which a stretch counts as nothing. -50 dB rather than -60: a track
 * of pure digital silence sits at -inf, and encoder noise from a "silent" AAC track sits well under -50, so
 * this separates "the encoder wrote something" from "there is a sound here".
 */
export async function measureAudio(file, { silenceThresholdDb = -50, minSilenceSeconds = 0.3, timeoutMs = 180_000 } = {}) {
  if (!FFMPEG) throw err(AUDIO_PROBE_ERRORS.NO_TOOLS, "ffmpeg is unavailable");
  const stream = await probeAudioStream(file);
  if (!stream.hasAudio) {
    return Object.freeze({ ...stream, measured: true, decoded: false, reason: "the file carries no audio stream" });
  }

  // One pass: silence windows + loudness + statistics. All three filters read the same decoded samples.
  const r = await run(FFMPEG, [
    "-v", "info", "-nostats", "-i", file,
    "-map", "0:a:0",
    "-af", `silencedetect=noise=${silenceThresholdDb}dB:d=${minSilenceSeconds},ebur128=peak=true,astats=metadata=1:reset=0`,
    "-f", "null", "-"
  ], { timeoutMs });
  const log = r.err || "";

  // silencedetect emits paired start/end lines; a track that is silent throughout emits a start and no end.
  const silences = [];
  const startRe = /silence_start:\s*(-?[\d.]+)/gu;
  const endRe = /silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/gu;
  let m;
  while ((m = startRe.exec(log)) !== null) silences.push({ start: Number(m[1]), end: null, duration: null });
  let i = 0;
  while ((m = endRe.exec(log)) !== null) {
    if (silences[i]) { silences[i].end = Number(m[1]); silences[i].duration = Number(m[2]); }
    i += 1;
  }
  const total = stream.audioDurationSeconds || stream.containerDurationSeconds || 0;
  let silentSeconds = silences.reduce((acc, s) => acc + (Number.isFinite(s.duration) ? s.duration : 0), 0);
  // An unterminated window runs to the end of the track.
  const open = silences.find((s) => s.end === null);
  if (open && total > 0 && Number.isFinite(open.start)) silentSeconds += Math.max(0, total - open.start);

  const integratedLufs = num(/I:\s*(-?[\d.]+)\s*LUFS/u, log.split("Summary:").pop() || log);
  const loudnessRange = num(/LRA:\s*(-?[\d.]+)\s*LU/u, log.split("Summary:").pop() || log);
  const truePeakDbtp = num(/Peak:\s*(-?[\d.]+)\s*dBFS/u, log.split("True peak:").pop() || log);

  const rmsDb = num(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.inf]+)/u, log);
  const peakDb = num(/Overall[\s\S]*?Peak level dB:\s*(-?[\d.inf]+)/u, log);
  const flatness = num(/Overall[\s\S]*?Flat factor:\s*([\d.]+)/u, log);
  const zeroCrossingsRate = num(/Overall[\s\S]*?Zero crossings rate:\s*([\d.]+)/u, log);
  const dynamicRange = num(/Overall[\s\S]*?Dynamic range:\s*([\d.]+)/u, log);

  // Speech-band energy. Two extra passes, each measuring RMS after a filter, so the ratio comes from real
  // decoded samples rather than from a spectrum we guessed at.
  const bandRms = async (filter) => {
    const rr = await run(FFMPEG, ["-v", "info", "-nostats", "-i", file, "-map", "0:a:0", "-af", `${filter},astats=metadata=1:reset=0`, "-f", "null", "-"], { timeoutMs });
    return num(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.inf]+)/u, rr.err || "");
  };
  const speechBandRmsDb = await bandRms("highpass=f=300,lowpass=f=3400");
  const lowBandRmsDb = await bandRms("lowpass=f=300");

  const dbToLin = (db) => (Number.isFinite(db) ? Math.pow(10, db / 20) : null);
  const full = dbToLin(rmsDb);
  const speech = dbToLin(speechBandRmsDb);
  const low = dbToLin(lowBandRmsDb);
  const speechBandRatio = full && speech !== null && full > 0 ? round(speech / full, 4) : null;
  const lowBandRatio = full && low !== null && full > 0 ? round(low / full, 4) : null;

  // 5C.48 — WHERE the silence is, not just how much of it there is. A recording missing its first word and a
  // recording with a pause in the middle have the same silent total and are completely different faults, and
  // the transcript gate has to be able to tell them apart to say "the opening line is not in the file".
  const closed = silences.filter((s) => Number.isFinite(s.duration));
  const leading = silences.find((s) => Number.isFinite(s.start) && s.start <= 0.05) || null;
  const trailingWindow = open || (total > 0 ? closed.find((s) => Number.isFinite(s.end) && s.end >= total - 0.05) : null) || null;
  const internal = closed.filter((s) => s !== leading && s !== trailingWindow);
  const trailingSeconds = trailingWindow
    ? (Number.isFinite(trailingWindow.duration) ? trailingWindow.duration : Math.max(0, total - trailingWindow.start))
    : 0;

  return Object.freeze({
    ...stream,
    measured: true,
    decoded: true,
    silentSeconds: round(silentSeconds),
    silenceRatio: total > 0 ? round(Math.min(1, silentSeconds / total), 4) : null,
    silenceWindows: silences.length,
    leadingSilenceMs: leading ? Math.round((Number.isFinite(leading.duration) ? leading.duration : Math.max(0, total - leading.start)) * 1000) : 0,
    trailingSilenceMs: Math.round(trailingSeconds * 1000),
    maxInternalSilenceMs: internal.length ? Math.round(Math.max(...internal.map((s) => s.duration)) * 1000) : 0,
    integratedLufs: round(integratedLufs, 2),
    loudnessRange: round(loudnessRange, 2),
    truePeakDbtp: round(truePeakDbtp, 2),
    rmsDb: round(rmsDb, 2),
    peakDb: round(peakDb, 2),
    flatFactor: round(flatness, 4),
    zeroCrossingsRate: round(zeroCrossingsRate, 6),
    dynamicRange: round(dynamicRange, 3),
    // The one feature that points at speech, reported as a ratio and never as a probability.
    speechBandRmsDb: round(speechBandRmsDb, 2),
    speechBandRatio,
    lowBandRatio,
    // Drift between the two streams: a soundtrack that stops early is a different fault from a silent one.
    audioVideoDriftSeconds: Number.isFinite(stream.audioDurationSeconds) && Number.isFinite(stream.videoDurationSeconds)
      ? round(stream.audioDurationSeconds - stream.videoDurationSeconds) : null
  });
}
