// P0 Step 5C.43 §2 — what the reconciler found, per SUBMIT_UNCERTAIN job.
//
// READ ONLY, and it does not drive anything. The reconciliation is performed by the RUNNING runtime — the one
// that owns the Cloak lifecycle — on startup, against the provider's own results surface. This reports what it
// recorded.
//
// It deliberately does not POST to the runtime's loopback channel to trigger a run. That channel is behind the
// fail-closed gateway PEP, and the only ways to call it from a script are to present the gateway secret or to
// borrow an owner session — which are exactly the two things this system does not do. The runtime reconciles
// itself; an ops script reads the ledger.

import { readFileSync, existsSync, statSync } from "node:fs";
import pg from "pg";
import { defaultStudioHome } from "../../lib/paths.mjs";

const OWNER = defaultStudioHome();
const WS = "ws_00000000000000000000000000";
const MEDIA = `${OWNER}/generated-media`;
const rj = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const m = rj(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`);
const s = rj(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`);
const c = new pg.Client({ connectionString: `postgresql://cp_tenant_app:${encodeURIComponent(s.tenant)}@127.0.0.1:${m.ports.postgresql}/facebook5c8_b3r` });  // scan-secrets:allow DSN assembled from environment, no literal password
await c.connect();
await c.query("SELECT set_config('app.current_workspace',$1,false)", [WS]);

const rows = (await c.query(
  `SELECT j.id, j.state, j.duration_seconds, j.aspect_ratio, j.media_meta, j.result_id, j.invocation_state,
          (SELECT at FROM generation_job_events e WHERE e.workspace_id=j.workspace_id AND e.job_id=j.id AND e.type='SUBMIT_ATTEMPTED' ORDER BY seq LIMIT 1) submitted_at,
          rv.verdict, rv.review_source,
          rc.state rc_state, rc.reason rc_reason, rc.confidence, rc.matched_result_id, rc.matched_asset_path,
          rc.matched_asset_sha256, rc.inspected_surface, rc.inspected_at, rc.prompt_hash, rc.match_method, rc.evidence
     FROM generation_jobs j
     LEFT JOIN generation_uncertain_reviews rv ON rv.workspace_id=j.workspace_id AND rv.job_id=j.id AND rv.superseded_at IS NULL
     LEFT JOIN LATERAL (SELECT * FROM generation_result_reconciliations x
                         WHERE x.workspace_id=j.workspace_id AND x.job_id=j.id ORDER BY x.created_at DESC LIMIT 1) rc ON true
    WHERE j.workspace_id=$1 AND (j.state='SUBMIT_UNCERTAIN' OR rc.id IS NOT NULL)
    ORDER BY j.created_at`, [WS])).rows;

console.log(`================ INVESTIGATED JOBS (${rows.length}) ================`);
for (const x of rows) {
  const mm = x.media_meta || {};
  const rel = mm.relativePath || `jobs/${x.id}/generated.mp4`;
  const abs = `${MEDIA}/${rel}`;
  const onDisk = existsSync(abs) ? statSync(abs).size : null;
  const ev = x.evidence || {};
  console.log(`\n${x.id}   state=${x.state}  invocation=${x.invocation_state}`);
  console.log(`  requested resolution : ${mm.requestedResolution || "720p (the composer request; not recorded on this job)"}`);
  console.log(`  requested duration   : ${x.duration_seconds}s`);
  console.log(`  submit timestamp     : ${x.submitted_at ? new Date(x.submitted_at).toISOString() : "(never submitted)"}`);
  console.log(`  prompt hash          : ${x.prompt_hash || "(not reconciled)"}`);
  console.log(`  provider result      : ${x.matched_result_id ? `YES  ${x.matched_result_id}` : "no"}`);
  console.log(`  asset                : ${onDisk == null ? "no" : `YES  ${onDisk} bytes  ${rel}`}${x.matched_asset_sha256 ? `  sha256=${x.matched_asset_sha256.slice(0, 16)}…` : ""}`);
  console.log(`  reconciliation state : ${x.rc_state || "(none)"}${x.rc_reason ? `  (${x.rc_reason})` : ""}${x.confidence != null ? `  confidence=${x.confidence}` : ""}`);
  console.log(`  review verdict       : ${x.verdict || "(none)"}${x.review_source ? ` via ${x.review_source}` : ""}`);
  if (x.inspected_surface) console.log(`  inspected            : ${x.inspected_surface} @ ${new Date(x.inspected_at).toISOString()}  cards=${ev.surfaceCards ?? "-"} candidates=${ev.candidates ?? "-"}`);
  if (ev.coverage) console.log(`  window coverage      : ${JSON.stringify(ev.coverage)}`);
  if (Array.isArray(ev.surfaceSample) && ev.surfaceSample.length) {
    console.log(`  what the cards show  :`);
    for (const s2 of ev.surfaceSample.slice(0, 3)) console.log(`      ${JSON.stringify(s2)}`);
  }
  if (mm.durationVerdict) console.log(`  duration record      : requested=${mm.requestedDurationSeconds} selected=${mm.selectedDurationSeconds} decoded=${mm.actualDecodedDurationSeconds} verdict=${mm.durationVerdict}`);
}

const open = (await c.query(
  `SELECT count(*)::int n FROM generation_jobs j
     LEFT JOIN generation_uncertain_reviews r ON r.workspace_id=j.workspace_id AND r.job_id=j.id AND r.superseded_at IS NULL
    WHERE j.workspace_id=$1 AND j.state='SUBMIT_UNCERTAIN'
      AND (r.verdict IS NULL OR r.verdict IN ('STILL_UNCERTAIN','AMBIGUOUS_MULTIPLE_MATCHES','CONFIRMED_SUBMITTED_RESULT_PENDING'))`, [WS])).rows[0].n;
const expired = (await c.query(
  `SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1
     AND ownership_status IN ('OFFERED','ACCEPTED','RUNNING','SUBMITTING') AND lease_expires_at < now()`, [WS])).rows[0].n;
const jobs = (await c.query("SELECT count(*)::int n FROM generation_jobs WHERE workspace_id=$1", [WS])).rows[0].n;
const paid = (await c.query("SELECT count(*)::int n FROM generation_attempts WHERE workspace_id=$1 AND generation_ordinal IS NOT NULL", [WS])).rows[0].n;
const recs = (await c.query("SELECT count(*)::int n FROM generation_result_reconciliations WHERE workspace_id=$1", [WS])).rows[0].n;

console.log(`\n================ OPERATIONAL ================`);
console.log(`  reconciliation records : ${recs}`);
console.log(`  uncertainNeedsReview   : ${open}`);
console.log(`  expiredLeases          : ${expired}`);
console.log(`  generation jobs        : ${jobs}`);
console.log(`  paid provider ordinals : ${paid}   <- the number that must not move`);

await c.end();
process.exit(0);
