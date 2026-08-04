// P0 Step 5C.4 — raw WebSocket frame safety (runs BEFORE Step 5C.3 durable processing).
//
// Accepts ONE Protocol-v1 JSON envelope per text frame. Enforces every limit before/around JSON
// parsing so a hostile frame cannot exhaust memory or pollute prototypes. No eval / Function /
// unsafe deserialization. Raw payloads are never logged here. Returns { ok, envelope } or
// { ok:false, code } with a SAFE machine code (never a parser stack trace).

import { validateEnvelope } from "../../../lib/protocol/envelope.mjs";
import { isWorkerToCloudType } from "../../../lib/protocol/message-types.mjs";

const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

// Recursively enforce structural bounds + reject prototype-pollution keys. Throws a {code} on any
// violation. Depth/keys/items limits keep parsing of an already-parsed value bounded.
function assertBounds(value, limits, depth) {
  if (depth > limits.maxJsonDepth) { const e = new Error("depth"); e.code = "E_FRAME_DEPTH"; throw e; }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) { const e = new Error("items"); e.code = "E_FRAME_ARRAY_ITEMS"; throw e; }
    for (const v of value) assertBounds(v, limits, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > limits.maxObjectKeys) { const e = new Error("keys"); e.code = "E_FRAME_OBJECT_KEYS"; throw e; }
    for (const k of keys) {
      if (POLLUTION_KEYS.has(k)) { const e = new Error("pollution"); e.code = "E_FRAME_POLLUTION"; throw e; }
      assertBounds(value[k], limits, depth + 1);
    }
  }
}

// validateInboundFrame(data, isBinary, options): options = { maxFrameBytes, maxJsonDepth,
// maxArrayItems, maxObjectKeys, allowedProtocolVersions, now, skewMs, checkSkew }.
export function validateInboundFrame(data, isBinary, options = {}) {
  const {
    maxFrameBytes = 262144, maxJsonDepth = 24, maxArrayItems = 4096, maxObjectKeys = 256
  } = options;

  if (isBinary === true) return { ok: false, code: "E_FRAME_BINARY" };
  // `ws` delivers a Buffer for text frames; normalise to bytes.
  const buf = Buffer.isBuffer(data) ? data : (typeof data === "string" ? Buffer.from(data, "utf8") : null);
  if (!buf) return { ok: false, code: "E_FRAME_INVALID" };
  if (buf.length === 0) return { ok: false, code: "E_FRAME_EMPTY" };
  if (buf.length > maxFrameBytes) return { ok: false, code: "E_FRAME_TOO_LARGE" };

  let text;
  try { text = utf8.decode(buf); } catch { return { ok: false, code: "E_FRAME_INVALID_UTF8" }; }
  if (text.trim() === "") return { ok: false, code: "E_FRAME_EMPTY" };

  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, code: "E_FRAME_INVALID_JSON" }; }

  // Root must be a plain object (arrays / primitives rejected).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "E_FRAME_ROOT_NOT_OBJECT" };
  const proto = Object.getPrototypeOf(parsed);
  if (proto !== Object.prototype && proto !== null) return { ok: false, code: "E_FRAME_ROOT_NOT_OBJECT" };

  try { assertBounds(parsed, { maxJsonDepth, maxArrayItems, maxObjectKeys }, 0); }
  catch (e) { return { ok: false, code: e.code || "E_FRAME_STRUCTURE" }; }

  // Protocol-v1 envelope (structure only; the durable inbox re-validates + does skew/dedupe).
  try { validateEnvelope(parsed, { checkSkew: false }); }
  catch (e) { return { ok: false, code: safeEnvelopeCode(e) }; }

  if (!isWorkerToCloudType(parsed.type)) return { ok: false, code: "E_FRAME_WRONG_DIRECTION" };
  return { ok: true, envelope: parsed };
}

function safeEnvelopeCode(e) {
  const c = e && e.code;
  // Map protocol error codes to safe frame codes; never surface the message text.
  if (typeof c === "string" && /^E_/.test(c)) return c;
  return "E_FRAME_ENVELOPE_INVALID";
}
