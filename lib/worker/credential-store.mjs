// AVC Studio P0 Step 5B — Worker-side secure credential store.
//
// The plaintext Worker credential is a SECRET. It must never be written in
// plaintext, never placed in argv/env/logs/errors, and must live OUTSIDE the repo
// (default %LOCALAPPDATA%\AVCStudioWorker\credentials). Two stores:
//   - MemoryCredentialStore: tests only (never a production default).
//   - DpapiCredentialStore: encrypts the credential via an INJECTED runner (Windows
//     DPAPI by default) with the secret passed over stdin — never argv/env.
//
// Interface: getActiveCredential / getPendingCredential / saveActiveCredential /
// savePendingCredential / promotePendingCredential / deleteCredential / deleteAll /
// hasCredential / getSafeMetadata.

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { generateId } from "../protocol/ids.mjs";

// Metadata is non-secret (workerId/workspaceId/expiry/status/controlPlaneUrl).
function splitRecord(record) {
  const { credential, ...meta } = record || {};
  return { credential, meta };
}
export function safeMeta(record) { if (!record) return null; const { credential, ...meta } = record; return meta; }

// ---- in-memory (tests only) ----
export class MemoryCredentialStore {
  constructor() { this._active = null; this._pending = null; }
  getActiveCredential() { return this._active ? { ...this._active } : null; }
  getPendingCredential() { return this._pending ? { ...this._pending } : null; }
  saveActiveCredential(record) { assertRecord(record); this._active = { ...record }; }
  savePendingCredential(record) { assertRecord(record); this._pending = { ...record }; }
  promotePendingCredential() { if (!this._pending) return false; this._active = this._pending; this._pending = null; return true; }
  deleteCredential() { this._active = null; }
  deleteAll() { this._active = null; this._pending = null; }
  hasCredential() { return this._active != null; }
  getSafeMetadata() { return { active: safeMeta(this._active), pending: safeMeta(this._pending) }; }
}

function assertRecord(record) {
  if (!record || typeof record.credential !== "string" || !record.credential) { const e = new Error("credential record requires a plaintext credential"); e.code = "E_CREDENTIAL_STORE_FAILED"; throw e; }
}

// ---- DPAPI-backed (Windows); runner injected so tests never spawn PowerShell ----
export class DpapiCredentialStore {
  constructor({ dir, runner, ensureOutsideRepo = true } = {}) {
    if (typeof runner !== "function") throw new Error("DpapiCredentialStore requires an injected runner(mode, secret)");
    this._dir = dir || defaultCredentialDir();
    if (ensureOutsideRepo) assertOutsideRepo(this._dir);
    this._runner = runner;
  }

  // One file per slot ({ schemaVersion, meta, ciphertext }) so promotion is a SINGLE
  // atomic rename — no window where ciphertext and metadata can disagree.
  _p(slot) { return path.join(this._dir, `${slot}.json`); }
  _ensureDir() { if (!existsSync(this._dir)) mkdirSync(this._dir, { recursive: true }); }
  _writeAtomic(file, data) { this._ensureDir(); const tmp = path.join(this._dir, `.tmp-${generateId("msg").slice(4)}-${path.basename(file)}`); writeFileSync(tmp, data); renameSync(tmp, file); }

  async _save(slot, record) {
    assertRecord(record);
    const { credential, meta } = splitRecord(record);
    let ciphertext;
    try { ciphertext = await this._runner("protect", credential); } // secret over stdin
    catch (err) { throw sanitizedStoreError("encrypt failed"); }
    if (typeof ciphertext !== "string" || !ciphertext) throw sanitizedStoreError("encrypt returned empty");
    this._writeAtomic(this._p(slot), `${JSON.stringify({ schemaVersion: 1, meta, ciphertext }, null, 2)}\n`);
  }
  async _load(slot) {
    if (!existsSync(this._p(slot))) return null;
    let doc;
    try { doc = JSON.parse(readFileSync(this._p(slot), "utf8")); } catch { this._quarantine(slot); return null; }
    if (!doc || doc.schemaVersion !== 1 || typeof doc.ciphertext !== "string") { this._quarantine(slot); return null; }
    let credential;
    try { credential = await this._runner("unprotect", doc.ciphertext); }
    catch { throw sanitizedStoreError("decrypt failed"); }
    if (typeof credential !== "string" || !credential) return null;
    return { ...(doc.meta || {}), credential };
  }
  _delete(slot) { const f = this._p(slot); if (existsSync(f)) rmSync(f, { force: true }); }
  _quarantine(slot) { try { const f = this._p(slot); if (existsSync(f)) renameSync(f, `${f}.corrupt`); } catch { /* best effort */ } }

  async saveActiveCredential(record) { return this._save("active", record); }
  async savePendingCredential(record) { return this._save("pending", record); }
  async getActiveCredential() { return this._load("active"); }
  async getPendingCredential() { return this._load("pending"); }
  async promotePendingCredential() {
    if (!existsSync(this._p("pending"))) return false;
    renameSync(this._p("pending"), this._p("active")); // single atomic swap
    return true;
  }
  deleteCredential() { this._delete("active"); }
  deleteAll() { this._delete("active"); this._delete("pending"); }
  hasCredential() { return existsSync(this._p("active")); }
  getSafeMetadata() {
    const read = (slot) => { try { return JSON.parse(readFileSync(this._p(slot), "utf8")).meta ?? null; } catch { return null; } };
    return { active: existsSync(this._p("active")) ? read("active") : null, pending: existsSync(this._p("pending")) ? read("pending") : null };
  }
}

function sanitizedStoreError(msg) { const e = new Error(`credential store: ${msg}`); e.code = "E_CREDENTIAL_STORE_FAILED"; return e; }
function defaultCredentialDir() {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Local");
  return path.join(base, "AVCStudioWorker", "credentials");
}
function assertOutsideRepo(dir) {
  const repo = process.cwd().toLowerCase();
  const d = path.resolve(dir).toLowerCase();
  if (d.startsWith(repo)) { const e = new Error("credential dir must be OUTSIDE the repository"); e.code = "E_CREDENTIAL_STORE_FAILED"; throw e; }
}

// makeDpapiRunner({ spawn }): default Windows DPAPI runner. Secret travels over STDIN
// (never argv/env). PowerShell is invoked -NoProfile -NonInteractive. Not used in
// automated tests (a fake runner is injected). `spawn` injectable for shape tests.
export function makeDpapiRunner({ spawn, powershell = "powershell" } = {}) {
  const nodeSpawn = spawn;
  if (typeof nodeSpawn !== "function") throw new Error("makeDpapiRunner requires spawn");
  // System.Security is NOT auto-loaded in Windows PowerShell 5.1, so ProtectedData must be
  // made available with Add-Type first and referenced by its fully-qualified name; otherwise
  // the script fails with TypeNotFound and DPAPI protect/unprotect never runs (P0 Step 5C.8B1
  // live-E2E defect: the real Worker child could not persist its paired credential).
  const SCRIPT = {
    protect: "Add-Type -AssemblyName System.Security;$b=[Console]::In.ReadToEnd();$d=[Text.Encoding]::UTF8.GetBytes($b);$e=[System.Security.Cryptography.ProtectedData]::Protect($d,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($e))",
    unprotect: "Add-Type -AssemblyName System.Security;$b=[Console]::In.ReadToEnd();$e=[Convert]::FromBase64String($b);$d=[System.Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser');[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))"
  };
  return (mode, secret) => new Promise((resolve, reject) => {
    const script = SCRIPT[mode];
    if (!script) return reject(new Error("unknown mode"));
    // Secret is written to stdin below — NEVER placed in argv.
    const child = nodeSpawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let out = "";
    child.stdout?.on?.("data", (d) => { out += d.toString(); });
    child.on?.("error", () => reject(sanitizedStoreError("runner spawn failed")));
    child.on?.("close", (code) => (code === 0 ? resolve(out) : reject(sanitizedStoreError("runner exited nonzero"))));
    try { child.stdin?.write?.(secret); child.stdin?.end?.(); } catch { reject(sanitizedStoreError("stdin write failed")); }
  });
}
