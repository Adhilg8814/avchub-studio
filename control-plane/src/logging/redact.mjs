// P0 Step 5C.1 — sanitization / redaction helper (PURE).
//
// Removes secrets and sensitive values before anything is logged or returned. Matching is
// by KEY (case-insensitive, at any nesting depth) plus a few VALUE shapes (Bearer tokens,
// absolute paths, provider URLs). Zero side effects; imports nothing.
//
// This is provider-neutral: the denylist is generic security terminology, not brand names.

// Sensitive KEY fragments — a key is redacted if its lowercased form CONTAINS any of these.
const SENSITIVE_KEY_FRAGMENTS = Object.freeze([
  "authorization", "credential", "cred", "pairingcode", "paircode", "pairing_code",
  "verifier", "pepper", "cookie", "token", "secret", "password", "passwd", "proxy",
  "apikey", "api_key", "privatekey", "private_key", "sessiontoken", "resumetoken",
  "resume_token", "bearer", "set-cookie", "x-api-key"
]);

// Keys whose VALUE may be a raw URL / absolute path (redact the value, keep the key).
const URL_LIKE_KEY_FRAGMENTS = Object.freeze([
  "url", "uri", "href", "endpoint", "downloadurl", "resulturl", "signedurl",
  "presignedurl", "webhook", "callbackurl", "database_url", "databaseurl", "dburl", "dsn"
]);

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;              // hard cap: never recurse into pathological nesting
const MAX_STRING = 2048;          // clamp long strings in logs

function keyIsSensitive(key) {
  const k = String(key).toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}
function keyIsUrlLike(key) {
  const k = String(key).toLowerCase();
  return URL_LIKE_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}

// A string value that itself looks like a secret/URL/absolute path, regardless of its key.
function valueLooksSensitive(value) {
  if (typeof value !== "string") return false;
  if (/^\s*bearer\s+\S/i.test(value)) return true;           // "Bearer <token>"
  if (/\b(wcred_|pcode_|rt\.v\d)/i.test(value)) return true; // credential / pairing / resume shapes
  if (/:\/\//.test(value)) return true;                       // any scheme://... URL
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;             // Windows absolute path C:\ or C:/
  if (/^\/(?:home|users|var|etc|root|mnt|media)\//i.test(value)) return true; // POSIX absolute path
  return false;
}

function clampString(s) {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[clamped ${s.length}]` : s;
}

// sanitize(value): returns a redacted deep copy safe to serialize. Never throws.
export function sanitize(value, depth = 0) {
  try {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "number" || t === "boolean") return value;
    if (t === "bigint") return `${value}n`;
    if (t === "function" || t === "symbol") return `[${t}]`;
    if (t === "string") return valueLooksSensitive(value) ? REDACTED : clampString(value);

    if (depth >= MAX_DEPTH) return "[depth-limit]";

    if (Array.isArray(value)) {
      return value.slice(0, 200).map((v) => sanitize(v, depth + 1));
    }

    if (value instanceof Error) {
      // Only the sanitized class + a clamped message; NEVER the stack.
      return { errorName: value.name, code: value.code, message: sanitize(value.message, depth + 1) };
    }

    if (t === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "__proto__" || k === "prototype" || k === "constructor") continue;
        if (keyIsSensitive(k)) { out[k] = REDACTED; continue; }
        if (keyIsUrlLike(k) && typeof v === "string") { out[k] = REDACTED; continue; }
        out[k] = sanitize(v, depth + 1);
      }
      return out;
    }
    return `[${t}]`;
  } catch {
    return "[unserializable]";
  }
}

// isSensitiveKey / valueLooksSensitive are exported for tests + reuse.
export { keyIsSensitive as isSensitiveKey, valueLooksSensitive };
