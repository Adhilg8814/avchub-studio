// P0 Step 5C.6 — staging API repository (client-taking, workspace-scoped, parameterized SQL only).
//
// Reads/writes the project + read-model rows the staging API needs. It NEVER duplicates the paid-
// generation ownership logic (createGenerationRequest / claimGenerationAttemptForWorker /
// applyCancel / assignProjectAffinity live in transactions/*). Every query carries the workspace
// predicate; there are no dynamic identifiers. Dynamic values are always bound parameters.

import { newId } from "../persistence/ids.mjs";
import { domainError, DOMAIN_ERRORS } from "../persistence/domain-errors.mjs";

function requireClient(client) {
  if (!client || typeof client.query !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "staging repository requires a transaction client");
}
const one = (r) => (r.rows[0] ?? null);

export const projectStore = {
  async workspaceOwner(client, ws) {
    requireClient(client);
    const r = await client.query("SELECT owner_user_id FROM workspaces WHERE id = $1", [ws]);
    return r.rows[0] ? r.rows[0].owner_user_id : null;
  },

  async create(client, ws, { title, description = null, settings = null, storageRelativeRoot, createdByUserId, locale = null, market = null }) {
    requireClient(client);
    const id = newId("prj");
    return one(await client.query(
      `INSERT INTO projects (id, workspace_id, created_by_user_id, title, description, default_settings, locale, market, status, storage_relative_root, revision, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,0, now(), now()) RETURNING *`,
      [id, ws, createdByUserId, title, description, settings ? JSON.stringify(settings) : null, locale, market, storageRelativeRoot]));
  },

  async get(client, ws, id) {
    requireClient(client);
    return one(await client.query("SELECT * FROM projects WHERE workspace_id = $1 AND id = $2", [ws, id]));
  },

  async list(client, ws, { limit, offset, includeArchived = false }) {
    requireClient(client);
    const rows = includeArchived
      ? (await client.query("SELECT * FROM projects WHERE workspace_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3", [ws, limit, offset])).rows
      : (await client.query("SELECT * FROM projects WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3", [ws, limit, offset])).rows;
    const total = one(await client.query(
      includeArchived ? "SELECT count(*)::int AS n FROM projects WHERE workspace_id=$1" : "SELECT count(*)::int AS n FROM projects WHERE workspace_id=$1 AND archived_at IS NULL", [ws]));
    return { rows, total: total.n };
  },

  // Optimistic-concurrency update: succeeds only when revision matches. Returns the updated row, or
  // null when the guard did not match (caller distinguishes not-found vs revision-conflict).
  async update(client, ws, id, expectedRevision, { title, description, settings }) {
    requireClient(client);
    return one(await client.query(
      `UPDATE projects
         SET title = COALESCE($4, title),
             description = CASE WHEN $5::boolean THEN $6 ELSE description END,
             default_settings = CASE WHEN $7::boolean THEN $8 ELSE default_settings END,
             revision = revision + 1, updated_at = now()
       WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND archived_at IS NULL RETURNING *`,
      [ws, id, expectedRevision, title ?? null,
       description !== undefined, description ?? null,
       settings !== undefined, settings !== undefined && settings !== null ? JSON.stringify(settings) : null]));
  },

  async archive(client, ws, id, expectedRevision) {
    requireClient(client);
    return one(await client.query(
      `UPDATE projects SET status='ARCHIVED', archived_at=now(), revision=revision+1, updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND archived_at IS NULL RETURNING *`,
      [ws, id, expectedRevision]));
  },

  async counts(client, ws, projectId) {
    requireClient(client);
    const r = one(await client.query(
      `SELECT count(*)::int AS jobs,
              count(*) FILTER (WHERE status='SUCCEEDED')::int AS completed,
              count(*) FILTER (WHERE status IN ('FAILED','EXPIRED','INTERRUPTED'))::int AS failed,
              count(*) FILTER (WHERE status NOT IN ('SUCCEEDED','FAILED','EXPIRED','INTERRUPTED','CANCELED'))::int AS active
         FROM jobs WHERE workspace_id=$1 AND project_id=$2`, [ws, projectId]));
    return { jobs: r.jobs, completed: r.completed, failed: r.failed, active: r.active };
  },

  // Revision history / per-revision config snapshot (existing project_revisions table).
  async writeRevision(client, ws, { projectId, revision, summary = null, diff = null, changedByUserId = null }) {
    requireClient(client);
    await client.query(
      `INSERT INTO project_revisions (id, workspace_id, project_id, revision, summary, diff, changed_by_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now()) ON CONFLICT DO NOTHING`,
      [newId("prev"), ws, projectId, revision, summary, diff ? JSON.stringify(diff) : null, changedByUserId]);
  }
};

export const affinityStore = {
  async active(client, ws, projectId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM project_worker_affinity WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'", [ws, projectId]));
  },
  // Release the ACTIVE affinity (generation guarded). History is preserved (row → RELEASED, never
  // deleted). Returns the released row or null if the guard did not match. (There is no released_by
  // column; the operator identity is captured in audit_events.)
  async release(client, ws, projectId, expectedGeneration, { reason = null } = {}) {
    requireClient(client);
    return one(await client.query(
      `UPDATE project_worker_affinity
         SET status='RELEASED', released_at=now(), release_reason=$3
       WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'
         AND ($4::int IS NULL OR generation = $4::int) RETURNING *`,
      [ws, projectId, reason, expectedGeneration]));
  }
};

export const workerStore = {
  async list(client, ws) {
    requireClient(client);
    return (await client.query(
      `SELECT w.*, s.reconcile_barrier_open
         FROM workers w
         LEFT JOIN worker_connection_sessions s ON s.workspace_id=w.workspace_id AND s.worker_id=w.id AND s.status='ACTIVE'
        WHERE w.workspace_id=$1 ORDER BY w.created_at DESC`, [ws])).rows;
  },
  async get(client, ws, workerId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM workers WHERE workspace_id=$1 AND id=$2", [ws, workerId]));
  },
  async capabilities(client, ws, workerId) {
    requireClient(client);
    return (await client.query("SELECT capability FROM worker_capabilities WHERE workspace_id=$1 AND worker_id=$2", [ws, workerId])).rows.map((r) => r.capability);
  },
  async isOnline(client, ws, workerId) {
    requireClient(client);
    const r = await client.query("SELECT 1 FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [ws, workerId]);
    return r.rowCount > 0;
  }
};

export const jobStore = {
  async list(client, ws, projectId, { limit, offset }) {
    requireClient(client);
    const rows = (await client.query(
      "SELECT * FROM jobs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4", [ws, projectId, limit, offset])).rows;
    const total = one(await client.query("SELECT count(*)::int AS n FROM jobs WHERE workspace_id=$1 AND project_id=$2", [ws, projectId]));
    return { rows, total: total.n };
  },
  async get(client, ws, jobId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM jobs WHERE workspace_id=$1 AND id=$2", [ws, jobId]));
  },
  async attempt(client, ws, attemptId) {
    requireClient(client);
    if (!attemptId) return null;
    return one(await client.query("SELECT * FROM generation_attempts WHERE workspace_id=$1 AND id=$2", [ws, attemptId]));
  },
  async request(client, ws, requestId) {
    requireClient(client);
    if (!requestId) return null;
    return one(await client.query("SELECT * FROM generation_requests WHERE workspace_id=$1 AND id=$2", [ws, requestId]));
  },
  async requestForAttempt(client, ws, attemptId) {
    requireClient(client);
    if (!attemptId) return null;
    return one(await client.query(
      "SELECT gr.* FROM generation_requests gr JOIN generation_attempts ga ON ga.generation_request_id=gr.id AND ga.workspace_id=gr.workspace_id WHERE ga.workspace_id=$1 AND ga.id=$2", [ws, attemptId]));
  },
  async terminal(client, ws, jobId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM job_terminal_results WHERE workspace_id=$1 AND job_id=$2", [ws, jobId]));
  },
  async assetCount(client, ws, attemptId) {
    requireClient(client);
    if (!attemptId) return 0;
    const r = one(await client.query("SELECT count(*)::int AS n FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2 AND deleted_at IS NULL", [ws, attemptId]));
    return r.n;
  }
};

export const assetStore = {
  async listForAttempt(client, ws, attemptId) {
    requireClient(client);
    if (!attemptId) return [];
    return (await client.query("SELECT * FROM assets WHERE workspace_id=$1 AND generation_attempt_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC", [ws, attemptId])).rows;
  },
  async get(client, ws, assetId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM assets WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL", [ws, assetId]));
  }
};
