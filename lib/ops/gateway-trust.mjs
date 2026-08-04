// P0 Step 5C.25 — shared trusted-gateway verifier. The studio-gateway stamps a per-installation secret in
// the `x-avc-gateway` header on every request it proxies; the enrollment channel + the new control-plane
// internal authorize endpoint verify it with a CONSTANT-TIME compare so a request is provably "from the
// gateway". The gateway strips + re-stamps this header (buildForwardHeaders), so a browser can never forge
// it. Single shared implementation (mirrors the enrollment channel's proxyStateOf) — the value is NEVER
// logged. NB: possession of the secret only proves "via the trusted gateway", NOT any user identity.

import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export const TRUSTED_PROXY_HEADER = "x-avc-gateway";

// Load the trusted-proxy secret from the file named by WORKER_TRUSTED_PROXY_SECRET_FILE (or an explicit
// path). Returns the trimmed secret, or null if unavailable/too-short (fail-closed at the caller).
export function readTrustedProxySecret(file = process.env.WORKER_TRUSTED_PROXY_SECRET_FILE || null) {
  if (typeof file !== "string" || !file) return null;
  try { const s = readFileSync(file, "utf8").trim(); return s.length >= 32 ? s : null; }
  catch { return null; }
}

// Constant-time compare of the inbound header value to the secret. Returns "valid" | "spoof" | "none":
//  - "none"  : no header present (a direct, non-gateway request)
//  - "valid" : header present and matches the secret
//  - "spoof" : header present but does NOT match (a forgery attempt)
export function gatewayTrustState(headerValue, secret) {
  const h = typeof headerValue === "string" ? headerValue : (Array.isArray(headerValue) ? headerValue[0] : null);
  if (h == null || h === "") return "none";
  if (typeof secret !== "string" || secret.length === 0) return "spoof"; // no secret configured -> never trust
  const a = Buffer.from(h), b = Buffer.from(secret);
  if (a.length !== b.length) return "spoof";
  return timingSafeEqual(a, b) ? "valid" : "spoof";
}

// True ONLY when the request carries the valid gateway secret. Use to gate the internal authorize endpoint
// and (in PEP mode) the enrollment channel's data/media routes so a direct-to-loopback bypass is refused.
export function isFromTrustedGateway(headers, secret) {
  const hv = headers && (headers[TRUSTED_PROXY_HEADER] || headers[TRUSTED_PROXY_HEADER.toUpperCase()]);
  return gatewayTrustState(hv, secret) === "valid";
}
