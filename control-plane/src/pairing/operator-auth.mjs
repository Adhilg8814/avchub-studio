// P0 Step 5C.5 — operator authentication for pairing/credential lifecycle APIs.
//
// STAGING-SAFE shared service token. Operator endpoints are OFF by default and the staging token
// adapter is FORBIDDEN in production (enforced in config.mjs). The token arrives ONLY in the
// `Authorization: Bearer <token>` header, is compared in CONSTANT TIME against the env-injected
// value, and is NEVER logged or echoed. This is deliberately NOT human SSO — it is a break-glass
// operator credential for the staging pairing certification.

import { constantTimeEqualSecret } from "./pairing-crypto.mjs";

export const OPERATOR_AUTH_CODES = Object.freeze({
  OK: "OK",
  MISSING: "E_OPERATOR_UNAUTHORIZED",
  MALFORMED: "E_OPERATOR_UNAUTHORIZED",
  MULTIPLE: "E_OPERATOR_UNAUTHORIZED",
  TOO_LARGE: "E_OPERATOR_UNAUTHORIZED",
  NOT_CONFIGURED: "E_OPERATOR_FORBIDDEN",   // operator API disabled / no token → forbidden
  FAILED: "E_OPERATOR_UNAUTHORIZED"          // generic: wrong token — never reveals validity detail
});

const MAX_AUTH_HEADER_BYTES = 8 * 1024;
const BEARER_RE = /^Bearer ([A-Za-z0-9._\-=+/]+)$/;

// Extract the operator bearer token. Never returns the token on an error path. Rejects
// missing / malformed / multiple / oversized headers.
export function extractOperatorBearer(headers) {
  const raw = headers && headers.authorization;
  if (raw === undefined || raw === null || raw === "") return { ok: false, code: OPERATOR_AUTH_CODES.MISSING };
  if (typeof raw !== "string") return { ok: false, code: OPERATOR_AUTH_CODES.MALFORMED };
  if (Buffer.byteLength(raw, "utf8") > MAX_AUTH_HEADER_BYTES) return { ok: false, code: OPERATOR_AUTH_CODES.TOO_LARGE };
  if (raw.includes(",")) return { ok: false, code: OPERATOR_AUTH_CODES.MULTIPLE };
  const m = BEARER_RE.exec(raw);
  if (!m) return { ok: false, code: OPERATOR_AUTH_CODES.MALFORMED };
  return { ok: true, token: m[1] };
}

// authenticateOperator({ enabled, operatorToken, operatorActorId, headers }): resolves
// { ok, actorId } or { ok:false, code }. `enabled` gates the whole operator surface; a missing
// configured token is a misconfiguration surfaced as FORBIDDEN (never a bypass).
export function authenticateOperator({ enabled, operatorToken, operatorActorId, headers }) {
  if (!enabled) return { ok: false, code: OPERATOR_AUTH_CODES.NOT_CONFIGURED };
  if (typeof operatorToken !== "string" || operatorToken.length === 0) return { ok: false, code: OPERATOR_AUTH_CODES.NOT_CONFIGURED };
  const ext = extractOperatorBearer(headers);
  if (!ext.ok) return ext;
  if (!constantTimeEqualSecret(ext.token, operatorToken)) return { ok: false, code: OPERATOR_AUTH_CODES.FAILED };
  return { ok: true, actorId: operatorActorId || "operator:staging" };
}
