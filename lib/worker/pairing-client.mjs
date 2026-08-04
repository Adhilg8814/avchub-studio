// AVC Studio P0 Step 5B — Worker-side pairing/rotation HTTP client.
//
// Exchanges a one-time pairing code for a Worker identity + credential and stores
// the credential securely via the injected WorkerCredentialStore. The plaintext
// credential is written to the secure store and NEVER returned to the caller,
// logged, or placed in argv/URL. Assumes an encrypted transport (wss) in
// production; loopback http:// is test/dev only.

import http from "node:http";
import https from "node:https";
import { IDENTITY_ERRORS, identityError } from "../control/identity-errors.mjs";

function postJson(urlStr, body, { authorization } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const data = JSON.stringify(body);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...(authorization ? { Authorization: authorization } : {}) }
    }, (res) => {
      let out = "";
      res.on("data", (d) => { out += d; });
      res.on("end", () => { let json = null; try { json = JSON.parse(out || "{}"); } catch { /* non-json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

export class WorkerPairingClient {
  constructor({ url, credentialStore, installationId = null, capabilities = [], workerName, workerVersion = "0.1.0", protocolVersion = 1 } = {}) {
    if (!url) throw new Error("WorkerPairingClient requires a url");
    if (!credentialStore) throw new Error("WorkerPairingClient requires a credentialStore");
    this._url = url.replace(/\/$/, "");
    this._store = credentialStore;
    this._installationId = installationId;
    this._capabilities = [...capabilities];
    this._workerName = workerName;
    this._workerVersion = workerVersion;
    this._protocolVersion = protocolVersion;
  }

  // pair(code) -> safe result. Stores the credential securely BEFORE reporting success.
  async pair(pairingCode) {
    const body = {
      pairingCode, installationId: this._installationId, requestedWorkerName: this._workerName,
      platform: process.platform, osVersion: "local", architecture: process.arch,
      workerVersion: this._workerVersion, protocolVersion: this._protocolVersion, capabilities: this._capabilities
    };
    const res = await postJson(`${this._url}/worker/pair`, body);
    if (res.status !== 200 || !res.json || !res.json.workerCredential) throw identityError(res.json?.error || IDENTITY_ERRORS.E_PAIRING_CODE_INVALID, res.json?.message || "Pairing failed");
    const r = res.json;
    await this._store.saveActiveCredential({ credential: r.workerCredential, workerId: r.workerId, workspaceId: r.workspaceId, expiresAt: r.credentialExpiresAt, controlPlaneUrl: r.controlPlaneUrl, status: "ACTIVE" });
    // NOTE: plaintext credential is intentionally NOT returned.
    return { workerId: r.workerId, workspaceId: r.workspaceId, credentialExpiresAt: r.credentialExpiresAt, controlPlaneUrl: r.controlPlaneUrl, stored: true };
  }

  // rotate(rotationId) -> stores the new credential as PENDING; returns safe result.
  async rotate(rotationId) {
    const active = await this._store.getActiveCredential();
    if (!active || !active.credential) throw identityError(IDENTITY_ERRORS.E_CREDENTIAL_INVALID, "No active credential");
    const res = await postJson(`${this._url}/worker/credential/rotate`, { rotationId }, { authorization: `Bearer ${active.credential}` });
    if (res.status !== 200 || !res.json || !res.json.workerCredential) throw identityError(res.json?.error || IDENTITY_ERRORS.E_CREDENTIAL_ROTATION_INVALID, res.json?.message || "Rotation failed");
    const r = res.json;
    await this._store.savePendingCredential({ credential: r.workerCredential, workerId: active.workerId, workspaceId: active.workspaceId, expiresAt: r.credentialExpiresAt, status: "PENDING" });
    return { stored: true };
  }
}
