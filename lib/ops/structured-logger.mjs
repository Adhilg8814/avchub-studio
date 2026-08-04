// P0 Step 5C.12 — structured operational logging (NDJSON, rotation, retention, redaction).
//
// One line per event: {ts, level, component, event, ...redactedFields}. The redactor is the safety
// boundary: secret-looking keys are masked, absolute paths are scrubbed to their basename, and
// long free-text (prompts/captions/narration) is truncated to a short prefix + sha256 tag so an
// event stays correlatable without ever storing the full text. Rotation is size-based with a
// bounded file count — the log directory can never grow unbounded.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const SECRET_KEY_RE = /(password|passwd|secret|token|cookie|credential|apikey|api_key|bearer|authorization|proxy|license)/i;
const FREETEXT_KEY_RE = /(prompt|text|caption|narration|synopsis|story|subtitle)/i;
const ABS_PATH_RE = /[A-Za-z]:[\\/][^\s"']*/g;
const LEVELS = new Set(["debug", "info", "warn", "error"]);

const sha8 = (s) => createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 8);

export function redactValue(key, value) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (SECRET_KEY_RE.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    let v = value.replace(ABS_PATH_RE, (m) => `<path:${path.basename(m.replace(/[\\/]+$/, ""))}>`);
    if (FREETEXT_KEY_RE.test(key) && v.length > 64) v = `${v.slice(0, 64)}…[len:${value.length},sha:${sha8(value)}]`;
    else if (v.length > 300) v = `${v.slice(0, 300)}…[len:${value.length}]`;
    return v;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((x) => redactValue(key, x));
  if (typeof value === "object") return redactFields(value);
  return String(value);
}

export function redactFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY_RE.test(k)) { out[k] = "[REDACTED]"; continue; }
    out[k] = redactValue(k, v);
  }
  return out;
}

export function createStructuredLogger({
  dir, component = "runtime", now = () => new Date(),
  maxFileBytes = 5_000_000, maxFiles = 10, fileName = "ops.ndjson"
} = {}) {
  if (typeof dir !== "string" || !dir) throw new TypeError("structured logger requires a directory");
  mkdirSync(dir, { recursive: true });
  const current = path.join(dir, fileName);

  function rotateIfNeeded() {
    let size = 0;
    try { size = statSync(current).size; } catch { return; }
    if (size < maxFileBytes) return;
    // Shift ops.ndjson.(n) → .(n+1); the oldest beyond maxFiles is deleted (bounded retention).
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const from = `${current}.${i}`;
      const to = `${current}.${i + 1}`;
      try {
        if (existsSync(from)) { if (i + 1 > maxFiles - 1) unlinkSync(from); else renameSync(from, to); }
      } catch { /* rotation is best-effort; never crash the runtime for it */ }
    }
    try { renameSync(current, `${current}.1`); } catch { /* */ }
  }

  function log(level, event, fields = {}) {
    const lvl = LEVELS.has(level) ? level : "info";
    if (typeof event !== "string" || !event) return;
    const line = JSON.stringify({ ts: now().toISOString(), level: lvl, component, event, ...redactFields(fields) });
    try { rotateIfNeeded(); appendFileSync(current, line + "\n", "utf8"); } catch { /* logging never crashes the runtime */ }
  }

  return Object.freeze({
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    child: (childComponent) => createStructuredLogger({ dir, component: childComponent, now, maxFileBytes, maxFiles, fileName }),
    currentFile: current,
    listFiles: () => readdirSync(dir).filter((f) => f.startsWith(fileName)).sort()
  });
}

// A no-op logger for callers that run without ops logging configured.
export function createNullLogger() {
  const noop = () => {};
  return Object.freeze({ log: noop, debug: noop, info: noop, warn: noop, error: noop, child: () => createNullLogger(), currentFile: null, listFiles: () => [] });
}
