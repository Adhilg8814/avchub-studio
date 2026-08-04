// P0 Step 5C.4 — resume-token generation + verifier hashing (PURE, node:crypto).
//
// A resume token is a high-entropy opaque string returned to the Worker ONCE in HELLO_ACK. Only
// its SHA-256 verifier is stored (resume_token_hash). Per protocol §11 + the task's conservative
// rule, resume does NOT bypass credential authentication — every reconnect still presents the
// Authorization credential; the resume token only correlates prior session/reconcile state.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

// Opaque, non-guessable, not a credential. Prefix marks it a resume token (§7.1 example uses rt.v1).
export function generateResumeToken() {
  const token = `rt.v1.${randomBytes(32).toString("base64url")}`;
  return { token, hash: resumeTokenHash(token) };
}

export function resumeTokenHash(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function isResumeTokenShaped(token) {
  return typeof token === "string" && /^rt\.v1\.[A-Za-z0-9_-]{40,}$/.test(token);
}

// Constant-time verifier comparison (equal-length hex).
export function resumeTokenMatches(token, storedHashHex) {
  if (typeof storedHashHex !== "string" || storedHashHex.length !== 64) return false;
  try { return timingSafeEqual(Buffer.from(resumeTokenHash(token), "hex"), Buffer.from(storedHashHex, "hex")); }
  catch { return false; }
}
