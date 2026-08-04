-- P0 Step 5C.34 — STORY QUALITY REPAIR (ADDITIVE, forward-only).
--
-- A story whose prose exists, is complete and is 2932 words long was being marked FAILED_GENERATION —
-- the state that means "the model failed to produce anything". It had produced everything; a quality
-- gate had declined it. Conflating those two is what made the failure unrecoverable: a generation
-- failure invites regeneration, which would have thrown away good prose and spent quota to reproduce it.
--
-- This migration adds the state that was missing and the ledger a repair needs:
--
--   QUALITY_REPAIR_REQUIRED  — output exists and is usable; a quality gate wants a targeted fix. It is
--                              NOT a generation failure and NOT a rejection.
--   story_quality_repairs    — one row per repair attempt, bounded and idempotent. The ORIGINAL text
--                              version is never mutated: a repair writes a NEW version and records which
--                              version it came from, so the draft the model actually produced stays on
--                              record forever.
--
-- Workspace remains the sole RLS boundary.

SET search_path = public;

-- ============================ (1) the missing status ============================
-- Rebuild the CHECK additively: every previously-legal value stays legal.
ALTER TABLE story_projects DROP CONSTRAINT IF EXISTS story_projects_status_check;
ALTER TABLE story_projects ADD CONSTRAINT story_projects_status_check CHECK (status IN (
  'DRAFT','DNA_GENERATING','DNA_VALIDATING','WRITING','EDITING','VALIDATING','READY',
  'FAILED_PRE_GENERATION','FAILED_GENERATION','FAILED_VALIDATION','NEEDS_REVIEW','ARCHIVED',
  'QUALITY_REPAIR_REQUIRED'));

-- How many targeted repairs this project has consumed. Bounded server-side so a repair loop cannot
-- burn provider budget indefinitely.
ALTER TABLE story_projects ADD COLUMN IF NOT EXISTS quality_repair_count INTEGER NOT NULL DEFAULT 0
  CHECK (quality_repair_count >= 0 AND quality_repair_count <= 10);
-- The most recent quality verdict, kept alongside the project for the UI + ops (never a substitute for
-- the durable report below).
ALTER TABLE story_projects ADD COLUMN IF NOT EXISTS quality_verdict JSONB NULL
  CHECK (quality_verdict IS NULL OR pg_column_size(quality_verdict) <= 16384);

-- ============================ (2) the repair ledger ============================
CREATE TABLE IF NOT EXISTS story_quality_repairs (
  id                  TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'sqr')),
  workspace_id        TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  story_project_id    TEXT COLLATE "C" NOT NULL,
  attempt             INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= 10),
  -- the version the repair started FROM (immutable) and the version it produced (null until it lands)
  source_text_id      TEXT COLLATE "C" NOT NULL,
  result_text_id      TEXT COLLATE "C" NULL,
  trigger_code        TEXT NOT NULL CHECK (trigger_code ~ '^E_[A-Z0-9_]{2,60}$'),
  band                TEXT NOT NULL CHECK (band IN ('SOFT_REPAIR','HARD_REPAIR_OR_REVIEW','BELOW_MIN','TRUNCATED','PASS')),
  -- what the detector said, before and after: score/spans/classes/confidence/explanation
  verdict_before      JSONB NULL CHECK (verdict_before IS NULL OR pg_column_size(verdict_before) <= 32768),
  verdict_after       JSONB NULL CHECK (verdict_after IS NULL OR pg_column_size(verdict_after) <= 32768),
  -- how the attempt was resolved. RE_EVALUATED = the corrected detector passed the EXISTING text with no
  -- provider call at all; that is the cheapest and most honest outcome and must be distinguishable from
  -- a rewrite, so an audit can tell which stories were edited and which were merely re-judged.
  outcome             TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (outcome IN ('PENDING','RE_EVALUATED','REPAIRED','STILL_FAILING','EXHAUSTED','ERROR')),
  provider_calls      INTEGER NOT NULL DEFAULT 0 CHECK (provider_calls >= 0 AND provider_calls <= 8),
  error_code          TEXT NULL CHECK (error_code IS NULL OR error_code ~ '^E_[A-Z0-9_]{2,60}$'),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz NULL,
  CONSTRAINT story_quality_repairs_project_fk FOREIGN KEY (workspace_id, story_project_id)
    REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE,
  -- One row per (project, attempt): the concurrency primitive. Two callers racing a repair both try to
  -- insert the same attempt number and exactly one wins, so a repair can never run twice in parallel.
  CONSTRAINT story_quality_repairs_attempt_uq UNIQUE (workspace_id, story_project_id, attempt)
);
CREATE INDEX IF NOT EXISTS story_quality_repairs_project_idx
  ON story_quality_repairs (workspace_id, story_project_id, attempt DESC);

ALTER TABLE story_quality_repairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_quality_repairs FORCE ROW LEVEL SECURITY;
CREATE POLICY story_quality_repairs_select ON story_quality_repairs FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY story_quality_repairs_insert ON story_quality_repairs FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY story_quality_repairs_update ON story_quality_repairs FOR UPDATE
  USING (workspace_id = current_setting('app.current_workspace', true))
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON story_quality_repairs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON story_quality_repairs TO cp_tenant_app;
GRANT SELECT ON story_quality_repairs TO cp_ops_enumerator;
