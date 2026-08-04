// P0 Step 5C.20 — ELEVENLABS_API SpeechProvider + composite routing (no network, fake apiProvider).
// Proves: the API provider is PRIMARY in the composite; tagged voiceIds route strictly to their own
// provider (no silent cross-provider fallback); the API speech adapter resolves the official voice_id from
// a tagged id or the locale map and emits the Movie-Factory contract shape.
import { createCompositeSpeechProvider } from "../lib/movie/composite-speech-provider.mjs";
import { createElevenLabsApiSpeechProvider } from "../lib/movie/elevenlabs-api-speech-provider.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log("FAIL", n); } };
const throwsAsync = async (n, fn, code) => { try { await fn(); failed++; console.log("FAIL(no throw)", n); } catch (e) { if (!code || e.code === code) passed++; else { failed++; console.log("FAIL(code)", n, "got", e.code); } } };

const dir = mkdtempSync(path.join(os.tmpdir(), "el-api-speech-"));
// fake api provider: writes a tiny valid-looking mp3 and records the call
const calls = [];
const fakeApi = {
  async synthesize({ text, officialVoiceId, modelId, outputFormat, outputPath, idempotencyKey }) {
    calls.push({ text, officialVoiceId, modelId, outputFormat, outputPath, idempotencyKey });
    writeFileSync(outputPath, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(400, 7)]));
    return { ok: true, path: outputPath, sizeBytes: 403, sha256: "a".repeat(64), container: "mp3", voiceId: officialVoiceId, idempotencyKey };
  }
};
const VOICE_MAP = {
  "bg-BG": { officialVoiceId: "Xb7hH8MSUJpSbSDYk0k2", displayName: "Alice - Clear, Engaging Educator" },
  "da-DK": { officialVoiceId: "Xb7hH8MSUJpSbSDYk0k2", displayName: "Alice - Clear, Engaging Educator" },
  "sv-SE": { officialVoiceId: "EXAVITQu4vr4xnSDxMaL", displayName: "Sarah - Mature, Reassuring, Confident" }
};

async function run() {
  const api = createElevenLabsApiSpeechProvider({ apiProvider: fakeApi, accountId: "el_06ba09f2ddf6f2836010", voiceMap: VOICE_MAP, probeDuration: async () => 1.9 });
  check("A provider builds with kind ELEVENLABS_API", api && api.kind === "ELEVENLABS_API");

  // ---- A. listVoices exposes official ids per mapped locale ----
  const vs = api.listVoices();
  check("A listVoices carries official ids", vs.some((v) => v.id === "Xb7hH8MSUJpSbSDYk0k2" && v.culture === "da-DK") && vs.some((v) => v.id === "EXAVITQu4vr4xnSDxMaL"));

  // ---- B. synthesize by EXPLICIT official voice id ----
  const out1 = path.join(dir, "s1.wav");
  const r1 = await api.synthesize({ text: "Dette er en kort test.", voiceId: "Xb7hH8MSUJpSbSDYk0k2", outputPath: out1 });
  check("B synth returns contract shape (mp3 container, ELEVENLABS_API)", r1.container === "mp3" && r1.provider === "ELEVENLABS_API" && r1.voiceName === "Xb7hH8MSUJpSbSDYk0k2" && r1.sizeBytes === 403 && r1.durationSeconds === 1.9);
  check("B forwarded the official id + multilingual model to the api provider", calls[0].officialVoiceId === "Xb7hH8MSUJpSbSDYk0k2" && calls[0].modelId === "eleven_multilingual_v2");

  // ---- C. synthesize by LOCALE (map resolution), never a display name ----
  const out2 = path.join(dir, "s2.wav");
  await api.synthesize({ text: "Detta är ett kort test.", locale: "sv-SE", outputPath: out2 });
  check("C locale sv-SE resolved to Sarah official id", calls[1].officialVoiceId === "EXAVITQu4vr4xnSDxMaL");

  // ---- D. no voice mapped / bad id -> VOICE_CONFIGURATION_REQUIRED (never guesses) ----
  await throwsAsync("D unmapped locale rejected", () => api.synthesize({ text: "x", locale: "fr-FR", outputPath: path.join(dir, "s3.wav") }), "E_ELEVENLABS_VOICE_CONFIGURATION_REQUIRED");
  await throwsAsync("D non-id voiceId with no locale rejected", () => api.synthesize({ text: "x", voiceId: "Charlotte", outputPath: path.join(dir, "s4.wav") }), "E_ELEVENLABS_VOICE_CONFIGURATION_REQUIRED");

  // ---- E. composite: API is PRIMARY; strict tag routing; no silent fallback ----
  const webCalls = [], sapiCalls = [];
  const web = { kind: "ELEVENLABS_WEB", listVoices: () => [{ id: "Charlotte", name: "Charlotte" }], synthesize: async (a) => { webCalls.push(a); return { container: "mp3", provider: "ELEVENLABS_WEB" }; } };
  const sapi = { kind: "WINDOWS_SAPI", listVoices: () => [{ id: "Zira", name: "Zira" }], synthesize: async (a) => { sapiCalls.push(a); return { container: "wav", provider: "WINDOWS_SAPI" }; } };
  const comp = createCompositeSpeechProvider({ elevenLabsApi: api, elevenLabs: web, fallback: sapi });
  check("E primaryKind is ELEVENLABS_API", comp.primaryKind === "ELEVENLABS_API");
  const all = await comp.listVoices();
  check("E listVoices tags every provider", all.some((v) => v.id.startsWith("elevenlabs-api:")) && all.some((v) => v.id.startsWith("elevenlabs:")) && all.some((v) => v.id.startsWith("sapi:")));
  const before = calls.length;
  await comp.synthesize({ text: "route me", voiceId: "elevenlabs-api:Xb7hH8MSUJpSbSDYk0k2", outputPath: path.join(dir, "c1.wav") });
  check("E elevenlabs-api: tag routes to API only (not web/sapi)", calls.length === before + 1 && webCalls.length === 0 && sapiCalls.length === 0);
  await comp.synthesize({ text: "route web", voiceId: "elevenlabs:Charlotte", outputPath: path.join(dir, "c2.wav") });
  check("E elevenlabs: tag routes to Web only", webCalls.length === 1 && webCalls[0].voiceId === "Charlotte");
  await comp.synthesize({ text: "route sapi", voiceId: "sapi:Zira", outputPath: path.join(dir, "c3.wav") });
  check("E sapi: tag routes to SAPI only", sapiCalls.length === 1 && sapiCalls[0].voiceId === "Zira");
  // untagged legacy voice -> SAPI fallback (back-compat)
  await comp.synthesize({ text: "legacy", voiceId: "Zira", outputPath: path.join(dir, "c4.wav") });
  check("E untagged legacy voice -> SAPI fallback", sapiCalls.length === 2);

  console.log(`Step 5C.20 api speech provider: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.log("FATAL", e); process.exit(1); });
