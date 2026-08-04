// P0 Step 5C.16 — Story Content Factory repository (migration 0020 tables).
//
// Data access for content_brand_profiles / story_archetypes / story_projects + the versioned outputs
// (dna/outline/text/title/package/quality/fingerprint), staged generation attempts, events, and the
// story->movie link. Every method takes an already-open tenant-transaction client (RLS-scoped) and
// returns normalized records. No secrets/proxy/credentials/absolute-paths/URLs are accepted or
// returned. Optimistic concurrency via `revision`; exactly-once invocation via a conditional UPDATE.

import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";
import { newId } from "../ids.mjs";

const one = (r) => (r.rows[0] ?? null);
function requireClient(client) { if (!client || typeof client.query !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "repository requires a transaction client"); }
function bad(m) { return domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, m); }
function J(v) { return v === null || v === undefined ? null : JSON.stringify(v); }
function safeJson(v) { if (v === null || v === undefined) return null; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } }
function isUnsafe(v) { return typeof v === "string" && (/^[A-Za-z]:[\\/]/.test(v) || /:\/\//.test(v)); }

async function nextVersion(client, table, ws, projectId) {
  const r = await client.query(`SELECT COALESCE(MAX(version),0)+1 AS v FROM ${table} WHERE workspace_id=$1 AND story_project_id=$2`, [ws, projectId]);
  return Number(r.rows[0].v);
}
async function claimInvocation(client, ws, id, { from, to }) {
  const fromCond = from === null ? "invocation_state IS NULL" : "invocation_state=$3";
  const params = from === null ? [ws, id, to] : [ws, id, from, to];
  const r = await client.query(`UPDATE story_generation_attempts SET invocation_state=$${params.length}, revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND ${fromCond} RETURNING id`, params);
  return r.rowCount === 1;
}

// ---- mappers ----
export function mapBrandProfile(r) {
  if (!r) return null;
  return Object.freeze({
    id: r.id, workspaceId: r.workspace_id, seedKey: r.seed_key ?? null, name: r.name, country: r.country,
    locale: r.locale, language: r.language, audience: r.audience, genreFamily: r.genre_family,
    narratorPerspective: r.narrator_perspective, narrativeTense: r.narrative_tense, tone: r.tone,
    emotionalArc: safeJson(r.emotional_arc) || [], titlePattern: r.title_pattern, hookPattern: r.hook_pattern,
    endingPattern: r.ending_pattern, preferredArchetypes: safeJson(r.preferred_archetypes) || [],
    prohibitedPatterns: safeJson(r.prohibited_patterns) || [], targetWordRange: safeJson(r.target_word_range) || {},
    paragraphStyle: r.paragraph_style, dialogueDensity: r.dialogue_density, dramaIntensity: Number(r.drama_intensity),
    realismLevel: r.realism_level, visualStyle: r.visual_style, archived: r.archived,
    revision: Number(r.revision), createdAt: r.created_at, updatedAt: r.updated_at
  });
}
export function mapArchetype(r) {
  if (!r) return null;
  return Object.freeze({
    id: r.id, workspaceId: r.workspace_id, name: r.name,
    protagonistRoles: safeJson(r.protagonist_roles) || [], antagonistRelationships: safeJson(r.antagonist_relationships) || [],
    coreConflicts: safeJson(r.core_conflicts) || [], humiliationTypes: safeJson(r.humiliation_types) || [],
    leverageTypes: safeJson(r.leverage_types) || [], reversalTypes: safeJson(r.reversal_types) || [],
    consequenceTypes: safeJson(r.consequence_types) || [], emotionalResolutionTypes: safeJson(r.emotional_resolution_types) || [],
    compatibleLocales: safeJson(r.compatible_locales) || [], prohibitedCombinations: safeJson(r.prohibited_combinations) || [],
    noveltyDimensions: safeJson(r.novelty_dimensions) || [], archived: r.archived, revision: Number(r.revision),
    createdAt: r.created_at, updatedAt: r.updated_at
  });
}
export function mapProject(r) {
  if (!r) return null;
  return Object.freeze({
    id: r.id, workspaceId: r.workspace_id, brandProfileId: r.brand_profile_id ?? null, archetypeId: r.archetype_id ?? null,
    country: r.country, locale: r.locale, language: r.language, targetAudience: r.target_audience,
    targetLength: r.target_length, dramaIntensity: Number(r.drama_intensity), realismLevel: r.realism_level,
    seedIdea: r.seed_idea ?? null, status: r.status,
    currentDnaId: r.current_dna_id ?? null, currentOutlineId: r.current_outline_id ?? null,
    currentTextId: r.current_text_id ?? null, currentPackageId: r.current_package_id ?? null,
    currentQualityId: r.current_quality_id ?? null, currentFingerprintId: r.current_fingerprint_id ?? null,
    title: r.title ?? null, wordCount: r.word_count ?? null, overallScore: r.overall_score != null ? Number(r.overall_score) : null,
    errorCode: r.error_code ?? null,
    lengthPreset: r.length_preset ?? "STANDARD", customReadingMinutes: safeJson(r.custom_reading_minutes),
    lengthTarget: safeJson(r.length_target), storyPlan: safeJson(r.story_plan), sections: safeJson(r.sections),
    metrics: safeJson(r.metrics), lengthGateState: r.length_gate_state ?? null, revisionCount: r.revision_count != null ? Number(r.revision_count) : 0,
    currentRunId: r.current_run_id ?? null,
    qualityRepairCount: r.quality_repair_count != null ? Number(r.quality_repair_count) : 0,
    qualityVerdict: safeJson(r.quality_verdict),
    repairNextEligibleAt: r.repair_next_eligible_at ?? null,
    revision: Number(r.revision), createdAt: r.created_at, updatedAt: r.updated_at
  });
}
const mapVersioned = (r) => (r ? Object.freeze({ ...r, revision: r.revision != null ? Number(r.revision) : undefined }) : null);
function mapSchedule(r) {
  return r ? Object.freeze({
    id: r.id, storyProjectId: r.story_project_id, state: r.state,
    attempt: Number(r.attempt), sourceRevision: r.source_revision != null ? Number(r.source_revision) : null,
    idempotencyKey: r.idempotency_key ?? null,
    leaseOwner: r.lease_owner ?? null, leaseExpiresAt: r.lease_expires_at ?? null, heartbeatAt: r.heartbeat_at ?? null,
    nextEligibleAt: r.next_eligible_at, deferrals: Number(r.deferrals),
    lastError: r.last_error ?? null, lastAction: r.last_action ?? null,
    enqueuedAt: r.enqueued_at, updatedAt: r.updated_at
  }) : null;
}
function mapRepair(r) {
  return r ? Object.freeze({
    id: r.id, storyProjectId: r.story_project_id, attempt: Number(r.attempt),
    sourceTextId: r.source_text_id, resultTextId: r.result_text_id ?? null,
    triggerCode: r.trigger_code, band: r.band,
    verdictBefore: safeJson(r.verdict_before), verdictAfter: safeJson(r.verdict_after),
    outcome: r.outcome, providerCalls: Number(r.provider_calls), errorCode: r.error_code ?? null,
    submitState: r.submit_state ?? "NOT_SUBMITTED", stage: r.stage ?? null,
    idempotencyKey: r.idempotency_key ?? null, actor: r.actor ?? "MANUAL",
    startedAt: r.started_at, finishedAt: r.finished_at ?? null
  }) : null;
}

export const storyRepository = {
  // ---------------- content brand profiles ----------------
  async upsertSeedBrandProfile(client, ws, profile) {
    requireClient(client);
    const existing = one(await client.query("SELECT * FROM content_brand_profiles WHERE workspace_id=$1 AND seed_key=$2", [ws, profile.seedKey]));
    if (existing) return mapBrandProfile(existing);
    const id = newId("cbp");
    const row = one(await client.query(
      `INSERT INTO content_brand_profiles (workspace_id,id,seed_key,name,country,locale,language,audience,genre_family,narrator_perspective,narrative_tense,tone,emotional_arc,title_pattern,hook_pattern,ending_pattern,preferred_archetypes,prohibited_patterns,target_word_range,paragraph_style,dialogue_density,drama_intensity,realism_level,visual_style)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [ws, id, profile.seedKey, profile.name, profile.country, profile.locale, profile.language, profile.audience, profile.genreFamily, profile.narratorPerspective, profile.narrativeTense, profile.tone, J(profile.emotionalArc), profile.titlePattern, profile.hookPattern, profile.endingPattern, J(profile.preferredArchetypes), J(profile.prohibitedPatterns), J(profile.targetWordRange), profile.paragraphStyle, profile.dialogueDensity, profile.dramaIntensity, profile.realismLevel, profile.visualStyle]));
    return mapBrandProfile(row);
  },
  async insertBrandProfile(client, ws, p) {
    requireClient(client);
    const id = newId("cbp");
    const row = one(await client.query(
      `INSERT INTO content_brand_profiles (workspace_id,id,seed_key,name,country,locale,language,audience,genre_family,narrator_perspective,narrative_tense,tone,emotional_arc,title_pattern,hook_pattern,ending_pattern,preferred_archetypes,prohibited_patterns,target_word_range,paragraph_style,dialogue_density,drama_intensity,realism_level,visual_style)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
      [ws, id, p.name, p.country, p.locale, p.language, p.audience, p.genreFamily, p.narratorPerspective, p.narrativeTense, p.tone, J(p.emotionalArc), p.titlePattern, p.hookPattern, p.endingPattern, J(p.preferredArchetypes), J(p.prohibitedPatterns), J(p.targetWordRange), p.paragraphStyle, p.dialogueDensity, p.dramaIntensity, p.realismLevel, p.visualStyle]));
    return mapBrandProfile(row);
  },
  async getBrandProfile(client, ws, id) { requireClient(client); return mapBrandProfile(one(await client.query("SELECT * FROM content_brand_profiles WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async listBrandProfiles(client, ws) { requireClient(client); return (await client.query("SELECT * FROM content_brand_profiles WHERE workspace_id=$1 AND archived=FALSE ORDER BY locale, name", [ws])).rows.map(mapBrandProfile); },
  async updateBrandProfile(client, ws, id, { patch = {}, expectedRevision = null } = {}) {
    requireClient(client);
    const cols = { name: "name", country: "country", audience: "audience", genreFamily: "genre_family", narratorPerspective: "narrator_perspective", narrativeTense: "narrative_tense", tone: "tone", titlePattern: "title_pattern", hookPattern: "hook_pattern", endingPattern: "ending_pattern", paragraphStyle: "paragraph_style", dialogueDensity: "dialogue_density", dramaIntensity: "drama_intensity", realismLevel: "realism_level", visualStyle: "visual_style", language: "language" };
    const jsonCols = { emotionalArc: "emotional_arc", preferredArchetypes: "preferred_archetypes", prohibitedPatterns: "prohibited_patterns", targetWordRange: "target_word_range" };
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    for (const [k, col] of Object.entries(cols)) if (patch[k] !== undefined) { params.push(patch[k]); sets.push(`${col}=$${params.length}`); }
    for (const [k, col] of Object.entries(jsonCols)) if (patch[k] !== undefined) { params.push(J(patch[k])); sets.push(`${col}=$${params.length}`); }
    if (patch.archived !== undefined) { params.push(Boolean(patch.archived)); sets.push(`archived=$${params.length}`); }
    let where = "workspace_id=$1 AND id=$2";
    if (expectedRevision !== null) { params.push(expectedRevision); where += ` AND revision=$${params.length}`; }
    const r = await client.query(`UPDATE content_brand_profiles SET ${sets.join(", ")} WHERE ${where} RETURNING *`, params);
    if (r.rowCount !== 1) throw domainError(DOMAIN_ERRORS.E_CONFLICT || DOMAIN_ERRORS.E_INVALID_ARGUMENT, "brand profile update conflict");
    return mapBrandProfile(r.rows[0]);
  },

  // ---------------- archetypes ----------------
  async upsertSeedArchetype(client, ws, a) {
    requireClient(client);
    const existing = one(await client.query("SELECT * FROM story_archetypes WHERE workspace_id=$1 AND id=$2", [ws, a.id]));
    if (existing) return mapArchetype(existing);
    const row = one(await client.query(
      `INSERT INTO story_archetypes (workspace_id,id,name,protagonist_roles,antagonist_relationships,core_conflicts,humiliation_types,leverage_types,reversal_types,consequence_types,emotional_resolution_types,compatible_locales,prohibited_combinations,novelty_dimensions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ws, a.id, a.name, J(a.protagonistRoles), J(a.antagonistRelationships), J(a.coreConflicts), J(a.humiliationTypes), J(a.leverageTypes), J(a.reversalTypes), J(a.consequenceTypes), J(a.emotionalResolutionTypes), J(a.compatibleLocales), J(a.prohibitedCombinations), J(a.noveltyDimensions)]));
    return mapArchetype(row);
  },
  async getArchetype(client, ws, id) { requireClient(client); return mapArchetype(one(await client.query("SELECT * FROM story_archetypes WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async listArchetypes(client, ws) { requireClient(client); return (await client.query("SELECT * FROM story_archetypes WHERE workspace_id=$1 AND archived=FALSE ORDER BY id", [ws])).rows.map(mapArchetype); },

  // ---------------- story projects ----------------
  async insertProject(client, ws, p) {
    requireClient(client);
    const id = newId("stp");
    const row = one(await client.query(
      `INSERT INTO story_projects (workspace_id,id,brand_profile_id,archetype_id,country,locale,language,target_audience,target_length,drama_intensity,realism_level,seed_idea,length_preset,custom_reading_minutes,length_target)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [ws, id, p.brandProfileId ?? null, p.archetypeId ?? null, p.country ?? "", p.locale, p.language ?? "", p.targetAudience ?? "", p.targetLength ?? "medium", p.dramaIntensity ?? 3, p.realismLevel ?? "GROUNDED", p.seedIdea ?? null, p.lengthPreset ?? "STANDARD", J(p.customReadingMinutes), J(p.lengthTarget)]));
    return mapProject(row);
  },
  async getProject(client, ws, id) { requireClient(client); return mapProject(one(await client.query("SELECT * FROM story_projects WHERE workspace_id=$1 AND id=$2", [ws, id]))); },
  async listProjects(client, ws, { limit = 100 } = {}) { requireClient(client); return (await client.query("SELECT * FROM story_projects WHERE workspace_id=$1 AND status<>'ARCHIVED' ORDER BY created_at DESC LIMIT $2", [ws, Math.min(500, limit)])).rows.map(mapProject); },
  async updateProject(client, ws, id, { patch = {}, expectedRevision = null } = {}) {
    requireClient(client);
    const cols = { brandProfileId: "brand_profile_id", archetypeId: "archetype_id", country: "country", language: "language", targetAudience: "target_audience", targetLength: "target_length", dramaIntensity: "drama_intensity", realismLevel: "realism_level", seedIdea: "seed_idea", status: "status", currentDnaId: "current_dna_id", currentOutlineId: "current_outline_id", currentTextId: "current_text_id", currentPackageId: "current_package_id", currentQualityId: "current_quality_id", currentFingerprintId: "current_fingerprint_id", title: "title", wordCount: "word_count", overallScore: "overall_score", errorCode: "error_code", lengthPreset: "length_preset", lengthGateState: "length_gate_state", revisionCount: "revision_count", currentRunId: "current_run_id", qualityRepairCount: "quality_repair_count", repairNextEligibleAt: "repair_next_eligible_at" };
    const jsonCols = { customReadingMinutes: "custom_reading_minutes", lengthTarget: "length_target", storyPlan: "story_plan", sections: "sections", metrics: "metrics", qualityVerdict: "quality_verdict" };
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    for (const [k, col] of Object.entries(cols)) if (patch[k] !== undefined) { if (typeof patch[k] === "string" && isUnsafe(patch[k]) && k !== "seedIdea") throw bad(`${k} must not contain a URL/path`); params.push(patch[k]); sets.push(`${col}=$${params.length}`); }
    for (const [k, col] of Object.entries(jsonCols)) if (patch[k] !== undefined) { params.push(J(patch[k])); sets.push(`${col}=$${params.length}`); }
    let where = "workspace_id=$1 AND id=$2";
    if (expectedRevision !== null) { params.push(expectedRevision); where += ` AND revision=$${params.length}`; }
    const r = await client.query(`UPDATE story_projects SET ${sets.join(", ")} WHERE ${where} RETURNING *`, params);
    if (r.rowCount !== 1) return { changed: false, row: await this.getProject(client, ws, id) };
    return { changed: true, row: mapProject(r.rows[0]) };
  },

  // ---------------- quality repair ledger (P0 Step 5C.34) ----------------
  // One row per (project, attempt). The UNIQUE(workspace_id, story_project_id, attempt) constraint IS the
  // concurrency primitive: two callers racing a repair both try to insert attempt N and exactly one wins,
  // so a repair can never run twice in parallel and can never exceed its bound by racing. The loser gets
  // null and backs off rather than starting a second provider call for the same work.
  async claimQualityRepair(client, ws, { storyProjectId, attempt, sourceTextId, triggerCode, band, verdictBefore = null, stage = null, idempotencyKey = null, actor = "MANUAL" }) {
    requireClient(client);
    const id = newId("sqr");
    const r = await client.query(
      `INSERT INTO story_quality_repairs (workspace_id,id,story_project_id,attempt,source_text_id,trigger_code,band,verdict_before,stage,idempotency_key,actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (workspace_id, story_project_id, attempt) DO NOTHING RETURNING *`,
      [ws, id, storyProjectId, attempt, sourceTextId, triggerCode, band, J(verdictBefore), stage, idempotencyKey, actor]);
    return r.rowCount === 1 ? mapRepair(r.rows[0]) : null;
  },

  // Record that the provider call for this attempt was reached. Written from the SAME onBeforeSubmit hook
  // the chat stage uses, so the evidence lands before the request can possibly be answered — which is what
  // lets a restart tell "never sent" from "may have been sent" instead of guessing.
  async markQualityRepairSubmitted(client, ws, id, { submitState = "SUBMITTED", stage = null } = {}) {
    requireClient(client);
    const r = await client.query(
      `UPDATE story_quality_repairs SET submit_state=$3, stage=COALESCE($4, stage), outcome=CASE WHEN outcome='PENDING' THEN 'RUNNING' ELSE outcome END
        WHERE workspace_id=$1 AND id=$2 RETURNING *`, [ws, id, submitState, stage]);
    return r.rowCount === 1 ? mapRepair(r.rows[0]) : null;
  },

  async getQualityRepairAttempt(client, ws, { storyProjectId, attempt }) {
    requireClient(client);
    const r = await client.query(
      "SELECT * FROM story_quality_repairs WHERE workspace_id=$1 AND story_project_id=$2 AND attempt=$3",
      [ws, storyProjectId, attempt]);
    return r.rowCount === 1 ? mapRepair(r.rows[0]) : null;
  },

  async finishQualityRepair(client, ws, id, { outcome, resultTextId = null, verdictAfter = null, providerCalls = 0, errorCode = null }) {
    requireClient(client);
    const r = await client.query(
      `UPDATE story_quality_repairs SET outcome=$3, result_text_id=$4, verdict_after=$5, provider_calls=$6, error_code=$7, finished_at=now()
       WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [ws, id, outcome, resultTextId, J(verdictAfter), providerCalls, errorCode]);
    return r.rowCount === 1 ? mapRepair(r.rows[0]) : null;
  },

  async listQualityRepairs(client, ws, storyProjectId) {
    requireClient(client);
    const r = await client.query(
      "SELECT * FROM story_quality_repairs WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY attempt",
      [ws, storyProjectId]);
    return r.rows.map(mapRepair);
  },

  // ---------------- auto-repair schedule (P0 Step 5C.35) ----------------
  // The durable eligible record. One row per story; the row IS the authorisation to work on it.

  async upsertRepairSchedule(client, ws, { storyProjectId, nextEligibleAt = null } = {}) {
    requireClient(client);
    const id = newId("srs");
    const r = await client.query(
      `INSERT INTO story_repair_schedule (id, workspace_id, story_project_id, state, next_eligible_at)
       VALUES ($1,$2,$3,'ELIGIBLE', COALESCE($4, now()))
       ON CONFLICT (workspace_id, story_project_id) DO UPDATE
         SET state = CASE WHEN story_repair_schedule.state IN ('DONE','BLOCKED','MANUAL_REVIEW') THEN story_repair_schedule.state ELSE story_repair_schedule.state END,
             updated_at = now()
       RETURNING *`,
      [id, ws, storyProjectId, nextEligibleAt]);
    return mapSchedule(r.rows[0]);
  },

  // Everything due right now, oldest first. FIFO is the anti-starvation property: a story that has been
  // waiting longest is picked before one that just became eligible, regardless of how often it deferred.
  async listDueRepairs(client, ws, { nowMs = Date.now(), limit = 20 } = {}) {
    requireClient(client);
    const r = await client.query(
      `SELECT * FROM story_repair_schedule
        WHERE workspace_id=$1
          AND state IN ('ELIGIBLE','WAITING_COOLDOWN','LEASED')
          AND next_eligible_at <= to_timestamp($2/1000.0)
          AND (lease_expires_at IS NULL OR lease_expires_at <= to_timestamp($2/1000.0))
        ORDER BY enqueued_at ASC, story_project_id ASC
        LIMIT $3`, [ws, nowMs, limit]);
    return r.rows.map(mapSchedule);
  },

  // The claim. A single conditional UPDATE is the concurrency primitive: two schedulers racing the same
  // story both run this, and only one can observe a row change. An expired lease is reclaimable, which is
  // what makes a crashed scheduler recoverable without any external reaper.
  async claimRepairSchedule(client, ws, { storyProjectId, owner, leaseMs, attempt, sourceRevision, idempotencyKey, nowMs = Date.now() }) {
    requireClient(client);
    const r = await client.query(
      `UPDATE story_repair_schedule
          SET state='LEASED', lease_owner=$3,
              lease_expires_at = to_timestamp($4/1000.0) + ($5 || ' milliseconds')::interval,
              heartbeat_at = to_timestamp($4/1000.0),
              attempt=$6, source_revision=$7, idempotency_key=$8, updated_at=now()
        WHERE workspace_id=$1 AND story_project_id=$2
          -- LEASED is included on purpose: a scheduler that died still holds the row, and the ONLY thing
          -- that distinguishes "working" from "dead" is whether its lease has expired. Requiring an
          -- external reaper to clean up would just move the same problem somewhere it can also die.
          AND state IN ('ELIGIBLE','WAITING_COOLDOWN','LEASED')
          AND next_eligible_at <= to_timestamp($4/1000.0)
          AND (lease_expires_at IS NULL OR lease_expires_at <= to_timestamp($4/1000.0))
        RETURNING *`,
      [ws, storyProjectId, owner, nowMs, leaseMs, attempt, sourceRevision, idempotencyKey]);
    return r.rowCount === 1 ? mapSchedule(r.rows[0]) : null;
  },

  // Lease renewal: only the holder may extend, so a scheduler that lost the row (its lease was stolen after
  // expiry) finds out here rather than continuing to act on work it no longer owns.
  async renewRepairLease(client, ws, { storyProjectId, owner, leaseMs, nowMs = Date.now() }) {
    requireClient(client);
    const r = await client.query(
      `UPDATE story_repair_schedule
          SET lease_expires_at = to_timestamp($4/1000.0) + ($5 || ' milliseconds')::interval,
              heartbeat_at = to_timestamp($4/1000.0), updated_at = now()
        WHERE workspace_id=$1 AND story_project_id=$2 AND lease_owner=$3 AND state='LEASED'
        RETURNING *`, [ws, storyProjectId, owner, nowMs, leaseMs]);
    return r.rowCount === 1 ? mapSchedule(r.rows[0]) : null;
  },

  // Release with a verdict. `state` decides what happens next; the lease is always dropped.
  async releaseRepairSchedule(client, ws, { storyProjectId, owner = null, state, nextEligibleAt = null, lastError = null, lastAction = null, bumpDeferrals = false }) {
    requireClient(client);
    const params = [ws, storyProjectId, state, nextEligibleAt, lastError, lastAction];
    let where = "workspace_id=$1 AND story_project_id=$2";
    if (owner) { params.push(owner); where += ` AND lease_owner=$${params.length}`; }
    const r = await client.query(
      `UPDATE story_repair_schedule
          SET state=$3, lease_owner=NULL, lease_expires_at=NULL,
              next_eligible_at = COALESCE($4, next_eligible_at),
              last_error=$5, last_action=$6,
              deferrals = deferrals + ${bumpDeferrals ? 1 : 0},
              updated_at = now()
        WHERE ${where} RETURNING *`, params);
    return r.rowCount === 1 ? mapSchedule(r.rows[0]) : null;
  },

  async getRepairSchedule(client, ws, storyProjectId) {
    requireClient(client);
    const r = await client.query("SELECT * FROM story_repair_schedule WHERE workspace_id=$1 AND story_project_id=$2", [ws, storyProjectId]);
    return r.rowCount === 1 ? mapSchedule(r.rows[0]) : null;
  },

  async listRepairSchedule(client, ws, { limit = 200 } = {}) {
    requireClient(client);
    const r = await client.query("SELECT * FROM story_repair_schedule WHERE workspace_id=$1 ORDER BY enqueued_at ASC LIMIT $2", [ws, limit]);
    return r.rows.map(mapSchedule);
  },

  // ---------------- versioned outputs ----------------
  async insertDnaVersion(client, ws, { storyProjectId, archetypeId = null, dna, checksum, logicReport = null }) {
    requireClient(client);
    const id = newId("sdv"); const version = await nextVersion(client, "story_dna_versions", ws, storyProjectId);
    const row = one(await client.query(`INSERT INTO story_dna_versions (workspace_id,id,story_project_id,version,archetype_id,dna,checksum,logic_report) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [ws, id, storyProjectId, version, archetypeId, J(dna), checksum, J(logicReport)]));
    return Object.freeze({ id, version, storyProjectId, checksum, dna: safeJson(row.dna), logicReport: safeJson(row.logic_report), createdAt: row.created_at });
  },
  async getDnaVersion(client, ws, id) { requireClient(client); const r = one(await client.query("SELECT * FROM story_dna_versions WHERE workspace_id=$1 AND id=$2", [ws, id])); return r ? Object.freeze({ id: r.id, storyProjectId: r.story_project_id, version: r.version, archetypeId: r.archetype_id, dna: safeJson(r.dna), checksum: r.checksum, logicReport: safeJson(r.logic_report), createdAt: r.created_at }) : null; },

  async insertOutlineVersion(client, ws, { storyProjectId, dnaId = null, outline }) {
    requireClient(client);
    const id = newId("sov"); const version = await nextVersion(client, "story_outline_versions", ws, storyProjectId);
    const row = one(await client.query(`INSERT INTO story_outline_versions (workspace_id,id,story_project_id,version,dna_id,outline) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ws, id, storyProjectId, version, dnaId, J(outline)]));
    return Object.freeze({ id, version, storyProjectId, outline: safeJson(row.outline), createdAt: row.created_at });
  },
  async getOutlineVersion(client, ws, id) { requireClient(client); const r = one(await client.query("SELECT * FROM story_outline_versions WHERE workspace_id=$1 AND id=$2", [ws, id])); return r ? Object.freeze({ id: r.id, storyProjectId: r.story_project_id, version: r.version, outline: safeJson(r.outline), createdAt: r.created_at }) : null; },

  async insertTextVersion(client, ws, { storyProjectId, dnaId = null, outlineId = null, storyText, wordCount = 0, edited = false, continuityReport = null }) {
    requireClient(client);
    if (isUnsafe(storyText)) throw bad("story text must not contain a URL/path");
    const id = newId("stv"); const version = await nextVersion(client, "story_text_versions", ws, storyProjectId);
    const row = one(await client.query(`INSERT INTO story_text_versions (workspace_id,id,story_project_id,version,dna_id,outline_id,story_text,word_count,edited,continuity_report) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [ws, id, storyProjectId, version, dnaId, outlineId, storyText, wordCount, edited, J(continuityReport)]));
    return Object.freeze({ id, version, storyProjectId, storyText: row.story_text, wordCount: Number(row.word_count), edited: row.edited, continuityReport: safeJson(row.continuity_report), createdAt: row.created_at });
  },
  async getTextVersion(client, ws, id) { requireClient(client); const r = one(await client.query("SELECT * FROM story_text_versions WHERE workspace_id=$1 AND id=$2", [ws, id])); return r ? Object.freeze({ id: r.id, storyProjectId: r.story_project_id, version: r.version, storyText: r.story_text, wordCount: Number(r.word_count), edited: r.edited, continuityReport: safeJson(r.continuity_report), createdAt: r.created_at }) : null; },
  async listTextVersions(client, ws, projectId) { requireClient(client); return (await client.query("SELECT id,version,word_count,edited,created_at FROM story_text_versions WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY version DESC", [ws, projectId])).rows.map((r) => Object.freeze({ id: r.id, version: r.version, wordCount: Number(r.word_count), edited: r.edited, createdAt: r.created_at })); },

  async insertTitleCandidates(client, ws, { storyProjectId, textVersionId = null, candidates = [] }) {
    requireClient(client);
    const out = [];
    for (const c of candidates) {
      const id = newId("stc");
      const row = one(await client.query(`INSERT INTO story_title_candidates (workspace_id,id,story_project_id,text_version_id,title,valid,score,reasons,chosen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [ws, id, storyProjectId, textVersionId, c.title, Boolean(c.valid), Number(c.score) || 0, J(c.reasons || []), Boolean(c.chosen)]));
      out.push(Object.freeze({ id: row.id, title: row.title, valid: row.valid, score: Number(row.score), reasons: safeJson(row.reasons) || [], chosen: row.chosen }));
    }
    return out;
  },
  async listTitleCandidates(client, ws, projectId) { requireClient(client); return (await client.query("SELECT * FROM story_title_candidates WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY chosen DESC, score DESC, created_at", [ws, projectId])).rows.map((r) => Object.freeze({ id: r.id, title: r.title, valid: r.valid, score: Number(r.score), reasons: safeJson(r.reasons) || [], chosen: r.chosen })); },
  async chooseTitle(client, ws, projectId, candidateId) {
    requireClient(client);
    await client.query("UPDATE story_title_candidates SET chosen=FALSE WHERE workspace_id=$1 AND story_project_id=$2", [ws, projectId]);
    const r = await client.query("UPDATE story_title_candidates SET chosen=TRUE WHERE workspace_id=$1 AND id=$2 RETURNING title", [ws, candidateId]);
    return r.rowCount === 1 ? r.rows[0].title : null;
  },

  async insertPackage(client, ws, { storyProjectId, fields = {}, packageJson = null }) {
    requireClient(client);
    const id = newId("scp"); const version = await nextVersion(client, "story_content_packages", ws, storyProjectId);
    const row = one(await client.query(`INSERT INTO story_content_packages (workspace_id,id,story_project_id,version,title,hook,excerpt,seo_description,hero_image_prompt,social_teaser,cliffhanger,cta,package) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [ws, id, storyProjectId, version, fields.title ?? null, fields.hook ?? null, fields.excerpt ?? null, fields.seoDescription ?? null, fields.heroImagePrompt ?? null, fields.socialTeaser ?? null, fields.cliffhanger ?? null, fields.cta ?? null, J(packageJson)]));
    return Object.freeze({ id: row.id, version: row.version, createdAt: row.created_at });
  },
  async getPackage(client, ws, id) { requireClient(client); const r = one(await client.query("SELECT * FROM story_content_packages WHERE workspace_id=$1 AND id=$2", [ws, id])); return r ? Object.freeze({ id: r.id, storyProjectId: r.story_project_id, version: r.version, title: r.title, hook: r.hook, excerpt: r.excerpt, seoDescription: r.seo_description, heroImagePrompt: r.hero_image_prompt, socialTeaser: r.social_teaser, cliffhanger: r.cliffhanger, cta: r.cta, package: safeJson(r.package), createdAt: r.created_at }) : null; },

  async insertQualityReport(client, ws, { storyProjectId, dimensions, overallScore, ready, failures = [] }) {
    requireClient(client);
    const id = newId("sqr"); const version = await nextVersion(client, "story_quality_reports", ws, storyProjectId);
    const row = one(await client.query(`INSERT INTO story_quality_reports (workspace_id,id,story_project_id,version,dimensions,overall_score,ready,failures) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [ws, id, storyProjectId, version, J(dimensions), overallScore, Boolean(ready), J(failures)]));
    return Object.freeze({ id: row.id, version: row.version, ready: row.ready, overallScore: Number(row.overall_score), createdAt: row.created_at });
  },
  async getQualityReport(client, ws, id) { requireClient(client); const r = one(await client.query("SELECT * FROM story_quality_reports WHERE workspace_id=$1 AND id=$2", [ws, id])); return r ? Object.freeze({ id: r.id, storyProjectId: r.story_project_id, version: r.version, dimensions: safeJson(r.dimensions), overallScore: Number(r.overall_score), ready: r.ready, failures: safeJson(r.failures) || [], createdAt: r.created_at }) : null; },

  async insertFingerprint(client, ws, { storyProjectId, locale = "", title = null, fingerprint, nearest = [], maxOverall = 0, pass = false, accepted = false }) {
    requireClient(client);
    const id = newId("snf");
    const row = one(await client.query(`INSERT INTO story_novelty_fingerprints (workspace_id,id,story_project_id,locale,title,fingerprint,nearest,max_overall,pass,accepted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [ws, id, storyProjectId, locale, title, J(fingerprint), J(nearest), maxOverall, Boolean(pass), Boolean(accepted)]));
    return Object.freeze({ id: row.id, storyProjectId, pass: row.pass, accepted: row.accepted, maxOverall: Number(row.max_overall), nearest: safeJson(row.nearest) || [], createdAt: row.created_at });
  },
  async getFingerprint(client, ws, id) { requireClient(client); const r = one(await client.query("SELECT * FROM story_novelty_fingerprints WHERE workspace_id=$1 AND id=$2", [ws, id])); return r ? Object.freeze({ id: r.id, storyProjectId: r.story_project_id, locale: r.locale, title: r.title, fingerprint: safeJson(r.fingerprint), nearest: safeJson(r.nearest) || [], maxOverall: Number(r.max_overall), pass: r.pass, accepted: r.accepted, createdAt: r.created_at }) : null; },
  async listAcceptedFingerprints(client, ws, { excludeProjectId = null, limit = 500 } = {}) {
    requireClient(client);
    const rows = (await client.query("SELECT DISTINCT ON (story_project_id) story_project_id, locale, title, fingerprint FROM story_novelty_fingerprints WHERE workspace_id=$1 AND accepted=TRUE ORDER BY story_project_id, created_at DESC LIMIT $2", [ws, limit])).rows;
    return rows.filter((r) => r.story_project_id !== excludeProjectId).map((r) => Object.freeze({ storyProjectId: r.story_project_id, locale: r.locale, title: r.title, fingerprint: safeJson(r.fingerprint) }));
  },
  async markFingerprintAccepted(client, ws, id) { requireClient(client); await client.query("UPDATE story_novelty_fingerprints SET accepted=TRUE WHERE workspace_id=$1 AND id=$2", [ws, id]); },

  // ---------------- staged generation attempts (exactly-once) ----------------
  async insertGenerationAttempt(client, ws, { storyProjectId, stage, provider = "GROK_CHAT", promptHash }) {
    requireClient(client);
    if (typeof promptHash !== "string" || promptHash.length < 8) throw bad("promptHash required");
    const id = newId("sgn");
    const row = one(await client.query(`INSERT INTO story_generation_attempts (workspace_id,id,story_project_id,stage,provider,prompt_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ws, id, storyProjectId, stage, provider, promptHash]));
    return Object.freeze({ id: row.id, storyProjectId, stage, provider, state: row.state, submitState: row.submit_state });
  },
  async getGenerationAttempt(client, ws, id) { requireClient(client); const r = one(await client.query("SELECT * FROM story_generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, id])); return r ? Object.freeze({ id: r.id, storyProjectId: r.story_project_id, stage: r.stage, provider: r.provider, invocationState: r.invocation_state, submitState: r.submit_state, result: safeJson(r.result), providerResultRef: r.provider_result_ref, state: r.state, errorCode: r.error_code, revision: Number(r.revision) }) : null; },
  async listGenerationAttempts(client, ws, projectId, { limit = 100 } = {}) { requireClient(client); return (await client.query("SELECT id,stage,provider,state,submit_state,invocation_state,error_code,created_at FROM story_generation_attempts WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY created_at DESC LIMIT $3", [ws, projectId, limit])).rows.map((r) => Object.freeze({ id: r.id, stage: r.stage, provider: r.provider, state: r.state, submitState: r.submit_state, invocationState: r.invocation_state, errorCode: r.error_code, createdAt: r.created_at })); },
  async reserveInvocation(client, ws, id) { requireClient(client); return claimInvocation(client, ws, id, { from: null, to: "RESERVED" }); },
  async consumeInvocation(client, ws, id) { requireClient(client); return claimInvocation(client, ws, id, { from: "RESERVED", to: "CONSUMED" }); },
  async updateGenerationAttempt(client, ws, id, { patch = {} } = {}) {
    requireClient(client);
    const sets = ["revision=revision+1", "updated_at=now()"]; const params = [ws, id];
    const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.submitState !== undefined) add("submit_state", patch.submitState);
    if (patch.responseHash !== undefined) add("response_hash", patch.responseHash);
    if (patch.providerResultRef !== undefined) { if (patch.providerResultRef !== null && isUnsafe(patch.providerResultRef)) throw bad("providerResultRef must be a redacted id"); add("provider_result_ref", patch.providerResultRef); }
    if (patch.result !== undefined) add("result", J(patch.result));
    if (patch.errorCode !== undefined) add("error_code", patch.errorCode);
    const r = await client.query(`UPDATE story_generation_attempts SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('COMPLETED','FAILED','UNCERTAIN') RETURNING id`, params);
    return { changed: r.rowCount === 1 };
  },

  // ---------------- events + movie links ----------------
  async appendEvent(client, ws, storyProjectId, { type, detail = null }) {
    requireClient(client);
    const id = newId("sev");
    await client.query(`INSERT INTO story_events (workspace_id,id,story_project_id,type,detail) VALUES ($1,$2,$3,$4,$5)`, [ws, id, storyProjectId, String(type).slice(0, 80), J(detail)]);
    return id;
  },
  async listEvents(client, ws, projectId, { limit = 100 } = {}) { requireClient(client); return (await client.query("SELECT type,detail,created_at FROM story_events WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY created_at DESC LIMIT $3", [ws, projectId, limit])).rows.map((r) => Object.freeze({ type: r.type, detail: safeJson(r.detail), createdAt: r.created_at })); },

  async insertMovieLink(client, ws, { storyProjectId, movieProjectId, sceneCount = null, storyboardOnly = true }) {
    requireClient(client);
    const id = newId("sml");
    const row = one(await client.query(`INSERT INTO story_movie_links (workspace_id,id,story_project_id,movie_project_id,scene_count,storyboard_only) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,story_project_id,movie_project_id) DO UPDATE SET scene_count=EXCLUDED.scene_count RETURNING *`, [ws, id, storyProjectId, movieProjectId, sceneCount, storyboardOnly]));
    return Object.freeze({ id: row.id, storyProjectId, movieProjectId, sceneCount: row.scene_count, storyboardOnly: row.storyboard_only, createdAt: row.created_at });
  },
  async listMovieLinks(client, ws, projectId) { requireClient(client); return (await client.query("SELECT * FROM story_movie_links WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY created_at DESC", [ws, projectId])).rows.map((r) => Object.freeze({ id: r.id, movieProjectId: r.movie_project_id, sceneCount: r.scene_count, storyboardOnly: r.storyboard_only, createdAt: r.created_at })); }
};
