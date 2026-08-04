// P0 Step 5C.11 — Content Studio repository (migration 0019 tables).
//
// Data access for story_text_attempts / scene_audio_assets / movie_renders / publish_attempts.
// Every method takes an already open tenant-transaction client (RLS-scoped) and returns normalized
// records. No secrets, proxy refs, credentials, absolute paths, or signed URLs are ever accepted or
// returned (media JSONB carries a SAFE relative path + sizes only). Optimistic concurrency via
// `revision`. Exactly-once primitives: invocation_state RESERVED→CONSUMED is claimed with a
// conditional UPDATE (only ONE caller wins), submit_state is monotonic NOT_SUBMITTED→SUBMITTED→
// UNCERTAIN, and terminal states never regress.

import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";
import { newId } from "../ids.mjs";

const one = (r) => (r.rows[0] ?? null);
function requireClient(client) { if (!client || typeof client.query !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "repository requires a transaction client"); }
function bad(m) { return domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, m); }
function isUnsafe(v) { return typeof v === "string" && (/^[A-Za-z]:[\\/]/.test(v) || /^[\\/]/.test(v) || /:\/\//.test(v) || v.includes("..")); }
function assertRelative(ref, field) { if (typeof ref !== "string" || isUnsafe(ref)) throw bad(`${field} must be a safe relative reference`); }
function safeJson(v) { if (v === null || v === undefined) return null; if (typeof v === "object") return v; try { const p = JSON.parse(v); return p && typeof p === "object" ? p : null; } catch { return null; } }

// Shared media JSONB shape for audio / render outputs: safe relative path + sizes only.
export function validateContentMedia(m, field) {
  if (m === null || m === undefined) return null;
  if (typeof m !== "object" || Array.isArray(m)) throw bad(`${field} must be an object`);
  assertRelative(m.relativePath, `${field}.relativePath`);
  if (typeof m.sizeBytes !== "number" || m.sizeBytes < 0) throw bad(`${field}.sizeBytes invalid`);
  return {
    relativePath: m.relativePath, sizeBytes: m.sizeBytes,
    container: typeof m.container === "string" ? m.container : null,
    durationSeconds: m.durationSeconds ?? null, width: m.width ?? null, height: m.height ?? null,
    sha256: typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : null
  };
}

const SGA_RE = /^sga_[0-9A-HJKMNP-TV-Z]{26}$/u;
const AUD_RE = /^aud_[0-9A-HJKMNP-TV-Z]{26}$/u;
const RND_RE = /^rnd_[0-9A-HJKMNP-TV-Z]{26}$/u;
const PUB_RE = /^pub_[0-9A-HJKMNP-TV-Z]{26}$/u;

// ---- row mapping ----
export function mapStoryAttempt(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, workspaceId: row.workspace_id, movieProjectId: row.movie_project_id,
    provider: row.provider, promptHash: row.prompt_hash, responseHash: row.response_hash ?? null,
    invocationState: row.invocation_state ?? null, submitState: row.submit_state,
    result: safeJson(row.result), providerResultRef: row.provider_result_ref ?? null,
    state: row.state, errorCode: row.error_code ?? null,
    revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at
  });
}
export function mapAudioAsset(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, workspaceId: row.workspace_id, movieProjectId: row.movie_project_id,
    sceneId: row.scene_id ?? null, kind: row.kind, provider: row.provider ?? null,
    audioAttemptId: row.audio_attempt_id ?? null, invocationState: row.invocation_state ?? null,
    mediaMeta: safeJson(row.media_meta), state: row.state, errorCode: row.error_code ?? null,
    revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at
  });
}
export function mapRender(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, workspaceId: row.workspace_id, movieProjectId: row.movie_project_id,
    version: row.version, renderHash: row.render_hash,
    finalMedia: safeJson(row.final_media), subtitleMedia: safeJson(row.subtitle_media),
    thumbnailMedia: safeJson(row.thumbnail_media), packageMedia: safeJson(row.package_media),
    probe: safeJson(row.probe), state: row.state, errorCode: row.error_code ?? null,
    revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at
  });
}
export function mapPublishAttempt(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, workspaceId: row.workspace_id, movieProjectId: row.movie_project_id,
    renderId: row.render_id ?? null, target: row.target, audience: row.audience ?? null,
    invocationState: row.invocation_state ?? null, submitState: row.submit_state,
    postRef: row.post_ref ?? null, state: row.state, errorCode: row.error_code ?? null,
    revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at
  });
}

// Claim RESERVED→CONSUMED (or NULL→RESERVED) with a conditional UPDATE so exactly ONE caller wins.
async function claimInvocation(client, table, ws, id, { from, to }) {
  const fromCond = from === null ? "invocation_state IS NULL" : "invocation_state=$3";
  const params = from === null ? [ws, id, to] : [ws, id, from, to];
  const toIdx = params.length;
  const r = await client.query(
    `UPDATE ${table} SET invocation_state=$${toIdx}, revision=revision+1, updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND ${fromCond} RETURNING id`, params);
  return r.rowCount === 1;
}

export const contentRepository = {
  // ---------------------------------------------------------------- story_text_attempts
  async insertStoryAttempt(client, ws, { movieProjectId, provider = "LOCAL", promptHash }) {
    requireClient(client);
    if (!["LOCAL", "GROK_CHAT", "MANUAL"].includes(provider)) throw bad("invalid story provider");
    if (typeof promptHash !== "string" || promptHash.length < 8) throw bad("promptHash required");
    const id = newId("sga");
    const row = one(await client.query(
      `INSERT INTO story_text_attempts (workspace_id, id, movie_project_id, provider, prompt_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [ws, id, movieProjectId, provider, promptHash]));
    return mapStoryAttempt(row);
  },
  async getStoryAttempt(client, ws, id) { requireClient(client); return mapStoryAttempt(one(await client.query("SELECT * FROM story_text_attempts WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async listStoryAttempts(client, ws, projectId, { limit = 50 } = {}) {
    requireClient(client);
    return (await client.query("SELECT * FROM story_text_attempts WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY created_at DESC LIMIT $3", [ws, projectId, Math.min(Math.max(1, limit), 200)])).rows.map(mapStoryAttempt);
  },
  // ONE reservation per attempt: NULL→RESERVED; false when already reserved/consumed (never re-run).
  async reserveStoryInvocation(client, ws, id) { requireClient(client); return claimInvocation(client, "story_text_attempts", ws, id, { from: null, to: "RESERVED" }); },
  async consumeStoryInvocation(client, ws, id) { requireClient(client); return claimInvocation(client, "story_text_attempts", ws, id, { from: "RESERVED", to: "CONSUMED" }); },
  async updateStoryAttempt(client, ws, id, { patch = {} } = {}) {
    requireClient(client);
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.submitState !== undefined) add("submit_state", patch.submitState);
    if (patch.responseHash !== undefined) add("response_hash", patch.responseHash);
    if (patch.providerResultRef !== undefined) { if (patch.providerResultRef !== null && isUnsafe(patch.providerResultRef)) throw bad("providerResultRef must be a redacted id"); add("provider_result_ref", patch.providerResultRef); }
    if (patch.result !== undefined) add("result", patch.result ? JSON.stringify(patch.result) : null);
    if (patch.errorCode !== undefined) add("error_code", patch.errorCode);
    // Terminal states never regress (COMPLETED/FAILED/UNCERTAIN stay put).
    const r = await client.query(`UPDATE story_text_attempts SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('COMPLETED','FAILED','UNCERTAIN') RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapStoryAttempt(r.rows[0]) : await this.getStoryAttempt(client, ws, id) };
  },

  // ---------------------------------------------------------------- scene_audio_assets
  async insertAudioAsset(client, ws, { movieProjectId, sceneId = null, kind, provider = null }) {
    requireClient(client);
    if (!["NARRATION", "MUSIC", "UPLOAD"].includes(kind)) throw bad("invalid audio kind");
    const id = newId("aud");
    const row = one(await client.query(
      `INSERT INTO scene_audio_assets (workspace_id, id, movie_project_id, scene_id, kind, provider, audio_attempt_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [ws, id, movieProjectId, sceneId, kind, provider, newId("audat")]));
    return mapAudioAsset(row);
  },
  async getAudioAsset(client, ws, id) { requireClient(client); return mapAudioAsset(one(await client.query("SELECT * FROM scene_audio_assets WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async listAudioAssets(client, ws, projectId, { kind = null } = {}) {
    requireClient(client);
    const params = [ws, projectId]; let where = "workspace_id=$1 AND movie_project_id=$2";
    if (kind) { params.push(kind); where += ` AND kind=$${params.length}`; }
    return (await client.query(`SELECT * FROM scene_audio_assets WHERE ${where} ORDER BY created_at ASC`, params)).rows.map(mapAudioAsset);
  },
  async reserveAudioInvocation(client, ws, id) { requireClient(client); return claimInvocation(client, "scene_audio_assets", ws, id, { from: null, to: "RESERVED" }); },
  async consumeAudioInvocation(client, ws, id) { requireClient(client); return claimInvocation(client, "scene_audio_assets", ws, id, { from: "RESERVED", to: "CONSUMED" }); },
  async updateAudioAsset(client, ws, id, { patch = {} } = {}) {
    requireClient(client);
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.provider !== undefined) add("provider", patch.provider);
    if (patch.mediaMeta !== undefined) add("media_meta", patch.mediaMeta ? JSON.stringify(validateContentMedia(patch.mediaMeta, "mediaMeta")) : null);
    if (patch.errorCode !== undefined) add("error_code", patch.errorCode);
    const r = await client.query(`UPDATE scene_audio_assets SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2 RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapAudioAsset(r.rows[0]) : await this.getAudioAsset(client, ws, id) };
  },
  async deleteAudioAsset(client, ws, id) {
    requireClient(client);
    const r = await client.query("DELETE FROM scene_audio_assets WHERE workspace_id=$1 AND id=$2 RETURNING id", [ws, id]);
    return { deleted: r.rowCount === 1 };
  },

  // ---------------------------------------------------------------- movie_renders
  // Version allocation happens under the caller's transaction: MAX(version)+1 with the UNIQUE
  // (workspace, project, version) constraint as the backstop against concurrent renders.
  async insertRender(client, ws, { movieProjectId, renderHash }) {
    requireClient(client);
    if (typeof renderHash !== "string" || renderHash.length < 8) throw bad("renderHash required");
    const id = newId("rnd");
    const row = one(await client.query(
      `INSERT INTO movie_renders (workspace_id, id, movie_project_id, version, render_hash)
       SELECT $1,$2,$3, COALESCE(MAX(version),0)+1, $4 FROM movie_renders WHERE workspace_id=$1 AND movie_project_id=$3
       RETURNING *`, [ws, id, movieProjectId, renderHash]));
    return mapRender(row);
  },
  async getRender(client, ws, id) { requireClient(client); return mapRender(one(await client.query("SELECT * FROM movie_renders WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async listRenders(client, ws, projectId) {
    requireClient(client);
    return (await client.query("SELECT * FROM movie_renders WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY version DESC", [ws, projectId])).rows.map(mapRender);
  },
  // renderHash unchanged → the COMPLETED render is reused, never re-rendered (golden invariant).
  async findCompletedRenderByHash(client, ws, projectId, renderHash) {
    requireClient(client);
    return mapRender(one(await client.query("SELECT * FROM movie_renders WHERE workspace_id=$1 AND movie_project_id=$2 AND render_hash=$3 AND state='COMPLETED' ORDER BY version DESC LIMIT 1", [ws, projectId, renderHash])));
  },
  async updateRender(client, ws, id, { patch = {} } = {}) {
    requireClient(client);
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    for (const [key, col] of [["finalMedia", "final_media"], ["subtitleMedia", "subtitle_media"], ["thumbnailMedia", "thumbnail_media"], ["packageMedia", "package_media"]]) {
      if (patch[key] !== undefined) add(col, patch[key] ? JSON.stringify(validateContentMedia(patch[key], key)) : null);
    }
    if (patch.probe !== undefined) {
      if (patch.probe && typeof patch.probe === "object") {
        for (const v of Object.values(patch.probe)) if (isUnsafe(v)) throw bad("probe must not contain paths/URLs");
      }
      add("probe", patch.probe ? JSON.stringify(patch.probe) : null);
    }
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.errorCode !== undefined) add("error_code", patch.errorCode);
    // A COMPLETED render is immutable evidence — only its package fields may be attached later.
    const packageOnly = Object.keys(patch).every((k) => ["packageMedia"].includes(k));
    const guard = packageOnly ? "" : " AND state NOT IN ('COMPLETED','FAILED')";
    const r = await client.query(`UPDATE movie_renders SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2${guard} RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapRender(r.rows[0]) : await this.getRender(client, ws, id) };
  },

  // ---------------------------------------------------------------- publish_attempts
  async insertPublishAttempt(client, ws, { movieProjectId, renderId = null, target = "PACKAGE", audience = null }) {
    requireClient(client);
    if (!["FACEBOOK", "PACKAGE"].includes(target)) throw bad("invalid publish target");
    if (audience !== null && !["DRAFT", "ONLY_ME", "PUBLIC"].includes(audience)) throw bad("invalid audience");
    const id = newId("pub");
    const row = one(await client.query(
      `INSERT INTO publish_attempts (workspace_id, id, movie_project_id, render_id, target, audience)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ws, id, movieProjectId, renderId, target, audience]));
    return mapPublishAttempt(row);
  },
  async getPublishAttempt(client, ws, id) { requireClient(client); return mapPublishAttempt(one(await client.query("SELECT * FROM publish_attempts WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async listPublishAttempts(client, ws, projectId, { limit = 50 } = {}) {
    requireClient(client);
    return (await client.query("SELECT * FROM publish_attempts WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY created_at DESC LIMIT $3", [ws, projectId, Math.min(Math.max(1, limit), 200)])).rows.map(mapPublishAttempt);
  },
  async reservePublishInvocation(client, ws, id) { requireClient(client); return claimInvocation(client, "publish_attempts", ws, id, { from: null, to: "RESERVED" }); },
  async consumePublishInvocation(client, ws, id) { requireClient(client); return claimInvocation(client, "publish_attempts", ws, id, { from: "RESERVED", to: "CONSUMED" }); },
  async updatePublishAttempt(client, ws, id, { patch = {} } = {}) {
    requireClient(client);
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.submitState !== undefined) add("submit_state", patch.submitState);
    if (patch.postRef !== undefined) { if (patch.postRef !== null && isUnsafe(patch.postRef)) throw bad("postRef must be a redacted reference"); add("post_ref", patch.postRef); }
    if (patch.errorCode !== undefined) add("error_code", patch.errorCode);
    // Terminal publish outcomes (COMPLETED/FAILED/UNCERTAIN) never regress; UNCERTAIN is never retried.
    const r = await client.query(`UPDATE publish_attempts SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('COMPLETED','FAILED','UNCERTAIN') RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapPublishAttempt(r.rows[0]) : await this.getPublishAttempt(client, ws, id) };
  }
};

export { SGA_RE, AUD_RE, RND_RE, PUB_RE };
