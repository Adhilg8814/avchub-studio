// P0 Step 5C.7 — HTTP safety helpers shared by the temporary Studio session and static UI.

import { ControlPlaneError, CP_ERRORS } from "../errors.mjs";

export const STAGING_SESSION_COOKIE = "cp_staging_ui_session";
export const STAGING_CSRF_COOKIE = "cp_staging_ui_csrf";

export function createStagingContentSecurityPolicy(providerLocalOrigin = "http://127.0.0.1:5177") {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    // Provider-account secrets bypass the Control Plane and travel directly to
    // the exact origin-bound numeric-loopback Worker enrollment channel.
    `connect-src 'self' ${providerLocalOrigin}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join("; ");
}

export const STAGING_CONTENT_SECURITY_POLICY = createStagingContentSecurityPolicy();

function bad(message = "Invalid staging request") {
  return new ControlPlaneError(CP_ERRORS.E_BAD_REQUEST, message);
}

function oneHeader(headers, name) {
  const value = headers && headers[name];
  return typeof value === "string" ? value : null;
}

export function applyStagingSecurityHeaders(res, { providerLocalOrigin = "http://127.0.0.1:5177" } = {}) {
  if (!res || res.headersSent) return;
  res.setHeader("Content-Security-Policy", createStagingContentSecurityPolicy(providerLocalOrigin));
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

export function isSecureRequest(req, { trustProxy = false } = {}) {
  if (req?.socket?.encrypted === true) return true;
  if (!trustProxy) return false;
  const forwarded = oneHeader(req?.headers, "x-forwarded-proto");
  return forwarded === "https";
}

export function assertSameOriginMutation(req, { trustProxy = false } = {}) {
  const fetchSite = oneHeader(req?.headers, "sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") throw bad("Same-origin request required");

  const origin = oneHeader(req?.headers, "origin");
  const host = oneHeader(req?.headers, "host");
  if (!origin || !host || origin.length > 2048 || host.length > 255) throw bad("Same-origin request required");
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host) || host.includes(",")) throw bad("Same-origin request required");

  let supplied;
  let expected;
  try {
    supplied = new URL(origin);
    const scheme = isSecureRequest(req, { trustProxy }) ? "https" : "http";
    expected = new URL(`${scheme}://${host}`);
  } catch {
    throw bad("Same-origin request required");
  }
  if (!['http:', 'https:'].includes(supplied.protocol) || supplied.username || supplied.password || supplied.pathname !== "/" || supplied.search || supplied.hash) {
    throw bad("Same-origin request required");
  }
  if (supplied.origin !== expected.origin) throw bad("Same-origin request required");
}

// Reject encoded path components entirely. Studio route parameters use constrained opaque IDs and
// never need percent encoding, so this removes encoded slash/dot/backslash and double-decode risk.
export function parseStrictStagingTarget(url) {
  const raw = typeof url === "string" ? url : "/";
  if (raw.length > 8192 || !raw.startsWith("/") || raw.includes("#")) throw bad();
  const queryAt = raw.indexOf("?");
  const pathname = queryAt >= 0 ? raw.slice(0, queryAt) : raw;
  const queryText = queryAt >= 0 ? raw.slice(queryAt + 1) : "";
  if (!pathname || pathname.includes("%") || pathname.includes("\\") || pathname.includes("//") || /[\u0000-\u001f\u007f]/.test(pathname)) throw bad();
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) throw bad();
  if (/%(?![0-9A-Fa-f]{2})/.test(queryText) || /[\u0000-\u001f\u007f]/.test(queryText)) throw bad();
  return Object.freeze({ pathname, searchParams: new URLSearchParams(queryText) });
}

export function readStagingCookies(req) {
  const raw = oneHeader(req?.headers, "cookie");
  if (raw === null || raw.length > 8192) return { sessionId: null, csrfToken: null, malformed: raw !== null };
  let sessionId = null;
  let csrfToken = null;
  let malformed = false;
  for (const item of raw.split(";")) {
    const part = item.trim();
    if (!part) continue;
    const at = part.indexOf("=");
    if (at <= 0) { malformed = true; continue; }
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === STAGING_SESSION_COOKIE) {
      if (sessionId !== null) malformed = true;
      else sessionId = value;
    } else if (name === STAGING_CSRF_COOKIE) {
      if (csrfToken !== null) malformed = true;
      else csrfToken = value;
    }
  }
  return { sessionId, csrfToken, malformed };
}

function serializeCookie(name, value, { maxAgeSeconds, secure, clear = false }) {
  const parts = [`${name}=${clear ? "" : value}`, "Path=/staging", "HttpOnly", "SameSite=Strict"];
  if (clear) parts.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  else parts.push(`Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function setStagingSessionCookies(res, req, { sessionId, csrfToken, ttlMs, trustProxy = false }) {
  const secure = isSecureRequest(req, { trustProxy });
  const maxAgeSeconds = ttlMs / 1000;
  res.setHeader("Set-Cookie", [
    serializeCookie(STAGING_SESSION_COOKIE, sessionId, { maxAgeSeconds, secure }),
    serializeCookie(STAGING_CSRF_COOKIE, csrfToken, { maxAgeSeconds, secure })
  ]);
}

export function clearStagingSessionCookies(res, req, { trustProxy = false } = {}) {
  const secure = isSecureRequest(req, { trustProxy });
  res.setHeader("Set-Cookie", [
    serializeCookie(STAGING_SESSION_COOKIE, "", { maxAgeSeconds: 0, secure, clear: true }),
    serializeCookie(STAGING_CSRF_COOKIE, "", { maxAgeSeconds: 0, secure, clear: true })
  ]);
}

export function csrfHeader(req) {
  return oneHeader(req?.headers, "x-csrf-token");
}

export function isJsonRequest(req) {
  const value = oneHeader(req?.headers, "content-type");
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}
