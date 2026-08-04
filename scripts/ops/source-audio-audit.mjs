// P0 Step 5C.45 §1/§8 — audit the audio of every Grok source clip on this production.
//
// READ ONLY. Local ffmpeg over files already on disk: no provider call, no generation, no ElevenLabs, no
// network. Final Movie renders are deliberately EXCLUDED — those already carry synthesised narration, music
// and a mix, so measuring them would answer a different question.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { measureAudio } from "../../lib/movie/source-audio-probe.mjs";
import { classifySourceAudio, SOURCE_AUDIO_CLASS, needsTranscript, carriesUsableAmbience } from "../../lib/movie/source-audio-class.mjs";
import { defaultStudioHome } from "../../lib/paths.mjs";

const OWNER = defaultStudioHome();
const WS = "ws_00000000000000000000000000";
const MEDIA = `${OWNER}/generated-media`;
const JOBS = path.join(MEDIA, "jobs");
const LIMIT = Number(process.env.LIMIT || 0);

const rj = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const mf = rj(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`);
const sc = rj(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`);
const c = new pg.Client({ connectionString: `postgresql://cp_tenant_app:${encodeURIComponent(sc.tenant)}@127.0.0.1:${mf.ports.postgresql}/facebook5c8_b3r` });  // scan-secrets:allow DSN assembled from environment, no literal password
await c.connect();
await c.query("SELECT set_config('app.current_workspace',$1,false)", [WS]);

// Which scene (if any) each job's clip belongs to, and what that scene was supposed to say.
const scenes = (await c.query(
  `SELECT s.id scene_id, s.movie_project_id, s.ordinal, s.narration, s.generation_job_id, s.duration_seconds,
          p.title, p.language
     FROM movie_scenes s JOIN movie_projects p ON p.id = s.movie_project_id AND p.workspace_id = s.workspace_id
    WHERE s.workspace_id=$1 AND s.generation_job_id IS NOT NULL`, [WS])).rows;
const sceneByJob = new Map(scenes.map((s) => [s.generation_job_id, s]));

const dirs = existsSync(JOBS) ? readdirSync(JOBS).filter((d) => existsSync(path.join(JOBS, d, "generated.mp4"))) : [];
const chosen = LIMIT > 0 ? dirs.slice(0, LIMIT) : dirs;
console.log(`source clips on disk: ${dirs.length}${LIMIT ? ` (auditing ${chosen.length})` : ""}`);
console.log(`final renders EXCLUDED by design (they already carry synthesised narration and a mix)\n`);

const sha256 = (p) => { const h = createHash("sha256"); h.update(readFileSync(p)); return h.digest("hex"); };

const rows = [];
for (const d of chosen) {
  const file = path.join(JOBS, d, "generated.mp4");
  const scene = sceneByJob.get(d) || null;
  let meas = null, error = null;
  try { meas = await measureAudio(file); } catch (e) { error = e.code || e.message; }
  const cls = meas ? classifySourceAudio(meas) : { class: SOURCE_AUDIO_CLASS.UNKNOWN, reason: error || "not measured", speechEvidence: null };
  rows.push({
    jobId: d, sceneId: scene ? scene.scene_id : null, movieId: scene ? scene.movie_project_id : null,
    ordinal: scene ? scene.ordinal : null,
    intendedNarration: scene ? String(scene.narration || "") : "",
    language: scene ? scene.language : null,
    sizeBytes: statSync(file).size, sourceHash: sha256(file).slice(0, 16),
    meas, cls, error
  });
  process.stdout.write(".");
}
console.log("\n");

const fmt = (r) => {
  const m = r.meas || {};
  return `${r.jobId.slice(-6)} ${r.sceneId ? `scene#${r.ordinal}` : "(no scene)"} ` +
    `${m.hasAudio ? `${m.audioCodec} ${m.sampleRate}Hz ${m.channels}ch` : "NO AUDIO"} ` +
    `dur=${m.audioDurationSeconds ?? "-"}s drift=${m.audioVideoDriftSeconds ?? "-"}s ` +
    `silence=${m.silenceRatio ?? "-"} I=${m.integratedLufs ?? "-"}LUFS TP=${m.truePeakDbtp ?? "-"}dBTP ` +
    `rms=${m.rmsDb ?? "-"}dB band=${m.speechBandRatio ?? "-"} => ${r.cls.class}`;
};
for (const r of rows) console.log("  " + fmt(r));

const byClass = new Map();
for (const r of rows) byClass.set(r.cls.class, (byClass.get(r.cls.class) || 0) + 1);

console.log(`\n================ AUDIT SUMMARY ================`);
console.log(`  source clips audited        : ${rows.length}`);
console.log(`  with an audio stream        : ${rows.filter((r) => r.meas && r.meas.hasAudio).length}`);
console.log(`  NO audio stream             : ${rows.filter((r) => r.meas && !r.meas.hasAudio).length}`);
for (const [k, v] of [...byClass.entries()].sort()) console.log(`  ${k.padEnd(28)}: ${v}`);
// UNKNOWN counts here on purpose: not knowing is a reason to listen, never a reason to skip.
const speechish = rows.filter((r) => needsTranscript(r.cls.class));
console.log(`  needing a transcript        : ${speechish.length}`);
console.log(`  carrying usable ambience    : ${rows.filter((r) => carriesUsableAmbience(r.cls.class)).length}`);
console.log(`  attached to a movie scene   : ${rows.filter((r) => r.sceneId).length}`);
console.log(`  with intended narration text: ${rows.filter((r) => r.intendedNarration.trim().length > 0).length}`);

const paid = (await c.query("SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1 AND generation_ordinal IS NOT NULL", [WS])).rows[0].n;
const jobs = (await c.query("SELECT count(*)::int n FROM generation_jobs WHERE workspace_id=$1", [WS])).rows[0].n;
console.log(`\n  provider delta check        : jobs=${jobs} paidOrdinals=${paid}  (this audit made none)`);

await c.end();
process.exit(0);
