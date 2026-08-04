// P0 Step 5C.39 — content artifacts on REAL disposable PostgreSQL.
//
// The immutability and one-active-revision rules are enforced by the DATABASE — a trigger and a partial unique
// index — so they can only be proven against a real one. A mock would test my intentions rather than the
// constraints, and the whole reason those rules live in the schema is that intentions do not survive a second
// writer, a crash, or an ops script run at three in the morning.
//
// Provider-free: no browser, no ffmpeg, no quota.

import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { movieArtifactRepository as repo, ARTIFACT_KIND, CREATOR, contentHashOf } from "../control-plane/src/persistence/repositories/movie-artifact-repository.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
// Movie-side ids (mov/scn/rnd/art) come from the persistence generator; the protocol one only knows the
// protocol prefixes and refuses the rest rather than minting an id nothing else will accept.
import { newId } from "../control-plane/src/persistence/ids.mjs";

let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n, d ? `-> ${d}` : ""); } };
// The adapter maps a PostgreSQL check_violation to a generic domain error, so the SPECIFIC reason - immutable
// vs forward-only vs append-only - survives only on the cause. Asserting on the mapped message would prove the
// database refused without proving it refused for the right reason, and those triggers guard different rules.
async function throwsWith(name, fn, match) {
  try { await fn(); check(name, false, "expected a refusal"); }
  catch (e) {
    const parts = [e && e.message, e && e.cause && e.cause.message, e && e.detail, e && e.code].filter(Boolean).map(String);
    const m = parts.join(" | ");
    if (!match || match.test(m)) passed += 1; else { failed += 1; console.log("FAIL", name, "->", m.slice(0, 200)); }
  }
}

if (!livePgAvailable()) { console.log("Step 5C.39 artifact persistence: 0 passed, 0 failed (SKIPPED — no PostgreSQL)"); process.exit(0); }

const live = await startDisposablePg({ namePrefix: "art39" });
let adapter = null;
try {
  const ws = generateId("ws"), wsOther = generateId("ws"), user = generateId("usr");
  const mc = new pg.Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
    await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "art39" });
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    for (const w of [ws, wsOther]) {
      await mc.query("SELECT set_config('app.current_workspace',$1,false)", [w]);
      await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'ART39',$2)", [w, user]);
    }
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const T = (w, fn) => adapter.tenantTransaction(w, fn);

  const movie = newId("mov");
  const otherMovie = newId("mov");
  await T(ws, async (c) => {
    await c.query(`INSERT INTO movie_projects (workspace_id,id,title,language,aspect_ratio,input_mode,status)
                   VALUES ($1,$2,'Artifact probe','da-DK','9:16','IDEA','DRAFT')`, [ws, movie]);
  });
  await T(wsOther, async (c) => {
    await c.query(`INSERT INTO movie_projects (workspace_id,id,title,language,aspect_ratio,input_mode,status)
                   VALUES ($1,$2,'Other tenant','da-DK','9:16','IDEA','DRAFT')`, [wsOther, otherMovie]);
  });

  // ---------------------------------------------------------- P1 the first revision
  const bodyV1 = { format: "SHORT_FORM", hook: "the room goes quiet", narrationScript: "Jeg sad over for dem." };
  const first = await T(ws, (c) => repo.putArtifact(c, ws, {
    id: newId("art"), movieProjectId: movie, kind: ARTIFACT_KIND.ADAPTATION, body: bodyV1,
    creator: CREATOR.SYSTEM, sourceKind: "STORY", sourceRevision: 3
  }));
  check("P1 the first revision is 1", first.artifact.revision === 1 && first.created === true);
  check("P1 it is ACTIVE", first.artifact.status === "ACTIVE");
  check("P1 the hash is over the content, computed the same way the caller would", first.artifact.contentHash === contentHashOf(bodyV1));
  check("P1 lineage is recorded", first.artifact.sourceKind === "STORY" && first.artifact.sourceRevision === 3);
  check("P1 nothing supersedes the first one", first.artifact.supersedesRevision === null);

  // ---------------------------------------------------------- P2 identical content does not churn
  const again = await T(ws, (c) => repo.putArtifact(c, ws, {
    id: newId("art"), movieProjectId: movie, kind: ARTIFACT_KIND.ADAPTATION, body: { ...bodyV1 }, creator: CREATOR.SYSTEM
  }));
  // A deterministic step that re-runs should not inflate history — and a render pointing at revision 1 should
  // not later find a revision 7 whose body is the same thing again.
  check("P2 re-deriving identical content returns the SAME revision", again.created === false && again.artifact.revision === 1);
  check("P2 and the same id", again.artifact.id === first.artifact.id);

  // ---------------------------------------------------------- P3 a real change supersedes
  const bodyV2 = { ...bodyV1, hook: "nobody looked at me" };
  const second = await T(ws, (c) => repo.putArtifact(c, ws, {
    id: newId("art"), movieProjectId: movie, kind: ARTIFACT_KIND.ADAPTATION, body: bodyV2, creator: CREATOR.OWNER, createdByUserId: user
  }));
  check("P3 changed content writes revision 2", second.created === true && second.artifact.revision === 2);
  check("P3 it names its predecessor", second.artifact.supersedesRevision === 1);
  check("P3 the creator is recorded — an owner edit is a different fact from a scheduler repair", second.artifact.creator === CREATOR.OWNER);

  const active = await T(ws, (c) => repo.getActive(c, ws, { movieProjectId: movie, kind: ARTIFACT_KIND.ADAPTATION }));
  check("P3 exactly one revision is active, and it is the new one", active.revision === 2);
  const history = await T(ws, (c) => repo.listRevisions(c, ws, { movieProjectId: movie, kind: ARTIFACT_KIND.ADAPTATION }));
  check("P3 the old revision is kept as history, not deleted", history.length === 2 && history[1].revision === 1);
  check("P3 and marked SUPERSEDED", history[1].status === "SUPERSEDED");

  // ---------------------------------------------------------- P4 immutability is the DATABASE's job
  //
  // Asserted by OUTCOME, not by error message. The adapter maps every check_violation to one domain code, so
  // matching text would prove only that something was refused. What matters is that the row survived intact:
  // that is the actual guarantee, and it holds no matter how the error is packaged on the way out.
  const snapshotOf = (id) => T(ws, async (c) => (await c.query(
    "SELECT body, content_hash, revision, status FROM movie_content_artifacts WHERE workspace_id=$1 AND id=$2", [ws, id])).rows[0]);
  const beforeEdit = await snapshotOf(first.artifact.id);

  const attempts = [
    ["P4 the body cannot be edited", "UPDATE movie_content_artifacts SET body='{\"hook\":\"rewritten\"}'::jsonb WHERE workspace_id=$1 AND id=$2", []],
    ["P4b the hash cannot be edited", "UPDATE movie_content_artifacts SET content_hash=$3 WHERE workspace_id=$1 AND id=$2", ["sha256:" + "0".repeat(64)]],
    ["P4c the revision cannot be edited", "UPDATE movie_content_artifacts SET revision=99 WHERE workspace_id=$1 AND id=$2", []],
    // Resurrecting an old body would silently change what a render claims to be made from.
    ["P4d a SUPERSEDED artifact cannot be made ACTIVE again", "UPDATE movie_content_artifacts SET status='ACTIVE' WHERE workspace_id=$1 AND id=$2", []]
  ];
  for (const [name, sql, extra] of attempts) {
    let threw = false;
    try { await T(ws, (c) => c.query(sql, [ws, first.artifact.id, ...extra])); }
    catch { threw = true; }
    const after = await snapshotOf(first.artifact.id);
    check(name, threw === true && JSON.stringify(after) === JSON.stringify(beforeEdit),
      threw ? "row changed despite the refusal" : "the write was ACCEPTED");
  }

  // ---------------------------------------------------------- P5 one active revision, enforced
  await throwsWith("P5 two ACTIVE revisions in one slot are impossible", () => T(ws, async (c) => {
    await c.query(`INSERT INTO movie_content_artifacts
      (workspace_id,id,movie_project_id,kind,revision,content_hash,body,creator,status)
      VALUES ($1,$2,$3,'ADAPTATION',7,$4,'{}'::jsonb,'SYSTEM','ACTIVE')`,
      [ws, newId("art"), movie, "sha256:" + "a".repeat(64)]);
  }), /duplicate key|unique|E_DUPLICATE|Duplicate request/iu);

  // ---------------------------------------------------------- P6 per-scene slots are independent
  const sceneA = newId("scn"), sceneB = newId("scn");
  const shotA = await T(ws, (c) => repo.putArtifact(c, ws, { id: newId("art"), movieProjectId: movie, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId: sceneA, body: { action: "places a letter" } }));
  const shotB = await T(ws, (c) => repo.putArtifact(c, ws, { id: newId("art"), movieProjectId: movie, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId: sceneB, body: { action: "opens a door" } }));
  check("P6 two scenes each get revision 1 of their own shot contract", shotA.artifact.revision === 1 && shotB.artifact.revision === 1);
  const repaired = await T(ws, (c) => repo.putArtifact(c, ws, { id: newId("art"), movieProjectId: movie, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId: sceneA, body: { action: "places a letter on the table, mid-motion" } }));
  check("P6 repairing one shot advances only that scene", repaired.artifact.revision === 2);
  const stillB = await T(ws, (c) => repo.getActive(c, ws, { movieProjectId: movie, kind: ARTIFACT_KIND.SHOT_CONTRACT, sceneId: sceneB }));
  // This is targeted repair as a data property: the other shot is untouched, not merely un-regenerated.
  check("P6 the other scene is untouched", stillB.revision === 1 && stillB.id === shotB.artifact.id);

  // ---------------------------------------------------------- P7 render provenance
  const renderId = newId("rnd");
  await T(ws, async (c) => {
    await c.query(`INSERT INTO movie_renders (workspace_id,id,movie_project_id,version,render_hash,state)
                   VALUES ($1,$2,$3,1,$4,'COMPLETED')`, [ws, renderId, movie, "sha256:" + "b".repeat(64)]);
  });
  const activeAll = await T(ws, (c) => repo.listActive(c, ws, movie));
  const bound = await T(ws, (c) => repo.recordRenderProvenance(c, ws, { renderId, artifacts: activeAll }));
  check("P7 every active artifact is bound to the render", bound.bound === activeAll.length && activeAll.length >= 3, `${bound.bound}/${activeAll.length}`);
  const prov = await T(ws, (c) => repo.listRenderProvenance(c, ws, renderId));
  check("P7 the render can now say exactly what it was made from", prov.some((p) => p.kind === "ADAPTATION" && p.revision === 2));
  check("P7 including per-scene contracts at their exact revisions", prov.some((p) => p.kind === "SHOT_CONTRACT" && p.sceneId === sceneA && p.revision === 2));
  // Again by outcome: provenance that can be rewritten after the fact describes a render that no longer exists.
  const provCount = () => T(ws, async (c) => Number((await c.query(
    "SELECT count(*)::int n FROM movie_render_artifacts WHERE workspace_id=$1 AND render_id=$2", [ws, renderId])).rows[0].n));
  const provBefore = await provCount();
  for (const [name, sql] of [
    ["P7b provenance cannot be rewritten after the fact", "UPDATE movie_render_artifacts SET revision=1 WHERE workspace_id=$1 AND render_id=$2"],
    ["P7c nor deleted", "DELETE FROM movie_render_artifacts WHERE workspace_id=$1 AND render_id=$2"]
  ]) {
    let threw = false;
    try { await T(ws, (c) => c.query(sql, [ws, renderId])); } catch { threw = true; }
    check(name, threw === true && (await provCount()) === provBefore, threw ? "rows changed" : "the write was ACCEPTED");
  }

  // ---------------------------------------------------------- P8 the quality state
  const before = await T(ws, async (c) => (await c.query("SELECT quality_state FROM movie_projects WHERE workspace_id=$1 AND id=$2", [ws, movie])).rows[0]);
  // The 9 existing production movies have exactly this: never assessed, which reads as unverified rather than
  // as a pass.
  check("P8 a movie starts with no quality state at all", before.quality_state === null);
  await T(ws, (c) => repo.setQualityState(c, ws, movie, { state: "QUALITY_REVIEW_REQUIRED" }));
  const mid = await T(ws, async (c) => (await c.query("SELECT quality_state, quality_assessed_at FROM movie_projects WHERE workspace_id=$1 AND id=$2", [ws, movie])).rows[0]);
  check("P8 a finished render becomes QUALITY_REVIEW_REQUIRED, not publishable", mid.quality_state === "QUALITY_REVIEW_REQUIRED" && mid.quality_assessed_at !== null);
  await T(ws, (c) => repo.setQualityState(c, ws, movie, { state: "PUBLISHABLE", scorecardId: first.artifact.id }));
  const done = await T(ws, async (c) => (await c.query("SELECT quality_state, quality_scorecard_id FROM movie_projects WHERE workspace_id=$1 AND id=$2", [ws, movie])).rows[0]);
  check("P8 PUBLISHABLE carries the scorecard that justified it", done.quality_state === "PUBLISHABLE" && done.quality_scorecard_id === first.artifact.id);
  let badStateThrew = false;
  try { await T(ws, (c) => repo.setQualityState(c, ws, movie, { state: "SHIP_IT" })); } catch { badStateThrew = true; }
  const stillPublishable = await T(ws, async (c) => (await c.query("SELECT quality_state FROM movie_projects WHERE workspace_id=$1 AND id=$2", [ws, movie])).rows[0].quality_state);
  check("P8b an unknown state is refused and changes nothing", badStateThrew === true && stillPublishable === "PUBLISHABLE");

  // ---------------------------------------------------------- P9 tenant isolation
  await T(wsOther, (c) => repo.putArtifact(c, wsOther, { id: newId("art"), movieProjectId: otherMovie, kind: ARTIFACT_KIND.ADAPTATION, body: { hook: "another tenant's film" } }));
  const mine = await T(ws, (c) => repo.listActive(c, ws, movie));
  check("P9 another workspace's artifacts are invisible", mine.every((a) => a.movieProjectId === movie));
  const crossRead = await T(ws, (c) => repo.getActive(c, ws, { movieProjectId: otherMovie, kind: ARTIFACT_KIND.ADAPTATION }));
  check("P9 reading another tenant's movie by id returns nothing", crossRead === null);
  const theirs = await T(wsOther, (c) => repo.listActive(c, wsOther, otherMovie));
  check("P9 and their own workspace still sees it", theirs.length === 1);

  // ---------------------------------------------------------- P10 concurrent writers collide, not merge
  const results = await Promise.allSettled([1, 2, 3].map((i) =>
    T(ws, (c) => repo.putArtifact(c, ws, {
      id: newId("art"), movieProjectId: movie, kind: ARTIFACT_KIND.MOVIE_SCORECARD,
      body: { state: "PUBLISHABLE", writer: i }
    }))));
  const okCount = results.filter((r) => r.status === "fulfilled").length;
  const activeScorecards = await T(ws, async (c) => Number((await c.query(
    "SELECT count(*)::int n FROM movie_content_artifacts WHERE workspace_id=$1 AND movie_project_id=$2 AND kind='MOVIE_SCORECARD' AND status='ACTIVE'",
    [ws, movie])).rows[0].n));
  check("P10 three concurrent writers leave exactly ONE active scorecard", activeScorecards === 1, String(activeScorecards));
  check("P10 at least one succeeded", okCount >= 1, String(okCount));

  // ---------------------------------------------------------- P11 the migration is idempotent
  const mc2 = new pg.Client({ connectionString: live.migrationUrl });
  await mc2.connect();
  try {
    await mrun(mc2, { dir: MIGRATIONS_DIR, appVersion: "art39-again" });
    passed += 1; // re-running every migration must be a no-op
  } catch (e) { failed += 1; console.log("FAIL P11 migrations are not idempotent ->", String(e.message).slice(0, 160)); }
  finally { await mc2.end(); }

} catch (e) {
  failed += 1;
  console.log("FAIL harness threw ->", e && (e.stack || e.message));
} finally {
  try { await adapter?.stop?.(); } catch { /* */ }
  try { await live.stop(); } catch { /* */ }
}

console.log(`Step 5C.39 artifact persistence: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
