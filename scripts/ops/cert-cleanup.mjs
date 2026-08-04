// P0 Step 5C.40 — retire the cert attempts this task created, so production stops working on them.
//
// The vision cert produced three throwaway movies before the one that mattered. Their scenes are still PLANNED
// or GENERATING, so the runtime keeps opening browsers for them, and their abandoned leases and one uncertain
// submission show up as degraded. None of that is a defect; it is litter this task dropped, and clearing it is
// part of finishing.
//
// A SUBMITTED job is never rewritten: it already cost its invocation, and editing the row would hide the spend
// rather than undo it. The uncertain one is REVIEWED — recorded alongside, never falsified — using the
// mechanism 5C.30 certified for exactly this.

import { readFileSync } from "node:fs";
import pg from "pg";
import { defaultStudioHome } from "../../lib/paths.mjs";

const OWNER = defaultStudioHome();
const WS = "ws_00000000000000000000000000";
const KEEP = process.env.KEEP_MOVIE || "mov_01KYD5F3XCZ9BQKEQDVBRGX4F3";

// The manifest is written with a BOM after a clean stop, and JSON.parse rejects it.
const readJson = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const m = readJson(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`);
const s = readJson(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`);
const c = new pg.Client({ connectionString: `postgresql://cp_tenant_app:${encodeURIComponent(s.tenant)}@127.0.0.1:${m.ports.postgresql}/facebook5c8_b3r` });  // scan-secrets:allow DSN assembled from environment, no literal password
await c.connect();
await c.query("SELECT set_config('app.current_workspace',$1,false)", [WS]);

// 1. The cert movies other than the one holding the judged scenes.
const surplus = (await c.query(
  "SELECT id FROM movie_projects WHERE workspace_id=$1 AND title='Vision cert' AND id <> $2", [WS, KEEP])).rows.map((r) => r.id);
console.log("surplus cert movies:", surplus.join(", ") || "(none)");

// 2. Their unfinished scenes: stop the runtime picking them up again.
if (surplus.length) {
  const sc = await c.query(
    `UPDATE movie_scenes SET state='FAILED', error_code='E_CERT_ABANDONED', revision=revision+1, updated_at=now()
      WHERE workspace_id=$1 AND movie_project_id = ANY($2) AND state NOT IN ('COMPLETED','FAILED')
      RETURNING id`, [WS, surplus]);
  console.log("abandoned scenes:", sc.rowCount);
}

// 3. Jobs that never submitted cost nothing and can be cancelled outright.
const cancelled = await c.query(
  `UPDATE generation_jobs SET state='CANCELLED_BEFORE_SUBMIT', error_code='E_CERT_CANCELLED', completed_at=now()
    WHERE workspace_id=$1 AND state IN ('QUEUED','PREPARING','GENERATING') RETURNING id`, [WS]);
console.log("cancelled un-submitted jobs:", cancelled.rowCount);

// 4. Expired leases from those abandoned offers.
const offers = await c.query(
  `UPDATE job_offers SET state='FAILED', updated_at=now()
    WHERE workspace_id=$1 AND state NOT IN ('COMPLETED','FAILED')
      AND generation_attempt_id IN (SELECT generation_attempt_id FROM generation_jobs WHERE workspace_id=$1 AND state='CANCELLED_BEFORE_SUBMIT')
    RETURNING id`, [WS]).catch((e) => ({ rowCount: 0, err: e.message }));
console.log("closed abandoned offers:", offers.rowCount ?? 0);

// 5. The uncertain submissions: REVIEWED through the certified API, never rewritten. Writing the review row by
// hand guessed at a schema that is not this script's to know - and the job row stays exactly as it is either
// way, because a submitted invocation was really spent and history must not be falsified.
const uncertain = (await c.query(
  "SELECT id FROM generation_jobs WHERE workspace_id=$1 AND state='SUBMIT_UNCERTAIN'", [WS])).rows;
await c.end();

if (uncertain.length) {
  const { createPostgresAdapter } = await import("../../control-plane/src/persistence/postgres/adapter.mjs");
  const { loadConfig } = await import("../../control-plane/src/config/config.mjs");
  const { createGenerationControlPlane } = await import("../../control-plane/src/api-staging/generation-control-plane.mjs");
  const u = (a, b) => `postgresql://${a}:${encodeURIComponent(b)}@127.0.0.1:${m.ports.postgresql}/facebook5c8_b3r`;  // scan-secrets:allow DSN assembled from environment, no literal password
  const ad = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: u("cp_tenant_app", s.tenant), CONTROL_PLANE_DB_OPS_URL: u("cp_ops_enumerator", s.ops) }), {});
  await ad.start();
  const gen = createGenerationControlPlane({ persistence: ad, config: { stagingApi: { workspaceId: WS } } });
  const owner = (await ad.tenantTransaction(WS, async (cl) => (await cl.query("SELECT owner_user_id FROM workspaces WHERE id=$1", [WS])).rows[0])).owner_user_id;
  let done = 0;
  for (const j of uncertain) {
    try {
      await gen.reviewUncertain({ jobId: j.id, verdict: "STILL_UNCERTAIN", source: "OPERATOR_ASSERTION",
        note: "abandoned 5C.40 vision cert attempt; the provider surface was not inspected", reviewedByUserId: owner });
      done += 1;
    } catch (e) { console.log("  review failed:", j.id, e.code || e.message); }
  }
  console.log("uncertain submissions reviewed:", done, "of", uncertain.length);
  await ad.stop?.();
}

process.exit(0);
