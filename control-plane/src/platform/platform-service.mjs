// P0 Step 5C.29 — Platform service (Boss Manager backend). Owns the platform-plane business logic:
// platform-role resolution (for the PDP), customer onboarding (atomic), owner activation (password + TOTP),
// suspension/expiration, platform-role grants, dashboard + audit. docs/…LOCK.md §2/§5/§6/§7/§11/§12/§R.
//
// It reuses the certified auth primitives (crypto + repos) — it does NOT re-implement password/TOTP/session.
// Onboarding + activation each run in ONE persistence.transaction() (all-or-nothing; no partial customer).
// The platform authority (PLATFORM_OWNER/ADMIN) is resolved SERVER-SIDE via cp_platform_role, NEVER from a
// workspace role or a client assertion.
import { platformRepository as P } from "./platform-repository.mjs";
import { newId } from "../persistence/ids.mjs";
import { DomainError } from "../persistence/domain-errors.mjs";

const PLATFORM_ROLES = new Set(["PLATFORM_OWNER", "PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
// Extends DomainError so the persistence adapter (which re-maps non-DomainError throws inside a transaction)
// passes it through UNCHANGED; we override .code with our platform code (DomainError would otherwise clobber
// an unknown code to E_INVALID_STATE_TRANSITION).
class PlatformError extends DomainError {
  constructor(code, message) { super("E_INVALID_STATE_TRANSITION", message); this.code = code; this.name = "PlatformError"; this.isPlatformError = true; }
}
function perr(code, message) { return new PlatformError(code, message); }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createPlatformService({
  persistence, setAuthContext, config = {}, clock = () => Date.now(), externalOrigin = null,
  repos, crypto
} = {}) {
  if (!persistence || typeof persistence.transaction !== "function") throw new TypeError("platform service requires persistence");
  const { user, workspace, credential, mfa, recovery, session, invitation, security } = repos || {};
  const { hashPassword, validatePasswordPolicy, generateToken, hashToken, verifyTotp, generateTotpSecret, encryptTotpSecret, decryptTotpSecret, otpauthUrl, generateRecoveryCodes, hashRecoveryCode } = crypto || {};
  const now = () => clock();
  const activationTtlMs = config.activationTtlMs || 7 * 86400e3;
  const recoveryCount = config.recoveryCodeCount || 10;
  const tx = (fn) => persistence.transaction(fn);
  const mkToken = () => { const t = generateToken(32); return { token: t, hash: hashToken(t) }; };
  const idle = () => new Date(now() + (config.sessionIdleMs || 12 * 3600e3)).toISOString();
  const absolute = () => new Date(now() + (config.sessionAbsoluteMs || 7 * 86400e3)).toISOString();

  // ---------- platform authority (PDP + guards) ----------
  async function resolvePlatformRole({ userId }) {
    if (!userId) return null;
    return tx(async (c) => P.resolvePlatformRole(c, userId)); // { role, status } | null (ACTIVE only)
  }
  // Authority is resolved in its OWN transaction and throws OUTSIDE any mutation tx — the persistence adapter
  // re-maps non-DomainError throws raised inside a transaction, which would clobber our platform error codes.
  async function requirePlatformAdmin(actorUserId, { needOwner = false } = {}) {
    const r = await tx(async (c) => P.resolvePlatformRole(c, actorUserId));
    if (!r || !PLATFORM_ROLES.has(r.role)) throw perr("PLATFORM_FORBIDDEN", "not a platform admin");
    if (needOwner && r.role !== "PLATFORM_OWNER") throw perr("PLATFORM_FORBIDDEN", "requires PLATFORM_OWNER");
    return r.role;
  }

  // ---------- read surfaces (platform-plane) ----------
  async function dashboard({ actorUserId }) {
    await requirePlatformAdmin(actorUserId);
    return tx(async (c) => ({ totals: await P.totals(c), customers: await P.listCustomers(c), recentAudit: await P.listAudit(c, { limit: 25 }) }));
  }
  async function listCustomers({ actorUserId }) { await requirePlatformAdmin(actorUserId); return tx((c) => P.listCustomers(c)); }
  async function getCustomer({ actorUserId, customerId }) {
    await requirePlatformAdmin(actorUserId);
    return tx(async (c) => {
      const cust = await P.getCustomer(c, customerId); if (!cust) throw perr("PLATFORM_NOT_FOUND", "customer not found");
      return { customer: cust, workspaces: await P.listWorkspacesForCustomer(c, customerId), usage: await P.getUsage(c, { customerId }), audit: await P.listAudit(c, { customerId, limit: 50 }) };
    });
  }
  async function listAudit({ actorUserId, limit }) { await requirePlatformAdmin(actorUserId); return tx((c) => P.listAudit(c, { limit })); }
  async function listPlatformAdmins({ actorUserId }) { await requirePlatformAdmin(actorUserId, { needOwner: true }); return tx((c) => P.listPlatformAdmins(c)); }

  // ---------- platform-role grants (PLATFORM_OWNER only) ----------
  async function grantPlatformRole({ actorUserId, targetEmail, role }) {
    if (!PLATFORM_ROLES.has(role)) throw perr("PLATFORM_INVALID", "invalid platform role");
    const actorRole = await requirePlatformAdmin(actorUserId, { needOwner: true });
    const target = await tx((c) => user.findByNormalizedEmail(c, targetEmail)); if (!target) throw perr("PLATFORM_NOT_FOUND", "user not found");
    return tx(async (c) => {
      const out = await P.grantPlatformRole(c, { userId: target.id, role, grantedBy: actorUserId });
      await P.recordAudit(c, { actorUserId, actorRole, action: "PLATFORM_ROLE_GRANTED", targetType: "user", targetId: target.id, metadata: { role } });
      return out;
    });
  }
  async function revokePlatformRole({ actorUserId, targetUserId }) {
    const actorRole = await requirePlatformAdmin(actorUserId, { needOwner: true });
    if (targetUserId === actorUserId) throw perr("PLATFORM_INVALID", "cannot revoke your own platform role");
    return tx(async (c) => {
      await P.disablePlatformRole(c, { userId: targetUserId });
      await P.recordAudit(c, { actorUserId, actorRole, action: "PLATFORM_ROLE_REVOKED", targetType: "user", targetId: targetUserId });
      return { ok: true };
    });
  }

  // ---------- CUSTOMER ONBOARDING (atomic; §6) ----------
  // Creates customer + workspace + PENDING owner user + OWNER membership + quota + audit + activation token
  // in ONE transaction. Idempotent on retry via the customers.legal_name unique + user-email uniqueness
  // (a duplicate legal_name or an already-ACTIVE owner email is rejected, never half-created). Returns the
  // activation token plaintext ONCE (the caller shows the URL; it is never logged/audited).
  async function createCustomer({ actorUserId, legalName, workspaceName, ownerEmail, plan = "FREE", quota = {}, expiresAt = null, initialStatus = "ACTIVE", dedicatedWorkerMode = true, ipAddress = null }) {
    if (!legalName || String(legalName).trim().length < 2) throw perr("PLATFORM_INVALID", "customer name required");
    if (!workspaceName || String(workspaceName).trim().length < 2) throw perr("PLATFORM_INVALID", "workspace name required");
    if (!ownerEmail || !EMAIL_RE.test(ownerEmail)) throw perr("PLATFORM_INVALID", "valid owner email required");
    if (!["ACTIVE", "SUSPENDED"].includes(initialStatus)) throw perr("PLATFORM_INVALID", "bad initial status");
    const actorRole = await requirePlatformAdmin(actorUserId);
    return tx(async (c) => {
      // reject onboarding an already-ACTIVE identity as a fresh tenant owner (no silent hijack; §L3).
      const existing = await user.findByNormalizedEmail(c, ownerEmail);
      if (existing && existing.status === "ACTIVE") throw perr("PLATFORM_OWNER_EMAIL_IN_USE", "owner email already belongs to an active account");
      let customer;
      try { customer = await P.insertCustomer(c, { legalName: String(legalName).trim(), plan, dedicatedWorkerMode, status: initialStatus, expiresAt, quota }); }
      catch (e) { if (/legal_name/.test(String(e.message))) throw perr("PLATFORM_CUSTOMER_EXISTS", "a customer with this name already exists"); throw e; }
      // owner user: reuse a PENDING one (retry) or create a fresh PENDING identity.
      const owner = existing || await user.createInvitedUser(c, { email: ownerEmail, status: "PENDING" });
      // workspace (createWorkspace sets app.current_workspace to the new id) + OWNER membership.
      const ws = await workspace.createWorkspace(c, { name: String(workspaceName).trim(), ownerUserId: owner.id });
      await workspace.createMembership(c, { workspaceId: ws.id, userId: owner.id, role: "OWNER" });
      await P.linkWorkspaceCustomer(c, { workspaceId: ws.id, customerId: customer.id });
      await P.updateCustomerQuota(c, { id: customer.id, quota });
      // activation invitation (role OWNER — the PLATFORM path is the only OWNER-granting path; §7/§L1).
      const act = mkToken();
      await invitation.createInvitation(c, { workspaceId: ws.id, email: ownerEmail, role: "OWNER", tokenHash: act.hash, expiresAt: new Date(now() + activationTtlMs).toISOString(), invitedBy: actorUserId });
      await P.recordAudit(c, { actorUserId, actorRole, action: "CUSTOMER_CREATED", targetType: "customer", targetId: customer.id, customerId: customer.id, workspaceId: ws.id, metadata: { legalName: customer.legal_name, ownerEmail, plan, initialStatus }, ipAddress });
      const activationUrl = externalOrigin ? `${externalOrigin.replace(/\/$/, "")}/activate?token=${act.token}` : null;
      return { customerId: customer.id, workspaceId: ws.id, ownerUserId: owner.id, activationToken: act.token, activationUrl, ownerEmail };
    });
  }

  // ---------- OWNER ACTIVATION (owner sets password + TOTP; §7). Two steps, single-use token. ----------
  async function beginActivation({ activationToken }) {
    return tx(async (c) => {
      const inv = await invitation.peekInvitation(c, { tokenHash: hashToken(activationToken || ""), nowMs: now() });
      if (!inv) throw perr("PLATFORM_ACTIVATION_INVALID", "invalid or expired activation link");
      const owner = await user.findByNormalizedEmail(c, inv.email); if (!owner) throw perr("PLATFORM_ACTIVATION_INVALID", "activation target missing");
      if (owner.status !== "PENDING") throw perr("PLATFORM_ACTIVATION_CONSUMED", "already activated");
      await setAuthContext(c, { userId: owner.id });
      const secret = generateTotpSecret();
      await mfa.createPendingTotp(c, { userId: owner.id, secretCiphertext: encryptTotpSecret(secret) });
      return { email: inv.email, otpauthUri: otpauthUrl(secret, { account: inv.email }) };
    });
  }
  async function confirmActivation({ activationToken, password, totpCode, ipAddress = null, userAgent = null }) {
    return tx(async (c) => {
      const inv = await invitation.peekInvitation(c, { tokenHash: hashToken(activationToken || ""), nowMs: now() });
      if (!inv) throw perr("PLATFORM_ACTIVATION_INVALID", "invalid or expired activation link");
      const owner = await user.findByNormalizedEmail(c, inv.email); if (!owner) throw perr("PLATFORM_ACTIVATION_INVALID", "activation target missing");
      if (owner.status !== "PENDING") throw perr("PLATFORM_ACTIVATION_CONSUMED", "already activated");
      const pol = validatePasswordPolicy(password || ""); if (!pol.ok) throw perr("PLATFORM_WEAK_PASSWORD", pol.reason || "password too weak");
      await setAuthContext(c, { userId: owner.id });
      const pending = await mfa.loadUsableTotp(c, owner.id, { status: "PENDING" });
      if (!pending) throw perr("PLATFORM_ACTIVATION_INVALID", "begin activation first");
      const secret = decryptTotpSecret(pending.secretCiphertext);
      const totp = verifyTotp(secret, totpCode || "", { nowMs: now(), lastUsedTimestep: pending.lastUsedTimestep ?? null });
      if (!totp.ok) throw perr("PLATFORM_TOTP_INVALID", "invalid authenticator code");
      // atomic activation: password -> TOTP active -> recovery codes -> user ACTIVE -> consume token -> session
      await credential.setPasswordCredential(c, { userId: owner.id, secretHash: await hashPassword(password), params: crypto.ARGON2_PARAMS || {} });
      await mfa.recordTimestepIfNewer(c, { userId: owner.id, methodId: pending.id, timestep: totp.timestep });
      await mfa.activateTotp(c, { userId: owner.id, methodId: pending.id });
      const rc = generateRecoveryCodes(recoveryCount); // { plaintext, hashes } — already hashed
      await recovery.createRecoveryCodeSet(c, { userId: owner.id, batchId: newId("rcb"), hashes: rc.hashes });
      await user.updateStatus(c, owner.id, "ACTIVE");
      await c.query("UPDATE users SET email_verified_at=now() WHERE id=$1 AND email_verified_at IS NULL", [owner.id]);
      await invitation.consumeInvitation(c, { tokenHash: hashToken(activationToken), acceptedUserId: owner.id, nowMs: now() });
      // issue an MFA session bound to the owner's workspace.
      const st = mkToken(), csrf = mkToken();
      await session.createSession(c, { userId: owner.id, tokenHash: st.hash, csrfHash: csrf.hash, activeWorkspaceId: inv.workspaceId, idleExpiresAt: idle(), absoluteExpiresAt: absolute(), mfaAuthenticatedAt: new Date(now()).toISOString(), authStrength: "MFA_TOTP", ipAddress, userAgent });
      if (security) { try { await security.record?.(c, { userId: owner.id, workspaceId: inv.workspaceId, event: "OWNER_ACTIVATED", outcome: "OK" }); } catch {} }
      return { ok: true, sessionToken: st.token, csrfToken: csrf.token, workspaceId: inv.workspaceId, recoveryCodes: rc.plaintext };
    });
  }

  // ---------- lifecycle (suspend / reactivate / quota) ----------
  async function setCustomerStatus({ actorUserId, customerId, status, reason = null }) {
    if (!["ACTIVE", "SUSPENDED", "EXPIRED", "CLOSED"].includes(status)) throw perr("PLATFORM_INVALID", "bad status");
    const actorRole = await requirePlatformAdmin(actorUserId);
    return tx(async (c) => {
      const out = await P.setCustomerStatus(c, { id: customerId, status, reason }); if (!out) throw perr("PLATFORM_NOT_FOUND", "customer not found");
      await P.recordAudit(c, { actorUserId, actorRole, action: status === "ACTIVE" ? "CUSTOMER_REACTIVATED" : `CUSTOMER_${status}`, targetType: "customer", targetId: customerId, customerId, metadata: { reason } });
      return out;
    });
  }
  async function updateQuota({ actorUserId, customerId, quota, plan }) {
    const actorRole = await requirePlatformAdmin(actorUserId);
    return tx(async (c) => {
      const out = await P.updateCustomerQuota(c, { id: customerId, quota, plan }); if (!out) throw perr("PLATFORM_NOT_FOUND", "customer not found");
      await P.recordAudit(c, { actorUserId, actorRole, action: "CUSTOMER_QUOTA_UPDATED", targetType: "customer", targetId: customerId, customerId, metadata: { plan } });
      return out;
    });
  }

  // ---------- idempotent production backfill (§13): existing owner -> PLATFORM_OWNER; existing workspaces -> one customer ----------
  // Cross-workspace reads are impossible under cp_tenant_app (NOBYPASSRLS), so the OPERATOR supplies the known
  // production owner user id + workspace ids (read out-of-band from the deployed DB). Non-RLS writes
  // (customer + platform_admin + audit) run in one plain transaction; each workspace link runs in its own
  // tenantTransaction(wsId) so the FORCE-RLS UPDATE on workspaces passes (app.current_workspace == wsId).
  // Fully idempotent: reuse the existing customer, upsert the platform role, link only still-unlinked ws.
  async function runBackfill({ legalName = "AVC Studio", ownerUserId, workspaceIds = [] } = {}) {
    if (!ownerUserId) return { backfilled: false, reason: "NO_OWNER_USER_ID" };
    const { customerId } = await tx(async (c) => {
      let customer = await P.firstCustomer(c);
      // The GRANDFATHERED existing owner keeps the local shared worker — dedicatedWorkerMode:false so the Phase 7
      // dedicated-worker readiness gate never blocks the owner's existing Story/Movie flow. New customers created
      // via createCustomer default to dedicatedWorkerMode:true (dedicated-per-customer, readiness-gated).
      if (!customer) customer = await P.insertCustomer(c, { legalName, plan: "OWNER", primaryOwnerUserId: ownerUserId, dedicatedWorkerMode: false, status: "ACTIVE" });
      await P.grantPlatformRole(c, { userId: ownerUserId, role: "PLATFORM_OWNER", grantedBy: ownerUserId });
      await P.recordAudit(c, { actorUserId: ownerUserId, actorRole: "SYSTEM", action: "PLATFORM_BACKFILL", targetType: "customer", targetId: customer.id, customerId: customer.id, metadata: { ownerUserId, workspaceIds } });
      return { customerId: customer.id };
    });
    let linked = 0;
    for (const wsId of workspaceIds) {
      try {
        await persistence.tenantTransaction(wsId, async (c) => {
          const r = await c.query("UPDATE workspaces SET customer_id=$2, updated_at=now() WHERE id=$1 AND customer_id IS NULL RETURNING id", [wsId, customerId]);
          if (r.rowCount) linked += 1;
        });
      } catch { /* a non-existent/foreign ws is skipped (idempotent) */ }
    }
    return { backfilled: true, customerId, ownerUserId, workspacesLinked: linked };
  }

  return Object.freeze({
    resolvePlatformRole, dashboard, listCustomers, getCustomer, listAudit, listPlatformAdmins,
    grantPlatformRole, revokePlatformRole, createCustomer, beginActivation, confirmActivation,
    setCustomerStatus, updateQuota, runBackfill, PLATFORM_ROLES
  });
}
