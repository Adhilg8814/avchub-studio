// P0 Step 5C.19 — ElevenLabs API key store (server-side, DPAPI-encrypted at rest).
//
// The owner's restricted ElevenLabs API key is a HIGH-VALUE secret. It is stored ONLY here, encrypted via
// Windows DPAPI (the same certified DpapiCredentialStore that protects worker credentials): the ciphertext
// lives in a file OUTSIDE the repo; the plaintext key exists only transiently in memory when a request is
// signed. It is NEVER written to Git, source, the frontend bundle, the owner JSON account store, a
// database, a test fixture, a log, an exception message, terminal output, a report, or an API response to
// the browser. The UI only ever sees the non-secret metadata (name, masked hint, createdAt, permissions,
// quota/IP restriction) via getSafeMetadata — never the key.

import { DpapiCredentialStore, MemoryCredentialStore } from "../worker/credential-store.mjs";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EL_ID = /^el_[0-9a-f]{20}$/;

// A short, non-authenticating hint: enough for the owner to recognise the key, useless for auth.
export function maskApiKey(key) {
  const s = String(key || "");
  if (s.length < 10) return "••••";
  return `${s.slice(0, 4)}…${s.slice(-3)}`;
}

export function createElevenLabsApiKeyStore({ dir, runner, backingStore = null } = {}) {
  // The backing store is the certified DPAPI credential store (or an injected memory store for tests).
  const store = backingStore || new DpapiCredentialStore({ dir, runner });

  return Object.freeze({
    async isConfigured() { return store.hasCredential(); },
    // Non-secret metadata ONLY (name, maskedHint, createdAt, permissions, quotaRestriction, ipRestriction).
    async metadata() { const m = store.getSafeMetadata(); return (m && m.active) || null; },
    // Persist a NEW key (encrypted). meta is non-secret; the key itself is the encrypted credential.
    async save({ apiKey, accountId = null, credentialId = null, name = "AVC Studio TTS", permissions = ["text_to_speech"], quotaRestriction = null, ipRestriction = null, createdAt = Date.now(), validatedAt = 0, source = "owner_entered" } = {}) {
      if (typeof apiKey !== "string" || apiKey.trim().length < 12) { const e = new Error("invalid api key"); e.code = "API_KEY_INVALID"; throw e; }
      await store.saveActiveCredential({
        credential: apiKey.trim(),
        provider: "ELEVENLABS_API",
        accountId: accountId || null,
        credentialId: credentialId || `apk_${crypto.randomBytes(8).toString("hex")}`,
        name: String(name).slice(0, 60),
        maskedHint: maskApiKey(apiKey.trim()),
        permissions: Array.isArray(permissions) ? permissions.slice(0, 8).map((p) => String(p).slice(0, 40)) : [],
        quotaRestriction: quotaRestriction ? String(quotaRestriction).slice(0, 60) : null,
        ipRestriction: ipRestriction ? String(ipRestriction).slice(0, 120) : null,
        createdAt: Number(createdAt) || Date.now(),
        validatedAt: Number(validatedAt) || 0,
        source: String(source).slice(0, 30),
        lastCheckedAt: 0, lastHealth: "unknown"
      });
    },
    // Update non-secret health metadata WITHOUT touching the ciphertext (re-encrypts the same key so the
    // meta+ciphertext stay atomic). Used after a Test connection.
    async setHealth({ lastHealth, lastCheckedAt = Date.now() } = {}) {
      const cur = await store.getActiveCredential();
      if (!cur) return null;
      const { credential, ...meta } = cur;
      await store.saveActiveCredential({ ...meta, credential, lastHealth: String(lastHealth || "unknown").slice(0, 20), lastCheckedAt: Number(lastCheckedAt) || Date.now() });
      return store.getSafeMetadata().active;
    },
    // SERVER-SIDE ONLY: the plaintext key, for signing an ElevenLabs API request. Callers must never log,
    // echo, or persist the returned value.
    async getKey() { const r = await store.getActiveCredential(); return r ? r.credential : null; },
    // Remove the local secret reference (the key stays valid on ElevenLabs until the owner revokes it there).
    async remove() { store.deleteAll(); return true; }
  });
}

// P0 Step 5C.20 — multi-account credential registry. Each ElevenLabs account (el_…) owns its OWN encrypted
// key in an isolated per-account DPAPI dir: accountId ↔ credentialId ↔ encrypted key ↔ health ↔ metadata.
// Account A's key is NEVER usable for account B (separate stores/dirs). Backward-compatible: a single
// account is just one entry.
export function createElevenLabsApiCredentialRegistry({ baseDir, runner, now = () => Date.now() } = {}) {
  if (!baseDir) throw new TypeError("createElevenLabsApiCredentialRegistry requires baseDir");
  function accountDir(accountId) {
    if (!EL_ID.test(String(accountId || ""))) { const e = new Error("invalid account id"); e.code = "API_KEY_INVALID"; throw e; }
    return path.join(baseDir, accountId);
  }
  function store(accountId) { return createElevenLabsApiKeyStore({ dir: accountDir(accountId), runner, now }); }
  async function listConfigured() {
    const out = [];
    try {
      for (const d of readdirSync(baseDir)) {
        if (!EL_ID.test(d)) continue;
        const s = store(d);
        if (await s.isConfigured()) out.push({ accountId: d, metadata: await s.metadata() });
      }
    } catch { /* baseDir may not exist yet */ }
    return out;
  }
  async function isConfigured(accountId) { try { return existsSync(accountDir(accountId)) && (await store(accountId).isConfigured()); } catch { return false; } }
  return Object.freeze({ store, listConfigured, isConfigured });
}

export { MemoryCredentialStore };
