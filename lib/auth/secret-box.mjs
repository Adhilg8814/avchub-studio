// P0 Step 5C.21 — authenticated symmetric encryption for secrets AT REST (AES-256-GCM).
//
// Used to encrypt the TOTP secret before it touches the database, so a DB leak alone never yields a working
// second factor. The 32-byte key comes from a secure store OUTSIDE the DB (DPAPI-wrapped keyfile, wired in
// the service layer) — this module is pure and takes the key as an argument. The output is a self-describing
// versioned string (v1.<iv>.<tag>.<ct>, all base64url) so key/format can rotate without ambiguity.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_LEN = 12; // 96-bit nonce (GCM standard)

function keyBuf(key) {
  const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ""), "base64");
  if (k.length !== 32) { const e = new Error("secret-box key must be 32 bytes"); e.code = "SECRET_BOX_KEY_INVALID"; throw e; }
  return k;
}

export function encryptSecret(plaintext, key) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", keyBuf(key), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

export function decryptSecret(box, key) {
  const parts = String(box || "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) { const e = new Error("bad secret box"); e.code = "SECRET_BOX_MALFORMED"; throw e; }
  const iv = Buffer.from(parts[1], "base64url"), tag = Buffer.from(parts[2], "base64url"), ct = Buffer.from(parts[3], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", keyBuf(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"); // throws on tamper/wrong key
}

// Mint a fresh 32-byte key (base64), for first-run key provisioning by the service layer.
export function generateSecretBoxKey() { return randomBytes(32).toString("base64"); }
