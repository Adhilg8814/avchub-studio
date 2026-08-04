// P0 Step 5C.29 — platform HTTP handler (Boss Manager API). Serves /api/platform/*. Sits BEHIND the gateway
// PEP (which already authorized the PLATFORM policy — role + MFA + CSRF), but re-derives the actor from the
// session and lets the platform SERVICE re-check authority (defense in depth; also the sole gate in a no-PEP
// dev path). Tenant-owner activation (begin/confirm) is pre-session. No secret is logged; sensitive responses
// (activation otpauth + one-time recovery codes) are no-store. Returns { status, headers, body }.
import { parseSessionCookie, serializeSessionCookie, serializeCsrfCookie, validateOrigin, CSRF_HEADER } from "../auth/http/auth-http.mjs";

const NO_STORE = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const j = (status, body, extra = {}) => ({ status, headers: { ...NO_STORE, ...extra }, body });
const CODE_STATUS = { PLATFORM_FORBIDDEN: 403, PLATFORM_NOT_FOUND: 404, PLATFORM_CUSTOMER_EXISTS: 409, PLATFORM_OWNER_EMAIL_IN_USE: 409, PLATFORM_ACTIVATION_INVALID: 400, PLATFORM_ACTIVATION_CONSUMED: 409, PLATFORM_TOTP_INVALID: 400, PLATFORM_WEAK_PASSWORD: 400, PLATFORM_INVALID: 400 };
const CUST = "cust_[0-9A-HJKMNP-TV-Z]{26}";
const USR = "usr_[0-9A-HJKMNP-TV-Z]{26}";

export function createPlatformHttpHandler({ platformService, authService, config = {}, clock = () => Date.now() } = {}) {
  const allowedOrigins = config.allowedOrigins || [];
  const cookieSecure = config.cookieSecure !== false;

  function handles(method, path) { return typeof path === "string" && path.startsWith("/api/platform/"); }

  // Resolve the platform ACTOR from the session cookie; mutations also re-verify Origin + CSRF (double-submit).
  async function actorFor(headers, method) {
    const cookie = parseSessionCookie(headers.cookie || headers.Cookie);
    if (!cookie.token) return { ok: false, res: j(401, { ok: false, error: "unauthenticated" }) };
    const r = await authService.resolveSession({ sessionToken: cookie.token });
    if (!r.ok) return { ok: false, res: j(401, { ok: false, error: "unauthenticated" }) };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const org = validateOrigin(headers, { allowedOrigins, requireForMutation: true });
      if (!org.ok) return { ok: false, res: j(403, { ok: false, error: "forbidden_origin" }) };
      const csrf = headers[CSRF_HEADER] || headers[CSRF_HEADER.toLowerCase()] || "";
      if (!csrf || !r.context.csrfHash || (config.hashToken && config.hashToken(csrf) !== r.context.csrfHash)) return { ok: false, res: j(403, { ok: false, error: "csrf" }) };
    }
    return { ok: true, actorUserId: r.context.userId };
  }

  function mapErr(e) {
    const code = e && e.code;
    if (code && CODE_STATUS[code]) return j(CODE_STATUS[code], { ok: false, error: code, message: e.message || code });
    return j(500, { ok: false, error: "server_error" });
  }

  async function handle(norm) {
    const { method, path, headers = {}, body = {}, ip = null } = norm;
    const sub = path.replace(/^\/api\/platform\//, "").split("?")[0];
    try {
      // ----- pre-session activation (the tenant owner sets password + TOTP) -----
      if (sub === "activation/begin" && method === "POST") {
        const out = await platformService.beginActivation({ activationToken: body.token });
        return j(200, { ok: true, email: out.email, otpauthUri: out.otpauthUri });
      }
      if (sub === "activation/confirm" && method === "POST") {
        const out = await platformService.confirmActivation({ activationToken: body.token, password: body.password, totpCode: body.totpCode, ipAddress: ip, userAgent: headers["user-agent"] || null });
        const maxAgeMs = (config.sessionAbsoluteMs || 7 * 86400e3);
        const cookies = [serializeSessionCookie(out.sessionToken, { maxAgeMs, secure: cookieSecure }), serializeCsrfCookie(out.csrfToken, { maxAgeMs, secure: cookieSecure })];
        // recovery codes returned ONCE for the owner to save; workspaceId so the client lands in their workspace.
        return j(200, { ok: true, workspaceId: out.workspaceId, recoveryCodes: out.recoveryCodes }, { "Set-Cookie": cookies });
      }

      // ----- authenticated platform-admin surface -----
      const a = await actorFor(headers, method);
      if (!a.ok) return a.res;
      const actorUserId = a.actorUserId;

      if (sub === "dashboard" && method === "GET") return j(200, { ok: true, ...(await platformService.dashboard({ actorUserId })) });
      if (sub === "customers" && method === "GET") return j(200, { ok: true, customers: await platformService.listCustomers({ actorUserId }) });
      if (sub === "customers" && method === "POST") {
        const out = await platformService.createCustomer({ actorUserId, legalName: body.legalName, workspaceName: body.workspaceName, ownerEmail: body.ownerEmail, plan: body.plan, quota: body.quota || {}, expiresAt: body.expiresAt || null, initialStatus: body.initialStatus || "ACTIVE", dedicatedWorkerMode: body.dedicatedWorkerMode !== false, ipAddress: ip });
        // activationToken plaintext returned ONCE (Platform Owner copies the URL). Never logged/audited.
        return j(201, { ok: true, customerId: out.customerId, workspaceId: out.workspaceId, ownerEmail: out.ownerEmail, activationUrl: out.activationUrl, activationToken: out.activationToken });
      }
      let m = new RegExp(`^customers/(${CUST})$`).exec(sub);
      if (m && method === "GET") return j(200, { ok: true, ...(await platformService.getCustomer({ actorUserId, customerId: m[1] })) });
      m = new RegExp(`^customers/(${CUST})/(suspend|reactivate)$`).exec(sub);
      if (m && method === "POST") { const status = m[2] === "suspend" ? "SUSPENDED" : "ACTIVE"; return j(200, { ok: true, customer: await platformService.setCustomerStatus({ actorUserId, customerId: m[1], status, reason: body.reason || null }) }); }
      m = new RegExp(`^customers/(${CUST})/quota$`).exec(sub);
      if (m && method === "POST") return j(200, { ok: true, customer: await platformService.updateQuota({ actorUserId, customerId: m[1], quota: body.quota || {}, plan: body.plan || null }) });
      if (sub === "audit" && method === "GET") return j(200, { ok: true, audit: await platformService.listAudit({ actorUserId, limit: Number(body.limit) || 100 }) });
      if (sub === "admins" && method === "GET") return j(200, { ok: true, admins: await platformService.listPlatformAdmins({ actorUserId }) });
      if (sub === "admins" && method === "POST") return j(201, { ok: true, admin: await platformService.grantPlatformRole({ actorUserId, targetEmail: body.email, role: body.role }) });
      m = new RegExp(`^admins/(${USR})/revoke$`).exec(sub);
      if (m && method === "POST") return j(200, { ok: true, ...(await platformService.revokePlatformRole({ actorUserId, targetUserId: m[1] })) });

      return j(404, { ok: false, error: "not_found" });
    } catch (e) { return mapErr(e); }
  }

  return Object.freeze({ handles, handle });
}
