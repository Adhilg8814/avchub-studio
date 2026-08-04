// P0 Step 5C.19 — ElevenLabs API key store (DPAPI, fake runner) + API provider (fake fetch), provider-free.
// Proves: the key is encrypted-at-rest + never in the safe metadata; error classification; voice resolution
// ambiguity handling; idempotent + validated synthesis. NO network, NO real key, NO real DPAPI spawn.
import { createElevenLabsApiKeyStore, maskApiKey } from "../lib/movie/elevenlabs-api-key-store.mjs";
import { createElevenLabsApiProvider } from "../lib/movie/elevenlabs-api-provider.mjs";
import { DpapiCredentialStore } from "../lib/worker/credential-store.mjs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log("FAIL", n); } };
const throwsAsync = async (n, fn, code) => { try { await fn(); failed++; console.log("FAIL(no throw)", n); } catch (e) { if (!code || e.code === code) passed++; else { failed++; console.log("FAIL(code)", n, "got", e.code); } } };

// fake DPAPI runner (base64 round-trip stands in for ProtectedData) — never spawns PowerShell
const fakeRunner = async (mode, secret) => mode === "protect" ? Buffer.from(String(secret), "utf8").toString("base64") : Buffer.from(String(secret), "base64").toString("utf8");
function res(status, body, { text = null } = {}) {
  return { status, json: async () => body, text: async () => (text != null ? text : JSON.stringify(body)), arrayBuffer: async () => body };
}

async function run() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "el-api-"));
  const store = createElevenLabsApiKeyStore({ backingStore: new DpapiCredentialStore({ dir, runner: fakeRunner }) });

  // ---- A. key store: encrypted at rest, masked metadata only ----
  check("A masks key to a non-authenticating hint", maskApiKey("sk_abcdef1234567890xyz") === "sk_a…xyz");
  check("A not configured initially", (await store.isConfigured()) === false);
  await store.save({ apiKey: "sk_secret_key_1234567890ABCDEF", name: "AVC Studio TTS", permissions: ["text_to_speech"] });
  check("A configured after save", (await store.isConfigured()) === true);
  const meta = await store.metadata();
  check("A metadata has name + maskedHint + permissions", meta.name === "AVC Studio TTS" && meta.maskedHint === "sk_s…DEF" && meta.permissions[0] === "text_to_speech");
  check("A metadata does NOT contain the key", !JSON.stringify(meta).includes("sk_secret_key_1234567890ABCDEF") && !("credential" in meta));
  // the on-disk file must not contain the plaintext key
  const files = await readdir(dir);
  const disk = await readFile(path.join(dir, files.find((f) => f.endsWith(".json"))), "utf8");
  check("A on-disk file has NO plaintext key (ciphertext only)", !disk.includes("sk_secret_key_1234567890ABCDEF") && disk.includes("ciphertext"));
  check("A getKey returns the plaintext server-side only", (await store.getKey()) === "sk_secret_key_1234567890ABCDEF");
  await throwsAsync("A save rejects a too-short key", () => store.save({ apiKey: "short" }), "API_KEY_INVALID");

  // ---- B. provider: not configured -> API_KEY_NOT_CONFIGURED ----
  {
    const empty = createElevenLabsApiKeyStore({ backingStore: new DpapiCredentialStore({ dir: await mkdtemp(path.join(os.tmpdir(), "el-empty-")), runner: fakeRunner }) });
    const prov = createElevenLabsApiProvider({ keyStore: empty, fetchImpl: async () => res(200, {}) });
    check("B not-configured code", (await prov.testConnection()).code === "API_KEY_NOT_CONFIGURED");
  }

  // ---- C. error classification ----
  const mkProv = (fetchImpl) => createElevenLabsApiProvider({ keyStore: store, fetchImpl });
  check("C 401 -> API_KEY_INVALID", (await mkProv(async () => res(401, {}, { text: "unauthorized" })).testConnection()).code === "API_KEY_INVALID");
  check("C 403 ip -> IP_NOT_ALLOWED", (await mkProv(async () => res(403, {}, { text: "ip address not allowed" })).testConnection()).code === "IP_NOT_ALLOWED");
  check("C 403 other -> API_PERMISSION_DENIED", (await mkProv(async () => res(403, {}, { text: "missing permission" })).testConnection()).code === "API_PERMISSION_DENIED");
  check("C 429 -> API_QUOTA_EXHAUSTED", (await mkProv(async () => res(429, {}, { text: "quota" })).testConnection()).code === "API_QUOTA_EXHAUSTED");
  check("C network throw -> PROVIDER_ERROR transient", (await mkProv(async () => { throw new Error("net"); }).testConnection()).code === "PROVIDER_ERROR");

  // ---- D. testConnection ok + usage ----
  {
    const prov = mkProv(async () => res(200, { character_count: 1200, character_limit: 100000, tier: "creator" }));
    const r = await prov.testConnection();
    check("D auth ok + usage parsed", r.ok === true && r.usage.characterCount === 1200 && r.usage.tier === "creator");
    check("D health persisted ok", (await store.metadata()).lastHealth === "ok");
  }

  // ---- E. listVoices -> official voice_id ----
  const voicesBody = { voices: [
    { voice_id: "e336504eb956419d8f09e26bd514f906", name: "Charlotte", category: "premade", labels: { accent: "british" } },
    { voice_id: "5fecb720a9bc44e8a006c2bf7d7d01ef", name: "Sarah", category: "premade" },
    { voice_id: "aaaa1111", name: "Sarah", category: "cloned" }
  ] };
  {
    const prov = mkProv(async () => res(200, voicesBody));
    const r = await prov.listVoices();
    check("E lists official voice ids", r.ok && r.voices[0].officialVoiceId === "e336504eb956419d8f09e26bd514f906" && r.voices[0].displayName === "Charlotte");
  }

  // ---- F. resolveVoice: unique / ambiguous / not found ----
  {
    const prov = mkProv(async () => res(200, voicesBody));
    check("F unique Charlotte", (await prov.resolveVoice("Charlotte")).voice.officialVoiceId === "e336504eb956419d8f09e26bd514f906");
    const amb = await prov.resolveVoice("Sarah");
    check("F ambiguous Sarah -> VOICE_AMBIGUOUS + candidates (no guess)", amb.ok === false && amb.code === "VOICE_AMBIGUOUS" && amb.candidates.length === 2);
    check("F not found -> VOICE_NOT_FOUND", (await prov.resolveVoice("Zzz")).code === "VOICE_NOT_FOUND");
  }

  // ---- G. synthesize: mp3 validated + SHA-256 + idempotent; no retry on 4xx ----
  {
    const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(600, 1)]);
    let calls = 0;
    const prov = createElevenLabsApiProvider({ keyStore: store, fetchImpl: async () => { calls += 1; return res(200, mp3); } });
    const out = path.join(dir, "sample.mp3");
    const r1 = await prov.synthesize({ text: "Kort test.", officialVoiceId: "e336504e", outputPath: out, idempotencyKey: "k1" });
    check("G synth ok + sha256 + mp3", r1.ok && r1.sizeBytes === mp3.length && /^[0-9a-f]{64}$/.test(r1.sha256) && r1.container === "mp3");
    const r2 = await prov.synthesize({ text: "Kort test.", officialVoiceId: "e336504e", outputPath: out, idempotencyKey: "k1" });
    check("G idempotent: same key does not re-submit", calls === 1 && r2.sha256 === r1.sha256);
    let calls2 = 0;
    const prov2 = createElevenLabsApiProvider({ keyStore: store, fetchImpl: async () => { calls2 += 1; return res(401, {}, { text: "unauthorized" }); } });
    const rf = await prov2.synthesize({ text: "x", officialVoiceId: "v", outputPath: path.join(dir, "x.mp3"), idempotencyKey: "k2" });
    check("G no retry on 401 (auth), one call, code surfaced", rf.ok === false && rf.code === "API_KEY_INVALID" && calls2 === 1);
  }

  // ---- H. remove ----
  await store.remove();
  check("H removed -> not configured", (await store.isConfigured()) === false);

  console.log(`Step 5C.19 elevenlabs api: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.log("FATAL", e); process.exit(1); });
