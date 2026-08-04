// AVC Studio P0 Step 5B — pairing + credential crypto (PURE, node:crypto only).
//
// Generates human-enterable pairing codes and high-entropy Worker credentials, and
// derives PEPPERED HMAC-SHA256 verifiers so the control plane never stores a
// recoverable plaintext code/credential. All comparisons are constant-time.
//
// Design assumes an encrypted transport (wss) in production; loopback ws:// is
// test/dev only (documented in p0-step5b-notes.md).

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { generateUlid } from "../protocol/ids.mjs";

// Crockford Base32 (no I, L, O, U) — unambiguous for humans.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// newLocalId("install"|"cred"|"pcode"|"rot") -> "<prefix>_<ULID>". Internal ids
// (NOT wire protocol ids); workerId/workspaceId remain protocol ULIDs.
export function newLocalId(prefix) { return `${prefix}_${generateUlid()}`; }

// ---- pairing code (12 Crockford chars = 60 bits entropy, shown XXXX-XXXX-XXXX) ----
export function generatePairingCode() {
  // 256 % 32 === 0 → byte % 32 is unbiased.
  const bytes = randomBytes(12);
  let normalized = "";
  for (let i = 0; i < 12; i += 1) normalized += CROCKFORD[bytes[i] % 32];
  const code = `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
  return { code, normalized };
}

// Normalize human input: uppercase, strip separators, map Crockford aliases
// (I/L→1, O→0, U→V). Returns "" if it does not yield exactly 12 Crockford chars.
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
export function pairingCodeVerifier(pepper, normalizedCode) {
  return createHmac("sha256", pepperKey(pepper)).update(String(normalizedCode)).digest("hex");
}
export function credentialVerifier(pepper, credential) {
  return createHmac("sha256", pepperKey(pepper)).update(String(credential)).digest("hex");
}
function pepperKey(pepper) {
  if (pepper == null) throw new Error("identity-crypto requires a pepper");
  return typeof pepper === "string" ? Buffer.from(pepper, "utf8") : Buffer.from(pepper);
}

// Constant-time hex compare (equal length required; length-mismatch → false without
// timing leak on the compare itself).
export function constantTimeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  try { return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); } catch { return false; }
}

// ---- Worker credential (>=256 bits, opaque, one-time plaintext) ----
export function generateWorkerCredential() {
  const secret = randomBytes(32).toString("base64url"); // 256 bits
  return `wcred_${secret}`;
}
export function isCredentialShaped(cred) {
  return typeof cred === "string" && /^wcred_[A-Za-z0-9_-]{40,}$/.test(cred);
}

// ---- installation id (opaque, non-secret, no hardware fingerprint) ----
export function generateInstallationId() { return newLocalId("install"); }
