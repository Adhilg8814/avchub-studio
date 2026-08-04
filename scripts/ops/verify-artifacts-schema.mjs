// P0 Step 5C.39 — post-deploy check: the artifact schema is live and no existing movie was touched.
//
// Read-only. The point is to confirm that migration 0039 added what it claims and changed nothing else: the
// 9 completed movies must still be exactly as they were, with NO quality state, because none of them has been
// assessed and an unassessed film is unverified rather than approved.

import { readFileSync } from "node:fs";
import { createPostgresAdapter } from "../../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../../control-plane/src/config/config.mjs";
import { defaultStudioHome } from "../../lib/paths.mjs";

const OWNER = defaultStudioHome();
const WS = "ws_00000000000000000000000000";
const m = JSON.parse(readFileSync(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`, "utf8"));
const s = JSON.parse(readFileSync(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`, "utf8"));
const u = (a, b) => `postgresql://${a}:${encodeURIComponent(b)}@127.0.0.1:${m.ports.postgresql}/facebook5c8_b3r`;  // scan-secrets:allow DSN assembled from environment, no literal password

const ad = createPostgresAdapter(loadConfig({
  CONTROL_PLANE_DB_ENABLED: "true",
  CONTROL_PLANE_DB_URL: u("cp_tenant_app", s.tenant),
  CONTROL_PLANE_DB_OPS_URL: u("cp_ops_enumerator", s.ops)
}), {});
await ad.start();

const out = await ad.tenantTransaction(WS, async (c) => {
  const tables = (await c.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('movie_content_artifacts','movie_render_artifacts','movie_shot_repairs')
      ORDER BY table_name`)).rows.map((r) => r.table_name);
  const cols = (await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='movie_projects' AND column_name LIKE 'quality%' ORDER BY column_name`)).rows.map((r) => r.column_name);
  // COMPLETED, not every row: the workspace also holds drafts and abandoned cert attempts, and "9 Movies"
  // has always meant the nine finished films.
  const movies = (await c.query(
    "SELECT count(*)::int total, count(*) FILTER (WHERE status='COMPLETED')::int completed, count(quality_state)::int assessed FROM movie_projects WHERE workspace_id=$1", [WS])).rows[0];
  const renders = (await c.query(
    "SELECT count(*)::int total FROM movie_renders WHERE workspace_id=$1 AND state='COMPLETED'", [WS])).rows[0];
  const artifacts = (await c.query(
    "SELECT count(*)::int n FROM movie_content_artifacts WHERE workspace_id=$1", [WS])).rows[0];
  return { tables, cols, movies, renders, artifacts };
});

console.log("new tables      :", out.tables.join(", ") || "(none)");
console.log("new columns     :", out.cols.join(", ") || "(none)");
console.log("movies          :", out.movies.total, "rows,", out.movies.completed, "COMPLETED, assessed:", out.movies.assessed, "(0 is correct — none has been re-judged)");
console.log("completed renders:", out.renders.total);
console.log("artifacts stored :", out.artifacts.n, "(0 until a movie runs the new pipeline)");

const ok = out.tables.length === 3 && out.cols.length === 3 && out.movies.completed === 9 && out.renders.total === 10 && out.movies.assessed === 0;
console.log(ok ? "\nSCHEMA OK — additive, and the existing library is untouched." : "\nUNEXPECTED — see the numbers above.");
process.exit(ok ? 0 : 1);
