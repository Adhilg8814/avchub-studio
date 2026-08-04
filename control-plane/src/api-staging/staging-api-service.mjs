// P0 Step 5C.6 — staging API service (orchestration).
//
// Composes the read-model repository + the EXISTING paid-generation ownership transactions into the
// staging Project/Generation/Job/Result flows. It NEVER re-implements ownership SQL: generation
// creation reuses createGenerationRequestCore (one request → one attempt → one job), dispatch reuses
// claimGenerationAttemptForWorkerCore (one owner, one offer, one JOB_OFFER outbox), cancel reuses
// applyCancelCore, affinity reuses assignProjectAffinity. The API layer adds only: workspace-scoped
// reads, projections, idempotency mapping, the minimal dispatch decision, and audit.
//
// Business rejections use the commit-then-signal REJECT pattern (never thrown inside a txn, which
// the adapter would remap to E_INTERNAL). Delivery is ALWAYS via the durable outbox — the API never
// sends to a socket.

import { createHash } from "node:crypto";
import { newId } from "../persistence/ids.mjs";
import { CP_ERRORS } from "../errors.mjs";
import { REJECT, settle, apiError, toApiError } from "./staging-api-errors.mjs";
import * as OWN from "../persistence/transactions/ownership.mjs";
import {
  projectStore, affinityStore, workerStore, jobStore, assetStore
} from "./staging-repository.mjs";
import { jobOfferRepository, protocolRepository, auditRepository, assetRepository } from "../persistence/repositories/repositories.mjs";
import { idempotencyRepository } from "../persistence/repositories/pairing-repository.mjs";
import {
  projectProject, projectWorker, projectJob, projectJobStatus, projectJobEvents,
  projectAsset, sanitizeSettings, workerDispatchable
} from "./projections.mjs";

const TERMINAL_JOB = new Set(["SUCCEEDED", "FAILED", "CANCELED", "EXPIRED", "INTERRUPTED"]);
// A job is retryable once it is resolved or being canceled/stuck — but NOT while actively in-flight
// (a premature retry of a queued/dispatched/running job is rejected E_JOB_NOT_RETRYABLE).
const NOT_RETRYABLE = new Set(["QUEUED", "DISPATCHED", "ACCEPTED", "RUNNING"]);
function sha256Hex(obj) { return createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }
// Fake video staging jobs require the grok.video capability (enforced only when the worker has
// declared capabilities — a freshly paired worker with none is treated as compatible in staging).
function capabilityForAction() { return "grok.video"; }

export function createStagingApiService({ config, persistence, logger, now = () => Date.now() } = {}) {
  const scfg = config.stagingApi;

  async function actorUser(client, ws) {
    const owner = await projectStore.workspaceOwner(client, ws);
    return owner; // staging operator acts as the workspace owner (created_by_user_id)
  }

  // ---------------------------------------------------------------- projections (assembled)
  async function buildJobView(client, ws, job) {
    const attempt = await jobStore.attempt(client, ws, job.generation_attempt_id);
    const request = await jobStore.requestForAttempt(client, ws, job.generation_attempt_id);
    let worker = null, workerAvailable = false;
    if (job.worker_id) {
      const wrow = await workerStore.get(client, ws, job.worker_id);
      if (wrow) { const caps = await workerStore.capabilities(client, ws, job.worker_id); worker = projectWorker(wrow, { capabilities: caps }); workerAvailable = workerDispatchable(wrow) && (await workerStore.isOnline(client, ws, job.worker_id)); }
    } else {
      const aff = await affinityStore.active(client, ws, job.project_id);
      if (aff) { const wrow = await workerStore.get(client, ws, aff.worker_id); if (wrow) workerAvailable = workerDispatchable(wrow) && (await workerStore.isOnline(client, ws, aff.worker_id)); }
    }
    const resultCount = await jobStore.assetCount(client, ws, job.generation_attempt_id);
    const view = projectJob({ job, attempt, worker, workerAvailable, resultCount });
    view.requestId = request ? request.id : null;
    view.dispatchStatus = dispatchStatusOf({ job, attempt, workerAvailable });
    return view;
  }
  function dispatchStatusOf({ job, attempt, workerAvailable }) {
    const s = projectJobStatus({ job, attempt, workerAvailable });
    if (s === "QUEUED" && !workerAvailable) return "WAITING_FOR_WORKER";
    if (s === "OFFERED") return "OFFERED";
    if (s === "WAITING_FOR_WORKER") return "WAITING_FOR_WORKER";
    return s;
  }

  // ================================================================ PROJECTS
  async function createProject({ ws, actorId, title, description = null, settings = null, idempotencyKey = null }) {
    const requestHash = sha256Hex({ v: 1, title: title ?? null, description: description ?? null, settings: settings ?? null });
    const out = settle(await persistence.tenantTransaction(ws, async (client) => {
      let replayId = null;
      if (idempotencyKey) {
        const claim = await idempotencyRepository.claim(client, ws, { scope: "project.create", key: idempotencyKey, requestHash });
        if (!claim.fresh) {
          if (!claim.row || claim.row.request_hash !== requestHash) return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT);
          if (claim.row.status === "COMPLETED" && claim.row.response) replayId = claim.row.response.projectId;
          else return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT);
        }
      }
      if (replayId) { const existing = await projectStore.get(client, ws, replayId); return { row: existing, replayed: true }; }
      const createdByUserId = await actorUser(client, ws);
      const row = await projectStore.create(client, ws, {
        title, description, settings: settings ? sanitizeSettings(settings) : null,
        storageRelativeRoot: `projects/${newId("prj").slice(4, 16)}`, createdByUserId
      });
      await projectStore.writeRevision(client, ws, { projectId: row.id, revision: 0, summary: "created", diff: { description, settings: settings ? sanitizeSettings(settings) : null }, changedByUserId: createdByUserId });
      if (idempotencyKey) await idempotencyRepository.complete(client, ws, { scope: "project.create", key: idempotencyKey, response: { projectId: row.id } });
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "project.created", targetType: "project", targetId: row.id, metadata: { hasDescription: Boolean(description) } });
      return { row, replayed: false };
    }));
    return { project: projectProject(out.row, { counts: { jobs: 0, completed: 0, failed: 0, active: 0 } }), replayed: out.replayed };
  }

  async function listProjects({ ws, limit, offset, includeArchived = false }) {
    return persistence.tenantTransaction(ws, async (client) => {
      const { rows, total } = await projectStore.list(client, ws, { limit, offset, includeArchived });
      const projects = [];
      for (const row of rows) {
        const counts = await projectStore.counts(client, ws, row.id);
        projects.push(projectProject(row, { worker: await activeWorkerView(client, ws, row.id), counts }));
      }
      return { projects, total };
    });
  }

  async function getProject({ ws, projectId }) {
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const row = await projectStore.get(client, ws, projectId);
      if (!row) return REJECT(CP_ERRORS.E_PROJECT_NOT_FOUND);
      const counts = await projectStore.counts(client, ws, projectId);
      return projectProject(row, { worker: await activeWorkerView(client, ws, projectId), counts });
    }));
  }

  async function activeWorkerView(client, ws, projectId) {
    const aff = await affinityStore.active(client, ws, projectId);
    if (!aff) return null;
    const wrow = await workerStore.get(client, ws, aff.worker_id);
    if (!wrow) return null;
    const caps = await workerStore.capabilities(client, ws, aff.worker_id);
    return projectWorker(wrow, { capabilities: caps });
  }

  async function updateProject({ ws, actorId, projectId, expectedRevision, title, description, settings }) {
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const cur = await projectStore.get(client, ws, projectId);
      if (!cur) return REJECT(CP_ERRORS.E_PROJECT_NOT_FOUND);
      if (cur.archived_at) return REJECT(CP_ERRORS.E_PROJECT_ARCHIVED);
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (description !== undefined) patch.description = description;
      if (settings !== undefined) patch.settings = settings ? sanitizeSettings(settings) : null;
      const row = await projectStore.update(client, ws, projectId, expectedRevision, patch);
      if (!row) return REJECT(CP_ERRORS.E_REVISION_CONFLICT);
      // changed_by_user_id references users(id); the staging operator is not a user row (its identity
      // is captured in audit_events.actor_id), so revision history records a null author.
      await projectStore.writeRevision(client, ws, { projectId, revision: row.revision, summary: "updated", diff: { description: row.description, settings: row.default_settings }, changedByUserId: null });
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "project.updated", targetType: "project", targetId: projectId, metadata: { revision: row.revision } });
      const counts = await projectStore.counts(client, ws, projectId);
      return projectProject(row, { worker: await activeWorkerView(client, ws, projectId), counts });
    }));
  }

  async function archiveProject({ ws, actorId, projectId, expectedRevision }) {
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const cur = await projectStore.get(client, ws, projectId);
      if (!cur) return REJECT(CP_ERRORS.E_PROJECT_NOT_FOUND);
      if (cur.archived_at) { const counts = await projectStore.counts(client, ws, projectId); return projectProject(cur, { counts }); } // idempotent
      const row = await projectStore.archive(client, ws, projectId, expectedRevision);
      if (!row) return REJECT(CP_ERRORS.E_REVISION_CONFLICT);
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "project.archived", targetType: "project", targetId: projectId, metadata: {} });
      const counts = await projectStore.counts(client, ws, projectId);
      return projectProject(row, { counts });
    }));
  }

  // ================================================================ WORKERS / AFFINITY
  async function listProjectWorkers({ ws }) {
    return persistence.tenantTransaction(ws, async (client) => {
      const rows = await workerStore.list(client, ws);
      const workers = [];
      for (const r of rows) workers.push(projectWorker(r, { capabilities: await workerStore.capabilities(client, ws, r.id), reconcileBarrierOpen: r.reconcile_barrier_open }));
      return { workers };
    });
  }

  async function assignAffinity({ ws, actorId, projectId, workerId, expectedGeneration = null }) {
    // Pre-validate the worker is paired, in-workspace, and not disabled (assignProjectAffinity also
    // re-checks workspace membership + migration safety). assignProjectAffinity opens its own txn.
    const pre = settle(await persistence.tenantTransaction(ws, async (client) => {
      const project = await projectStore.get(client, ws, projectId);
      if (!project) return REJECT(CP_ERRORS.E_PROJECT_NOT_FOUND);
      if (project.archived_at) return REJECT(CP_ERRORS.E_PROJECT_ARCHIVED);
      const wrow = await workerStore.get(client, ws, workerId);
      if (!wrow) return REJECT(CP_ERRORS.E_WORKER_NOT_FOUND);
      if (wrow.status === "REVOKED" || wrow.disabled_at) return REJECT(CP_ERRORS.E_WORKER_NOT_AVAILABLE);
      return { ok: true };
    }));
    if (!pre.ok) return pre;
    try {
      // assigned_by references users(id); the staging operator is not a user (captured in audit).
      const res = await OWN.assignProjectAffinity(persistence, { workspaceId: ws, projectId, workerId, assignedBy: null, expectedGeneration: expectedGeneration ?? undefined, releaseReason: "reassigned" });
      await persistence.tenantTransaction(ws, (client) => auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "affinity.assigned", targetType: "project", targetId: projectId, metadata: { workerId, generation: res.affinity.generation, migrated: res.migrated } }));
      return { workerId, generation: res.affinity.generation, migrated: res.migrated };
    } catch (err) { throw toApiError(err); }
  }

  async function releaseAffinity({ ws, actorId, projectId, expectedGeneration = null, reason = null }) {
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const project = await projectStore.get(client, ws, projectId);
      if (!project) return REJECT(CP_ERRORS.E_PROJECT_NOT_FOUND);
      const aff = await affinityStore.active(client, ws, projectId);
      if (!aff) return { released: false };
      const released = await affinityStore.release(client, ws, projectId, expectedGeneration, { reason: reason ? String(reason).slice(0, 128) : "released" });
      if (!released) return REJECT(CP_ERRORS.E_AFFINITY_CONFLICT);
      // The active affinity row is authoritative; projects.home_worker_id is a denormalized pointer
      // maintained by assignProjectAffinity (which bumps the project revision under its revision
      // trigger). We deliberately do NOT touch it here — clearing it without a revision bump would
      // trip cp_revision_increment, and the API reads worker state from the affinity table anyway.
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "affinity.released", targetType: "project", targetId: projectId, metadata: { workerId: aff.worker_id } });
      return { released: true, workerId: aff.worker_id };
    }));
  }

  // ================================================================ GENERATION
  async function createGeneration({ ws, actorId, projectId, input, idempotencyKey = null }) {
    const requestHash = sha256Hex({ v: 1, projectId, input });
    const created = settle(await persistence.tenantTransaction(ws, async (client) => {
      const project = await projectStore.get(client, ws, projectId);
      if (!project) return REJECT(CP_ERRORS.E_PROJECT_NOT_FOUND);
      if (project.archived_at) return REJECT(CP_ERRORS.E_PROJECT_ARCHIVED);
      const createdByUserId = await actorUser(client, ws);

      let reqIdemKey, replayed = false;
      if (idempotencyKey) {
        const claim = await idempotencyRepository.claim(client, ws, { scope: "generation.create", key: idempotencyKey, requestHash });
        if (!claim.fresh) {
          if (!claim.row || claim.row.request_hash !== requestHash) return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT);
          if (claim.row.status === "COMPLETED" && claim.row.response) { reqIdemKey = claim.row.response.reqIdemKey; replayed = true; }
          else return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT);
        } else reqIdemKey = newId("req");
      } else reqIdemKey = newId("req");

      // input_snapshot is BUSINESS-ONLY (no identity duplication) — createGenerationRequestCore
      // stores the request-idempotency-key/attempt identity at the row level, never in the input.
      const gen = await OWN.createGenerationRequestCore(client, {
        workspaceId: ws, projectId, requestIdempotencyKey: reqIdemKey,
        action: scfg.fakeAction, inputSnapshot: input, quotaRisk: false, createdByUserId
      });
      if (idempotencyKey && !replayed) await idempotencyRepository.complete(client, ws, { scope: "generation.create", key: idempotencyKey, response: { reqIdemKey } });
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: gen.duplicate ? "generation.duplicate" : "generation.requested", targetType: "job", targetId: gen.job.id, metadata: { projectId, duplicate: Boolean(gen.duplicate) } });
      return { requestId: gen.request.id, attemptId: gen.attempt.id, jobId: gen.job.id, duplicate: Boolean(gen.duplicate) };
    }));

    let dispatch = null;
    if (scfg.dispatchOnCreate && !created.duplicate) {
      // Best-effort auto-dispatch (separate txn). A safety block leaves the request WAITING; the
      // operator can retry via POST /jobs/:id/dispatch (which surfaces any hard error).
      try { dispatch = await dispatchJob({ ws, actorId, jobId: created.jobId }); }
      catch { dispatch = null; }
    }
    const view = await persistence.tenantTransaction(ws, async (client) => buildJobView(client, ws, await jobStore.get(client, ws, created.jobId)));
    return {
      requestId: created.requestId, generationAttemptId: created.attemptId, jobId: created.jobId,
      status: view.status, dispatchStatus: dispatch ? dispatch.dispatchStatus : view.dispatchStatus,
      workerId: dispatch ? (dispatch.workerId || null) : (view.worker ? view.worker.id : null),
      duplicate: created.duplicate, createdAt: view.createdAt,
      links: jobLinks(created.jobId)
    };
  }

  function jobLinks(jobId) {
    return { self: `/internal/v1/jobs/${jobId}`, events: `/internal/v1/jobs/${jobId}/events`, results: `/internal/v1/jobs/${jobId}/results` };
  }

  // ---- minimal dispatch coordinator (reuses claimGenerationAttemptForWorkerCore) ----
  async function dispatchJob({ ws, actorId, jobId }) {
    const out = settle(await persistence.tenantTransaction(ws, async (client) => {
      const job = await jobStore.get(client, ws, jobId);
      if (!job) return REJECT(CP_ERRORS.E_JOB_NOT_FOUND);

      // Idempotent: an existing live offer for this attempt → return it (never a second offer).
      const live = await jobOfferRepository.liveForAttempt(client, ws, job.generation_attempt_id);
      if (live) {
        await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "job.dispatched", targetType: "job", targetId: jobId, metadata: { idempotent: true, workerId: live.assigned_worker_id } });
        return { dispatched: true, idempotent: true, dispatchStatus: "OFFERED", workerId: live.assigned_worker_id, offerMessageId: live.offer_message_id };
      }

      const affinity = await affinityStore.active(client, ws, job.project_id);
      if (!affinity) {
        await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "dispatch.blocked", targetType: "job", targetId: jobId, metadata: { reasonCode: "AFFINITY_REQUIRED" } });
        return { dispatched: false, dispatchStatus: "WAITING_FOR_WORKER", reasonCode: "AFFINITY_REQUIRED" };
      }
      const wrow = await workerStore.get(client, ws, affinity.worker_id);
      const online = await workerStore.isOnline(client, ws, affinity.worker_id);
      if (!workerDispatchable(wrow) || !online) {
        await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "dispatch.blocked", targetType: "job", targetId: jobId, metadata: { reasonCode: "WORKER_UNAVAILABLE" } });
        return { dispatched: false, dispatchStatus: "WAITING_FOR_WORKER", reasonCode: "WORKER_UNAVAILABLE" };
      }
      const caps = await workerStore.capabilities(client, ws, wrow.id);
      const need = capabilityForAction(job.type);
      if (caps.length > 0 && need && !caps.includes(need)) return REJECT(CP_ERRORS.E_WORKER_CAPABILITY_MISMATCH);

      // Safe claim — enforces ALL paid-safety (not owned / not submitting / not submitted / not
      // possiblySubmitted / not recovering / not terminal / no unsafe prior offer / affinity match /
      // reconcile barrier closed). Fake staging jobs require NO paid approval grant.
      const claim = await OWN.claimGenerationAttemptForWorkerCore(client, { workspaceId: ws, attemptId: job.generation_attempt_id, workerId: wrow.id, requireApproval: false });
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "job.dispatched", targetType: "job", targetId: jobId, metadata: { workerId: wrow.id, offerMessageId: claim.offer.offer_message_id } });
      return { dispatched: true, dispatchStatus: "OFFERED", workerId: wrow.id, offerMessageId: claim.offer.offer_message_id };
    }));
    return out;
  }

  // ================================================================ JOB READS
  async function listJobs({ ws, projectId, limit, offset }) {
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const project = await projectStore.get(client, ws, projectId);
      if (!project) return REJECT(CP_ERRORS.E_PROJECT_NOT_FOUND);
      const { rows, total } = await jobStore.list(client, ws, projectId, { limit, offset });
      const jobs = [];
      for (const j of rows) jobs.push(await buildJobView(client, ws, j));
      return { jobs, total };
    }));
  }
  async function getJob({ ws, jobId }) {
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const job = await jobStore.get(client, ws, jobId);
      if (!job) return REJECT(CP_ERRORS.E_JOB_NOT_FOUND);
      return buildJobView(client, ws, job);
    }));
  }
  async function jobEvents({ ws, jobId, limit, offset }) {
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const job = await jobStore.get(client, ws, jobId);
      if (!job) return REJECT(CP_ERRORS.E_JOB_NOT_FOUND);
      const attempt = await jobStore.attempt(client, ws, job.generation_attempt_id);
      const all = projectJobEvents({ job, attempt });
      return { events: all.slice(offset, offset + limit), total: all.length };
    }));
  }

  // ================================================================ CANCEL (reuses applyCancelCore)
  async function cancelJob({ ws, actorId, jobId }) {
    const out = settle(await persistence.tenantTransaction(ws, async (client) => {
      const before = await jobStore.get(client, ws, jobId);
      if (!before) return REJECT(CP_ERRORS.E_JOB_NOT_FOUND);
      const res = await OWN.applyCancelCore(client, { workspaceId: ws, jobId });
      const job = res.job;
      // Deliver a durable JOB_CANCEL_REQUEST when the job is assigned + not already terminal and no
      // cancel is already queued (idempotent). NEVER a direct socket send.
      let outboxCreated = false;
      if (!res.idempotent && job.worker_id && !TERMINAL_JOB.has(before.status)) {
        const existing = await client.query("SELECT 1 FROM protocol_outbox WHERE workspace_id=$1 AND job_id=$2 AND type='JOB_CANCEL_REQUEST'", [ws, jobId]);
        if (existing.rowCount === 0) {
          await protocolRepository.createOutbox(client, ws, {
            messageId: newId("msg"), workerId: job.worker_id, jobId, generationAttemptId: job.generation_attempt_id,
            type: "JOB_CANCEL_REQUEST", settlementMode: "LIFECYCLE_RESPONSE", expectedResponseTypes: ["JOB_CANCELED"],
            orderingKey: `${job.worker_id}:${jobId}`, payload: { reason: "operator_cancel" }
          });
          outboxCreated = true;
        }
      }
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "job.cancel_requested", targetType: "job", targetId: jobId, metadata: { possiblySubmitted: Boolean(res.possiblySubmitted), outboxCreated, idempotent: Boolean(res.idempotent) } });
      return { jobId, possiblySubmitted: Boolean(res.possiblySubmitted), outboxCreated, idempotent: Boolean(res.idempotent) };
    }));
    const view = await getJob({ ws, jobId });
    return { ...out, status: view.status };
  }

  // ================================================================ RETRY (new request/attempt/job)
  async function retryJob({ ws, actorId, jobId, idempotencyKey = null }) {
    const requestHash = sha256Hex({ v: 1, retryOf: jobId });
    const created = settle(await persistence.tenantTransaction(ws, async (client) => {
      const priorJob = await jobStore.get(client, ws, jobId);
      if (!priorJob) return REJECT(CP_ERRORS.E_JOB_NOT_FOUND);
      if (NOT_RETRYABLE.has(priorJob.status)) return REJECT(CP_ERRORS.E_JOB_NOT_RETRYABLE);
      const priorRequest = await jobStore.requestForAttempt(client, ws, priorJob.generation_attempt_id);
      const createdByUserId = await actorUser(client, ws);

      let reqIdemKey, replayed = false;
      if (idempotencyKey) {
        const claim = await idempotencyRepository.claim(client, ws, { scope: "generation.create", key: idempotencyKey, requestHash: sha256Hex({ v: 1, retryOf: jobId }) });
        if (!claim.fresh) {
          if (claim.row && claim.row.status === "COMPLETED" && claim.row.response && claim.row.response.reqIdemKey) { reqIdemKey = claim.row.response.reqIdemKey; replayed = true; }
          else return REJECT(CP_ERRORS.E_IDEMPOTENCY_CONFLICT);
        } else reqIdemKey = newId("req");
      } else reqIdemKey = newId("req");

      // NEW request/attempt/job with explicit retry lineage. The OLD attempt is never reactivated;
      // its generationAttemptId is never reused; terminal/submission evidence is untouched.
      const gen = await OWN.createGenerationRequestCore(client, {
        workspaceId: ws, projectId: priorJob.project_id, requestIdempotencyKey: reqIdemKey,
        action: priorJob.type, inputSnapshot: (priorRequest && priorRequest.input_snapshot) || priorJob.input || {},
        quotaRisk: false, createdByUserId,
        parentAttemptId: priorJob.generation_attempt_id, retryOfJobId: priorJob.id
      });
      if (idempotencyKey && !replayed) await idempotencyRepository.complete(client, ws, { scope: "generation.create", key: idempotencyKey, response: { reqIdemKey } });
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "job.retry_requested", targetType: "job", targetId: gen.job.id, metadata: { retryOfJobId: priorJob.id, parentAttemptId: priorJob.generation_attempt_id } });
      return { requestId: gen.request.id, generationAttemptId: gen.attempt.id, jobId: gen.job.id, previousJobId: priorJob.id, previousAttemptId: priorJob.generation_attempt_id };
    }));
    const view = await getJob({ ws, jobId: created.jobId });
    return { ...created, status: view.status, dispatchStatus: view.dispatchStatus, links: jobLinks(created.jobId), lineage: { previousJobId: created.previousJobId, previousAttemptId: created.previousAttemptId } };
  }

  // ================================================================ RESULTS / ASSETS
  async function getJobResults({ ws, jobId }) {
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const job = await jobStore.get(client, ws, jobId);
      if (!job) return REJECT(CP_ERRORS.E_JOB_NOT_FOUND);
      const rows = await assetStore.listForAttempt(client, ws, job.generation_attempt_id);
      const assets = [];
      for (const a of rows) {
        const online = a.producing_worker_id ? await workerStore.isOnline(client, ws, a.producing_worker_id) : null;
        assets.push(projectAsset(a, { workerOnline: online }));
      }
      const terminal = await jobStore.terminal(client, ws, jobId);
      return { jobId, generationStatus: job.status === "SUCCEEDED" ? "COMPLETED" : job.status, assets, terminalType: terminal ? terminal.terminal_type : null };
    }));
  }

  async function reviewAsset({ ws, actorId, assetId, reviewStatus, expectedRevision }) {
    const ALLOWED = new Set(["UNREVIEWED", "SELECTED", "APPROVED", "REJECTED"]);
    if (!ALLOWED.has(reviewStatus)) throw apiError(CP_ERRORS.E_BAD_REQUEST, "Invalid review status");
    return settle(await persistence.tenantTransaction(ws, async (client) => {
      const cur = await assetStore.get(client, ws, assetId);
      if (!cur) return REJECT(CP_ERRORS.E_NOT_FOUND);
      let updated;
      try {
        updated = await assetRepository.setReview(client, ws, assetId, expectedRevision, {
          reviewStatus, selected: reviewStatus === "SELECTED" ? true : (reviewStatus === "REJECTED" ? false : null),
          approved: reviewStatus === "APPROVED" ? true : (reviewStatus === "REJECTED" ? false : null)
        });
      } catch (e) { return REJECT(CP_ERRORS.E_REVISION_CONFLICT); }
      await auditRepository.record(client, { workspaceId: ws, actorType: "ADMIN", actorId, action: "asset.review_updated", targetType: "asset", targetId: assetId, metadata: { reviewStatus } });
      const online = updated.producing_worker_id ? await workerStore.isOnline(client, ws, updated.producing_worker_id) : null;
      return projectAsset(updated, { workerOnline: online });
    }));
  }

  return {
    createProject, listProjects, getProject, updateProject, archiveProject,
    listProjectWorkers, assignAffinity, releaseAffinity,
    createGeneration, dispatchJob,
    listJobs, getJob, jobEvents, cancelJob, retryJob, getJobResults, reviewAsset
  };
}
