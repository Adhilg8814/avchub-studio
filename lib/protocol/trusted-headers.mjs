// Header names the studio gateway stamps on a forwarded request, and the only ones a downstream service
// may trust.
//
// These live in the protocol package because two independent sides depend on the exact strings: the gateway
// that writes them, and every service that reads them. A service that re-derived the names would silently
// stop trusting a header the day one of them changed.
//
// Trust model: every inbound `x-avc-gateway*` header is stripped before forwarding, so a browser can never
// supply one. A request carrying TRUSTED_PROXY_HEADER with the wrong secret is a spoof and is refused; a
// request without it keeps the strict loopback-only rules. The workspace/user/role headers are authentic
// only when they arrive together with a valid proxy secret.

/** Per-installation secret proving the request came through the studio gateway. */
export const TRUSTED_PROXY_HEADER = "x-avc-gateway";

/** PDP-verified workspace id, used to select the workspace-scoped control-plane bundle. */
export const TRUSTED_WORKSPACE_HEADER = "x-avc-gateway-workspace";

/** PDP-verified actor, stamped by the gateway from its own server-side decision. */
export const TRUSTED_USER_HEADER = "x-avc-gateway-user";

/** PDP-verified role for the actor above. */
export const TRUSTED_ROLE_HEADER = "x-avc-gateway-role";

/** Every gateway-stamped header, for the strip-before-forward pass. */
export const TRUSTED_HEADERS = Object.freeze([
  TRUSTED_PROXY_HEADER,
  TRUSTED_WORKSPACE_HEADER,
  TRUSTED_USER_HEADER,
  TRUSTED_ROLE_HEADER
]);
