-- P0 Step 5C.9E — 0017 make generation_jobs a strict 1:1 EXTENSION of the authoritative
-- ownership pipeline (architecture correction).
--
-- 0016 created generation_jobs with its own scheduler/lease/dispatch columns
-- (lease_owner, lease_expires_at, priority, start_requested, assigned_worker_id). That
-- duplicated the role of the frozen ownership pipeline — generation_requests /
-- generation_attempts / jobs / job_offers (0005), claimGenerationAttemptForWorker, and the
-- job_offers lease — which MUST remain the single source of truth for request/attempt/
-- dispatch/Worker-lease. This migration corrects that WITHOUT rolling back the applied 0016:
--   (1) FK-link generation_jobs 1:1 to jobs(id) and to generation_attempts(id), so the
--       extension row is the SAME job/attempt as the ownership pipeline (no second identity);
--   (2) drop the wrong-role scheduling/lease/dispatch columns and their indexes — scheduling
--       and leasing now come ONLY from the ownership pipeline / job_offers.
-- generation_jobs is kept ONLY for Grok-specific lifecycle granularity (the fine-grained
-- state machine), the selected Grok account, invocation/submit correlation, result/media
-- metadata, and generation-layer idempotency. Migrations 0001-0015 remain frozen; 0016 is
-- not modified or rolled back.

SET search_path = public;

-- Drop indexes that reference the wrong-role columns first (explicit, no surprise cascades).
DROP INDEX IF EXISTS generation_jobs_schedulable_idx;   -- referenced priority (pipeline schedules)
DROP INDEX IF EXISTS generation_jobs_lease_idx;         -- referenced lease_owner (job_offers leases)

ALTER TABLE generation_jobs
  DROP COLUMN IF EXISTS lease_owner,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS start_requested,
  DROP COLUMN IF EXISTS assigned_worker_id;

-- 1:1 extension links to the authoritative ownership rows. Both are set when the extension
-- row is created from a control-plane createGeneration (job + attempt already exist), so the
-- FKs are always satisfiable; ON DELETE CASCADE keeps the extension tied to its job's life.
ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_job_fk FOREIGN KEY (workspace_id, id)
    REFERENCES jobs (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT generation_jobs_attempt_link_fk FOREIGN KEY (workspace_id, generation_attempt_id)
    REFERENCES generation_attempts (workspace_id, id) ON DELETE RESTRICT;

-- UI listing still benefits from a per-account active-state index (not a scheduler index).
-- generation_jobs_account_active_idx (from 0016) is retained.

COMMENT ON TABLE generation_jobs IS
  '1:1 Grok-generation extension of jobs/generation_attempts (0005). Scheduling + Worker lease live ONLY in the ownership pipeline (job_offers). Holds fine-grained Grok lifecycle, selected account, invocation/submit correlation, result/media metadata, generation-layer idempotency.';
