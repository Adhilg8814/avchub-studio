// P0 Step 5C.32 — the authenticated WORKER RELEASE service (browser side).
//
// Sits between the Studio UI and the release registry and answers exactly one question per call:
// "may THIS actor, in THIS workspace, right now, see or fetch THIS release?" Everything the answer
// depends on is resolved server-side:
//
//   * the workspace comes from the PDP decision the gateway stamped — never from a query, body or
//     client header (a client-asserted workspace is the classic cross-tenant download bug);
//   * the role likewise; MEMBER is refused, because a member who cannot create a worker has no reason
//     to be handed the installer for one;
//   * the customer lifecycle is re-checked here, so a suspended tenant cannot keep pulling artifacts
//     after the account was stopped;
//   * the rate limit is DURABLE (the same rate_limit_buckets the pairing service uses), so it survives
//     a restart instead of resetting every deploy.
//
// The audit row records who / which workspace / which version / which SHA / what happened. It records
// no cookie, no session id, no token, and no absolute path.

import { rateLimitRepository } from "../../../control-plane/src/persistence/repositories/pairing-repository.mjs";
import { auditRepository } from "../../../control-plane/src/persistence/repositories/repositories.mjs";
import { RELEASE_ERRORS } from "../../ops/worker-release-registry.mjs";

export const RELEASE_ACCESS_ERRORS = Object.freeze({
  UNAUTHENTICATED: "E_RELEASE_UNAUTHENTICATED",
  FORBIDDEN_ROLE: "E_RELEASE_FORBIDDEN_ROLE",
  CUSTOMER_BLOCKED: "E_RELEASE_CUSTOMER_BLOCKED",
  RATE_LIMITED: "E_RELEASE_RATE_LIMITED",
  UNAVAILABLE: "E_RELEASE_UNAVAILABLE"
});

// Workspace roles allowed to download a worker installer. Deliberately the same set that may CREATE a
// worker: download and pairing are two halves of one operation, so splitting their authorization would
// only create a role that can fetch an installer it can never use.
const DOWNLOAD_ROLES = new Set(["OWNER", "ADMIN"]);

function serr(code, message, details = null) {
  const e = Object.assign(new Error(message || code), { code });
  if (details) e.details = details;
  return e;
}
const WS_RE = /^ws_[0-9A-HJKMNP-TV-Z]{26}$/u;
const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/u;

// Denial categories the UI can act on. A bare error code tells an operator nothing and leaves them
// stuck on a page with a button that does not work; a category plus the workspace it applies to lets
// the UI say what happened and offer the one action that fixes it.
export const RELEASE_DENIAL = Object.freeze({
  CUSTOMER_SUSPENDED: "CUSTOMER_SUSPENDED",
  CUSTOMER_EXPIRED: "CUSTOMER_EXPIRED",
  ROLE_INSUFFICIENT: "ROLE_INSUFFICIENT",
  NO_VERIFIED_SESSION: "NO_VERIFIED_SESSION"
});

export function createWorkerReleaseService({
  registry, persistence = null, tenantGuard = null, logger = null,
  now = () => Date.now(),
  maxDownloadsPerWindow = 30, rateLimitWindowMs = 60 * 60_000
} = {}) {
  if (!registry || typeof registry.openArtifact !== "function") throw new TypeError("worker release service requires the release registry");

  const log = (lvl, event, fields) => { try { logger?.[lvl]?.(event, fields); } catch { /* logging must never block a download */ } };

  // The identity the gateway proved. Anything missing or malformed fails CLOSED — this function never
  // "falls back" to a default workspace, because a default workspace is how a download leaks sideways.
  function requireActor({ workspaceId, userId, role }) {
    if (typeof workspaceId !== "string" || !WS_RE.test(workspaceId)) {
      throw serr(RELEASE_ACCESS_ERRORS.UNAUTHENTICATED, "no verified workspace",
        { denial: RELEASE_DENIAL.NO_VERIFIED_SESSION });
    }
    const canonical = typeof role === "string" ? role.toUpperCase() : null;
    if (!canonical) {
      throw serr(RELEASE_ACCESS_ERRORS.UNAUTHENTICATED, "no verified role", { denial: RELEASE_DENIAL.NO_VERIFIED_SESSION });
    }
    if (!DOWNLOAD_ROLES.has(canonical)) {
      throw serr(RELEASE_ACCESS_ERRORS.FORBIDDEN_ROLE, "role may not manage workers",
        { denial: RELEASE_DENIAL.ROLE_INSUFFICIENT, workspaceId, role: canonical, requiredRoles: [...DOWNLOAD_ROLES] });
    }
    return { workspaceId, userId: typeof userId === "string" && USER_RE.test(userId) ? userId : null, role: canonical };
  }

  // Customer lifecycle. A SUSPENDED/EXPIRED tenant is refused; an UNMANAGED workspace (the existing
  // owner, no linked customer) is a no-op exactly as everywhere else.
  // Commit-then-signal: the refusal is returned as a marker and thrown AFTER the transaction. Throwing a
  // plain Error inside tenantTransaction would be remapped by the adapter (it preserves only DomainError),
  // so the honest "this customer is suspended" would reach the caller as a generic invalid-state error —
  // and a download endpoint that cannot say why it refused is one nobody can operate.
  // What this checks, and — just as importantly — what it does NOT:
  //
  //   BLOCKS  : the customer that owns this workspace is SUSPENDED / CLOSED / EXPIRED.
  //   ALLOWS  : an ACTIVE customer, whatever else is true about it. In particular
  //             `dedicated_worker_mode = false` (the grandfathered production owner) is NOT a blocked
  //             state, and having no dedicated worker bound yet is NOT a blocked state — downloading
  //             the bundle is how you GET a dedicated worker, so requiring one first would be a
  //             chicken-and-egg lock-out.
  //   ALLOWS  : a workspace with no linked customer at all (unmanaged), unchanged from every other
  //             tenant-guard call site.
  //
  // On denial it reports the workspace and the customer status so the UI can say which workspace is
  // suspended and offer to switch — an operator staring at a bare code has no way to act on it.
  async function assertCustomerActive(workspaceId) {
    if (!tenantGuard || !persistence) return { managed: false, customerId: null, customerStatus: null };
    const out = await persistence.tenantTransaction(workspaceId, async (c) => {
      let customer = null;
      try { customer = await tenantGuard.resolveCustomer(c, workspaceId); } catch { customer = null; }
      if (!customer) return { managed: false, customerId: null, customerStatus: null };
      try { tenantGuard.assertLifecycle(customer); }
      catch (e) {
        return {
          __reject: e?.code || "CUSTOMER_BLOCKED",
          customerId: customer.id || null,
          customerStatus: customer.status || null,
          expiresAt: customer.expires_at || null
        };
      }
      return { managed: true, customerId: customer.id || null, customerStatus: customer.status || null };
    });
    if (out && out.__reject) {
      const expired = out.__reject === "E_CUSTOMER_EXPIRED" || out.customerStatus === "EXPIRED";
      throw serr(RELEASE_ACCESS_ERRORS.CUSTOMER_BLOCKED, out.__reject, {
        denial: expired ? RELEASE_DENIAL.CUSTOMER_EXPIRED : RELEASE_DENIAL.CUSTOMER_SUSPENDED,
        workspaceId,
        customerStatus: out.customerStatus,
        expiresAt: out.expiresAt || null,
        // The operator is very likely signed in to the wrong workspace: this is a workspace-scoped
        // refusal, not an account-wide one.
        canSwitchWorkspace: true
      });
    }
    return out;
  }

  async function assertRateLimit(workspaceId, scope) {
    if (!persistence) return { count: 0, limited: false };
    const windowStart = new Date(Math.floor(now() / rateLimitWindowMs) * rateLimitWindowMs).toISOString();
    const count = await persistence.tenantTransaction(workspaceId, (c) =>
      rateLimitRepository.hit(c, workspaceId, `${scope}:${workspaceId}`, windowStart));
    if (count > maxDownloadsPerWindow) throw serr(RELEASE_ACCESS_ERRORS.RATE_LIMITED, "too many release downloads");
    return { count, limited: false };
  }

  // Safe, minimal audit. `metadata` is a fixed shape: no cookie, no session, no token, no path.
  async function audit(workspaceId, { actorId, action, version, sha256, result, byteRange = null, customerId = null }) {
    if (!persistence) return;
    try {
      await persistence.tenantTransaction(workspaceId, (c) => auditRepository.record(c, {
        workspaceId, actorType: "ADMIN", actorId: actorId || null, action,
        targetType: "worker_release", targetId: version,
        metadata: { version, sha256: sha256 || null, result, byteRange, customerId }
      }));
    } catch (e) { log("warn", "RELEASE_AUDIT_FAILED", { action, version, code: e?.code || null }); }
  }

  // ---------------------------------------------------------------- read surfaces
  async function describeCurrent(actorInput) {
    const actor = requireActor(actorInput);
    const tenancy = await assertCustomerActive(actor.workspaceId);
    let current = null, releases = [];
    try { current = registry.current(); } catch (e) { if (e?.code !== RELEASE_ERRORS.NOT_FOUND && e?.code !== RELEASE_ERRORS.INDEX_MISSING) throw e; }
    try { releases = registry.list(); } catch { releases = []; }
    return Object.freeze({
      current,
      releases,
      // WHICH workspace this answer is about. When the last incident happened there was no way to tell
      // from the browser which workspace the request had resolved to, which turned a one-line question
      // into an investigation. The UI now shows it.
      context: Object.freeze({
        workspaceId: actor.workspaceId,
        role: actor.role,
        customerManaged: tenancy.managed === true,
        customerStatus: tenancy.customerStatus || null
      }),
      // What the operator has to be told before running an unsigned installer, carried with the data so
      // the UI cannot forget it.
      advisories: Object.freeze({
        signing: current ? current.signing : null,
        verifyBeforeRunning: true,
        downloadOnlyFromStudio: true,
        cloakBringYourOwn: true,
        bundleContainsNoCredentials: true
      })
    });
  }

  async function describeVersion(actorInput, version) {
    const actor = requireActor(actorInput);
    await assertCustomerActive(actor.workspaceId);
    return registry.describe(version);
  }

  async function readDocument(actorInput, version, name) {
    const actor = requireActor(actorInput);
    await assertCustomerActive(actor.workspaceId);
    return { version, name, content: registry.readDocument(version, name) };
  }

  // ---------------------------------------------------------------- download
  // Returns the verified artifact handle. HEAD takes the same path as GET on purpose: a HEAD that
  // skipped verification would advertise a size and hash for bytes nobody checked.
  async function openDownload(actorInput, version, { head = false, byteRange = null } = {}) {
    const actor = requireActor(actorInput);
    const tenancy = await assertCustomerActive(actor.workspaceId);
    // HEAD is a metadata probe and resume clients issue it constantly; only real GETs consume budget.
    if (!head) await assertRateLimit(actor.workspaceId, "release.download");

    let artifact;
    try {
      artifact = await registry.openArtifact(version);
    } catch (e) {
      await audit(actor.workspaceId, {
        actorId: actor.userId, action: head ? "worker_release.head" : "worker_release.download",
        version, sha256: null, result: e?.code || "ERROR", customerId: tenancy.customerId
      });
      throw e;
    }
    await audit(actor.workspaceId, {
      actorId: actor.userId, action: head ? "worker_release.head" : "worker_release.download",
      version: artifact.version, sha256: artifact.sha256, result: "OK", byteRange, customerId: tenancy.customerId
    });
    log("info", "WORKER_RELEASE_SERVED", {
      workspaceId: actor.workspaceId, version: artifact.version, head, byteRange, sizeBytes: artifact.sizeBytes
    });
    return artifact;
  }

  function health() { return registry.health(); }

  return Object.freeze({ describeCurrent, describeVersion, readDocument, openDownload, health, DOWNLOAD_ROLES: [...DOWNLOAD_ROLES] });
}
