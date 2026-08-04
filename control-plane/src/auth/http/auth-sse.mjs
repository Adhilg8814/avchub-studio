// P0 Step 5C.22 — native-auth SSE enforcement (§2/§3). SSE is NOT WebSocket: authentication failures are
// plain HTTP 401/403 returned BEFORE any text/event-stream header is committed (never a 4401/4403 close
// code). After the stream opens, an immutable auth context is bound; every event is filtered to the
// session's workspace server-side (a client cannot assert a workspace via query/event); a bounded
// revalidation loop closes the stream promptly when the session/membership is revoked, the role is
// downgraded, or the absolute expiry passes. Heartbeats carry no sensitive data. This module is a pure state
// machine (no socket) so it is deterministically testable with a fake clock.

export const SSE_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no" // disable proxy buffering where supported
});

// Authenticate an SSE request BEFORE committing stream headers. Returns { ok, context } or a denial with an
// HTTP status (401 no/revoked/expired session, 403 bad Origin / forbidden). Never a redirect, never a WS code.
export async function authenticateSseRequest(req, { enforcement } = {}) {
  if (!enforcement) throw new TypeError("authenticateSseRequest requires enforcement");
  // Origin must be valid (SSE is fetch/EventSource-initiated); reuse the socket authenticator's Origin+session
  // resolution but MAP its WS close codes to HTTP status for the pre-stream response.
  const r = await enforcement.authenticateSocket({ headers: req.headers || {}, path: req.path || "" });
  if (r.bypassed) return { ok: true, context: null, bypassed: true };
  if (r.ok) return { ok: true, context: r.context };
  const status = r.closeCode === enforcement.wsClose.FORBIDDEN ? 403 : 401;
  return { ok: false, status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } };
}

// A per-connection controller. The caller drives it: filterEvent before sending, tick() to know when to
// revalidate, applyRevalidation() with a fresh resolveSession result, heartbeat() for the keep-alive line.
export function createSseController({ context, sessionToken, revalidateMs = 30_000, absoluteExpiresAtMs = null, clock = () => Date.now() } = {}) {
  if (!context) throw new TypeError("createSseController requires an auth context");
  let lastRevalidate = clock();
  let closed = false;

  return {
    // Only events for THIS session's workspace are ever delivered (server-side ownership filter).
    filterEvent(event) {
      if (closed) return null;
      const ws = event && (event.workspaceId ?? (event.data && event.data.workspaceId));
      if (ws != null && ws !== context.workspaceId) return null; // cross-workspace event -> dropped
      return event;
    },
    // Should the caller re-resolve the session now?
    shouldRevalidate(nowMs = clock()) { return !closed && (nowMs - lastRevalidate) >= revalidateMs; },
    // Feed a fresh AuthService.resolveSession result; returns { close, reason } if the stream must end.
    applyRevalidation(resolveResult, nowMs = clock()) {
      lastRevalidate = nowMs;
      if (!resolveResult || !resolveResult.ok) { closed = true; return { close: true, reason: "SESSION_ENDED" }; }
      const c = resolveResult.context;
      if (c.userId !== context.userId) { closed = true; return { close: true, reason: "IDENTITY_CHANGED" }; }
      if (c.workspaceId !== context.workspaceId) { closed = true; return { close: true, reason: "WORKSPACE_CHANGED" }; }
      if (c.role !== context.role) { closed = true; return { close: true, reason: "ROLE_CHANGED" }; } // fail-closed on downgrade
      return { close: false };
    },
    // Absolute-expiry check independent of revalidation cadence.
    expired(nowMs = clock()) { return absoluteExpiresAtMs != null && nowMs >= absoluteExpiresAtMs; },
    // Keep-alive line — a comment, never any session/user/workspace secret.
    heartbeat() { return ": keep-alive\n\n"; },
    close() { closed = true; },
    get isClosed() { return closed; }
  };
}
