// Measure the films that already shipped.
//
// Every one of them is recorded as 720x1280 because the container header says so. This decodes their actual
// frames and reports what is really there — including each SOURCE clip's true resolution, which is the number
// that decides whether "720p" was delivered or merely declared.
//
// Read-only: no provider, no database write, no re-render. Nothing here can change a finished movie.

import { readFileSync, existsSync } from "node:fs";
import { createPostgresAdapter } from "../../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../../control-plane/src/config/config.mjs";
import { certifyMaster, VERTICAL_720P } from "../../lib/movie/media-master.mjs";
import { resolveWithinOrNull } from "../../lib/ops/canonical-path.mjs";
import { defaultStudioHome } from "../../lib/paths.mjs";

const OWNER = defaultStudioHome();
const WS = "ws_00000000000000000000000000";
const DB = "facebook5c8_b3r";
const MEDIA = `${OWNER}/generated-media`;

const m = JSON.parse(readFileSync(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`, "utf8"));
const s = JSON.parse(readFileSync(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`, "utf8"));
const u = (user, pw) => `postgresql://${user}:${encodeURIComponent(pw)}@127.0.0.1:${m.ports.postgresql}/${DB}`;  // scan-secrets:allow DSN assembled from environment, no literal password
const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: u("cp_tenant_app", s.tenant), CONTROL_PLANE_DB_OPS_URL: u("cp_ops_enumerator", s.ops) }), {});
await adapter.start();
const T = (fn) => adapter.tenantTransaction(WS, fn);

const rows = await T(async (c) => (await c.query(
  `SELECT p.id, p.title, r.version, r.final_media
     FROM movie_projects p JOIN movie_renders r ON r.movie_project_id = p.id AND r.workspace_id = p.workspace_id
    WHERE p.workspace_id = $1 AND r.state = 'COMPLETED'
    ORDER BY p.created_at, r.version`, [WS])).rows);

console.log(`completed renders on record: ${rows.length}\n`);
let conforming = 0, upscaledCount = 0, missing = 0;

for (const r of rows) {
  const rel = (r.final_media || {}).relativePath;
  let abs = null;
  abs = rel ? resolveWithinOrNull(MEDIA, rel) : null;
  const label = `${String(r.title || "(untitled)").slice(0, 30).padEnd(30)} v${r.version}`;
  if (!abs || !existsSync(abs)) { console.log(`${label}  MISSING ON DISK`); missing += 1; continue; }

  // The clips this film was built from set the ceiling on how much real detail its master can hold.
  const scenes = await T(async (c) => (await c.query(
    `SELECT ordinal, media_meta FROM movie_scenes
      WHERE workspace_id = $1 AND movie_project_id = $2 ORDER BY ordinal`, [WS, r.id])).rows);
  const sources = [];
  for (const sc of scenes) {
    const srel = sc.media_meta && sc.media_meta.relativePath;
    if (!srel) continue;
    const p = resolveWithinOrNull(MEDIA, srel); if (p && existsSync(p)) sources.push({ path: p, ordinal: sc.ordinal });
  }

  const rep = await certifyMaster(abs, { profile: VERTICAL_720P, sampleCount: 6, sourceClips: sources });
  const mm = rep.measured;
  const src = rep.sources.filter((x) => x.height);
  const minH = src.length ? Math.min(...src.map((x) => x.height)) : null;
  const up = src.some((x) => x.upscaled);
  if (up) upscaledCount += 1;
  if (rep.pass) conforming += 1;

  console.log(`${label}  ${rep.pass ? "PASS" : "FAIL"}  ${mm.displayWidth}x${mm.displayHeight} ${mm.videoCodec} ${Number(mm.durationSeconds || 0).toFixed(1)}s  ` +
    `score=${rep.technicalScore}  sharp=${mm.sharpness}  block=${mm.blockiness}  band=${mm.banding}  ` +
    `sources=${src.length}${minH ? ` minSourceH=${minH}` : ""}${up ? "  UPSCALED" : ""}`);
  for (const f of rep.failures) console.log(`      FAIL  ${f.check}  ${JSON.stringify(f).slice(0, 150)}`);
  for (const w of rep.warnings) console.log(`      warn  ${w.check}  ${w.detail || ""}`);
}

console.log(`\nconforming masters: ${conforming}/${rows.length}   built from upscaled footage: ${upscaledCount}   missing: ${missing}`);
await adapter.stop?.();
process.exit(0);
