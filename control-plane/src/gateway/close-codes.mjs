// P0 Step 5C.4 — stable WebSocket close-code + upgrade-rejection mapping.
//
// Reasons are SAFE machine codes only — never a stack trace, SQL error, credential state, or a
// signal of whether another worker exists. Pre-handshake rejections (before the WS is
// established) are HTTP responses on the raw upgrade socket; post-handshake problems are WS closes.

// Standard codes we use: 1000 normal, 1001 going-away, 1003 unsupported-data, 1008 policy,
// 1009 too-big, 1011 internal, 1013 try-again-later. Private app range: 4000–4999.
export const CLOSE = Object.freeze({
  NORMAL:              { code: 1000, reason: "NORMAL" },
  DRAINING:            { code: 1001, reason: "SERVER_DRAINING" },
  HELLO_TIMEOUT:       { code: 4408, reason: "HELLO_TIMEOUT" },
  MALFORMED_FRAME:     { code: 1003, reason: "MALFORMED_FRAME" },
  MESSAGE_TOO_LARGE:   { code: 1009, reason: "MESSAGE_TOO_LARGE" },
  UNSUPPORTED_VERSION: { code: 4426, reason: "UNSUPPORTED_PROTOCOL_VERSION" },
  IDENTITY_MISMATCH:   { code: 4409, reason: "IDENTITY_MISMATCH" },
  CREDENTIAL_REVOKED:  { code: 4401, reason: "CREDENTIAL_REVOKED" },
  WORKER_DISABLED:     { code: 4403, reason: "WORKER_DISABLED" },
  AUTH_FAILED:         { code: 4401, reason: "AUTH_FAILED" },
  SESSION_SUPERSEDED:  { code: 4410, reason: "SESSION_SUPERSEDED" },
  RATE_LIMITED:        { code: 4429, reason: "RATE_LIMITED" },
  QUEUE_OVERFLOW:      { code: 1013, reason: "QUEUE_OVERFLOW" },
  HEARTBEAT_TIMEOUT:   { code: 4408, reason: "HEARTBEAT_TIMEOUT" },
  BAD_HANDSHAKE:       { code: 4400, reason: "BAD_HANDSHAKE" },
  INTERNAL:            { code: 1011, reason: "INTERNAL_ERROR" }
});

// Pre-handshake upgrade rejection → a minimal safe HTTP response (status + reason token). No body
// details, no headers echoing the request, no credential state.
export function upgradeRejection(reason) {
  const map = {
    E_AUTH_REQUIRED:          { status: 401, code: "AUTH_REQUIRED" },
    E_AUTH_MALFORMED:         { status: 400, code: "AUTH_MALFORMED" },
    E_AUTH_HEADER_TOO_LARGE:  { status: 431, code: "AUTH_HEADER_TOO_LARGE" },
    E_AUTH_MULTIPLE:          { status: 400, code: "AUTH_MULTIPLE" },
    E_AUTH_RATE_LIMITED:      { status: 429, code: "RATE_LIMITED" },
    E_AUTH_NOT_CONFIGURED:    { status: 503, code: "GATEWAY_NOT_READY" },
    E_AUTH_FAILED:            { status: 401, code: "AUTH_FAILED" },
    E_UNKNOWN_PATH:           { status: 404, code: "NOT_FOUND" },
    E_ORIGIN_FORBIDDEN:       { status: 403, code: "ORIGIN_FORBIDDEN" },
    E_GATEWAY_DRAINING:       { status: 503, code: "GATEWAY_DRAINING" },
    E_GATEWAY_DISABLED:       { status: 404, code: "NOT_FOUND" }
  };
  return map[reason] || { status: 400, code: "BAD_REQUEST" };
}

// Write a minimal HTTP rejection to a raw upgrade socket and destroy it (no WS established).
export function rejectUpgrade(socket, reason) {
  const { status, code } = upgradeRejection(reason);
  const line = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 431: "Request Header Fields Too Large", 503: "Service Unavailable" }[status] || "Bad Request";
  try {
    socket.write(
      `HTTP/1.1 ${status} ${line}\r\n` +
      `Connection: close\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(JSON.stringify({ code }))}\r\n` +
      `\r\n` +
      JSON.stringify({ code })
    );
  } catch { /* socket already gone */ }
  try { socket.destroy(); } catch { /* */ }
}
