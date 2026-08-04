// P0 Step 5C.20 — one-time SECURE import of an ElevenLabs API key from a local plaintext file into the
// DPAPI-encrypted per-account credential store. Local-only bootstrap tool.
//
// SECURITY CONTRACT (enforced below):
//   * the command line carries ONLY --file <path> and --account-id <el_…> — NEVER the key;
//   * the key is read into RAM, validated LIVE, then encrypted with Windows DPAPI (CurrentUser) and written
//     atomically to a per-account store OUTSIDE the repo; on validation failure it is NOT stored;
//   * the key is never printed, logged, put in argv/env, written as plaintext anywhere, returned, or left
//     in a variable longer than necessary; only NON-secret status (masked hint / health) is emitted;
//   * the source file is NOT deleted here — deletion happens only after the caller confirms reload + restart
//     + post-restart API test all pass (a separate, explicit step).
//
// Usage:  node scripts/import-elevenlabs-api-key.mjs --file "<path>" --account-id "el_…" [--base-dir <dir>] [--reload-only]

import { lstatSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createElevenLabsApiCredentialRegistry } from "../lib/movie/elevenlabs-api-key-store.mjs";
import { createElevenLabsApiProvider } from "../lib/movie/elevenlabs-api-provider.mjs";
import { makeDpapiRunner } from "../lib/worker/credential-store.mjs";

const EL_ID = /^el_[0-9a-f]{20}$/;

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }
function fail(code, detail) { console.log(JSON.stringify({ ok: false, code, detail: detail || null })); process.exit(1); }
function ok(obj) { console.log(JSON.stringify({ ok: true, ...obj })); process.exit(0); }

function defaultBaseDir() {
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Local");
  return path.join(la, "AVCStudioWorker", "elevenlabs-api");
}

async function main() {
  const file = arg("file");
  const accountId = arg("account-id");
  const baseDir = arg("base-dir") || defaultBaseDir();
  const reloadOnly = process.argv.includes("--reload-only");
  if (!accountId || !EL_ID.test(accountId)) fail("API_KEY_INVALID", "bad --account-id");
  const registry = createElevenLabsApiCredentialRegistry({ baseDir, runner: makeDpapiRunner({ spawn }) });

  // --reload-only: prove the DPAPI ciphertext round-trips + re-validate, WITHOUT re-reading the file.
  if (reloadOnly) {
    const store = registry.store(accountId);
    if (!(await store.isConfigured())) fail("API_KEY_NOT_CONFIGURED", "no stored key");
    let key = null;
    try { key = await store.getKey(); } catch { return fail("ELEVENLABS_DPAPI_IDENTITY_MISMATCH", "decrypt failed"); }
    if (!key) return fail("ELEVENLABS_DPAPI_IDENTITY_MISMATCH", "decrypt empty");
    const prov = createElevenLabsApiProvider({ keyStore: store, fetchImpl: globalThis.fetch });
    const t = await prov.testConnection();
    key = null;
    if (!t.ok) return fail(t.code === "API_KEY_INVALID" ? "API_KEY_INVALID" : t.code, "reload test failed");
    const meta = await store.metadata();
    return ok({ stage: "reload", accountId, health: "ok", maskedHint: meta && meta.maskedHint, usage: t.usage || null });
  }

  if (!file) fail("ELEVENLABS_KEY_FILE_INVALID", "missing --file");
  // ---- validate the file by stat, WITHOUT reading content yet ----
  let st;
  try { st = lstatSync(file); } catch { return fail("ELEVENLABS_KEY_FILE_INVALID", "not found"); }
  if (!st.isFile()) return fail("ELEVENLABS_KEY_FILE_INVALID", "not a regular file");
  if (st.isSymbolicLink()) return fail("ELEVENLABS_KEY_FILE_INVALID", "symlink");
  if (st.size <= 0 || st.size > 4096) return fail("ELEVENLABS_KEY_FILE_INVALID", "size out of range");
  if (path.resolve(file).toLowerCase().startsWith(process.cwd().toLowerCase())) return fail("ELEVENLABS_KEY_FILE_INVALID", "inside repo");

  // ---- read into RAM; strip BOM + trim; validate shape (never printed) ----
  let raw = readFileSync(file, "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let key = raw.replace(/^\s+|\s+$/g, "");
  raw = null;
  // exactly one token: no interior whitespace/newlines, printable ASCII, plausible length
  if (/\s/.test(key) || key.length < 20 || key.length > 200 || /[^\x21-\x7e]/.test(key)) { key = null; return fail("ELEVENLABS_KEY_FILE_INVALID", "not a single key token"); }

  // ---- LIVE validation via a stub key source (never writes the key to disk) ----
  const stub = { async getKey() { return key; }, async setHealth() {} };
  const probe = createElevenLabsApiProvider({ keyStore: stub, fetchImpl: globalThis.fetch });
  const auth = await probe.testConnection();
  if (!auth.ok) { key = null; return fail(auth.code, "auth failed"); }
  const voices = await probe.listVoices();
  if (!voices.ok) { key = null; return fail(voices.code, "voices read failed"); }

  // ---- validation PASSED → encrypt + store per-account (DPAPI) ----
  const store = registry.store(accountId);
  try {
    await store.save({ apiKey: key, accountId, name: "AVC Studio TTS", permissions: ["text_to_speech"], validatedAt: Date.now(), source: "owner_file_import" });
  } catch (e) { key = null; return fail(e && e.code || "API_KEY_INVALID", "store failed"); }
  key = null; // wipe plaintext from RAM ASAP

  // ---- reload from DPAPI in a fresh store + re-validate (proves the ciphertext round-trips) ----
  const store2 = createElevenLabsApiCredentialRegistry({ baseDir, runner: makeDpapiRunner({ spawn }) }).store(accountId);
  let rk = null;
  try { rk = await store2.getKey(); } catch { return fail("ELEVENLABS_DPAPI_IDENTITY_MISMATCH", "reload decrypt failed"); }
  if (!rk) return fail("ELEVENLABS_DPAPI_IDENTITY_MISMATCH", "reload empty");
  rk = null;
  const t2 = await createElevenLabsApiProvider({ keyStore: store2, fetchImpl: globalThis.fetch }).testConnection();
  if (!t2.ok) return fail(t2.code, "reload test failed");
  await store2.setHealth({ lastHealth: "ok" });
  const meta = await store2.metadata();
  ok({ stage: "import", accountId, voiceCount: voices.voices.length, health: "ok", maskedHint: meta && meta.maskedHint, usage: t2.usage || null });
}

main().catch((e) => fail("API_PROVIDER_UNAVAILABLE", (e && e.code) || "unexpected"));
