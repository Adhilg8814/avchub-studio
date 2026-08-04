// AVC Studio Worker Protocol v1 — prefixed ULID identifiers.
//
// PURE MODULE. The ONLY import is `node:crypto` (randomFillSync) for entropy —
// no fs/path/child_process/http/WebSocket/browser/Python/storage/env. Safe for
// both cloud and Worker.
//
// ID format: `<prefix>_<26-char Crockford Base32 ULID>`.
//   - ULID = 48-bit timestamp (ms) + 80-bit randomness, encoded to 26 chars.
//   - Crockford Base32 alphabet: 0-9 A-Z minus I, L, O, U.
// Spec: docs/protocol-v1.md §3 (ID format), §7 (fixture IDs).

import { randomFillSync } from "node:crypto";

import { PROTOCOL_ERRORS, protocolError } from "./errors.mjs";

// Crockford Base32 alphabet (no I, L, O, U). Index = 5-bit value.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_INDEX = (() => {
  const map = new Map();
  for (let i = 0; i < CROCKFORD.length; i += 1) map.set(CROCKFORD[i], i);
  return map;
})();

export const ID_PREFIXES = Object.freeze([
  "usr", "ws", "wrk", "job", "asset", "msg", "corr", "sess",
  "prj", "ep", "sh", "pa", "req", "attempt", "submission"
]);
const PREFIX_SET = new Set(ID_PREFIXES);

export const ULID_LENGTH = 26;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/; // Crockford, exactly 26 chars

// ---------------------------------------------------------------- ULID encode

// Encode 128 bits (16 bytes: 6 time + 10 random) into 26 Crockford chars.
// Standard ULID layout: the 128-bit integer is emitted big-endian in 5-bit
// groups; because 26*5 = 130 bits, the first char carries only the top 2 bits
// (so a valid ULID's first char is 0-7).
function encodeUlidBytes(bytes) {
  // Build a 130-bit view by prepending two zero bits, then read 26 groups of 5.
  let out = "";
  // Represent the 128 bits as a BigInt for clean 5-bit slicing.
  let value = 0n;
  for (let i = 0; i < 16; i += 1) value = (value << 8n) | BigInt(bytes[i]);
  // 26 groups, most-significant first.
  for (let i = 25; i >= 0; i -= 1) {
    const group = Number((value >> BigInt(i * 5)) & 31n);
    out += CROCKFORD[group];
  }
  return out;
}

// Generate a ULID string (26 chars). `timeMs` overridable for determinism in
// tests; defaults to Date.now(). (Date.now is allowed — this is a pure value
// function, not env/fs access.)
export function generateUlid(timeMs = Date.now()) {
  const bytes = new Uint8Array(16);
  // 48-bit timestamp, big-endian, into bytes[0..5].
  let t = BigInt(Math.max(0, Math.floor(timeMs)));
  for (let i = 5; i >= 0; i -= 1) { bytes[i] = Number(t & 0xffn); t >>= 8n; }
  // 80-bit randomness into bytes[6..15].
  const rnd = new Uint8Array(10);
  randomFillSync(rnd);
  bytes.set(rnd, 6);
  return encodeUlidBytes(bytes);
}

export function isValidUlid(value) {
  return typeof value === "string" && ULID_RE.test(value);
}

// ---------------------------------------------------------------- public API

export function isKnownPrefix(prefix) {
  return PREFIX_SET.has(prefix);
}

// generateId("job") -> "job_01JQ..." (throws on unknown prefix).
export function generateId(prefix, timeMs = undefined) {
  if (!PREFIX_SET.has(prefix)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, `Unknown id prefix: "${safePrefix(prefix)}"`, { prefix: safePrefix(prefix) });
  }
  return `${prefix}_${generateUlid(timeMs)}`;
}

// parseId("job_01JQ...") -> { prefix, ulid }. Throws E_INVALID_ID otherwise.
export function parseId(value) {
  if (typeof value !== "string") {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, "Id must be a string", { type: typeof value });
  }
  const underscore = value.indexOf("_");
  if (underscore <= 0 || underscore === value.length - 1) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, "Id must be <prefix>_<ulid>", { reason: "missing-separator" });
  }
  const prefix = value.slice(0, underscore);
  const ulid = value.slice(underscore + 1);
  if (!PREFIX_SET.has(prefix)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, `Unknown id prefix: "${safePrefix(prefix)}"`, { prefix: safePrefix(prefix) });
  }
  if (!ULID_RE.test(ulid)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, "Id body is not a valid 26-char Crockford ULID", { prefix, ulidLength: ulid.length });
  }
  return { prefix, ulid };
}

// validateId(value, expectedPrefix?) -> boolean (no throw). If expectedPrefix
// given, the value must carry exactly that prefix.
export function validateId(value, expectedPrefix = undefined) {
  if (typeof value !== "string") return false;
  const underscore = value.indexOf("_");
  if (underscore <= 0 || underscore === value.length - 1) return false;
  const prefix = value.slice(0, underscore);
  const ulid = value.slice(underscore + 1);
  if (!PREFIX_SET.has(prefix)) return false;
  if (!ULID_RE.test(ulid)) return false;
  if (expectedPrefix !== undefined && prefix !== expectedPrefix) return false;
  return true;
}

// assertId(value, expectedPrefix?) — throws ProtocolError(E_INVALID_ID) if invalid.
export function assertId(value, expectedPrefix = undefined, fieldName = "id") {
  if (!validateId(value, expectedPrefix)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID,
      `Invalid ${fieldName}${expectedPrefix ? ` (expected prefix "${expectedPrefix}_")` : ""}`,
      { field: fieldName, expectedPrefix: expectedPrefix ?? null });
  }
  return value;
}

// Decode a ULID's 48-bit timestamp (ms). Useful for ordering/inspection; pure.
export function ulidTimeMs(ulid) {
  if (!ULID_RE.test(ulid)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_ID, "Not a valid ULID", {});
  }
  // First 10 chars encode the 48-bit (+2 pad) timestamp portion.
  let value = 0n;
  for (const ch of ulid.slice(0, 10)) value = (value << 5n) | BigInt(CROCKFORD_INDEX.get(ch));
  // Drop the 2 pad bits that were prepended during encode (130 - 128).
  return Number(value & ((1n << 48n) - 1n));
}

// Never echo an arbitrary prefix value verbatim into a message; clamp it.
function safePrefix(prefix) {
  const s = String(prefix ?? "");
  return s.length <= 16 ? s.replace(/[^\w-]/g, "?") : `${s.slice(0, 16).replace(/[^\w-]/g, "?")}…`;
}
