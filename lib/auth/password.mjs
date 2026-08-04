// P0 Step 5C.21 — password hashing (Argon2id via @node-rs/argon2). Server-side only.
//
// The plaintext password exists only transiently on the stack of hash()/verify(); it is NEVER logged,
// echoed, trimmed, or transformed beyond the published policy. The stored value is the standard argon2
// encoded string ($argon2id$v=19$m=..,t=..,p=..$salt$hash) — self-describing, so verify() and
// needsRehash() read the parameters back from it. An OPTIONAL server-side pepper (a keyed `secret`, from a
// secure store outside the DB) can be supplied so a stolen DB alone cannot be brute-forced offline.

import { hash as argonHash, verify as argonVerify, Algorithm } from "@node-rs/argon2";

// OWASP-aligned Argon2id parameters (memory in KiB). Tuned to be strong yet viable on the production box.
export const ARGON2_PARAMS = Object.freeze({ algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

// Published password policy (no silent transforms). Long passphrases allowed; an upper bound only guards
// against a CPU/memory DoS from a multi-megabyte input.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 1024;

export function validatePasswordPolicy(password) {
  if (typeof password !== "string") return { ok: false, code: "PASSWORD_INVALID" };
  if (password.length < PASSWORD_MIN) return { ok: false, code: "PASSWORD_TOO_SHORT" };
  if (password.length > PASSWORD_MAX) return { ok: false, code: "PASSWORD_TOO_LONG" };
  return { ok: true };
}

function pepperOpt(pepper) {
  // @node-rs/argon2 accepts a keyed `secret` (Buffer). The pepper is NOT stored with the hash.
  return pepper ? { secret: Buffer.isBuffer(pepper) ? pepper : Buffer.from(String(pepper), "utf8") } : {};
}

export async function hashPassword(password, { pepper = null } = {}) {
  const pol = validatePasswordPolicy(password);
  if (!pol.ok) { const e = new Error("password policy"); e.code = pol.code; throw e; }
  return argonHash(password, { ...ARGON2_PARAMS, ...pepperOpt(pepper) });
}

// Constant-time verification via argon2. Any parse/verify error is a NON-match (never throws to the caller).
export async function verifyPassword(storedHash, password, { pepper = null } = {}) {
  if (typeof storedHash !== "string" || typeof password !== "string" || !storedHash) return false;
  try { return await argonVerify(storedHash, password, pepperOpt(pepper)); } catch { return false; }
}

// True when the stored hash was produced with weaker params than the current policy (rehash on next login).
export function needsRehash(storedHash) {
  if (typeof storedHash !== "string") return true;
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!m) return true; // not argon2id / unknown → rehash
  const [mem, time, par] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mem < ARGON2_PARAMS.memoryCost || time < ARGON2_PARAMS.timeCost || par !== ARGON2_PARAMS.parallelism;
}
