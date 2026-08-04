// P0 Step 5C.4 — Worker transport authentication.
//
// Credentials arrive ONLY in the HTTP `Authorization: Bearer <wcred_…>` header of the WS upgrade
// — never in the query string, a cookie, or WORKER_HELLO. The credential is verified against the
// peppered HMAC verifier stored in worker_credentials (via the BYPASSRLS ops connection, because
// the workspace is unknown until the credential resolves). The plaintext credential is never
// logged, stored, or returned; only its credential row id is retained. Failures are generic (they
// never reveal whether a worker id exists) and rate-limited per remote.

import { credentialVerifier, isCredentialShaped } from "./credential-verifier.mjs";
import { lookupCredentialByVerifier } from "../persistence/repositories/session-repository.mjs";

export const AUTH_CODES = Object.freeze({
  OK: "OK",
  MISSING: "E_AUTH_REQUIRED",
  MALFORMED: "E_AUTH_MALFORMED",
  HEADER_TOO_LARGE: "E_AUTH_HEADER_TOO_LARGE",
  MULTIPLE: "E_AUTH_MULTIPLE",
  RATE_LIMITED: "E_AUTH_RATE_LIMITED",
  NO_PEPPER: "E_AUTH_NOT_CONFIGURED",
  FAILED: "E_AUTH_FAILED"      // generic: invalid / revoked / expired — never distinguishes
});

const MAX_AUTH_HEADER_BYTES = 8 * 1024;
const BEARER_RE = /^Bearer ([A-Za-z0-9._\-=+/]+)$/;

// extractBearer(headers): returns { ok, credential } or { ok:false, code }. Never returns the
// credential in any error path. Rejects query/cookie/multiple/malformed/oversized.
export function extractBearer(headers) {
  const raw = headers && headers.authorization;
  if (raw === undefined || raw === null || raw === "") return { ok: false, code: AUTH_CODES.MISSING };
  if (typeof raw !== "string") return { ok: false, code: AUTH_CODES.MALFORMED };
  if (Buffer.byteLength(raw, "utf8") > MAX_AUTH_HEADER_BYTES) return { ok: false, code: AUTH_CODES.HEADER_TOO_LARGE };
  // node joins duplicate Authorization headers with ", " — reject any multiplicity.
  if (raw.includes(",")) return { ok: false, code: AUTH_CODES.MULTIPLE };
  const m = BEARER_RE.exec(raw);
  if (!m) return { ok: false, code: AUTH_CODES.MALFORMED };
  return { ok: true, credential: m[1] };
}

// Simple fixed-window rate limiter for FAILED auth attempts, keyed by a coarse remote label.
export function createAuthRateLimiter({ windowMs = 60000, maxPerWindow = 20, now = () => Date.now() } = {}) {
  const buckets = new Map(); // key → { count, resetAt }
  function check(key) {
    const k = key || "unknown";
    const t = now();
    let b = buckets.get(k);
    if (!b || t >= b.resetAt) { b = { count: 0, resetAt: t + windowMs }; buckets.set(k, b); }
    return b.count < maxPerWindow;
  }
  function record(key) {
    const k = key || "unknown";
    const t = now();
    let b = buckets.get(k);
    if (!b || t >= b.resetAt) { b = { count: 0, resetAt: t + windowMs }; buckets.set(k, b); }
    b.count += 1;
    // bounded map: opportunistically drop expired buckets
    if (buckets.size > 4096) { for (const [kk, vv] of buckets) if (t >= vv.resetAt) buckets.delete(kk); }
  }
  return { check, record, _size: () => buckets.size };
}

// authenticate({ persistence, pepper, credential }): resolves { ok, workspaceId, workerId,
// credentialId, protocolVersion } or { ok:false, code }. Generic failure for any credential
// problem; a distinct NO_PEPPER when the gateway is misconfigured.
export async function authenticateCredential({ persistence, pepper, credential, now = () => Date.now() }) {
  if (!pepper) return { ok: false, code: AUTH_CODES.NO_PEPPER };
  if (!isCredentialShaped(credential)) return { ok: false, code: AUTH_CODES.FAILED };
  let verifier;
  try { verifier = credentialVerifier(pepper, credential); } catch { return { ok: false, code: AUTH_CODES.NO_PEPPER }; }
  const row = await persistence.opsEnumerate((c) => lookupCredentialByVerifier(c, verifier));
  if (!row) return { ok: false, code: AUTH_CODES.FAILED };
  if (row.cred_status !== "ACTIVE") return { ok: false, code: AUTH_CODES.FAILED };
  if (row.worker_status === "REVOKED") return { ok: false, code: AUTH_CODES.FAILED };
  if (row.expires_at && new Date(row.expires_at).getTime() <= now()) return { ok: false, code: AUTH_CODES.FAILED };
  return { ok: true, workspaceId: row.workspace_id, workerId: row.worker_id, credentialId: row.credential_id, protocolVersion: row.protocol_version };
}
