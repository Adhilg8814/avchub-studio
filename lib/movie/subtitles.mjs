// P0 Step 5C.11 — pure subtitle helpers (no ffmpeg import, safe for the control-plane facade).
//
// buildSrt moved here from movie-assembler.mjs (which re-exports it unchanged) so the facade can
// build/edit subtitle text without touching media-binary modules. parseSrtCues validates edited
// SRT text structurally (indexes/timestamps) without trusting its content anywhere else.

export function fmtSrtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

// Build an SRT from ordered scenes with { durationSeconds, narration }. One cue per scene.
export function buildSrt(scenes) {
  let t = 0, out = "", n = 0;
  for (const sc of scenes) {
    const dur = Number.isFinite(sc.durationSeconds) && sc.durationSeconds > 0 ? sc.durationSeconds : 6;
    const text = String(sc.narration || sc.heading || "").replace(/\r/g, "").trim();
    if (text) { n += 1; out += `${n}\n${fmtSrtTime(t)} --> ${fmtSrtTime(t + dur)}\n${text.slice(0, 300)}\n\n`; }
    t += dur;
  }
  return out;
}

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;
function parseTime(s) {
  const m = TIME_RE.exec(String(s || "").trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

// Structural SRT validation for user-edited subtitles. Returns the parsed cues
// [{ start, end, text }] or throws E_SRT_INVALID. Caps size + cue count defensively.
export function parseSrtCues(srtText, { maxCues = 200, maxChars = 20000 } = {}) {
  const raw = String(srtText ?? "").replace(/\r/g, "");
  if (raw.trim().length === 0) throw Object.assign(new Error("subtitles are empty"), { code: "E_SRT_INVALID" });
  if (raw.length > maxChars) throw Object.assign(new Error("subtitles too large"), { code: "E_SRT_INVALID" });
  const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 0 || blocks.length > maxCues) throw Object.assign(new Error("invalid subtitle cue count"), { code: "E_SRT_INVALID" });
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 2) throw Object.assign(new Error("invalid subtitle cue"), { code: "E_SRT_INVALID" });
    const timeLine = lines[0].includes("-->") ? lines[0] : lines[1];
    const textStart = lines[0].includes("-->") ? 1 : 2;
    const [a, b] = timeLine.split("-->");
    const start = parseTime(a), end = parseTime(b);
    if (start === null || end === null || end <= start) throw Object.assign(new Error("invalid subtitle timing"), { code: "E_SRT_INVALID" });
    cues.push({ start, end, text: lines.slice(textStart).join("\n").slice(0, 600) });
  }
  return cues;
}
