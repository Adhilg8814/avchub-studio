// P0 Step 5C.17 — ElevenLabs Web account store (owner-side, file-backed).
//
// The owner's own elevenlabs.io accounts are personal config, NOT multi-tenant workspace data, so they
// live in a small JSON file under the owner root (outside the repo, alongside the other owner runtime
// state) rather than the tenant PostgreSQL — this keeps the certified Grok provider-account machinery
// completely untouched. A record holds ONLY non-secret metadata: a label, the Cloak profile directory
// that carries the owner's signed-in session, an optional proxy ref, the authenticated flag (set only by
// a real daemon auth check, never by the agent), a per-locale voice map the owner confirms after signing
// in, and coarse usage counters. NO password, cookie, or token is ever stored here or anywhere else.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function err(code, message) { return Object.assign(new Error(message), { code }); }
const EL_ID = /^el_[0-9a-f]{20}$/;
function mintId() { return "el_" + crypto.randomBytes(10).toString("hex"); }

// A tiny path-shape guard: the profile dir must be an absolute path, never a URL/secret. We store only
// the directory string; the daemon is what actually opens it.
function sanitizeProfileDir(p) {
  const s = String(p || "").trim();
  if (!s || !path.isAbsolute(s) || /^https?:/i.test(s)) throw err("E_ELEVENLABS_PROFILE_DIR", "an absolute profile directory is required");
  return s;
}

export function createElevenLabsAccountStore({ storePath, now = () => Date.now() } = {}) {
  if (!storePath || !path.isAbsolute(storePath)) throw new TypeError("createElevenLabsAccountStore requires an absolute storePath");

  async function readAll() {
    try {
      const raw = await readFile(storePath, "utf8");
      const j = JSON.parse(raw);
      return Array.isArray(j.accounts) ? j.accounts : [];
    } catch (e) {
      if (e && e.code === "ENOENT") return [];
      if (e instanceof SyntaxError) return []; // never crash on a corrupt file; treat as empty
      throw e;
    }
  }
  async function writeAll(accounts) {
    await mkdir(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify({ schemaVersion: 1, accounts }, null, 2), "utf8");
    await rename(tmp, storePath); // atomic replace
  }
  // Public view: never leak the raw profile dir path to callers that only need to pick an account; expose
  // a redacted marker + the metadata the selector/provider need.
  function toView(a) {
    return Object.freeze({
      id: a.id, label: a.label || null, authenticated: a.authenticated === true, disabled: a.disabled === true,
      hasProfile: Boolean(a.profileDir), proxyRef: a.proxyRef || null, voiceMap: a.voiceMap || null,
      voiceCatalog: Array.isArray(a.voiceCatalog) ? a.voiceCatalog : null, voiceCatalogAt: a.voiceCatalogAt || 0,
      lastUsedAt: a.lastUsedAt || 0, charsUsed: a.charsUsed || 0, createdAt: a.createdAt || 0,
      lastAuthCheckAt: a.lastAuthCheckAt || 0
    });
  }

  async function mutate(id, fn) {
    if (!EL_ID.test(String(id || ""))) throw err("E_ELEVENLABS_ACCOUNT_NOT_FOUND", "invalid account id");
    const all = await readAll();
    const idx = all.findIndex((a) => a.id === id);
    if (idx < 0) throw err("E_ELEVENLABS_ACCOUNT_NOT_FOUND", "account not found");
    all[idx] = fn({ ...all[idx] });
    await writeAll(all);
    return toView(all[idx]);
  }

  return Object.freeze({
    async list() { return (await readAll()).map(toView); },
    // resolveInternal returns the RAW record (with profileDir) for the daemon-facing coordinator only.
    async resolveInternal(id) {
      const a = (await readAll()).find((x) => x.id === id);
      if (!a) throw err("E_ELEVENLABS_ACCOUNT_NOT_FOUND", "account not found");
      return { ...a };
    },
    async create({ label, profileDir, proxyRef = null } = {}) {
      const dir = sanitizeProfileDir(profileDir);
      const all = await readAll();
      if (all.some((a) => a.profileDir === dir)) throw err("E_ELEVENLABS_PROFILE_IN_USE", "a profile directory is already registered");
      const rec = { id: mintId(), label: String(label || "ElevenLabs").slice(0, 80), profileDir: dir, proxyRef: proxyRef ? String(proxyRef).slice(0, 120) : null, authenticated: false, disabled: false, voiceMap: null, lastUsedAt: 0, charsUsed: 0, lastAuthCheckAt: 0, createdAt: now() };
      all.push(rec);
      await writeAll(all);
      return toView(rec);
    },
    async setAuthenticated(id, authenticated) { return mutate(id, (a) => ({ ...a, authenticated: authenticated === true, lastAuthCheckAt: now() })); },
    async setVoiceMap(id, voiceMap) {
      const clean = {};
      if (voiceMap && typeof voiceMap === "object") {
        for (const [loc, v] of Object.entries(voiceMap)) {
          if (v && typeof v === "object" && v.voiceName) {
            const e = { voiceName: String(v.voiceName).slice(0, 80), model: String(v.model || "eleven_multilingual_v2").slice(0, 60) };
            // stable identity (from the enumerated catalog) distinguishes duplicate-name voices
            if (v.voiceIdentity && /^[A-Za-z0-9._-]{8,80}$/.test(String(v.voiceIdentity))) e.voiceIdentity = String(v.voiceIdentity);
            clean[loc] = e;
          }
        }
      }
      return mutate(id, (a) => ({ ...a, voiceMap: Object.keys(clean).length ? clean : null }));
    },
    // Persist the account's enumerated voice catalog (non-secret display + UI identity + avatar only).
    async setVoiceCatalog(id, voices, { observedAt = now(), sourceSurface = "speech-synthesis" } = {}) {
      const clean = (Array.isArray(voices) ? voices : []).map((v) => ({
        displayName: String(v.displayName || "").slice(0, 60),
        voiceIdentity: v.voiceIdentity ? String(v.voiceIdentity).slice(0, 80) : null,
        avatar: v.avatar ? String(v.avatar).slice(0, 200) : null,
        category: v.category ? String(v.category).slice(0, 30) : null,
        selectable: v.selectable !== false, observedAt, sourceSurface
      })).filter((v) => v.displayName);
      return mutate(id, (a) => ({ ...a, voiceCatalog: clean, voiceCatalogAt: observedAt }));
    },
    async setDisabled(id, disabled) { return mutate(id, (a) => ({ ...a, disabled: disabled === true })); },
    async markUsed(id, { chars = 0 } = {}) { return mutate(id, (a) => ({ ...a, lastUsedAt: now(), charsUsed: (a.charsUsed || 0) + Math.max(0, Math.round(chars)) })); },
    async remove(id) {
      if (!EL_ID.test(String(id || ""))) throw err("E_ELEVENLABS_ACCOUNT_NOT_FOUND", "invalid account id");
      const all = await readAll();
      const next = all.filter((a) => a.id !== id);
      if (next.length === all.length) throw err("E_ELEVENLABS_ACCOUNT_NOT_FOUND", "account not found");
      await writeAll(next);
      return { ok: true, id };
    }
  });
}
