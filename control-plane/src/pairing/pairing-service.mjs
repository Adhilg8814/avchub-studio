// P0 Step 5C.5 — pairing + credential lifecycle service (transactions + orchestration).
//
// Composes the pairing repository, crypto, and durable idempotency/rate-limit tables into the
// operator + worker flows. All mutations run inside ONE tenant transaction so a failure leaves no
// half state. NO plaintext pairing code or Worker credential is ever persisted or logged — only
// peppered HMAC verifiers are stored; the plaintext is returned to the caller EXACTLY ONCE.
//
// IMPORTANT: business rejections are NOT thrown inside tenantTransaction. The adapter's catch
// preserves only DomainError and remaps everything else via mapPgError, so a ControlPlaneError
// thrown inside a txn would be mangled to E_INTERNAL AND would roll back durable side effects we
// want to keep (e.g. the failed-attempt increment). Instead each callback COMMITS its decision and
// returns a REJECT marker; the service throws the ControlPlaneError AFTER the txn (see safeReoffer
// in transactions/ownership.mjs for the same pattern). Skew rule: expiry/now use DB now().

import { createHash } from "node:crypto";
import { ControlPlaneError, CP_ERRORS } from "../errors.mjs";
import { createAuthRateLimiter } from "../gateway/gateway-auth.mjs";
import {
  generatePairingCode, normalizePairingCode, pairingCodeVerifier,
  generateWorkerCredential, credentialVerifier, constantTimeEqualHex
} from "./pairing-crypto.mjs";
import {
  lookupPairingByVerifier, pairingCodeRepository, pairedWorkerRepository,
  workerCredentialRepository, idempotencyRepository, rateLimitRepository
} from "../persistence/repositories/pairing-repository.mjs";
import { auditRepository } from "../persistence/repositories/repositories.mjs";

const REJECT = (code, message) => ({ __reject: { code, message } });
function settle(out) {
  if (out && out.__reject) throw new ControlPlaneError(out.__reject.code, out.__reject.message);
  return out;
}
function sha256Hex(obj) { return createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }
function windowStartIso(nowMs, windowMs) { return new Date(Math.floor(nowMs / windowMs) * windowMs).toISOString(); }
function clamp(n, min, max, def) { const x = Number.isInteger(n) ? n : def; return Math.max(min, Math.min(max, x)); }
function safeLabel(s, fallback) {
  if (typeof s !== "string") return fallback;
  const t = s.trim().slice(0, 128);
  return t.length ? t : fallback;
}

// createPairingService(deps): the injected `disconnectWorker(workspaceId, workerId, reason)` closes
// any live Gateway socket + fences the session AFTER a credential/worker authority change commits.
// It is a no-op when the Gateway is disabled/absent (pairing does not require a running Gateway).
export function createPairingService({ config, persistence, logger, now = () => Date.now(), disconnectWorker = null } = {}) {
  const pcfg = config.pairing;
  const pairingPepper = pcfg.pairingPepper;
  const credentialPepper = config.security.credentialPepper;
  // Per-remote in-memory claim limiter (pre-workspace-resolution abuse bound). Durable per-remote
  // limiting is impossible before the workspace resolves under RLS; the durable defenses are the
  // per-code attempt counter + short TTL + 60-bit code entropy.
  const claimLimiter = createAuthRateLimiter({ windowMs: pcfg.rateLimitWindowMs, maxPerWindow: pcfg.maxClaimsPerWindow, now });

  function requirePeppers() {
    // Defensive: config.mjs already fails startup if pairing.enabled without both peppers.
    if (!pairingPepper) throw new ControlPlaneError(CP_ERRORS.E_CONFIG_INVALID, "pairing pepper not configured");
    if (!credentialPepper) throw new ControlPlaneError(CP_ERRORS.E_CONFIG_INVALID, "credential pepper not configured");
  }
  async function dbNowMs(client) {
    const r = await client.query("SELECT now() AS now");
    return new Date(r.rows[0].now).getTime();
  }
  async function afterAuthorityChange(workspaceId, workerId, reason) {
    if (typeof disconnectWorker !== "function") return;
    try { await disconnectWorker(workspaceId, workerId, reason); }
    catch { logger?.warn?.("pairing_disconnect_failed", { component: "pairing", reasonCode: "DISCONNECT_FAILED" }); }
  }

  // ---------------------------------------------------------------- operator: issue a pairing code
  async function issueCode({ workspaceId, actorId, requestedLabel = null, capabilities = null, ttlMs = null, maxAttempts = null, idempotencyKey = null }) {
    requirePeppers();
    const effTtl = clamp(ttlMs, 60000, pcfg.maxCodeTtlMs, pcfg.codeTtlMs);
    const effMaxAttempts = clamp(maxAttempts, 1, 20, pcfg.maxFailedAttempts);
    const label = requestedLabel == null ? null : safeLabel(requestedLabel, null);
    const requestHash = sha256Hex({ v: 1, label, capabilities: capabilities ?? null, ttl: effTtl });

    return settle(await persistence.tenantTransaction(workspaceId, async (client) => {
      if (idempotencyKey) {
        const claim = await idempotencyRepository.claim(client, workspaceId, { scope: "pairing.issue", key: idempotencyKey, requestHash });
        if (!claim.fresh) {
          if (!claim.row || claim.row.request_hash !== requestHash) return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT, "Idempotency key reused with different parameters");
          if (claim.row.status === "COMPLETED" && claim.row.response) return { replayed: true, pairingCodeId: claim.row.response.pairingCodeId, expiresAt: claim.row.response.expiresAt, workspaceId };
          return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT, "Idempotent request already in progress");
        }
      }
      const nowMs = await dbNowMs(client);
      // Durable per-workspace issuance rate limit. The bucket key includes the workspace id because
      // rate_limit_buckets is UNIQUE(bucket_key, window_start) — a shared key would collide across
      // workspaces and the ON CONFLICT row would be RLS-invisible under another workspace.
      const count = await rateLimitRepository.hit(client, workspaceId, `pairing.issue:${workspaceId}`, windowStartIso(nowMs, pcfg.rateLimitWindowMs));
      if (count > pcfg.maxIssuePerWindow) return REJECT(CP_ERRORS.E_PAIRING_RATE_LIMITED, "Pairing issuance rate limit exceeded");
      const active = await pairingCodeRepository.countActive(client, workspaceId);
      if (active >= pcfg.maxActiveCodesPerWorkspace) return REJECT(CP_ERRORS.E_PAIRING_RATE_LIMITED, "Too many active pairing codes");

      const { code, normalized } = generatePairingCode();
      const codeHash = pairingCodeVerifier(pairingPepper, normalized);
      const expiresAt = new Date(nowMs + effTtl).toISOString();
      const row = await pairingCodeRepository.insert(client, workspaceId, {
        codeHash, expiresAt, requestedLabel: label, capabilities, createdByActor: actorId, maxAttempts: effMaxAttempts
      });
      if (idempotencyKey) await idempotencyRepository.complete(client, workspaceId, { scope: "pairing.issue", key: idempotencyKey, response: { pairingCodeId: row.id, expiresAt } });
      await auditRepository.record(client, {
        workspaceId, actorType: "ADMIN", actorId, action: "pairing_code.issue",
        targetType: "pairing_code", targetId: row.id, metadata: { requestedLabel: label, expiresAt }
      });
      // The plaintext `code` is returned to the operator ONCE — never stored/logged.
      return { replayed: false, pairingCode: code, pairingCodeId: row.id, expiresAt, workspaceId };
    }));
  }

  // ---------------------------------------------------------------- worker: claim a pairing code
  async function claimCode({ code, installationId = null, requestedWorkerName = null, platform = "unknown", osVersion = null, architecture = null, workerVersion = null, protocolVersion = 1, capabilities = null, remoteKey = null }) {
    requirePeppers();
    if (!pcfg.enabled) throw new ControlPlaneError(CP_ERRORS.E_PAIRING_DISABLED, "Pairing is not enabled");

    const allowed = claimLimiter.check(remoteKey);
    claimLimiter.record(remoteKey);
    if (!allowed) throw new ControlPlaneError(CP_ERRORS.E_PAIRING_RATE_LIMITED, "Too many pairing attempts");

    const normalized = normalizePairingCode(code);
    if (!normalized) throw new ControlPlaneError(CP_ERRORS.E_PAIRING_INVALID, "Invalid pairing code");   // generic
    const verifier = pairingCodeVerifier(pairingPepper, normalized);

    // Resolve the workspace by verifier on the BYPASSRLS ops connection (READ ONLY).
    const found = await persistence.opsEnumerate((c) => lookupPairingByVerifier(c, verifier));
    if (!found) throw new ControlPlaneError(CP_ERRORS.E_PAIRING_INVALID, "Invalid pairing code");         // generic

    const pv = Number.isInteger(protocolVersion) ? protocolVersion : 1;
    return settle(await persistence.tenantTransaction(found.workspace_id, async (client) => {
      const nowMs = await dbNowMs(client);
      const codeRow = await pairingCodeRepository.lock(client, found.workspace_id, found.id);   // FOR UPDATE
      // Re-validate under the lock: any non-ACTIVE state → generic invalid (never distinguishes).
      if (!codeRow || codeRow.status !== "ACTIVE") return REJECT(CP_ERRORS.E_PAIRING_INVALID, "Invalid pairing code");
      if (!constantTimeEqualHex(codeRow.code_hash, verifier)) {
        await pairingCodeRepository.recordFailedAttempt(client, found.workspace_id, codeRow.id);  // committed
        return REJECT(CP_ERRORS.E_PAIRING_INVALID, "Invalid pairing code");
      }
      if (new Date(codeRow.expires_at).getTime() <= nowMs) {
        await pairingCodeRepository.recordFailedAttempt(client, found.workspace_id, codeRow.id);  // committed
        return REJECT(CP_ERRORS.E_PAIRING_INVALID, "Invalid pairing code");
      }

      const name = safeLabel(requestedWorkerName, safeLabel(codeRow.requested_label, `worker-${String(found.id).slice(-6)}`));
      const worker = await pairedWorkerRepository.create(client, found.workspace_id, {
        name, platform: safeLabel(platform, "unknown"), osVersion: osVersion ? String(osVersion).slice(0, 128) : null,
        architecture: architecture ? String(architecture).slice(0, 64) : null,
        workerVersion: workerVersion ? String(workerVersion).slice(0, 64) : null,
        protocolVersion: pv, installationId: installationId ? String(installationId).slice(0, 128) : null
      });

      const credential = generateWorkerCredential();
      const credHash = credentialVerifier(credentialPepper, credential);
      const credentialExpiresAt = new Date(nowMs + pcfg.credentialTtlMs).toISOString();
      const credRow = await workerCredentialRepository.insertActive(client, found.workspace_id, {
        workerId: worker.id, credentialHash: credHash, expiresAt: credentialExpiresAt
      });

      // Consume the code (guarded ACTIVE→CONSUMED). The FOR UPDATE lock serialized racing claims,
      // so this always succeeds here; a null return means a concurrent consume slipped in.
      const consumed = await pairingCodeRepository.consume(client, found.workspace_id, codeRow.id, worker.id);
      if (!consumed) return REJECT(CP_ERRORS.E_PAIRING_INVALID, "Invalid pairing code");

      await auditRepository.record(client, {
        workspaceId: found.workspace_id, actorType: "WORKER", actorId: worker.id, action: "worker.paired",
        targetType: "pairing_code", targetId: codeRow.id, metadata: { platform: worker.platform, protocolVersion: pv }
      });
      return { workerId: worker.id, workspaceId: found.workspace_id, credential, credentialId: credRow.id, credentialExpiresAt };
    }));
  }

  // ---------------------------------------------------------------- operator: rotate credential
  async function rotateCredential({ workspaceId, workerId, actorId, idempotencyKey = null }) {
    requirePeppers();
    const requestHash = sha256Hex({ v: 1, workerId });
    const out = settle(await persistence.tenantTransaction(workspaceId, async (client) => {
      if (idempotencyKey) {
        const claim = await idempotencyRepository.claim(client, workspaceId, { scope: "credential.rotate", key: idempotencyKey, requestHash });
        if (!claim.fresh) {
          if (!claim.row || claim.row.request_hash !== requestHash) return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT, "Idempotency key reused with different parameters");
          if (claim.row.status === "COMPLETED" && claim.row.response) return { replayed: true, credentialId: claim.row.response.credentialId, expiresAt: claim.row.response.expiresAt };
          return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT, "Idempotent request already in progress");
        }
      }
      const nowMs = await dbNowMs(client);
      const worker = await pairedWorkerRepository.lock(client, workspaceId, workerId);
      if (!worker) return REJECT(CP_ERRORS.E_NOT_FOUND, "Worker not found");
      if (worker.status === "REVOKED") return REJECT(CP_ERRORS.E_WORKER_DISABLED, "Worker is disabled; re-enable before rotating");

      const oldActive = await workerCredentialRepository.revokeActive(client, workspaceId, workerId, "rotated");
      const credential = generateWorkerCredential();
      const credHash = credentialVerifier(credentialPepper, credential);
      const expiresAt = new Date(nowMs + pcfg.credentialTtlMs).toISOString();
      const credRow = await workerCredentialRepository.insertActive(client, workspaceId, {
        workerId, credentialHash: credHash, expiresAt, rotatedFromCredentialId: oldActive ? oldActive.id : null
      });
      if (idempotencyKey) await idempotencyRepository.complete(client, workspaceId, { scope: "credential.rotate", key: idempotencyKey, response: { credentialId: credRow.id, expiresAt } });
      await auditRepository.record(client, {
        workspaceId, actorType: "ADMIN", actorId, action: "credential.rotate",
        targetType: "worker", targetId: workerId, metadata: { rotatedFrom: oldActive ? oldActive.id : null }
      });
      return { replayed: false, credentialId: credRow.id, credential, expiresAt, rotatedFrom: oldActive ? oldActive.id : null };
    }));
    // Drop any live socket so the worker re-authenticates with the NEW credential (old is revoked).
    if (!out.replayed) await afterAuthorityChange(workspaceId, workerId, "CREDENTIAL_REVOKED");
    return out;
  }

  // ---------------------------------------------------------------- operator: revoke credential
  async function revokeCredential({ workspaceId, workerId, credentialId = null, actorId, reason = null }) {
    const out = settle(await persistence.tenantTransaction(workspaceId, async (client) => {
      const worker = await pairedWorkerRepository.lock(client, workspaceId, workerId);
      if (!worker) return REJECT(CP_ERRORS.E_NOT_FOUND, "Worker not found");
      const revoked = credentialId
        ? await workerCredentialRepository.revokeById(client, workspaceId, credentialId, reason || "revoked")
        : await workerCredentialRepository.revokeActive(client, workspaceId, workerId, reason || "revoked");
      await auditRepository.record(client, {
        workspaceId, actorType: "ADMIN", actorId, action: "credential.revoke",
        targetType: "worker", targetId: workerId, metadata: { credentialId: revoked ? revoked.id : null }
      });
      return { revokedCredentialId: revoked ? revoked.id : null };
    }));
    await afterAuthorityChange(workspaceId, workerId, "CREDENTIAL_REVOKED");
    return out;
  }

  // ---------------------------------------------------------------- operator: disable / enable worker
  async function disableWorker({ workspaceId, workerId, actorId, reason = null }) {
    const out = settle(await persistence.tenantTransaction(workspaceId, async (client) => {
      const worker = await pairedWorkerRepository.lock(client, workspaceId, workerId);
      if (!worker) return REJECT(CP_ERRORS.E_NOT_FOUND, "Worker not found");
      const disabled = await pairedWorkerRepository.disable(client, workspaceId, workerId, reason ? String(reason).slice(0, 256) : null);
      // Disabling revokes the active credential too — a disabled worker retains NO authority.
      const revoked = await workerCredentialRepository.revokeActive(client, workspaceId, workerId, "worker_disabled");
      await auditRepository.record(client, {
        workspaceId, actorType: "ADMIN", actorId, action: "worker.disable",
        targetType: "worker", targetId: workerId, metadata: { revokedCredentialId: revoked ? revoked.id : null, alreadyDisabled: !disabled }
      });
      return { workerId, status: "REVOKED" };
    }));
    await afterAuthorityChange(workspaceId, workerId, "WORKER_DISABLED");
    return out;
  }

  async function enableWorker({ workspaceId, workerId, actorId }) {
    return settle(await persistence.tenantTransaction(workspaceId, async (client) => {
      const worker = await pairedWorkerRepository.lock(client, workspaceId, workerId);
      if (!worker) return REJECT(CP_ERRORS.E_NOT_FOUND, "Worker not found");
      const enabled = await pairedWorkerRepository.enable(client, workspaceId, workerId);
      await auditRepository.record(client, {
        workspaceId, actorType: "ADMIN", actorId, action: "worker.enable",
        targetType: "worker", targetId: workerId, metadata: { changed: Boolean(enabled) }
      });
      // Enabling restores identity but NOT authority — the operator must rotate to issue a fresh
      // credential (the prior credential was revoked at disable time).
      return { workerId, status: "OFFLINE", requiresRotation: true };
    }));
  }

  // ---------------------------------------------------------------- operator: read models
  async function getWorkers({ workspaceId }) {
    return persistence.tenantTransaction(workspaceId, (client) => pairedWorkerRepository.list(client, workspaceId));
  }
  async function getWorker({ workspaceId, workerId }) {
    return settle(await persistence.tenantTransaction(workspaceId, async (client) => {
      const worker = await pairedWorkerRepository.get(client, workspaceId, workerId);
      if (!worker) return REJECT(CP_ERRORS.E_NOT_FOUND, "Worker not found");
      const active = await workerCredentialRepository.getActive(client, workspaceId, workerId);
      return {
        worker: {
          id: worker.id, name: worker.name, platform: worker.platform, status: worker.status,
          protocolVersion: worker.protocol_version, installationId: worker.installation_id,
          pairedAt: worker.paired_at, firstSeenAt: worker.first_seen_at, lastSeenAt: worker.last_seen_at,
          disabledAt: worker.disabled_at, disableReason: worker.disable_reason
        },
        activeCredentialId: active ? active.id : null, activeCredentialExpiresAt: active ? active.expires_at : null
      };
    }));
  }
  async function getPairingCode({ workspaceId, codeId }) {
    return settle(await persistence.tenantTransaction(workspaceId, async (client) => {
      const row = await pairingCodeRepository.getById(client, workspaceId, codeId);
      if (!row) return REJECT(CP_ERRORS.E_NOT_FOUND, "Pairing code not found");
      // Safe projection — never the code_hash/verifier.
      return {
        id: row.id, status: row.status, purpose: row.purpose, requestedLabel: row.requested_label,
        expiresAt: row.expires_at, attempts: row.attempts, maxAttempts: row.max_attempts,
        usedByWorkerId: row.used_by_worker_id, createdAt: row.created_at
      };
    }));
  }
  async function listPairingCodes({ workspaceId }) {
    return persistence.tenantTransaction(workspaceId, (client) => pairingCodeRepository.listActive(client, workspaceId));
  }
  async function revokePairingCode({ workspaceId, codeId, actorId }) {
    return settle(await persistence.tenantTransaction(workspaceId, async (client) => {
      const row = await pairingCodeRepository.getById(client, workspaceId, codeId);
      if (!row) return REJECT(CP_ERRORS.E_NOT_FOUND, "Pairing code not found");
      const revoked = await pairingCodeRepository.revoke(client, workspaceId, codeId);
      await auditRepository.record(client, {
        workspaceId, actorType: "ADMIN", actorId, action: "pairing_code.revoke",
        targetType: "pairing_code", targetId: codeId, metadata: { changed: Boolean(revoked) }
      });
      return { codeId, status: "REVOKED", changed: Boolean(revoked) };
    }));
  }

  return {
    issueCode, claimCode, rotateCredential, revokeCredential,
    disableWorker, enableWorker,
    getWorkers, getWorker, getPairingCode, listPairingCodes, revokePairingCode
  };
}
