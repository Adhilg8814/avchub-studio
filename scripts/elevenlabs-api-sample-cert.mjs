// P0 Step 5C.20 — ELEVENLABS_API certification: resolve the official voice map + synthesize short
// per-locale samples through the REAL ElevenLabs API (eleven_multilingual_v2), EXACTLY-ONCE.
//
// Voice policy (owner decision 2026-07-21): "Helen" is the official replacement of legacy "Charlotte" —
// resolve it EXACTLY first; if the API account does not expose Helen, fall back to Alice
// (Xb7hH8MSUJpSbSDYk0k2) for bg-BG + da-DK. sv-SE is always Sarah (EXAVITQu4vr4xnSDxMaL). NEVER guess a
// voice: every mapping is either a unique name resolution or an owner-fixed id.
//
// Exactly-once: a persistent ledger records each completed sample (locale, idempotencyKey, sha256). A
// re-run with an unchanged (voice, model, text) and a valid on-disk mp3 whose sha matches is a NO-OP (no
// second quota charge). The key is fetched from the DPAPI store per request and never printed/logged.
//
// Usage:
//   node scripts/elevenlabs-api-sample-cert.mjs --account-id el_… --out <dir> [--locales bg-BG,da-DK,sv-SE]
//   node scripts/elevenlabs-api-sample-cert.mjs --account-id el_… --out <dir> --map-only   (0 quota)

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElevenLabsApiCredentialRegistry } from "../lib/movie/elevenlabs-api-key-store.mjs";
import { createElevenLabsApiProvider } from "../lib/movie/elevenlabs-api-provider.mjs";
import { makeDpapiRunner } from "../lib/worker/credential-store.mjs";
import { ffmpegPaths } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is GPL and is NOT bundled: the operator installs it and this resolves where it landed.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

const EL_ID = /^el_[0-9a-f]{20}$/;
const MODEL = "eleven_multilingual_v2";
const FORMAT = "mp3_44100_128";
// Fixed fallback ids (owner-confirmed) — present in this account's default premade set.
const ALICE = "Xb7hH8MSUJpSbSDYk0k2";
const SARAH = "EXAVITQu4vr4xnSDxMaL";
// Short, one-sentence per-locale probes (kept minimal to spend the least quota).
const SAMPLE_TEXT = {
  "bg-BG": "Това е кратък тест на гласа.",
  "da-DK": "Dette er en kort stemmetest.",
  "sv-SE": "Detta är ett kort röstprov."
};

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
function ffprobe(file) {
  return new Promise((resolve) => {
    const c = spawn(ffprobeStaticPath, ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", file]);
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("error", () => resolve(null));
    c.on("close", () => { try { const j = JSON.parse(out); const s = (j.streams || [])[0] || {}; resolve({ codec: s.codec_name || null, sampleRate: s.sample_rate ? Number(s.sample_rate) : null, channels: s.channels ?? null, duration: j.format && Number(j.format.duration) ? Number(j.format.duration) : null }); } catch { resolve(null); } });
  });
}
function loadJson(p, def) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return def; } }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

async function main() {
  const accountId = arg("account-id");
  const outDir = arg("out");
  const mapOnly = process.argv.includes("--map-only");
  const locales = (arg("locales") || "bg-BG,da-DK,sv-SE").split(",").map((s) => s.trim()).filter(Boolean);
  if (!accountId || !EL_ID.test(accountId)) { console.log(JSON.stringify({ ok: false, code: "API_KEY_INVALID", detail: "bad --account-id" })); process.exit(1); }
  if (!outDir) { console.log(JSON.stringify({ ok: false, code: "BAD_ARGS", detail: "missing --out" })); process.exit(1); }
  const baseDir = path.join(process.env.LOCALAPPDATA, "AVCStudioWorker", "elevenlabs-api");
  const store = createElevenLabsApiCredentialRegistry({ baseDir, runner: makeDpapiRunner({ spawn }) }).store(accountId);
  const prov = createElevenLabsApiProvider({ keyStore: store, fetchImpl: globalThis.fetch });

  // ---- 1. enumerate + persist the account voice catalog (official voice_id is canonical identity) ----
  const cat = await prov.listVoices();
  if (!cat.ok) { console.log(JSON.stringify({ ok: false, code: cat.code, stage: "listVoices" })); process.exit(1); }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "voice-catalog.json"), JSON.stringify({ accountId, provider: "ELEVENLABS_API", model: MODEL, count: cat.voices.length, voices: cat.voices, updatedAt: Date.now() }, null, 2));

  // ---- 2. resolve the locale → official voice map (Helen first, Alice fallback, Sarah unique) ----
  const helen = await prov.resolveVoice("Helen");
  const bgDaVoice = helen.ok ? helen.voice.officialVoiceId : ALICE;
  const bgDaVia = helen.ok ? "unique_helen" : "fallback_alice_helen_absent";
  const bgDaName = helen.ok ? helen.voice.displayName : (cat.voices.find((v) => v.officialVoiceId === ALICE)?.displayName || "Alice");
  const sarah = await prov.resolveVoice("Sarah");
  const svVoice = sarah.ok ? sarah.voice.officialVoiceId : SARAH;
  const svName = sarah.ok ? sarah.voice.displayName : (cat.voices.find((v) => v.officialVoiceId === SARAH)?.displayName || "Sarah");
  const mapPath = path.join(outDir, "voice-map.json");
  const prevMap = loadJson(mapPath, null);
  const voiceMap = {
    accountId, provider: "ELEVENLABS_API", model: MODEL, updatedAt: Date.now(),
    map: {
      "bg-BG": { officialVoiceId: bgDaVoice, displayName: bgDaName, requestedName: "Helen", legacyName: "Charlotte", resolvedVia: bgDaVia, webObservedIdentity: null },
      "da-DK": { officialVoiceId: bgDaVoice, displayName: bgDaName, requestedName: "Helen", legacyName: "Charlotte", resolvedVia: bgDaVia, webObservedIdentity: null },
      "sv-SE": { officialVoiceId: svVoice, displayName: svName, requestedName: "Sarah", legacyName: "Sarah", resolvedVia: sarah.ok ? "unique_sarah" : "fixed_sarah_id", webObservedIdentity: null }
    },
    history: [...((prevMap && prevMap.history) || []), ...(prevMap ? [{ at: prevMap.updatedAt, map: prevMap.map }] : [])].slice(-10)
  };
  writeFileSync(mapPath, JSON.stringify(voiceMap, null, 2));

  if (mapOnly) { console.log(JSON.stringify({ ok: true, stage: "map", accountId, helenPresent: helen.ok, map: Object.fromEntries(Object.entries(voiceMap.map).map(([k, v]) => [k, { officialVoiceId: v.officialVoiceId, displayName: v.displayName, resolvedVia: v.resolvedVia }])) })); process.exit(0); }

  // ---- 3. synthesize short samples EXACTLY-ONCE (ledger-guarded) ----
  const samplesDir = path.join(outDir, "samples"); mkdirSync(samplesDir, { recursive: true });
  const ledgerPath = path.join(outDir, "sample-ledger.json");
  const ledger = loadJson(ledgerPath, { accountId, provider: "ELEVENLABS_API", model: MODEL, samples: {} });
  const results = [];
  for (const locale of locales) {
    const text = SAMPLE_TEXT[locale];
    const voiceId = voiceMap.map[locale] ? voiceMap.map[locale].officialVoiceId : null;
    if (!text || !voiceId) { results.push({ locale, ok: false, code: "NO_MAPPING" }); continue; }
    const outPath = path.join(samplesDir, `${locale}.mp3`);
    const idk = createHash("sha256").update(`${voiceId}|${MODEL}|${FORMAT}|${text}`).digest("hex");
    const prev = ledger.samples[locale];
    // exactly-once: same idempotencyKey + valid on-disk mp3 + matching sha => NO re-submit
    if (prev && prev.idempotencyKey === idk && existsSync(outPath) && statSync(outPath).size > 256 && sha256File(outPath) === prev.sha256) {
      const pf = await ffprobe(outPath);
      results.push({ locale, ok: true, skipped: true, voiceId, sizeBytes: prev.sizeBytes, sha256: prev.sha256, ffprobe: pf });
      continue;
    }
    const r = await prov.synthesize({ text, officialVoiceId: voiceId, modelId: MODEL, outputFormat: FORMAT, outputPath: outPath, idempotencyKey: idk });
    if (!r.ok) { results.push({ locale, ok: false, code: r.code, voiceId }); continue; }
    const pf = await ffprobe(outPath);
    ledger.samples[locale] = { locale, voiceId, idempotencyKey: idk, sha256: r.sha256, sizeBytes: r.sizeBytes, textChars: text.length, createdAt: Date.now(), ffprobe: pf };
    results.push({ locale, ok: true, skipped: false, voiceId, sizeBytes: r.sizeBytes, sha256: r.sha256, ffprobe: pf });
  }
  ledger.updatedAt = Date.now();
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  // ---- 4. technical PASS gate: every requested sample is a valid mp3 with a positive duration + DISTINCT sha ----
  const okSamples = results.filter((r) => r.ok);
  const shas = okSamples.map((r) => r.sha256).filter(Boolean);
  const distinct = new Set(shas).size === shas.length;
  const allValid = okSamples.length === locales.length && okSamples.every((r) => r.ffprobe && r.ffprobe.duration > 0 && (r.ffprobe.codec === "mp3"));
  const technicalPass = allValid && distinct;
  console.log(JSON.stringify({
    ok: technicalPass, stage: "sample-cert", technicalPass, distinctSha: distinct,
    note: "technical PASS only (valid mp3 + ffprobe duration + distinct sha256); NOT a human/native-pronunciation PASS",
    helenPresent: helen.ok, accountId,
    results: results.map((r) => ({ locale: r.locale, ok: r.ok, code: r.code || null, skipped: r.skipped || false, voiceId: r.voiceId || null, sizeBytes: r.sizeBytes || null, sha256: r.sha256 || null, duration: r.ffprobe && r.ffprobe.duration, codec: r.ffprobe && r.ffprobe.codec, sampleRate: r.ffprobe && r.ffprobe.sampleRate }))
  }, null, 2));
  process.exit(technicalPass ? 0 : 1);
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, code: "UNEXPECTED", detail: (e && e.message) || String(e) })); process.exit(1); });
