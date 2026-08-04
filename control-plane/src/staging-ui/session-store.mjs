// P0 Step 5C.7 — bounded, process-local temporary Studio sessions.
//
// Session and CSRF plaintext values exist only in the browser cookies and in the return value of
// create(). The registry retains SHA-256 verifiers only. There is deliberately no persistence and
// no cleanup timer: expiry is enforced lazily and a process restart invalidates every session.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function randomToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

function keyFor(value) {
  return digest(value).toString("hex");
}

function validToken(value) {
  return typeof value === "string" && TOKEN_RE.test(value);
}

function equalDigest(expected, plaintext) {
  const actual = digest(typeof plaintext === "string" ? plaintext : "");
  return Buffer.isBuffer(expected) && expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createStagingSessionStore({
  ttlMs = 30 * 60 * 1000,
  maxSessions = 64,
  now = () => Date.now()
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive integer");
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) throw new TypeError("maxSessions must be a positive integer");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const records = new Map();

  function nowMs() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function purgeExpired(at = nowMs()) {
    for (const [key, record] of records) {
      if (record.expiresAtMs <= at) records.delete(key);
    }
  }

  function evictOne() {
    let victim = null;
    for (const [key, record] of records) {
      if (!victim || record.expiresAtMs < victim.expiresAtMs) victim = { key, expiresAtMs: record.expiresAtMs };
    }
    if (victim) records.delete(victim.key);
  }

  function lookup(sessionId, at = nowMs()) {
    if (!validToken(sessionId)) return null;
    const key = keyFor(sessionId);
    const record = records.get(key);
    if (!record) return null;
    if (record.expiresAtMs <= at) {
      records.delete(key);
      return null;
    }
    return { key, record };
  }

  function publicRecord(record) {
    return Object.freeze({
      workspaceId: record.workspaceId,
      actorId: record.actorId,
      createdAt: new Date(record.createdAtMs).toISOString(),
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      expiresAtMs: record.expiresAtMs
    });
  }

  function create({ workspaceId, actorId }) {
    const at = nowMs();
    purgeExpired(at);
    while (records.size >= maxSessions) evictOne();

    let sessionId;
    do { sessionId = randomToken(); } while (records.has(keyFor(sessionId)));
    const csrfToken = randomToken();
    const record = {
      workspaceId,
      actorId,
      createdAtMs: at,
      expiresAtMs: at + ttlMs,
      csrfVerifier: digest(csrfToken)
    };
    records.set(keyFor(sessionId), record);
    return Object.freeze({ sessionId, csrfToken, ...publicRecord(record) });
  }

  // Both opaque cookies must be present. The CSRF carrier is HttpOnly in the browser; validating
  // it here lets GET /staging/session safely return the same stable token to runtime memory.
  function resolve({ sessionId, csrfCookieToken }) {
    const found = lookup(sessionId);
    if (!found) return null;
    const cookieDigestOk = equalDigest(found.record.csrfVerifier, csrfCookieToken);
    if (!validToken(csrfCookieToken) || !cookieDigestOk) return null;
    return publicRecord(found.record);
  }

  function verifyMutation({ sessionId, csrfCookieToken, csrfHeaderToken }) {
    const found = lookup(sessionId);
    if (!found) return null;
    // Perform both digest comparisons when a session exists. Invalid token shapes still take the
    // same digest path and never cause the expected verifier to be exposed.
    const cookieDigestOk = equalDigest(found.record.csrfVerifier, csrfCookieToken);
    const headerDigestOk = equalDigest(found.record.csrfVerifier, csrfHeaderToken);
    const cookieOk = validToken(csrfCookieToken) && cookieDigestOk;
    const headerOk = validToken(csrfHeaderToken) && headerDigestOk;
    return cookieOk && headerOk ? publicRecord(found.record) : null;
  }

  function destroy(sessionId) {
    if (!validToken(sessionId)) return false;
    return records.delete(keyFor(sessionId));
  }

  function clear() {
    records.clear();
  }

  function status() {
    purgeExpired();
    return Object.freeze({ size: records.size, maxSessions, ttlMs });
  }

  return Object.freeze({ create, resolve, verifyMutation, destroy, clear, status });
}

export const STAGING_SESSION_TOKEN_PATTERN = TOKEN_RE;
