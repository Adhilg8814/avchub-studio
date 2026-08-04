// P0 Step 5C.36 — DURATION-AWARE RENDER + VOICE GATE, end to end on REAL PostgreSQL + REAL ffmpeg.
//
// The pure suite proves the plan is right. This proves the FILM is: real clips, real audio, real ffmpeg,
// real probe of the finished file. A 10-second target has to come out 10 seconds — measured, not intended —
// with its narration whole and its subtitles inside the picture.
//
// Provider-free by construction: the generation facade is a fake that writes local test clips, and the
// speech provider writes a real short wav. No Grok, no ElevenLabs, no quota.

import { mkdtempSync, rmSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createMovieControlPlane } from "../control-plane/src/api-staging/movie-control-plane.mjs";
import { createMovieAssembler } from "../lib/movie/movie-assembler.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { DURATION_ERRORS } from "../lib/movie/duration-budget.mjs";
import { VOICE_ERRORS } from "../lib/movie/voice-capability.mjs";
import { ffmpegPaths } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is not a dependency of this project: the operator installs it and the locator finds it.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n, d); } };
async function refuses(name, fn, code) {
  try { await fn(); check(name, false, "expected a refusal"); }
  catch (e) { const got = String(e && e.code || ""); if (got === code) passed += 1; else { failed += 1; console.log("FAIL", name, "->", got || (e && e.message)); } }
}

if (!livePgAvailable() || !ffmpegStatic) { console.log("Step 5C.36 duration render: 0 passed, 0 failed (SKIPPED — no PostgreSQL/ffmpeg)"); process.exit(0); }

const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "avc-5c36-"));
const probe = (file) => {
  const r = spawnSync(ffprobeStaticPath, ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", file], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((x) => x.codec_type === "video");
  const a = (j.streams || []).find((x) => x.codec_type === "audio");
  return { seconds: Number(j.format.duration), width: v && v.width, height: v && v.height, video: v && v.codec_name, audio: a && a.codec_name };
};

// The three real Danish lines the production movie carries.
const NARRATION = [
  "Jeg sad over for dem i det kommunale mødelokale.",
  "Sagsbehandleren bad os sidde.",
  "Om søndagen sad jeg i køkkenet og kiggede ud på haven."
];

// A generation fake that writes CLIPS OF A CHOSEN LENGTH, so "clip shorter/longer than its slot" is a real
// file on disk rather than a number in a test.
function makeGen(clipSeconds = 6) {
  const jobs = new Map();
  return {
    async ensureBootstrap() { return { workerId: "wrk_00000000000000000000000000", projectId: "prj_00000000000000000000000000" }; },
    async enqueue({ aspectRatio }) { const jobId = generateId("job"); jobs.set(jobId, { jobId, aspectRatio: aspectRatio || "9:16", polled: 0, seconds: Array.isArray(clipSeconds) ? clipSeconds[jobs.size % clipSeconds.length] : clipSeconds }); return { jobId, generationAttemptId: generateId("attempt"), state: "QUEUED" }; },
    async requestStart() { return { dispatchStatus: "OFFERED", offerId: "off_x" }; },
    async getForUi(jobId) {
      const j = jobs.get(jobId); if (!j) return null; j.polled += 1;
      if (j.polled < 2) return { jobId, state: "PROCESSING", hasMedia: false };
      const dir = path.join(mediaRoot, "jobs", jobId); mkdirSync(dir, { recursive: true });
      const clip = path.join(dir, "generated.mp4");
      if (!existsSync(clip)) {
        const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", `testsrc=size=720x1280:rate=30:duration=${j.seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", String(j.seconds), clip], { windowsHide: true });
        if (r.status !== 0) return { jobId, state: "PROCESSING", hasMedia: false };
      }
      return { jobId, state: "COMPLETED", hasMedia: true, resultId: "res_" + jobId.slice(-8), media: { sizeBytes: statSync(clip).size, container: "mp4", durationSeconds: j.seconds, width: 720, height: 1280 } };
    }
  };
}
// Speech that produces audio of the length the TEXT would really take, so the render-time verification is
// exercised against something meaningful rather than a constant.
function makeSpeech(secondsFor) {
  return {
    kind: "TESTTTS",
    listVoices: async () => [{ voiceId: "test-voice", label: "Test" }],
    async synthesize({ text, outputPath }) {
      const secs = Math.max(0.4, secondsFor ? secondsFor(text) : Math.max(0.6, String(text || "").length / 13));
      mkdirSync(path.dirname(outputPath), { recursive: true });
      const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", `sine=frequency=220:duration=${secs.toFixed(2)}`, "-ac", "1", outputPath], { windowsHide: true });
      if (r.status !== 0) throw Object.assign(new Error("tts"), { code: "E_TTS_FAILED" });
      return { sizeBytes: statSync(outputPath).size, durationSeconds: Number(secs.toFixed(3)) };
    }
  };
}

const live = await startDisposablePg({ namePrefix: "dur36" });
let adapter = null;
try {
  const ws = generateId("ws"), user = generateId("usr");
  const mc = new pg.Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
    await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "dur36" });
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'DUR36',$2)", [ws, user]);
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const config = { stagingApi: { workspaceId: ws } };
  const assembler = createMovieAssembler();

  const storyFor = (texts) => ({
    title: "Duration probe", synopsis: "A probe.", language: "da-DK", genre: "drama",
    styleBible: "cinematic", characters: [{ name: "Karen", description: "the narrator" }],
    beats: texts.map((t, i) => ({ heading: `Scene ${i + 1}`, narration: t, visual: `shot ${i + 1}` }))
  });

  // Build a project whose scenes are COMPLETED with real clips on disk.
  async function makeMovie(movie, gen, { target, texts = NARRATION }) {
    const p = await movie.createProject({ title: "Duration probe", language: "da-DK", targetDurationSeconds: target, aspectRatio: "9:16", inputMode: "IDEA", idea: "probe" });
    await movie.setStory({ projectId: p.id, story: storyFor(texts) });
    await movie.planStoryboard({ projectId: p.id });
    const scenes = await movie.listScenes(p.id);
    for (const s of scenes) await movie.generateScene({ projectId: p.id, sceneId: s.id });
    for (let i = 0; i < 4; i += 1) await movie.refreshScenes({ projectId: p.id });
    return p.id;
  }

  // ============================================================ 1. a 10-second target really is 10 seconds
  {
    const gen = makeGen(6);
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech: makeSpeech(), voiceCatalogue: [{ voiceId: "test-voice", displayName: "Freja", labels: { language: "da" } }], resolveVoiceName: () => "Freja" });
    const id = await makeMovie(movie, gen, { target: 10 });
    const plan = await movie.planMovieDuration({ projectId: id });
    check("R1 the plan is available BEFORE any render", Math.abs(plan.plannedSeconds - 10) <= plan.toleranceSeconds, String(plan.plannedSeconds));
    check("R1 it names the target it was given", plan.targetSeconds === 10);
    check("R1 and reports what it had to do to get there", Array.isArray(plan.warnings));

    await movie.generateNarration({ projectId: id, voiceId: "test-voice" });
    const r = await movie.renderMovie({ projectId: id });
    check("R1 the render completed", Boolean(r.render));
    const view = await movie.getProjectView(id, { refresh: false });
    const final = view.project.finalMovie;
    // Renders are immutable versions; the finished file lives under the version directory.
    const file = path.join(mediaRoot, "movies", id, "renders", `v${r.render.version}`, "final.mp4");
    const m = probe(file);
    check("R1 the finished file exists", Boolean(m), file);
    check(`R1 the MEASURED duration is the target (${m ? m.seconds.toFixed(2) : "?"}s)`, m && Math.abs(m.seconds - 10) <= 0.15, m ? String(m.seconds) : "");
    check("R1 the database agrees with the file", final && Math.abs(final.durationSeconds - m.seconds) <= 0.2, JSON.stringify(final));
    check("R1 it is 720x1280 h264+aac", m && m.width === 720 && m.height === 1280 && m.video === "h264" && m.audio === "aac");

    // 5C.37 — the render is measured, not just finished. The verdict is stored beside the render it describes.
    const rr = await movie.getProjectView(id, { refresh: false });
    const q = await movie.movieQuality({ projectId: id });
    check("R1/37 the finished master was decoded and measured", q.master && typeof q.master.technicalScore === "number", JSON.stringify(q.master && q.master.failures));
    check("R1/37 the measurement is of real frames, not the container header", q.master && q.master.measured && q.master.measured.sampledFrames > 0, JSON.stringify(q.master && q.master.measured));
    check("R1/37 each source clip's true resolution is on the record", q.master && Array.isArray(q.master.sources) && q.master.sources.length > 0, JSON.stringify(q.master && q.master.sources));
    // The film finished, and that is all "finished" means. Nothing here has looked at what the pictures show
    // or listened back to the audio, so it must NOT be publishable.
    check("R1/37 finishing the pipeline is not the same as being publishable", q.state !== "PUBLISHABLE", q.state);
    check("R1/37 and the unmeasured dimensions are named rather than scored", q.scorecard.unmeasuredHardDimensions.length > 0, JSON.stringify(q.scorecard.unmeasuredHardDimensions));
    check("R1/37 the verdict rides with the render version it describes", q.renderVersion === r.render.version && Boolean(rr.project.finalMovie));

    // 5C.39 — the hard gate, end to end on a real database. This film has no adaptation, no transcript
    // verification and no vision verdicts, because nothing produced them; the pipeline finished perfectly.
    check("R1/39 a finished render is NOT publishable on its own", q.publishable === false && q.state !== "PUBLISHABLE", q.state);
    check("R1/39 the unmeasured dimensions are named, not averaged away", q.scorecard.unmeasuredHardDimensions.length > 0, JSON.stringify(q.scorecard.unmeasuredHardDimensions));
    // The verdict has to be readable by the UI and the publish path, not recomputed differently by each.
    check("R1/39 the verdict is PERSISTED, not just computed", typeof q.scorecardId === "string" && q.scorecardId.startsWith("art_"), String(q.scorecardId));
    const persisted = await movie.getProjectView(id, { refresh: false });
    check("R1/39 and the movie now carries a quality state", persisted.project.qualityState === q.state, `${persisted.project.qualityState} vs ${q.state}`);
    check("R1/39 which is review-required, since nothing looked at the pictures", q.state === "QUALITY_REVIEW_REQUIRED", q.state);
    // Every film shipped before 5C.37 carried 96 kHz audio: loudnorm resamples internally and nothing put the
    // rate back. Nobody noticed because nobody measured it. This is the regression that keeps it fixed.
    check("R1/37 the delivered audio is 48 kHz, not whatever loudnorm left behind", q.master.measured.audioSampleRate === 48000, String(q.master.measured.audioSampleRate));
    check("R1/37 and the sample rate is no longer a gate failure", !q.master.failures.some((f) => f.check === "audio-sample-rate"), JSON.stringify(q.master.failures.map((f) => f.check)));
  }

  // ============================================================ 2. narration is never cut mid-sentence
  {
    const gen = makeGen(6);
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech: makeSpeech(), voiceCatalogue: [{ voiceId: "test-voice", displayName: "Freja", labels: { language: "da" } }], resolveVoiceName: () => "Freja" });
    const id = await makeMovie(movie, gen, { target: 13 });
    const plan = await movie.planMovieDuration({ projectId: id });
    check("R2 13s holds all three lines", plan.silentSceneCount === 0, JSON.stringify(plan.warnings));
    check("R2 every line is spoken in full", plan.scenes.every((s, i) => s.narrationText === NARRATION[i]));
    check("R2 no line ends mid-word", plan.scenes.every((s) => /[.!?…]$/u.test(s.narrationText)));
    await movie.generateNarration({ projectId: id, voiceId: "test-voice" });
    await movie.renderMovie({ projectId: id });
    const m = probe(path.join(mediaRoot, "movies", id, "renders", "v1", "final.mp4"));
    check(`R2 the film is 13s (${m ? m.seconds.toFixed(2) : "?"}s)`, m && Math.abs(m.seconds - 13) <= 0.15, m ? String(m.seconds) : "");
    const srtPath = path.join(mediaRoot, "movies", id, "renders", "v1", "final.srt");
    check("R2 an SRT was written", existsSync(srtPath));
  }

  // ============================================================ 3. an impossible budget fails BEFORE the render
  {
    const gen = makeGen(6);
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech: makeSpeech(), resolveVoiceName: () => "Freja", voiceCatalogue: [{ voiceId: "test-voice", displayName: "Freja", labels: { language: "da" } }] });
    const monster = "Dette er en meget lang sætning som fortsætter og fortsætter og fortsætter uden at stoppe fordi den skal bruges til at bevise at systemet nægter at klippe midt i en sætning selv når budgettet er alt for lille.";
    const id = await makeMovie(movie, gen, { target: 6, texts: [monster, monster, monster] });
    await refuses("R3 planning refuses an impossible budget", () => movie.planMovieDuration({ projectId: id }), DURATION_ERRORS.UNSATISFIABLE);
    await movie.generateNarration({ projectId: id, voiceId: "test-voice" }).catch(() => {});
    await refuses("R3 and the RENDER refuses too, rather than cutting speech", () => movie.renderMovie({ projectId: id }), DURATION_ERRORS.UNSATISFIABLE);
    check("R3 no final file was produced", !existsSync(path.join(mediaRoot, "movies", id, "renders", "v1", "final.mp4")));
  }

  // ============================================================ 4. real narration longer than its slot
  {
    const gen = makeGen(6);
    // Speech that takes far longer than the planner estimated: the render must refuse, not truncate.
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech: makeSpeech(() => 9), resolveVoiceName: () => "Freja", voiceCatalogue: [{ voiceId: "test-voice", displayName: "Freja", labels: { language: "da" } }] });
    const id = await makeMovie(movie, gen, { target: 10 });
    await movie.generateNarration({ projectId: id, voiceId: "test-voice" });
    await refuses("R4 measured narration longer than its slot refuses the render", () => movie.renderMovie({ projectId: id }), DURATION_ERRORS.UNSATISFIABLE);
    check("R4 nothing was written", !existsSync(path.join(mediaRoot, "movies", id, "renders", "v1", "final.mp4")));
  }

  // ============================================================ 5. clips shorter than their slot
  {
    const gen = makeGen([2, 6, 6]);
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech: makeSpeech(), resolveVoiceName: () => "Freja", voiceCatalogue: [{ voiceId: "test-voice", displayName: "Freja", labels: { language: "da" } }] });
    const id = await makeMovie(movie, gen, { target: 12 });
    const plan = await movie.planMovieDuration({ projectId: id });
    check("R5 the short clip caps its own scene", plan.scenes[0].allocatedSeconds <= 2 + 1e-6, String(plan.scenes[0].allocatedSeconds));
    check("R5 the target is still met from the other clips", Math.abs(plan.plannedSeconds - 12) <= plan.toleranceSeconds, String(plan.plannedSeconds));
    await movie.generateNarration({ projectId: id, voiceId: "test-voice" }).catch(() => {});
    await movie.renderMovie({ projectId: id });
    const m = probe(path.join(mediaRoot, "movies", id, "renders", "v1", "final.mp4"));
    check(`R5 the film is still 12s (${m ? m.seconds.toFixed(2) : "?"}s)`, m && Math.abs(m.seconds - 12) <= 0.15, m ? String(m.seconds) : "");
  }

  // ============================================================ 6. the voice gate
  {
    const gen = makeGen(6);
    // Charlotte is an English voice; the story is Danish. The old pipeline synthesised anyway.
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech: makeSpeech(), resolveVoiceName: () => "Charlotte" });
    const id = await makeMovie(movie, gen, { target: 13 });

    const verdict = movie.assessMovieVoice({ locale: "da-DK", voiceId: "elevenlabs-api:xyz", voiceName: "Charlotte" });
    check("R6 an English voice for a Danish story is a FALLBACK", verdict.capability === "FALLBACK" && verdict.fallbackKind === "ACCENT");

    await refuses("R6 an unattended run refuses to use it silently",
      () => movie.generateNarration({ projectId: id, voiceId: "elevenlabs-api:xyz" }), VOICE_ERRORS.FALLBACK_NOT_ALLOWED);
    const after = await movie.getProjectView(id, { refresh: false });
    check("R6 nothing was synthesised", (after.content.narration || []).length === 0);

    const ok = await movie.generateNarration({ projectId: id, voiceId: "elevenlabs-api:xyz", allowFallbackVoice: true });
    check("R6 an explicit policy lets it through", ok && ok.generated >= 1, JSON.stringify(ok));
    const v2 = await movie.getProjectView(id, { refresh: false });
    check("R6 and the fallback is on the record", v2.events.some((e) => e.type === "NARRATION_VOICE_FALLBACK"));
    const ev = v2.events.filter((e) => e.type === "NARRATION_VOICE_FALLBACK").pop();
    check("R6 naming the voice, its real language and who allowed it",
      ev.detail.voiceName === "Charlotte" && ev.detail.voiceLanguage === "en" && ev.detail.confirmedBy === "POLICY", JSON.stringify(ev.detail));

    const confirmed = await movie.generateNarration({ projectId: id, voiceId: "elevenlabs-api:xyz", confirmedFallbackLocales: ["da-DK"], force: true });
    check("R6 an owner confirmation also lets it through", confirmed && confirmed.generated >= 1);
  }

  // ============================================================ 7. a native voice needs no permission
  {
    const gen = makeGen(6);
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech: makeSpeech(), resolveVoiceName: () => "Freja", voiceCatalogue: [{ voiceId: "test-voice", displayName: "Freja", labels: { language: "da" } }] });
    const id = await makeMovie(movie, gen, { target: 13 });
    const out = await movie.generateNarration({ projectId: id, voiceId: "test-voice" });
    check("R7 a native voice synthesises with no policy at all", out && out.generated >= 1);
    const v = await movie.getProjectView(id, { refresh: false });
    check("R7 and no fallback is recorded", !v.events.some((e) => e.type === "NARRATION_VOICE_FALLBACK"));
    check("R7 the narration settings record the voice that was actually used",
      v.project.narrationSettings && v.project.narrationSettings.voice && v.project.narrationSettings.voice.capability === "NATIVE", JSON.stringify(v.project.narrationSettings));
  }

  // ============================================================ 8. canonical media paths, live
  {
    const gen = makeGen(6);
    // A root written with a FORWARD slash — the exact shape that made every clip look missing.
    const mixedRoot = mediaRoot.split(path.sep).join("/");
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mixedRoot, speech: makeSpeech(), resolveVoiceName: () => "Freja", voiceCatalogue: [{ voiceId: "test-voice", displayName: "Freja", labels: { language: "da" } }] });
    const id = await makeMovie(movie, gen, { target: 13 });
    await movie.generateNarration({ projectId: id, voiceId: "test-voice" });
    const r = await movie.renderMovie({ projectId: id });
    check("R8 a forward-slash media root renders instead of reporting every clip missing", Boolean(r.render));
    const media = await movie.finalMediaFor(id);
    check("R8 and the finished file is servable", media && media.sizeBytes > 0, JSON.stringify(media));
  }
} finally {
  try { if (adapter) await adapter.stop(); } catch { /* */ }
  await live.stop();
  try { rmSync(mediaRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}

console.log(`Step 5C.36 duration render: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
