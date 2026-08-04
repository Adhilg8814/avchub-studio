// P0 Step 5C.21 — bearer-token + session-id primitives. One generator for every high-entropy artifact:
// session ids, CSRF tokens, invitation / password-reset / email-verification / bootstrap tokens. The
// PLAINTEXT is returned to the caller exactly once (put in a cookie or emailed link); only its sha256 hash
// is ever stored, so a DB leak cannot reconstruct a usable token. Comparison is constant-time.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

// 256 bits of entropy, URL-safe (fits cookies, query params, emailed links).
export function generateToken(bytes = 32) { return randomBytes(Math.max(16, bytes)).toString("base64url"); }

export function hashToken(token) { return createHash("sha256").update(String(token || ""), "utf8").digest("hex"); }

// Constant-time equality of two hex hashes (defends the rare in-process compare path).
export function tokenHashEquals(aHex, bHex) {
  const a = Buffer.from(String(aHex || ""), "hex"), b = Buffer.from(String(bHex || ""), "hex");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// Mint a token + its hash + an absolute expiry. `now`/`ttlMs` are explicit for testability.
export function issueToken({ bytes = 32, ttlMs, now = Date.now() } = {}) {
  const token = generateToken(bytes);
  return { token, tokenHash: hashToken(token), expiresAt: new Date(now + Number(ttlMs || 0)) };
}
