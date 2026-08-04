// P0 Step 5C.2 — domain repositories. EXPLICIT per-domain repositories (not one generic
// wrapper). Every method receives a transaction CLIENT (never opens its own transaction),
// uses parameterized SQL, is workspace-scoped, and returns normalized records. Constraint
// errors propagate to the transaction boundary where mapPgError() turns them into stable
// DomainErrors. No absolute paths / provider URLs / secrets are ever accepted or returned.

import { newId } from "../ids.mjs";
import { validateId } from "../../../../lib/protocol/ids.mjs";
import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";

function requireClient(client) {
  if (!client || typeof client.query !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "repository requires a transaction client");
}
function assertRelative(ref, field) {
  if (typeof ref !== "string" || /^[A-Za-z]:[\\/]/.test(ref) || /^[\\/]/.test(ref) || /\.\./.test(ref) || /:\/\//.test(ref)) {
    throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, `${field} must be a safe relative reference`);
  }
}
const one = (r) => (r.rows[0] ?? null);

// ---------------------------------------------------------------- workspace / project

export const workspaceRepository = {
  async getScoped(client, workspaceId) {
    requireClient(client);
    return one(await client.query("SELECT id, name, plan, owner_user_id, created_at, deleted_at FROM workspaces WHERE id = $1", [workspaceId]));
  }
};

export const projectRepository = {
  async create(client, workspaceId, { title, storageRelativeRoot, createdByUserId, locale = null, market = null }) {
    requireClient(client);
    assertRelative(storageRelativeRoot, "storageRelativeRoot");
    const id = newId("prj");
    return one(await client.query(
      `INSERT INTO projects (id, workspace_id, created_by_user_id, title, locale, market, storage_relative_root)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, workspaceId, createdByUserId, title, locale, market, storageRelativeRoot]));
  },
  async get(client, workspaceId, projectId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM projects WHERE workspace_id = $1 AND id = $2", [workspaceId, projectId]));
  },
  async list(client, workspaceId) {
    requireClient(client);
    return (await client.query("SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC", [workspaceId])).rows;
  },
  // optimistic-concurrency update: bumps revision by exactly 1; 0 rows → conflict.
  async updateWithRevision(client, workspaceId, projectId, expectedRevision, patch) {
    requireClient(client);
    const r = await client.query(
      `UPDATE projects SET title = COALESCE($4, title), status = COALESCE($5, status), revision = revision + 1
       WHERE workspace_id = $1 AND id = $2 AND revision = $3 RETURNING *`,
      [workspaceId, projectId, expectedRevision, patch.title ?? null, patch.status ?? null]);
    if (r.rowCount === 0) throw domainError(DOMAIN_ERRORS.E_REVISION_CONFLICT, "Concurrent modification");
    return one(r);
  }
};

// ---------------------------------------------------------------- worker

export const workerRepository = {
  async get(client, workspaceId, workerId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM workers WHERE workspace_id = $1 AND id = $2", [workspaceId, workerId]));
  },
  async list(client, workspaceId) {
    requireClient(client);
    return (await client.query("SELECT * FROM workers WHERE workspace_id = $1 ORDER BY created_at DESC", [workspaceId])).rows;
  },
  async belongsToWorkspace(client, workspaceId, workerId) {
    requireClient(client);
    const r = await client.query("SELECT 1 FROM workers WHERE workspace_id = $1 AND id = $2", [workspaceId, workerId]);
    return r.rowCount === 1;
  },
  async activeSession(client, workspaceId, workerId) {
    requireClient(client);
    return one(await client.query(
      "SELECT * FROM worker_connection_sessions WHERE workspace_id = $1 AND worker_id = $2 AND status = 'ACTIVE'", [workspaceId, workerId]));
  }
};

// ---------------------------------------------------------------- generation

export const generationRequestRepository = {
  async findByIdemKey(client, workspaceId, requestIdempotencyKey) {
    requireClient(client);
    return one(await client.query(
      "SELECT * FROM generation_requests WHERE workspace_id = $1 AND request_idempotency_key = $2", [workspaceId, requestIdempotencyKey]));
  },
  async create(client, workspaceId, { requestId, projectId, shotId = null, createdByUserId = null, action, requestIdempotencyKey, inputSnapshot, quotaRisk = false }) {
    requireClient(client);
    return one(await client.query(
      `INSERT INTO generation_requests (id, workspace_id, project_id, shot_id, created_by_user_id, action, request_idempotency_key, input_snapshot, quota_risk)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [requestId, workspaceId, projectId, shotId, createdByUserId, action, requestIdempotencyKey, JSON.stringify(inputSnapshot ?? {}), quotaRisk]));
  }
};

export const generationAttemptRepository = {
  async create(client, workspaceId, { attemptId, generationRequestId, requestIdempotencyKey, parentAttemptId = null, retryOfJobId = null, attemptIndex = 0, providerId = null, providerAccountRef = null }) {
    requireClient(client);
    return one(await client.query(
      `INSERT INTO generation_attempts (id, workspace_id, generation_request_id, request_idempotency_key, parent_attempt_id, retry_of_job_id, attempt_index, provider_id, provider_account_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [attemptId, workspaceId, generationRequestId, requestIdempotencyKey, parentAttemptId, retryOfJobId, attemptIndex, providerId, providerAccountRef]));
  },
  // Lock the attempt row FOR UPDATE (the paid-ownership serialization point).
  async lock(client, workspaceId, attemptId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM generation_attempts WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [workspaceId, attemptId]));
  },
  async get(client, workspaceId, attemptId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM generation_attempts WHERE workspace_id = $1 AND id = $2", [workspaceId, attemptId]));
  },
  async setOwnership(client, workspaceId, attemptId, { ownershipStatus, assignedWorkerId }) {
    requireClient(client);
    return one(await client.query(
      "UPDATE generation_attempts SET ownership_status = $3, assigned_worker_id = $4 WHERE workspace_id = $1 AND id = $2 RETURNING *",
      [workspaceId, attemptId, ownershipStatus, assignedWorkerId]));
  }
};

export const jobRepository = {
  async create(client, workspaceId, { jobId, workerId = null, projectId = null, episodeId = null, shotId = null, generationAttemptId, createdByUserId = null, type, requestIdempotencyKey, input, quotaRisk = false, offerExpiresAt = null, executionDeadlineAt = null }) {
    requireClient(client);
    return one(await client.query(
      `INSERT INTO jobs (id, workspace_id, worker_id, project_id, episode_id, shot_id, generation_attempt_id, created_by_user_id, type, request_idempotency_key, input, quota_risk, offer_expires_at, execution_deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [jobId, workspaceId, workerId, projectId, episodeId, shotId, generationAttemptId, createdByUserId, type, requestIdempotencyKey, JSON.stringify(input ?? {}), quotaRisk, offerExpiresAt, executionDeadlineAt]));
  },
  async get(client, workspaceId, jobId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM jobs WHERE workspace_id = $1 AND id = $2", [workspaceId, jobId]));
  },
  async lock(client, workspaceId, jobId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [workspaceId, jobId]));
  },
  async getByAttempt(client, workspaceId, attemptId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM jobs WHERE workspace_id = $1 AND generation_attempt_id = $2", [workspaceId, attemptId]));
  },
  async setStatus(client, workspaceId, jobId, status, patch = {}) {
    requireClient(client);
    return one(await client.query(
      `UPDATE jobs SET status = $3, accepted_at = COALESCE($4, accepted_at), started_at = COALESCE($5, started_at),
         finished_at = COALESCE($6, finished_at), canceled_at = COALESCE($7, canceled_at), worker_id = COALESCE($8, worker_id)
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [workspaceId, jobId, status, patch.acceptedAt ?? null, patch.startedAt ?? null, patch.finishedAt ?? null, patch.canceledAt ?? null, patch.workerId ?? null]));
  }
};

export const jobOfferRepository = {
  async create(client, workspaceId, { offerId, jobId, generationAttemptId, assignedWorkerId, projectId = null, offerMessageId, ownershipStatus, offerExpiresAt, leaseExpiresAt, executionDeadlineAt = null }) {
    requireClient(client);
    return one(await client.query(
      `INSERT INTO job_offers (id, workspace_id, job_id, generation_attempt_id, assigned_worker_id, project_id, offer_message_id, ownership_status, offer_expires_at, lease_expires_at, execution_deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [offerId, workspaceId, jobId, generationAttemptId, assignedWorkerId, projectId, offerMessageId, ownershipStatus, offerExpiresAt, leaseExpiresAt, executionDeadlineAt]));
  },
  async liveForAttempt(client, workspaceId, attemptId) {
    requireClient(client);
    return one(await client.query(
      `SELECT * FROM job_offers WHERE workspace_id = $1 AND generation_attempt_id = $2
        AND ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED') FOR UPDATE`, [workspaceId, attemptId]));
  },
  async setStatus(client, workspaceId, offerId, ownershipStatus, patch = {}) {
    requireClient(client);
    return one(await client.query(
      `UPDATE job_offers SET ownership_status = $3, accepted_at = COALESCE($4, accepted_at),
         reconcile_required = COALESCE($5, reconcile_required), possibly_submitted = COALESCE($6, possibly_submitted),
         terminal_at = COALESCE($7, terminal_at), last_worker_event_at = now()
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [workspaceId, offerId, ownershipStatus, patch.acceptedAt ?? null, patch.reconcileRequired ?? null, patch.possiblySubmitted ?? null, patch.terminalAt ?? null]));
  }
};

export const terminalResultRepository = {
  async get(client, workspaceId, jobId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM job_terminal_results WHERE workspace_id = $1 AND job_id = $2", [workspaceId, jobId]));
  },
  async create(client, workspaceId, { jobId, terminalType, terminalMessageId, result = null, errorCode = null }) {
    requireClient(client);
    return one(await client.query(
      `INSERT INTO job_terminal_results (job_id, workspace_id, terminal_type, terminal_message_id, result, error_code)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [jobId, workspaceId, terminalType, terminalMessageId, result ? JSON.stringify(result) : null, errorCode]));
  }
};

// ---------------------------------------------------------------- assets

export const assetRepository = {
  async upsertSafe(client, workspaceId, a) {
    requireClient(client);
    assertRelative(a.relativePath, "relativePath");
    if (a.provider && /:\/\//.test(String(a.providerAccountRef ?? ""))) throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "provider url not allowed");
    const id = a.assetId || newId("asset");
    return one(await client.query(
      `INSERT INTO assets (id, workspace_id, project_id, episode_id, shot_id, producing_worker_id, generation_attempt_id, provider, provider_account_ref, relative_path, file_name, mime_type, size_bytes, checksum, actual_duration_sec, width, height, storage_tier, liveness, prompt_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18,'LOCAL_ONLY'),COALESCE($19,'ONLINE'),$20)
       ON CONFLICT (workspace_id, project_id, relative_path) WHERE deleted_at IS NULL
       DO UPDATE SET checksum = EXCLUDED.checksum, size_bytes = EXCLUDED.size_bytes, storage_tier = EXCLUDED.storage_tier, liveness = EXCLUDED.liveness, revision = assets.revision + 1
       RETURNING *`,
      [id, workspaceId, a.projectId, a.episodeId ?? null, a.shotId ?? null, a.producingWorkerId ?? null, a.generationAttemptId ?? null, a.provider ?? null, a.providerAccountRef ?? null, a.relativePath, a.fileName, a.mimeType, a.sizeBytes ?? null, a.checksum, a.actualDurationSec ?? null, a.width ?? null, a.height ?? null, a.storageTier ?? null, a.liveness ?? null, a.promptSnapshot ?? null]));
  },
  async get(client, workspaceId, assetId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM assets WHERE workspace_id = $1 AND id = $2", [workspaceId, assetId]));
  },
  async listForShot(client, workspaceId, shotId) {
    requireClient(client);
    return (await client.query("SELECT * FROM assets WHERE workspace_id = $1 AND shot_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC", [workspaceId, shotId])).rows;
  },
  async setReview(client, workspaceId, assetId, expectedRevision, { reviewStatus = null, selected = null, approved = null }) {
    requireClient(client);
    const r = await client.query(
      `UPDATE assets SET review_status = COALESCE($4, review_status), selected = COALESCE($5, selected), approved = COALESCE($6, approved), revision = revision + 1
       WHERE workspace_id = $1 AND id = $2 AND revision = $3 RETURNING *`,
      [workspaceId, assetId, expectedRevision, reviewStatus, selected, approved]);
    if (r.rowCount === 0) throw domainError(DOMAIN_ERRORS.E_REVISION_CONFLICT, "Concurrent modification");
    return one(r);
  }
};

// ---------------------------------------------------------------- protocol (outbox row only)

export const protocolRepository = {
  // Create a JOB_OFFER outbox row inside the SAME transaction as the ownership claim. Never
  // marked SENT here (no socket send in 5C.2). settlement_mode LIFECYCLE_RESPONSE for JOB_OFFER.
  async createOutbox(client, workspaceId, { messageId, workerId, jobId = null, generationAttemptId = null, type, settlementMode, expectedResponseTypes = null, orderingKey = null, payload }) {
    requireClient(client);
    const id = newId("ob");
    return one(await client.query(
      `INSERT INTO protocol_outbox (id, workspace_id, worker_id, job_id, generation_attempt_id, message_id, type, settlement_mode, expected_response_types, ordering_key, payload, delivery_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING') RETURNING id, message_id, delivery_state`,
      [id, workspaceId, workerId, jobId, generationAttemptId, messageId, type, settlementMode, expectedResponseTypes ? JSON.stringify(expectedResponseTypes) : null, orderingKey, JSON.stringify(payload ?? {})]));
  },
  async findInboxDup(client, workspaceId, workerId, messageId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM protocol_inbox WHERE worker_id = $1 AND message_id = $2 AND workspace_id = $3", [workerId, messageId, workspaceId]));
  }
};

// ---------------------------------------------------------------- audit + flags + approvals

export const auditRepository = {
  async record(client, { workspaceId = null, actorType, actorId = null, action, targetType = null, targetId = null, metadata = null }) {
    requireClient(client);
    const id = newId("audit");
    await client.query(
      "INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, workspaceId, actorType, actorId, action, targetType, targetId, metadata ? JSON.stringify(metadata) : null]);
    return id;
  }
};

export const featureFlagRepository = {
  async readConfig(client, name) {
    requireClient(client);
    const flag = one(await client.query("SELECT * FROM feature_flags WHERE name = $1", [name]));
    if (!flag) return null;
    const targets = (await client.query("SELECT list_kind, scope, target_id FROM feature_flag_targets WHERE flag_id = $1", [flag.id])).rows;
    return { flag, targets };
  },
  // Consume ONE one-shot paid approval grant transactionally. Returns the grant id or null.
  async consumeApprovalGrant(client, workspaceId, { attemptId, projectId = null }) {
    requireClient(client);
    // Lock an available grant for this workspace, then consume exactly one unit.
    const grant = one(await client.query(
      `SELECT * FROM paid_generation_approval_grants
        WHERE workspace_id = $1 AND consumed_count < max_paid_generations
          AND (expires_at IS NULL OR expires_at > now())
          AND (project_id IS NULL OR project_id = $2)
          AND (generation_attempt_id IS NULL OR generation_attempt_id = $3)
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
      [workspaceId, projectId, attemptId]));
    if (!grant) return null;
    await client.query(
      `UPDATE paid_generation_approval_grants
         SET consumed_count = consumed_count + 1, consumed_by_attempt_id = $2, consumed_at = now()
       WHERE id = $1`, [grant.id, attemptId]);
    return grant.id;
  }
};

export { validateId };
