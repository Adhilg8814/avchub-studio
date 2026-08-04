// P0 Step 5C.36 — produce a REAL movie from a READY story, through the running production runtime.
//
// Same shape as movie-real-cert.mjs and for the same reason: this process must never reach a provider. It
// builds the story + movie control planes against the live database WITHOUT a chat actuator and WITHOUT a
// generation runtime, so all it can do is write rows. The actual video, narration and render are driven by
// the ALREADY-RUNNING runtime, which owns the single Grok account, the single browser lease and the durable
// pacing lane — the marker below is the handover.
//
//   plan <storyId> [seconds] [sceneSeconds]  create the movie project + storyboard. ZERO provider quota.
//                                            Prints exactly how many invocations the run would cost.
//   go <movieId>                             append PIPELINE_STARTED (real spend begins) and monitor.
//   status <movieId>                         read-only snapshot.
import path from "node:path";
import { readFileSync } from "node:fs";
import { createPostgresAdapter } from "../../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../../control-plane/src/config/config.mjs";
import { createMovieControlPlane } from "../../control-plane/src/api-staging/movie-control-plane.mjs";
import { createStoryFactoryControlPlane } from "../../control-plane/src/api-staging/story-factory-control-plane.mjs";
import { movieRepository as repo } from "../../control-plane/src/persistence/repositories/movie-repository.mjs";
import { createMovieAssembler } from "../../lib/movie/movie-assembler.mjs";
import { defaultStudioHome } from "../../lib/paths.mjs";

const OWNER = defaultStudioHome();
// The media root must use pure Windows separators. The control plane guards every media path with
// abs.startsWith(ownerMediaRoot) after path.join() has normalised it to backslashes, so a root with a
// forward slash in it makes that guard reject every clip — reported as E_MOVIE_CLIP_MISSING, which sounds
// like the file is gone when in fact the path was never allowed to resolve.
const OWNER_MEDIA_ROOT = path.join(defaultStudioHome(), "generated-media");
const WS = "ws_00000000000000000000000000";
const DB = process.env.PGDATABASE || "avc_studio";
// Alice — the certified voice-map entry the owner confirmed for da/bg (no native da-DK voice exists on this
// box; that limitation is reported, never papered over).
const VOICE = "elevenlabs-api:Xb7hH8MSUJpSbSDYk0k2";
const PRESETS = Object.freeze({
  narrationEnabled: true, voiceId: VOICE, rate: 0,
  subtitleEnabled: true, subtitleMode: "embed",
  music: { source: "AMBIENT", style: "CALM", volume: 0.3 }
});

function urls() {
  const m = JSON.parse(readFileSync(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`, "utf8"));
  const s = JSON.parse(readFileSync(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`, "utf8"));
  const u = (r, pw) => `postgresql://${r}:${encodeURIComponent(pw)}@127.0.0.1:${m.ports.postgresql}/${DB}`;  // scan-secrets:allow DSN assembled from environment, no literal password
  return { app: u("cp_tenant_app", s.tenant), ops: u("cp_ops_enumerator", s.ops) };
}

async function open() {
  const { app, ops } = urls();
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: app, CONTROL_PLANE_DB_OPS_URL: ops }), {});
  await adapter.start();
  // A generation stub that REFUSES: if any code path in this process tried to enqueue provider work it would
  // fail loudly here rather than quietly becoming a second enqueuer.
  const stubGen = { ensureBootstrap: async () => ({}), enqueue: async () => { throw new Error("this CLI never enqueues; the running runtime does"); } };
  // The assembler is pure local ffmpeg over files already on disk — no browser, no account, no provider —
  // so a re-render costs nothing but CPU and cannot contend with the runtime's single provider lease.
  const movie = createMovieControlPlane({ persistence: adapter, config: { stagingApi: { workspaceId: WS } }, generation: stubGen, assembler: createMovieAssembler(), ownerMediaRoot: OWNER_MEDIA_ROOT });
  const story = createStoryFactoryControlPlane({ persistence: adapter, config: { stagingApi: { workspaceId: WS } }, movie });
  return { adapter, movie, story };
}
const now = () => new Date().toISOString().slice(11, 19) + "Z";

async function plan(storyId, seconds, sceneSeconds) {
  const { adapter, movie, story } = await open();
  try {
    const view = await story.getProjectView(storyId);
    if (!view || view.project.status !== "READY") { console.log("ERROR: story is not READY:", view && view.project.status); process.exit(1); }
    console.log(`story ${storyId} ${view.project.locale} ${view.project.wordCount}w score=${view.project.overallScore}`);
    console.log(`title: ${JSON.stringify(view.project.title)}`);
    const out = await story.createMovieAdaptation(storyId, { targetDurationSeconds: seconds, sceneDurationSeconds: sceneSeconds, aspectRatio: "9:16" });
    const scenes = await movie.listScenes(out.movieProjectId);
    // planStoryboard fixes every scene at 6 s; trim them to the requested length so the finished movie is
    // the duration that was asked for rather than the planner's default.
    for (const s of scenes) {
      if (s.durationSeconds !== sceneSeconds) await movie.updateScene({ sceneId: s.id, patch: { durationSeconds: sceneSeconds } });
    }
    const after = await movie.listScenes(out.movieProjectId);
    console.log(`PLAN_OK movieProjectId=${out.movieProjectId} scenes=${after.length} videoInvoked=${out.videoInvoked}`);
    for (const s of after) console.log(`  #${s.ordinal} ${s.durationSeconds}s ${s.aspectRatio} · ${String(s.heading || "").slice(0, 40)} · ${String(s.narration || "").slice(0, 70)}`);
    console.log(`nominal duration: ${after.reduce((a, s) => a + s.durationSeconds, 0)}s at 720x1280`);
    console.log(`COST IF STARTED: ${after.length} Grok Imagine invocations (1/scene) + ${after.length} ElevenLabs narration + 1 ffmpeg render. Facebook=0.`);
    console.log(`next: node scripts/ops/story-movie-run.mjs go ${out.movieProjectId}`);
  } finally { await adapter.stop().catch(() => {}); }
}

async function snapshot(movie, id) {
  const v = await movie.getProjectView(id, { refresh: false });
  if (!v) return null;
  const ev = v.events || [];
  const renders = (v.content && v.content.renders) || [];
  return {
    status: v.project.status, progress: v.progress,
    scenes: v.scenes.map((s) => s.state),
    last: ev.slice(-5).map((e) => e.type).join(">"),
    blocked: ev.some((e) => e.type === "PIPELINE_BLOCKED") ? ev.filter((e) => e.type === "PIPELINE_BLOCKED").slice(-1)[0].detail : null,
    done: ev.some((e) => e.type === "PIPELINE_DONE"),
    render: renders.find((r) => r.state === "COMPLETED" && r.hasFinal) || null,
    hasFinal: v.project.hasFinalMovie === true, final: v.project.finalMovie || null
  };
}

async function go(movieId) {
  const { adapter, movie } = await open();
  try {
    const pre = await movie.getProjectView(movieId, { refresh: false });
    if (!pre) { console.log("ERROR: movie not found"); process.exit(1); }
    if ((pre.events || []).some((e) => e.type === "PIPELINE_STARTED")) console.log("NOTE: PIPELINE_STARTED already present — monitoring only");
    else {
      await adapter.tenantTransaction(WS, async (c) => {
        await repo.appendEvent(c, WS, movieId, { type: "PIPELINE_STARTED", detail: PRESETS });
        await repo.updateProject(c, WS, movieId, { patch: { status: "GENERATING" } });
      });
      console.log(`[${now()}] PIPELINE_STARTED seeded — the running runtime drives real generation from here.`);
    }
    const deadline = Date.now() + 40 * 60 * 1000;
    let last = "";
    while (Date.now() < deadline) {
      const s = await snapshot(movie, movieId);
      const line = JSON.stringify({ status: s.status, prog: s.progress, scenes: s.scenes, last: s.last });
      if (line !== last) { console.log(`[${now()}]`, line); last = line; }
      if (s.done && s.hasFinal) { console.log(`[${now()}] DONE ${JSON.stringify(s.final)}`); return; }
      if (s.blocked) { console.log(`[${now()}] BLOCKED ${JSON.stringify(s.blocked)}`); return; }
      await new Promise((r) => setTimeout(r, 15000));
    }
    console.log(`[${now()}] TIMEOUT (40 min) — inspect with status.`);
  } finally { await adapter.stop().catch(() => {}); }
}

async function status(movieId) {
  const { adapter, movie } = await open();
  try { console.log(JSON.stringify(await snapshot(movie, movieId), null, 1)); } finally { await adapter.stop().catch(() => {}); }
}

// Re-cut an already-rendered movie to a requested total length, WITHOUT touching the provider: the clips
// are on disk, so this only sets per-scene trims and runs ffmpeg again. Renders are immutable versions, so
// the previous cut stays exactly where it was.
async function trim(movieId, totalSeconds) {
  const { adapter, movie } = await open();
  try {
    const scenes = (await movie.listScenes(movieId)).slice().sort((a, b) => a.ordinal - b.ordinal);
    if (!scenes.length) { console.log("ERROR: no scenes"); process.exit(1); }
    const per = Math.floor((totalSeconds / scenes.length) * 10) / 10;
    const entries = scenes.map((sc, i) => ({
      sceneId: sc.id, trimIn: 0,
      trimOut: i === 0 ? Number((totalSeconds - per * (scenes.length - 1)).toFixed(1)) : per
    }));
    await movie.updateTimeline({ projectId: movieId, entries });
    console.log("trims:", entries.map((e) => `${e.trimIn}-${e.trimOut}s`).join(" "));
    const r = await movie.renderMovie({ projectId: movieId });
    console.log(`render idempotent=${r.idempotent} version=${r.render.version}`);
    console.log("final:", JSON.stringify((await snapshot(movie, movieId)).final));
  } finally { await adapter.stop().catch(() => {}); }
}

const [mode, arg, a2, a3] = process.argv.slice(2);
if (mode === "plan") await plan(arg, Number(a2) || 10, Number(a3) || 4);
else if (mode === "go") await go(arg);
else if (mode === "trim") await trim(arg, Number(a2) || 10);
 else if (mode === "status") await status(arg);
else console.log("usage: story-movie-run.mjs plan <storyId> [seconds] [sceneSeconds] | go <movieId> | status <movieId>");


