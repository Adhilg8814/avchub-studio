// P0 Step 5C.39 — the store for everything a movie is made of.
//
// One repository for every artifact kind, because they share one lifecycle: written once, hashed, never
// mutated, superseded by a newer revision that names its predecessor. The alternative — a writer per kind —
// duplicates that lifecycle a dozen times and lets the copies drift apart, which is exactly how "the adaptation
// says one thing and the shot contract says another" becomes possible.
//
// The database enforces the hard parts (immutability trigger, one-active-revision index). This module exists so
// callers cannot construct an artifact that is *valid but meaningless*: no hash, no lineage, a body that is not
// canonical JSON. A content hash computed over a differently-ordered object is a different hash for the same
// content, which would make "did anything change" unanswerable.

import { createHash } from "node:crypto";

function bad(message, code = "E_ARTIFACT_INVALID") { return Object.assign(new Error(message), { code }); }
function requireClient(client) { if (!client || typeof client.query !== "function") throw bad("a database client is required"); }

export const ARTIFACT_KIND = Object.freeze({
  ADAPTATION: "ADAPTATION",
  CHARACTER_BIBLE: "CHARACTER_BIBLE",
  LOCATION_BIBLE: "LOCATION_BIBLE",
  STYLE_BIBLE: "STYLE_BIBLE",
  BEAT_SHEET: "BEAT_SHEET",
  NARRATION_SCRIPT: "NARRATION_SCRIPT",
  NARRATION_AUDIO: "NARRATION_AUDIO",
  AUDIO_ALIGNMENT: "AUDIO_ALIGNMENT",
  TRANSCRIPT_VERIFICATION: "TRANSCRIPT_VERIFICATION",
  SHOT_CONTRACT: "SHOT_CONTRACT",
  SUBTITLE_TIMELINE: "SUBTITLE_TIMELINE",
  SCENE_VISION_VERDICT: "SCENE_VISION_VERDICT",
  SCENE_TECHNICAL_VERDICT: "SCENE_TECHNICAL_VERDICT",
  MOVIE_SCORECARD: "MOVIE_SCORECARD",
  // 5C.45 - what the clip's own audio measures, and which narration source the scene ended up using.
  SOURCE_AUDIO_AUDIT: "SOURCE_AUDIO_AUDIT",
  AUDIO_ROUTING_DECISION: "AUDIO_ROUTING_DECISION",
  AUDIO_MIX_VERDICT: "AUDIO_MIX_VERDICT"
});
const KINDS = new Set(Object.values(ARTIFACT_KIND));

export const CREATOR = Object.freeze({ SYSTEM: "SYSTEM", SCHEDULER: "SCHEDULER", OWNER: "OWNER" });

/**
 * Canonical JSON: object keys sorted at every depth, so the hash depends on the CONTENT and not on the order
 * a particular code path happened to build the object in. Without this, re-deriving an identical artifact
 * produces a different hash and every comparison reports a change that did not happen.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function contentHashOf(body) {
  return `sha256:${createHash("sha256").update(canonicalJson(body), "utf8").digest("hex")}`;
}

function mapArtifact(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, workspaceId: row.workspace_id, movieProjectId: row.movie_project_id,
    kind: row.kind, sceneId: row.scene_id ?? null,
    revision: Number(row.revision), supersedesRevision: row.supersedes_revision == null ? null : Number(row.supersedes_revision),
    sourceKind: row.source_kind ?? null, sourceArtifactId: row.source_artifact_id ?? null,
    sourceRevision: row.source_revision == null ? null : Number(row.source_revision),
    contentHash: row.content_hash, body: row.body,
    creator: row.creator, createdByUserId: row.created_by_user_id ?? null,
    provider: row.provider ?? null, providerAccountId: row.provider_account_id ?? null,
    providerAttemptId: row.provider_attempt_id ?? null, providerRequest: row.provider_request ?? null,
    status: row.status, createdAt: row.created_at, supersededAt: row.superseded_at ?? null
  });
}

const one = (r) => (r && r.rows && r.rows.length ? r.rows[0] : null);

export const movieArtifactRepository = {
  /**
   * Write the next revision of an artifact slot and make it the active one.
   *
   * Idempotent on content: re-deriving an artifact that is byte-identical to the active revision returns that
   * revision instead of creating a redundant one. A pipeline that re-runs a deterministic step should not
   * inflate the revision history, and — more importantly — a render pointing at revision 3 should not find
   * itself looking at a revision 7 whose body is the same thing again.
   */
  async putArtifact(client, ws, {
    id, movieProjectId, kind, sceneId = null, body,
    sourceKind = null, sourceArtifactId = null, sourceRevision = null,
    creator = CREATOR.SYSTEM, createdByUserId = null,
    provider = null, providerAccountId = null, providerAttemptId = null, providerRequest = null,
    status = "ACTIVE"
  } = {}) {
    requireClient(client);
    if (!KINDS.has(kind)) throw bad(`unknown artifact kind ${kind}`);
    if (!movieProjectId || typeof movieProjectId !== "string") throw bad("movieProjectId is required");
    if (!body || typeof body !== "object") throw bad("an artifact body must be an object");
    if (!Object.values(CREATOR).includes(creator)) throw bad(`unknown creator ${creator}`);

    const hash = contentHashOf(body);
    const scene = sceneId ?? null;

    const active = mapArtifact(one(await client.query(
      `SELECT * FROM movie_content_artifacts
        WHERE workspace_id=$1 AND movie_project_id=$2 AND kind=$3 AND COALESCE(scene_id,'')=COALESCE($4,'')
          AND status='ACTIVE'`, [ws, movieProjectId, kind, scene])));

    if (active && active.contentHash === hash) return Object.freeze({ artifact: active, created: false });

    // Retire the current revision first. The partial unique index on (slot) WHERE status='ACTIVE' means a
    // concurrent writer that also got here fails on insert rather than producing two active revisions — the
    // collision is the point, not a problem to work around.
    if (active) {
      await client.query(
        `UPDATE movie_content_artifacts SET status='SUPERSEDED', superseded_at=now()
          WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE'`, [ws, active.id]);
    }

    const next = active ? active.revision + 1 : 1;
    const row = one(await client.query(
      `INSERT INTO movie_content_artifacts
         (workspace_id, id, movie_project_id, kind, scene_id, revision, supersedes_revision,
          source_kind, source_artifact_id, source_revision, content_hash, body,
          creator, created_by_user_id, provider, provider_account_id, provider_attempt_id, provider_request, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [ws, id, movieProjectId, kind, scene, next, active ? active.revision : null,
       sourceKind, sourceArtifactId, sourceRevision, hash, JSON.stringify(body),
       creator, createdByUserId, provider, providerAccountId, providerAttemptId,
       providerRequest ? JSON.stringify(providerRequest) : null, status]));
    return Object.freeze({ artifact: mapArtifact(row), created: true });
  },

  /** The current revision of one slot, or null. Null means never produced — which is UNVERIFIED, not a pass. */
  async getActive(client, ws, { movieProjectId, kind, sceneId = null } = {}) {
    requireClient(client);
    return mapArtifact(one(await client.query(
      `SELECT * FROM movie_content_artifacts
        WHERE workspace_id=$1 AND movie_project_id=$2 AND kind=$3 AND COALESCE(scene_id,'')=COALESCE($4,'')
          AND status='ACTIVE'`, [ws, movieProjectId, kind, sceneId ?? null])));
  },

  /** Every active artifact for a movie, for the view and for render provenance. */
  async listActive(client, ws, movieProjectId) {
    requireClient(client);
    return (await client.query(
      `SELECT * FROM movie_content_artifacts
        WHERE workspace_id=$1 AND movie_project_id=$2 AND status='ACTIVE'
        ORDER BY kind, scene_id NULLS FIRST`, [ws, movieProjectId])).rows.map(mapArtifact);
  },

  /** Full history of one slot, newest first — what a "compare revisions" view reads. */
  async listRevisions(client, ws, { movieProjectId, kind, sceneId = null, limit = 20 } = {}) {
    requireClient(client);
    return (await client.query(
      `SELECT * FROM movie_content_artifacts
        WHERE workspace_id=$1 AND movie_project_id=$2 AND kind=$3 AND COALESCE(scene_id,'')=COALESCE($4,'')
        ORDER BY revision DESC LIMIT $5`, [ws, movieProjectId, kind, sceneId ?? null, limit])).rows.map(mapArtifact);
  },

  /**
   * Bind the artifacts a render consumed to that render. Called once, at completion, with everything active at
   * the moment the file was produced — so the provenance describes the render that exists rather than the
   * artifacts that happen to be current later.
   */
  async recordRenderProvenance(client, ws, { renderId, artifacts = [] } = {}) {
    requireClient(client);
    if (!renderId) throw bad("renderId is required");
    let bound = 0;
    for (const a of artifacts) {
      if (!a || !a.id) continue;
      const r = await client.query(
        `INSERT INTO movie_render_artifacts (workspace_id, render_id, artifact_id, kind, scene_id, revision, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [ws, renderId, a.id, a.kind, a.sceneId ?? null, a.revision, a.contentHash]);
      bound += r.rowCount;
    }
    return { bound };
  },

  async listRenderProvenance(client, ws, renderId) {
    requireClient(client);
    return (await client.query(
      `SELECT * FROM movie_render_artifacts WHERE workspace_id=$1 AND render_id=$2 ORDER BY kind, scene_id NULLS FIRST`,
      [ws, renderId])).rows.map((r) => Object.freeze({
        renderId: r.render_id, artifactId: r.artifact_id, kind: r.kind,
        sceneId: r.scene_id ?? null, revision: Number(r.revision), contentHash: r.content_hash
      }));
  },

  /** The movie's quality verdict. Separate from `status`, because "the pipeline finished" and "this is good
   *  enough to publish" are different questions and conflating them is what this milestone exists to stop. */
  async setQualityState(client, ws, projectId, { state, scorecardId = null } = {}) {
    requireClient(client);
    if (!["PIPELINE_COMPLETED", "QUALITY_REVIEW_REQUIRED", "PUBLISHABLE"].includes(state)) {
      throw bad(`unknown quality state ${state}`);
    }
    const r = await client.query(
      `UPDATE movie_projects SET quality_state=$3, quality_scorecard_id=$4, quality_assessed_at=now()
        WHERE workspace_id=$1 AND id=$2 RETURNING quality_state`, [ws, projectId, state, scorecardId]);
    return { changed: r.rowCount === 1, state: r.rowCount === 1 ? r.rows[0].quality_state : null };
  }
};

export { mapArtifact };
