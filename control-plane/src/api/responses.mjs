// P0 Step 5C.1 — safe HTTP response helpers.
//
// Every response is JSON, carries the correlation id, and is no-store. Errors go through
// ControlPlaneError.toPublic() so a stack trace or raw value can never reach the client.

import { ControlPlaneError, CP_ERRORS, toControlPlaneError } from "../errors.mjs";

export function sendJson(res, status, body, { correlationId = null } = {}) {
  if (res.writableEnded || res.headersSent) return;
  let payload;
  try { payload = JSON.stringify(body ?? {}); }
  catch { payload = JSON.stringify({ code: CP_ERRORS.E_INTERNAL, message: "Internal error", retriable: true, correlationId }); status = 500; }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (correlationId) res.setHeader("X-Correlation-Id", correlationId);
  res.end(payload);
}

export function sendError(res, err, { correlationId = null, production = false } = {}) {
  const cp = toControlPlaneError(err);
  sendJson(res, cp.httpStatus, cp.toPublic({ correlationId, production }), { correlationId });
}

// Redirect to a FIXED, server-controlled relative location (never a client-supplied value, so no
// open redirect). Relative Location resolves against the request origin, so it works identically
// for the local loopback runtime and the external studio origin behind the tunnel. HEAD sends the
// same headers with no body.
export function sendRedirect(res, location, { status = 303, correlationId = null } = {}) {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (correlationId) res.setHeader("X-Correlation-Id", correlationId);
  res.end();
}

export function makeError(code, message) { return new ControlPlaneError(code, message); }
