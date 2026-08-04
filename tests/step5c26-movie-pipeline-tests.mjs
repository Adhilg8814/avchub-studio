// P0 Step 5C.26 — movie AUTO-PIPELINE orchestrator: provider-free END-TO-END against a REAL disposable
// PostgreSQL + REAL ffmpeg, FAKE 5C.9E generation facade (fake Grok clips) + FAKE speech (real short wav).
// Proves: startMoviePipeline → advanceMoviePipeline walks scenes → narration → music → subtitles → render →
// COMPLETED autonomously; idempotent; NEVER double-submits; BLOCKS (never auto-retries) on a FAILED scene;
// resumes across a fresh control-plane instance (restart). Plus a unit test of the thin scheduler.
// SKIPS if PG binaries or ffmpeg are absent.
import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { ffmpegPaths } from "../lib/media/ffmpeg-locator.mjs";
const ffmpegStatic = ffmpegPaths().ffmpeg;
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createMovieControlPlane } from "../control-plane/src/api-staging/movie-control-plane.mjs";
import { createMovieAssembler } from "../lib/movie/movie-assembler.mjs";
import { createMovieOrchestrator } from "../lib/movie/movie-orchestrator.mjs";
import { generateId } from "../lib/protocol/ids.mjs";

const { Client } = pg;
let passed = 0, failed = 0;
function check(name, actual, expected = true) { try { assert.deepEqual(actual, expected, name); passed += 1; } catch (e) { failed += 1; console.log("FAIL", name, "-> got", JSON.stringify(actual)); } }

// ---- unit test the thin scheduler (no PG, no ffmpeg): coalescing + per-project in-flight guard ----
async function testScheduler() {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const mock = {
    async listActivePipelines() { return ["mov_a", "mov_b"]; },
    async advanceMoviePipeline({ projectId }) { calls.push(projectId); if (projectId === "mov_a") await gate; return { projectId, action: "RENDER" }; }
  };
  const orch = createMovieOrchestrator({ movie: mock, pollMs: 1000 });
  const first = orch.tick();                 // launches advance for a + b (a is stuck on the gate)
  await new Promise((r) => setTimeout(r, 5));
  await orch.tick();                          // second pass while a still in-flight -> a MUST be skipped
  check("SCHED a+b advanced once each on first pass", calls.filter((x) => x === "mov_a").length === 1 && calls.filter((x) => x === "mov_b").length >= 1, true);
  const aCountBeforeRelease = calls.filter((x) => x === "mov_a").length;
  check("SCHED in-flight guard: mov_a not re-entered while stuck", aCountBeforeRelease, 1);
  release();
  await first;
  orch.stop();
  check("SCHED tick after stop is a no-op", (await orch.tick()).length ?? 0, 0);
}

async function main() {
  await testScheduler();

  if (!livePgAvailable() || !ffmpegStatic) {
    console.log(`Step 5C.26 movie pipeline: ${passed} passed, ${failed} failed (partial — no PostgreSQL or ffmpeg; scheduler unit only)`);
    if (failed > 0) process.exit(1);
    return;
  }

  // FAKE generation facade: enqueue counted; getForUi completes on 2nd poll writing a real clip; a jobId in
  // `failSet` reports FAILED_PRE_SUBMIT. Tracks enqueue count for the no-double-submit assertion.
  const mediaRoot = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".movie26-"));
  const dims = (ar) => (ar === "16:9" ? [1280, 720] : ar === "1:1" ? [512, 512] : [720, 1280]);
  function makeGen() {
    const jobs = new Map(); const failSet = new Set(); let enqueueCount = 0;
    return {
      _failSet: failSet, get _enqueueCount() { return enqueueCount; },
      async ensureBootstrap() { return { workerId: "wrk_00000000000000000000000000", projectId: "prj_00000000000000000000000000" }; },
      async enqueue({ prompt, durationSeconds, aspectRatio }) { enqueueCount += 1; const jobId = generateId("job"), attemptId = generateId("attempt"); jobs.set(jobId, { jobId, attemptId, aspectRatio: aspectRatio || "9:16", polled: 0 }); return { jobId, generationAttemptId: attemptId, state: "QUEUED" }; },
      async requestStart() { return { dispatchStatus: "OFFERED", offerId: "off_x" }; },
      async getForUi(jobId) {
        const j = jobs.get(jobId); if (!j) return null; j.polled += 1;
        if (failSet.has(jobId)) return { jobId, state: "FAILED_PRE_SUBMIT", hasMedia: false, errorCode: "E_FAKE_FAIL" };
        if (j.polled < 2) return { jobId, state: "PROCESSING", hasMedia: false };
        const dir = path.join(mediaRoot, "jobs", jobId); mkdirSync(dir, { recursive: true });
        const clip = path.join(dir, "generated.mp4"); const [w, h] = dims(j.aspectRatio);
        if (!existsSync(clip)) { const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=30:duration=6`, "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { windowsHide: true }); if (r.status !== 0) return { jobId, state: "PROCESSING", hasMedia: false }; }
        return { jobId, state: "COMPLETED", hasMedia: true, resultId: "res_" + jobId.slice(-8), media: { sizeBytes: statSync(clip).size, container: "mp4", durationSeconds: 6, width: w, height: h } };
      }
    };
  }
  // FAKE speech: writes a REAL short wav so the assembler mixes real audio.
  const speech = {
    kind: "TESTTTS",
    listVoices: async () => [{ voiceId: "test-voice", label: "Test" }],
    async synthesize({ outputPath }) { mkdirSync(path.dirname(outputPath), { recursive: true }); const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-ac", "1", outputPath], { windowsHide: true }); if (r.status !== 0) throw Object.assign(new Error("tts"), { code: "E_TTS_FAILED" }); return { sizeBytes: statSync(outputPath).size, durationSeconds: 2 }; }
  };

  const live = await startDisposablePg({ namePrefix: "mov26" });
  let adapter = null;
  try {
    const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
    const ws = generateId("ws"), user = generateId("usr");
    try { try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch {}
      await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "mov26" });
      await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
      await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
      await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'MOV26',$2)", [ws, user]);
    } finally { await mc.end(); }
    adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
    await adapter.start();
    const config = { stagingApi: { workspaceId: ws } };
    const assembler = createMovieAssembler();
    const gen = makeGen();
    // 5C.36 — the speech here is a local stub with no voice catalogue, so its voice is UNKNOWN and the new
    // capability gate refuses it by default. That refusal is the point of the gate; this suite is about
    // pipeline orchestration, so it states the policy explicitly rather than leaving it implied.
    const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech, resolveVoiceName: () => "Test" });

    const drive = async (m, pid, max = 20) => { const seq = []; for (let i = 0; i < max; i++) { const r = await m.advanceMoviePipeline({ projectId: pid }); seq.push(r.action + (r.stage ? `:${r.stage}` : "")); if (r.action === "DONE" || r.action === "BLOCKED") break; } return seq; };
    // Drive the way the REAL orchestrator does — via listActivePipelines each tick. This catches the bug where
    // renderMovie sets status=COMPLETED and the project drops out of the scan before reaching PIPELINE_DONE.
    const driveScheduler = async (m, pid, max = 30) => {
      const seq = [];
      for (let i = 0; i < max; i++) {
        const active = await m.listActivePipelines();
        if (!active.includes(pid)) { seq.push("NOT_LISTED"); break; }
        const r = await m.advanceMoviePipeline({ projectId: pid });
        seq.push(r.action + (r.stage ? `:${r.stage}` : ""));
        if (r.action === "BLOCKED") break;
        if (r.action === "DONE") { const v = await m.getProjectView(pid, { refresh: false }); if (v.events.some((e) => e.type === "PIPELINE_DONE")) break; }
      }
      return seq;
    };

    // ===================== HAPPY PATH: story -> full auto pipeline -> COMPLETED =====================
    const p = await movie.createProject({ title: "Dawn Rower", genre: "drama", targetDurationSeconds: 18, aspectRatio: "9:16", inputMode: "IDEA", idea: "a woman rows across a misty lake at sunrise" });
    await movie.draftStory({ projectId: p.id });
    const start = await movie.startMoviePipeline({ projectId: p.id, presets: { narrationEnabled: true, voiceId: "test-voice", allowFallbackVoice: true, subtitleEnabled: true, subtitleMode: "embed", music: { source: "AMBIENT", style: "CALM", volume: 0.3 } } });
    check("P1 startMoviePipeline planned + enqueued scenes", start.scenes >= 3, true);
    const scenes0 = await movie.listScenes(p.id);
    check("P1 scenes QUEUED after start", scenes0.every((s) => s.state === "QUEUED"), true);
    check("P1 project GENERATING", (await movie.getProject(p.id)).status, "GENERATING");
    check("P1 enqueue called once per scene (no double submit)", gen._enqueueCount, scenes0.length);
    const evStart = (await movie.getProjectView(p.id, { refresh: false })).events;
    check("P1 PIPELINE_STARTED recorded with presets", evStart.some((e) => e.type === "PIPELINE_STARTED" && e.detail && e.detail.voiceId === "test-voice"), true);

    const seq = await driveScheduler(movie, p.id, 30);
    const finalView = await movie.getProjectView(p.id, { refresh: false });
    check("P2 pipeline reached DONE via the REAL scheduler (listActivePipelines, past status=COMPLETED)", finalView.events.some((e) => e.type === "PIPELINE_DONE") && seq[seq.length - 1] === "DONE", true);
    check("P2 sequence advanced through NARRATION+MUSIC+SUBTITLES+RENDER+PACKAGE", seq.some((a) => a === "NARRATION") && seq.some((a) => a === "MUSIC") && seq.some((a) => a === "SUBTITLES") && seq.some((a) => a === "RENDER") && seq.some((a) => a === "PACKAGE"), true);
    check("P2 project COMPLETED", finalView.project.status, "COMPLETED");
    check("P2 a COMPLETED render with final media exists", finalView.content.renders.some((r) => r.state === "COMPLETED" && r.hasFinal), true);
    check("P2 package ZIP built (downloadable)", finalView.content.renders.some((r) => r.hasPackage), true);
    check("P2 PIPELINE_DONE event", finalView.events.some((e) => e.type === "PIPELINE_DONE"), true);
    check("P2 enqueue STILL once per scene after full run (no re-submit)", gen._enqueueCount, scenes0.length);
    // final render file exists + non-trivial size
    const renders = await movie.listRenders(p.id);
    check("P2 render file on disk", renders.some((r) => r.finalMedia && existsSync(path.join(mediaRoot, r.finalMedia.relativePath)) && statSync(path.join(mediaRoot, r.finalMedia.relativePath)).size > 1000), true);

    // idempotent: advancing a DONE pipeline does nothing new
    const rendersBefore = (await movie.listRenders(p.id)).length;
    check("P3 advance after DONE -> DONE", (await movie.advanceMoviePipeline({ projectId: p.id })).action, "DONE");
    check("P3 no extra render created", (await movie.listRenders(p.id)).length, rendersBefore);

    // ===================== BLOCKED: a FAILED scene never auto-retries =====================
    const p2 = await movie.createProject({ title: "Broken", genre: "drama", targetDurationSeconds: 12, aspectRatio: "9:16", inputMode: "IDEA", idea: "a storm at sea" });
    await movie.draftStory({ projectId: p2.id });
    await movie.startMoviePipeline({ projectId: p2.id, presets: { narrationEnabled: true, voiceId: "test-voice", allowFallbackVoice: true } });
    const s2 = await movie.listScenes(p2.id);
    gen._failSet.add(s2[0].generationJobId); // designate one scene's job to fail
    const enqAtFail = gen._enqueueCount;
    const seq2 = await drive(movie, p2.id, 25);
    check("B1 pipeline BLOCKED on a failed scene", seq2[seq2.length - 1].startsWith("BLOCKED"), true);
    const v2 = await movie.getProjectView(p2.id, { refresh: false });
    check("B1 PIPELINE_BLOCKED SCENES_FAILED recorded", v2.events.some((e) => e.type === "PIPELINE_BLOCKED" && e.detail && e.detail.stage === "SCENES"), true);
    check("B1 no auto-retry of the failed scene (enqueue count unchanged)", gen._enqueueCount, enqAtFail);
    // repeated advances do not spam BLOCKED events nor re-submit
    await movie.advanceMoviePipeline({ projectId: p2.id }); await movie.advanceMoviePipeline({ projectId: p2.id });
    const blockedCount = (await movie.getProjectView(p2.id, { refresh: false })).events.filter((e) => e.type === "PIPELINE_BLOCKED").length;
    check("B2 BLOCKED not spammed across ticks", blockedCount, 1);
    check("B2 still no re-submit", gen._enqueueCount, enqAtFail);

    // ===================== CANCEL: stops auto-progression safely (no provider abort) =====================
    const pc = await movie.createProject({ title: "Cancelled", genre: "drama", targetDurationSeconds: 12, aspectRatio: "9:16", inputMode: "IDEA", idea: "a candle in the wind" });
    await movie.draftStory({ projectId: pc.id });
    await movie.startMoviePipeline({ projectId: pc.id, presets: { narrationEnabled: true, voiceId: "test-voice", allowFallbackVoice: true } });
    const enqAtCancel = gen._enqueueCount;
    await movie.cancelMoviePipeline({ projectId: pc.id });
    check("C1 advance after cancel -> CANCELLED (auto-progression stopped)", (await movie.advanceMoviePipeline({ projectId: pc.id })).action, "CANCELLED");
    check("C1 cancel did not enqueue/abort provider work", gen._enqueueCount, enqAtCancel);
    check("C1 no render produced for a cancelled pipeline", (await movie.listRenders(pc.id)).length, 0);
    // re-start after cancel resumes (new PIPELINE_STARTED becomes latest)
    await movie.startMoviePipeline({ projectId: pc.id, presets: { narrationEnabled: true, voiceId: "test-voice", allowFallbackVoice: true, subtitleEnabled: true, music: { source: "NONE" } } });
    const seqC = await drive(movie, pc.id, 25);
    check("C2 re-start after cancel drives to DONE", seqC[seqC.length - 1], "DONE");

    // ===================== RESUME across a fresh control-plane instance (restart) =====================
    const p3 = await movie.createProject({ title: "Resumed", genre: "drama", targetDurationSeconds: 12, aspectRatio: "9:16", inputMode: "IDEA", idea: "a train through mountains" });
    await movie.draftStory({ projectId: p3.id });
    await movie.startMoviePipeline({ projectId: p3.id, presets: { narrationEnabled: true, voiceId: "test-voice", allowFallbackVoice: true, subtitleEnabled: true, music: { source: "NONE" } } });
    await movie.advanceMoviePipeline({ projectId: p3.id }); // one step, still generating
    // simulate restart: brand-new control plane instance over the same durable DB
    const movie2 = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech, resolveVoiceName: () => "Test" });
    const active = await movie2.listActivePipelines();
    check("R1 fresh instance sees the in-flight pipeline as active", active.includes(p3.id), true);
    const seq3 = await drive(movie2, p3.id, 25);
    check("R1 fresh instance drove it to DONE", seq3[seq3.length - 1], "DONE");
    check("R1 resumed project COMPLETED", (await movie2.getProject(p3.id)).status, "COMPLETED");
  } finally {
    if (adapter) await adapter.stop().catch(() => {});
    await live.stop().catch(() => {});
    try { rmSync(mediaRoot, { recursive: true, force: true }); } catch {}
  }

  console.log(`Step 5C.26 movie pipeline: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });

