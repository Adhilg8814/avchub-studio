// P0 Step 5C.4 — Worker credential verifier (PURE, node:crypto only).
//
// The Control Plane must not import lib/control (dependency boundary); this replicates the peppered
// HMAC-SHA256 verifier scheme that mints worker_credentials.credential_hash so the Gateway can
// authenticate a presented credential. It MUST stay byte-compatible with lib/control/identity-
// crypto.mjs (credentialVerifier / isCredentialShaped) — the same pepper yields the same verifier.

import { createHmac } from "node:crypto";

// wcred_<>=256-bit base64url> shape (matches identity-crypto.generateWorkerCredential).
export function isCredentialShaped(cred) {
  return typeof cred === "string" && /^wcred_[A-Za-z0-9_-]{40,}$/.test(cred);
}

// HMAC-SHA256(pepper, credential) hex — identical to lib/control/identity-crypto.credentialVerifier.
export function credentialVerifier(pepper, credential) {
  if (pepper == null) throw new Error("credential verifier requires a pepper");
  const key = typeof pepper === "string" ? Buffer.from(pepper, "utf8") : Buffer.from(pepper);
  return createHmac("sha256", key).update(String(credential)).digest("hex");
}
