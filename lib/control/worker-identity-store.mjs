// AVC Studio P0 Step 5B — control-plane Worker identity store (test/dev only).
//
// Holds pairing-code records, Worker identities, and credential records. It stores
// ONLY verifiers (peppered HMAC-SHA256), NEVER a plaintext pairing code or
// credential. Injectable clock. In-memory core; a file-backed variant persists the
// SAME (secret-free) data with atomic writes. NOT the production database design.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { generateId } from "../protocol/ids.mjs";
import { newLocalId, constantTimeEqualHex } from "./identity-crypto.mjs";
import { IDENTITY_ERRORS, identityError } from "./identity-errors.mjs";

export const CREDENTIAL_STATUS = Object.freeze({ PENDING: "PENDING", ACTIVE: "ACTIVE", ROTATING: "ROTATING", REVOKED: "REVOKED", EXPIRED: "EXPIRED" });
export const WORKER_STATUS = Object.freeze({ ACTIVE: "ACTIVE", REVOKED: "REVOKED" });

export class InMemoryWorkerIdentityStore {
  constructor({ clock, onMutate } = {}) {
    this._clock = typeof clock === "function" ? clock : () => Date.now();
    this._onMutate = typeof onMutate === "function" ? onMutate : null;
    this._codes = new Map();       // pairingCodeId -> record
    this._codeByVerifier = new Map();
    this._workers = new Map();     // workerId -> record
    this._credentials = new Map(); // credentialId -> record
    this._credByVerifier = new Map();
    this._audit = [];
  }

  _now() { return this._clock(); }
  _touch() { if (this._onMutate) this._onMutate(this.snapshot()); }

  audit(type, details = {}) { this._audit.push({ type, at: this._now(), ...sanitizeAudit(details) }); if (this._audit.length > 10000) this._audit.splice(0, this._audit.length - 10000); this._touch(); }
  getAuditEvents() { return this._audit.map((a) => ({ ...a })); }

  // ---- pairing codes ----
  createPairingCode({ workspaceId, codeVerifier, createdAt, expiresAt, createdBy = null }) {
    const pairingCodeId = newLocalId("pcode");
    const rec = { pairingCodeId, workspaceId, codeVerifier, createdAt, expiresAt, usedAt: null, usedByWorkerId: null, failedAttempts: 0, revokedAt: null, createdBy, lastAttemptAt: null };
    this._codes.set(pairingCodeId, rec);
    this._codeByVerifier.set(codeVerifier, pairingCodeId);
    this.audit("PAIRING_CODE_CREATED", { pairingCodeId, workspaceId });
    return { pairingCodeId, workspaceId, expiresAt };
  }
  getPairingCodeByVerifier(codeVerifier) { const id = this._codeByVerifier.get(codeVerifier); return id ? this._codes.get(id) : null; }
  revokePairingCode(pairingCodeId) { const r = this._codes.get(pairingCodeId); if (r && !r.revokedAt) { r.revokedAt = this._now(); this._touch(); } return Boolean(r); }

  // Atomic consume: exactly one caller may transition a valid code to used. Synchronous
  // (single-threaded) → no interleave between the validity check and the mark.
  consumePairingCodeAtomic(codeVerifier, { workspaceId, workerId }) {
    const now = this._now();
    const rec = this.getPairingCodeByVerifier(codeVerifier);
    if (!rec) throw identityError(IDENTITY_ERRORS.E_PAIRING_CODE_INVALID, "Unknown pairing code");
    rec.lastAttemptAt = now;
    if (rec.revokedAt) throw identityError(IDENTITY_ERRORS.E_PAIRING_CODE_REVOKED, "Pairing code revoked");
    if (rec.usedAt) throw identityError(IDENTITY_ERRORS.E_PAIRING_CODE_USED, "Pairing code already used");
    if (now >= rec.expiresAt) throw identityError(IDENTITY_ERRORS.E_PAIRING_CODE_EXPIRED, "Pairing code expired");
    if (workspaceId && rec.workspaceId !== workspaceId) throw identityError(IDENTITY_ERRORS.E_WORKSPACE_MISMATCH, "Workspace mismatch");
    rec.usedAt = now; rec.usedByWorkerId = workerId;
    this._touch();
    return { ...rec };
  }
  setCodeUsedBy(pairingCodeId, workerId) { const r = this._codes.get(pairingCodeId); if (r) { r.usedByWorkerId = workerId; this.audit("PAIRING_CODE_CONSUMED", { pairingCodeId, workerId }); this._touch(); } }
  recordPairingFailure(codeVerifier) {
    const rec = codeVerifier ? this.getPairingCodeByVerifier(codeVerifier) : null;
    if (rec) { rec.failedAttempts += 1; rec.lastAttemptAt = this._now(); this._touch(); }
    this.audit("PAIRING_CODE_FAILED", { pairingCodeId: rec?.pairingCodeId ?? null });
  }

  // ---- workers ----
  createWorker({ workspaceId, name, installationId = null }) {
    const workerId = generateId("wrk");
    const rec = { workerId, workspaceId, name: name || defaultName(workerId), installationId, status: WORKER_STATUS.ACTIVE, createdAt: this._now(), revokedAt: null, capabilities: [], storage: null, lastSeenAt: 0, connStatus: "OFFLINE" };
    this._workers.set(workerId, rec);
    this.audit("WORKER_CREATED", { workerId, workspaceId });
    return { ...rec };
  }
  getWorker(workerId) { const r = this._workers.get(workerId); return r ? { ...r } : null; }
  workspaceOf(workerId) { return this._workers.get(workerId)?.workspaceId ?? null; }
  listWorkersByWorkspace(workspaceId) { return [...this._workers.values()].filter((w) => w.workspaceId === workspaceId).map((w) => ({ ...w })); }
  renameWorker(workerId, name) { const r = this._workers.get(workerId); if (!r) return false; r.name = String(name || "").slice(0, 60) || r.name; this.audit("WORKER_RENAMED", { workerId }); this._touch(); return true; }
  setWorkerCapabilities(workerId, caps) { const r = this._workers.get(workerId); if (r) { r.capabilities = Array.isArray(caps) ? [...caps] : []; this._touch(); } }
  setWorkerStorage(workerId, storage) { const r = this._workers.get(workerId); if (r) { r.storage = storage ?? null; this._touch(); } }
  touchWorker(workerId, atMs, connStatus) { const r = this._workers.get(workerId); if (r) { if (Number.isFinite(atMs)) r.lastSeenAt = atMs; if (connStatus) r.connStatus = connStatus; this._touch(); } }

  // ---- credentials ----
  createCredential({ workerId, verifier, expiresAt, status = CREDENTIAL_STATUS.ACTIVE, keyVersion = 1 }) {
    const credentialId = newLocalId("cred");
    const rec = { credentialId, workerId, verifier, status, issuedAt: this._now(), expiresAt, lastUsedAt: null, rotatedAt: null, revokedAt: null, keyVersion };
    this._credentials.set(credentialId, rec);
    this._credByVerifier.set(verifier, credentialId);
    this.audit("CREDENTIAL_ISSUED", { workerId, credentialId, status });
    return { credentialId, workerId, status, expiresAt };
  }

  // verifyCredential(presentedVerifier) -> { ok, workerId, workspaceId, credentialId } or throws
  // sanitized identity error. Accepts ACTIVE and (within grace) ROTATING credentials.
  verifyCredential(presentedVerifier) {
    const now = this._now();
    const credId = this._credByVerifier.get(presentedVerifier);
    const rec = credId ? this._credentials.get(credId) : null;
    if (!rec || !constantTimeEqualHex(rec.verifier, presentedVerifier)) throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_INVALID, "Invalid credential");
    if (rec.status === CREDENTIAL_STATUS.REVOKED) throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_REVOKED, "Credential revoked");
    if (rec.expiresAt != null && now >= rec.expiresAt) { rec.status = CREDENTIAL_STATUS.EXPIRED; this._touch(); throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_EXPIRED, "Credential expired"); }
    if (rec.status !== CREDENTIAL_STATUS.ACTIVE && rec.status !== CREDENTIAL_STATUS.ROTATING) throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_INVALID, "Credential not usable");
    const worker = this._workers.get(rec.workerId);
    if (!worker || worker.status === WORKER_STATUS.REVOKED) throw identityError(IDENTITY_ERRORS.E_WORKER_REVOKED, "Worker revoked");
    rec.lastUsedAt = now; this._touch();
    return { ok: true, workerId: rec.workerId, workspaceId: worker.workspaceId, credentialId: rec.credentialId };
  }
  getCredential(credentialId) { const r = this._credentials.get(credentialId); return r ? { ...r } : null; }
  listCredentials(workerId) { return [...this._credentials.values()].filter((c) => c.workerId === workerId).map((c) => ({ ...c })); }
  markCredentialUsed(credentialId) { const r = this._credentials.get(credentialId); if (r) { r.lastUsedAt = this._now(); this._touch(); } }

  activateCredential(credentialId) {
    const r = this._credentials.get(credentialId);
    if (!r) return false;
    r.status = CREDENTIAL_STATUS.ACTIVE; r.rotatedAt = this._now(); this._touch();
    return true;
  }
  revokeCredential(credentialId) {
    const r = this._credentials.get(credentialId);
    if (!r) return false;
    if (r.status !== CREDENTIAL_STATUS.REVOKED) { r.status = CREDENTIAL_STATUS.REVOKED; r.revokedAt = this._now(); this.audit("CREDENTIAL_REVOKED", { workerId: r.workerId, credentialId }); this._touch(); }
    return true;
  }
  revokeWorker(workerId) {
    const w = this._workers.get(workerId);
    if (!w) return false;
    w.status = WORKER_STATUS.REVOKED; w.revokedAt = this._now(); w.connStatus = "REVOKED";
    for (const c of this._credentials.values()) if (c.workerId === workerId && c.status !== CREDENTIAL_STATUS.REVOKED) { c.status = CREDENTIAL_STATUS.REVOKED; c.revokedAt = this._now(); }
    this.audit("WORKER_REVOKED", { workerId });
    this._touch();
    return true;
  }

  // ---- persistence snapshot (secret-free: verifiers only, never plaintext) ----
  snapshot() {
    return {
      schemaVersion: 1,
      codes: [...this._codes.values()],
      workers: [...this._workers.values()],
      credentials: [...this._credentials.values()],
      audit: this._audit
    };
  }
  static fromSnapshot(snap, opts = {}) {
    const store = new InMemoryWorkerIdentityStore(opts);
    if (snap && snap.schemaVersion === 1) {
      for (const r of snap.codes || []) { store._codes.set(r.pairingCodeId, r); store._codeByVerifier.set(r.codeVerifier, r.pairingCodeId); }
      for (const r of snap.workers || []) store._workers.set(r.workerId, r);
      for (const r of snap.credentials || []) { store._credentials.set(r.credentialId, r); store._credByVerifier.set(r.verifier, r.credentialId); }
      store._audit = snap.audit || [];
    }
    return store;
  }
}

// File-backed dev store (localhost/dev only; NOT the production DB design). Every
// operation reloads from disk, runs against an InMemory store, then persists
// atomically (temp+rename) — so separate dev CLI processes share state via one file.
// Single-writer assumption (documented). Holds ONLY verifiers, never plaintext.
export function makeFileWorkerIdentityStore({ file, clock } = {}) {
  const load = () => {
    try {
      if (!existsSync(file)) return new InMemoryWorkerIdentityStore({ clock });
      const snap = JSON.parse(readFileSync(file, "utf8"));
      if (!snap || snap.schemaVersion !== 1) { quarantineFile(file); return new InMemoryWorkerIdentityStore({ clock }); }
      return InMemoryWorkerIdentityStore.fromSnapshot(snap, { clock });
    } catch { quarantineFile(file); return new InMemoryWorkerIdentityStore({ clock }); }
  };
  const persist = (store) => {
    const dir = file.replace(/[\\/][^\\/]*$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${Math.abs(clock ? clock() : Date.now())}`;
    writeFileSync(tmp, `${JSON.stringify(store.snapshot(), null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  };
  return new Proxy({}, {
    get(_t, prop) {
      return (...args) => { const store = load(); const res = store[prop](...args); try { persist(store); } catch { /* best effort */ } return res; };
    }
  });
}
function quarantineFile(file) { try { if (existsSync(file)) renameSync(file, `${file}.corrupt`); } catch { /* */ } }

function defaultName(workerId) { return `worker-${workerId.split("_")[1]?.slice(-6) ?? "new"}`; }
function sanitizeAudit(details) {
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    const lk = k.toLowerCase();
    if (lk.includes("credential") && lk !== "credentialid") continue;
    if (lk.includes("code") && lk !== "pairingcodeid") continue;
    if (lk.includes("verifier") || lk.includes("authorization") || lk.includes("token") || lk.includes("cookie") || lk.includes("password") || lk.includes("secret") || lk.includes("pepper")) continue;
    out[k] = typeof v === "string" ? v.slice(0, 120) : v;
  }
  return out;
}
