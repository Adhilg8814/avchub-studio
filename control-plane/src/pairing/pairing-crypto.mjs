// P0 Step 5C.5 — pairing + credential crypto (PURE, node:crypto only).
//
// The Control Plane must NOT import lib/control (dependency-boundary test). This module replicates
// the pairing-code + Worker-credential scheme of lib/control/identity-crypto.mjs so that:
//   • a pairing code minted here normalizes identically to what a Worker (lib/control) would send;
//   • a Worker credential minted here is byte-compatible with the Gateway verifier
//     (control-plane/src/gateway/credential-verifier.mjs) and lib/control's isCredentialShaped.
// It MUST stay byte-compatible with lib/control/identity-crypto.mjs — same pepper ⇒ same verifier.
//
// NO plaintext code/credential is ever persisted or logged: only peppered HMAC-SHA256 verifiers
// are stored. Peppers come from the environment; comparisons are constant-time.

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

// Crockford Base32 (no I, L, O, U) — unambiguous for humans.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ---- pairing code (12 Crockford chars = 60 bits entropy, shown XXXX-XXXX-XXXX) ----
export function generatePairingCode() {
  // 256 % 32 === 0 → (byte % 32) is unbiased.
  const bytes = randomBytes(12);
  let normalized = "";
  for (let i = 0; i < 12; i += 1) normalized += CROCKFORD[bytes[i] % 32];
  const code = `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
  return { code, normalized };
}

// Normalize human input: uppercase, strip separators, map Crockford aliases (I/L→1, O→0, U→V).
// Returns "" unless the input yields exactly 12 Crockford characters.
export function normalizePairingCode(input) {
  if (typeof input !== "string") return "";
  let s = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  s = s.replace(/[IL]/g, "1").replace(/O/g, "0").replace(/U/g, "V");
  if (s.length !== 12) return "";
  for (const ch of s) if (!CROCKFORD.includes(ch)) return "";
  return s;
}

export function isValidPairingCodeFormat(input) { return normalizePairingCode(input) !== ""; }

// ---- verifiers (peppered HMAC-SHA256; hex) ----
function pepperKey(pepper) {
  if (pepper == null) throw new Error("pairing-crypto requires a pepper");
  return typeof pepper === "string" ? Buffer.from(pepper, "utf8") : Buffer.from(pepper);
}
export function pairingCodeVerifier(pepper, normalizedCode) {
  return createHmac("sha256", pepperKey(pepper)).update(String(normalizedCode)).digest("hex");
}
export function credentialVerifier(pepper, credential) {
  return createHmac("sha256", pepperKey(pepper)).update(String(credential)).digest("hex");
}

// Constant-time hex compare (equal length required; length-mismatch → false without leaking
// timing on the compare itself).
export function constantTimeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  try { return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); } catch { return false; }
}

// Constant-time compare of two opaque secret STRINGS (e.g. operator tokens). Uses SHA-256 digests
// so unequal lengths don't leak and Buffer.from never throws on non-hex input.
export function constantTimeEqualSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  try { return timingSafeEqual(ha, hb); } catch { return false; }
}

// ---- Worker credential (>=256 bits, opaque, one-time plaintext) ----
export function generateWorkerCredential() {
  const secret = randomBytes(32).toString("base64url"); // 256 bits
  return `wcred_${secret}`;
}
export function isCredentialShaped(cred) {
  return typeof cred === "string" && /^wcred_[A-Za-z0-9_-]{40,}$/.test(cred);
}
