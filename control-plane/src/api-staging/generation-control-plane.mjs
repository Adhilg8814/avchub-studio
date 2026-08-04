// P0 Step 5C.9E — durable generation control plane (facade).
//
// The SINGLE source of truth for local Grok video generation when a control-plane PostgreSQL is
// available. It composes the FROZEN ownership pipeline (generation_requests → generation_attempts
// → jobs → job_offers via ownership.mjs cores + claimGenerationAttemptForWorkerCore + the
// job_offers lease) with the 1:1 generation_jobs EXTENSION (generation-projection-repository.mjs).
//
// It adds NO second scheduler/claim/lease: dispatch is claimGenerationAttemptForWorkerCore, the
// lease is the job_offers lease, expiry/reoffer is expireOfferCore/safeReoffer, submission facts
// are applySubmissionFactCore, terminals are applyTerminalCore/applyCancelCore. generation_jobs
// only projects Grok-specific lifecycle granularity, the selected account, invocation/submit
// correlation, result/media, redacted events, and media capabilities.
//
// The Worker drives this facade in-process (control-plane + Worker share the node process in the
// local runtime): enqueue → requestStart (claim → offer+lease) → claimNextForWorker (accept its
// own offer) → run executor with the PIPELINE attemptId → submit/terminal facts → recovery.

import { createHash, randomBytes } from "node:crypto";
import * as OWN from "../persistence/transactions/ownership.mjs";
import * as R from "../persistence/repositories/repositories.mjs";
import { idempotencyRepository } from "../persistence/repositories/pairing-repository.mjs";
import {
  generationProjectionRepository as proj,
  mapExtensionRow,
  projectExtensionRowForUi
} from "../persistence/repositories/generation-projection-repository.mjs";
import { newId } from "../persistence/ids.mjs";
import { GENERATION_JOB_STATES as S, isPostSubmit, isTerminal } from "../../../lib/protocol/generation-job-states.mjs";
import { asGate } from "../../../lib/protocol/generation-execution-gate.mjs";
import { reserveSlot, noteSlotOutcome, listSlots, normalizeCooldownMs, jitterFor, slotKeyOf, classifyRunFailure, DEFAULT_PROVIDER_COOLDOWN_MS, MAX_COOLDOWN_DEFERRALS } from "./generation-cooldown.mjs";

const LOCAL_WORKER_NAME = "local-grok-generation-worker";
const PROJECT_MARKER = "grok-generation";
const DEFAULT_OFFER_TTL_MS = 60_000;
const DEFAULT_LEASE_TTL_MS = 300_000;

function cpErr(code, message) { return Object.assign(new Error(message), { code }); }
function promptHashOf(prompt) { return `sha256:${createHash("sha256").update(String(prompt), "utf8").digest("hex")}`; }
function digestOf(token) { return createHash("sha256").update(String(token), "utf8").digest("hex"); }
function iso(ms) { return new Date(ms).toISOString(); }

export function createGenerationControlPlane({ persistence, config, now = () => Date.now(), workerName = LOCAL_WORKER_NAME, projectMarker = PROJECT_MARKER, tenantGuard = null, executionGate = null, slotResolver = null,
  // P0 Step 5C.31 - REMOTE DELIVERY. Resolves WHICH worker executes this workspace's attempts:
  //   null / { mode: "LOCAL" }  -> the in-process local worker (current production behaviour, byte-identical)
  //   { mode: "REMOTE", workerId, assignable, reason } -> a paired remote machine owns the work.
  // The resolver is consulted at DISPATCH time only. It never changes an attempt that is already owned, and a
  // REMOTE workspace NEVER silently falls back to local execution: an unavailable remote worker BLOCKS the
  // dispatch (the job stays QUEUED with a clear reason) instead of quietly running on the wrong machine.
  executionWorkerResolver = null } = {}) {
  // P0 Step 5C.30 - provider pacing. slotResolver() is supplied by the WORKER (only it knows which physical
  // account/profile lane a dispatch will use) and returns { provider, accountRef, profileRef } or null. When
  // present, EVERY dispatch path (manual start, movie scene, pipeline) reserves the lane first, so there is no
  // bypass from the browser or the API. Absent -> unthrottled (unchanged behaviour for tests/older runtimes).
  const baseCooldownMs = normalizeCooldownMs(config?.generation?.providerCooldownMs, DEFAULT_PROVIDER_COOLDOWN_MS);
  // P0 Step 5C.29 Phase 0 — server-side maintenance pause. When paused, the three entry points that can lead to
  // a provider invocation (enqueue -> requestStart -> claim) refuse with E_GENERATION_EXECUTION_PAUSED BEFORE
  // any transaction, so no durable state is touched. Reads (listForUi/getForUi/events/media) stay available.
  const gate = asGate(executionGate);
  if (!persistence || typeof persistence.tenantTransaction !== "function") {
    throw new TypeError("createGenerationControlPlane requires a persistence adapter");
  }
  const ws = config?.stagingApi?.workspaceId;
  if (typeof ws !== "string" || !/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(ws)) {
    throw cpErr("E_GENERATION_CP_WORKSPACE", "A configured staging workspace is required");
  }
  const action = config?.stagingApi?.fakeAction || "GENERATE_GROK_VIDEO";
  const tx = (fn, opts) => persistence.tenantTransaction(ws, fn, opts);

  // Commit-then-signal: the adapter's tenantTransaction only PRESERVES a DomainError, and
  // DomainError normalizes any unknown code to E_INVALID_STATE_TRANSITION — so a custom
  // E_GENERATION_* thrown INSIDE the txn would lose its code. Instead a validating txn returns a
  // reject marker (no side effects committed before the check) and we throw the coded error AFTER
  // the transaction, exactly like ownership.safeReoffer.
  const reject = (code, message) => ({ __reject: { code, message } });
  async function txReject(fn, opts) {
    const out = await tx(fn, opts);
    if (out && out.__reject) throw cpErr(out.__reject.code, out.__reject.message);
    return out;
  }

  let bootstrap = null; // { workerId, projectId }

  async function workspaceOwner(client) {
    const row = (await client.query("SELECT owner_user_id FROM workspaces WHERE id=$1", [ws])).rows[0];
    return row ? row.owner_user_id : null;
  }

  // Self-seed the single-tenant workspace + its owner user when the local runtime's fresh database
  // has none yet. RLS: app.current_workspace is already set to ws by the tenant transaction, so the
  // workspaces_insert policy (WITH CHECK id = current context) permits it; users has no RLS. This
  // is a no-op when the workspace already exists (the multi-tenant test harnesses seed it directly).
  async function ensureWorkspaceAndOwner(client) {
    const existing = await workspaceOwner(client);
    if (existing) return existing;
    const userId = newId("usr");
    const inserted = (await client.query(
      "INSERT INTO users (id, email, status) VALUES ($1,$2,'ACTIVE') ON CONFLICT (email) DO NOTHING RETURNING id",
      [userId, "local-grok-generation@worker.local"])).rows[0];
    const ownerId = inserted ? inserted.id : (await client.query("SELECT id FROM users WHERE email=$1", ["local-grok-generation@worker.local"])).rows[0].id;
    await client.query("INSERT INTO workspaces (id, name, owner_user_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [ws, "Local Grok generation", ownerId]);
    return ownerId;
  }

  // Ensure exactly one durable local worker row + one project + ACTIVE affinity. Idempotent, so a
  // restart re-adopts the SAME worker/project (stable identity → recovery reclaims its own offers).
  async function ensureBootstrap() {
    if (bootstrap) return bootstrap;
    const base = await tx(async (client) => {
      await ensureWorkspaceAndOwner(client);
      let worker = (await client.query("SELECT id FROM workers WHERE workspace_id=$1 AND name=$2 ORDER BY created_at ASC LIMIT 1", [ws, workerName])).rows[0];
      if (!worker) {
        const workerId = newId("wrk");
        await client.query(
          "INSERT INTO workers (id, workspace_id, name, platform, protocol_version, status, paired_at, first_seen_at) VALUES ($1,$2,$3,'win32',1,'OFFLINE', now(), now())",
          [workerId, ws, workerName]);
        worker = { id: workerId };
      }
      let project = (await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND storage_relative_root=$2 AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1", [ws, projectMarker])).rows[0];
      if (!project) {
        const createdByUserId = await workspaceOwner(client);
        const row = await R.projectRepository.create(client, ws, {
          title: "Local Grok generation", storageRelativeRoot: projectMarker, createdByUserId
        });
        project = { id: row.id };
      }
      return { workerId: worker.id, projectId: project.id };
    });
    // Affinity assignment opens its own transaction (assignProjectAffinity is the adapter wrapper);
    // it is idempotent (unchanged when the ACTIVE affinity already targets this worker).
    await OWN.assignProjectAffinity(persistence, { workspaceId: ws, projectId: base.projectId, workerId: base.workerId, assignedBy: null });
    bootstrap = base;
    return bootstrap;
  }

  async function workerId() { return (await ensureBootstrap()).workerId; }
  // P0 Step 5C.31 - hand this workspace project to a dedicated (remote) worker. Called at BIND time, i.e.
  // tenant onboarding, before any attempt exists: the pipeline refuses to migrate an affinity while attempts
  // are unresolved, and that refusal must stay intact rather than being routed around at dispatch.
  async function adoptExecutionWorker(targetWorkerId) {
    const boot = await ensureBootstrap();
    await OWN.assignProjectAffinity(persistence, { workspaceId: ws, projectId: boot.projectId, workerId: targetWorkerId, assignedBy: null });
    return { adopted: true, workerId: targetWorkerId, projectId: boot.projectId };
  }
  async function projectId() { return (await ensureBootstrap()).projectId; }

  // ---------------------------------------------------------------- enqueue (create)
  // One request→attempt→job (idempotent via idempotency_keys scope generation.create) + the 1:1
  // projection row bound to the SAME attempt. Never a second identity.
  async function enqueue(inputArg = {}) {
    gate.assertRunning("enqueue"); // maintenance pause: refuse BEFORE bootstrap/transaction (no state touched)
    const { projectId: pid } = await ensureBootstrap();
    const prompt = String(inputArg.prompt ?? "").trim();
    if (prompt.length < 3) throw cpErr("E_GENERATION_PROMPT_INVALID", "Prompt is required");
    const durationSeconds = Number.isFinite(inputArg.durationSeconds) ? Math.min(30, Math.max(1, Math.round(inputArg.durationSeconds))) : 6;
    const aspectRatio = typeof inputArg.aspectRatio === "string" && inputArg.aspectRatio ? inputArg.aspectRatio : "9:16";
    const providerAccountId = /^pa_[0-9A-HJKMNP-TV-Z]{26}$/u.test(inputArg.providerAccountId || "") ? inputArg.providerAccountId : null;
    const accountSelection = providerAccountId ? "EXPLICIT" : "AUTO";
    const idempotencyKey = typeof inputArg.idempotencyKey === "string" && inputArg.idempotencyKey ? inputArg.idempotencyKey : null;
    const inputSnapshot = { kind: "VIDEO", prompt, durationSeconds, aspectRatio, outputCount: 1 };
    const requestHash = createHash("sha256").update(JSON.stringify({ v: 1, pid, inputSnapshot }), "utf8").digest("hex");

    const created = await txReject(async (client) => {
      const createdByUserId = await workspaceOwner(client);
      // P0 Step 5C.29 Phase 8 — customer lifecycle + quota at the universal enqueue choke point. Runs INSIDE
      // this transaction so a suspended/expired customer or an over-quota reservation refuses the job BEFORE any
      // provider invocation, and the grok reservation rolls back with the transaction on any later failure. A
      // workspace with no linked customer (existing owner) is unmanaged -> the guard is a no-op. The count is
      // RLS-scoped to THIS workspace (generation_jobs is workspace-RLS) so tenants never see each other's jobs.
      if (tenantGuard) {
        await tenantGuard.assertCanEnqueue(client, {
          workspaceId: ws,
          countActiveJobs: async (c) => Number((await c.query("SELECT count(*)::int n FROM generation_jobs WHERE state IN ('QUEUED','WAITING_FOR_ACCOUNT','PREPARING','READY_TO_SUBMIT','SUBMITTED','PROCESSING')")).rows[0].n)
        });
      }
      let reqIdemKey = null, replayedJobId = null;
      if (idempotencyKey) {
        const claim = await idempotencyRepository.claim(client, ws, { scope: "generation.create", key: idempotencyKey, requestHash });
        if (!claim.fresh) {
          if (!claim.row || claim.row.request_hash !== requestHash) return reject("E_GENERATION_IDEMPOTENCY_CONFLICT", "Idempotency key reused with a different request");
          if (claim.row.status === "COMPLETED" && claim.row.response) { replayedJobId = claim.row.response.jobId; }
          else return reject("E_GENERATION_IDEMPOTENCY_CONFLICT", "Concurrent create in progress");
        } else reqIdemKey = newId("req");
      } else reqIdemKey = newId("req");

      if (replayedJobId) return { jobId: replayedJobId, duplicate: true };

      const gen = await OWN.createGenerationRequestCore(client, {
        workspaceId: ws, projectId: pid, requestIdempotencyKey: reqIdemKey,
        action, inputSnapshot, quotaRisk: true, createdByUserId
      });
      // 1:1 projection bound to the SAME job + attempt.
      await proj.insert(client, ws, {
        jobId: gen.job.id, generationAttemptId: gen.attempt.id, provider: "GROK",
        providerAccountId, accountSelection, prompt, promptHash: promptHashOf(prompt),
        durationSeconds, aspectRatio, invocationScope: "ATTEMPT",
        source: inputArg.source === "IMPORT" ? "IMPORT" : "UI",
        isCertificationEvidence: inputArg.isCertificationEvidence === true,
        createCommandId: idempotencyKey
      });
      await proj.appendEvent(client, ws, gen.job.id, { type: "JOB_QUEUED", detail: { accountSelection } });
      if (idempotencyKey) await idempotencyRepository.complete(client, ws, { scope: "generation.create", key: idempotencyKey, response: { jobId: gen.job.id } });
      return { jobId: gen.job.id, duplicate: Boolean(gen.duplicate) };
    });
    return getForUi(created.jobId);
  }

  // ---------------------------------------------------------------- requestStart (dispatch)
  // Real dispatch: claimGenerationAttemptForWorkerCore mints ONE job_offer + lease + JOB_OFFER
  // outbox for the affinity worker. Idempotent: an existing live offer is returned, never a second.
  async function requestStart({ jobId, slot = undefined } = {}) {
    gate.assertRunning("requestStart"); // maintenance pause: a QUEUED job can never be offered/started
    const boot = await ensureBootstrap();
    // P0 Step 5C.31 - who executes this workspace's work? Resolved BEFORE the transaction because it reads the
    // dedicated-resource registry + the remote worker liveness, and because a BLOCKED answer must not open a
    // transaction at all (nothing to roll back, nothing half-claimed).
    let exec = { mode: "LOCAL", workerId: boot.workerId, assignable: true, reason: "LOCAL" };
    if (typeof executionWorkerResolver === "function") {
      try { exec = (await Promise.resolve(executionWorkerResolver())) || exec; } catch { /* fail safe to local */ }
    }
    if (exec.mode === "REMOTE") {
      if (!exec.workerId) return { dispatchStatus: "BLOCKED", blocked: true, reason: "NO_REMOTE_WORKER", deliveryMode: "REMOTE" };
      if (exec.assignable === false) {
        // No fallback: a tenant bound to a dedicated remote worker must never have its prompt executed on the
        // Studio host browser/profile. The job simply waits, visibly, with the reason the owner can act on.
        return { dispatchStatus: "BLOCKED", blocked: true, reason: exec.reason || "REMOTE_WORKER_UNAVAILABLE", workerId: exec.workerId, deliveryMode: "REMOTE" };
      }
    }
    const wid = exec.mode === "REMOTE" ? exec.workerId : boot.workerId;
    // Project affinity is the pipeline "this project belongs to that worker" rule. Moving a workspace to a
    // dedicated remote worker moves the affinity with it (idempotent), so claimGenerationAttemptForWorkerCore
    // does not refuse with E_AFFINITY_CONFLICT and the LOCAL worker stops being a candidate at all.
    if (exec.mode === "REMOTE") {
      // Idempotent when the affinity already points at this worker. If it does not, the pipeline refuses to
      // migrate a project that still has unresolved attempts (E_RECONCILIATION_REQUIRED) - that refusal is
      // CORRECT and is surfaced as a blocked dispatch with an actionable reason, never worked around and
      // never downgraded to local execution.
      try { await OWN.assignProjectAffinity(persistence, { workspaceId: ws, projectId: boot.projectId, workerId: wid, assignedBy: null }); }
      catch (e) {
        const reason = (e && e.code === "E_RECONCILIATION_REQUIRED") ? "AFFINITY_MIGRATION_BLOCKED" : "AFFINITY_ASSIGN_FAILED";
        return { dispatchStatus: "BLOCKED", blocked: true, reason, workerId: wid, deliveryMode: "REMOTE" };
      }
    }
    // Resolve the physical submission lane once, OUTSIDE the transaction (worker-side registry knowledge).
    // A remote worker is its OWN lane: its pacing must not be shared with the Studio host Grok account.
    const lane = slot === undefined
      ? (exec.mode === "REMOTE"
        ? { provider: "GROK", accountRef: `worker:${wid}`, profileRef: "-" }
        : (typeof slotResolver === "function" ? await Promise.resolve(slotResolver()).catch(() => null) : null))
      : slot;
    return txReject(async (client) => {
      const p = await proj.get(client, ws, jobId);
      if (!p) return reject("E_GENERATION_JOB_NOT_FOUND", "Job not found");
      if (isPostSubmit(p.state) || isTerminal(p.state)) return reject("E_GENERATION_START_REJECTED", "Job already progressed");
      const attemptId = p.generationAttemptId;
      if (!attemptId) return reject("E_GENERATION_NO_ATTEMPT", "Job has no attempt");
      const live = await R.jobOfferRepository.liveForAttempt(client, ws, attemptId);
      if (live) return { dispatchStatus: "OFFERED", offerId: live.id, workerId: live.assigned_worker_id, leaseExpiresAt: live.lease_expires_at, idempotent: true };
      // Record the START INTENT durably: a deferred job must still be known to be "wanted", so the scheduler
      // can pick it up later without the caller having to ask again.
      await client.query("UPDATE generation_jobs SET start_intent_at = COALESCE(start_intent_at, now()) WHERE workspace_id=$1 AND id=$2", [ws, jobId]);
      if (lane && lane.provider && lane.accountRef) {
        const res = await reserveSlot(client, { ...lane, nowMs: now(), baseCooldownMs, newId });
        if (!res.granted) {
          // DEFER: no offer, no lease, no browser, no invocation. The job stays QUEUED with an ETA.
          const attempts = (p.cooldownAttemptCount ?? 0) + 1;
          await client.query(
            `UPDATE generation_jobs SET next_eligible_at=$3, cooldown_reason=$4, cooldown_attempt_count=$5, provider_slot_ref=$6, updated_at=now()
              WHERE workspace_id=$1 AND id=$2`,
            [ws, jobId, res.nextEligibleAt, "PROVIDER_COOLDOWN", attempts, res.slotKey]);
          await proj.appendEvent(client, ws, jobId, { type: "JOB_DEFERRED_PROVIDER_COOLDOWN", detail: { nextEligibleAt: new Date(res.nextEligibleAt).toISOString(), attempt: attempts } });
          return { dispatchStatus: "DEFERRED", deferred: true, nextEligibleAt: res.nextEligibleAt, cooldownMs: res.cooldownMs, slotKey: res.slotKey, reason: "PROVIDER_COOLDOWN" };
        }
        await client.query("UPDATE generation_jobs SET next_eligible_at=NULL, cooldown_reason=NULL, provider_slot_ref=$3 WHERE workspace_id=$1 AND id=$2", [ws, jobId, res.slotKey]);
      }
      const claim = await OWN.claimGenerationAttemptForWorkerCore(client, {
        workspaceId: ws, attemptId, workerId: wid, requireApproval: false,
        offerTtlMs: DEFAULT_OFFER_TTL_MS, leaseTtlMs: DEFAULT_LEASE_TTL_MS
      });
      if (exec.mode === "REMOTE") {
        await client.query("UPDATE generation_jobs SET delivery_mode='REMOTE' WHERE workspace_id=$1 AND id=$2", [ws, jobId]);
      }
      await proj.appendEvent(client, ws, jobId, { type: "JOB_START_REQUESTED", detail: { deliveryMode: exec.mode } });
      return { dispatchStatus: "OFFERED", offerId: claim.offer.id, workerId: wid, deliveryMode: exec.mode, leaseExpiresAt: claim.offer.lease_expires_at, idempotent: false };
    });
  }

  // ---------------------------------------------------------------- worker claim (accept offer)
  // The Worker consumes ITS OWN live offers in-process (the offer is already assigned to this
  // worker by affinity at claim time). SKIP LOCKED + the OFFERED/accepted_at guards make a double
  // pull impossible. Accepting sets the offer/attempt/job to ACCEPTED and the projection PREPARING.
  async function claimNextForWorker({ max = 1 } = {}) {
    // maintenance pause: claim NOTHING (silent, non-throwing — this is a background-loop call site, and an
    // OFFERED job must simply stay OFFERED, untouched, until the owner resumes execution).
    if (gate.blocked()) return [];
    const { workerId: wid } = await ensureBootstrap();
    return tx(async (client) => {
      const rows = (await client.query(
        `SELECT id, job_id, generation_attempt_id, lease_expires_at FROM job_offers
          WHERE workspace_id=$1 AND assigned_worker_id=$2 AND ownership_status='OFFERED' AND accepted_at IS NULL
          ORDER BY created_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED`, [ws, wid, Math.max(1, Math.min(max, 16))])).rows;
      const claimed = [];
      for (const off of rows) {
        await R.jobOfferRepository.setStatus(client, ws, off.id, "ACCEPTED", { acceptedAt: iso(now()) });
        await R.generationAttemptRepository.setOwnership(client, ws, off.generation_attempt_id, { ownershipStatus: "ACCEPTED", assignedWorkerId: wid });
        await R.jobRepository.setStatus(client, ws, off.job_id, "ACCEPTED", { workerId: wid, acceptedAt: iso(now()) });
        const p = await proj.get(client, ws, off.job_id);
        if (p && p.state === S.QUEUED) await proj.transition(client, ws, off.job_id, { from: S.QUEUED, to: S.PREPARING });
        await proj.appendEvent(client, ws, off.job_id, { type: "JOB_ACCEPTED", detail: {} });
        const fresh = await proj.get(client, ws, off.job_id);
        claimed.push({
          jobId: off.job_id, generationAttemptId: off.generation_attempt_id, offerId: off.id,
          prompt: fresh.prompt, durationSeconds: fresh.durationSeconds, aspectRatio: fresh.aspectRatio,
          providerAccountId: fresh.providerAccountId, accountSelection: fresh.accountSelection,
          leaseExpiresAt: off.lease_expires_at
        });
      }
      return claimed;
    });
  }

  // Extend the job_offers lease while the worker actively runs (still the owner).
  async function heartbeat({ jobId, leaseTtlMs = DEFAULT_LEASE_TTL_MS, workerId: explicitWorkerId = null }) {
    // P0 Step 5C.31 - a REMOTE attempt is owned by the remote worker id, so the caller passes it in; the
    // local runtime keeps calling without it and gets the bootstrap worker exactly as before.
    const wid = explicitWorkerId || (await ensureBootstrap()).workerId;
    return tx(async (client) => {
      const r = await client.query(
        `UPDATE job_offers SET lease_expires_at=$4, last_worker_event_at=now()
          WHERE workspace_id=$1 AND job_id=$2 AND assigned_worker_id=$3
            AND ownership_status IN ('ACCEPTED','RUNNING','SUBMITTING') RETURNING lease_expires_at`,
        [ws, jobId, wid, iso(now() + leaseTtlMs)]);
      return { extended: r.rowCount === 1, leaseExpiresAt: r.rows[0]?.lease_expires_at ?? null };
    });
  }

  // Projection-only transition (validated + optimistic). Used for GATE_PASSED → READY_TO_SUBMIT etc.
  async function markState({ jobId, from, to, detail = null, patch = {} }) {
    return tx(async (client) => {
      const out = await proj.transition(client, ws, jobId, { from, to, patch });
      if (out.changed && detail !== undefined) await proj.appendEvent(client, ws, jobId, { type: `STATE_${to}`, detail: detail || {} });
      return out;
    });
  }

  // Submission fact: the ONE durable "submitted" record. applySubmissionFactCore books ordinal=1 +
  // possibly_submitted on the pipeline attempt (idempotent); the projection mirrors SUBMITTED and
  // records the CONSUMED invocation + timestamp. Called from the executor's onBeforeSubmit, before
  // the single click, so a crash after this is only ever tracked read-only.
  async function markSubmitted({ jobId, attemptId, providerSubmissionId = null, workerId: explicitWorkerId = null }) {
    // P0 Step 5C.31 - a REMOTE attempt is owned by the remote worker id, so the caller passes it in; the
    // local runtime keeps calling without it and gets the bootstrap worker exactly as before.
    const wid = explicitWorkerId || (await ensureBootstrap()).workerId;
    return tx(async (client) => {
      await OWN.applySubmissionFactCore(client, { workspaceId: ws, attemptId, workerId: wid, state: "SUBMITTED", confidence: "PRESUMED", providerSubmissionId });
      await client.query("UPDATE job_offers SET ownership_status='SUBMITTING', possibly_submitted=true, last_worker_event_at=now() WHERE workspace_id=$1 AND generation_attempt_id=$2 AND assigned_worker_id=$3 AND ownership_status IN ('ACCEPTED','RUNNING')", [ws, attemptId, wid]);
      const p = await proj.get(client, ws, jobId);
      if (p && (p.state === S.PREPARING || p.state === S.READY_TO_SUBMIT)) {
        if (p.state === S.PREPARING) await proj.transition(client, ws, jobId, { from: S.PREPARING, to: S.READY_TO_SUBMIT });
        await proj.transition(client, ws, jobId, { from: S.READY_TO_SUBMIT, to: S.SUBMITTED });
      }
      await proj.recordInvocation(client, ws, jobId, { invocationState: "CONSUMED", submitAttemptedAt: iso(now()) });
      await proj.appendEvent(client, ws, jobId, { type: "SUBMIT_ATTEMPTED", detail: {} });
      return { ok: true };
    });
  }

  // Terminal COMPLETED: applyTerminalCore records the safe result asset (relative path only) +
  // marks job SUCCEEDED + attempt COMPLETED; the projection records result/media + COMPLETED.
  async function complete({ jobId, resultId = null, resultAsset = null, mediaMeta = null, workerId: explicitWorkerId = null }) {
    // P0 Step 5C.31 - a REMOTE attempt is owned by the remote worker id, so the caller passes it in; the
    // local runtime keeps calling without it and gets the bootstrap worker exactly as before.
    const wid = explicitWorkerId || (await ensureBootstrap()).workerId;
    return txReject(async (client) => {
      const p = await proj.get(client, ws, jobId);
      if (!p) return reject("E_GENERATION_JOB_NOT_FOUND", "Job not found");
      if (isTerminal(p.state)) return { idempotent: true, state: p.state };
      // assets.file_name / mime_type / checksum are NOT NULL; media is local-only. Provider URLs /
      // absolute paths are rejected by upsertSafe's assertRelative on relativePath.
      const assetMeta = mediaMeta ? {
        relativePath: mediaMeta.relativePath,
        fileName: String(mediaMeta.relativePath).split(/[\\/]/).pop() || "generated.mp4",
        mimeType: "video/mp4",
        sizeBytes: mediaMeta.sizeBytes ?? null,
        actualDurationSec: mediaMeta.durationSeconds ?? null,
        width: mediaMeta.width ?? null, height: mediaMeta.height ?? null,
        checksum: typeof mediaMeta.checksum === "string" && mediaMeta.checksum ? mediaMeta.checksum : "unverified",
        storageTier: "LOCAL_ONLY", liveness: "ONLINE"
      } : null;
      await OWN.applyTerminalCore(client, { workspaceId: ws, jobId, workerId: wid, terminalType: "JOB_COMPLETED", terminalMessageId: newId("msg"), assetMeta });
      await proj.recordResult(client, ws, jobId, { resultId, resultAsset, mediaMeta });
      // Advance projection to COMPLETED (from whatever post-submit state it is in).
      const cur = await proj.get(client, ws, jobId);
      if (cur.state === S.SUBMITTED || cur.state === S.PROCESSING || cur.state === S.WAITING_FOR_MANUAL_ACTION) {
        await proj.transition(client, ws, jobId, { from: cur.state, to: S.COMPLETED });
      }
      // 5C.50 — the LIVE offer only. Unscoped, this dragged an already-expired offer back into the live set.
      await settleLiveOffer(client, { jobId, to: "COMPLETED" });
      await proj.appendEvent(client, ws, jobId, { type: "JOB_COMPLETED", detail: {} });
      return { ok: true };
    });
  }

  /**
   * P0 Step 5C.50 — settle the offer that is CURRENTLY LIVE for this job, and only it.
   *
   * The three terminal paths used to write `UPDATE job_offers SET ownership_status=… WHERE job_id=$2`, which
   * matches EVERY offer row the job ever had. A job that was re-offered — a cooldown deferral leaves an
   * EXPIRED_PRE_SUBMIT row behind, and 5C.49 made deferrals routine — therefore had its DEAD offer dragged
   * back into the live set, because `job_offers_one_live_uq` excludes exactly EXPIRED_PRE_SUBMIT and
   * OFFER_REJECTED. Two live offers for one attempt is precisely what that index forbids, so the whole
   * settlement failed with E_ATTEMPT_ALREADY_OWNED and the job could never leave SUBMITTED.
   *
   * The scoping here is the semantic fix, not a way around the constraint: a settled offer stays settled, and
   * only the live one is moved. `cancel()` has always done it this way; the other three did not.
   *
   * Owner-scoped when a worker is named: the live offer belongs to a worker, and only that worker may end it.
   * Returns what it settled so the caller can tell "settled" from "nothing live" from "someone else owns it"
   * — three different situations that must not collapse into one silent no-op.
   */
  async function settleLiveOffer(client, { jobId, to, ownerWorkerId = null, possiblySubmitted = false }) {
    const live = (await client.query(
      `SELECT id, assigned_worker_id, ownership_status FROM job_offers
        WHERE workspace_id=$1 AND job_id=$2 AND ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')
        FOR UPDATE`, [ws, jobId])).rows;
    if (live.length === 0) return { settled: [], live: [], foreign: [] };
    const foreign = ownerWorkerId ? live.filter((o) => o.assigned_worker_id !== ownerWorkerId) : [];
    const mine = ownerWorkerId ? live.filter((o) => o.assigned_worker_id === ownerWorkerId) : live;
    if (mine.length === 0) return { settled: [], live, foreign };
    const params = [ws, mine.map((o) => o.id), to];
    const r = await client.query(
      `UPDATE job_offers SET ownership_status=$3, terminal_at=now(), updated_at=now()${possiblySubmitted ? ", possibly_submitted=true" : ""}
        WHERE workspace_id=$1 AND id = ANY($2) RETURNING id, ownership_status`, params);
    return { settled: r.rows, live, foreign };
  }

  // Pre-submit failure: never submitted → JOB_FAILED terminal + projection FAILED_PRE_SUBMIT.
  async function failPreSubmit({ jobId, code = "E_GENERATION_FAILED_PRE_SUBMIT", reason = "Generation failed before submit", workerId: explicitWorkerId = null }) {
    // P0 Step 5C.31 - a REMOTE attempt is owned by the remote worker id, so the caller passes it in; the
    // local runtime keeps calling without it and gets the bootstrap worker exactly as before.
    const wid = explicitWorkerId || (await ensureBootstrap()).workerId;
    return txReject(async (client) => {
      const p = await proj.get(client, ws, jobId);
      if (!p || isTerminal(p.state)) return { idempotent: true };
      if (isPostSubmit(p.state)) return reject("E_GENERATION_ALREADY_SUBMITTED", "Cannot fail-pre-submit a submitted job");
      await OWN.applyTerminalCore(client, { workspaceId: ws, jobId, workerId: wid, terminalType: "JOB_FAILED", terminalMessageId: newId("msg"), errorCode: code });
      await proj.transition(client, ws, jobId, { from: p.state, to: S.FAILED_PRE_SUBMIT, patch: { errorCode: code, errorReason: reason } });
      await settleLiveOffer(client, { jobId, to: "FAILED" });
      await proj.appendEvent(client, ws, jobId, { type: "JOB_FAILED_PRE_SUBMIT", detail: { code } });
      return { ok: true };
    });
  }

  // Submit-uncertain: the invocation may have been spent but the result is unverified. NEVER retry.
  // The pipeline attempt keeps possibly_submitted evidence (JOB_FAILED preserves it as a column);
  // the projection is the terminal SUBMIT_UNCERTAIN.
  async function submitUncertain({ jobId, reason = "Submit outcome uncertain; not retried", workerId: explicitWorkerId = null }) {
    // P0 Step 5C.31 - a REMOTE attempt is owned by the remote worker id, so the caller passes it in; the
    // local runtime keeps calling without it and gets the bootstrap worker exactly as before.
    const wid = explicitWorkerId || (await ensureBootstrap()).workerId;
    return txReject(async (client) => {
      const p = await proj.get(client, ws, jobId);
      // Already settled by whoever won the race. Idempotent, and deliberately BEFORE anything is written.
      if (!p) return { idempotent: true };
      if (isTerminal(p.state)) return { idempotent: true, state: p.state };

      // P0 Step 5C.50 — the live offer's OWNER ends it, and nobody else.
      //
      // A settlement that quietly did nothing was the worst of the three possible outcomes: the job stayed
      // SUBMITTED, the reconciler only reads SUBMIT_UNCERTAIN, and the workspace stayed degraded with no
      // record of why. So a live offer owned by another worker is a REFUSAL with a name, not a no-op.
      const offers = await settleLiveOffer(client, { jobId, to: "RECOVERING", ownerWorkerId: wid, possiblySubmitted: true });
      if (offers.settled.length === 0 && offers.foreign.length > 0) {
        return reject("E_GENERATION_OFFER_NOT_OWNED", "The live offer for this job belongs to another worker");
      }

      await OWN.applyTerminalCore(client, { workspaceId: ws, jobId, workerId: wid, terminalType: "JOB_FAILED", terminalMessageId: newId("msg"), errorCode: "E_GENERATION_SUBMIT_UNCERTAIN" });
      const from = p.state;
      // The transition is the one-winner primitive: it is an optimistic UPDATE guarded on the state it read,
      // so two racing recoveries cannot both settle. A caller that loses learns it lost.
      const moved = await proj.transition(client, ws, jobId, { from, to: S.SUBMIT_UNCERTAIN, patch: { errorCode: "E_GENERATION_SUBMIT_UNCERTAIN", errorReason: reason } });
      if (!moved.changed) return reject("E_INVALID_STATE_TRANSITION", "The job moved while this settlement was being applied");
      // Same transaction as the transition: an event that fails to append rolls the settlement back rather
      // than leaving a state change nobody can explain.
      await proj.appendEvent(client, ws, jobId, { type: "JOB_SUBMIT_UNCERTAIN", detail: { offersSettled: offers.settled.length } });
      return { ok: true, offersSettled: offers.settled.map((o) => o.id), state: S.SUBMIT_UNCERTAIN };
    });
  }

  /**
   * P0 Step 5C.42 — record an observation about a job without changing its state.
   *
   * Needed because a provider fact can be worth keeping while being nobody's terminal outcome: a clip that
   * came back at a different length than the control was set to is COMPLETED and also wrong, and the only
   * honest place for that is the job's own event log. Append-only and redacted by the repository's existing
   * detail check, so this cannot become a side channel for anything else.
   */
  async function appendJobEvent({ jobId, type, detail = null }) {
    if (typeof type !== "string" || !type) return { ok: false };
    return tx(async (client) => {
      const p = await proj.get(client, ws, jobId);
      if (!p) return { ok: false };
      await proj.appendEvent(client, ws, jobId, { type, detail: detail || {} });
      return { ok: true };
    });
  }

  // Cancel is pre-submit only (applyCancelCore preserves paid evidence if somehow submitted).
  async function cancel({ jobId }) {
    return txReject(async (client) => {
      const p = await proj.get(client, ws, jobId);
      if (!p) return reject("E_GENERATION_JOB_NOT_FOUND", "Job not found");
      if (isTerminal(p.state)) return { idempotent: true, state: p.state };
      if (isPostSubmit(p.state)) return reject("E_GENERATION_CANCEL_REJECTED", "Cannot cancel after submit");
      await OWN.applyCancelCore(client, { workspaceId: ws, jobId });
      await proj.transition(client, ws, jobId, { from: p.state, to: S.CANCELLED_BEFORE_SUBMIT });
      await client.query("UPDATE job_offers SET ownership_status='EXPIRED_PRE_SUBMIT', terminal_at=now() WHERE workspace_id=$1 AND job_id=$2 AND ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')", [ws, jobId]);
      await proj.appendEvent(client, ws, jobId, { type: "JOB_CANCELLED", detail: {} });
      return { ok: true, state: S.CANCELLED_BEFORE_SUBMIT };
    });
  }

  // ---------------------------------------------------------------- reads for the UI
  function computeQueuePositions(list) {
    // Queue position among jobs waiting to run (QUEUED/WAITING_FOR_ACCOUNT), FIFO by createdAt.
    const waiting = list.filter((j) => j.state === S.QUEUED || j.state === S.WAITING_FOR_ACCOUNT);
    const order = new Map(waiting.map((j, i) => [j.jobId, i + 1]));
    return order;
  }

  async function listForUi({ limit = 100, offset = 0, states = null, providerAccountId = null } = {}) {
    return tx(async (client) => {
      const rows = await proj.list(client, ws, { limit, offset, states, providerAccountId });
      const views = [];
      for (const r of rows) views.push(await buildView(client, r));
      const pos = computeQueuePositions(rows.map(mapExtensionRowSafe));
      return views.map((v) => ({ ...v, queuePosition: pos.get(v.jobId) ?? null }));
    });
  }
  async function getForUi(jobId) {
    return tx(async (client) => {
      const r = await proj.get(client, ws, jobId);
      if (!r) return null;
      return buildView(client, r);
    });
  }
  /**
   * P0 Step 5C.43 — the FULL prompt for one job, for reconciliation only.
   *
   * Everything the UI sees is `promptPreview`, 140 characters, and that is deliberate. But matching a job to a
   * card on the provider's surface has to compare what was actually typed: a 140-character preview turns every
   * long prompt into a prefix, and two different jobs whose first sentence agrees become indistinguishable —
   * which in this workspace is not hypothetical. Not projected to any UI, and never included in an event.
   */
  async function promptFor(jobId) {
    return tx(async (client) => {
      const r = await client.query("SELECT prompt FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [ws, jobId]);
      return r.rows[0] ? r.rows[0].prompt : null;
    });
  }

  async function events(jobId, { limit = 200, offset = 0 } = {}) {
    return tx(async (client) => proj.listEvents(client, ws, jobId, { limit, offset }));
  }

  function mapExtensionRowSafe(r) { return r && r.jobId ? r : mapExtensionRow(r); }

  // Join the projection with the ownership offer/job so the UI shows the real dispatch/lease state.
  async function buildView(client, r) {
    const offer = (await client.query(
      `SELECT id, assigned_worker_id, ownership_status, offer_expires_at, lease_expires_at, accepted_at
         FROM job_offers WHERE workspace_id=$1 AND job_id=$2 ORDER BY created_at DESC LIMIT 1`, [ws, r.jobId])).rows[0] || null;
    const startRequested = Boolean(offer) && !["EXPIRED_PRE_SUBMIT", "OFFER_REJECTED"].includes(offer.ownership_status);
    const view = projectExtensionRowForUi(r, { startRequested });
    return {
      ...view,
      assignedWorkerId: offer?.assigned_worker_id ?? null,
      offerStatus: offer?.ownership_status ?? null,
      leaseExpiresAt: offer?.lease_expires_at ?? null,
      offerExpiresAt: offer?.offer_expires_at ?? null
    };
  }

  // ---------------------------------------------------------------- provider pacing (scheduler side)
  // Jobs whose turn has come: QUEUED, wanted (start intent recorded), no live offer, and either never deferred
  // or past their next-eligible time. FIFO by creation so a tenant can never jump the lane queue.
  async function listStartable({ limit = 25 } = {}) {
    return tx(async (client) => {
      const r = await client.query(
        `SELECT p.id, p.generation_attempt_id, p.next_eligible_at, p.cooldown_attempt_count, p.provider_slot_ref
           FROM generation_jobs p
          WHERE p.workspace_id=$1 AND p.state='QUEUED' AND p.start_intent_at IS NOT NULL
            AND (p.next_eligible_at IS NULL OR p.next_eligible_at <= to_timestamp($3/1000.0))
            AND NOT EXISTS (SELECT 1 FROM job_offers o WHERE o.workspace_id=p.workspace_id AND o.generation_attempt_id=p.generation_attempt_id AND o.terminal_at IS NULL)
          ORDER BY p.created_at ASC LIMIT $2`, [ws, Math.max(1, Math.min(limit, 100)), now()]);
      return r.rows.map((x) => ({ jobId: x.id, generationAttemptId: x.generation_attempt_id, nextEligibleAt: x.next_eligible_at, cooldownAttemptCount: x.cooldown_attempt_count, slotKey: x.provider_slot_ref }));
    });
  }

  // A run failed PROVABLY before reaching the provider and is classified as pacing: raise the lane backoff and
  // re-defer the job (still QUEUED) instead of burning it as a terminal FAILED_PRE_SUBMIT. Bounded.
  async function deferForCooldown({ jobId, slot = null, reason = "PROVIDER_COOLDOWN" } = {}) {
    return tx(async (client) => {
      const p = await proj.get(client, ws, jobId);
      if (!p) return { deferred: false, reason: "NOT_FOUND" };
      const attempts = (p.cooldownAttemptCount ?? 0) + 1;
      if (attempts > MAX_COOLDOWN_DEFERRALS) return { deferred: false, exhausted: true, attempts };
      let nextEligibleAt = new Date(now() + baseCooldownMs);
      if (slot && slot.provider && slot.accountRef) {
        const out = await noteSlotOutcome(client, { ...slot, outcome: "COOLDOWN", nowMs: now(), baseCooldownMs });
        if (out && out.next_eligible_at) nextEligibleAt = out.next_eligible_at;
      }
      const jitter = jitterFor(slot ? slotKeyOf(slot) : jobId, baseCooldownMs);
      nextEligibleAt = new Date(new Date(nextEligibleAt).getTime() + jitter);
      await client.query(
        `UPDATE generation_jobs SET next_eligible_at=$3, cooldown_reason=$4, cooldown_attempt_count=$5, updated_at=now()
          WHERE workspace_id=$1 AND id=$2`, [ws, jobId, nextEligibleAt, reason, attempts]);
      // P0 Step 5C.31 - a deferral must also RELEASE the claim, otherwise the job sits in PREPARING behind a
      // dead offer and listStartable (which scans QUEUED) never looks at it again until a restart. Only a
      // provably pre-submit attempt is released: possibly-submitted evidence keeps the attempt owned forever.
      if (p.state === S.PREPARING || p.state === S.READY_TO_SUBMIT) {
        const a = (await client.query(
          `SELECT a.possibly_submitted, a.submission_state, o.id AS offer_id
             FROM generation_jobs g
             LEFT JOIN generation_attempts a ON a.workspace_id=g.workspace_id AND a.id=g.generation_attempt_id
             LEFT JOIN LATERAL (SELECT id FROM job_offers WHERE workspace_id=g.workspace_id AND job_id=g.id AND terminal_at IS NULL ORDER BY created_at DESC LIMIT 1) o ON true
            WHERE g.workspace_id=$1 AND g.id=$2`, [ws, jobId])).rows[0];
        const preSubmit = a && a.possibly_submitted !== true && (!a.submission_state || a.submission_state === "NOT_SUBMITTED") && p.invocationState !== "CONSUMED";
        if (preSubmit) {
          if (a.offer_id) await client.query("UPDATE job_offers SET ownership_status='EXPIRED_PRE_SUBMIT', terminal_at=now() WHERE workspace_id=$1 AND id=$2", [ws, a.offer_id]);
          await client.query("UPDATE generation_attempts SET ownership_status='CREATED', assigned_worker_id=NULL WHERE workspace_id=$1 AND id=(SELECT generation_attempt_id FROM generation_jobs WHERE workspace_id=$1 AND id=$2)", [ws, jobId]);
          await client.query("UPDATE jobs SET status='QUEUED', worker_id=NULL WHERE workspace_id=$1 AND generation_attempt_id=(SELECT generation_attempt_id FROM generation_jobs WHERE workspace_id=$1 AND id=$2)", [ws, jobId]);
          await proj.transition(client, ws, jobId, { from: p.state, to: S.QUEUED });
        }
      }
      await proj.appendEvent(client, ws, jobId, { type: "JOB_DEFERRED_PROVIDER_COOLDOWN", detail: { nextEligibleAt: new Date(nextEligibleAt).toISOString(), attempt: attempts, reason } });
      return { deferred: true, nextEligibleAt, attempts };
    });
  }

  // P0 Step 5C.31 - the pacing decision, made SERVER-side, for any executor. A remote worker reports a raw
  // failure code; the hub (not the worker) decides whether that code is a provider-pacing signal that should
  // re-defer the job, or a real terminal failure. A possibly-submitted attempt never reaches this path.
  async function deferForCooldownIfPacing({ jobId, code, slot = null } = {}) {
    const verdict = classifyRunFailure({ code, invocationConsumed: false, submitted: false, possiblySubmitted: false });
    if (verdict.kind !== "COOLDOWN") return { deferred: false, kind: verdict.kind };
    return deferForCooldown({ jobId, slot, reason: code });
  }

  // A dispatch reached the provider: reset the lane interval to base so a healthy account paces at base speed.
  async function noteSubmitOutcome({ slot, outcome = "SUBMITTED" } = {}) {
    if (!slot || !slot.provider || !slot.accountRef) return null;
    return tx((client) => noteSlotOutcome(client, { ...slot, outcome, nowMs: now(), baseCooldownMs }));
  }

  // Health/ops projection: how many jobs are waiting on pacing and when the earliest lane frees up.
  async function cooldownSnapshot() {
    return tx(async (client) => {
      const w = await client.query(
        `SELECT count(*)::int n, min(next_eligible_at) soonest FROM generation_jobs
          WHERE workspace_id=$1 AND state='QUEUED' AND next_eligible_at IS NOT NULL AND next_eligible_at > to_timestamp($2/1000.0)`, [ws, now()]);
      return {
        baseCooldownMs,
        providerCooldownWaitingCount: Number(w.rows[0].n),
        nearestProviderEligibleAt: w.rows[0].soonest ? new Date(w.rows[0].soonest).toISOString() : null,
        slots: await listSlots(client)
      };
    });
  }

  // ---------------------------------------------------------------- uncertain review (Part A)
  // A SUBMIT_UNCERTAIN job keeps its state FOREVER. A review is recorded ALONGSIDE it. Concurrency: the job row
  // is locked first, so two reviewers serialize and exactly one current revision exists; the previous revision
  // is superseded (kept as history), never deleted. Idempotent: an identical current verdict is a no-op.
  async function reviewUncertain({ jobId, verdict, source, note = null, evidence = null, reviewedByUserId = null } = {}) {
    // 5C.43 - an automated reader of the provider's own surface can tell "the result exists" from "the
    // submission was accepted and is still rendering", and can report that it found several equally good
    // matches. A human reviewer could only say "submitted", so these are additions, not replacements.
    const VERDICTS = ["CONFIRMED_SUBMITTED", "CONFIRMED_SUBMITTED_RESULT_FOUND", "CONFIRMED_SUBMITTED_RESULT_PENDING",
      "CONFIRMED_NOT_SUBMITTED", "AMBIGUOUS_MULTIPLE_MATCHES", "STILL_UNCERTAIN"];
    const SOURCES = ["OWNER_PROVIDER_GUI_INSPECTION", "PROVIDER_API_RECONCILE", "OPERATOR_ASSERTION", "AUTOMATED_RECONCILE", "PROVIDER_SURFACE_RECONCILE"];
    if (!VERDICTS.includes(verdict)) throw cpErr("E_UNCERTAIN_REVIEW_VERDICT", "Unknown verdict");
    if (!SOURCES.includes(source)) throw cpErr("E_UNCERTAIN_REVIEW_SOURCE", "Unknown review source");
    if (note != null && (typeof note !== "string" || note.length > 2000)) throw cpErr("E_UNCERTAIN_REVIEW_NOTE", "Note too long");
    return txReject(async (client) => {
      const locked = await client.query("SELECT id, state, generation_attempt_id FROM generation_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [ws, jobId]);
      const job = locked.rows[0];
      if (!job) return reject("E_GENERATION_JOB_NOT_FOUND", "Job not found");
      if (job.state !== S.SUBMIT_UNCERTAIN) return reject("E_UNCERTAIN_REVIEW_STATE", "Only a SUBMIT_UNCERTAIN job can be reviewed");
      const cur = (await client.query("SELECT id, verdict, review_source, review_revision FROM generation_uncertain_reviews WHERE workspace_id=$1 AND job_id=$2 AND superseded_at IS NULL", [ws, jobId])).rows[0] || null;
      if (cur && cur.verdict === verdict && cur.review_source === source) {
        return { ok: true, idempotent: true, reviewId: cur.id, verdict: cur.verdict, revision: cur.review_revision };
      }
      const revision = cur ? cur.review_revision + 1 : 1;
      if (cur) await client.query("UPDATE generation_uncertain_reviews SET superseded_at=now() WHERE id=$1 AND workspace_id=$2", [cur.id, ws]);
      const id = newId("gurev");
      await client.query(
        `INSERT INTO generation_uncertain_reviews (id, workspace_id, job_id, generation_attempt_id, verdict, review_source, reviewed_by_user_id, review_note, evidence, review_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, ws, jobId, job.generation_attempt_id, verdict, source, reviewedByUserId, note, evidence ? JSON.stringify(evidence) : null, revision]);
      // The job STATE is untouched; only an audit event is appended.
      await proj.appendEvent(client, ws, jobId, { type: "JOB_UNCERTAIN_REVIEWED", detail: { verdict, source, revision } });
      return { ok: true, idempotent: false, reviewId: id, verdict, revision };
    });
  }

  /**
   * P0 Step 5C.43 - record ONE reading of the provider's result surface.
   *
   * Separate from the review verdict on purpose. A reading that concludes nothing is still evidence about
   * where we looked and when, and the old ledger had nowhere to put it - so those readings disappeared and the
   * same job was inspected from scratch every time.
   *
   * Idempotent on WHAT WAS DECIDED rather than on when: replaying the same reading returns the existing row.
   * Insert-only; a later reading writes its own row, because an observation that can be edited afterwards is
   * not evidence.
   */
  async function recordReconciliation({
    jobId, generationAttemptId = null, idempotencyKey, state, reason, confidence = 0,
    inspectedSurface, inspectedAt, submittedAt = null, promptHash,
    matchMethod = null, matchedResultId = null, matchedAssetPath = null, matchedAssetSha256 = null,
    evidence = {},
    // 5C.44 - how far back the reading reached, and where the matched prompt came from. Columns rather than
    // evidence keys because these are read to DECIDE: the database refuses CONFIRMED_NOT_SUBMITTED unless the
    // history brackets the submit click.
    coverage = null, promptEvidenceSource = null
  } = {}) {
    const STATES = ["CONFIRMED_SUBMITTED_RESULT_FOUND", "CONFIRMED_SUBMITTED_RESULT_PENDING",
      "CONFIRMED_NOT_SUBMITTED", "AMBIGUOUS_MULTIPLE_MATCHES", "STILL_UNCERTAIN"];
    if (!STATES.includes(state)) throw cpErr("E_RECONCILE_STATE", "Unknown reconciliation state");
    if (typeof idempotencyKey !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(idempotencyKey)) throw cpErr("E_RECONCILE_KEY", "Bad idempotency key");
    if (typeof promptHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(promptHash)) throw cpErr("E_RECONCILE_PROMPT_HASH", "Bad prompt hash");
    return txReject(async (client) => {
      const job = (await client.query("SELECT id, generation_attempt_id FROM generation_jobs WHERE workspace_id=$1 AND id=$2", [ws, jobId])).rows[0];
      if (!job) return reject("E_GENERATION_JOB_NOT_FOUND", "Job not found");
      const existing = (await client.query(
        "SELECT id, state FROM generation_result_reconciliations WHERE workspace_id=$1 AND idempotency_key=$2", [ws, idempotencyKey])).rows[0];
      if (existing) return { ok: true, idempotent: true, reconciliationId: existing.id, state: existing.state };
      const id = newId("grrec");
      await client.query(
        `INSERT INTO generation_result_reconciliations
           (id, workspace_id, job_id, generation_attempt_id, idempotency_key, state, reason, confidence,
            inspected_surface, inspected_at, submitted_at, prompt_hash, match_method, matched_result_id,
            matched_asset_path, matched_asset_sha256, evidence,
            coverage_earliest_at, coverage_latest_at, coverage_results_read, coverage_results_timed,
            coverage_contains_submit, prompt_evidence_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [id, ws, jobId, generationAttemptId || job.generation_attempt_id, idempotencyKey, state, String(reason || "").slice(0, 64),
          Math.min(1, Math.max(0, Number(confidence) || 0)), String(inspectedSurface || "/imagine").slice(0, 200),
          new Date(inspectedAt || Date.now()).toISOString(), submittedAt ? new Date(submittedAt).toISOString() : null,
          promptHash, matchMethod, matchedResultId, matchedAssetPath, matchedAssetSha256,
          JSON.stringify(evidence || {}),
          coverage && Number.isFinite(coverage.earliestAtMs) ? new Date(coverage.earliestAtMs).toISOString() : null,
          coverage && Number.isFinite(coverage.latestAtMs) ? new Date(coverage.latestAtMs).toISOString() : null,
          coverage ? Number(coverage.resultsRead) || 0 : 0,
          coverage ? Number(coverage.resultsTimed) || 0 : 0,
          coverage ? coverage.containsSubmit === true : false,
          promptEvidenceSource ? String(promptEvidenceSource).slice(0, 120) : null]);
      await proj.appendEvent(client, ws, jobId, { type: "JOB_RESULT_RECONCILED", detail: { state, reason: String(reason || "").slice(0, 64), matched: matchedResultId ? 1 : 0 } });
      return { ok: true, idempotent: false, reconciliationId: id, state };
    });
  }

  async function listReconciliations(jobId = null) {
    return tx(async (client) => {
      const r = await client.query(
        `SELECT id, job_id, state, reason, confidence, inspected_surface, inspected_at, submitted_at,
                match_method, matched_result_id, matched_asset_path, matched_asset_sha256, evidence, created_at,
                coverage_earliest_at, coverage_latest_at, coverage_results_read, coverage_results_timed,
                coverage_contains_submit, prompt_evidence_source
           FROM generation_result_reconciliations
          WHERE workspace_id=$1 AND ($2::text IS NULL OR job_id=$2) ORDER BY created_at DESC LIMIT 200`, [ws, jobId || null]);
      return r.rows.map((x) => ({
        reconciliationId: x.id, jobId: x.job_id, state: x.state, reason: x.reason, confidence: Number(x.confidence),
        inspectedSurface: x.inspected_surface, inspectedAt: x.inspected_at, submittedAt: x.submitted_at,
        matchMethod: x.match_method, matchedResultId: x.matched_result_id, matchedAssetPath: x.matched_asset_path,
        matchedAssetSha256: x.matched_asset_sha256, evidence: x.evidence, createdAt: x.created_at,
        coverage: {
          earliestAt: x.coverage_earliest_at, latestAt: x.coverage_latest_at,
          resultsRead: x.coverage_results_read, resultsTimed: x.coverage_results_timed,
          containsSubmit: x.coverage_contains_submit
        },
        promptEvidenceSource: x.prompt_evidence_source
      }));
    });
  }

  /** Every provider result id this workspace already owns - a job's recorded result, or a reconciliation that
   *  already claimed one. Without this list a card belonging to an old completed job is a perfect match for
   *  any later job that typed the same prompt, which is not hypothetical in this workspace. */
  /**
   * P0 Step 5C.44 - the results we own, WITH the moment we recorded them finishing.
   *
   * The provider's gallery publishes no times. Ours does: most cards on that surface belong to a job in this
   * ledger, and for those the completion time is a fact we wrote down ourselves. Paired with the gallery's
   * newest-first order they become anchors, which is how an absence can be proven against a surface that
   * refuses to say when anything happened.
   */
  async function claimedResults() {
    return tx(async (client) => {
      const r = await client.query(
        `SELECT id, result_id, completed_at, state FROM generation_jobs
          WHERE workspace_id=$1 AND result_id IS NOT NULL AND completed_at IS NOT NULL
          ORDER BY completed_at DESC LIMIT 200`, [ws]);
      return r.rows.map((x) => ({ jobId: x.id, resultId: x.result_id, completedAtMs: new Date(x.completed_at).getTime(), state: x.state }));
    });
  }

  async function claimedResultIds() {
    return tx(async (client) => {
      const a = await client.query("SELECT DISTINCT result_id FROM generation_jobs WHERE workspace_id=$1 AND result_id IS NOT NULL", [ws]);
      const b = await client.query("SELECT DISTINCT matched_result_id FROM generation_result_reconciliations WHERE workspace_id=$1 AND matched_result_id IS NOT NULL", [ws]);
      const out = new Set();
      for (const r of a.rows) out.add(r.result_id);
      for (const r of b.rows) out.add(r.matched_result_id);
      return Array.from(out);
    });
  }

  async function getUncertainReview(jobId) {
    return tx(async (client) => {
      const r = await client.query(
        `SELECT id, job_id, verdict, review_source, reviewed_by_user_id, reviewed_at, review_note, evidence, review_revision
           FROM generation_uncertain_reviews WHERE workspace_id=$1 AND job_id=$2 AND superseded_at IS NULL`, [ws, jobId]);
      const x = r.rows[0];
      return x ? { reviewId: x.id, jobId: x.job_id, verdict: x.verdict, source: x.review_source, reviewedByUserId: x.reviewed_by_user_id, reviewedAt: x.reviewed_at, note: x.review_note, evidence: x.evidence, revision: x.review_revision } : null;
    });
  }

  // Every SUBMIT_UNCERTAIN job with its CURRENT review (if any) — the Activity/Operations review surface.
  async function listUncertain() {
    return tx(async (client) => {
      const r = await client.query(
        `SELECT p.id, p.created_at, p.completed_at, p.error_code, left(p.prompt, 120) AS prompt_preview,
                r.verdict, r.review_source, r.reviewed_at, r.reviewed_by_user_id, r.review_note, r.review_revision
           FROM generation_jobs p
           LEFT JOIN generation_uncertain_reviews r ON r.workspace_id=p.workspace_id AND r.job_id=p.id AND r.superseded_at IS NULL
          WHERE p.workspace_id=$1 AND p.state='SUBMIT_UNCERTAIN' ORDER BY p.created_at DESC`, [ws]);
      return r.rows.map((x) => ({
        jobId: x.id, createdAt: x.created_at, completedAt: x.completed_at, errorCode: x.error_code, promptPreview: x.prompt_preview,
        review: x.verdict ? { verdict: x.verdict, source: x.review_source, reviewedAt: x.reviewed_at, reviewedByUserId: x.reviewed_by_user_id, note: x.review_note, revision: x.review_revision } : null,
        // 5C.43 - an item stays OPEN until the question it was raised for is answered. A pending result
        // answers "was it submitted" and leaves "where is the asset" open, so it is looked at again;
        // several equally good matches answers nothing at all.
        needsReview: !x.verdict || x.verdict === "STILL_UNCERTAIN"
          || x.verdict === "AMBIGUOUS_MULTIPLE_MATCHES" || x.verdict === "CONFIRMED_SUBMITTED_RESULT_PENDING"
      }));
    });
  }

  // ---------------------------------------------------------------- recovery (restart)
  // Classify this worker's non-terminal jobs against the pipeline truth. Post-submit → read-only
  // track. Pre-submit accepted (not consumed) → resume (same worker re-runs). Expired unaccepted
  // offers → expireOfferCore (Case A reoffer / Case B RECOVERING). NEVER a second invocation.
  async function recover() {
    const { workerId: wid } = await ensureBootstrap();
    const plan = await tx(async (client) => {
      const rows = (await client.query(
        `SELECT p.id AS job_id, p.state AS proj_state, p.invocation_state, p.generation_attempt_id,
                p.delivery_mode, p.executed_by_worker_id,
                a.submission_state, a.possibly_submitted, a.terminal_state,
                o.id AS offer_id, o.ownership_status AS offer_status, o.accepted_at, o.offer_expires_at
           FROM generation_jobs p
           LEFT JOIN generation_attempts a ON a.workspace_id=p.workspace_id AND a.id=p.generation_attempt_id
           LEFT JOIN LATERAL (SELECT id, ownership_status, accepted_at, offer_expires_at FROM job_offers
                              WHERE workspace_id=p.workspace_id AND job_id=p.id ORDER BY created_at DESC LIMIT 1) o ON true
          WHERE p.workspace_id=$1`, [ws])).rows;
      const resume = [], track = [], expire = [], remote = [];
      for (const row of rows) {
        if (["COMPLETED", "FAILED_PRE_SUBMIT", "SUBMIT_UNCERTAIN", "CANCELLED_BEFORE_SUBMIT"].includes(row.proj_state)) continue;
        const postSubmit = row.invocation_state === "CONSUMED" || row.possibly_submitted === true ||
          (row.submission_state && row.submission_state !== "NOT_SUBMITTED") || isPostSubmit(row.proj_state);
        // P0 Step 5C.31 - a REMOTE attempt lives on another machine: this process has neither its browser
        // profile nor its provider session, so it must NEVER "recover" it by opening a local surface. It is
        // reported separately and settled by the hub when the worker reconnects (or by lease expiry).
        if (row.delivery_mode === "REMOTE") {
          remote.push({ jobId: row.job_id, generationAttemptId: row.generation_attempt_id, workerId: row.executed_by_worker_id, postSubmit });
          continue;
        }
        if (postSubmit) { track.push({ jobId: row.job_id, generationAttemptId: row.generation_attempt_id }); continue; }
        if (row.offer_id && row.accepted_at) { resume.push({ jobId: row.job_id, generationAttemptId: row.generation_attempt_id, offerId: row.offer_id }); continue; }
        if (row.offer_id && row.offer_status === "OFFERED") { expire.push({ offerId: row.offer_id }); continue; }
      }
      return { resume, track, expire, remote };
    });
    // Expire/reoffer stale unaccepted offers (each in its own txn; expireOfferCore is per-offer safe).
    const reoffered = [];
    for (const e of plan.expire) {
      try { const out = await OWN.handleOfferExpiry(persistence, { workspaceId: ws, offerId: e.offerId, nowMs: now() }); if (out?.reoffered) reoffered.push(e.offerId); }
      catch { /* best-effort; a live offer stays as-is */ }
    }
    return { resume: plan.resume, track: plan.track, remote: plan.remote, reoffered };
  }

  // ---------------------------------------------------------------- legacy import (idempotent)
  // Import a 5C.9D JSON job into the pipeline + projection WITHOUT re-running it. Terminal jobs are
  // imported at their terminal state (evidence), never requeued. Idempotent by create_command_id.
  async function importLegacyJob(legacy) {
    // Resolve the project OUTSIDE the tx (ensureBootstrap opens its own transaction and nesting is
    // rejected). The legacy import can be the FIRST facade call after a restart, so bootstrap may
    // not be primed yet — never read the module-level `bootstrap` directly here.
    const { projectId: pid } = await ensureBootstrap();
    const importKey = `import:${legacy.jobId}`;
    return tx(async (client) => {
      const existing = (await client.query("SELECT id FROM generation_jobs WHERE workspace_id=$1 AND create_command_id=$2", [ws, importKey])).rows[0];
      if (existing) return { jobId: existing.id, imported: false, reason: "already-imported" };
      const createdByUserId = await workspaceOwner(client);
      const prompt = String(legacy.prompt ?? legacy.promptPreview ?? "imported").trim() || "imported";
      const inputSnapshot = { kind: "VIDEO", prompt, durationSeconds: legacy.durationSeconds ?? 6, aspectRatio: legacy.aspectRatio ?? "9:16", outputCount: 1 };
      const gen = await OWN.createGenerationRequestCore(client, {
        workspaceId: ws, projectId: pid, requestIdempotencyKey: newId("req"),
        action, inputSnapshot, quotaRisk: true, createdByUserId
      });
      const legacyState = typeof legacy.state === "string" ? legacy.state : S.COMPLETED;
      await proj.insert(client, ws, {
        jobId: gen.job.id, generationAttemptId: gen.attempt.id, provider: "GROK",
        providerAccountId: /^pa_[0-9A-HJKMNP-TV-Z]{26}$/u.test(legacy.providerAccountId || "") ? legacy.providerAccountId : null,
        accountSelection: legacy.accountSelection === "EXPLICIT" ? "EXPLICIT" : "AUTO",
        prompt, promptHash: legacy.promptHash || promptHashOf(prompt),
        durationSeconds: legacy.durationSeconds ?? 6, aspectRatio: legacy.aspectRatio ?? "9:16",
        invocationScope: "ATTEMPT", source: "IMPORT",
        isCertificationEvidence: legacy.isCertificationEvidence === true, createCommandId: importKey
      });
      // Bring the imported row to its terminal/evidence state without a provider run, using the
      // SAME durable path a real completion takes (submission fact → applyTerminalCore) so the
      // pipeline job/attempt/asset are consistent. Errors are NOT swallowed — a masked error inside
      // a txn aborts it (Postgres) and corrupts everything after.
      if (legacyState === S.COMPLETED) {
        const media = legacy.media && legacy.media.sizeBytes ? { relativePath: `jobs/${gen.job.id}/generated.mp4`, sizeBytes: legacy.media.sizeBytes, container: legacy.media.container || "mp4", durationSeconds: legacy.media.durationSeconds ?? null, width: legacy.media.width ?? null, height: legacy.media.height ?? null } : null;
        // Paid submission fact first (attempt_completed_requires_submitted CHECK requires SUBMITTED
        // before a COMPLETED terminal_state).
        await OWN.applySubmissionFactCore(client, { workspaceId: ws, attemptId: gen.attempt.id, workerId: null, state: "SUBMITTED", confidence: "CONFIRMED" });
        const assetMeta = media ? { relativePath: media.relativePath, fileName: "generated.mp4", mimeType: "video/mp4", sizeBytes: media.sizeBytes, actualDurationSec: media.durationSeconds, width: media.width, height: media.height, checksum: "unverified", storageTier: "LOCAL_ONLY", liveness: "ONLINE" } : null;
        await OWN.applyTerminalCore(client, { workspaceId: ws, jobId: gen.job.id, workerId: null, terminalType: "JOB_COMPLETED", terminalMessageId: newId("msg"), assetMeta });
        await proj.recordInvocation(client, ws, gen.job.id, { invocationState: "CONSUMED", submitAttemptedAt: legacy.submitAttemptedAt || iso(now()) });
        await proj.recordResult(client, ws, gen.job.id, { resultId: legacy.resultId || null, resultAsset: legacy.resultId ? { resultId: legacy.resultId } : null, mediaMeta: media });
        await proj.transition(client, ws, gen.job.id, { from: S.QUEUED, to: S.PREPARING });
        await proj.transition(client, ws, gen.job.id, { from: S.PREPARING, to: S.READY_TO_SUBMIT });
        await proj.transition(client, ws, gen.job.id, { from: S.READY_TO_SUBMIT, to: S.SUBMITTED });
        await proj.transition(client, ws, gen.job.id, { from: S.SUBMITTED, to: S.COMPLETED });
      } else if (["FAILED_PRE_SUBMIT", "SUBMIT_UNCERTAIN", "CANCELLED_BEFORE_SUBMIT"].includes(legacyState)) {
        await proj.transition(client, ws, gen.job.id, { from: S.QUEUED, to: legacyState, patch: { errorCode: legacy.errorCode || null } });
      }
      await proj.appendEvent(client, ws, gen.job.id, { type: "JOB_IMPORTED", detail: { fromState: legacyState } });
      return { jobId: gen.job.id, imported: true };
    });
  }

  // ---------------------------------------------------------------- media capability (digest-only)
  async function issueMediaCapability({ jobId, ttlMs = 120_000 }) {
    return tx(async (client) => {
      const token = randomBytes(32).toString("base64url");
      await proj.issueMediaCapability(client, ws, { jobId, capabilityDigest: digestOf(token), expiresAt: iso(now() + ttlMs) });
      return { token, expiresAt: iso(now() + ttlMs) };
    });
  }
  async function resolveMediaCapability(token) {
    return tx(async (client) => {
      const out = await proj.resolveMediaCapability(client, ws, { capabilityDigest: digestOf(String(token || "")), nowMs: now() });
      return out ? out.jobId : null;
    });
  }

  return Object.freeze({
    ensureBootstrap, workerId, projectId, adoptExecutionWorker,
    enqueue, requestStart, claimNextForWorker, heartbeat, markState,
    markSubmitted, complete, failPreSubmit, submitUncertain, cancel, appendJobEvent,
    listForUi, getForUi, promptFor, events, recover, importLegacyJob,
    listStartable, deferForCooldown, deferForCooldownIfPacing, noteSubmitOutcome, cooldownSnapshot,
    reviewUncertain, getUncertainReview, listUncertain, recordReconciliation, listReconciliations, claimedResultIds, claimedResults,
    issueMediaCapability, resolveMediaCapability,
    _workspaceId: ws
  });
}
