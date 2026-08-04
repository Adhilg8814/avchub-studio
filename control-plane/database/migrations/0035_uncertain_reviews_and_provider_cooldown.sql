-- P0 Step 5C.30 — operational hardening (ADDITIVE, forward-only). Two independent concerns:
--
-- (A) CERTIFIED UNCERTAIN REVIEW. A SUBMIT_UNCERTAIN job is a permanent, honest historical record: its state
--     is NEVER rewritten to make an operational dashboard green. Instead a REVIEW is recorded ALONGSIDE it
--     (who reviewed, when, what verdict, what evidence). Health then distinguishes "historically uncertain"
--     (a fact) from "uncertain and STILL needing review" (an action item). CONFIRMED_* verdicts clear the
--     action item; STILL_UNCERTAIN keeps it. The job row, its events and the invocation ledger are untouched.
--
-- (B) DURABLE PROVIDER SUBMISSION COOLDOWN. Grok Imagine refuses PRE-SUBMIT when generations are fired back
--     to back. The fix is a durable, server-side reservation slot per (provider, account, profile): a job may
--     only be dispatched when the slot is eligible, otherwise it is DEFERRED with a next-eligible time. The
--     wait costs nothing — no worker lease, no browser, no PostgreSQL transaction, no invocation guard — and
--     survives a restart because the slot lives in the database, not in a timer.
--
-- Workspace remains the SOLE RLS boundary. generation_uncertain_reviews is workspace-scoped + FORCE RLS like
-- every other tenant table. provider_submission_slots is a PHYSICAL-RESOURCE table (a real provider account /
-- Cloak profile is dedicated to exactly one customer by the Phase 7 registry, and a slot holds only timing —
-- no tenant identifiers, no prompt, no secret), so it is non-RLS like the platform plane, and is keyed
-- globally so two workspaces can never share one physical account's pacing.

SET search_path = public;

-- ============================ (A) uncertain review ============================
CREATE TABLE IF NOT EXISTS generation_uncertain_reviews (
  id                 TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'gurev')),
  workspace_id       TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  job_id             TEXT COLLATE "C" NOT NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  verdict            TEXT NOT NULL CHECK (verdict IN ('CONFIRMED_SUBMITTED','CONFIRMED_NOT_SUBMITTED','STILL_UNCERTAIN')),
  review_source      TEXT NOT NULL CHECK (review_source IN ('OWNER_PROVIDER_GUI_INSPECTION','PROVIDER_API_RECONCILE','OPERATOR_ASSERTION','AUTOMATED_RECONCILE')),
  reviewed_by_user_id TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        timestamptz NOT NULL DEFAULT now(),
  review_note        TEXT NULL CHECK (review_note IS NULL OR length(review_note) <= 2000),
  -- Safe, non-secret evidence only (what was inspected, when, how). Never a token/cookie/credential/prompt.
  evidence           JSONB NULL CHECK (evidence IS NULL OR pg_column_size(evidence) <= 8192),
  review_revision    INTEGER NOT NULL DEFAULT 1,
  superseded_at      timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_uncertain_reviews_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES generation_jobs (workspace_id, id) ON DELETE CASCADE
);
-- Exactly ONE current (non-superseded) review per job: concurrent reviewers serialize and only one revision
-- is current; earlier revisions stay as history (superseded_at set) so the review trail is never lost.
CREATE UNIQUE INDEX IF NOT EXISTS generation_uncertain_reviews_current_uq
  ON generation_uncertain_reviews (workspace_id, job_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS generation_uncertain_reviews_job_idx
  ON generation_uncertain_reviews (workspace_id, job_id, review_revision DESC);

ALTER TABLE generation_uncertain_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_uncertain_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY generation_uncertain_reviews_select ON generation_uncertain_reviews FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY generation_uncertain_reviews_insert ON generation_uncertain_reviews FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY generation_uncertain_reviews_update ON generation_uncertain_reviews FOR UPDATE
  USING (workspace_id = current_setting('app.current_workspace', true))
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON generation_uncertain_reviews FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON generation_uncertain_reviews TO cp_tenant_app;
GRANT SELECT ON generation_uncertain_reviews TO cp_ops_enumerator;

-- ============================ (B) provider submission cooldown ============================
-- One row per PHYSICAL submission lane. account_ref/profile_ref are opaque non-secret refs (pa_* / profile
-- directory id); no tenant id, no credential, no prompt is stored here.
CREATE TABLE IF NOT EXISTS provider_submission_slots (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'pslot')),
  provider              TEXT NOT NULL,
  account_ref           TEXT NOT NULL,
  profile_ref           TEXT NOT NULL DEFAULT '-',
  -- the scheduler's single source of truth; always UTC, always server-side
  next_eligible_at      timestamptz NOT NULL DEFAULT now(),
  last_reserved_at      timestamptz NULL,
  last_outcome          TEXT NULL CHECK (last_outcome IS NULL OR last_outcome IN ('SUBMITTED','COOLDOWN','FAILED','RESET')),
  -- adaptive backoff: base interval, raised (capped) on a real provider cooldown signal, reset after success
  cooldown_ms           INTEGER NOT NULL DEFAULT 120000 CHECK (cooldown_ms >= 0 AND cooldown_ms <= 3600000),
  consecutive_cooldowns INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_cooldowns >= 0),
  reservation_count     BIGINT NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_submission_slots_key_uq UNIQUE (provider, account_ref, profile_ref)
);
CREATE INDEX IF NOT EXISTS provider_submission_slots_eligible_idx ON provider_submission_slots (next_eligible_at);

DROP TRIGGER IF EXISTS provider_submission_slots_touch ON provider_submission_slots;
CREATE TRIGGER provider_submission_slots_touch BEFORE UPDATE ON provider_submission_slots
  FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();

REVOKE ALL ON provider_submission_slots FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON provider_submission_slots TO cp_tenant_app;
GRANT SELECT ON provider_submission_slots TO cp_ops_enumerator;

-- Additive scheduling metadata on the generation projection. The job STATE MACHINE is unchanged: a deferred
-- job simply stays QUEUED with a next-eligible time, so it is neither a failure nor a stall.
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS start_intent_at        timestamptz NULL;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS next_eligible_at       timestamptz NULL;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS cooldown_reason        TEXT NULL;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS cooldown_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider_slot_ref      TEXT NULL;
-- Dispatch scan: "QUEUED jobs whose turn has come", FIFO by creation.
CREATE INDEX IF NOT EXISTS generation_jobs_startable_idx
  ON generation_jobs (workspace_id, next_eligible_at, created_at) WHERE state = 'QUEUED';
