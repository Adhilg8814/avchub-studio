// P0 Step 5C.47 §3/§4 — re-render the legacy films from the assets already on disk.
//
// NO PROVIDER CALLS. No clip is generated, no narration is synthesised: every scene's clip and every
// narration WAV already exist, and this rebuilds the final mux from them under the audio routing the gate
// decided. If a narration asset is missing the film is skipped rather than re-synthesised — paying for a
// voice we already own would be the opposite of the point.
//
// Old renders are IMMUTABLE. Each film gets a new version directory; nothing under an existing v-N is
// touched, and the previous render rows stay exactly as they are.
//
// What this actually fixes, measured before writing a byte: all ten existing renders carry 96 kHz audio.
// 5C.37 pinned the encoder to 48 kHz but every render on disk predates that fix, and 96 kHz is a rate no
// delivery target asks for and several reject.

import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash, webcrypto as crypto } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { ffmpegPaths } from "../../lib/media/ffmpeg-locator.mjs";
import { createMovieAssembler } from "../../lib/movie/movie-assembler.mjs";
import { measureAudio } from "../../lib/movie/source-audio-probe.mjs";
import { classifySourceAudio } from "../../lib/movie/source-audio-class.mjs";
import { matchNarration } from "../../lib/movie/narration-match.mjs";
import { decideSceneAudio, decideMovieAudio, applyFilmDecision, ttsSavings, NARRATION_SOURCE } from "../../lib/movie/audio-source-policy.mjs";
import { createLocalSttProvider } from "../../lib/movie/local-stt-provider.mjs";
import { defaultStudioHome } from "../../lib/paths.mjs";

const FFPROBE = ffmpegPaths().ffprobe;
const OWNER = defaultStudioHome();
const MEDIA = path.join(OWNER, "generated-media");
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..", "..");
const WS = "ws_00000000000000000000000000";
const APPLY = process.argv.includes("--apply");
const ONLY = process.env.ONLY || null;

const rj = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const mf = rj(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`);
const sc = rj(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`);
const c = new pg.Client({ connectionString: `postgresql://cp_tenant_app:${encodeURIComponent(sc.tenant)}@127.0.0.1:${mf.ports.postgresql}/facebook5c8_b3r` });  // scan-secrets:allow DSN assembled from environment, no literal password
await c.connect();
await c.query("SELECT set_config('app.current_workspace',$1,false)", [WS]);

const stt = createLocalSttProvider({ ownerRoot: OWNER, repoRoot: REPO });
const assembler = createMovieAssembler();
const abs = (rel) => path.join(MEDIA, String(rel).split("/").join(path.sep));
const sha256 = (p) => { const h = createHash("sha256"); h.update(readFileSync(p)); return h.digest("hex"); };
const streamsOf = (f) => JSON.parse(spawnSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels", "-of", "json", f], { encoding: "utf8" }).stdout || "{}").streams || [];

const projects = (await c.query(
  `SELECT id, title, language, audio_policy, allow_mixed_voices, narration_source
     FROM movie_projects WHERE workspace_id=$1 AND status='COMPLETED' ORDER BY created_at`, [WS])).rows;
console.log(`completed movies: ${projects.length}${ONLY ? ` (only ${ONLY})` : ""}   mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

const report = [];
for (const p of projects) {
  if (ONLY && !p.id.endsWith(ONLY)) continue;
  const scenes = (await c.query(
    `SELECT id, ordinal, narration, heading, media_meta, audio_meta, duration_seconds
       FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY ordinal`, [WS, p.id])).rows;
  const audio = (await c.query(
    `SELECT id, scene_id, kind, state, media_meta FROM scene_audio_assets
      WHERE workspace_id=$1 AND movie_project_id=$2 AND state='COMPLETED'`, [WS, p.id])).rows;
  const narrationFor = new Map(audio.filter((a) => a.kind === "NARRATION").map((a) => [a.scene_id, a]));
  const music = audio.find((a) => a.kind === "MUSIC") || null;

  const missingClip = scenes.filter((s) => !s.media_meta || !s.media_meta.relativePath || !existsSync(abs(s.media_meta.relativePath)));
  const needNarration = scenes.filter((s) => String(s.narration || "").trim());
  const missingNarration = needNarration.filter((s) => {
    const a = narrationFor.get(s.id);
    return !a || !a.media_meta || !existsSync(abs(a.media_meta.relativePath));
  });

  // ---- decide the routing from the clips we already have ----------------------------------------------
  const sceneDecisions = [];
  for (const s of scenes) {
    if (!s.media_meta || !s.media_meta.relativePath || !existsSync(abs(s.media_meta.relativePath))) { sceneDecisions.push(null); continue; }
    const clip = abs(s.media_meta.relativePath);
    let meas = null; try { meas = await measureAudio(clip); } catch { meas = null; }
    let cls = classifySourceAudio(meas, { intendedNarration: s.narration || "" });
    let tr = null;
    if (stt.available() && ["UNKNOWN", "SPEECH_PRESENT", "NARRATION_CANDIDATE"].includes(cls.class)) {
      try { tr = await stt.transcribeLocal({ audioPath: clip }); } catch { tr = null; }
    }
    if (tr) {
      cls = classifySourceAudio(meas, {
        intendedNarration: s.narration || "",
        speechDetector: { available: true, method: `${tr.engine}:${tr.model}`, speechDetected: String(tr.text || "").trim().length > 0 && (tr.noSpeechProbability == null || tr.noSpeechProbability < 0.6), confidence: tr.confidence }
      });
    }
    const tsCov = tr && tr.words.length && tr.durationSeconds ? Math.min(1, (tr.words[tr.words.length - 1].end - tr.words[0].start) / tr.durationSeconds) : null;
    const match = matchNarration({
      transcript: tr ? tr.text : null, intendedNarration: s.narration || "",
      expectedLanguage: p.language, detectedLanguage: tr ? tr.detectedLanguage : null,
      sttAvailable: Boolean(tr), transcriptConfidence: tr ? tr.confidence : null,
      noSpeechProbability: tr ? tr.noSpeechProbability : null, timestampCoverage: tsCov,
      speechDetected: ["SILENCE", "NONE", "AMBIENCE_ONLY", "SFX_ONLY", "AMBIENCE_AND_SFX"].includes(cls.class) ? false : null
    });
    sceneDecisions.push(decideSceneAudio({
      audioClass: cls.class, narrationVerdict: match.verdict,
      hasIntendedNarration: String(s.narration || "").trim().length > 0,
      policy: p.audio_policy || "AUTO",
      alignmentAvailable: Boolean(tr && tr.words.length && tsCov !== null && tsCov >= 0.35)
    }));
  }
  const usable = sceneDecisions.filter(Boolean);
  const film = decideMovieAudio({ sceneDecisions: usable, policy: p.audio_policy || "AUTO", allowMixedVoices: p.allow_mixed_voices === true });
  const effective = applyFilmDecision(usable, film);
  const save = ttsSavings(effective);

  // Idempotent: a film already carrying a legacy-routing revision is left alone rather than gaining another.
  const already = (await c.query(
    `SELECT id, version FROM movie_renders WHERE workspace_id=$1 AND movie_project_id=$2
       AND probe->>'rerenderOf' = 'LEGACY_AUDIO_ROUTING' ORDER BY version DESC LIMIT 1`, [WS, p.id])).rows[0] || null;

  const blocked = already ? `already re-rendered as v${already.version}`
    : missingClip.length ? `${missingClip.length} clip(s) missing` : (missingNarration.length ? `${missingNarration.length} narration asset(s) missing — re-synthesising would cost a provider call` : null);
  const line = {
    movieId: p.id, title: p.title, scenes: scenes.length,
    narrationSource: film.narrationSource, eligible: save.eligibleForSkip, actual: save.actualSkipped,
    overridden: save.overriddenByFilm, ttsRequired: save.ttsCallsRequired,
    muted: effective.filter((d) => d.effectiveMuteSourceSpeech).length,
    ambience: effective.filter((d) => d.effectiveKeepSourceAudio).length,
    blocked
  };
  report.push(line);
  console.log(`${p.id.slice(-6)} "${String(p.title || "").slice(0, 26)}" scenes=${scenes.length} -> ${film.narrationSource}` +
              `  eligible=${line.eligible} actual=${line.actual} overridden=${line.overridden} ttsRequired=${line.ttsRequired}` +
              `  muted=${line.muted} ambience=${line.ambience}${blocked ? `  BLOCKED: ${blocked}` : ""}`);
  if (blocked || !APPLY) continue;

  // ---- build the new revision -------------------------------------------------------------------------
  const nextVersion = ((await c.query("SELECT COALESCE(MAX(version),0)+1 v FROM movie_renders WHERE workspace_id=$1 AND movie_project_id=$2", [WS, p.id])).rows[0].v);
  const relDir = `movies/${p.id}/renders/v${nextVersion}`;
  const outDir = abs(relDir);
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "final.mp4");

  const clips = scenes.map((s, i) => {
    const a = narrationFor.get(s.id);
    return {
      path: abs(s.media_meta.relativePath),
      narration: s.narration || s.heading || "",
      heading: s.heading || "",
      durationSeconds: s.duration_seconds,
      narrationPath: a && a.media_meta ? abs(a.media_meta.relativePath) : null,
      audioPlan: effective[i] || null
    };
  });

  let result = null, error = null;
  try {
    result = await assembler.assembleWithAudio({
      clips, workDir: path.join(outDir, "work"), outputPath: outPath,
      title: p.title || "", aspectRatio: "9:16",
      music: music && music.media_meta ? { path: abs(music.media_meta.relativePath), volume: 0.4 } : null,
      subtitleMode: "embed"
    });
  } catch (e) { error = String(e && (e.code || e.message)).slice(0, 120); }

  if (error || !existsSync(outPath)) { console.log(`     re-render FAILED: ${error || "no output"}`); line.rerender = { ok: false, error }; continue; }

  // ---- prove it by decoding what was written ----------------------------------------------------------
  const st = streamsOf(outPath).filter((x) => x.codec_type === "audio");
  const m = await measureAudio(outPath);
  const ok48 = m.sampleRate === 48000;
  const oneTrack = st.length === 1;
  const durOk = Number.isFinite(m.audioVideoDriftSeconds) && Math.abs(m.audioVideoDriftSeconds) <= 0.25;
  const noClip = Number.isFinite(m.truePeakDbtp) && m.truePeakDbtp <= -0.5;
  const loudOk = Number.isFinite(m.integratedLufs) && m.integratedLufs >= -20 && m.integratedLufs <= -12;
  line.rerender = {
    ok: ok48 && oneTrack && durOk && noClip && loudOk,
    version: nextVersion, relativePath: `${relDir}/final.mp4`, sizeBytes: statSync(outPath).size,
    sha256: sha256(outPath).slice(0, 16),
    audioStreams: st.length, sampleRate: m.sampleRate, integratedLufs: m.integratedLufs,
    truePeakDbtp: m.truePeakDbtp, driftSeconds: m.audioVideoDriftSeconds,
    checks: { ok48, oneTrack, durOk, noClip, loudOk }
  };
  console.log(`     v${nextVersion}: streams=${st.length} ${m.sampleRate}Hz I=${m.integratedLufs} TP=${m.truePeakDbtp} drift=${m.audioVideoDriftSeconds}s -> ${line.rerender.ok ? "PASS" : "FAIL " + JSON.stringify(line.rerender.checks)}`);

  // Provenance. A new row, never an update: the previous renders stay exactly as they were, and the audio
  // routing that produced this one is recorded beside it so the file can be explained later.
  if (line.rerender.ok) {
    const renderId = `rnd_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("").slice(0, 26)}`;
    await c.query(
      `INSERT INTO movie_renders (workspace_id, id, movie_project_id, version, render_hash, final_media, probe, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'COMPLETED')`,
      [WS, renderId, p.id, nextVersion, line.rerender.sha256,
       JSON.stringify({ relativePath: line.rerender.relativePath, sizeBytes: line.rerender.sizeBytes, container: "mp4",
                        durationSeconds: m.audioDurationSeconds, width: result && result.width ? result.width : null,
                        height: result && result.height ? result.height : null, sceneCount: scenes.length }),
       JSON.stringify({
         audioStreams: st.length, sampleRate: m.sampleRate, integratedLufs: m.integratedLufs,
         truePeakDbtp: m.truePeakDbtp, audioVideoDriftSeconds: m.audioVideoDriftSeconds,
         narrationSource: film.narrationSource,
         eligibleTtsSkips: save.eligibleForSkip, actualTtsSkips: save.actualSkipped,
         overriddenByFilm: save.overriddenByFilm, ttsCallsRequired: save.ttsCallsRequired,
         sourceSpeechMutedScenes: line.muted, ambienceRetainedScenes: line.ambience,
         rerenderOf: "LEGACY_AUDIO_ROUTING", providerCalls: 0
       })]);
    // Best-effort: the render row is the record that matters, and a timeline entry must never be the reason
    // a verified re-render is lost.
    try {
      await c.query(
        `INSERT INTO movie_project_events (workspace_id, project_id, seq, type, detail)
         SELECT $1,$2, COALESCE(MAX(seq),0)+1, 'RENDER_REVISION_CREATED', $3
           FROM movie_project_events WHERE workspace_id=$1 AND project_id=$2`,
        [WS, p.id, JSON.stringify({ version: nextVersion, reason: "LEGACY_AUDIO_ROUTING", sampleRate: m.sampleRate, providerCalls: 0 })]);
    } catch (e) { console.log(`     (timeline entry skipped: ${String(e && e.message).slice(0, 60)})`); }
    line.rerender.renderId = renderId;
    console.log(`     recorded render ${renderId.slice(-6)} v${nextVersion} (previous renders untouched)`);
  }
}

console.log(`\n================ SUMMARY ================`);
const built = report.filter((r) => r.rerender && r.rerender.ok);
console.log(`  movies considered      : ${report.length}`);
console.log(`  blocked (missing asset): ${report.filter((r) => r.blocked).length}`);
console.log(`  re-rendered + verified : ${built.length}`);
console.log(`  eligible TTS skips     : ${report.reduce((a, r) => a + r.eligible, 0)}`);
console.log(`  ACTUAL TTS skips       : ${report.reduce((a, r) => a + r.actual, 0)}`);
console.log(`  overridden by film     : ${report.reduce((a, r) => a + r.overridden, 0)}`);
console.log(`  source speech muted    : ${report.reduce((a, r) => a + r.muted, 0)} scene(s)`);
console.log(`  ambience retained      : ${report.reduce((a, r) => a + r.ambience, 0)} scene(s)`);

const paid = (await c.query("SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1 AND generation_ordinal IS NOT NULL", [WS])).rows[0].n;
const aud = (await c.query("SELECT count(*)::int n FROM scene_audio_assets WHERE workspace_id=$1", [WS])).rows[0].n;
console.log(`\n  provider delta         : paidOrdinals=${paid} audioAssets=${aud}  (this run created none)`);
await c.end();
process.exit(0);
