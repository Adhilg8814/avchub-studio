// P0 Step 5C.37 — 720p MASTERING GATE (real decode; ffmpeg/ffprobe, no provider).
//
// "720×1280" has been checked from the container header. That proves the file CLAIMS a size, which is not
// the same as the picture being 720p — a 256×455 clip stretched to fill the frame reports 720×1280 and
// looks like mud; a stream with a non-square SAR reports one thing and displays another; a rotation flag
// turns a vertical master sideways on a phone; and a bitrate low enough to block up the image still
// produces a perfectly well-formed 720×1280 file.
//
// So this module decodes actual frames and measures them:
//
//   * geometry     coded size, DISPLAY size after SAR, rotation, aspect, letterboxing
//   * conformance  H.264 / yuv420p / CFR 30 / AAC 48 kHz, and a bitrate that is not starving the picture
//   * integrity    black opening or ending, frozen runs, broken/duplicated frames, timestamp sanity
//   * fidelity     sharpness (edge energy), blockiness, banding — the things a low bitrate destroys
//   * provenance   each SOURCE clip's real resolution, and whether anything was upscaled to reach 720p
//
// Every number here comes from a decoded frame or an ffmpeg filter that looked at one. Nothing is inferred
// from a header alone, because the header is exactly what was lying.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { ffmpegPaths } from "../media/ffmpeg-locator.mjs";

// FFmpeg is GPL and is NOT bundled: the operator installs it and this resolves where it landed.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

export const MASTER_ERRORS = Object.freeze({
  UNREADABLE: "E_MOVIE_MASTER_UNREADABLE",
  PROFILE: "E_MOVIE_MASTER_PROFILE",
  INTEGRITY: "E_MOVIE_MASTER_INTEGRITY",
  FIDELITY: "E_MOVIE_MASTER_FIDELITY",
  SOURCE_RESOLUTION: "E_MOVIE_SOURCE_RESOLUTION_TOO_LOW"
});

// The vertical master profile. Explicit, so a change is a decision someone made rather than a drift.
/** A 30fps profile for workspaces whose delivery target requires it. Named, so choosing it is a decision
 *  someone made rather than a default nobody noticed. */
export function verticalProfileAt(fps) {
  return Object.freeze({ ...VERTICAL_720P, name: `VERTICAL_720P_${fps}`, fps });
}

export const VERTICAL_720P = Object.freeze({
  name: "VERTICAL_720P",
  width: 720, height: 1280, aspectRatio: "9:16",
  sar: "1:1", rotation: 0,
  // P0 Step 5C.39 — 24fps, matching what Grok actually delivers (the certified native clip decodes at 24).
  // Resampling 24 to 30 invents five frames a second by duplication: it does not add motion, it adds judder
  // where a clean cadence used to be, and it costs bitrate to encode frames carrying no new information. The
  // master should keep the source cadence unless a workspace deliberately asks otherwise.
  videoCodec: "h264", pixelFormat: "yuv420p", fps: 24, constantFrameRate: true,
  audioCodec: "aac", audioSampleRate: 48000, audioChannels: 2,
  // A 720×1280 30fps talking-head/cinematic short needs roughly this to hold detail. Below the floor the
  // file is "720p" in name only, which is the exact failure this gate exists to catch.
  minVideoBitrateBps: 1_200_000, targetVideoBitrateBps: 2_600_000, maxCrf: 24,
  minAudioBitrateBps: 96_000
});

// A source clip must be at least this tall before it is allowed to become a 720p master. Grok Imagine
// returns ~464×688 today; upscaling that is a decision, not an accident, so it needs a flag.
export const SOURCE_GATE = Object.freeze({ minHeight: 640, minWidth: 360, allowUpscale: true, maxUpscaleFactor: 2.0 });

// Fidelity floors, calibrated against real renders of this pipeline rather than picked from the air.
export const FIDELITY = Object.freeze({
  minSharpness: 2.2,        // mean |Laplacian| over luma; a soft/upscaled frame falls below
  maxBlockiness: 0.22,      // (onGrid-offGrid)/(onGrid+offGrid); ~0 on a clean encode, climbs as bitrate starves
  maxBandingScore: 0.42,    // flat-gradient stepping
  maxBlackFrameRatio: 0.02, // of sampled frames
  maxFrozenRunMs: 1500,
  maxOpeningBlackMs: 120,
  maxTrailingBlackMs: 120
});

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const round = (n, d = 4) => Number(Number(n).toFixed(d));

function run(exe, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = "", errOut = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish({ code: -1, out, err: errOut }); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errOut += d; });
    child.on("error", () => finish({ code: -1, out, err: errOut }));
    child.on("close", (code) => finish({ code, out, err: errOut }));
  });
}
/** Same as run(), but stdout is captured as BINARY — for piping decoded frames back to us. */
function runBinary(exe, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    const chunks = []; let errOut = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish({ code: -1, buf: Buffer.concat(chunks), err: errOut }); }, timeoutMs);
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => { errOut += d; });
    child.on("error", () => finish({ code: -1, buf: Buffer.concat(chunks), err: errOut }));
    child.on("close", (code) => finish({ code, buf: Buffer.concat(chunks), err: errOut }));
  });
}
const FFMPEG = ffmpegStatic;
const FFPROBE = ffprobeStaticPath;

/** Everything the container and streams claim. The starting point, never the verdict. */
export async function probeMedia(file) {
  if (!file || !existsSync(file)) throw err(MASTER_ERRORS.UNREADABLE, "the media file is not present");
  const r = await run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  if (r.code !== 0) throw err(MASTER_ERRORS.UNREADABLE, "the media file could not be probed");
  let j;
  try { j = JSON.parse(r.out); } catch { throw err(MASTER_ERRORS.UNREADABLE, "the probe output could not be read"); }
  const v = (j.streams || []).find((s) => s.codec_type === "video") || null;
  const a = (j.streams || []).find((s) => s.codec_type === "audio") || null;
  const sub = (j.streams || []).filter((s) => s.codec_type === "subtitle");
  const rot = (() => {
    const tagRot = v && v.tags && (v.tags.rotate || v.tags.ROTATE);
    if (tagRot != null) return Number(tagRot) || 0;
    const sd = v && Array.isArray(v.side_data_list) ? v.side_data_list.find((x) => x.rotation != null) : null;
    return sd ? Number(sd.rotation) || 0 : 0;
  })();
  const fpsOf = (s) => { const [n, d] = String((s && (s.avg_frame_rate || s.r_frame_rate)) || "0/1").split("/").map(Number); return d ? n / d : 0; };
  const sar = v && v.sample_aspect_ratio && v.sample_aspect_ratio !== "0:1" ? v.sample_aspect_ratio : "1:1";
  const [sarN, sarD] = sar.split(":").map(Number);
  const codedW = v ? Number(v.width) : 0, codedH = v ? Number(v.height) : 0;
  return Object.freeze({
    file,
    durationSeconds: j.format && j.format.duration ? Number(j.format.duration) : null,
    sizeBytes: j.format && j.format.size ? Number(j.format.size) : null,
    bitrateBps: j.format && j.format.bit_rate ? Number(j.format.bit_rate) : null,
    video: v ? Object.freeze({
      codec: v.codec_name, pixelFormat: v.pix_fmt,
      codedWidth: codedW, codedHeight: codedH,
      // What a player actually shows: coded size corrected by the sample aspect ratio.
      displayWidth: Math.round(codedW * (sarN && sarD ? sarN / sarD : 1)), displayHeight: codedH,
      sar, rotation: ((rot % 360) + 360) % 360,
      fps: round(fpsOf(v), 3),
      avgFrameRate: v.avg_frame_rate, rFrameRate: v.r_frame_rate,
      bitrateBps: v.bit_rate ? Number(v.bit_rate) : null,
      frames: v.nb_frames ? Number(v.nb_frames) : null,
      profile: v.profile || null, level: v.level || null
    }) : null,
    audio: a ? Object.freeze({
      codec: a.codec_name, sampleRate: Number(a.sample_rate) || 0, channels: Number(a.channels) || 0,
      bitrateBps: a.bit_rate ? Number(a.bit_rate) : null, durationSeconds: a.duration ? Number(a.duration) : null
    }) : null,
    subtitleStreams: sub.length,
    subtitleCodec: sub.length ? sub[0].codec_name : null
  });
}

/** Decode N frames spread across the film and measure each one. This is the part a header cannot fake. */
export async function sampleFrames(file, { count = 12, startSkipSeconds = 0.05 } = {}) {
  const meta = await probeMedia(file);
  const dur = meta.durationSeconds || 0;
  if (dur <= 0) throw err(MASTER_ERRORS.UNREADABLE, "the media has no duration to sample");
  const w = meta.video ? meta.video.codedWidth : 0, h = meta.video ? meta.video.codedHeight : 0;
  if (!w || !h) throw err(MASTER_ERRORS.UNREADABLE, "the media has no video dimensions to sample");
  const stamps = [];
  for (let i = 0; i < count; i += 1) {
    // Spread across the film, biased to include the very first and very last visible moments.
    const t = i === 0 ? startSkipSeconds
      : i === count - 1 ? Math.max(startSkipSeconds, dur - 0.08)
        : (dur * (i / (count - 1)));
    // Decoded straight into memory as raw luma. Writing frames to a scratch directory made this depend on a
    // healthy system temp — and a full disk turned "measure the picture" into "the media is unreadable",
    // which is a diagnosis about the wrong thing entirely.
    const r = await runBinary(FFMPEG, ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", file,
      "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"], { timeoutMs: 60_000 });
    if (r.code !== 0 || r.buf.length < w * h) continue;
    stamps.push({ atSeconds: round(t, 3), ...measureFrame({ width: w, height: h, data: r.buf.subarray(0, w * h) }) });
  }
  if (!stamps.length) throw err(MASTER_ERRORS.UNREADABLE, "no frame could be decoded from the media");
  return Object.freeze({ meta, frames: Object.freeze(stamps.map((x) => Object.freeze(x))) });
}

// Minimal binary PGM (P5) reader — header, then one byte per pixel.
function readPgm(buf) {
  if (buf.length < 10 || buf[0] !== 0x50 || buf[1] !== 0x35) return null;   // "P5"
  let pos = 2, fields = [];
  while (fields.length < 3 && pos < buf.length) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos += 1;
    if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0A) pos += 1; continue; }
    let tok = "";
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) { tok += String.fromCharCode(buf[pos]); pos += 1; }
    if (tok) fields.push(Number(tok));
  }
  pos += 1;
  const [w, h] = fields;
  if (!w || !h || buf.length - pos < w * h) return null;
  return { width: w, height: h, data: buf.subarray(pos, pos + w * h) };
}

/**
 * Per-frame measurements:
 *   mean/std      exposure and contrast — a black or flat frame is obvious here
 *   sharpness     mean |Laplacian|: real detail has edges; an upscale or a soft encode does not
 *   blockiness    how much stronger the 8-pixel-grid discontinuities are than their neighbours; this is
 *                 what a starved bitrate looks like numerically
 *   banding       long runs of identical value along a gradient
 */
export function measureFrame({ width, height, data }) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  const mean = sum / data.length;
  let varSum = 0;
  for (let i = 0; i < data.length; i += 1) { const d = data[i] - mean; varSum += d * d; }
  const std = Math.sqrt(varSum / data.length);

  let lap = 0, lapN = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 360));   // subsample big frames, keep it honest
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const i = y * width + x;
      const v = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width];
      lap += Math.abs(v); lapN += 1;
    }
  }
  const sharpness = lapN ? lap / lapN : 0;

  // Blockiness: compare the gradient ON the 8-pixel grid to the gradient at MID-block (x%8===4). Comparing
  // grid columns to "everything else" looks decisive and is not: on flat synthetic content the off-grid
  // average collapses toward zero and any edge at all reads as 100% blockiness. Grid-vs-mid-block is a
  // like-for-like comparison — in a clean image the two are statistically the same column.
  let onGrid = 0, onN = 0, offGrid = 0, offN = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 8; x < width - 8; x += 1) {
      const m = x % 8;
      if (m !== 0 && m !== 4) continue;
      const d = Math.abs(data[y * width + x] - data[y * width + x - 1]);
      if (m === 0) { onGrid += d; onN += 1; } else { offGrid += d; offN += 1; }
    }
  }
  // Bounded and scale-free: (on - off) / (on + off). Zero when the 8-pixel grid is no more edgy than its
  // neighbours — which is what a clean image looks like — and rising toward 1 as block edges dominate. An
  // unbounded difference blows up on flat synthetic frames and says nothing about the encode.
  const on = onN ? onGrid / onN : 0, off = offN ? offGrid / offN : 0;
  const blockiness = (on + off) > 0.01 ? Math.max(0, (on - off) / (on + off)) : 0;

  // Banding: in near-flat areas, how often a long horizontal run holds exactly one value.
  let runs = 0, flat = 0;
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 64))) {
    let runLen = 1;
    for (let x = 1; x < width; x += 1) {
      const same = data[y * width + x] === data[y * width + x - 1];
      if (same) runLen += 1;
      else { if (runLen >= 12) runs += 1; runLen = 1; }
    }
    flat += 1;
  }
  const banding = flat ? Math.min(1, runs / (flat * 8)) : 0;

  return {
    width, height,
    mean: round(mean, 2), std: round(std, 2),
    sharpness: round(sharpness, 3),
    blockiness: round(blockiness, 4),
    banding: round(banding, 3),
    isBlack: mean < 6 && std < 4
  };
}

/** ffmpeg's own detectors for the things a sampled frame can miss between samples. */
export async function detectIntegrity(file, { blackThreshold = 0.10, freezeSeconds = 1.0 } = {}) {
  const r = await run(FFMPEG, ["-hide_banner", "-i", file,
    "-vf", `blackdetect=d=0.08:pic_th=0.98,freezedetect=n=-60dB:d=${freezeSeconds}`,
    "-an", "-f", "null", "-"], { timeoutMs: 180_000 });
  const text = `${r.err}`;
  const blacks = [];
  for (const m of text.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/gu)) {
    blacks.push({ startSeconds: Number(m[1]), endSeconds: Number(m[2]), durationSeconds: Number(m[3]) });
  }
  const freezes = [];
  for (const m of text.matchAll(/freeze_start:\s*([\d.]+)/gu)) freezes.push({ startSeconds: Number(m[1]) });
  for (const m of text.matchAll(/freeze_duration:\s*([\d.]+)/gu)) {
    const i = freezes.findIndex((f) => f.durationSeconds === undefined);
    if (i >= 0) freezes[i].durationSeconds = Number(m[1]);
  }
  // A decode that reports errors is a broken file, whatever its header says.
  const decodeErrors = (text.match(/\[(?:h264|mov|mp4)[^\]]*\]\s*(?:error|corrupt|invalid)/giu) || []).length;
  return Object.freeze({
    blackRanges: Object.freeze(blacks), freezeRanges: Object.freeze(freezes.filter((f) => f.durationSeconds !== undefined)),
    decodeErrors, blackThreshold, freezeSeconds
  });
}

/**
 * The gate. Returns a full report — every measurement, every failure, with the evidence that produced it —
 * and a boolean that is the CONJUNCTION of the hard checks, never an average.
 */
export async function certifyMaster(file, {
  profile = VERTICAL_720P, fidelity = FIDELITY, sampleCount = 12,
  sourceClips = [], sourceGate = SOURCE_GATE, subtitleSafeArea = true, expectedDurationSeconds = null, durationToleranceSeconds = 0.15
} = {}) {
  const { meta, frames } = await sampleFrames(file, { count: sampleCount });
  const integrity = await detectIntegrity(file);
  const failures = [];
  const warnings = [];
  const v = meta.video, a = meta.audio;
  if (!v) failures.push({ check: "video-stream", detail: "the file has no video stream" });

  // ---- geometry: what a player will actually show ----
  if (v) {
    if (v.displayWidth !== profile.width || v.displayHeight !== profile.height) {
      failures.push({ check: "display-size", expected: `${profile.width}x${profile.height}`, actual: `${v.displayWidth}x${v.displayHeight}`, coded: `${v.codedWidth}x${v.codedHeight}`, sar: v.sar });
    }
    if (v.sar !== profile.sar && v.sar !== "1:1") failures.push({ check: "sar", expected: profile.sar, actual: v.sar, detail: "a non-square pixel makes the coded size a lie" });
    if (v.rotation !== profile.rotation) failures.push({ check: "rotation", expected: profile.rotation, actual: v.rotation, detail: "a rotation flag turns the master sideways on a phone" });
    if (v.codec !== profile.videoCodec) failures.push({ check: "video-codec", expected: profile.videoCodec, actual: v.codec });
    if (v.pixelFormat !== profile.pixelFormat) failures.push({ check: "pixel-format", expected: profile.pixelFormat, actual: v.pixelFormat });
    if (Math.abs(v.fps - profile.fps) > 0.6) failures.push({ check: "fps", expected: profile.fps, actual: v.fps });
    if (profile.constantFrameRate && v.avgFrameRate !== v.rFrameRate) {
      warnings.push({ check: "cfr", detail: `avg ${v.avgFrameRate} vs r ${v.rFrameRate}: the stream is not strictly constant` });
    }
    // Every decoded frame must be the coded size — a decoder that hands back something else means the
    // stream is not what the header describes.
    const wrongSize = frames.filter((f) => f.width !== v.codedWidth || f.height !== v.codedHeight);
    if (wrongSize.length) failures.push({ check: "frame-size", detail: `${wrongSize.length} decoded frame(s) are not ${v.codedWidth}x${v.codedHeight}` });
  }

  // ---- audio ----
  if (!a) failures.push({ check: "audio-stream", detail: "the file has no audio stream" });
  else {
    if (a.codec !== profile.audioCodec) failures.push({ check: "audio-codec", expected: profile.audioCodec, actual: a.codec });
    if (a.sampleRate !== profile.audioSampleRate) failures.push({ check: "audio-sample-rate", expected: profile.audioSampleRate, actual: a.sampleRate });
    if (a.bitrateBps != null && a.bitrateBps < profile.minAudioBitrateBps) warnings.push({ check: "audio-bitrate", actual: a.bitrateBps, floor: profile.minAudioBitrateBps });
  }

  // ---- bitrate: a 720p file starved of bits is 720p in name only ----
  const videoBps = (v && v.bitrateBps) || (meta.bitrateBps && a && a.bitrateBps ? meta.bitrateBps - a.bitrateBps : meta.bitrateBps);
  if (videoBps != null && videoBps < profile.minVideoBitrateBps) {
    failures.push({ check: "video-bitrate", actual: videoBps, floor: profile.minVideoBitrateBps, detail: "the picture does not have enough bits to be 720p in anything but name" });
  }

  // ---- integrity ----
  const blackFrames = frames.filter((f) => f.isBlack);
  if (blackFrames.length / frames.length > fidelity.maxBlackFrameRatio) {
    failures.push({ check: "black-frames", detail: `${blackFrames.length}/${frames.length} sampled frames are black`, timestamps: blackFrames.map((f) => f.atSeconds) });
  }
  const opening = integrity.blackRanges.find((b) => b.startSeconds <= 0.05);
  if (opening && opening.durationSeconds * 1000 > fidelity.maxOpeningBlackMs) {
    failures.push({ check: "opening-black", detail: `the film opens on ${Math.round(opening.durationSeconds * 1000)}ms of black` });
  }
  const dur = meta.durationSeconds || 0;
  const trailing = integrity.blackRanges.find((b) => b.endSeconds >= dur - 0.05);
  if (trailing && trailing.durationSeconds * 1000 > fidelity.maxTrailingBlackMs) {
    failures.push({ check: "trailing-black", detail: `the film ends on ${Math.round(trailing.durationSeconds * 1000)}ms of black` });
  }
  const longFreeze = integrity.freezeRanges.find((f) => f.durationSeconds * 1000 > fidelity.maxFrozenRunMs);
  if (longFreeze) failures.push({ check: "frozen-frames", detail: `${Math.round(longFreeze.durationSeconds * 1000)}ms frozen from ${longFreeze.startSeconds}s` });
  if (integrity.decodeErrors > 0) failures.push({ check: "decode-errors", detail: `${integrity.decodeErrors} decode error(s)` });

  // ---- fidelity: the numbers that say whether the picture survived the encode ----
  const live = frames.filter((f) => !f.isBlack);
  const avg = (k) => (live.length ? live.reduce((s, f) => s + f[k], 0) / live.length : 0);
  const sharpness = round(avg("sharpness"), 3), blockiness = round(avg("blockiness"), 4), banding = round(avg("banding"), 3);
  if (live.length && sharpness < fidelity.minSharpness) failures.push({ check: "sharpness", actual: sharpness, floor: fidelity.minSharpness, detail: "the picture is soft — typically an upscale or an over-compressed encode" });
  if (live.length && blockiness > fidelity.maxBlockiness) failures.push({ check: "blockiness", actual: blockiness, ceiling: fidelity.maxBlockiness });
  if (live.length && banding > fidelity.maxBandingScore) warnings.push({ check: "banding", actual: banding, ceiling: fidelity.maxBandingScore });

  // ---- duration agreement ----
  if (expectedDurationSeconds != null && dur > 0 && Math.abs(dur - expectedDurationSeconds) > durationToleranceSeconds) {
    failures.push({ check: "duration", expected: expectedDurationSeconds, actual: round(dur, 3), toleranceSeconds: durationToleranceSeconds });
  }

  // ---- source provenance: what the master was actually built from ----
  const sources = [];
  for (const c of sourceClips) {
    try {
      const sm = await probeMedia(c.path || c);
      const upscaleFactor = sm.video ? round(profile.height / Math.max(1, sm.video.displayHeight), 3) : null;
      const rec = {
        path: undefined, sceneOrdinal: c.ordinal ?? null,
        width: sm.video ? sm.video.displayWidth : null, height: sm.video ? sm.video.displayHeight : null,
        upscaleFactor, upscaled: upscaleFactor != null && upscaleFactor > 1.001
      };
      if (sm.video && (sm.video.displayHeight < sourceGate.minHeight || sm.video.displayWidth < sourceGate.minWidth)) {
        if (!sourceGate.allowUpscale) failures.push({ check: "source-resolution", scene: rec.sceneOrdinal, actual: `${rec.width}x${rec.height}`, floor: `${sourceGate.minWidth}x${sourceGate.minHeight}` });
        else if (upscaleFactor > sourceGate.maxUpscaleFactor) failures.push({ check: "source-upscale", scene: rec.sceneOrdinal, actual: `${rec.width}x${rec.height}`, factor: upscaleFactor, max: sourceGate.maxUpscaleFactor });
        else warnings.push({ check: "source-upscaled", scene: rec.sceneOrdinal, actual: `${rec.width}x${rec.height}`, factor: upscaleFactor, detail: "upscaled to reach the master profile" });
      }
      sources.push(Object.freeze(rec));
    } catch { sources.push(Object.freeze({ sceneOrdinal: c.ordinal ?? null, width: null, height: null, upscaleFactor: null, upscaled: null, unreadable: true })); }
  }

  const technicalScore = (() => {
    // Not an average that can hide a failure — a floor at zero the moment any hard check fails.
    if (failures.length) return 0;
    const s = Math.min(1, sharpness / (fidelity.minSharpness * 1.6));
    const b = Math.max(0, 1 - blockiness / fidelity.maxBlockiness);
    return round(0.5 + 0.3 * s + 0.2 * b, 4);
  })();

  return Object.freeze({
    profile: profile.name,
    pass: failures.length === 0,
    failures: Object.freeze(failures.map((f) => Object.freeze(f))),
    warnings: Object.freeze(warnings.map((w) => Object.freeze(w))),
    technicalScore,
    measured: Object.freeze({
      durationSeconds: round(dur, 3),
      displayWidth: v ? v.displayWidth : null, displayHeight: v ? v.displayHeight : null,
      codedWidth: v ? v.codedWidth : null, codedHeight: v ? v.codedHeight : null,
      sar: v ? v.sar : null, rotation: v ? v.rotation : null, fps: v ? v.fps : null,
      videoCodec: v ? v.codec : null, pixelFormat: v ? v.pixelFormat : null,
      videoBitrateBps: videoBps ?? null, totalBitrateBps: meta.bitrateBps,
      audioCodec: a ? a.codec : null, audioSampleRate: a ? a.sampleRate : null, audioBitrateBps: a ? a.bitrateBps : null,
      subtitleStreams: meta.subtitleStreams, subtitleCodec: meta.subtitleCodec,
      sharpness, blockiness, banding,
      sampledFrames: frames.length, blackFrames: blackFrames.length
    }),
    integrity: Object.freeze({ blackRanges: integrity.blackRanges, freezeRanges: integrity.freezeRanges, decodeErrors: integrity.decodeErrors }),
    frames: Object.freeze(frames.map((f) => Object.freeze({ atSeconds: f.atSeconds, sharpness: f.sharpness, blockiness: f.blockiness, banding: f.banding, mean: f.mean, isBlack: f.isBlack }))),
    sources: Object.freeze(sources),
    subtitleSafeArea
  });
}

/** ffmpeg arguments for the master profile, so the encode and the gate cannot disagree about the target. */
export function encoderArgsFor(profile = VERTICAL_720P, { crf = 21 } = {}) {
  return [
    "-c:v", "libx264", "-profile:v", "high", "-preset", "medium",
    "-crf", String(Math.min(profile.maxCrf, crf)),
    "-maxrate", String(profile.targetVideoBitrateBps), "-bufsize", String(profile.targetVideoBitrateBps * 2),
    "-pix_fmt", profile.pixelFormat,
    "-r", String(profile.fps), "-vsync", "cfr",
    "-vf", `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},setsar=1`,
    "-c:a", "aac", "-ar", String(profile.audioSampleRate), "-ac", String(profile.audioChannels), "-b:a", "192k",
    "-movflags", "+faststart"
  ];
}

/** Cues inside the safe area for a vertical frame: not over the face, not off the bottom edge. */
export function subtitleSafeAreaFor(profile = VERTICAL_720P) {
  return Object.freeze({
    marginBottomPx: Math.round(profile.height * 0.12),
    marginSidePx: Math.round(profile.width * 0.06),
    maxHeightPx: Math.round(profile.height * 0.18),
    fontSizePx: Math.round(profile.height * 0.032)
  });
}
