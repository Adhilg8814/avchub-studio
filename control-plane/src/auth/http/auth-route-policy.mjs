// P0 Step 5C.22 — centralized native-auth route classification (§8). One place decides each route's policy
// so enforcement is never scattered as ad-hoc `if`s. An UNKNOWN Studio API defaults to PROTECTED (fail
// closed) when enforcement is on; WORKER routes never pass through browser-session middleware.

export const ROUTE_POLICY = Object.freeze({
  PUBLIC_AUTH: "PUBLIC_AUTH",       // pre-session auth endpoints (Origin-checked, no cookie)
  AUTHENTICATED: "AUTHENTICATED",   // any live session
  ROLE_PROTECTED: "ROLE_PROTECTED", // requires a role (OWNER/ADMIN)
  STRONG_AUTH: "STRONG_AUTH",       // requires a fresh MFA/re-auth
  MEDIA: "MEDIA",                   // metadata/download/range/capability
  STREAM: "STREAM",                 // WS/SSE
  WORKER: "WORKER",                 // worker/device credential domain — NOT browser session
  PLATFORM: "PLATFORM",             // P0 Step 5C.29: Boss Manager — platform-admin plane (NOT a workspace role)
  PUBLIC: "PUBLIC"                  // health / login assets
});

// Ordered matchers — first match wins. Kept explicit + auditable.
const RULES = [
  // native-auth endpoints — pre-session (Origin-checked, no cookie): login/MFA/recovery/enroll/reset/verify
  // + the one-time owner bootstrap (status/begin/confirm).
  { re: /^\/api\/auth\/(login|mfa\/complete|recovery\/complete|mfa\/enroll\/(begin|confirm)|password\/(forgot|reset)|invitations\/(accept|inspect)|email\/verify|bootstrap\/(status|begin|confirm))$/, policy: ROUTE_POLICY.PUBLIC_AUTH },
  // native-auth endpoints — authenticated (live session; mutations also require CSRF): session/logout/
  // workspace/password/reauth/verify + MFA-replace/disable, recovery status/regenerate, and workspace admin.
  { re: /^\/api\/auth\/(session|me|sessions(\/.*)?|logout(-all|-others)?|workspace\/(switch|role|transfer|users(\/.*)?)|password\/change|reauth\/(begin|password|totp)|email\/verify\/begin|mfa\/(status|disable|replace\/(begin|confirm))|recovery\/(status|regenerate)|security\/events|invitations(\/.*)?)$/, policy: ROUTE_POLICY.AUTHENTICATED },
  // P0 Step 5C.29 platform plane. Tenant-owner ACTIVATION is pre-session (the owner has no session yet) —
  // Origin-checked, no cookie. Everything else under /api/platform/* is the platform-admin surface.
  { re: /^\/api\/platform\/activation\/(begin|confirm)$/, policy: ROUTE_POLICY.PUBLIC_AUTH },
  { re: /^\/api\/platform(\/|$)/, policy: ROUTE_POLICY.PLATFORM },
  // P0 Step 5C.32 — the RELEASE surface lives in the worker namespace but is a BROWSER surface: an
  // operator downloading an installer, not a worker reporting in. It must be classified BEFORE the
  // worker rule below, which would otherwise ALLOW it with the cookie stripped — i.e. hand the bundle
  // to anyone who can reach the URL. ROLE_PROTECTED = live session + OWNER/ADMIN in the target
  // workspace; a MEMBER is refused, because a member cannot create the worker it would install.
  { re: /^\/api\/workers\/releases(\/|$)/, policy: ROUTE_POLICY.ROLE_PROTECTED },
  // worker/device channel — separate trust domain (worker credential, never a browser cookie)
  { re: /^\/api\/(worker|workers|pairing|lease|leases|heartbeat|device|devices)(\/|$)/, policy: ROUTE_POLICY.WORKER },
  { re: /^\/ws(\/|$)|^\/api\/.*\/(ws|socket)$/, policy: ROUTE_POLICY.STREAM },
  { re: /^\/api\/.*\/(events|stream)$|text\/event-stream/, policy: ROUTE_POLICY.STREAM },
  // media (provider-management movie/render media, thumbnails, subtitles, packages)
  { re: /^\/api\/provider-management\/(movies|generations)\/.*\/(media|final-media|thumbnail|subtitles|package)$/, policy: ROUTE_POLICY.MEDIA },
  // health / public
  { re: /^\/api\/provider-management\/ops\/health$|^\/__avc-gateway\/health$/, policy: ROUTE_POLICY.PUBLIC },
  // static auth/UI assets (the login page + its bundle must load WITHOUT a session)
  { re: /^\/auth-assets\/|^\/assets\//, policy: ROUTE_POLICY.PUBLIC },
  // pre-auth document routes (served to an unauthenticated user during the login/bootstrap flow)
  { re: /^\/(login|forgot|reset|verify|accept-invite|mfa|recovery|bootstrap|activate)(\/|$|\?)/, policy: ROUTE_POLICY.PUBLIC },
];

export function classifyRoute(method, path) {
  const p = String(path || "").split("?")[0];
  for (const r of RULES) if (r.re.test(p)) return { policy: r.policy };
  // Any other /api/* under Studio -> PROTECTED (authenticated) by default when enforcement is on.
  if (p.startsWith("/api/")) return { policy: ROUTE_POLICY.AUTHENTICATED };
  // Non-API document routes default to a protected Studio document (redirect to /login when unauthenticated).
  return { policy: ROUTE_POLICY.AUTHENTICATED, document: true };
}

// The subset of /api/auth/* mutations that require a fresh re-auth proof at the SERVICE layer (the HTTP layer
// still routes them; the service enforces the proof). Listed here for policy documentation/tests.
export const STRONG_AUTH_ACTIONS = Object.freeze(["DISABLE_MFA", "REPLACE_TOTP", "REGENERATE_RECOVERY", "TRANSFER_OWNERSHIP", "CHANGE_PASSWORD"]);
