-- P0 Step 5C.2 — 0005 generation_requests, generation_attempts, jobs, job_offers,
-- job_events, job_recovery_reports, job_terminal_results.
--
-- Canonical identity model: one generation_request → one generation_attempt → one job.
-- Request-idempotency uniqueness lives ONLY on generation_requests. Paid-ownership evidence
-- is RESTRICT under project. The full "one paid owner" invariant is transactional (Phase C);
-- these constraints are the DB backstops.

SET search_path = public;

CREATE TABLE generation_requests (
  id                     TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'req')),
  workspace_id           TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id             TEXT COLLATE "C" NOT NULL,
  shot_id                TEXT COLLATE "C" NULL,
  created_by_user_id     TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  action                 TEXT NOT NULL,
  request_idempotency_key TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(request_idempotency_key, 'req')),
  input_snapshot         JSONB NOT NULL,
  quota_risk             BOOLEAN NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- The SOLE request-dedupe key (S4): one click = one request per workspace.
  CONSTRAINT generation_requests_idem_uq UNIQUE (workspace_id, request_idempotency_key),
  CONSTRAINT generation_requests_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT generation_requests_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE generation_attempts (
  id                          TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'attempt')),
  workspace_id                TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  generation_request_id       TEXT COLLATE "C" NOT NULL,
  parent_attempt_id           TEXT COLLATE "C" NULL,
  retry_of_job_id             TEXT COLLATE "C" NULL,          -- FK added after jobs exists
  assigned_worker_id          TEXT COLLATE "C" NULL,
  request_idempotency_key     TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(request_idempotency_key, 'req')),
  attempt_index               INTEGER NOT NULL DEFAULT 0,
  generation_ordinal          INTEGER NOT NULL DEFAULT 0 CHECK (generation_ordinal <= 1 AND generation_ordinal >= 0),
  provider_id                 TEXT NULL,
  provider_account_ref        TEXT NULL,                      -- label, never a secret/FK
  provider_idempotency_mode   TEXT NOT NULL DEFAULT 'NONE' CHECK (provider_idempotency_mode IN ('NONE','NATIVE','DERIVED')),
  provider_idempotency_key_ref TEXT NULL,
  provider_submission_id      TEXT NULL,
  submission_state            TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submission_state IN ('NOT_SUBMITTED','SUBMITTING','SUBMITTED')),
  submission_confidence       TEXT NOT NULL DEFAULT 'NONE' CHECK (submission_confidence IN ('NONE','UNKNOWN','PRESUMED','CONFIRMED')),
  ownership_status            TEXT NOT NULL DEFAULT 'CREATED' CHECK (ownership_status IN (
                                'CREATED','OFFER_PENDING','OFFERED','ACCEPTED','RUNNING','SUBMITTING',
                                'POSSIBLY_SUBMITTED','SUBMITTED','RECOVERING','RESULT_AVAILABLE','IMPORTED',
                                'TERMINAL_PENDING_ACK','COMPLETED','FAILED','CANCELED','MANUAL_ACTION_REQUIRED','EXPIRED_PRE_SUBMIT')),
  possibly_submitted          BOOLEAN NOT NULL DEFAULT false,
  reconcile_epoch             INTEGER NOT NULL DEFAULT 0,
  submitted_at                timestamptz NULL,
  terminal_state              TEXT NULL CHECK (terminal_state IS NULL OR terminal_state IN ('COMPLETED','FAILED','CANCELED')),
  revision                    INTEGER NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  -- cross-column defense-in-depth (S7): no illegal combo is storable.
  CONSTRAINT attempt_ordinal_requires_submit CHECK (generation_ordinal = 0 OR submission_state IN ('SUBMITTING','SUBMITTED')),
  CONSTRAINT attempt_paidrisk_gauge CHECK (submission_state = 'NOT_SUBMITTED' OR possibly_submitted),
  CONSTRAINT attempt_completed_requires_submitted CHECK (terminal_state IS DISTINCT FROM 'COMPLETED' OR submission_state = 'SUBMITTED'),
  CONSTRAINT generation_attempts_request_fk FOREIGN KEY (workspace_id, generation_request_id)
    REFERENCES generation_requests (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT generation_attempts_parent_fk FOREIGN KEY (workspace_id, parent_attempt_id)
    REFERENCES generation_attempts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT generation_attempts_worker_fk FOREIGN KEY (workspace_id, assigned_worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT generation_attempts_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE jobs (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'job')),
  workspace_id          TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id             TEXT COLLATE "C" NULL,
  project_id            TEXT COLLATE "C" NULL,
  episode_id            TEXT COLLATE "C" NULL,
  shot_id               TEXT COLLATE "C" NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  created_by_user_id    TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  type                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
                          'QUEUED','DISPATCHED','ACCEPTED','RUNNING','NEEDS_MANUAL_ACTION','SUCCEEDED',
                          'FAILED','CANCEL_REQUESTED','CANCELED','INTERRUPTED','EXPIRED')),
  request_idempotency_key TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(request_idempotency_key, 'req')),
  input                 JSONB NOT NULL,
  progress              JSONB NULL,
  result                JSONB NULL,
  error_code            TEXT NULL,
  error_message         TEXT NULL,
  quota_risk            BOOLEAN NOT NULL DEFAULT false,
  cancel_requested      BOOLEAN NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  dispatched_at         timestamptz NULL,
  accepted_at           timestamptz NULL,
  started_at            timestamptz NULL,
  finished_at           timestamptz NULL,
  canceled_at           timestamptz NULL,
  offer_expires_at      timestamptz NULL,
  execution_deadline_at timestamptz NULL,
  -- one job per attempt (S4). generation_attempt_id is nullable (non-generation actions),
  -- but when present it is unique across jobs.
  CONSTRAINT jobs_one_per_attempt_uq UNIQUE (generation_attempt_id),
  CONSTRAINT jobs_attempt_fk FOREIGN KEY (workspace_id, generation_attempt_id)
    REFERENCES generation_attempts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT jobs_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT jobs_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT jobs_ws_id_uq UNIQUE (workspace_id, id)
);

-- Break the attempt↔job cycle: add retry_of_job_id FK now that jobs exists.
ALTER TABLE generation_attempts
  ADD CONSTRAINT generation_attempts_retry_job_fk FOREIGN KEY (workspace_id, retry_of_job_id)
  REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT;

CREATE TABLE job_offers (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'off')),
  workspace_id          TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  job_id                TEXT COLLATE "C" NOT NULL,
  generation_attempt_id TEXT COLLATE "C" NOT NULL,
  assigned_worker_id    TEXT COLLATE "C" NOT NULL,
  project_id            TEXT COLLATE "C" NULL,
  offer_message_id      TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(offer_message_id, 'msg')),
  offer_version         INTEGER NOT NULL DEFAULT 1,
  offered_at            timestamptz NOT NULL DEFAULT now(),
  accepted_at           timestamptz NULL,
  offer_expires_at      timestamptz NOT NULL,
  execution_deadline_at timestamptz NULL,
  lease_expires_at      timestamptz NOT NULL,
  last_worker_event_at  timestamptz NULL,
  ownership_status      TEXT NOT NULL CHECK (ownership_status IN (
                          'CREATED','OFFER_PENDING','OFFERED','ACCEPTED','RUNNING','SUBMITTING',
                          'POSSIBLY_SUBMITTED','SUBMITTED','RECOVERING','RESULT_AVAILABLE','IMPORTED',
                          'TERMINAL_PENDING_ACK','COMPLETED','FAILED','CANCELED','MANUAL_ACTION_REQUIRED',
                          'EXPIRED_PRE_SUBMIT','OFFER_REJECTED')),
  reconcile_required    BOOLEAN NOT NULL DEFAULT false,
  possibly_submitted    BOOLEAN NOT NULL DEFAULT false,
  terminal_at           timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_offers_attempt_fk FOREIGN KEY (workspace_id, generation_attempt_id)
    REFERENCES generation_attempts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT job_offers_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT job_offers_worker_fk FOREIGN KEY (workspace_id, assigned_worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);
-- One LIVE offer per attempt (S3): excludes ONLY the provably-not-submitted outcomes, so a
-- settled/paid attempt keeps its slot and can never gain a second live offer.
CREATE UNIQUE INDEX job_offers_one_live_uq ON job_offers (generation_attempt_id)
  WHERE ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED');

CREATE TABLE job_events (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'evt')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  job_id       TEXT COLLATE "C" NOT NULL,
  worker_id    TEXT COLLATE "C" NULL,
  sequence     INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload      JSONB NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_events_seq_uq UNIQUE (job_id, sequence),
  CONSTRAINT job_events_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE job_recovery_reports (
  id                       TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'jrr')),
  workspace_id             TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  job_id                   TEXT COLLATE "C" NOT NULL,
  worker_id                TEXT COLLATE "C" NULL,
  original_message_id      TEXT COLLATE "C" NOT NULL,
  local_state              TEXT NULL,
  submitted_to_provider    BOOLEAN NULL,
  result                   JSONB NULL,
  applied_at               timestamptz NULL,
  created_second_generation BOOLEAN NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_recovery_reports_uq UNIQUE (job_id, original_message_id),
  CONSTRAINT job_recovery_reports_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE job_terminal_results (
  job_id             TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(job_id, 'job')),
  workspace_id       TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  terminal_type      TEXT NOT NULL CHECK (terminal_type IN ('JOB_COMPLETED','JOB_FAILED','JOB_CANCELED')),
  terminal_message_id TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(terminal_message_id, 'msg')),
  result             JSONB NULL,
  error_code         TEXT NULL,
  applied_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_terminal_results_msg_uq UNIQUE (terminal_message_id),
  CONSTRAINT job_terminal_results_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER generation_attempts_touch BEFORE UPDATE ON generation_attempts FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
CREATE TRIGGER job_offers_touch BEFORE UPDATE ON job_offers FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
