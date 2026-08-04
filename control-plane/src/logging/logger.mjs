// P0 Step 5C.1 — structured JSON logger.
//
// Production-shaped structured logging. Every entry is a single JSON line with safe fields.
// All fields pass through the redactor (logging/redact.mjs) so a secret can never be logged
// even if a caller accidentally attaches one. A logger failure NEVER crashes the caller.
//
// Provider-neutral: no brand terminology in the core logger.

import { sanitize } from "./redact.mjs";

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

// Fields that carry safe correlation identity (kept verbatim if scalar, else sanitized).
const KNOWN_FIELDS = Object.freeze([
  "event", "requestId", "correlationId", "workspaceId", "workerId", "jobId",
  "generationAttemptId", "durationMs", "outcome", "component", "reasonCode",
  "method", "path", "status"
]);

export function createLogger(options = {}) {
  const {
    level = "info",
    service = "control-plane",
    instanceId = null,
    // Injectable sink + clock make the logger fully testable and failure-isolated.
    sink = defaultSink,
    now = () => new Date().toISOString(),
    base = {}
  } = options;

  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, event, fields) {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    let line;
    try {
      const record = { ts: now(), level: lvl, service };
      if (instanceId) record.instanceId = instanceId;
      // Merge base context (child loggers) then per-call fields, all sanitized.
      const merged = sanitize({ ...base, ...(fields && typeof fields === "object" ? fields : {}), event });
      // Promote known correlation fields to the top level for easy querying.
      for (const f of KNOWN_FIELDS) if (merged[f] !== undefined) record[f] = merged[f];
      record.fields = merged;
      line = JSON.stringify(record);
    } catch {
      // Serialization itself failed — emit a minimal, guaranteed-safe fallback.
      try { line = JSON.stringify({ ts: now(), level: lvl, service, event: "log_serialize_failed" }); }
      catch { line = `{"level":"${lvl}","event":"log_serialize_failed"}`; }
    }
    // The sink must never throw into the caller.
    try { sink(line, lvl); } catch { /* logging must not crash the service */ }
  }

  const api = {
    level,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    // child(): a logger with additional persistent base fields (e.g. requestId).
    child: (childBase = {}) => createLogger({ ...options, base: { ...base, ...sanitize(childBase) } })
  };
  return api;
}

function defaultSink(line, lvl) {
  // stderr for warn/error, stdout otherwise — standard 12-factor logging to streams.
  const stream = lvl === "warn" || lvl === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export { LEVELS };
