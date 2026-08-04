// P0 Step 5C.43 §2 — what the five SUBMIT_UNCERTAIN jobs actually are, before anything touches a browser.
//
// Read-only. Every number here is what the reconciler will have to match against: the prompt it typed, the
// moment it clicked submit, the composer settings it asked for, and whether a file already exists on disk.

import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
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

const jobs = (await c.query(
  `SELECT j.id, j.prompt, j.duration_seconds, j.aspect_ratio, j.created_at, j.error_code,
          j.invocation_state, j.generation_attempt_id, j.result_id, j.media_meta,
          (SELECT at FROM generation_job_events e WHERE e.workspace_id=j.workspace_id AND e.job_id=j.id AND e.type='SUBMIT_ATTEMPTED' ORDER BY seq LIMIT 1) submitted_at,
          r.verdict, r.review_source, r.reviewed_at, r.review_revision
     FROM generation_jobs j
     LEFT JOIN generation_uncertain_reviews r ON r.workspace_id=j.workspace_id AND r.job_id=j.id AND r.superseded_at IS NULL
    WHERE j.workspace_id=$1 AND j.state='SUBMIT_UNCERTAIN'
    ORDER BY j.created_at`, [WS])).rows;

console.log(`SUBMIT_UNCERTAIN jobs: ${jobs.length}\n`);
for (const j of jobs) {
  const promptHash = createHash("sha256").update(String(j.prompt || ""), "utf8").digest("hex");
  const rel = `jobs/${j.id}/generated.mp4`;
  const abs = `${MEDIA}/${rel}`;
  const onDisk = existsSync(abs) ? statSync(abs).size : null;
  console.log(`${j.id}`);
  console.log(`  attempt         : ${j.generation_attempt_id}`);
  console.log(`  requested       : duration=${j.duration_seconds}s aspect=${j.aspect_ratio}`);
  console.log(`  created         : ${new Date(j.created_at).toISOString()}`);
  console.log(`  submitted       : ${j.submitted_at ? new Date(j.submitted_at).toISOString() : "(never — no SUBMIT_ATTEMPTED event)"}`);
  console.log(`  invocation      : ${j.invocation_state}   error=${j.error_code}`);
  console.log(`  promptSha256    : ${promptHash}`);
  console.log(`  promptLength    : ${String(j.prompt || "").length}`);
  console.log(`  promptHead      : ${String(j.prompt || "").slice(0, 90).replace(/\s+/gu, " ")}`);
  console.log(`  resultId        : ${j.result_id || "(none)"}`);
  console.log(`  media_meta      : ${j.media_meta ? Object.keys(j.media_meta).join(",") : "(null)"}`);
  console.log(`  file on disk    : ${onDisk == null ? "(absent)" : `${onDisk} bytes at ${rel}`}`);
  console.log(`  current review  : ${j.verdict ? `${j.verdict} via ${j.review_source} rev${j.review_revision} @ ${new Date(j.reviewed_at).toISOString()}` : "(none)"}`);
  console.log("");
}

// Prompts that collide: the matcher cannot use text alone where two jobs typed the same words.
const byPrompt = new Map();
for (const j of jobs) {
  const h = createHash("sha256").update(String(j.prompt || ""), "utf8").digest("hex");
  byPrompt.set(h, (byPrompt.get(h) || []).concat(j.id));
}
const collisions = [...byPrompt.entries()].filter(([, ids]) => ids.length > 1);
console.log(`prompt collisions among uncertain jobs: ${collisions.length ? collisions.map(([h, ids]) => `${h.slice(0, 12)} -> ${ids.join(", ")}`).join(" | ") : "(none)"}`);

// And across the WHOLE ledger — a card on the provider surface may match an old completed job just as well.
const all = (await c.query("SELECT id, prompt, state FROM generation_jobs WHERE workspace_id=$1", [WS])).rows;
const allByPrompt = new Map();
for (const j of all) {
  const h = createHash("sha256").update(String(j.prompt || ""), "utf8").digest("hex");
  allByPrompt.set(h, (allByPrompt.get(h) || []).concat(`${j.id.slice(-6)}:${j.state}`));
}
const uncertainHashes = new Set(jobs.map((j) => createHash("sha256").update(String(j.prompt || ""), "utf8").digest("hex")));
console.log(`\nsame prompt used by other jobs too:`);
for (const h of uncertainHashes) {
  const ids = allByPrompt.get(h) || [];
  if (ids.length > 1) console.log(`  ${h.slice(0, 12)} -> ${ids.join(", ")}`);
}

const offers = (await c.query(
  `SELECT o.id, o.job_id, o.ownership_status, o.lease_expires_at, o.possibly_submitted
     FROM job_offers o WHERE o.workspace_id=$1 AND o.ownership_status IN ('OFFERED','ACCEPTED','RUNNING','SUBMITTING','RECOVERING')
     ORDER BY o.updated_at DESC`, [WS])).rows;
console.log(`\nopen offers: ${offers.length}`);
for (const o of offers) console.log(`  ${o.job_id.slice(-6)} ${o.ownership_status} possiblySubmitted=${o.possibly_submitted} leaseExpires=${o.lease_expires_at ? new Date(o.lease_expires_at).toISOString() : "-"}`);

await c.end();
