// P0 Step 5C.1 — per-request context (requestId / correlationId, privacy-safe remote meta).
//
// Reuses the shipped PURE protocol id helpers (lib/protocol/ids.mjs) — the only cross-module
// import the Control Plane core makes, and it is a pure value module (no fs/net/provider).
//
// A client MAY supply an X-Request-Id / X-Correlation-Id, but arbitrary/malformed ids are
// NOT trusted — an invalid id is replaced with a freshly generated one. No user is
// authenticated in this step (actor is always anonymous — security/identity-context.mjs).

import { generateId, validateId } from "../../../lib/protocol/ids.mjs";
import { anonymousActor } from "../security/identity-context.mjs";

// Accept a client-supplied id only if it is a valid `corr_<ULID>`; otherwise generate one.
function acceptOrGenerate(candidate) {
  return validateId(candidate, "corr") ? candidate : generateId("corr");
}

// Privacy-safe remote descriptor: never store the raw client IP. We record only whether the
// connection arrived via a trusted proxy and a coarse address family.
function safeRemote(req, { trustProxy }) {
  const hasForwarded = typeof req.headers?.["x-forwarded-for"] === "string";
  const fam = req.socket && req.socket.remoteFamily ? String(req.socket.remoteFamily) : null;
  return Object.freeze({ via: trustProxy && hasForwarded ? "proxy" : "direct", family: fam });
}

// createRequestContext(req, { now, trustProxy }): builds the immutable context.
export function createRequestContext(req, { now = () => new Date().toISOString(), trustProxy = false } = {}) {
  const headers = req.headers || {};
  const requestId = acceptOrGenerate(pickHeader(headers, "x-request-id"));
  const correlationId = acceptOrGenerate(pickHeader(headers, "x-correlation-id") || requestId);
  return Object.freeze({
    requestId,
    correlationId,
    startedAt: now(),
    method: typeof req.method === "string" ? req.method.toUpperCase() : "GET",
    remote: safeRemote(req, { trustProxy }),
    actor: anonymousActor()
  });
}

function pickHeader(headers, name) {
  const v = headers[name];
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : null;
  return typeof v === "string" ? v : null;
}

export { acceptOrGenerate };
