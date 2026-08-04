// P0 Step 5C.46 §2/§3/§6 — transcribe the Grok source clips and decide, per scene and per film, whether
// ElevenLabs can be skipped.
//
// READ ONLY at the provider: local ffmpeg + local Whisper over files already on disk. No Grok call, no
// ElevenLabs call, no network at inference time. Final Movie renders are excluded — they already carry
// synthesised narration.
//
// Writes a versioned artifact per clip. The full transcript is NOT printed to the operational log: only its
// hash, the language, the confidence and the verdict.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { measureAudio } from "../../lib/movie/source-audio-probe.mjs";
import { classifySourceAudio, SOURCE_AUDIO_CLASS, needsTranscript, carriesUsableAmbience } from "../../lib/movie/source-audio-class.mjs";
import { matchNarration, NARRATION_VERDICT, narrationUsable } from "../../lib/movie/narration-match.mjs";
import { decideSceneAudio, decideMovieAudio, ttsSavings, AUDIO_DECISION, NARRATION_SOURCE } from "../../lib/movie/audio-source-policy.mjs";
import { createLocalSttProvider } from "../../lib/movie/local-stt-provider.mjs";
import { defaultStudioHome } from "../../lib/paths.mjs";

const OWNER = defaultStudioHome();
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..", "..");
const WS = "ws_00000000000000000000000000";
const JOBS = path.join(OWNER, "generated-media", "jobs");
const LIMIT = Number(process.env.LIMIT || 0);

const rj = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const mf = rj(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`);
const sc = rj(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`);
const c = new pg.Client({ connectionString: `postgresql://cp_tenant_app:${encodeURIComponent(sc.tenant)}@127.0.0.1:${mf.ports.postgresql}/facebook5c8_b3r` });  // scan-secrets:allow DSN assembled from environment, no literal password
await c.connect();
await c.query("SELECT set_config('app.current_workspace',$1,false)", [WS]);

const stt = createLocalSttProvider({ ownerRoot: OWNER, repoRoot: REPO });
console.log("STT capability:", JSON.stringify(stt.describe()));
if (!stt.available()) { console.log("\nno local transcriber — nothing can be concluded; ElevenLabs stays."); await c.end(); process.exit(2); }

const scenes = (await c.query(
  `SELECT s.id scene_id, s.movie_project_id, s.ordinal, s.narration, s.generation_job_id, s.duration_seconds,
          p.title, p.language, p.character_bible
     FROM movie_scenes s JOIN movie_projects p ON p.id = s.movie_project_id AND p.workspace_id = s.workspace_id
    WHERE s.workspace_id=$1 AND s.generation_job_id IS NOT NULL`, [WS])).rows;
const sceneByJob = new Map(scenes.map((s) => [s.generation_job_id, s]));

const dirs = existsSync(JOBS) ? readdirSync(JOBS).filter((d) => existsSync(path.join(JOBS, d, "generated.mp4"))) : [];
const chosen = LIMIT > 0 ? dirs.slice(0, LIMIT) : dirs;
console.log(`\nsource clips on disk: ${dirs.length}${LIMIT ? ` (processing ${chosen.length})` : ""}\n`);

const sha256 = (p) => { const h = createHash("sha256"); h.update(readFileSync(p)); return h.digest("hex"); };
const rows = [];
let processedSeconds = 0;

for (const d of chosen) {
  const file = path.join(JOBS, d, "generated.mp4");
  const scene = sceneByJob.get(d) || null;
  const intended = scene ? String(scene.narration || "") : "";
  const language = scene ? scene.language : null;
  const names = scene && Array.isArray(scene.character_bible) ? scene.character_bible.map((x) => x && x.name).filter(Boolean) : [];

  let meas = null, cls = null, tr = null, err = null;
  try { meas = await measureAudio(file); } catch (e) { err = e.code || e.message; }
  cls = classifySourceAudio(meas, { intendedNarration: intended });

  if (needsTranscript(cls.class)) {
    try { tr = await stt.transcribeLocal({ audioPath: file }); processedSeconds += tr.processingSeconds || 0; }
    catch (e) { err = e.code || e.message; }
  }

  // Re-classify with the transcriber acting as the certified detector it is.
  if (tr) {
    cls = classifySourceAudio(meas, {
      intendedNarration: intended,
      speechDetector: {
        available: true, method: `${tr.engine}:${tr.model}`,
        speechDetected: String(tr.text || "").trim().length > 0 && (tr.noSpeechProbability == null || tr.noSpeechProbability < 0.6),
        confidence: tr.confidence
      }
    });
  }

  const align = tr ? { timestampCoverage: tr.durationSeconds && tr.words.length ? Math.min(1, (tr.words[tr.words.length - 1].end - tr.words[0].start) / tr.durationSeconds) : 0 } : null;
  const match = matchNarration({
    transcript: tr ? tr.text : null, intendedNarration: intended,
    expectedLanguage: language, detectedLanguage: tr ? tr.detectedLanguage : null,
    sttAvailable: Boolean(tr), characterNames: names,
    transcriptConfidence: tr ? tr.confidence : null,
    noSpeechProbability: tr ? tr.noSpeechProbability : null,
    timestampCoverage: align ? align.timestampCoverage : null,
    // A class the energy already settled as having no voice must read NO_SPEECH, not "nobody listened":
    // the transcript was skipped BECAUSE the question was already answered.
    speechDetected: [SOURCE_AUDIO_CLASS.SILENCE, SOURCE_AUDIO_CLASS.NONE, SOURCE_AUDIO_CLASS.AMBIENCE_ONLY,
      SOURCE_AUDIO_CLASS.SFX_ONLY, SOURCE_AUDIO_CLASS.AMBIENCE_AND_SFX].includes(cls.class) ? false : null
  });

  const decision = decideSceneAudio({
    audioClass: cls.class, narrationVerdict: match.verdict,
    hasIntendedNarration: intended.trim().length > 0,
    alignmentAvailable: Boolean(tr && tr.words.length > 0 && align && align.timestampCoverage >= 0.35)
  });

  rows.push({
    jobId: d, sceneId: scene ? scene.scene_id : null, movieId: scene ? scene.movie_project_id : null,
    ordinal: scene ? scene.ordinal : null, title: scene ? scene.title : null,
    intended, language, sourceHash: sha256(file), sizeBytes: statSync(file).size,
    meas, cls, tr, match, decision, align, err
  });
  process.stdout.write(tr ? (narrationUsable(match.verdict) ? "!" : "·") : "-");
}
console.log("\n");

// ---- per clip, without ever printing the transcript ------------------------------------------------------
for (const r of rows) {
  const t = r.tr;
  console.log(`${r.jobId.slice(-6)} ${r.sceneId ? `#${r.ordinal} ${String(r.title || "").slice(0, 18)}` : "(no scene)"}`);
  console.log(`   class=${r.cls.class} lang=${t ? `${t.detectedLanguage}(${t.languageProbability})` : "-"} expected=${r.language || "-"}` +
              ` conf=${t ? t.confidence : "-"} noSpeech=${t ? t.noSpeechProbability : "-"} words=${t ? t.words.length : 0}` +
              ` speech=${t ? t.speechSeconds : "-"}s/${t ? t.durationSeconds : "-"}s`);
  console.log(`   verdict=${r.match.verdict} coverage=${r.match.evidence.coverage ?? "-"} tsCoverage=${r.align ? r.align.timestampCoverage.toFixed(3) : "-"}` +
              ` transcriptHash=${(r.match.evidence.transcriptHash || "-").slice(0, 23)}`);
  console.log(`   decision=${r.decision.decision} narration=${r.decision.narrationSource} ttsSkipped=${r.decision.elevenLabsSkipped}`);
}

// ---- per movie -------------------------------------------------------------------------------------------
const byMovie = new Map();
for (const r of rows) { if (!r.movieId) continue; byMovie.set(r.movieId, (byMovie.get(r.movieId) || []).concat(r)); }
console.log(`\n================ PER MOVIE ================`);
const skippableMovies = [];
for (const [mid, list] of byMovie) {
  const mv = decideMovieAudio({ sceneDecisions: list.map((x) => x.decision) });
  const save = ttsSavings(list.map((x) => x.decision));
  const allGrok = mv.narrationSource === NARRATION_SOURCE.GROK && mv.consistent === true;
  if (allGrok) skippableMovies.push(mid);
  console.log(`  ${mid.slice(-6)} "${String(list[0].title || "").slice(0, 24)}" scenes=${list.length} lang=${list[0].language || "-"}` +
              ` -> ${mv.narrationSource}${mv.requiresReview ? " (review)" : ""} ttsCalls=${save.elevenLabsCalls} skipped=${save.elevenLabsSkipped}`);
  console.log(`      ${mv.reason}`);
}

// ---- the numbers §6 asks for -------------------------------------------------------------------------------
const withTr = rows.filter((r) => r.tr);
const cnt = (f) => rows.filter(f).length;
const v = (x) => rows.filter((r) => r.match.verdict === x).length;
console.log(`\n================ PRODUCTION RESULT ================`);
console.log(`  clips considered                : ${rows.length}`);
console.log(`  transcribed                     : ${withTr.length}`);
console.log(`  ambience / SFX (no speech)      : ${cnt((r) => carriesUsableAmbience(r.cls.class))}`);
console.log(`  speech present                  : ${cnt((r) => [SOURCE_AUDIO_CLASS.SPEECH_PRESENT, SOURCE_AUDIO_CLASS.NARRATION_CANDIDATE].includes(r.cls.class))}`);
console.log(`  EXACT_NARRATION_MATCH           : ${v(NARRATION_VERDICT.EXACT_NARRATION_MATCH)}`);
console.log(`  ACCEPTABLE_NARRATION_MATCH      : ${v(NARRATION_VERDICT.ACCEPTABLE_NARRATION_MATCH)}`);
console.log(`  PARTIAL_NARRATION_MATCH         : ${v(NARRATION_VERDICT.PARTIAL_NARRATION_MATCH)}`);
console.log(`  UNRELATED_DIALOGUE              : ${v(NARRATION_VERDICT.UNRELATED_DIALOGUE)}`);
console.log(`  WRONG_LANGUAGE                  : ${v(NARRATION_VERDICT.WRONG_LANGUAGE)}`);
console.log(`  UNINTELLIGIBLE                  : ${v(NARRATION_VERDICT.UNINTELLIGIBLE)}`);
console.log(`  NO_SPEECH                       : ${v(NARRATION_VERDICT.NO_SPEECH)}`);
console.log(`  UNMEASURED_LOW_CONFIDENCE       : ${v(NARRATION_VERDICT.UNMEASURED_LOW_CONFIDENCE)}`);
console.log(`  UNMEASURED_NO_STT_CAPABILITY    : ${v(NARRATION_VERDICT.UNMEASURED_NO_STT_CAPABILITY)}`);
const langs = new Map();
for (const r of withTr) langs.set(r.tr.detectedLanguage, (langs.get(r.tr.detectedLanguage) || 0) + 1);
console.log(`  detected languages              : ${[...langs.entries()].map(([k, n]) => `${k}×${n}`).join(", ") || "-"}`);

const actualSkipped = rows.filter((r) => r.decision.elevenLabsSkipped === true).length;
const scenesWithNarration = rows.filter((r) => r.sceneId && r.intended.trim()).length;
console.log(`\n  movies that can drop ElevenLabs : ${skippableMovies.length ? skippableMovies.map((m) => m.slice(-6)).join(", ") : "NONE"}`);
console.log(`  TTS calls ACTUALLY avoidable    : ${actualSkipped}   <- decided, not estimated`);
console.log(`  scenes still needing TTS        : ${scenesWithNarration - actualSkipped} of ${scenesWithNarration}`);
console.log(`  transcription cost              : ${processedSeconds.toFixed(1)}s of local CPU, 0 provider calls`);

const paid = (await c.query("SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1 AND generation_ordinal IS NOT NULL", [WS])).rows[0].n;
const jobs = (await c.query("SELECT count(*)::int n FROM generation_jobs WHERE workspace_id=$1", [WS])).rows[0].n;
console.log(`\n  provider delta                  : jobs=${jobs} paidOrdinals=${paid}  (this run made none)`);

await c.end();
process.exit(0);
