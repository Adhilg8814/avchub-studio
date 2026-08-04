// P0 Step 5C.21 — MFA recovery codes. High-entropy single-use codes, shown ONCE at generation, stored
// only as sha256 hashes. Regenerating mints a new batch and revokes the old one. Using one is a security
// event (recorded by the service). This module is pure: it mints + normalizes + hashes; the DB layer owns
// batch/used/revoked state.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // Crockford-ish: no 0/O/1/I/L confusables
const GROUPS = 2, GROUP_LEN = 5; // e.g. "A3F9K-QM7XZ" (10 chars, ~50 bits)

function randomCode() {
  const bytes = randomBytes(GROUPS * GROUP_LEN);
  let s = "";
  for (let i = 0; i < GROUPS * GROUP_LEN; i += 1) {
    if (i > 0 && i % GROUP_LEN === 0) s += "-";
    s += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return s;
}

// Normalize for hashing/compare: uppercase, strip everything but the alphabet (so "a3f9k-qm7xz",
// "A3F9KQM7XZ", "A3F9K QM7XZ" all match). Display keeps the hyphen; storage keys off the normal form.
export function normalizeRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(new RegExp(`[^${ALPHABET}]`, "g"), "");
}

export function hashRecoveryCode(code) {
  return createHash("sha256").update(normalizeRecoveryCode(code), "utf8").digest("hex");
}

// Generate a fresh batch. Returns { plaintext: string[] (show ONCE), hashes: string[] }.
export function generateRecoveryCodes(count = 10) {
  const n = Math.max(1, Math.min(20, Number(count) || 10));
  const plaintext = [], hashes = [], seen = new Set();
  while (plaintext.length < n) {
    const c = randomCode();
    const h = hashRecoveryCode(c);
    if (seen.has(h)) continue;
    seen.add(h); plaintext.push(c); hashes.push(h);
  }
  return { plaintext, hashes };
}

// Constant-time membership check of a submitted code against a set of stored hashes.
export function matchRecoveryHash(code, storedHashes) {
  const h = Buffer.from(hashRecoveryCode(code), "hex");
  let matchedHex = null;
  for (const stored of storedHashes || []) {
    const s = Buffer.from(String(stored), "hex");
    if (s.length === h.length && timingSafeEqual(s, h)) matchedHex = String(stored);
  }
  return matchedHex; // the matched stored hash (so the caller marks THAT row used), or null
}
