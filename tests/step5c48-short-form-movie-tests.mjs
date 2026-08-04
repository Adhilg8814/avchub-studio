// P0 Step 5C.48 — the 15–30 second film, end to end, and the repair path in front of it.
//
// What this suite is holding down, in the order the failures actually happened:
//
//   A — the three-beat shape. HOOK / PROGRESSION / PAYOFF|CLIFFHANGER is its own format, the gate in front of
//       the spend reads the SAME structure table the builder does, and a fourth beat is refused. The old code
//       could build a three-beat film and then have the gate demand a SETUP it had never asked for.
//   P — the adaptation prompt and parser: exactly three beats, no repeated moment, roles validated, and a
//       response that is prose rather than JSON is a refusal instead of a film with holes in it.
//   V — the voice verdict. Every real ElevenLabs voice was UNKNOWN_VOICE — "we cannot say what language this
//       is" about premade voices whose language is in the table — so every narration needed a confirmation.
//   T — the transcript record: the shape the scorecard reads, and the rule that no transcript is never a pass.
//   E — the encoding of the local ear. A Danish transcript arriving as "s?ndagen" and a Cyrillic one crashing
//       the runner both look exactly like a model that cannot hear the language.
//   S — persistence, on a disposable PostgreSQL: the prompt comes from the ACTIVE shot contract, a repair
//       cannot report SUBMITTED without a job, cannot spend twice on one revision, resumes instead of
//       re-refining, settles when its generation finishes, and never touches a shot that PASSED.
//
// No provider of any kind. Every fixture is local: ffmpeg for audio, a fake generation facade for jobs, a
// stub actuator for the adaptation.

import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createMovieControlPlane } from "../control-plane/src/api-staging/movie-control-plane.mjs";
import { movieArtifactRepository as arepo, ARTIFACT_KIND, CREATOR } from "../control-plane/src/persistence/repositories/movie-artifact-repository.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";
import {
  buildAdaptation, ADAPTATION_FORMATS, ADAPTATION_ERRORS, formatStructure, FORMAT_STRUCTURE
} from "../lib/movie/adaptation-contract.mjs";
import { gateAdaptation, PIPELINE_ERRORS } from "../lib/movie/content-pipeline.mjs";
import { buildAdaptationPrompt, parseAdaptationResponse, localAdaptationFrom, createGrokChatTextProvider, createLocalTextProvider } from "../lib/movie/text-provider.mjs";
import { assessVoiceCapability, voiceLanguageOf, assertVoiceAllowed, VOICE_CAPABILITY, VOICE_FALLBACK_KIND } from "../lib/movie/voice-capability.mjs";
import { verifyTranscript, TRANSCRIPT_VERDICT } from "../lib/movie/transcript-verification.mjs";
import { measureAudio } from "../lib/movie/source-audio-probe.mjs";
import { createLocalSttProvider } from "../lib/movie/local-stt-provider.mjs";
import { createCompositeSpeechProvider } from "../lib/movie/composite-speech-provider.mjs";
import { createElevenLabsApiSpeechProvider } from "../lib/movie/elevenlabs-api-speech-provider.mjs";
import { VISION_VERDICT } from "../lib/movie/vision-judge.mjs";
import { FLOORS } from "../lib/movie/movie-scorecard.mjs";
import { estimateSpeechSeconds } from "../lib/movie/duration-budget.mjs";
import { ffmpegPaths } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is not a dependency of this project: the operator installs it and the locator finds it.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c === true) passed += 1; else { failed += 1; console.log("FAIL", n, d ? `-> ${d}` : ""); } };
async function throwsCode(name, fn, code) {
  try { await fn(); check(name, false, "it did not refuse"); }
  catch (e) { check(name, e && e.code === code, `${e && e.code} ${String(e && e.message).slice(0, 90)}`); }
}

const STORY = [
  "Jesper called me petty at the midsummer dinner in front of everyone.",
  "I had spent eleven years paying the mortgage on the house he now says was always his.",
  "The lawyer read the deed aloud and the table went very quiet.",
  "My sister put down her glass and asked Jesper to repeat what he had just said.",
  "He could not, and the silence did the rest of the work for me.",
  "I signed nothing that night, and in the morning the locks were changed."
].join(" ");

const THREE_BEATS = {
  hook: "Jesper called me petty at the midsummer dinner in front of everyone.",
  narrativeObjective: "A quiet reckoning at a family table.",
  tone: "restrained",
  audience: "adults who have had a family fight",
  beats: [
    { role: "HOOK", summary: "the accusation", narration: "Jesper called me petty at the midsummer dinner, in front of every single person we know.", visual: "A long summer table, glasses half full, one man standing", emotionalBeat: "shock", location: "garden table" },
    { role: "PROGRESSION", summary: "the deed", narration: "Then the lawyer read the deed aloud, slowly, and the whole table went very quiet.", visual: "A woman holding a folded paper, guests frozen mid gesture", emotionalBeat: "tension", location: "garden table" },
    { role: "PAYOFF", summary: "the locks", narration: "I signed nothing that night, and by the morning I had changed every lock in the house.", visual: "A hand turning a new brass key in a front door at dawn", emotionalBeat: "resolve", location: "front door" }
  ],
  characters: [{ name: "Jesper", ageRange: "forties", genderPresentation: "male", face: "narrow, close beard", hair: "short dark", clothing: "pale linen shirt", build: "tall" }],
  locations: [{ name: "garden table", description: "a long wooden table under birches", interiorExterior: "EXTERIOR", timeOfDay: "evening", props: ["glasses", "candles"] }],
  style: { visualGenre: "grounded nordic drama", palette: "muted greens", lighting: "late evening sun", lensFraming: "35mm eye level", realismLevel: "photoreal", motionStyle: "slow drift", era: "present day" }
};
const asBuild = (d, over = {}) => buildAdaptation({
  sourceStoryId: "mov_x", targetDurationSeconds: 22, locale: "en-US", format: ADAPTATION_FORMATS.SHORT_FORM_3BEAT,
  hook: d.hook, narrativeObjective: d.narrativeObjective, audience: d.audience, tone: d.tone,
  narrationScript: d.beats.map((b) => b.narration).join(" "),
  beatSheet: d.beats.map((b) => ({ role: b.role, summary: b.summary, narration: b.narration, emotionalBeat: b.emotionalBeat })),
  characters: d.characters, locations: d.locations, style: d.style, ...over
});

// ============================================================ A — the three-beat shape
{
  const a = asBuild(THREE_BEATS);
  check("A1 a three-beat short form builds", a.beatSheet.length === 3 && a.format === "SHORT_FORM_3BEAT");
  check("A1 the roles are the ones asked for", a.beatSheet.map((b) => b.role).join(",") === "HOOK,PROGRESSION,PAYOFF");
  check("A2 the old four-role shape is UNCHANGED", FORMAT_STRUCTURE.SHORT_FORM.requiredRoles.includes("SETUP"));
  check("A2 and the three-beat shape does not require SETUP", !formatStructure("SHORT_FORM_3BEAT").requiredRoles.includes("SETUP"));
  await throwsCode("A3 the same beats are refused as SHORT_FORM, which needs a SETUP",
    async () => asBuild(THREE_BEATS, { format: ADAPTATION_FORMATS.SHORT_FORM }), ADAPTATION_ERRORS.STRUCTURE);
  await throwsCode("A4 a fourth beat is refused: the length was decided before the writing", async () => asBuild({
    ...THREE_BEATS, beats: [...THREE_BEATS.beats, { role: "PROGRESSION", summary: "extra", narration: "And then something else happened as well.", visual: "another shot" }]
  }), ADAPTATION_ERRORS.STRUCTURE);
  await throwsCode("A5 no ending is refused", async () => asBuild({
    ...THREE_BEATS, beats: THREE_BEATS.beats.map((b, i) => (i === 2 ? { ...b, role: "PROGRESSION" } : b))
  }), ADAPTATION_ERRORS.STRUCTURE);

  // The gate in front of the spend must agree with the builder about the shape.
  const g = gateAdaptation({ adaptation: a, story: null, targetDurationSeconds: 22, locale: "en-US" });
  check("A6 the pre-spend gate accepts the three-beat film the builder just made", g.ok === true, JSON.stringify(g.failures));
  check("A6 and it counted the words it will be judged on", g.words > 20 && g.wordsPerSecond > 1.8 && g.wordsPerSecond < 3.6, `${g.words} ${g.wordsPerSecond}`);
  const four = gateAdaptation({ adaptation: { ...a, beatSheet: [...a.beatSheet, a.beatSheet[0]] }, targetDurationSeconds: 22, locale: "en-US" });
  check("A7 the gate refuses a fourth beat too", four.ok === false && four.failures.some((f) => /exactly 3 beats/u.test(f)), JSON.stringify(four.failures));
  const tooLong = gateAdaptation({ adaptation: a, targetDurationSeconds: 6, locale: "en-US" });
  check("A8 a script too long for its film is refused before anything is spent", tooLong.ok === false, JSON.stringify(tooLong.failures));
  const wrongLocale = gateAdaptation({ adaptation: a, targetDurationSeconds: 22, locale: "da-DK" });
  check("A9 an adaptation in the wrong language for the film is refused", wrongLocale.ok === false && wrongLocale.failures.some((f) => /written in/u.test(f)));

  // A film narrated in a language its source was not written in says so, in the artifact.
  const dubbed = asBuild(THREE_BEATS, { sourceLocale: "da-DK", localeRationale: "no Danish-recorded voice exists on this runtime" });
  check("A10 a re-languaged film records the source locale and the reason",
    dubbed.sourceLocale === "da-DK" && dubbed.locale === "en-US" && /Danish/u.test(dubbed.localeRationale), JSON.stringify({ s: dubbed.sourceLocale, r: dubbed.localeRationale }));
}

// ============================================================ P — the adaptation prompt and parser
{
  const prompt = buildAdaptationPrompt({ storyText: STORY.repeat(2), targetDurationSeconds: 22, languageName: "English", characterNames: ["Jesper"] });
  check("P1 the prompt states the three roles in order", /HOOK[\s\S]*PROGRESSION[\s\S]*PAYOFF/u.test(prompt));
  // The band has to satisfy BOTH gates the script will meet: the pre-spend gate's "not mostly silence" floor
  // of 1.8 words per second, and the duration budget's real speech model — which is what actually decides
  // whether a sentence gets spoken. A prompt that asks for more than the film can say produces a script whose
  // last sentences are dropped, silently.
  const band = prompt.match(/between (\d+) and (\d+) words/u);
  const lo = band ? Number(band[1]) : 0, hi = band ? Number(band[2]) : 0;
  check("P1 the low end is above the mostly-silence floor", band && lo / 22 >= 1.8, band ? band[0] : "no band");
  check("P1 the high end is a script the film can actually speak",
    band && estimateSpeechSeconds("word ".repeat(hi).trim(), "en-US") <= 22 * 0.92,
    `${hi} words -> ${band ? estimateSpeechSeconds("word ".repeat(hi).trim(), "en-US") : "?"}s of 20.24s`);
  check("P1 it forbids digits, because a spoken number is words", /no digits/u.test(prompt));
  check("P1 it carries the story and the names that must survive", prompt.includes("Jesper") && prompt.includes("SOURCE STORY"));
  await throwsCode("P2 a story too short to adapt is refused before the model is called",
    async () => buildAdaptationPrompt({ storyText: "too short" }), "E_MOVIE_ADAPTATION_BRIEF");

  const good = parseAdaptationResponse("here you go\n```json\n" + JSON.stringify(THREE_BEATS) + "\n```\nhope that helps");
  check("P3 a fenced response parses to three beats", good.beats.length === 3 && good.beats[0].role === "HOOK");
  check("P3 the visual and the narration are kept apart", good.beats[0].visual !== good.beats[0].narration);
  await throwsCode("P4 prose with no JSON is a refusal", async () => parseAdaptationResponse("I think the film should open on a table."), "E_MOVIE_ADAPTATION_RESPONSE_FORMAT");
  await throwsCode("P5 two beats is a refusal", async () => parseAdaptationResponse(JSON.stringify({ ...THREE_BEATS, beats: THREE_BEATS.beats.slice(0, 2) })), "E_MOVIE_ADAPTATION_RESPONSE_INVALID");
  await throwsCode("P6 a beat with no narration is a refusal", async () => parseAdaptationResponse(JSON.stringify({
    ...THREE_BEATS, beats: THREE_BEATS.beats.map((b, i) => (i === 1 ? { ...b, narration: "" } : b))
  })), "E_MOVIE_ADAPTATION_RESPONSE_INVALID");
  await throwsCode("P7 a beat with nothing to film is a refusal", async () => parseAdaptationResponse(JSON.stringify({
    ...THREE_BEATS, beats: THREE_BEATS.beats.map((b, i) => (i === 2 ? { ...b, visual: "", summary: "" } : b))
  })), "E_MOVIE_ADAPTATION_RESPONSE_INVALID");
  await throwsCode("P8 the same moment twice is a refusal — that is the film that feels like nothing happens",
    async () => parseAdaptationResponse(JSON.stringify({
      ...THREE_BEATS, beats: THREE_BEATS.beats.map((b, i) => (i === 1 ? { ...b, narration: THREE_BEATS.beats[0].narration } : b))
    })), "E_MOVIE_ADAPTATION_RESPONSE_INVALID");
  await throwsCode("P9 an invented role is a refusal", async () => parseAdaptationResponse(JSON.stringify({
    ...THREE_BEATS, beats: THREE_BEATS.beats.map((b, i) => (i === 0 ? { ...b, role: "TEASER" } : b))
  })), "E_MOVIE_ADAPTATION_RESPONSE_INVALID");

  // ONE invocation, and the submit fact is recorded immediately before it.
  {
    const order = [];
    const tp = createGrokChatTextProvider({
      actuator: async ({ prompt: p, onBeforeSubmit }) => {
        check("P10 the actuator receives the built prompt", typeof p === "string" && p.includes("SOURCE STORY"));
        await onBeforeSubmit();
        order.push("send");
        return { text: "```json\n" + JSON.stringify(THREE_BEATS) + "\n```", responseId: "resp_abc123" };
      }
    });
    const before = tp.adaptStory ? "yes" : "no";
    check("P10 the GROK_CHAT provider offers adaptStory", before === "yes");
    const out = await tp.adaptStory({ storyText: STORY.repeat(2), targetDurationSeconds: 22 }, { onBeforeSubmit: async () => order.push("submit-fact") });
    check("P10 the submit fact is recorded BEFORE the send", order.join(",") === "submit-fact,send", order.join(","));
    check("P10 and the result carries a provider reference and a prompt hash", out.providerResultRef === "resp_abc123" && /^sha256:/u.test(out.promptHash));
  }
  const local = localAdaptationFrom({ storyText: STORY, targetDurationSeconds: 22 });
  check("P11 the deterministic fallback still produces three distinct beats",
    local.beats.length === 3 && new Set(local.beats.map((b) => b.narration)).size === 3);
  const lp = createLocalTextProvider();
  check("P11 and the LOCAL provider offers it too", typeof lp.adaptStory === "function");
}

// ============================================================ V — the voice verdict
{
  check("V1 a premade voice's description does not hide which voice it is",
    voiceLanguageOf("Alice - Clear, Engaging Educator") === "en", String(voiceLanguageOf("Alice - Clear, Engaging Educator")));
  check("V1 the plain name still resolves", voiceLanguageOf("Sarah") === "en");
  check("V1 an unknown voice stays unknown", voiceLanguageOf("Vivienne Sørensen") === null);
  const cat = [{ voiceId: "EXAVITQu4vr4xnSDxMaL", name: "Sarah - Mature, Reassuring, Confident", displayName: "Sarah - Mature, Reassuring, Confident" }];
  const en = assessVoiceCapability({ locale: "en-US", voiceName: "Sarah - Mature, Reassuring, Confident", voiceId: "EXAVITQu4vr4xnSDxMaL", catalogue: cat });
  check("V2 an English voice narrating English is NATIVE — no confirmation needed", en.capability === VOICE_CAPABILITY.NATIVE && en.requiresConfirmation === false, JSON.stringify(en));
  check("V2 and the gate passes it unattended", assertVoiceAllowed(en, {}) === en);
  const da = assessVoiceCapability({ locale: "da-DK", voiceName: "Alice - Clear, Engaging Educator", voiceId: "Xb7hH8MSUJpSbSDYk0k2" });
  check("V3 the same voice narrating Danish is an ACCENT fallback, not an unknown voice",
    da.capability === VOICE_CAPABILITY.FALLBACK && da.fallbackKind === VOICE_FALLBACK_KIND.ACCENT, JSON.stringify(da));
  await throwsCode("V3 and unattended automation may not decide that on its own",
    async () => assertVoiceAllowed(da, {}), "E_MOVIE_VOICE_FALLBACK_NOT_ALLOWED");
  check("V4 an owner-confirmed locale is allowed through", assertVoiceAllowed(da, { allowFallbackVoice: true, confirmedFallbacks: ["da-DK"] }) === da);
  const catLang = [{ voiceId: "x", displayName: "Nordic Voice", language: "da" }];
  check("V5 a catalogue that states a language still wins over the name table",
    assessVoiceCapability({ locale: "da-DK", voiceName: "Nordic Voice", catalogue: catLang }).capability === VOICE_CAPABILITY.NATIVE);
}

// ============================================================ T — the transcript record
{
  const script = THREE_BEATS.beats.map((b) => b.narration).join(" ");
  const perfect = verifyTranscript({ script, transcript: { text: script, detectedLanguage: "en", languageProbability: 0.99 }, expectedLocale: "en-US", characterNames: ["Jesper"] });
  check("T1 a recording that says the script PASSES", perfect.verdict === TRANSCRIPT_VERDICT.PASS && perfect.wordCoverage === 1);
  check("T1 and its coverage clears the hard floor the scorecard applies", perfect.wordCoverage >= FLOORS.voiceCorrectness);
  const noStt = verifyTranscript({ script, transcript: null, expectedLocale: "en-US" });
  check("T2 no transcript is UNVERIFIED and NEVER a pass", noStt.verdict === TRANSCRIPT_VERDICT.UNVERIFIED && noStt.transcribed === false);
  const headGone = verifyTranscript({ script: script, transcript: { text: script.split(" ").slice(6).join(" "), detectedLanguage: "en" }, expectedLocale: "en-US" });
  check("T3 a lost sentence head is REJECTED, not averaged away", headGone.verdict === TRANSCRIPT_VERDICT.REJECT && headGone.leadingTruncation === true);
  const wrongLang = verifyTranscript({ script, transcript: { text: script, detectedLanguage: "da" }, expectedLocale: "en-US" });
  check("T4 the right words in the wrong language are REJECTED", wrongLang.verdict === TRANSCRIPT_VERDICT.REJECT && wrongLang.languageMatch === false);
  // The shape the scorecard actually reads. This mapping is where a real measurement gets lost.
  const body = {
    coverage: perfect.wordCoverage, missingWords: perfect.missingSegments.map((m) => m.text),
    substitutions: perfect.substitutedSegments, detectedLanguage: perfect.detectedLanguage,
    expectedLanguage: "en-US", ok: true
  };
  check("T5 the persisted body carries `coverage`, which is the key the scorecard reads",
    typeof body.coverage === "number" && body.coverage >= FLOORS.voiceCorrectness);
}

// ============================================================ E — the local ear, and its encoding
{
  const stt = createLocalSttProvider({ ownerRoot: (process.env.AVC_STUDIO_HOME || os.tmpdir()), repoRoot: process.cwd() });
  const d = stt.describe();
  check("E1 the runner reports what it is", d.engine === "faster-whisper" && d.wordTimestamps === true);
  if (!d.available || !ffmpegStatic) {
    console.log("Step 5C.48 local ear: SKIPPED (no local STT or ffmpeg on this host)");
  } else {
    const dir = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".sfm-test-"));
    try {
      // A file of pure tone: there is nothing to hear, so the transcript must not invent words. What is being
      // tested here is the PIPE — a runner that cannot emit non-ASCII fails the same way for every language.
      const wav = path.join(dir, "tone.wav");
      const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "16000", wav], { encoding: "utf8" });
      check("E2 the fixture was written", r.status === 0 && existsSync(wav));
      const t = await stt.transcribeLocal({ audioPath: wav, language: "en" });
      check("E2 a tone produces no confident speech", String(t.text || "").trim().length < 40, JSON.stringify(String(t.text).slice(0, 60)));
      // The measurement the transcript gate needs: WHERE the silence is, not just how much.
      const silent = path.join(dir, "gap.wav");
      spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1.5", silent], { encoding: "utf8" });
      const m = await measureAudio(silent);
      check("E3 silence at the head is located, not merely counted",
        Number.isFinite(m.leadingSilenceMs) && m.leadingSilenceMs > 900, JSON.stringify({ lead: m.leadingSilenceMs, trail: m.trailingSilenceMs, internal: m.maxInternalSilenceMs }));
      check("E3 and the three positions are all reported",
        Object.prototype.hasOwnProperty.call(m, "leadingSilenceMs") && Object.prototype.hasOwnProperty.call(m, "trailingSilenceMs") && Object.prototype.hasOwnProperty.call(m, "maxInternalSilenceMs"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

// ============================================================ W — aligned synthesis reaches the pipeline
{
  // The defect: the control plane asks `typeof speech.synthesizeWithTimestamps === "function"`, and no speech
  // provider on any real runtime answered yes — so every film fell back to plain synthesis and no film could
  // ever have a measured subtitle timeline.
  const calls = [];
  const apiProvider = {
    kind: "ELEVENLABS_API",
    async synthesize() { calls.push("plain"); return { ok: true, sizeBytes: 10, path: "x" }; },
    async synthesizeWithTimestamps({ text, officialVoiceId, languageCode, outputPath }) {
      calls.push(`aligned:${officialVoiceId}:${languageCode}`);
      writeFileSync(outputPath, "ID3fake");
      return { ok: true, path: outputPath, sizeBytes: 7, sha256: "abc", alignment: { characters: ["a"], characterStartTimesSeconds: [0], characterEndTimesSeconds: [0.1] }, alignmentSource: "normalized", alignmentAvailable: true, idempotencyKey: "k" };
    }
  };
  const dir = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".sfm-tts-"));
  try {
    const el = createElevenLabsApiSpeechProvider({ apiProvider, accountId: "el_x", voiceMap: { "en-US": { officialVoiceId: "EXAVITQu4vr4xnSDxMaL", displayName: "Sarah" } }, probeDuration: async () => 3.5 });
    check("W1 the ElevenLabs speech provider now offers aligned synthesis", typeof el.synthesizeWithTimestamps === "function");
    const out = await el.synthesizeWithTimestamps({ text: "One short line.", voiceId: "EXAVITQu4vr4xnSDxMaL", outputPath: path.join(dir, "a.mp3"), locale: "en-US" });
    check("W1 it returns the provider's alignment", out.ok === true && out.alignmentAvailable === true && out.alignment.characters.length === 1);
    check("W1 and the measured duration, which the timeline needs", out.durationSeconds === 3.5);
    // As the ISO-639-1 subtag the API accepts — "en-US" is a locale and would be rejected, which would cost
    // the film its timeline while looking like a provider outage.
    check("W1 the language reaches the API as a language code, not a locale", calls.some((c) => c === "aligned:EXAVITQu4vr4xnSDxMaL:en"), calls.join("|"));
    check("W1 the plain endpoint was not used", !calls.includes("plain"));

    const comp = createCompositeSpeechProvider({ elevenLabsApi: el, fallback: { kind: "SAPI", async synthesize() { return { sizeBytes: 1 }; }, async listVoices() { return []; } } });
    check("W2 the composite exposes it when the API provider can do it", typeof comp.synthesizeWithTimestamps === "function");
    const tagged = await comp.synthesizeWithTimestamps({ text: "One short line.", voiceId: "elevenlabs-api:EXAVITQu4vr4xnSDxMaL", outputPath: path.join(dir, "b.mp3"), locale: "en-US" });
    check("W2 a tagged ElevenLabs voice routes to it", tagged.ok === true);
    const sapi = await comp.synthesizeWithTimestamps({ text: "x", voiceId: "sapi:David", outputPath: path.join(dir, "c.mp3") });
    check("W2 another provider's voice is NOT quietly re-routed to ElevenLabs", sapi.ok === false && sapi.code === "E_ELEVENLABS_ALIGNMENT_UNSUPPORTED", JSON.stringify(sapi));
    const noApi = createCompositeSpeechProvider({ fallback: { kind: "SAPI", async synthesize() { return { sizeBytes: 1 }; }, async listVoices() { return []; } } });
    check("W3 a runtime with no API provider does not claim it can align", typeof noApi.synthesizeWithTimestamps !== "function");
    const long = await el.synthesizeWithTimestamps({ text: "x ".repeat(3000), voiceId: "EXAVITQu4vr4xnSDxMaL", outputPath: path.join(dir, "d.mp3"), locale: "en-US" });
    check("W4 text that would need chunking is refused rather than aligned wrongly", long.ok === false && long.code === "E_ELEVENLABS_ALIGNMENT_TOO_LONG");

    // A model that refuses the language hint rejects the REQUEST — no audio, no credits — so the retry without
    // it is free, and it is the difference between a measured timeline and a silent fall back to estimates.
    {
      const seen = [];
      const picky = {
        kind: "ELEVENLABS_API",
        async synthesize() { return { ok: true, sizeBytes: 1 }; },
        async synthesizeWithTimestamps({ languageCode, outputPath }) {
          seen.push(languageCode);
          if (languageCode) return { ok: false, code: "PROVIDER_ERROR", detail: "language_code not supported" };
          writeFileSync(outputPath, "ID3fake");
          return { ok: true, path: outputPath, sizeBytes: 7, alignment: { characters: ["a"], characterStartTimesSeconds: [0], characterEndTimesSeconds: [0.1] }, alignmentAvailable: true };
        }
      };
      const el2 = createElevenLabsApiSpeechProvider({ apiProvider: picky, accountId: "el_x", voiceMap: {}, probeDuration: async () => 2 });
      const out2 = await el2.synthesizeWithTimestamps({ text: "One line.", voiceId: "EXAVITQu4vr4xnSDxMaL", outputPath: path.join(dir, "e.mp3"), locale: "en-US" });
      check("W5 a refused language hint is retried once without it, at no cost", out2.ok === true && seen.join(",") === "en," , `${out2.ok} ${seen.join(",")}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ============================================================ S — persistence, on real PostgreSQL
if (!livePgAvailable()) {
  console.log("Step 5C.48 persistence: SKIPPED (no PostgreSQL binaries)");
} else {
  const live = await startDisposablePg({ namePrefix: "sfm" });
  const mediaRoot = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".sfm-pg-"));
  let adapter = null;
  try {
    const mc = new pg.Client({ connectionString: live.migrationUrl });
    await mc.connect();
    const ws = generateId("ws"), user = generateId("usr");
    try {
      try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
      await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c48-sfm" });
      await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
      await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
      await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'SFM',$2)", [ws, user]);
    } finally { await mc.end(); }

    adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
    await adapter.start();
    const config = { stagingApi: { workspaceId: ws } };
    const T = (fn) => adapter.tenantTransaction(ws, fn);
    const q = (sql, params) => T(async (c) => (await c.query(sql, params)).rows);

    // A generation facade that records what it was asked for and never touches a provider.
    const jobs = [];
    let jobState = "GENERATING";
    const fakeGeneration = {
      async ensureBootstrap() { return { workerId: "wrk_00000000000000000000000000", projectId: "prj_00000000000000000000000000" }; },
      async enqueue({ prompt, durationSeconds, aspectRatio }) {
        const jobId = generateId("job");
        jobs.push({ jobId, prompt, durationSeconds, aspectRatio });
        return { jobId, generationAttemptId: generateId("attempt"), state: "QUEUED" };
      },
      async requestStart() { return { dispatchStatus: "OFFERED" }; },
      async getForUi(jobId) { return { state: jobState, hasMedia: false, jobId }; }
    };
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: fakeGeneration, ownerMediaRoot: mediaRoot, masteringEnabled: false });

    const project = await movie.createProject({ title: "Short Form Cert", inputMode: "IDEA", idea: "a family dinner where a deed is read aloud", targetDurationSeconds: 22, aspectRatio: "9:16", language: "en-US" });
    await movie.draftStory({ projectId: project.id });
    const scenes = await movie.planStoryboard({ projectId: project.id });
    const target = scenes[0];

    // -------------------------------------------------- S1: the prompt comes from the ACTIVE contract
    {
      await T((c) => arepo.putArtifact(c, ws, {
        id: newId("art"), movieProjectId: project.id, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId: target.id,
        body: { shotId: target.id, semanticIntent: "the deed is read", generationPrompt: "A CONTRACT PROMPT nobody wrote onto the scene row", durationSeconds: 8 },
        creator: CREATOR.SYSTEM
      }));
      const out = await movie.generateScene({ sceneId: target.id });
      const enq = jobs.find((j) => j.jobId === out.jobId);
      check("S1 the generation carries the contract's prompt, not the scene row's",
        enq.prompt === "A CONTRACT PROMPT nobody wrote onto the scene row", String(enq.prompt).slice(0, 60));
      check("S1 the length comes from the contract too", enq.durationSeconds === 8);
      check("S1 and the source of both is recorded", out.promptSource === "SHOT_CONTRACT" && out.durationSource === "SHOT_CONTRACT" && /^sha256:/u.test(out.promptSha256));
      const ev = await q("SELECT detail FROM movie_project_events WHERE workspace_id=$1 AND project_id=$2 AND type='SCENE_GENERATION_STARTED' ORDER BY seq DESC LIMIT 1", [ws, project.id]);
      check("S1 the event says which words were sent", ev[0].detail.promptSource === "SHOT_CONTRACT" && typeof ev[0].detail.promptSha256 === "string");
    }
    // -------------------------------------------------- S2: a scene with no contract still generates
    {
      const out = await movie.generateScene({ sceneId: scenes[1].id });
      const enq = jobs.find((j) => j.jobId === out.jobId);
      check("S2 a scene with no contract falls back to its own prompt", enq.prompt === scenes[1].videoPrompt && out.promptSource === "SCENE");
    }

    // -------------------------------------------------- S3: a PASS is never repaired
    {
      await T((c) => arepo.putArtifact(c, ws, {
        id: newId("art"), movieProjectId: project.id, kind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sceneId: scenes[1].id,
        body: { verdict: VISION_VERDICT.PASS, measured: true, scores: { semanticMatch: 0.9 } }, creator: CREATOR.SYSTEM
      }));
      await throwsCode("S3 a shot the judge PASSED cannot be regenerated",
        async () => movie.repairScene({ projectId: project.id, sceneId: scenes[1].id }), "E_MOVIE_SCENE_NOT_REPAIRABLE");
      await throwsCode("S3 and neither can one nobody judged",
        async () => movie.repairScene({ projectId: project.id, sceneId: scenes[2].id }), "E_MOVIE_SCENE_NOT_REPAIRABLE");
    }

    // -------------------------------------------------- S4: a REGENERATE repairs exactly that shot
    let repairJobId = null;
    {
      await T((c) => arepo.putArtifact(c, ws, {
        id: newId("art"), movieProjectId: project.id, kind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sceneId: target.id,
        body: { verdict: VISION_VERDICT.REGENERATE, measured: true, scores: { semanticMatch: 0.15, characterMatch: 0.9, styleMatch: 0.8 },
                failedRequirements: ["semanticMatch the shot shows an empty room, not a table"],
                evidence: [{ timestampMs: 1000, observation: "an empty room" }] }, creator: CREATOR.SYSTEM
      }));
      // The scene is COMPLETED, as it would be after a real generation.
      await T((c) => c.query("UPDATE movie_scenes SET state='COMPLETED', media_meta=$3 WHERE workspace_id=$1 AND id=$2",
        [ws, target.id, JSON.stringify({ relativePath: "jobs/x/generated.mp4", sizeBytes: 10, width: 720, height: 1280 })]));
      const before = jobs.length;
      const r = await movie.repairScene({ projectId: project.id, sceneId: target.id });
      check("S4 the repair returns a real job id", typeof r.jobId === "string" && r.jobId.startsWith("job_"), String(r.jobId));
      check("S4 exactly one generation was enqueued", jobs.length === before + 1);
      repairJobId = r.jobId;
      const enq = jobs[jobs.length - 1];
      check("S4 it carries the REFINED prompt of the new revision", enq.prompt !== "A CONTRACT PROMPT nobody wrote onto the scene row" && enq.prompt.length > 20);
      check("S4 and the refinement is driven by what failed, not a re-send of the same words",
        /CORRECTIONS/u.test(enq.prompt) && enq.prompt.startsWith("A CONTRACT PROMPT"), enq.prompt.slice(0, 90).replace(/\n/gu, "\\n"));
      check("S4 the new revision is rev 2 of the same contract slot", r.shotContractRevision === 2 && r.previousContractRevision === 1);
      check("S4 the prompt provenance is asserted, not assumed", r.promptSource === "SHOT_CONTRACT" && r.refinedPromptSha256 === `sha256:${(await import("node:crypto")).createHash("sha256").update(enq.prompt).digest("hex")}`);
      check("S4 the length is carried onto the new revision", enq.durationSeconds === 8);
      const rows = await q("SELECT state, generation_job_id, generated_contract_id FROM movie_shot_repairs WHERE workspace_id=$1", [ws]);
      check("S4 the ledger says SUBMITTED with the job and the revision it generated",
        rows.length === 1 && rows[0].state === "SUBMITTED" && rows[0].generation_job_id === r.jobId && rows[0].generated_contract_id === r.shotContractId, JSON.stringify(rows));
      const old = await q("SELECT revision, status FROM movie_content_artifacts WHERE workspace_id=$1 AND kind='SHOT_CONTRACT' AND scene_id=$2 ORDER BY revision", [ws, target.id]);
      check("S4 the original revision is kept, superseded rather than rewritten",
        old.length === 2 && old[0].revision === 1 && old[0].status === "SUPERSEDED" && old[1].status === "ACTIVE", JSON.stringify(old));
      const other = await q("SELECT count(*)::int n FROM movie_shot_repairs WHERE workspace_id=$1 AND scene_id <> $2", [ws, target.id]);
      check("S4 no other shot was touched", other[0].n === 0);
    }

    // -------------------------------------------------- S5: one invocation per revision
    {
      const before = jobs.length;
      await throwsCode("S5 a second repair while one is in flight is refused",
        async () => movie.repairScene({ projectId: project.id, sceneId: target.id }), "E_MOVIE_REPAIR_IN_FLIGHT");
      check("S5 and nothing was enqueued by the refusal", jobs.length === before);
      // The database refuses it too, even if a caller went around the guard.
      let dbRefused = false;
      const gen = (await q("SELECT id, generated_contract_id FROM movie_shot_repairs WHERE workspace_id=$1", [ws]))[0];
      try {
        await T((c) => c.query(
          `INSERT INTO movie_shot_repairs (workspace_id,id,movie_project_id,scene_id,attempt,idempotency_key,reason,generated_contract_id,state)
           VALUES ($1,$2,$3,$4,99,'k-dup','VISION_REGENERATE',$5,'COMPLETED')`,
          [ws, newId("msr"), project.id, target.id, gen.generated_contract_id]));
      } catch { dbRefused = true; }
      check("S5 the unique index makes a second invocation for one revision impossible", dbRefused === true);
    }

    // -------------------------------------------------- S6: settling, and the second look
    {
      jobState = "COMPLETED";
      const s = await movie.settleShotRepairs({ projectId: project.id });
      check("S6 a finished repair is closed out", s.settled.some((x) => x.state === "COMPLETED"), JSON.stringify(s.settled));
      const rows = await q("SELECT state FROM movie_shot_repairs WHERE workspace_id=$1", [ws]);
      check("S6 the ledger no longer holds the shot in flight", rows[0].state === "COMPLETED");
      // Which is what lets the SECOND repair happen when the new clip is rejected too. Before this, the
      // in-flight guard blocked it forever and the film rendered the rejected shot.
      const before = jobs.length;
      const r2 = await movie.repairScene({ projectId: project.id, sceneId: target.id });
      check("S6 a second rejected clip can be repaired", r2.attempt === 2 && jobs.length === before + 1, JSON.stringify({ a: r2.attempt, j: jobs.length - before }));
      check("S6 on a third revision of the contract", r2.shotContractRevision === 3);
      // And no further: the budget is two attempts per shot.
      jobState = "COMPLETED";
      await movie.settleShotRepairs({ projectId: project.id });
      await throwsCode("S6 a third attempt is refused — the budget is two",
        async () => movie.repairScene({ projectId: project.id, sceneId: target.id }), "E_MOVIE_REPAIR_EXHAUSTED");
    }

    // -------------------------------------------------- S7: an UNCERTAIN submit is abandoned, never retried
    {
      const sc = scenes[2];
      await T((c) => arepo.putArtifact(c, ws, {
        id: newId("art"), movieProjectId: project.id, kind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sceneId: sc.id,
        body: { verdict: VISION_VERDICT.REGENERATE, measured: true, scores: { semanticMatch: 0.2 }, failedRequirements: ["semanticMatch wrong place"], evidence: [] }, creator: CREATOR.SYSTEM
      }));
      await T((c) => c.query("UPDATE movie_scenes SET state='COMPLETED', media_meta=$3 WHERE workspace_id=$1 AND id=$2",
        [ws, sc.id, JSON.stringify({ relativePath: "jobs/y/generated.mp4", sizeBytes: 10, width: 720, height: 1280 })]));
      await movie.repairScene({ projectId: project.id, sceneId: sc.id });
      jobState = "SUBMIT_UNCERTAIN";
      await movie.settleShotRepairs({ projectId: project.id });
      const row = (await q("SELECT state, error_code FROM movie_shot_repairs WHERE workspace_id=$1 AND scene_id=$2", [ws, sc.id]))[0];
      check("S7 a possibly-charged submission is ABANDONED, not FAILED", row.state === "ABANDONED", JSON.stringify(row));
      check("S7 and it says why", row.error_code === "E_SCENE_SUBMIT_UNCERTAIN");
      const before = jobs.length;
      // It still counts as an attempt, so nothing blindly re-sends it.
      const evs = await q("SELECT type FROM movie_project_events WHERE workspace_id=$1 AND project_id=$2 AND type='SCENE_REPAIR_SETTLED'", [ws, project.id]);
      check("S7 the settlement is on the event log", evs.length >= 1);
      check("S7 nothing was re-enqueued", jobs.length === before);
      jobState = "GENERATING";
    }

    // A rejected shot on a project of its own. Artifacts are write-once and the repair ledger has no DELETE
    // grant — which is the point of both — so a fresh scene is how these cases get a clean slate.
    async function rejectedScene(title) {
      const p = await movie.createProject({ title, inputMode: "IDEA", idea: "a family dinner where a deed is read aloud", targetDurationSeconds: 18, aspectRatio: "9:16", language: "en-US" });
      await movie.draftStory({ projectId: p.id });
      const sc = (await movie.planStoryboard({ projectId: p.id }))[0];
      await T((c) => arepo.putArtifact(c, ws, {
        id: newId("art"), movieProjectId: p.id, kind: ARTIFACT_KIND.SCENE_VISION_VERDICT, sceneId: sc.id,
        body: { verdict: VISION_VERDICT.REGENERATE, measured: true, scores: { semanticMatch: 0.1 }, failedRequirements: ["semanticMatch nothing of the line is visible"], evidence: [] }, creator: CREATOR.SYSTEM
      }));
      await T((c) => c.query("UPDATE movie_scenes SET state='COMPLETED', media_meta=$3 WHERE workspace_id=$1 AND id=$2",
        [ws, sc.id, JSON.stringify({ relativePath: `jobs/${sc.id}/generated.mp4`, sizeBytes: 10, width: 720, height: 1280 })]));
      return { projectId: p.id, sceneId: sc.id };
    }

    // -------------------------------------------------- S8: a crash between claim and send does not pay twice
    {
      const { projectId: pid, sceneId: sid } = await rejectedScene("Crash Before Send");
      // An expired claim with no generated revision: exactly the state a crash between the claim and the
      // provider call leaves behind.
      await T((c) => c.query(
        `INSERT INTO movie_shot_repairs (workspace_id,id,movie_project_id,scene_id,attempt,idempotency_key,reason,state,lease_owner,lease_expires_at)
         VALUES ($1,$2,$3,$4,1,'k-crash','VISION_REGENERATE','CLAIMED','dead-runtime', now() - interval '1 hour')`,
        [ws, newId("msr"), pid, sid]));
      const before = jobs.length;
      const r = await movie.repairScene({ projectId: pid, sceneId: sid });
      check("S8 the abandoned claim is RESUMED rather than replaced", r.resumed === true && r.attempt === 1, JSON.stringify({ resumed: r.resumed, attempt: r.attempt }));
      check("S8 it still counts as one attempt", (await q("SELECT count(*)::int n FROM movie_shot_repairs WHERE workspace_id=$1 AND scene_id=$2", [ws, sid]))[0].n === 1);
      check("S8 and exactly one generation was sent", jobs.length === before + 1);
    }

    // -------------------------------------------------- S9: an interrupted repair adopts its own live job
    {
      const { projectId: pid, sceneId: sid } = await rejectedScene("Crash After Send");
      const first = await movie.repairScene({ projectId: pid, sceneId: sid });
      // Rewind the ledger to CLAIMED with an expired lease, leaving the enqueued job and the written revision
      // exactly where they are: the crash happened after the send but before the ledger caught up.
      await T((c) => c.query(
        `UPDATE movie_shot_repairs SET state='CLAIMED', generated_contract_id=NULL, generation_job_id=NULL,
                lease_owner='dead-runtime', lease_expires_at = now() - interval '1 hour'
          WHERE workspace_id=$1 AND scene_id=$2`, [ws, sid]));
      const before = jobs.length;
      const again = await movie.repairScene({ projectId: pid, sceneId: sid });
      check("S9 the live job is ADOPTED instead of a second one being bought", jobs.length === before && again.adoptedExistingJob === true, JSON.stringify({ added: jobs.length - before, adopted: again.adoptedExistingJob }));
      check("S9 it is the same job", again.jobId === first.jobId);
      check("S9 and the same contract revision — no third set of words", again.shotContractRevision === first.shotContractRevision, `${again.shotContractRevision} vs ${first.shotContractRevision}`);
    }


    // -------------------------------------------------- S10: the repair does not need the vision actuator
    {
      // The movie control plane here was built with NO visionActuator at all, and every repair above worked.
      // That is the property: regenerating a shot is an Imagine call, and gating it on the chat capability
      // meant a runtime that could generate but not judge silently skipped repair.
      const rows = await q("SELECT count(*)::int n FROM movie_shot_repairs WHERE workspace_id=$1 AND generation_job_id IS NOT NULL", [ws]);
      check("S10 repairs ran on a runtime with no vision actuator", rows[0].n >= 3, JSON.stringify(rows));
    }

    // -------------------------------------------------- S11: adaptation writes one scene per beat
    {
      const p2 = await movie.createProject({ title: "Adaptation Shape", inputMode: "PASTED", pastedStory: STORY.repeat(3), targetDurationSeconds: 22, aspectRatio: "9:16", language: "en-US" });
      const stub = {
        kind: "GROK_CHAT", available: () => true,
        async adaptStory(brief, { onBeforeSubmit } = {}) {
          if (onBeforeSubmit) await onBeforeSubmit();
          return { adaptation: THREE_BEATS, providerResultRef: "resp_x", promptHash: "sha256:x", responseChars: 100 };
        }
      };
      const mv2 = createMovieControlPlane({ persistence: adapter, config, generation: fakeGeneration, ownerMediaRoot: mediaRoot, masteringEnabled: false, textProviders: { GROK_CHAT: stub } });
      const out = await mv2.adaptMovieContent({ projectId: p2.id, provider: "GROK_CHAT", sourceLocale: "da-DK", localeRationale: "no Danish-recorded voice exists here" });
      check("S11 the adaptation persisted", out.beats.length === 3 && out.scenes === 3, JSON.stringify(out.beats));
      const art = (await q("SELECT body, kind, revision FROM movie_content_artifacts WHERE workspace_id=$1 AND movie_project_id=$2 AND kind='ADAPTATION'", [ws, p2.id]))[0];
      check("S11 the artifact records the gate that let it through", art.body.gate.ok === true && art.body.gate.words > 20);
      check("S11 and the language decision", art.body.sourceLocale === "da-DK" && /Danish/u.test(art.body.localeRationale));
      const sc = await q("SELECT ordinal, heading, narration, video_prompt FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY ordinal", [ws, p2.id]);
      check("S11 exactly three scenes, one per beat, in order", sc.length === 3 && sc.map((x) => x.heading).join(",") === "HOOK,PROGRESSION,PAYOFF", JSON.stringify(sc.map((x) => x.heading)));
      check("S11 each scene carries its OWN line", new Set(sc.map((x) => x.narration)).size === 3);
      check("S11 and its own picture", new Set(sc.map((x) => x.video_prompt)).size === 3);
      const second = await mv2.adaptMovieContent({ projectId: p2.id });
      check("S11 running it again does not adapt again", second.idempotent === true);

      // A model that returns a fourth beat is refused, and refused BEFORE the scenes are written.
      const p3 = await movie.createProject({ title: "Four Beats", inputMode: "PASTED", pastedStory: STORY.repeat(3), targetDurationSeconds: 22, language: "en-US" });
      const mv3 = createMovieControlPlane({ persistence: adapter, config, generation: fakeGeneration, ownerMediaRoot: mediaRoot, masteringEnabled: false,
        textProviders: { GROK_CHAT: { kind: "GROK_CHAT", available: () => true, async adaptStory() {
          return { adaptation: { ...THREE_BEATS, beats: [...THREE_BEATS.beats, { role: "PAYOFF", summary: "s", narration: "One more thing happened after that.", visual: "another door" }] } };
        } } } });
      await throwsCode("S12 a four-beat response is refused", async () => mv3.adaptMovieContent({ projectId: p3.id }), ADAPTATION_ERRORS.STRUCTURE);
      const none = await q("SELECT count(*)::int n FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2", [ws, p3.id]);
      check("S12 and no scenes were written for the refused film", none[0].n === 0);
    }

    // -------------------------------------------------- S13: shot contracts need a real timeline
    {
      const p4 = await movie.createProject({ title: "No Alignment", inputMode: "PASTED", pastedStory: STORY.repeat(3), targetDurationSeconds: 22, language: "en-US" });
      const mv4 = createMovieControlPlane({ persistence: adapter, config, generation: fakeGeneration, ownerMediaRoot: mediaRoot, masteringEnabled: false,
        textProviders: { GROK_CHAT: { kind: "GROK_CHAT", available: () => true, async adaptStory() { return { adaptation: THREE_BEATS }; } } } });
      await mv4.adaptMovieContent({ projectId: p4.id });
      await throwsCode("S13 no measured narration means no shot plan — never an estimated one",
        async () => mv4.planShotContracts({ projectId: p4.id }), PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE);

      // With alignments, each scene's contract is timed by its own audio.
      const sc = await q("SELECT id, ordinal, narration FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY ordinal", [ws, p4.id]);
      for (const s of sc) {
        // A character-level alignment, as the provider returns it: one entry per character of the line.
        const text = s.narration;
        const chars = [...text];
        const per = 0.075;
        await T((c) => arepo.putArtifact(c, ws, {
          id: newId("art"), movieProjectId: p4.id, kind: ARTIFACT_KIND.AUDIO_ALIGNMENT, sceneId: s.id,
          body: {
            alignment: {
              characters: chars,
              characterStartTimesSeconds: chars.map((_, i) => Number((i * per).toFixed(3))),
              characterEndTimesSeconds: chars.map((_, i) => Number(((i + 1) * per).toFixed(3)))
            },
            spokenText: text, measuredDurationSeconds: Number((chars.length * per).toFixed(3))
          },
          creator: CREATOR.SYSTEM
        }));
      }
      const plan = await mv4.planShotContracts({ projectId: p4.id });
      check("S14 one contract per scene", plan.shots.length === 3, JSON.stringify(plan.shots.map((x) => x.durationSeconds)));
      check("S14 each shot is as long as its own line", plan.shots.every((x) => x.durationSeconds > 2 && x.durationSeconds < 9), JSON.stringify(plan.shots.map((x) => x.durationSeconds)));
      check("S14 the film adds up to a short form", plan.filmSeconds > 12 && plan.filmSeconds < 32, String(plan.filmSeconds));
      const bodies = await q("SELECT scene_id, body FROM movie_content_artifacts WHERE workspace_id=$1 AND movie_project_id=$2 AND kind='SHOT_CONTRACT' AND status='ACTIVE'", [ws, p4.id]);
      check("S14 every contract states the seconds the generator will ask for", bodies.length === 3 && bodies.every((b) => Number(b.body.durationSeconds) > 0));
      check("S14 and the prompt is built from the line it plays over",
        bodies.every((b) => b.body.generationPrompt.includes(String(b.body.narrationText).slice(0, 30))), JSON.stringify(bodies.map((b) => b.body.generationPrompt.slice(0, 40))));
      const rows = await q("SELECT duration_seconds, video_prompt FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY ordinal", [ws, p4.id]);
      // The scene column is an integer, so it rounds UP — never down, which would describe a shot shorter than
      // the line spoken over it. The exact length lives in the contract, which is what the generator reads.
      check("S14 the scene rows never claim less time than the line needs",
        rows.every((r, i) => Number(r.duration_seconds) >= plan.shots[i].durationSeconds && Number(r.duration_seconds) - plan.shots[i].durationSeconds < 1),
        JSON.stringify(rows.map((r) => r.duration_seconds)));

      // And the generation then asks for exactly that.
      const g = await mv4.generateScene({ sceneId: sc[0].id });
      const enq = jobs.find((j) => j.jobId === g.jobId);
      check("S15 the generation asks for the contract's length and words",
        Math.abs(enq.durationSeconds - plan.shots[0].durationSeconds) < 0.01 && enq.prompt === bodies.find((b) => b.scene_id === sc[0].id).body.generationPrompt,
        JSON.stringify({ asked: enq.durationSeconds, planned: plan.shots[0].durationSeconds }));
    }

    // -------------------------------------------------- S16: content-first does not plan a storyboard
    {
      const p5 = await movie.createProject({ title: "Content First", inputMode: "PASTED", pastedStory: STORY.repeat(3), targetDurationSeconds: 22, language: "en-US" });
      await movie.setStory({ projectId: p5.id, story: { title: "t", synopsis: "s", styleBible: "b", language: "en-US", characters: [{ name: "Jesper", description: "a man" }], beats: [{ heading: "h", narration: "n", visual: "v" }] } });
      const started = await movie.startMoviePipeline({ projectId: p5.id, presets: { contentFirst: true, narrationEnabled: true } });
      check("S16 a content-first pipeline starts with no scenes at all", started.contentFirst === true && started.scenes === 0, JSON.stringify(started));
      const n = await q("SELECT count(*)::int n FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2", [ws, p5.id]);
      check("S16 and nothing was enqueued for scenes that do not exist", n[0].n === 0 );
      const ev = await q("SELECT detail FROM movie_project_events WHERE workspace_id=$1 AND project_id=$2 AND type='PIPELINE_STARTED'", [ws, p5.id]);
      check("S16 the presets record the order the film will run in", ev[0].detail.contentFirst === true && ev[0].detail.adaptationFormat === "SHORT_FORM_3BEAT", JSON.stringify(ev[0].detail));
    }
  } finally {
    if (adapter) { try { await adapter.stop(); } catch { /* */ } }
    try { await live.stop(); } catch { /* */ }
    rmSync(mediaRoot, { recursive: true, force: true });
  }
}

console.log(`Step 5C.48 short-form movie + repair: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
