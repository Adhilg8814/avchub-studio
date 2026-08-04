// P0 Step 5C.21B — AuthService: the server-side login / pre-auth / MFA / session state machine. Provider-
// neutral and HTTP-agnostic: it takes normalized inputs + safe request metadata, returns TYPED PUBLIC
// results (never a cookie, HTTP object, raw body, DB error, hash, token, or TOTP secret), and drives every
// mutation through injected repositories + the crypto core inside one transaction. State machine:
//   START → PASSWORD_VERIFIED → { MFA_ENROLLMENT_REQUIRED | MFA_REQUIRED | SESSION_READY } → SESSION_ISSUED
// Security invariants: generic failure (no account enumeration; a dummy Argon2id verify equalizes the
// no-user timing), NO full session before MFA completes (OWNER/ADMIN must have active TOTP), opaque
// hash-only sessions with idle+absolute expiry + rotation, live role re-resolution (revoked membership or an
// MFA-requiring promotion fails the next resolve), and rate-limit + redacted audit on every branch.

import { normalizeEmail, isPlausibleEmail } from "./auth-errors.mjs";
import { AUTH_CONFIG_DEFAULTS, AUTH_PUBLIC_RESULT as R, roleRequiresMfa } from "./auth-config.mjs";

const REQUIRED_REPOS = ["user", "workspace", "credential", "mfa", "recovery", "session", "preAuth", "reauth", "resetToken", "security"];

export function createAuthService(deps = {}) {
  const {
    persistence, setAuthContext, repos,
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy,
    generateToken, hashToken, verifyTotp, decryptTotpSecret,
    // Checkpoint C (MFA/recovery lifecycle) crypto — optional; the MFA methods throw a clear error if absent.
    generateTotpSecret = null, otpauthUrl = null, encryptTotpSecret = null,
    generateRecoveryCodes = null, hashRecoveryCode = null, matchRecoveryHash = null,
    // Checkpoint D (onboarding) — encrypt the one-time link token for the durable outbox (optional).
    encryptLinkToken = null,
    totpIssuer = "AVC Studio",
    clock = () => Date.now(),
    config = AUTH_CONFIG_DEFAULTS,
    // P0 Step 5C.29 Phase 8 — optional tenant guard (customer lifecycle + max_users). Null -> no enforcement.
    tenantGuard = null,
    workspaceMfaPolicy = () => false,
    logger = null
  } = deps;

  // ---- dependency validation (deterministic tests; no scattered env reads) ----
  if (!persistence || typeof persistence.transaction !== "function") throw new TypeError("AuthService requires persistence.transaction");
  if (typeof setAuthContext !== "function") throw new TypeError("AuthService requires setAuthContext");
  if (!repos || REQUIRED_REPOS.some((k) => !repos[k])) throw new TypeError(`AuthService requires repos: ${REQUIRED_REPOS.join(",")}`);
  for (const fn of ["hashPassword", "verifyPassword", "needsRehash", "validatePasswordPolicy", "generateToken", "hashToken", "verifyTotp", "decryptTotpSecret"]) {
    if (typeof deps[fn] !== "function") throw new TypeError(`AuthService requires ${fn}()`);
  }

  const log = (level, msg, meta) => { try { if (logger && typeof logger[level] === "function") logger[level](msg, meta || {}); } catch { /* logging must never throw */ } };
  const now = () => clock();

  // Dummy Argon2id hash to equalize timing when the user / credential does not exist (computed once).
  let dummyHashP = null;
  const dummyHash = () => (dummyHashP ||= hashPassword("x".repeat(24)));

  const mkToken = (bytes = 32) => { const t = generateToken(bytes); return { token: t, hash: hashToken(t) }; };
  const idle = () => new Date(now() + config.session.idleTimeoutMs);
  const absolute = () => new Date(now() + config.session.absoluteTimeoutMs);

  // Issue an opaque session in the CURRENT transaction (app.current_user must already == user.id). Returns
  // the SESSION_ISSUED public shape with the plaintext token + csrf returned exactly once.
  async function issueSession(client, { user, workspaceId, role, mfa, ip, userAgent, absoluteExpiresAt = null, authStrength = null }) {
    const st = mkToken(32), csrf = mkToken(24);
    const sess = await repos.session.createSession(client, {
      userId: user.id, tokenHash: st.hash, csrfHash: csrf.hash, activeWorkspaceId: workspaceId,
      idleExpiresAt: idle(), absoluteExpiresAt: absoluteExpiresAt || absolute(),
      mfaAuthenticatedAt: mfa ? new Date(now()) : null, ipAddress: ip, userAgent,
      authStrength: authStrength || (mfa ? "MFA_TOTP" : "PASSWORD")
    });
    await repos.user.updateLastLoginMetadata(client, user.id, { ip });
    await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId, event: "SESSION_CREATED", outcome: "SUCCESS", ipAddress: ip, metadata: { mfa: Boolean(mfa) } });
    return { result: R.SESSION_ISSUED, ok: true, sessionToken: st.token, csrfToken: csrf.token, session: { id: sess.id, activeWorkspaceId: workspaceId, role, authenticatedWithMfa: Boolean(mfa), idleExpiresAt: sess.idleExpiresAt, absoluteExpiresAt: sess.absoluteExpiresAt } };
  }

  // ------------------------------------------------------------------ beginLogin
  async function beginLogin({ email, password, requestedWorkspaceId = null, ip = null, userAgent = null, requestId = null } = {}) {
    const norm = normalizeEmail(email);
    return persistence.transaction(async (client) => {
      // 1. rate limit BEFORE any password work
      const rlE = await repos.security.getRateLimitState(client, { identifier: norm, dimension: "EMAIL", ...config.rateLimit.email, nowMs: now() });
      const rlI = ip ? await repos.security.getRateLimitState(client, { identifier: ip, dimension: "IP", ...config.rateLimit.ip, nowMs: now() }) : { limited: false, retryAfterMs: 0 };
      if (rlE.limited || rlI.limited) {
        await repos.security.appendSecurityEvent(client, { event: "LOGIN_RATE_LIMITED", outcome: "DENY", ipAddress: ip, metadata: { dim: rlE.limited ? "EMAIL" : "IP" } });
        return { result: R.RATE_LIMITED, ok: false, retryAfterMs: Math.max(rlE.retryAfterMs, rlI.retryAfterMs) };
      }

      // 2-5. resolve user + verify password (timing-equalized)
      const user = await repos.user.findByNormalizedEmail(client, norm);
      let cred = null;
      if (user) { await setAuthContext(client, { userId: user.id }); cred = await repos.credential.loadPasswordForVerification(client, user.id); }
      const ok = cred ? await verifyPassword(cred.secretHash, password) : (await verifyPassword(await dummyHash(), password), false);

      const genericFail = async (reason) => {
        await repos.security.appendLoginAttempt(client, { identifier: norm, dimension: "EMAIL", outcome: "FAILURE", route: "beginLogin", createdAtMs: now() });
        if (ip) await repos.security.appendLoginAttempt(client, { identifier: ip, dimension: "IP", outcome: "FAILURE", route: "beginLogin", createdAtMs: now() });
        await repos.security.appendSecurityEvent(client, { userId: user ? user.id : null, event: "LOGIN_FAILED", outcome: "FAILURE", ipAddress: ip, metadata: { reason } });
        return { result: R.AUTHENTICATION_FAILED, ok: false };
      };
      if (!user || !cred || !ok) return genericFail(!user ? "NO_USER" : !cred ? "NO_CREDENTIAL" : "BAD_PASSWORD");
      if (user.status !== "ACTIVE") return genericFail(`USER_${user.status}`);

      // rehash-on-login (best-effort; a benign concurrent-login race must NOT fail this login)
      if (needsRehash(cred.secretHash)) {
        try { const nh = await hashPassword(password); await repos.credential.replaceHashIfVersionMatches(client, { userId: user.id, newHash: nh, params: config.argon2Params, expectedVersion: cred.version }); await repos.security.appendSecurityEvent(client, { userId: user.id, event: "PASSWORD_REHASHED", outcome: "INFO" }); }
        catch (e) { if (e && e.code === "AUTH_CREDENTIAL_CONFLICT") log("info", "rehash race (benign)", {}); else throw e; }
      }
      await repos.security.appendSecurityEvent(client, { userId: user.id, event: "PASSWORD_VERIFIED", outcome: "SUCCESS", ipAddress: ip });

      // 7-8. memberships + workspace selection (server-resolved; client role NEVER trusted)
      const memberships = await repos.workspace.listUserMemberships(client, user.id);
      if (!memberships.length) return genericFail("NO_MEMBERSHIP");
      let chosen = requestedWorkspaceId ? (memberships.find((m) => m.workspaceId === requestedWorkspaceId) || null) : null;
      if (!chosen) {
        if (memberships.length === 1) chosen = memberships[0];
        else {
          await repos.security.appendSecurityEvent(client, { userId: user.id, event: "WORKSPACE_SELECTION_REQUIRED", outcome: "INFO", ipAddress: ip });
          return { result: R.WORKSPACE_SELECTION_REQUIRED, ok: false, workspaces: memberships.map((m) => ({ workspaceId: m.workspaceId, role: m.role })) };
        }
      }
      await repos.security.appendLoginAttempt(client, { identifier: norm, dimension: "EMAIL", outcome: "SUCCESS", route: "beginLogin", createdAtMs: now() });

      // 9-10. MFA decision — NEVER issue a session before MFA is satisfied
      const requiresMfa = roleRequiresMfa(chosen.role, { userMfaEnforced: user.mfaEnforced, workspaceRequiresMfa: workspaceMfaPolicy(chosen.workspaceId) });
      const activeTotp = requiresMfa ? await repos.mfa.loadUsableTotp(client, user.id, { status: "ACTIVE" }) : null;
      if (requiresMfa && !activeTotp) {
        const c = mkToken(32);
        await repos.preAuth.createChallenge(client, { userId: user.id, tokenHash: c.hash, purpose: "MFA_ENROLLMENT", loginAttemptId: requestId, intendedWorkspaceId: chosen.workspaceId, expiresAt: new Date(now() + config.preAuthChallengeTtlMs) });
        await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId: chosen.workspaceId, event: "MFA_ENROLLMENT_REQUIRED", outcome: "INFO", ipAddress: ip });
        return { result: R.MFA_ENROLLMENT_REQUIRED, ok: false, challengeToken: c.token, workspaceId: chosen.workspaceId, role: chosen.role };
      }
      if (requiresMfa && activeTotp) {
        const c = mkToken(32);
        await repos.preAuth.createChallenge(client, { userId: user.id, tokenHash: c.hash, purpose: "MFA", loginAttemptId: requestId, intendedWorkspaceId: chosen.workspaceId, expiresAt: new Date(now() + config.preAuthChallengeTtlMs) });
        await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId: chosen.workspaceId, event: "MFA_REQUIRED", outcome: "INFO", ipAddress: ip });
        return { result: R.MFA_REQUIRED, ok: false, challengeToken: c.token, workspaceId: chosen.workspaceId };
      }
      // SESSION_READY → issue now (app.current_user already set)
      return issueSession(client, { user, workspaceId: chosen.workspaceId, role: chosen.role, mfa: false, ip, userAgent });
    });
  }

  // ------------------------------------------------------------- completeMfaLogin (active-TOTP path)
  async function completeMfaLogin({ challengeToken, code, ip = null, userAgent = null, requestId = null } = {}) {
    return persistence.transaction(async (client) => {
      const res = await repos.preAuth.resolveChallenge(client, { tokenHash: hashToken(challengeToken), nowMs: now() });
      if (!res.ok || res.challenge.purpose !== "MFA") return { result: R.AUTHENTICATION_FAILED, ok: false };
      const ch = res.challenge;
      const rl = await repos.security.getRateLimitState(client, { identifier: ch.userId, dimension: "SESSION", ...config.rateLimit.mfa, nowMs: now() });
      if (rl.limited) { await repos.security.appendSecurityEvent(client, { userId: ch.userId, event: "MFA_LOGIN_FAILED", outcome: "DENY", ipAddress: ip, metadata: { reason: "RATE_LIMITED" } }); return { result: R.RATE_LIMITED, ok: false, retryAfterMs: rl.retryAfterMs }; }

      await setAuthContext(client, { userId: ch.userId });
      const user = await repos.user.findById(client, ch.userId);
      if (!user || user.status !== "ACTIVE") return { result: R.AUTHENTICATION_FAILED, ok: false };
      const memberships = await repos.workspace.listUserMemberships(client, user.id);
      const m = memberships.find((x) => x.workspaceId === ch.intendedWorkspaceId);
      if (!m) return { result: R.AUTHENTICATION_FAILED, ok: false }; // membership revoked between begin + complete

      const totp = await repos.mfa.loadUsableTotp(client, user.id, { status: "ACTIVE" });
      if (!totp) return { result: R.AUTHENTICATION_FAILED, ok: false };
      let v;
      try { v = verifyTotp(decryptTotpSecret(totp.secretCiphertext), code, { window: config.mfa.totpWindow, nowMs: now(), lastUsedTimestep: totp.lastUsedTimestep }); }
      catch { v = { ok: false, code: "TOTP_SECRET_INVALID" }; }
      if (!v.ok) {
        await repos.security.appendLoginAttempt(client, { identifier: user.id, dimension: "SESSION", outcome: "FAILURE", route: "mfa", createdAtMs: now() });
        await repos.security.appendSecurityEvent(client, { userId: user.id, event: "MFA_LOGIN_FAILED", outcome: "FAILURE", ipAddress: ip, metadata: { reason: v.code } });
        return { result: R.AUTHENTICATION_FAILED, ok: false };
      }
      // atomic replay guard on the accepted timestep, THEN atomic one-time challenge consume
      if (!(await repos.mfa.recordTimestepIfNewer(client, { userId: user.id, methodId: totp.id, timestep: v.timestep }))) {
        await repos.security.appendSecurityEvent(client, { userId: user.id, event: "MFA_LOGIN_FAILED", outcome: "FAILURE", ipAddress: ip, metadata: { reason: "REPLAY" } });
        return { result: R.AUTHENTICATION_FAILED, ok: false };
      }
      await repos.preAuth.markVerified(client, { challengeId: ch.id, userId: user.id });
      if (!(await repos.preAuth.consumeChallenge(client, { challengeId: ch.id, userId: user.id, requireVerified: true, nowMs: now() }))) return { result: R.AUTHENTICATION_FAILED, ok: false };
      await repos.security.appendLoginAttempt(client, { identifier: user.id, dimension: "SESSION", outcome: "SUCCESS", route: "mfa", createdAtMs: now() });
      await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId: m.workspaceId, event: "MFA_LOGIN_SUCCEEDED", outcome: "SUCCESS", ipAddress: ip });
      return issueSession(client, { user, workspaceId: m.workspaceId, role: m.role, mfa: true, ip, userAgent });
    });
  }

  // ------------------------------------------------------------------ resolveSession (+ optional business fn)
  async function resolveSession({ sessionToken, requestId = null } = {}, businessFn = null) {
    return persistence.transaction(async (client) => {
      const res = await repos.session.resolveActiveSession(client, hashToken(sessionToken), { nowMs: now() });
      if (!res.ok) return { result: res.code === "AUTH_SESSION_EXPIRED" ? R.SESSION_EXPIRED : R.SESSION_REVOKED, ok: false };
      const s = res.session;
      await setAuthContext(client, { userId: s.userId });
      const user = await repos.user.findById(client, s.userId);
      if (!user || user.status !== "ACTIVE") { await repos.session.revokeSession(client, { sessionId: s.id, userId: s.userId, reason: "USER_INACTIVE" }); return { result: R.SESSION_REVOKED, ok: false }; }
      const memberships = await repos.workspace.listUserMemberships(client, s.userId);
      const m = s.activeWorkspaceId ? memberships.find((x) => x.workspaceId === s.activeWorkspaceId) : null;
      if (!m) { await repos.session.revokeSession(client, { sessionId: s.id, userId: s.userId, reason: "MEMBERSHIP_REVOKED" }); return { result: R.SESSION_REVOKED, ok: false }; }
      // a session issued without MFA cannot ride an MFA-requiring (possibly escalated) role
      if (roleRequiresMfa(m.role, { userMfaEnforced: user.mfaEnforced, workspaceRequiresMfa: workspaceMfaPolicy(m.workspaceId) }) && !s.authenticatedWithMfa) {
        return { result: R.REAUTH_REQUIRED, ok: false };
      }
      await setAuthContext(client, { userId: s.userId, workspaceId: s.activeWorkspaceId, role: m.role, requestId });
      await repos.session.touchLastSeen(client, { sessionId: s.id, userId: s.userId, idleExpiresAt: idle(), throttleMs: config.session.touchThrottleMs, nowMs: now() });
      // csrfHash is the STORED double-submit verifier (a hash, never the token) — the HTTP layer compares
      // hashToken(request csrf header) to it, then strips it before any response.
      const context = { userId: s.userId, workspaceId: s.activeWorkspaceId, role: m.role, sessionId: s.id, authenticatedWithMfa: s.authenticatedWithMfa, csrfHash: s.csrfHash || null, requestId };
      const value = businessFn ? await businessFn(client, context) : undefined;
      return { result: R.SESSION_ACTIVE, ok: true, context, value };
    });
  }

  // ---------------------------------------------------------------- describeSession (account menu identity)
  // Read-only identity for the header account menu: the signed-in email, the ACTIVE workspace (id + name +
  // role) and every workspace the user may switch to. Never returns a token, cookie, hash or secret. Kept
  // OUT of resolveSession (which runs on every authenticated request) because it reads a workspace row per
  // membership — this endpoint is called only when the menu is opened.
  async function describeSession({ sessionToken } = {}) {
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken);
      if (!ctx) return { ok: false };
      const workspaces = [];
      for (const m of ctx.memberships || []) {
        let name = null;
        try {
          await setAuthContext(client, { userId: ctx.user.id, workspaceId: m.workspaceId, role: m.role });
          const ws = await repos.workspace.findWorkspaceById(client, m.workspaceId);
          name = ws ? ws.name : null;
        } catch { name = null; }
        workspaces.push({ workspaceId: m.workspaceId, role: m.role, name });
      }
      // restore the ACTIVE workspace context before returning
      await setAuthContext(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, role: ctx.membership ? ctx.membership.role : null });
      return {
        ok: true,
        userId: ctx.user.id,
        email: ctx.user.email,
        activeWorkspaceId: ctx.session.activeWorkspaceId,
        role: ctx.membership ? ctx.membership.role : null,
        authenticatedWithMfa: ctx.session.authenticatedWithMfa === true,
        workspaces
      };
    });
  }

  // ------------------------------------------------------------------ switchWorkspace (rotates the session)
  async function switchWorkspace({ sessionToken, targetWorkspaceId, ip = null, userAgent = null, requestId = null } = {}) {
    return persistence.transaction(async (client) => {
      const res = await repos.session.resolveActiveSession(client, hashToken(sessionToken), { nowMs: now() });
      if (!res.ok) return { result: R.SESSION_REVOKED, ok: false };
      const s = res.session;
      await setAuthContext(client, { userId: s.userId });
      const user = await repos.user.findById(client, s.userId);
      if (!user || user.status !== "ACTIVE") return { result: R.SESSION_REVOKED, ok: false };
      const target = (await repos.workspace.listUserMemberships(client, s.userId)).find((x) => x.workspaceId === targetWorkspaceId);
      if (!target) return { result: R.AUTHENTICATION_FAILED, ok: false }; // not a member — never switch
      if (roleRequiresMfa(target.role, { userMfaEnforced: user.mfaEnforced, workspaceRequiresMfa: workspaceMfaPolicy(target.workspaceId) }) && !s.authenticatedWithMfa) {
        return { result: R.MFA_REQUIRED, ok: false };
      }
      const st = mkToken(32), csrf = mkToken(24);
      const newSess = await repos.session.rotateSession(client, { oldSessionId: s.id, userId: s.userId, newTokenHash: st.hash, newCsrfHash: csrf.hash, activeWorkspaceId: target.workspaceId, idleExpiresAt: idle(), absoluteExpiresAt: new Date(s.absoluteExpiresAt), mfaAuthenticatedAt: s.authenticatedWithMfa ? new Date(now()) : null, ipAddress: ip, userAgent, reason: "WORKSPACE_SWITCH" });
      if (!newSess) return { result: R.SESSION_REVOKED, ok: false }; // lost a concurrent rotation
      await repos.security.appendSecurityEvent(client, { userId: s.userId, workspaceId: target.workspaceId, event: "WORKSPACE_SWITCHED", outcome: "SUCCESS", ipAddress: ip });
      return { result: R.SESSION_ISSUED, ok: true, sessionToken: st.token, csrfToken: csrf.token, session: { id: newSess.id, activeWorkspaceId: target.workspaceId, role: target.role, authenticatedWithMfa: s.authenticatedWithMfa } };
    });
  }

  // ------------------------------------------------------------------ changePassword (authenticated)
  async function changePassword({ sessionToken, currentPassword, newPassword, ip = null, userAgent = null } = {}) {
    return persistence.transaction(async (client) => {
      const res = await repos.session.resolveActiveSession(client, hashToken(sessionToken), { nowMs: now() });
      if (!res.ok) return { result: R.SESSION_REVOKED, ok: false };
      const s = res.session;
      await setAuthContext(client, { userId: s.userId });
      const user = await repos.user.findById(client, s.userId);
      if (!user || user.status !== "ACTIVE") return { result: R.SESSION_REVOKED, ok: false };
      const cred = await repos.credential.loadPasswordForVerification(client, s.userId);
      if (!cred || !(await verifyPassword(cred.secretHash, currentPassword))) {
        await repos.security.appendSecurityEvent(client, { userId: s.userId, event: "PASSWORD_CHANGE_FAILED", outcome: "FAILURE", ipAddress: ip });
        return { result: R.AUTHENTICATION_FAILED, ok: false };
      }
      const pol = validatePasswordPolicy(newPassword);
      if (!pol.ok) return { result: R.PASSWORD_POLICY_VIOLATION, ok: false, code: pol.code };
      const nh = await hashPassword(newPassword);
      await repos.credential.replaceHashIfVersionMatches(client, { userId: s.userId, newHash: nh, params: config.argon2Params, expectedVersion: cred.version });
      await repos.resetToken.revokeAllForUser(client, s.userId);
      await repos.session.revokeAllExceptCurrent(client, { userId: s.userId, keepSessionId: s.id, reason: "PASSWORD_CHANGED" });
      const st = mkToken(32), csrf = mkToken(24);
      const newSess = await repos.session.rotateSession(client, { oldSessionId: s.id, userId: s.userId, newTokenHash: st.hash, newCsrfHash: csrf.hash, activeWorkspaceId: s.activeWorkspaceId, idleExpiresAt: idle(), absoluteExpiresAt: new Date(s.absoluteExpiresAt), mfaAuthenticatedAt: s.authenticatedWithMfa ? new Date(now()) : null, ipAddress: ip, userAgent, reason: "PASSWORD_CHANGED" });
      if (!newSess) return { result: R.SESSION_REVOKED, ok: false };
      await repos.security.appendSecurityEvent(client, { userId: s.userId, event: "PASSWORD_CHANGED", outcome: "SUCCESS", ipAddress: ip });
      return { result: R.SESSION_ISSUED, ok: true, sessionToken: st.token, csrfToken: csrf.token, session: { id: newSess.id, activeWorkspaceId: s.activeWorkspaceId, authenticatedWithMfa: s.authenticatedWithMfa } };
    });
  }

  // ------------------------------------------------------------------ logout / revoke / list
  async function withSession(sessionToken, fn) {
    return persistence.transaction(async (client) => {
      const res = await repos.session.resolveActiveSession(client, hashToken(sessionToken), { nowMs: now() });
      if (!res.ok) return { ok: true, alreadyGone: true };
      await setAuthContext(client, { userId: res.session.userId });
      return fn(client, res.session);
    });
  }
  const logout = ({ sessionToken } = {}) => withSession(sessionToken, async (client, s) => { await repos.session.revokeSession(client, { sessionId: s.id, userId: s.userId, reason: "LOGOUT" }); await repos.security.appendSecurityEvent(client, { userId: s.userId, event: "LOGOUT", outcome: "SUCCESS" }); return { ok: true }; });
  const logoutAll = ({ sessionToken } = {}) => withSession(sessionToken, async (client, s) => { const n = await repos.session.revokeAllSessions(client, s.userId, { reason: "LOGOUT_ALL" }); await repos.security.appendSecurityEvent(client, { userId: s.userId, event: "LOGOUT_ALL", outcome: "SUCCESS", metadata: { revoked: n } }); return { ok: true, revoked: n }; });
  const revokeSession = ({ sessionToken, targetSessionId } = {}) => withSession(sessionToken, async (client, s) => { const done = await repos.session.revokeSession(client, { sessionId: targetSessionId, userId: s.userId, reason: "REVOKED_BY_USER" }); if (done) await repos.security.appendSecurityEvent(client, { userId: s.userId, event: "SESSION_REVOKED", outcome: "SUCCESS", target: targetSessionId }); return { ok: done }; });
  const logoutOthers = ({ sessionToken } = {}) => withSession(sessionToken, async (client, s) => { const n = await repos.session.revokeAllExceptCurrent(client, { userId: s.userId, keepSessionId: s.id, reason: "LOGOUT_OTHERS" }); await repos.security.appendSecurityEvent(client, { userId: s.userId, event: "LOGOUT_OTHERS", outcome: "SUCCESS", metadata: { revoked: n } }); return { ok: true, revoked: n }; });
  const listSessions = ({ sessionToken } = {}) => withSession(sessionToken, async (client, s) => ({ ok: true, sessions: await repos.session.listSafeSessions(client, s.userId, { currentSessionId: s.id }) }));
  const listSecurityEvents = ({ sessionToken, limit } = {}) => withSession(sessionToken, async (client, s) => ({ ok: true, events: await repos.security.listSafeSecurityEvents(client, s.userId, { limit }) }));

  // ============================ Checkpoint C — MFA + recovery lifecycle ============================
  const mfaCryptoReady = [generateTotpSecret, otpauthUrl, encryptTotpSecret, generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash].every((f) => typeof f === "function");
  const requireMfaCrypto = () => { if (!mfaCryptoReady) throw new TypeError("AuthService MFA lifecycle requires generateTotpSecret/otpauthUrl/encryptTotpSecret/generateRecoveryCodes/hashRecoveryCode/matchRecoveryHash"); };

  // Resolve a live session -> { session, user, memberships, membership } under app.current_user, or null.
  async function resolveSessionAndUser(client, sessionToken, { requireActiveMembership = true } = {}) {
    const res = await repos.session.resolveActiveSession(client, hashToken(sessionToken), { nowMs: now() });
    if (!res.ok) return null;
    const s = res.session;
    await setAuthContext(client, { userId: s.userId });
    const user = await repos.user.findById(client, s.userId);
    if (!user || user.status !== "ACTIVE") return null;
    const memberships = await repos.workspace.listUserMemberships(client, s.userId);
    const membership = s.activeWorkspaceId ? memberships.find((m) => m.workspaceId === s.activeWorkspaceId) : null;
    if (requireActiveMembership && !membership) return null;
    return { session: s, user, memberships, membership };
  }

  // Mint recovery codes for a user (assumes app.current_user set). Returns the plaintext (once) + persists hashes.
  async function mintRecoveryCodes(client, userId) {
    const set = generateRecoveryCodes(config.recoveryCodeCount);
    const batchId = mkToken(8).hash.slice(0, 26); // opaque batch id (non-secret)
    await repos.recovery.createRecoveryCodeSet(client, { userId, batchId, hashes: set.hashes });
    return { plaintext: set.plaintext, batchId };
  }

  // Verify a redeemable re-auth proof for a specific action (does NOT consume — caller consumes atomically).
  async function checkReauth(client, { reauthToken, userId, action }) {
    if (!reauthToken) return { ok: false };
    const r = await repos.reauth.resolveProof(client, { tokenHash: hashToken(reauthToken), nowMs: now() });
    if (!r.ok || r.proof.userId !== userId || r.proof.action !== action || !r.proof.verified) return { ok: false };
    return { ok: true, proof: r.proof };
  }

  // ---- begin/confirm TOTP enrollment (login-challenge OR logged-in path) ----
  async function beginTotpEnrollment({ challengeToken = null, sessionToken = null, ip = null, requestId = null } = {}) {
    requireMfaCrypto();
    return persistence.transaction(async (client) => {
      let userId = null, workspaceId = null;
      if (challengeToken) {
        const c = await repos.preAuth.resolveChallenge(client, { tokenHash: hashToken(challengeToken), nowMs: now() });
        if (!c.ok || c.challenge.purpose !== "MFA_ENROLLMENT") return { result: R.AUTHENTICATION_FAILED, ok: false };
        userId = c.challenge.userId; workspaceId = c.challenge.intendedWorkspaceId;
      } else if (sessionToken) {
        const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
        if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
        userId = ctx.user.id; workspaceId = ctx.session.activeWorkspaceId;
        const active = await repos.mfa.loadUsableTotp(client, userId, { status: "ACTIVE" });
        if (active) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "USE_REPLACEMENT" }; // adding when already active -> use replacement flow
      } else return { result: R.AUTHENTICATION_FAILED, ok: false };
      await setAuthContext(client, { userId });
      const user = await repos.user.findById(client, userId);
      if (!user || user.status !== "ACTIVE") return { result: R.AUTHENTICATION_FAILED, ok: false };
      const secret = generateTotpSecret();
      await repos.mfa.createPendingTotp(client, { userId, secretCiphertext: encryptTotpSecret(secret) });
      await repos.security.appendSecurityEvent(client, { userId, workspaceId, event: "MFA_ENROLLMENT_STARTED", outcome: "INFO", ipAddress: ip });
      // otpauth URI carries the secret — returned ONCE to the caller, never logged/stored.
      return { result: R.OK, ok: true, otpauthUri: otpauthUrl(secret, { issuer: totpIssuer, account: user.email }), expiresInMs: config.preAuthChallengeTtlMs, digits: 6, period: 30, algorithm: "SHA1" };
    });
  }

  async function confirmTotpEnrollment({ challengeToken = null, sessionToken = null, code, ip = null, userAgent = null, requestId = null } = {}) {
    requireMfaCrypto();
    return persistence.transaction(async (client) => {
      const viaChallenge = Boolean(challengeToken);
      let userId = null, workspaceId = null, role = null, user = null, challenge = null;
      if (viaChallenge) {
        const c = await repos.preAuth.resolveChallenge(client, { tokenHash: hashToken(challengeToken), nowMs: now() });
        if (!c.ok || c.challenge.purpose !== "MFA_ENROLLMENT") return { result: R.AUTHENTICATION_FAILED, ok: false };
        challenge = c.challenge; userId = challenge.userId; workspaceId = challenge.intendedWorkspaceId;
      } else if (sessionToken) {
        const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
        if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
        userId = ctx.user.id; workspaceId = ctx.session.activeWorkspaceId; user = ctx.user;
      } else return { result: R.AUTHENTICATION_FAILED, ok: false };
      await setAuthContext(client, { userId });
      user = user || await repos.user.findById(client, userId);
      if (!user || user.status !== "ACTIVE") return { result: R.AUTHENTICATION_FAILED, ok: false };
      const pending = await repos.mfa.loadUsableTotp(client, userId, { status: "PENDING" });
      if (!pending) return { result: R.AUTHENTICATION_FAILED, ok: false };
      let v; try { v = verifyTotp(decryptTotpSecret(pending.secretCiphertext), code, { window: config.mfa.totpWindow, nowMs: now(), lastUsedTimestep: pending.lastUsedTimestep }); } catch { v = { ok: false }; }
      if (!v.ok) { await repos.security.appendSecurityEvent(client, { userId, event: "MFA_ENROLLMENT_FAILED", outcome: "FAILURE", ipAddress: ip }); return { result: R.AUTHENTICATION_FAILED, ok: false }; }
      if (!(await repos.mfa.recordTimestepIfNewer(client, { userId, methodId: pending.id, timestep: v.timestep }))) return { result: R.AUTHENTICATION_FAILED, ok: false };
      await repos.mfa.activateTotp(client, { userId, methodId: pending.id });
      const rc = await mintRecoveryCodes(client, userId);
      await repos.security.appendSecurityEvent(client, { userId, workspaceId, event: "MFA_ENROLLMENT_CONFIRMED", outcome: "SUCCESS", ipAddress: ip });
      await repos.security.appendSecurityEvent(client, { userId, event: "RECOVERY_CODES_CREATED", outcome: "INFO", metadata: { count: rc.plaintext.length } });
      if (viaChallenge) {
        // login-time enrollment: consume the challenge + issue the first MFA session
        await repos.preAuth.markVerified(client, { challengeId: challenge.id, userId });
        if (!(await repos.preAuth.consumeChallenge(client, { challengeId: challenge.id, userId, requireVerified: true, nowMs: now() }))) return { result: R.AUTHENTICATION_FAILED, ok: false };
        const memberships = await repos.workspace.listUserMemberships(client, userId);
        const m = memberships.find((x) => x.workspaceId === workspaceId);
        if (!m) return { result: R.AUTHENTICATION_FAILED, ok: false };
        const issued = await issueSession(client, { user, workspaceId: m.workspaceId, role: m.role, mfa: true, ip, userAgent, authStrength: "MFA_TOTP" });
        return { ...issued, recoveryCodes: rc.plaintext };
      }
      return { result: R.OK, ok: true, recoveryCodes: rc.plaintext };
    });
  }

  // ---- recovery-code login (alternative to TOTP at the MFA step) ----
  async function completeRecoveryLogin({ challengeToken, recoveryCode, ip = null, userAgent = null } = {}) {
    requireMfaCrypto();
    return persistence.transaction(async (client) => {
      const res = await repos.preAuth.resolveChallenge(client, { tokenHash: hashToken(challengeToken), nowMs: now() });
      if (!res.ok || res.challenge.purpose !== "MFA") return { result: R.AUTHENTICATION_FAILED, ok: false };
      const ch = res.challenge;
      const rl = await repos.security.getRateLimitState(client, { identifier: ch.userId, dimension: "SESSION", ...config.rateLimit.mfa, nowMs: now() });
      if (rl.limited) return { result: R.RATE_LIMITED, ok: false, retryAfterMs: rl.retryAfterMs };
      await setAuthContext(client, { userId: ch.userId });
      const user = await repos.user.findById(client, ch.userId);
      if (!user || user.status !== "ACTIVE") return { result: R.AUTHENTICATION_FAILED, ok: false };
      const m = (await repos.workspace.listUserMemberships(client, user.id)).find((x) => x.workspaceId === ch.intendedWorkspaceId);
      if (!m) return { result: R.AUTHENTICATION_FAILED, ok: false };
      const matched = matchRecoveryHash(recoveryCode, await repos.recovery.listActiveHashes(client, user.id));
      if (!matched || !(await repos.recovery.consumeRecoveryCode(client, { userId: user.id, codeHash: matched }))) {
        await repos.security.appendLoginAttempt(client, { identifier: user.id, dimension: "SESSION", outcome: "FAILURE", route: "recovery", createdAtMs: now() });
        await repos.security.appendSecurityEvent(client, { userId: user.id, event: "RECOVERY_LOGIN_FAILED", outcome: "FAILURE", ipAddress: ip });
        return { result: R.AUTHENTICATION_FAILED, ok: false };
      }
      await repos.preAuth.markVerified(client, { challengeId: ch.id, userId: user.id });
      if (!(await repos.preAuth.consumeChallenge(client, { challengeId: ch.id, userId: user.id, requireVerified: true, nowMs: now() }))) return { result: R.AUTHENTICATION_FAILED, ok: false };
      await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId: m.workspaceId, event: "RECOVERY_CODE_USED", outcome: "SUCCESS", ipAddress: ip });
      await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId: m.workspaceId, event: "RECOVERY_LOGIN_SUCCEEDED", outcome: "SUCCESS", ipAddress: ip });
      // recovery counts as MFA for session usability but is flagged weaker (sensitive actions still re-auth).
      const issued = await issueSession(client, { user, workspaceId: m.workspaceId, role: m.role, mfa: true, ip, userAgent, authStrength: "MFA_RECOVERY" });
      return { ...issued, authenticatedWithRecoveryCode: true };
    });
  }

  // ---- re-authentication (begin -> complete via password or TOTP) ----
  async function beginReauthentication({ sessionToken, action, method = "PASSWORD", ip = null } = {}) {
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      if (!["PASSWORD", "TOTP"].includes(method)) return { result: R.AUTHENTICATION_FAILED, ok: false };
      const t = mkToken(32);
      await repos.reauth.createProof(client, { userId: ctx.user.id, sessionId: ctx.session.id, tokenHash: t.hash, action: String(action), method, workspaceId: ctx.session.activeWorkspaceId, expiresAt: new Date(now() + config.reauthTtlMs) });
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, event: "MFA_REAUTH_STARTED", outcome: "INFO", ipAddress: ip, metadata: { action: String(action), method } });
      return { result: R.OK, ok: true, reauthToken: t.token, method, expiresInMs: config.reauthTtlMs };
    });
  }

  async function completeReauth(client, { sessionToken, reauthToken, verifyFn, ip }) {
    const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
    if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
    const rl = await repos.security.getRateLimitState(client, { identifier: ctx.user.id, dimension: "SESSION", ...config.rateLimit.mfa, nowMs: now() });
    if (rl.limited) return { result: R.RATE_LIMITED, ok: false, retryAfterMs: rl.retryAfterMs };
    const pr = await repos.reauth.resolveProof(client, { tokenHash: hashToken(reauthToken), nowMs: now() });
    if (!pr.ok || pr.proof.userId !== ctx.user.id) return { result: R.AUTHENTICATION_FAILED, ok: false };
    const ok = await verifyFn(client, ctx.user);
    if (!ok) { await repos.security.appendLoginAttempt(client, { identifier: ctx.user.id, dimension: "SESSION", outcome: "FAILURE", route: "reauth", createdAtMs: now() }); await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, event: "MFA_REAUTH_FAILED", outcome: "FAILURE", ipAddress: ip }); return { result: R.AUTHENTICATION_FAILED, ok: false }; }
    await repos.reauth.markVerified(client, { proofId: pr.proof.id, userId: ctx.user.id });
    await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, event: "MFA_REAUTH_SUCCEEDED", outcome: "SUCCESS", ipAddress: ip, metadata: { action: pr.proof.action } });
    return { result: R.OK, ok: true, reauthToken, action: pr.proof.action };
  }
  const completePasswordReauthentication = ({ sessionToken, reauthToken, password, ip = null } = {}) => persistence.transaction((client) => completeReauth(client, { sessionToken, reauthToken, ip, verifyFn: async (c, user) => { const cred = await repos.credential.loadPasswordForVerification(c, user.id); return Boolean(cred) && verifyPassword(cred.secretHash, password); } }));
  const completeTotpReauthentication = ({ sessionToken, reauthToken, code, ip = null } = {}) => persistence.transaction((client) => completeReauth(client, { sessionToken, reauthToken, ip, verifyFn: async (c, user) => { const totp = await repos.mfa.loadUsableTotp(c, user.id, { status: "ACTIVE" }); if (!totp) return false; let v; try { v = verifyTotp(decryptTotpSecret(totp.secretCiphertext), code, { window: config.mfa.totpWindow, nowMs: now(), lastUsedTimestep: totp.lastUsedTimestep }); } catch { return false; } if (!v.ok) return false; return repos.mfa.recordTimestepIfNewer(c, { userId: user.id, methodId: totp.id, timestep: v.timestep }); } }));

  // ---- sensitive actions (require a verified, action-bound re-auth proof) ----
  async function regenerateRecoveryCodes({ sessionToken, reauthToken, ip = null } = {}) {
    requireMfaCrypto();
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      const chk = await checkReauth(client, { reauthToken, userId: ctx.user.id, action: "REGENERATE_RECOVERY" });
      if (!chk.ok || !(await repos.reauth.consumeProof(client, { proofId: chk.proof.id, userId: ctx.user.id, action: "REGENERATE_RECOVERY", nowMs: now() }))) return { result: R.REAUTH_REQUIRED, ok: false };
      const rc = await mintRecoveryCodes(client, ctx.user.id); // createRecoveryCodeSet revokes the prior set
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, event: "RECOVERY_CODES_REGENERATED", outcome: "SUCCESS", ipAddress: ip, metadata: { count: rc.plaintext.length } });
      return { result: R.OK, ok: true, recoveryCodes: rc.plaintext };
    });
  }

  async function disableTotp({ sessionToken, reauthToken, ip = null } = {}) {
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      const chk = await checkReauth(client, { reauthToken, userId: ctx.user.id, action: "DISABLE_MFA" });
      if (!chk.ok || !(await repos.reauth.consumeProof(client, { proofId: chk.proof.id, userId: ctx.user.id, action: "DISABLE_MFA", nowMs: now() }))) return { result: R.REAUTH_REQUIRED, ok: false };
      await repos.mfa.disableTotp(client, ctx.user.id);
      await repos.recovery.revokeAll(client, ctx.user.id);
      await repos.preAuth.revokeForUser(client, ctx.user.id);
      // OWNER/ADMIN (or any MFA-required role) cannot keep a privileged session without MFA: revoke all
      // sessions so the next login goes back through MFA_ENROLLMENT_REQUIRED.
      const mustMfa = ctx.memberships.some((m) => roleRequiresMfa(m.role, { userMfaEnforced: ctx.user.mfaEnforced, workspaceRequiresMfa: workspaceMfaPolicy(m.workspaceId) }));
      if (mustMfa) await repos.session.revokeAllSessions(client, ctx.user.id, { reason: "MFA_DISABLED" });
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, event: "MFA_DISABLED", outcome: "SUCCESS", ipAddress: ip, metadata: { forcedReenroll: mustMfa } });
      return { result: R.OK, ok: true, reEnrollmentRequired: mustMfa };
    });
  }

  // ---- TOTP replacement: old stays ACTIVE until the new one is confirmed (never lock the owner out) ----
  async function beginTotpReplacement({ sessionToken, reauthToken, ip = null } = {}) {
    requireMfaCrypto();
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      const chk = await checkReauth(client, { reauthToken, userId: ctx.user.id, action: "REPLACE_TOTP" });
      if (!chk.ok) return { result: R.REAUTH_REQUIRED, ok: false };
      // do NOT consume the proof yet — confirm consumes it, so a failed/abandoned replacement is retryable.
      const secret = generateTotpSecret();
      await repos.mfa.createPendingTotp(client, { userId: ctx.user.id, secretCiphertext: encryptTotpSecret(secret), allowWithActive: true }); // ACTIVE method untouched
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, event: "MFA_REPLACEMENT_STARTED", outcome: "INFO", ipAddress: ip });
      return { result: R.OK, ok: true, otpauthUri: otpauthUrl(secret, { issuer: totpIssuer, account: ctx.user.email }), expiresInMs: config.preAuthChallengeTtlMs, digits: 6, period: 30, algorithm: "SHA1" };
    });
  }

  async function confirmTotpReplacement({ sessionToken, reauthToken, code, ip = null } = {}) {
    requireMfaCrypto();
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      const chk = await checkReauth(client, { reauthToken, userId: ctx.user.id, action: "REPLACE_TOTP" });
      if (!chk.ok) return { result: R.REAUTH_REQUIRED, ok: false };
      const pending = await repos.mfa.loadUsableTotp(client, ctx.user.id, { status: "PENDING" });
      if (!pending) return { result: R.AUTHENTICATION_FAILED, ok: false };
      let v; try { v = verifyTotp(decryptTotpSecret(pending.secretCiphertext), code, { window: config.mfa.totpWindow, nowMs: now(), lastUsedTimestep: pending.lastUsedTimestep }); } catch { v = { ok: false }; }
      if (!v.ok || !(await repos.mfa.recordTimestepIfNewer(client, { userId: ctx.user.id, methodId: pending.id, timestep: v.timestep }))) return { result: R.AUTHENTICATION_FAILED, ok: false };
      if (!(await repos.reauth.consumeProof(client, { proofId: chk.proof.id, userId: ctx.user.id, action: "REPLACE_TOTP", nowMs: now() }))) return { result: R.REAUTH_REQUIRED, ok: false };
      // disable ALL non-disabled totp, then activate the new pending -> exactly one active method.
      await client.query("UPDATE user_mfa_methods SET status='DISABLED', disabled_at=now() WHERE user_id=$1 AND kind='totp' AND id<>$2 AND status<>'DISABLED'", [ctx.user.id, pending.id]);
      await repos.mfa.activateTotp(client, { userId: ctx.user.id, methodId: pending.id });
      const rc = await mintRecoveryCodes(client, ctx.user.id);
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, event: "MFA_REPLACED", outcome: "SUCCESS", ipAddress: ip });
      return { result: R.OK, ok: true, recoveryCodes: rc.plaintext };
    });
  }

  const listRecoveryCodeStatus = ({ sessionToken } = {}) => withSession(sessionToken, async (client, s) => ({ ok: true, unusedCount: await repos.recovery.countActive(client, s.userId) }));
  const listMfaStatus = ({ sessionToken } = {}) => withSession(sessionToken, async (client, s) => ({ ok: true, methods: await repos.mfa.listSafeMfaMetadata(client, s.userId) }));

  // ============================ Checkpoint D — invitation / reset / verify / admin ============================
  const dReady = repos.invitation && repos.verifyToken && repos.notification && typeof encryptLinkToken === "function";
  const requireD = () => { if (!dReady) throw new TypeError("AuthService onboarding requires repos.invitation/verifyToken/notification + encryptLinkToken"); };
  const maskEmail = (e) => { const s = String(e || ""); const [u, d] = s.split("@"); return d ? `${u.slice(0, 2)}***@${d}` : "***"; };
  const canAdmin = (role) => role === "OWNER" || role === "ADMIN";
  // Enqueue a durable, transactional notification whose one-time link token is stored ONLY encrypted.
  const enqueueNotification = (client, { kind, email, token, userId, workspaceId, expiresAt, payload = {} }) =>
    repos.notification.enqueue(client, { kind, recipientEmail: email, userId, workspaceId, tokenCiphertext: token ? encryptLinkToken(token) : null, payload, expiresAt });

  async function createInvitation({ sessionToken, email, role, ip = null } = {}) {
    requireD();
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken);
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      if (!canAdmin(ctx.membership.role)) return { result: R.AUTHENTICATION_FAILED, ok: false }; // 403-equivalent
      const canon = role === "OWNER" ? null : role; // OWNER is not invitable directly (use ownership transfer)
      if (!["ADMIN", "MEMBER", "VIEWER"].includes(String(canon))) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "BAD_ROLE" };
      // P0 Step 5C.29 Phase 8 — customer lifecycle + max_users (active members + PENDING invitations). Set the
      // workspace context so the member count is RLS-scoped; on a quota/lifecycle refusal return the category as
      // `reason` (this path surfaces a result object, not a thrown error).
      if (tenantGuard) {
        await setAuthContext(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, role: ctx.membership.role });
        try {
          await tenantGuard.assertCanAddMember(client, { workspaceId: ctx.session.activeWorkspaceId, countMembers: async (c) => {
            const m = Number((await c.query("SELECT count(*)::int n FROM workspace_members")).rows[0].n);
            const p = Number((await c.query("SELECT count(*)::int n FROM user_invitations WHERE workspace_id=$1 AND status='PENDING'", [ctx.session.activeWorkspaceId])).rows[0].n);
            return m + p;
          } });
        } catch (e) { if (e && e.isTenantQuotaError) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: e.code }; throw e; }
      }
      const t = mkToken(32);
      const inv = await repos.invitation.createInvitation(client, { workspaceId: ctx.session.activeWorkspaceId, email, role: canon, tokenHash: t.hash, expiresAt: new Date(now() + config.invitationTtlMs), invitedBy: ctx.user.id });
      await enqueueNotification(client, { kind: "INVITATION", email, token: t.token, userId: null, workspaceId: ctx.session.activeWorkspaceId, expiresAt: new Date(now() + config.invitationTtlMs), payload: { role: canon } });
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, event: "INVITATION_CREATED", outcome: "SUCCESS", ipAddress: ip, actorUserId: ctx.user.id, target: maskEmail(email), metadata: { role: canon } });
      return { result: R.OK, ok: true, invitationId: inv.id };
    });
  }

  async function revokeInvitation({ sessionToken, invitationId, ip = null } = {}) {
    requireD();
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken);
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      if (!canAdmin(ctx.membership.role)) return { result: R.AUTHENTICATION_FAILED, ok: false };
      const done = await repos.invitation.revokeInvitation(client, { invitationId, workspaceId: ctx.session.activeWorkspaceId });
      if (done) await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, event: "INVITATION_REVOKED", outcome: "SUCCESS", ipAddress: ip, target: invitationId });
      return { result: R.OK, ok: done };
    });
  }

  // P0 Step 5C.29 Phase 6 — RESEND a PENDING invitation: rotate its token (old link dies) + re-enqueue the
  // notification. Workspace-scoped: an admin can only resend THIS workspace's invitations.
  async function resendInvitation({ sessionToken, invitationId, ip = null } = {}) {
    requireD();
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken);
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      if (!canAdmin(ctx.membership.role)) return { result: R.AUTHENTICATION_FAILED, ok: false };
      const t = mkToken(32);
      const inv = await repos.invitation.resendInvitation(client, { invitationId, workspaceId: ctx.session.activeWorkspaceId, tokenHash: t.hash, expiresAt: new Date(now() + config.invitationTtlMs) });
      if (!inv) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "NOT_PENDING" };
      await enqueueNotification(client, { kind: "INVITATION", email: inv.email, token: t.token, userId: null, workspaceId: ctx.session.activeWorkspaceId, expiresAt: new Date(now() + config.invitationTtlMs), payload: { role: inv.role } });
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, event: "INVITATION_RESENT", outcome: "SUCCESS", ipAddress: ip, target: invitationId });
      return { result: R.OK, ok: true, invitationId };
    });
  }

  // Non-consuming invitation preview for the accept-invite page: workspace name + role + MASKED email +
  // expiry, or a generic { ok:false } (no enumeration). Does not require a session.
  async function inspectInvitation({ token } = {}) {
    requireD();
    return persistence.transaction(async (client) => {
      const inv = await repos.invitation.peekInvitation(client, { tokenHash: hashToken(String(token || "")), nowMs: now() });
      if (!inv) return { ok: false };
      await setAuthContext(client, { workspaceId: inv.workspaceId });
      const ws = await repos.workspace.findWorkspaceById(client, inv.workspaceId);
      return { ok: true, workspaceName: ws ? ws.name : null, role: inv.role, maskedEmail: maskEmail(inv.email), expiresAt: inv.expiresAt };
    });
  }

  async function acceptInvitation({ token, password, displayName = null, ip = null, userAgent = null } = {}) {
    requireD();
    return persistence.transaction(async (client) => {
      let bind;
      try { bind = await repos.invitation.consumeInvitation(client, { tokenHash: hashToken(token), acceptedUserId: null, nowMs: now() }); }
      catch { return { result: R.AUTHENTICATION_FAILED, ok: false }; }
      // find-or-create the user for the invited email
      let user = await repos.user.findByNormalizedEmail(client, bind.email);
      const isNew = !user;
      if (!user) user = await repos.user.createInvitedUser(client, { email: bind.email, displayName, status: "ACTIVE" });
      await setAuthContext(client, { userId: user.id });
      if (isNew) {
        const pol = validatePasswordPolicy(password);
        if (!pol.ok) return { result: R.PASSWORD_POLICY_VIOLATION, ok: false, code: pol.code };
        await repos.credential.setPasswordCredential(client, { userId: user.id, secretHash: await hashPassword(password), params: config.argon2Params });
        await repos.user.updateEmailVerifiedAt(client, user.id); // invited email is considered verified (owner-controlled invite)
      }
      // bind the accepted user + create the membership (fails closed on duplicate)
      await setAuthContext(client, { workspaceId: bind.workspaceId });
      try { await repos.workspace.createMembership(client, { workspaceId: bind.workspaceId, userId: user.id, role: bind.role }); }
      catch (e) { if (e && e.code !== "AUTH_MEMBERSHIP_EXISTS") throw e; }
      await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId: bind.workspaceId, event: "INVITATION_ACCEPTED", outcome: "SUCCESS", ipAddress: ip, metadata: { role: bind.role, newUser: isNew } });
      await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId: bind.workspaceId, event: "MEMBERSHIP_CREATED", outcome: "SUCCESS", metadata: { role: bind.role } });
      // ADMIN (or MFA-required) invitees must enroll MFA before a session; others get a session now.
      await setAuthContext(client, { userId: user.id });
      const requiresMfa = roleRequiresMfa(bind.role, { userMfaEnforced: user.mfaEnforced, workspaceRequiresMfa: workspaceMfaPolicy(bind.workspaceId) });
      if (requiresMfa) {
        const c = mkToken(32);
        await repos.preAuth.createChallenge(client, { userId: user.id, tokenHash: c.hash, purpose: "MFA_ENROLLMENT", intendedWorkspaceId: bind.workspaceId, expiresAt: new Date(now() + config.preAuthChallengeTtlMs) });
        return { result: R.MFA_ENROLLMENT_REQUIRED, ok: false, challengeToken: c.token, workspaceId: bind.workspaceId, role: bind.role };
      }
      return issueSession(client, { user, workspaceId: bind.workspaceId, role: bind.role, mfa: false, ip, userAgent });
    });
  }

  // ---- password reset (generic; token via encrypted outbox) ----
  async function beginForgotPassword({ email, ip = null } = {}) {
    requireD();
    const norm = normalizeEmail(email);
    return persistence.transaction(async (client) => {
      const rl = await repos.security.getRateLimitState(client, { identifier: norm, dimension: "EMAIL", ...config.rateLimit.email, nowMs: now() });
      if (rl.limited) return { result: R.RATE_LIMITED, ok: false, retryAfterMs: rl.retryAfterMs };
      const user = await repos.user.findByNormalizedEmail(client, norm);
      if (user && user.status === "ACTIVE") {
        const t = mkToken(32);
        await setAuthContext(client, { userId: user.id });
        await repos.resetToken.createResetToken(client, { userId: user.id, tokenHash: t.hash, expiresAt: new Date(now() + config.passwordResetTtlMs) });
        await enqueueNotification(client, { kind: "PASSWORD_RESET", email: norm, token: t.token, userId: user.id, expiresAt: new Date(now() + config.passwordResetTtlMs) });
        await repos.security.appendSecurityEvent(client, { userId: user.id, event: "PASSWORD_RESET_REQUESTED", outcome: "INFO", ipAddress: ip });
      }
      return { result: R.OK, ok: true }; // ALWAYS generic (no account enumeration), token delivered only if eligible
    });
  }

  async function completePasswordReset({ token, newPassword, ip = null } = {}) {
    requireD();
    return persistence.transaction(async (client) => {
      let res;
      try { res = await repos.resetToken.consumeResetToken(client, { tokenHash: hashToken(token), nowMs: now() }); }
      catch { return { result: R.AUTHENTICATION_FAILED, ok: false }; }
      await setAuthContext(client, { userId: res.userId });
      const user = await repos.user.findById(client, res.userId);
      if (!user || user.status !== "ACTIVE") return { result: R.AUTHENTICATION_FAILED, ok: false };
      const pol = validatePasswordPolicy(newPassword);
      if (!pol.ok) return { result: R.PASSWORD_POLICY_VIOLATION, ok: false, code: pol.code };
      const cur = await repos.credential.getPasswordMetadata(client, user.id);
      await repos.credential.setPasswordCredential(client, { userId: user.id, secretHash: await hashPassword(newPassword), params: config.argon2Params });
      await repos.resetToken.revokeAllForUser(client, user.id);
      await repos.session.revokeAllSessions(client, user.id, { reason: "PASSWORD_RESET" });
      await repos.preAuth.revokeForUser(client, user.id);
      await repos.reauth.revokeForUser(client, user.id);
      await enqueueNotification(client, { kind: "SECURITY_NOTICE", email: user.email, token: null, userId: user.id, payload: { event: "PASSWORD_RESET" } });
      await repos.security.appendSecurityEvent(client, { userId: user.id, event: "PASSWORD_RESET_COMPLETED", outcome: "SUCCESS", ipAddress: ip, metadata: { fromVersion: cur ? cur.version : null } });
      return { result: R.OK, ok: true };
    });
  }

  // ---- email verification ----
  async function beginEmailVerification({ sessionToken, ip = null } = {}) {
    requireD();
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      const t = mkToken(32);
      await repos.verifyToken.invalidateForUser(client, ctx.user.id);
      await repos.verifyToken.createVerifyToken(client, { userId: ctx.user.id, email: ctx.user.email, tokenHash: t.hash, expiresAt: new Date(now() + config.emailVerifyTtlMs) });
      await enqueueNotification(client, { kind: "EMAIL_VERIFICATION", email: ctx.user.email, token: t.token, userId: ctx.user.id, expiresAt: new Date(now() + config.emailVerifyTtlMs) });
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, event: "EMAIL_VERIFICATION_REQUESTED", outcome: "INFO", ipAddress: ip });
      return { result: R.OK, ok: true };
    });
  }

  async function completeEmailVerification({ token, ip = null } = {}) {
    requireD();
    return persistence.transaction(async (client) => {
      let res;
      try { res = await repos.verifyToken.consumeVerifyToken(client, { tokenHash: hashToken(token), nowMs: now() }); }
      catch { return { result: R.AUTHENTICATION_FAILED, ok: false }; }
      await setAuthContext(client, { userId: res.userId });
      const user = await repos.user.findById(client, res.userId);
      if (!user) return { result: R.AUTHENTICATION_FAILED, ok: false };
      // bind: the token's email must still match the user's current email (an email change invalidates it)
      if (normalizeEmail(user.email) !== normalizeEmail(res.email)) return { result: R.AUTHENTICATION_FAILED, ok: false };
      await repos.user.updateEmailVerifiedAt(client, user.id);
      await repos.security.appendSecurityEvent(client, { userId: user.id, event: "EMAIL_VERIFIED", outcome: "SUCCESS", ipAddress: ip });
      return { result: R.OK, ok: true };
    });
  }

  // ---- user / membership administration ----
  async function adminOp(sessionToken, fn) {
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken);
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      if (!canAdmin(ctx.membership.role)) return { result: R.AUTHENTICATION_FAILED, ok: false };
      // admin ops touch workspace_members (workspace-RLS) — set the full trusted context.
      await setAuthContext(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, role: ctx.membership.role });
      return fn(client, ctx);
    });
  }
  const listWorkspaceUsersSafe = ({ sessionToken } = {}) => adminOp(sessionToken, async (client, ctx) => {
    const rows = await client.query("SELECT wm.user_id, wm.role, wm.status FROM workspace_members wm WHERE wm.workspace_id=$1", [ctx.session.activeWorkspaceId]);
    const ids = rows.rows.map((r) => r.user_id);
    const users = await repos.user.listSafeUserMetadata(client, ids);
    const metaById = new Map(rows.rows.map((r) => [r.user_id, { role: r.role, status: r.status }]));
    const invitations = await repos.invitation.listInvitations(client, ctx.session.activeWorkspaceId);
    return { ok: true, users: users.map((u) => ({ ...u, role: (metaById.get(u.id) || {}).role || null, membershipStatus: (metaById.get(u.id) || {}).status || null })), invitations };
  });
  // P0 Step 5C.29 Phase 6 — suspend / reactivate a membership (workspace-scoped). Suspension is enforced by the
  // access-path membership resolver (0034 ACTIVE-only), so a suspended member fails closed on switch + every
  // request WITHOUT killing the user's sessions in OTHER workspaces. Never suspend the last active owner.
  const setMemberStatus = (status) => ({ sessionToken, targetUserId, ip = null } = {}) => adminOp(sessionToken, async (client, ctx) => {
    if (targetUserId === ctx.user.id) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "SELF" };
    try {
      const m = await repos.workspace.setMembershipStatus(client, { workspaceId: ctx.session.activeWorkspaceId, userId: targetUserId, status });
      await repos.security.appendSecurityEvent(client, { userId: targetUserId, workspaceId: ctx.session.activeWorkspaceId, event: status === "SUSPENDED" ? "MEMBERSHIP_SUSPENDED" : "MEMBERSHIP_REACTIVATED", outcome: "SUCCESS", actorUserId: ctx.user.id, ipAddress: ip });
      return { result: R.OK, ok: true, status: m.status };
    } catch (e) {
      if (e.code === "AUTH_LAST_OWNER") { await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, event: "LAST_OWNER_ACTION_REJECTED", outcome: "DENY", ipAddress: ip }); return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "LAST_OWNER" }; }
      if (e.code === "AUTH_MEMBERSHIP_NOT_FOUND") return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "NOT_MEMBER" };
      throw e;
    }
  });
  const suspendWorkspaceMember = setMemberStatus("SUSPENDED");
  const reactivateWorkspaceMember = setMemberStatus("ACTIVE");
  const listWorkspaceInvitations = ({ sessionToken } = {}) => adminOp(sessionToken, async (client, ctx) => ({ ok: true, invitations: await repos.invitation.listInvitations(client, ctx.session.activeWorkspaceId) }));
  const updateWorkspaceRole = ({ sessionToken, targetUserId, role, ip = null } = {}) => adminOp(sessionToken, async (client, ctx) => {
    try {
      const m = await repos.workspace.updateMembershipRole(client, { workspaceId: ctx.session.activeWorkspaceId, userId: targetUserId, role });
      await repos.session.adminRevokeAllSessions(client, targetUserId, { reason: "ROLE_CHANGED" }); // old role must not persist
      await repos.security.appendSecurityEvent(client, { userId: targetUserId, workspaceId: ctx.session.activeWorkspaceId, event: "MEMBERSHIP_ROLE_CHANGED", outcome: "SUCCESS", actorUserId: ctx.user.id, ipAddress: ip, metadata: { role: m.role } });
      return { result: R.OK, ok: true, role: m.role };
    } catch (e) { if (e.code === "AUTH_LAST_OWNER") { await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, event: "LAST_OWNER_ACTION_REJECTED", outcome: "DENY", ipAddress: ip }); return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "LAST_OWNER" }; } if (e.code === "AUTH_MEMBERSHIP_NOT_FOUND") return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "NOT_MEMBER" }; throw e; }
  });
  const revokeWorkspaceMembership = ({ sessionToken, targetUserId, ip = null } = {}) => adminOp(sessionToken, async (client, ctx) => {
    try {
      await repos.workspace.revokeMembership(client, { workspaceId: ctx.session.activeWorkspaceId, userId: targetUserId });
      await repos.session.adminRevokeAllSessions(client, targetUserId, { reason: "MEMBERSHIP_REVOKED" });
      await repos.security.appendSecurityEvent(client, { userId: targetUserId, workspaceId: ctx.session.activeWorkspaceId, event: "MEMBERSHIP_REVOKED", outcome: "SUCCESS", actorUserId: ctx.user.id, ipAddress: ip });
      return { result: R.OK, ok: true };
    } catch (e) { if (e.code === "AUTH_LAST_OWNER") { await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, event: "LAST_OWNER_ACTION_REJECTED", outcome: "DENY", ipAddress: ip }); return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "LAST_OWNER" }; } if (e.code === "AUTH_MEMBERSHIP_NOT_FOUND") return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "NOT_MEMBER" }; throw e; }
  });
  const disableUser = ({ sessionToken, targetUserId, ip = null } = {}) => adminOp(sessionToken, async (client, ctx) => {
    if (targetUserId === ctx.user.id) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "SELF" };
    await repos.user.updateStatus(client, targetUserId, "DISABLED");
    await repos.session.adminRevokeAllSessions(client, targetUserId, { reason: "USER_DISABLED" });
    await repos.preAuth.revokeForUser(client, targetUserId);
    await repos.security.appendSecurityEvent(client, { userId: targetUserId, workspaceId: ctx.session.activeWorkspaceId, event: "USER_DISABLED", outcome: "SUCCESS", actorUserId: ctx.user.id, ipAddress: ip });
    return { result: R.OK, ok: true };
  });
  const enableUser = ({ sessionToken, targetUserId, ip = null } = {}) => adminOp(sessionToken, async (client, ctx) => {
    await repos.user.updateStatus(client, targetUserId, "ACTIVE");
    await repos.security.appendSecurityEvent(client, { userId: targetUserId, workspaceId: ctx.session.activeWorkspaceId, event: "USER_ENABLED", outcome: "SUCCESS", actorUserId: ctx.user.id, ipAddress: ip });
    return { result: R.OK, ok: true };
  });
  async function transferWorkspaceOwnership({ sessionToken, reauthToken, targetUserId, ip = null } = {}) {
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken);
      if (!ctx) return { result: R.SESSION_REVOKED, ok: false };
      if (ctx.membership.role !== "OWNER") return { result: R.AUTHENTICATION_FAILED, ok: false };
      const chk = await checkReauth(client, { reauthToken, userId: ctx.user.id, action: "TRANSFER_OWNERSHIP" });
      if (!chk.ok || !(await repos.reauth.consumeProof(client, { proofId: chk.proof.id, userId: ctx.user.id, action: "TRANSFER_OWNERSHIP", nowMs: now() }))) return { result: R.REAUTH_REQUIRED, ok: false };
      await setAuthContext(client, { workspaceId: ctx.session.activeWorkspaceId });
      try { await repos.workspace.transferOwnership(client, { workspaceId: ctx.session.activeWorkspaceId, fromUserId: ctx.user.id, toUserId: targetUserId }); }
      catch (e) { if (e.code === "AUTH_MEMBERSHIP_NOT_FOUND") return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "TARGET_NOT_MEMBER" }; throw e; }
      await repos.session.adminRevokeAllSessions(client, targetUserId, { reason: "OWNERSHIP_TRANSFERRED" });
      await repos.security.appendSecurityEvent(client, { userId: ctx.user.id, workspaceId: ctx.session.activeWorkspaceId, event: "OWNERSHIP_TRANSFERRED", outcome: "SUCCESS", actorUserId: ctx.user.id, target: targetUserId, ipAddress: ip });
      return { result: R.OK, ok: true };
    });
  }

  // ==================== Owner bootstrap (one-time first-owner ceremony; 0030) ====================
  // Distinct from every other flow: it creates the FIRST owner from zero identity. Invariants (§14–16):
  // no privileged session before MFA is confirmed; the owner + workspace + credential + MFA + recovery +
  // session are created in ONE atomic transaction (any failure rolls back — never a partial owner); a
  // SELECT ... FOR UPDATE on the singleton serializes concurrent confirms to exactly one winner; the
  // ceremony proof is revoked and every transient candidate secret cleared on completion; the route is
  // permanently closed once an owner exists.
  const bootstrapReady = Boolean(repos.bootstrap) && mfaCryptoReady;
  const requireBootstrap = () => { if (!bootstrapReady) throw new TypeError("AuthService bootstrap requires repos.bootstrap + MFA/recovery crypto"); };

  async function bootstrapStatus() {
    requireBootstrap();
    return persistence.transaction(async (client) => {
      const ownerExists = await repos.bootstrap.ownerExists(client);
      const st = await repos.bootstrap.readState(client);
      const state = ownerExists ? "COMPLETED" : (st ? st.state : "REQUIRED");
      // "available" = the ceremony can still be started/completed (REQUIRED or an in-flight IN_PROGRESS);
      // once an owner exists (COMPLETED) it is permanently closed.
      return { ok: true, result: R.OK, state, available: !ownerExists && state !== "COMPLETED" };
    });
  }

  async function beginOwnerBootstrap({ email, password, displayName = null, bootstrapProof = null, requireProof = false, ip = null } = {}) {
    requireBootstrap();
    const norm = normalizeEmail(email);
    if (!isPlausibleEmail(norm)) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "BAD_EMAIL" };
    return persistence.transaction(async (client) => {
      if (await repos.bootstrap.ownerExists(client)) return { result: "BOOTSTRAP_UNAVAILABLE", ok: false, reason: "ALREADY_BOOTSTRAPPED" };
      const pol = validatePasswordPolicy(password);
      if (!pol.ok) return { result: R.PASSWORD_POLICY_VIOLATION, ok: false, code: pol.code };
      // operator authorization proof (one-time) resolved BEFORE the claim so a proof failure returns a typed
      // result cleanly — no throw-to-rollback (the persistence adapter remaps a thrown Error, losing it).
      if (requireProof && !bootstrapProof) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "PROOF_REQUIRED" };
      if (bootstrapProof) {
        const consumed = await repos.bootstrapToken.consumeBootstrapToken(client, { tokenHash: hashToken(String(bootstrapProof)), nowMs: now() });
        if (!consumed) return { result: R.AUTHENTICATION_FAILED, ok: false, reason: "BAD_PROOF" };
      }
      const secret = generateTotpSecret();
      const passwordHash = await hashPassword(password);
      const proof = mkToken(32);
      // atomic single-winner claim (REQUIRED -> IN_PROGRESS, or restart an EXPIRED prior attempt).
      const claimed = await repos.bootstrap.claim(client, {
        candidateEmail: norm, candidateDisplayName: displayName,
        candidatePasswordHash: passwordHash, candidateTotpCiphertext: encryptTotpSecret(secret),
        ceremonyProofHash: proof.hash, proofExpiresAt: new Date(now() + config.preAuthChallengeTtlMs),
        claimedIp: ip, nowMs: now()
      });
      if (!claimed) return { result: "BOOTSTRAP_CONFLICT", ok: false, reason: "CEREMONY_IN_PROGRESS" };
      await repos.security.appendSecurityEvent(client, { userId: null, event: "OWNER_BOOTSTRAP_STARTED", outcome: "INFO", ipAddress: ip, target: maskEmail(norm) });
      // the otpauth URI carries the secret — returned ONCE, never logged/stored in plaintext.
      return { result: "OWNER_BOOTSTRAP_STARTED", ok: true, ceremonyToken: proof.token, otpauthUri: otpauthUrl(secret, { issuer: totpIssuer, account: norm }), digits: 6, period: 30, algorithm: "SHA1", expiresInMs: config.preAuthChallengeTtlMs };
    });
  }

  async function confirmOwnerBootstrap({ ceremonyToken, code, ip = null, userAgent = null, workspaceName = "AVC Studio" } = {}) {
    requireBootstrap();
    return persistence.transaction(async (client) => {
      const row = await repos.bootstrap.lockForConfirm(client); // FOR UPDATE — serializes confirms (one winner)
      if (!row || row.state !== "IN_PROGRESS") return { result: "BOOTSTRAP_UNAVAILABLE", ok: false };
      if (await repos.bootstrap.ownerExists(client)) return { result: "BOOTSTRAP_UNAVAILABLE", ok: false };
      if (!row.ceremonyProofHash || row.ceremonyProofHash !== hashToken(String(ceremonyToken || "")) || (row.proofExpiresAt && row.proofExpiresAt.getTime() < now())) return { result: R.AUTHENTICATION_FAILED, ok: false };
      let v; try { v = verifyTotp(decryptTotpSecret(row.candidateTotpCiphertext), code, { window: config.mfa.totpWindow, nowMs: now(), lastUsedTimestep: null }); } catch { v = { ok: false }; }
      if (!v.ok) { await repos.security.appendSecurityEvent(client, { userId: null, event: "OWNER_BOOTSTRAP_FAILED", outcome: "FAILURE", ipAddress: ip }); return { result: R.AUTHENTICATION_FAILED, ok: false }; }
      // ---- winner path: build the owner atomically. Any throw rolls back the WHOLE tx -> no partial owner. ----
      const user = await repos.user.createBootstrapOwner(client, { email: row.candidateEmail, displayName: row.candidateDisplayName });
      await setAuthContext(client, { userId: user.id });
      await repos.credential.setPasswordCredential(client, { userId: user.id, secretHash: row.candidatePasswordHash, params: config.argon2Params });
      const ws = await repos.workspace.createWorkspace(client, { name: workspaceName, ownerUserId: user.id }); // sets app.current_workspace
      await repos.workspace.createMembership(client, { workspaceId: ws.id, userId: user.id, role: "OWNER" });
      const pending = await repos.mfa.createPendingTotp(client, { userId: user.id, secretCiphertext: row.candidateTotpCiphertext, allowWithActive: true });
      await repos.mfa.recordTimestepIfNewer(client, { userId: user.id, methodId: pending.id, timestep: v.timestep });
      await repos.mfa.activateTotp(client, { userId: user.id, methodId: pending.id });
      const rc = await mintRecoveryCodes(client, user.id);
      await repos.bootstrap.complete(client, { ownerUserId: user.id }); // revoke ceremony proof + clear candidate secrets
      await repos.security.appendSecurityEvent(client, { userId: user.id, workspaceId: ws.id, event: "OWNER_BOOTSTRAP_COMPLETED", outcome: "SUCCESS", ipAddress: ip });
      const issued = await issueSession(client, { user, workspaceId: ws.id, role: "OWNER", mfa: true, ip, userAgent, authStrength: "MFA_TOTP" });
      return { ...issued, recoveryCodes: rc.plaintext, workspaceId: ws.id };
    });
  }

  // P0 Step 5C.25 — Gateway-PEP authorization resolve. Resolves a live session AND the user's canonical role
  // in a TARGET workspace (which may differ from the session's active workspace — e.g. the native owner
  // accessing the runtime's data workspace). Returns ONLY safe, non-secret decision metadata (never a token/
  // hash/secret). The internal /internal/native-auth/authorize endpoint calls this; it never trusts a
  // client-asserted role/workspace — the role comes from the persisted membership resolved server-side.
  async function resolveAuthorization({ sessionToken, targetWorkspaceId = null } = {}) {
    return persistence.transaction(async (client) => {
      const ctx = await resolveSessionAndUser(client, sessionToken, { requireActiveMembership: false });
      if (!ctx) return { ok: false, result: R.SESSION_REVOKED };
      const memberships = ctx.memberships || [];
      const activeWs = ctx.session.activeWorkspaceId || null;
      const target = targetWorkspaceId || activeWs;
      const m = target ? memberships.find((x) => x.workspaceId === target) : null;
      return {
        ok: true,
        userId: ctx.user.id,
        sessionId: ctx.session.id,
        activeWorkspaceId: activeWs,
        targetWorkspaceId: target,
        // canonical role in the TARGET workspace (null => the user is NOT a member of it)
        roleInTarget: m ? m.role : null,
        isMemberOfTarget: Boolean(m),
        // P0 Step 5C.29 §Q1: read the server-resolved strength state that resolveActiveSession now surfaces.
        // authenticatedWithMfa is the definer-derived boolean (Boolean(mfa_authenticated_at)); it is NEVER a
        // client-controlled value. authStrength distinguishes MFA_TOTP vs MFA_RECOVERY for step-up policy.
        authStrength: ctx.session.authStrength || null,
        authenticatedWithMfa: ctx.session.authenticatedWithMfa === true,
        workspaceIds: memberships.map((x) => x.workspaceId)
      };
    });
  }

  return Object.freeze({
    beginLogin, completeMfaLogin, resolveSession, describeSession, switchWorkspace, changePassword,
    logout, logoutAll, logoutOthers, revokeSession, listSessions, listSecurityEvents,
    // Checkpoint C
    beginTotpEnrollment, confirmTotpEnrollment, completeRecoveryLogin,
    beginReauthentication, completePasswordReauthentication, completeTotpReauthentication,
    regenerateRecoveryCodes, disableTotp, beginTotpReplacement, confirmTotpReplacement,
    listRecoveryCodeStatus, listMfaStatus,
    // Checkpoint D
    createInvitation, revokeInvitation, resendInvitation, listWorkspaceInvitations, acceptInvitation, inspectInvitation,
    beginForgotPassword, completePasswordReset, beginEmailVerification, completeEmailVerification,
    listWorkspaceUsersSafe, updateWorkspaceRole, revokeWorkspaceMembership, suspendWorkspaceMember, reactivateWorkspaceMember, disableUser, enableUser, transferWorkspaceOwnership,
    // P0 Step 5C.23 — owner bootstrap
    bootstrapStatus, beginOwnerBootstrap, confirmOwnerBootstrap,
    resolveAuthorization,
    _config: config
  });
}
