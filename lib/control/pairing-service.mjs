// AVC Studio P0 Step 5B — PairingService (control-plane orchestration).
//
// Creates one-time pairing codes and exchanges a submitted code for a Worker
// identity + credential (plaintext returned ONCE). Also drives credential rotation
// and revocation. Stores ONLY verifiers via the identity store. Rate-limited.
//
// It never logs a pairing code, credential, verifier, or Authorization header.

import {
  generatePairingCode, normalizePairingCode, pairingCodeVerifier,
  generateWorkerCredential, credentialVerifier, newLocalId
} from "./identity-crypto.mjs";
import { IDENTITY_ERRORS, identityError } from "./identity-errors.mjs";
import { CREDENTIAL_STATUS } from "./worker-identity-store.mjs";
import { RateLimiter } from "./rate-limiter.mjs";

const DEFAULT_LIMITS = {
  codeCreate: { max: 5, windowMs: 3600_000 },        // per workspace / hour
  attemptsPerSource: { max: 10, windowMs: 3600_000 }, // per source / hour
  maxAttemptsPerCode: 5,
  rotate: { max: 3, windowMs: 3600_000 }              // per worker / hour
};

export class PairingService {
  constructor({ store, pairingPepper, credentialPepper, clock, rateLimiter, limits, codeTtlMs = 600_000, credentialTtlMs = 90 * 24 * 3600_000, rotationTtlMs = 600_000, protocolVersion = 1, controlPlaneUrl = null } = {}) {
    if (!store) throw new Error("PairingService requires an identity store");
    if (!pairingPepper || !credentialPepper) throw new Error("PairingService requires peppers");
    this._store = store;
    this._pairingPepper = pairingPepper;
    this._credentialPepper = credentialPepper;
    this._clock = typeof clock === "function" ? clock : () => Date.now();
    this._rl = rateLimiter || new RateLimiter({ clock: this._clock });
    this._limits = { ...DEFAULT_LIMITS, ...(limits || {}) };
    this._codeTtlMs = codeTtlMs;
    this._credentialTtlMs = credentialTtlMs;
    this._rotationTtlMs = rotationTtlMs;
    this._protocolVersion = protocolVersion;
    this._controlPlaneUrl = controlPlaneUrl;
    this._rotations = new Map(); // rotationId -> { workerId, oldCredentialId, newCredentialId, expiresAt, consumed }
  }

  // ---- create a one-time code (plaintext returned ONCE to the local operator) ----
  createPairingCode({ workspaceId, createdBy = null }) {
    if (!workspaceId) throw identityError(IDENTITY_ERRORS.E_PAIRING_PAYLOAD_INVALID, "workspaceId required");
    if (!this._rl.hit(`pcode-create:${workspaceId}`, this._limits.codeCreate).allowed) throw identityError(IDENTITY_ERRORS.E_PAIRING_RATE_LIMITED, "Rate limited");
    const { code, normalized } = generatePairingCode();
    const now = this._clock();
    const meta = this._store.createPairingCode({ workspaceId, codeVerifier: pairingCodeVerifier(this._pairingPepper, normalized), createdAt: now, expiresAt: now + this._codeTtlMs, createdBy });
    return { code, pairingCodeId: meta.pairingCodeId, workspaceId, expiresAt: meta.expiresAt };
  }

  // ---- pair: exchange a code for identity + credential (credential returned ONCE) ----
  pair(request = {}, { source = "local" } = {}) {
    validatePairingPayload(request);
    if (!this._rl.hit(`pair-source:${source}`, this._limits.attemptsPerSource).allowed) throw identityError(IDENTITY_ERRORS.E_PAIRING_RATE_LIMITED, "Rate limited");
    if (request.protocolVersion != null && request.protocolVersion !== this._protocolVersion) throw identityError(IDENTITY_ERRORS.E_PAIRING_PAYLOAD_INVALID, "Unsupported protocol");

    const normalized = normalizePairingCode(request.pairingCode);
    if (!normalized) { this._store.recordPairingFailure(null); throw identityError(IDENTITY_ERRORS.E_PAIRING_CODE_INVALID, "Invalid code format"); }
    const verifier = pairingCodeVerifier(this._pairingPepper, normalized);
    const peek = this._store.getPairingCodeByVerifier(verifier);
    if (peek && peek.failedAttempts >= this._limits.maxAttemptsPerCode) throw identityError(IDENTITY_ERRORS.E_PAIRING_ATTEMPTS_EXCEEDED, "Too many attempts");

    let consumed;
    try {
      consumed = this._store.consumePairingCodeAtomic(verifier, {}); // atomic: one winner
    } catch (err) {
      this._store.recordPairingFailure(verifier);
      throw err;
    }
    const worker = this._store.createWorker({ workspaceId: consumed.workspaceId, name: safeName(request.requestedWorkerName), installationId: safeInstallationId(request.installationId) });
    this._store.setCodeUsedBy(consumed.pairingCodeId, worker.workerId);

    const { plaintext, expiresAt } = this._issueCredential(worker.workerId);
    return {
      workerId: worker.workerId, workspaceId: worker.workspaceId,
      workerCredential: plaintext, credentialExpiresAt: expiresAt,
      protocolVersion: this._protocolVersion, controlPlaneUrl: this._controlPlaneUrl
    };
  }

  _issueCredential(workerId, { status = CREDENTIAL_STATUS.ACTIVE, keyVersion = 1 } = {}) {
    const plaintext = generateWorkerCredential();
    const verifier = credentialVerifier(this._credentialPepper, plaintext);
    const expiresAt = this._credentialTtlMs == null ? null : this._clock() + this._credentialTtlMs;
    const rec = this._store.createCredential({ workerId, verifier, expiresAt, status, keyVersion });
    return { plaintext, credentialId: rec.credentialId, expiresAt };
  }

  // ---- authenticate a presented credential (for WebSocket upgrade) ----
  authenticate(plaintextCredential) {
    if (typeof plaintextCredential !== "string" || !plaintextCredential) throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_INVALID, "Missing credential");
    return this._store.verifyCredential(credentialVerifier(this._credentialPepper, plaintextCredential));
  }

  // ---- rotation (two-phase, crash-safe) ----
  startRotation(workerId, { reason = "operator" } = {}) {
    const active = this._store.listCredentials(workerId).filter((c) => c.status === CREDENTIAL_STATUS.ACTIVE);
    const oldCredentialId = active[0]?.credentialId ?? null;
    const rotationId = newLocalId("rot");
    this._rotations.set(rotationId, { workerId, oldCredentialId, newCredentialId: null, expiresAt: this._clock() + this._rotationTtlMs, consumed: false });
    this._store.audit("CREDENTIAL_ROTATION_STARTED", { workerId, reason });
    return { rotationId, expiresAt: this._clock() + this._rotationTtlMs, reason };
  }

  // Authenticated rotation endpoint: validate current credential + rotationId, mint a
  // ROTATING credential, return its plaintext ONCE.
  rotate({ rotationId, currentCredential } = {}, { source = "local" } = {}) {
    const auth = this.authenticate(currentCredential); // throws sanitized on bad cred
    if (!this._rl.hit(`rotate:${auth.workerId}`, this._limits.rotate).allowed) throw identityError(IDENTITY_ERRORS.E_PAIRING_RATE_LIMITED, "Rate limited");
    const rot = this._rotations.get(rotationId);
    if (!rot || rot.workerId !== auth.workerId) throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_ROTATION_INVALID, "Unknown rotation");
    if (this._clock() >= rot.expiresAt) throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_ROTATION_INVALID, "Rotation expired");
    if (rot.consumed) throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_ROTATION_INVALID, "Rotation already used");
    rot.consumed = true;
    const oldKey = auth.credentialId ? (this._store.getCredential(auth.credentialId)?.keyVersion ?? 1) : 1;
    const issued = this._issueCredential(auth.workerId, { status: CREDENTIAL_STATUS.ROTATING, keyVersion: oldKey + 1 });
    rot.newCredentialId = issued.credentialId;
    if (!rot.oldCredentialId) rot.oldCredentialId = auth.credentialId;
    return { workerCredential: issued.plaintext, credentialExpiresAt: issued.expiresAt, credentialId: issued.credentialId };
  }

  // Called by the control plane after a worker successfully authenticates with a
  // ROTATING credential: promote it and revoke the old one (end of overlap).
  completeRotationForCredential(credentialId) {
    const cred = this._store.getCredential(credentialId);
    if (!cred || cred.status !== CREDENTIAL_STATUS.ROTATING) return false;
    // Normal path: an in-memory rotation record links new→old.
    for (const [, rot] of this._rotations) {
      if (rot.newCredentialId === credentialId) {
        this._store.activateCredential(credentialId);
        if (rot.oldCredentialId && rot.oldCredentialId !== credentialId) this._store.revokeCredential(rot.oldCredentialId);
        this._store.audit("CREDENTIAL_ROTATED", { workerId: cred.workerId, credentialId });
        return true;
      }
    }
    // Reconciliation fallback (rotation record lost, e.g. control-plane restart between
    // rotate() and the completing HELLO): a ROTATING credential is only ever minted by
    // the authenticated rotate endpoint, so it is legitimate to promote it and revoke
    // any OTHER still-ACTIVE credential of the same worker — ending the overlap.
    this._store.activateCredential(credentialId);
    for (const c of this._store.listCredentials(cred.workerId)) {
      if (c.credentialId !== credentialId && c.status === CREDENTIAL_STATUS.ACTIVE) this._store.revokeCredential(c.credentialId);
    }
    this._store.audit("CREDENTIAL_ROTATED", { workerId: cred.workerId, credentialId, recovered: true });
    return true;
  }

  // ---- revocation / re-pair ----
  revokeWorker(workerId) { return this._store.revokeWorker(workerId); }
}

// ---- pairing payload validation (schema + size + pollution) ----
const MAX_PAIR_PAYLOAD_BYTES = 8 * 1024;
const POLLUTION = new Set(["__proto__", "prototype", "constructor"]);
export function validatePairingPayload(req) {
  if (!req || typeof req !== "object" || Array.isArray(req)) throw identityError(IDENTITY_ERRORS.E_PAIRING_PAYLOAD_INVALID, "Payload must be an object");
  for (const k of Object.keys(req)) if (POLLUTION.has(k)) throw identityError(IDENTITY_ERRORS.E_PAIRING_PAYLOAD_INVALID, "Forbidden key");
  if (typeof req.pairingCode !== "string" || req.pairingCode.length === 0 || req.pairingCode.length > 64) throw identityError(IDENTITY_ERRORS.E_PAIRING_PAYLOAD_INVALID, "pairingCode required");
  if (Buffer.byteLength(safeStringify(req), "utf8") > MAX_PAIR_PAYLOAD_BYTES) throw identityError(IDENTITY_ERRORS.E_PAIRING_PAYLOAD_INVALID, "Payload too large");
  // installationId is optional metadata, never an auth factor.
  if (req.installationId != null && (typeof req.installationId !== "string" || req.installationId.length > 64)) throw identityError(IDENTITY_ERRORS.E_PAIRING_PAYLOAD_INVALID, "Invalid installationId");
}
function safeStringify(v) { try { return JSON.stringify(v); } catch { return ""; } }
function safeName(n) { return typeof n === "string" ? n.slice(0, 60) : undefined; }
function safeInstallationId(i) { return typeof i === "string" && i.length <= 64 ? i : null; }
