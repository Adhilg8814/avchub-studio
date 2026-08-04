// P0 Step 5C.21 — TOTP (RFC 6238) + base32, implemented on node:crypto only (no otplib dependency).
//
// Used for the second factor. The secret is generated server-side, shown ONCE during enrollment (as an
// otpauth:// URL / manual key), then stored ENCRYPTED at rest (see secret-box.mjs) — this module never
// persists or logs anything. verify() returns the matched timestep so the caller can enforce a
// single-use-per-timestep replay guard (reject any code whose timestep <= the last accepted one).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32 alphabet
const PERIOD = 30, DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str || "").toUpperCase().replace(/=+$/,"").replace(/\s+/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) { const e = new Error("bad base32"); e.code = "TOTP_SECRET_INVALID"; throw e; }
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// A fresh 160-bit secret (RFC 6238 recommends >=160 bits for SHA-1), base32-encoded.
export function generateTotpSecret() { return base32Encode(randomBytes(20)); }

// otpauth:// URL for the enrollment QR. label/issuer are percent-encoded. Shown once, never re-derivable.
export function otpauthUrl(secretBase32, { issuer = "AVC Studio", account = "user" } = {}) {
  // otpauth label is "issuer:account" with issuer/account each percent-encoded but the ':' left literal.
  const lbl = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = `secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
  return `otpauth://totp/${lbl}?${q}`;
}

function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secretBuf).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function currentTimestep(nowMs) { return Math.floor((nowMs ?? Date.now()) / 1000 / PERIOD); }

export function generateTotp(secretBase32, { nowMs = Date.now() } = {}) {
  return hotp(base32Decode(secretBase32), currentTimestep(nowMs));
}

// Verify a submitted code against a bounded skew window. Returns { ok, timestep } — timestep is the
// matched counter so the caller can persist it and reject replays (code from an already-used timestep).
export function verifyTotp(secretBase32, code, { window = 1, nowMs = Date.now(), lastUsedTimestep = null } = {}) {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return { ok: false, code: "TOTP_CODE_INVALID" };
  let secret; try { secret = base32Decode(secretBase32); } catch { return { ok: false, code: "TOTP_SECRET_INVALID" }; }
  const t0 = currentTimestep(nowMs);
  const w = Math.max(0, Math.min(4, Number(window) || 0));
  for (let dt = -w; dt <= w; dt += 1) {
    const ts = t0 + dt;
    const expected = hotp(secret, ts);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c))) {
      if (lastUsedTimestep != null && ts <= Number(lastUsedTimestep)) return { ok: false, code: "TOTP_REPLAY" };
      return { ok: true, timestep: ts };
    }
  }
  return { ok: false, code: "TOTP_MISMATCH" };
}
