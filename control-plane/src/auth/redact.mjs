// P0 Step 5C.21 — security/audit event metadata redaction (§14). Event metadata is small, non-secret, and
// allowlist-shaped: the service passes only known fields, and THIS is the backstop that guarantees a secret
// can never reach a stored event even if a caller is careless. Rules: primitives (string/number/boolean/
// null) only — no nested objects/arrays; any key whose name matches a secret pattern is DROPPED; string
// values are truncated; the object is capped in size. The result is safe to persist and to log.

const FORBIDDEN_KEY = /(pass(word)?|secret|token|hash|cookie|csrf|otp|totp|recover|credential|api[_-]?key|private[_-]?key|bearer|authorization|session)/i;
const MAX_KEYS = 24;
const MAX_STR = 300;

export function redactMetadata(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (n >= MAX_KEYS) break;
    if (FORBIDDEN_KEY.test(k)) continue;                       // drop secret-named keys outright
    if (v === null || typeof v === "boolean" || typeof v === "number") { out[k] = v; n += 1; continue; }
    if (typeof v === "string") { out[k] = v.slice(0, MAX_STR); n += 1; continue; }
    // arrays of primitives are allowed (bounded); everything else (objects/functions) is dropped
    if (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) {
      out[k] = v.slice(0, 20).map((x) => (typeof x === "string" ? x.slice(0, MAX_STR) : x)); n += 1;
    }
  }
  return out;
}

// Defense-in-depth scan used by tests: does any serialized value look like a secret we must never store?
export function containsLikelySecret(serialized) {
  const s = String(serialized || "");
  return (
    /\$argon2id\$/.test(s) ||                 // argon2 hash
    /\bsk_[A-Za-z0-9]{12,}\b/.test(s) ||      // provider key
    /\b[a-f0-9]{64}\b/.test(s) ||             // a raw sha256 hash / token hash
    /\botpauth:\/\//.test(s) ||               // TOTP provisioning URI
    /\b[A-Z2-7]{16,}\b/.test(s)               // base32 TOTP secret
  );
}
