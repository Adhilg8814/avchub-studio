// P0 Step 5C.10 — movie_projects / movie_scenes / movie_project_events repository.
//
// Data access for the Story-to-Movie durable model (migration 0018). Every method takes an already
// open tenant-transaction client (RLS-scoped) and returns normalized records. No secrets, proxy
// refs, credentials, absolute paths, or signed URLs are ever accepted or returned (media_meta /
// final_media carry a SAFE relative path + sizes only). Optimistic concurrency via `revision`.

import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";
import { newId } from "../ids.mjs";
import { normalizeMediaEvidence } from "../../../../lib/media/media-evidence-schema.mjs";

const one = (r) => (r.rows[0] ?? null);
function requireClient(client) { if (!client || typeof client.query !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "repository requires a transaction client"); }
function bad(m) { return domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, m); }
const MOV_RE = /^mov_[0-9A-HJKMNP-TV-Z]{26}$/u;
const MSC_RE = /^msc_[0-9A-HJKMNP-TV-Z]{26}$/u;
function isUnsafe(v) { return typeof v === "string" && (/^[A-Za-z]:[\\/]/.test(v) || /^[\\/]/.test(v) || /:\/\//.test(v) || v.includes("..")); }
function assertRelative(ref, field) { if (typeof ref !== "string" || isUnsafe(ref)) throw bad(`${field} must be a safe relative reference`); }
const SECRET_KEY_RE = /(token|cookie|secret|password|authorization|proxy|credential|bearer|apikey|api_key|signed)/i;

function safeJson(v) { if (v === null || v === undefined) return null; if (typeof v === "object") return v; try { const p = JSON.parse(v); return p && typeof p === "object" ? p : null; } catch { return null; } }
// P0 Step 5C.43 - the SAME declared schema the generation projection uses. This allow-list kept eight fields
// and dropped the rest, including sourceVerdict / sourceNative / accountFallbackSuspected - which the movie UI
// projection reads off scene media. Those three have therefore read null since the day they were first
// written, and nothing said so.
function validateMediaMeta(m, field) {
  return normalizeMediaEvidence(m, { field });
}
function assertSafeStory(story) {
  if (story === null || story === undefined) return null;
  const s = JSON.stringify(story);
  if (/:\/\//.test(s) || /[A-Za-z]:\\\\/.test(s)) throw bad("story must not contain URLs or absolute paths");
  return story;
}
// 5C.11 settings bags (narration/music/subtitle/render/publishing) are stored as JSONB knobs; they
// must never carry URLs, absolute paths, or secret-looking keys — same policy as the story text.
function assertSafeSettings(settings, field) {
  if (settings === null || settings === undefined) return null;
  if (typeof settings !== "object" || Array.isArray(settings)) throw bad(`${field} must be an object`);
  const s = JSON.stringify(settings);
  if (/:\/\//.test(s) || /[A-Za-z]:\\\\/.test(s)) throw bad(`${field} must not contain URLs or absolute paths`);
  for (const k of Object.keys(settings)) if (SECRET_KEY_RE.test(k)) throw bad(`${field} key '${k}' not allowed`);
  return settings;
}

// ---- row mapping ----
export function mapProject(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, workspaceId: row.workspace_id, title: row.title, genre: row.genre ?? null,
    language: row.language, targetDurationSeconds: row.target_duration_seconds, aspectRatio: row.aspect_ratio,
    visualStyle: row.visual_style ?? null, characterBible: safeJson(row.character_bible), inputMode: row.input_mode,
    idea: row.idea ?? null, pastedStory: row.pasted_story ?? null, synopsis: row.synopsis ?? null,
    story: safeJson(row.story), status: row.status, finalMedia: safeJson(row.final_media), source: row.source,
    // 5C.45 - the film's audio routing. narrationSource is null until something decides it; it is never
    // inferred from whatever the first scene happened to do.
    audioPolicy: row.audio_policy || "AUTO", narrationSource: row.narration_source ?? null,
    allowMixedVoices: row.allow_mixed_voices === true,
    tone: row.tone ?? null, targetPlatform: row.target_platform ?? "GENERIC", worldBible: row.world_bible ?? null,
    negativeInstructions: row.negative_instructions ?? null, narrationSettings: safeJson(row.narration_settings),
    musicSettings: safeJson(row.music_settings), subtitleSettings: safeJson(row.subtitle_settings),
    renderSettings: safeJson(row.render_settings), publishingMetadata: safeJson(row.publishing_metadata),
    storyApproved: row.story_approved === true, textProvider: row.text_provider ?? "LOCAL",
    // 5C.39 additive: null on every movie made before the scorecard existed, which is unverified.
    qualityState: row.quality_state ?? null,
    qualityScorecardId: row.quality_scorecard_id ?? null,
    revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at ?? null
  });
}
export function mapScene(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, workspaceId: row.workspace_id, movieProjectId: row.movie_project_id, ordinal: row.ordinal,
    heading: row.heading ?? null, narration: row.narration ?? null, visualDescription: row.visual_description ?? null,
    videoPrompt: row.video_prompt, durationSeconds: row.duration_seconds, aspectRatio: row.aspect_ratio,
    continuity: safeJson(row.continuity), generationJobId: row.generation_job_id ?? null,
    generationAttemptId: row.generation_attempt_id ?? null, resultId: row.result_id ?? null,
    mediaMeta: safeJson(row.media_meta), state: row.state, attemptCount: row.attempt_count, errorCode: row.error_code ?? null,
    dialogue: row.dialogue ?? null, camera: row.camera ?? null, lighting: row.lighting ?? null,
    characterIds: safeJson(row.character_ids), negativeInstructions: row.negative_instructions ?? null,
    trimIn: row.trim_in != null ? Number(row.trim_in) : null, trimOut: row.trim_out != null ? Number(row.trim_out) : null,
    transitionType: row.transition_type ?? null, transitionSeconds: row.transition_seconds != null ? Number(row.transition_seconds) : null,
    audioMeta: safeJson(row.audio_meta),
    revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at
  });
}

export const movieRepository = {
  // ---- projects ----
  async insertProject(client, ws, spec) {
    requireClient(client);
    const title = String(spec.title ?? "").trim();
    if (!title) throw bad("title required");
    if (spec.inputMode && !["IDEA", "PASTED"].includes(spec.inputMode)) throw bad("invalid inputMode");
    const id = newId("mov");
    const row = one(await client.query(
      `INSERT INTO movie_projects (workspace_id, id, title, genre, language, target_duration_seconds, aspect_ratio,
         visual_style, character_bible, input_mode, idea, pasted_story, synopsis, source, created_by_user_id)
       VALUES ($1,$2,$3,$4,COALESCE($5,'en'),COALESCE($6,30),COALESCE($7,'9:16'),$8,$9,COALESCE($10,'IDEA'),$11,$12,$13,COALESCE($14,'UI'),$15)
       RETURNING *`,
      [ws, id, title, spec.genre ?? null, spec.language ?? null, spec.targetDurationSeconds ?? null, spec.aspectRatio ?? null,
       spec.visualStyle ?? null, spec.characterBible ? JSON.stringify(spec.characterBible) : null, spec.inputMode ?? null,
       spec.idea ?? null, spec.pastedStory ?? null, spec.synopsis ?? null, spec.source ?? null, spec.createdByUserId ?? null]));
    return mapProject(row);
  },
  async getProject(client, ws, id) { requireClient(client); return mapProject(one(await client.query("SELECT * FROM movie_projects WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async listProjects(client, ws, { limit = 100, offset = 0, includeArchived = false } = {}) {
    requireClient(client);
    const where = includeArchived ? "workspace_id=$1" : "workspace_id=$1 AND archived_at IS NULL";
    const rows = (await client.query(`SELECT * FROM movie_projects WHERE ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [ws, Math.min(Math.max(1, limit), 500), Math.max(0, offset)])).rows;
    return rows.map(mapProject);
  },
  async updateProject(client, ws, id, { expectedRevision = null, patch = {} } = {}) {
    requireClient(client);
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (patch.title !== undefined) { const t = String(patch.title).trim(); if (!t) throw bad("title required"); add("title", t); }
    if (patch.genre !== undefined) add("genre", patch.genre);
    if (patch.language !== undefined) add("language", patch.language || "en");
    if (patch.targetDurationSeconds !== undefined) add("target_duration_seconds", patch.targetDurationSeconds);
    if (patch.aspectRatio !== undefined) add("aspect_ratio", patch.aspectRatio || "9:16");
    if (patch.visualStyle !== undefined) add("visual_style", patch.visualStyle);
    if (patch.characterBible !== undefined) add("character_bible", patch.characterBible ? JSON.stringify(patch.characterBible) : null);
    if (patch.idea !== undefined) add("idea", patch.idea);
    if (patch.pastedStory !== undefined) add("pasted_story", patch.pastedStory);
    if (patch.synopsis !== undefined) add("synopsis", patch.synopsis);
    if (patch.inputMode !== undefined) { if (!["IDEA", "PASTED"].includes(patch.inputMode)) throw bad("invalid inputMode"); add("input_mode", patch.inputMode); }
    if (patch.story !== undefined) add("story", patch.story ? JSON.stringify(assertSafeStory(patch.story)) : null);
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.finalMedia !== undefined) add("final_media", patch.finalMedia ? JSON.stringify(validateMediaMeta(patch.finalMedia, "finalMedia")) : null);
    if (patch.audioPolicy !== undefined) add("audio_policy", String(patch.audioPolicy || "AUTO"));
    if (patch.narrationSource !== undefined) add("narration_source", patch.narrationSource || null);
    if (patch.allowMixedVoices !== undefined) add("allow_mixed_voices", patch.allowMixedVoices === true);
    if (patch.tone !== undefined) add("tone", patch.tone);
    if (patch.targetPlatform !== undefined) { if (!["FACEBOOK_REELS", "FACEBOOK_VIDEO", "GENERIC"].includes(patch.targetPlatform)) throw bad("invalid targetPlatform"); add("target_platform", patch.targetPlatform); }
    if (patch.worldBible !== undefined) add("world_bible", patch.worldBible);
    if (patch.negativeInstructions !== undefined) add("negative_instructions", patch.negativeInstructions);
    if (patch.narrationSettings !== undefined) add("narration_settings", patch.narrationSettings ? JSON.stringify(assertSafeSettings(patch.narrationSettings, "narrationSettings")) : null);
    if (patch.musicSettings !== undefined) add("music_settings", patch.musicSettings ? JSON.stringify(assertSafeSettings(patch.musicSettings, "musicSettings")) : null);
    if (patch.subtitleSettings !== undefined) add("subtitle_settings", patch.subtitleSettings ? JSON.stringify(assertSafeSettings(patch.subtitleSettings, "subtitleSettings")) : null);
    if (patch.renderSettings !== undefined) add("render_settings", patch.renderSettings ? JSON.stringify(assertSafeSettings(patch.renderSettings, "renderSettings")) : null);
    if (patch.publishingMetadata !== undefined) add("publishing_metadata", patch.publishingMetadata ? JSON.stringify(assertSafeSettings(patch.publishingMetadata, "publishingMetadata")) : null);
    if (patch.storyApproved !== undefined) add("story_approved", patch.storyApproved === true);
    if (patch.textProvider !== undefined) { if (!["LOCAL", "GROK_CHAT", "MANUAL"].includes(patch.textProvider)) throw bad("invalid textProvider"); add("text_provider", patch.textProvider); }
    let guard = ""; if (expectedRevision != null) { params.push(expectedRevision); guard = ` AND revision=$${params.length}`; }
    const r = await client.query(`UPDATE movie_projects SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2${guard} AND archived_at IS NULL RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapProject(r.rows[0]) : await this.getProject(client, ws, id) };
  },
  async archiveProject(client, ws, id) {
    requireClient(client);
    const r = await client.query("UPDATE movie_projects SET archived_at=now(), revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id", [ws, id]);
    return { archived: r.rowCount === 1 };
  },

  // ---- scenes ----
  async replaceScenes(client, ws, projectId, scenes) {
    requireClient(client);
    await client.query("DELETE FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2 AND state IN ('PLANNED','FAILED')", [ws, projectId]);
    // Only replace scenes that have NOT started generating (protect in-flight/completed correlation).
    const existing = (await client.query("SELECT ordinal FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2", [ws, projectId])).rows.map((r) => r.ordinal);
    const taken = new Set(existing);
    const out = [];
    let ord = 0;
    for (const s of scenes) {
      while (taken.has(ord)) ord += 1;
      if (!s.videoPrompt) throw bad("scene videoPrompt required");
      const id = newId("msc");
      const row = one(await client.query(
        `INSERT INTO movie_scenes (workspace_id, id, movie_project_id, ordinal, heading, narration, visual_description, video_prompt, duration_seconds, aspect_ratio, continuity, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,6),COALESCE($10,'9:16'),$11,'PLANNED') RETURNING *`,
        [ws, id, projectId, ord, s.heading ?? null, s.narration ?? null, s.visualDescription ?? null, s.videoPrompt, s.durationSeconds ?? null, s.aspectRatio ?? null, s.continuity ? JSON.stringify(s.continuity) : null]));
      out.push(mapScene(row)); ord += 1;
    }
    return out;
  },
  async listScenes(client, ws, projectId) { requireClient(client); return (await client.query("SELECT * FROM movie_scenes WHERE workspace_id=$1 AND movie_project_id=$2 ORDER BY ordinal ASC", [ws, projectId])).rows.map(mapScene); },
  async getScene(client, ws, id) { requireClient(client); return mapScene(one(await client.query("SELECT * FROM movie_scenes WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async updateScene(client, ws, id, { expectedRevision = null, patch = {} } = {}) {
    requireClient(client);
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (patch.heading !== undefined) add("heading", patch.heading);
    if (patch.narration !== undefined) add("narration", patch.narration);
    if (patch.visualDescription !== undefined) add("visual_description", patch.visualDescription);
    if (patch.videoPrompt !== undefined) { if (!String(patch.videoPrompt || "").trim()) throw bad("videoPrompt required"); add("video_prompt", patch.videoPrompt); }
    if (patch.durationSeconds !== undefined) add("duration_seconds", patch.durationSeconds);
    if (patch.aspectRatio !== undefined) add("aspect_ratio", patch.aspectRatio);
    if (patch.continuity !== undefined) add("continuity", patch.continuity ? JSON.stringify(patch.continuity) : null);
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.errorCode !== undefined) add("error_code", patch.errorCode);
    if (patch.generationJobId !== undefined) add("generation_job_id", patch.generationJobId);
    if (patch.generationAttemptId !== undefined) add("generation_attempt_id", patch.generationAttemptId);
    if (patch.resultId !== undefined) add("result_id", patch.resultId);
    if (patch.mediaMeta !== undefined) add("media_meta", patch.mediaMeta ? JSON.stringify(validateMediaMeta(patch.mediaMeta, "mediaMeta")) : null);
    if (patch.dialogue !== undefined) add("dialogue", patch.dialogue);
    if (patch.camera !== undefined) add("camera", patch.camera);
    if (patch.lighting !== undefined) add("lighting", patch.lighting);
    if (patch.characterIds !== undefined) add("character_ids", patch.characterIds ? JSON.stringify(patch.characterIds) : null);
    if (patch.negativeInstructions !== undefined) add("negative_instructions", patch.negativeInstructions);
    if (patch.trimIn !== undefined) { if (patch.trimIn !== null && (!Number.isFinite(patch.trimIn) || patch.trimIn < 0)) throw bad("trimIn invalid"); add("trim_in", patch.trimIn); }
    if (patch.trimOut !== undefined) { if (patch.trimOut !== null && (!Number.isFinite(patch.trimOut) || patch.trimOut <= 0)) throw bad("trimOut invalid"); add("trim_out", patch.trimOut); }
    if (patch.transitionType !== undefined) { if (patch.transitionType !== null && !["FADE", "CUT"].includes(patch.transitionType)) throw bad("invalid transitionType"); add("transition_type", patch.transitionType); }
    if (patch.transitionSeconds !== undefined) { if (patch.transitionSeconds !== null && (!Number.isFinite(patch.transitionSeconds) || patch.transitionSeconds < 0 || patch.transitionSeconds > 3)) throw bad("transitionSeconds invalid"); add("transition_seconds", patch.transitionSeconds); }
    if (patch.audioMeta !== undefined) add("audio_meta", patch.audioMeta ? JSON.stringify(patch.audioMeta) : null);
    if (patch.incrementAttempt === true) sets.push("attempt_count=attempt_count+1");
    let guard = ""; if (expectedRevision != null) { params.push(expectedRevision); guard = ` AND revision=$${params.length}`; }
    const r = await client.query(`UPDATE movie_scenes SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2${guard} RETURNING *`, params);
    return { changed: r.rowCount === 1, row: r.rowCount === 1 ? mapScene(r.rows[0]) : await this.getScene(client, ws, id) };
  },
  async deleteScene(client, ws, id) {
    requireClient(client);
    const r = await client.query("DELETE FROM movie_scenes WHERE workspace_id=$1 AND id=$2 AND state IN ('PLANNED','FAILED') RETURNING id", [ws, id]);
    return { deleted: r.rowCount === 1 };
  },

  // ---- events (redacted, per-project monotonic) ----
  async appendEvent(client, ws, projectId, { type, detail = null } = {}) {
    requireClient(client);
    if (typeof type !== "string" || !type || type.length > 64) throw bad("event type invalid");
    if (detail && typeof detail === "object") for (const k of Object.keys(detail)) { if (SECRET_KEY_RE.test(k)) throw bad(`event detail key '${k}' not allowed`); const v = detail[k]; if (isUnsafe(v)) throw bad(`event detail '${k}' looks like a path/URL`); }
    const row = one(await client.query(
      `INSERT INTO movie_project_events (workspace_id, project_id, seq, type, detail)
       SELECT $1,$2, COALESCE(MAX(seq),0)+1, $3, $4 FROM movie_project_events WHERE workspace_id=$1 AND project_id=$2 RETURNING *`,
      [ws, projectId, type, detail ? JSON.stringify(detail) : null]));
    return { seq: Number(row.seq), type: row.type, at: row.at, detail: safeJson(row.detail) };
  },
  async listEvents(client, ws, projectId, { limit = 200, offset = 0 } = {}) {
    requireClient(client);
    return (await client.query("SELECT seq, type, at, detail FROM movie_project_events WHERE workspace_id=$1 AND project_id=$2 ORDER BY seq ASC LIMIT $3 OFFSET $4", [ws, projectId, Math.min(Math.max(1, limit), 1000), Math.max(0, offset)])).rows.map((e) => ({ seq: Number(e.seq), type: e.type, at: e.at, detail: safeJson(e.detail) }));
  }
};

export { MOV_RE, MSC_RE };
