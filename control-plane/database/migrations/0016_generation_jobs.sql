-- P0 Step 5C.9E — 0016 durable generation job store (control-plane source of truth).
--
-- WHY A NEW MIGRATION (0001–0015 frozen): P0 Step 5C.9D shipped a usable local Grok video
-- generation MVP whose authoritative job state lived in Worker-local JSON files. 5C.9E moves
-- that authoritative state into PostgreSQL so many jobs, many READY Grok accounts, and (later)
-- many registered Workers can share one durable, transactional, restart-safe source of truth
-- with per-profile leasing. The existing paid-generation ownership tables (generation_requests /
-- generation_attempts / jobs / job_offers, 0005) model the broader remote-worker offer pipeline
-- and are UNCHANGED and frozen. generation_jobs is the Worker-driven Grok generation queue; it
-- references the SAME generationAttemptId as the C1 invocation guard for exact correlation, but
-- never duplicates the frozen ownership rows.
--
-- SAFETY: no provider credentials, cookies, proxy secrets, signed media URLs, absolute filesystem
-- paths, or prompt text beyond the stored prompt column are ever placed here; the API/repository
-- layer validates and rejects those before persistence. media_meta / affinity are SAFE knob bags
-- (relative media path + sizes + sanitized account/tunnel reference ids only). Workspace-scoped
-- with RLS FORCE like every collaborative table (0010). Media capabilities are short-lived,
-- job-bound, and store only a digest (never the plaintext capability).

SET search_path = public;

CREATE TABLE generation_jobs (
  workspace_id            TEXT COLLATE "C" NOT NULL,
  id                      TEXT COLLATE "C" NOT NULL,          -- job_<ULID>
  generation_attempt_id   TEXT COLLATE "C" NULL,              -- attempt_<ULID> (bound at gate)
  provider                TEXT NOT NULL DEFAULT 'GROK' CHECK (provider = 'GROK'),
  provider_account_id     TEXT COLLATE "C" NULL,              -- pa_<ULID>; null => AUTO selection
  account_selection       TEXT NOT NULL DEFAULT 'AUTO' CHECK (account_selection IN ('AUTO','EXPLICIT')),
  affinity                JSONB NULL,                         -- {profileRef?, tunnelRef?, label?} sanitized ids only
  assigned_worker_id      TEXT COLLATE "C" NULL,
  prompt                  TEXT NOT NULL,
  prompt_hash             TEXT NOT NULL,
  mode                    TEXT NOT NULL DEFAULT 'VIDEO' CHECK (mode = 'VIDEO'),
  duration_seconds        INTEGER NOT NULL DEFAULT 6 CHECK (duration_seconds BETWEEN 1 AND 30),
  aspect_ratio            TEXT NOT NULL DEFAULT '9:16',
  invocation_scope        TEXT NOT NULL DEFAULT 'ATTEMPT' CHECK (invocation_scope = 'ATTEMPT'),
  state                   TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
                            'QUEUED','WAITING_FOR_ACCOUNT','PREPARING','READY_TO_SUBMIT','SUBMITTED',
                            'PROCESSING','COMPLETED','FAILED_PRE_SUBMIT','SUBMIT_UNCERTAIN',
                            'WAITING_FOR_MANUAL_ACTION','CANCELLED_BEFORE_SUBMIT')),
  start_requested         BOOLEAN NOT NULL DEFAULT FALSE,
  priority                INTEGER NOT NULL DEFAULT 100,
  lease_owner             TEXT COLLATE "C" NULL,              -- worker runtime session id holding the lease
  lease_expires_at        timestamptz NULL,
  invocation_state        TEXT NULL CHECK (invocation_state IS NULL OR invocation_state IN ('RESERVED','CONSUMED')),
  submit_attempted_at     timestamptz NULL,
  result_id               TEXT NULL,
  result_asset            JSONB NULL,                         -- {resultId, host?, durationSeconds?, width?, height?}
  media_meta              JSONB NULL,                         -- {relativePath, sizeBytes, container, durationSeconds?, width?, height?}
  manual_action           TEXT NULL,
  error_code              TEXT NULL,
  error_reason            TEXT NULL,
  source                  TEXT NOT NULL DEFAULT 'UI' CHECK (source IN ('UI','IMPORT')),
  is_certification_evidence BOOLEAN NOT NULL DEFAULT FALSE,
  create_command_id       TEXT COLLATE "C" NULL,              -- idempotency of the create command
  start_command_id        TEXT COLLATE "C" NULL,              -- idempotency of the start command
  revision                BIGINT NOT NULL DEFAULT 1,          -- optimistic concurrency
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz NULL,
  CONSTRAINT generation_jobs_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT generation_jobs_terminal_completed_at CHECK (
    (state IN ('COMPLETED','FAILED_PRE_SUBMIT','SUBMIT_UNCERTAIN','CANCELLED_BEFORE_SUBMIT')) = (completed_at IS NOT NULL)),
  -- one job per generationAttemptId (exactly-once correlation) when an attempt is bound
  CONSTRAINT generation_jobs_attempt_uq UNIQUE (workspace_id, generation_attempt_id),
  CONSTRAINT generation_jobs_create_cmd_uq UNIQUE (workspace_id, create_command_id)
);

-- Scheduler hot path: eligible queued/startable jobs, and lease reclaim.
CREATE INDEX generation_jobs_schedulable_idx ON generation_jobs (workspace_id, state, priority, created_at)
  WHERE state IN ('QUEUED','WAITING_FOR_ACCOUNT');
CREATE INDEX generation_jobs_lease_idx ON generation_jobs (workspace_id, lease_expires_at)
  WHERE lease_owner IS NOT NULL;
CREATE INDEX generation_jobs_account_active_idx ON generation_jobs (workspace_id, provider_account_id)
  WHERE state IN ('PREPARING','READY_TO_SUBMIT','SUBMITTED','PROCESSING');

-- Append-only, ordered safe event log (redacted; no prompt/secret/URL/path).
CREATE TABLE generation_job_events (
  workspace_id  TEXT COLLATE "C" NOT NULL,
  job_id        TEXT COLLATE "C" NOT NULL,
  seq           BIGINT NOT NULL,                              -- per-job monotonic ordinal
  type          TEXT NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  detail        JSONB NULL,
  CONSTRAINT generation_job_events_pk PRIMARY KEY (workspace_id, job_id, seq),
  CONSTRAINT generation_job_events_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES generation_jobs (workspace_id, id) ON DELETE CASCADE
);

-- Short-lived, job-bound media capability. Only a digest is stored (never the plaintext).
CREATE TABLE generation_media_capabilities (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  capability_digest TEXT COLLATE "C" NOT NULL,
  job_id           TEXT COLLATE "C" NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_media_capabilities_pk PRIMARY KEY (workspace_id, capability_digest),
  CONSTRAINT generation_media_capabilities_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES generation_jobs (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX generation_media_capabilities_job_idx ON generation_media_capabilities (workspace_id, job_id);

-- RLS FORCE + tenant policies (identical predicate to every collaborative table, 0010).
DO $rls$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['generation_jobs','generation_job_events','generation_media_capabilities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$I_select ON %1$I FOR SELECT
      USING (workspace_id = current_setting('app.current_workspace', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_insert ON %1$I FOR INSERT
      WITH CHECK (workspace_id = current_setting('app.current_workspace', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_update ON %1$I FOR UPDATE
      USING (workspace_id = current_setting('app.current_workspace', true))
      WITH CHECK (workspace_id = current_setting('app.current_workspace', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_delete ON %1$I FOR DELETE
      USING (workspace_id = current_setting('app.current_workspace', true))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO cp_tenant_app', t);
  END LOOP;
END
$rls$;
