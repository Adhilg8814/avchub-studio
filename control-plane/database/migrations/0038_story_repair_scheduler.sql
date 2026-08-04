-- P0 Step 5C.35 — AUTONOMOUS STORY QUALITY REPAIR (ADDITIVE, forward-only).
--
-- 5C.34 made a story that needs repair say so, and gave the repair a bounded, certified implementation.
-- It still needed a human to press the button. This migration adds the durable state a scheduler needs to
-- press it instead — and nothing else. The repair LOGIC is unchanged; what is new is the record of which
-- stories are waiting, who is working on one right now, and when a paced provider lane frees up.
--
-- Three additions:
--
--   two statuses           QUALITY_REPAIRING and WAITING_REPAIR_COOLDOWN. A story being worked on and a
--                          story waiting for a provider lane are DIFFERENT states, and neither is a
--                          failure. Making them real statuses (rather than a flag on the side) means the
--                          UI, the health snapshot and any future reader all see the same truth.
--
--   story_repair_schedule  one row per story: the durable eligible record, the lease, and the pacing
--                          deadline. A row is the ONLY thing that authorises work on that story, so a
--                          restart, a second scheduler, or a duplicated invocation cannot produce two
--                          repairs — the claim is a single conditional UPDATE and only one caller can see
--                          a row change.
--
--   lease/evidence columns on story_quality_repairs so an interrupted attempt can be judged rather than
--                          blindly retried: if the provider call was already SUBMITTED, the attempt is
--                          resolved from that evidence and never re-sent.
--
-- Workspace remains the sole RLS boundary. Nothing here touches an existing row's meaning.

SET search_path = public;

-- ============================ (1) the two working statuses ============================
ALTER TABLE story_projects DROP CONSTRAINT IF EXISTS story_projects_status_check;
ALTER TABLE story_projects ADD CONSTRAINT story_projects_status_check CHECK (status IN (
  'DRAFT','DNA_GENERATING','DNA_VALIDATING','WRITING','EDITING','VALIDATING','READY',
  'FAILED_PRE_GENERATION','FAILED_GENERATION','FAILED_VALIDATION','NEEDS_REVIEW','ARCHIVED',
  'QUALITY_REPAIR_REQUIRED','QUALITY_REPAIRING','WAITING_REPAIR_COOLDOWN'));

-- When the paced provider lane frees up, for the UI's ETA. Advisory only — the authority is the schedule
-- row's next_eligible_at and the provider slot itself.
ALTER TABLE story_projects ADD COLUMN IF NOT EXISTS repair_next_eligible_at timestamptz NULL;

-- ============================ (2) the durable schedule ============================
CREATE TABLE IF NOT EXISTS story_repair_schedule (
  id                  TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'srs')),
  workspace_id        TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  story_project_id    TEXT COLLATE "C" NOT NULL,

  -- ELIGIBLE        waiting to be picked up
  -- LEASED          a scheduler owns it right now (lease_expires_at is when that claim goes stale)
  -- WAITING_COOLDOWN the provider lane is paced; next_eligible_at says when to look again
  -- DONE            the story reached READY
  -- MANUAL_REVIEW   attempts exhausted, or evidence says a provider call may have been sent
  -- BLOCKED         not auto-repairable (tenant suspended, no usable draft, unsupported category)
  state               TEXT NOT NULL DEFAULT 'ELIGIBLE'
                      CHECK (state IN ('ELIGIBLE','LEASED','WAITING_COOLDOWN','DONE','MANUAL_REVIEW','BLOCKED')),

  attempt             INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 10),
  -- The text version the CURRENT attempt started from. Together with the attempt number this is what makes
  -- the idempotency key mean something: same story, same draft, same attempt = the same unit of work.
  source_revision     INTEGER NULL,
  -- sha256(story_project_id | source_revision | attempt). UNIQUE per workspace, so a duplicated invocation
  -- — a retried callback, a second scheduler, a restart mid-flight — cannot start the same work twice.
  idempotency_key     TEXT COLLATE "C" NULL CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$'),

  lease_owner         TEXT COLLATE "C" NULL CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 4 AND 80),
  lease_expires_at    timestamptz NULL,
  heartbeat_at        timestamptz NULL,

  -- Pacing. A deferred story holds NO lease, NO browser, NO account lock and NO open transaction: the wait
  -- lives in this column, which is why a restart resumes it for free and why waiting is not a failure.
  next_eligible_at    timestamptz NOT NULL DEFAULT now(),
  deferrals           INTEGER NOT NULL DEFAULT 0 CHECK (deferrals >= 0 AND deferrals <= 200),

  last_error          TEXT NULL CHECK (last_error IS NULL OR last_error ~ '^E_[A-Z0-9_]{2,60}$'),
  last_action         TEXT NULL CHECK (last_action IS NULL OR length(last_action) <= 40),
  enqueued_at         timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT story_repair_schedule_project_fk FOREIGN KEY (workspace_id, story_project_id)
    REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE,
  -- One schedule row per story: the durable eligible record cannot be duplicated.
  CONSTRAINT story_repair_schedule_project_uq UNIQUE (workspace_id, story_project_id),
  -- One unit of work per (story, draft revision, attempt), across every scheduler and every restart.
  CONSTRAINT story_repair_schedule_idem_uq UNIQUE (workspace_id, idempotency_key)
);
-- The scheduler's only hot query: "what is eligible now, oldest first" (FIFO, no starvation).
CREATE INDEX IF NOT EXISTS story_repair_schedule_due_idx
  ON story_repair_schedule (workspace_id, state, next_eligible_at, enqueued_at);

ALTER TABLE story_repair_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_repair_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY story_repair_schedule_select ON story_repair_schedule FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY story_repair_schedule_insert ON story_repair_schedule FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY story_repair_schedule_update ON story_repair_schedule FOR UPDATE
  USING (workspace_id = current_setting('app.current_workspace', true))
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY story_repair_schedule_delete ON story_repair_schedule FOR DELETE
  USING (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON story_repair_schedule FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_repair_schedule TO cp_tenant_app;
GRANT SELECT ON story_repair_schedule TO cp_ops_enumerator;

-- ============================ (3) evidence on the attempt ledger ============================
-- Whether the provider call for this attempt was reached. An attempt that crashed after SUBMITTED must
-- never be re-sent — the honest resolution is to read this and hand the story to a human.
ALTER TABLE story_quality_repairs ADD COLUMN IF NOT EXISTS submit_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED'
  CHECK (submit_state IN ('NOT_SUBMITTED','SUBMITTED','UNCERTAIN'));
-- Which stage this attempt was executing, so an interrupted attempt can say what it was doing.
ALTER TABLE story_quality_repairs ADD COLUMN IF NOT EXISTS stage TEXT NULL
  CHECK (stage IS NULL OR stage IN ('RE_EVALUATE','REPAIR','EXPAND','TITLE','METADATA','QUALITY','COMPLETE'));
-- The schedule row's idempotency key at the moment this attempt was claimed (audit join).
ALTER TABLE story_quality_repairs ADD COLUMN IF NOT EXISTS idempotency_key TEXT COLLATE "C" NULL
  CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$');
-- Who ran it: the auto-repair scheduler, or an owner pressing the button.
ALTER TABLE story_quality_repairs ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT 'MANUAL'
  CHECK (actor IN ('MANUAL','SCHEDULER'));

-- Outcomes gain the two in-progress values a scheduler needs to record.
ALTER TABLE story_quality_repairs DROP CONSTRAINT IF EXISTS story_quality_repairs_outcome_check;
ALTER TABLE story_quality_repairs ADD CONSTRAINT story_quality_repairs_outcome_check CHECK (outcome IN (
  'PENDING','RUNNING','WAITING_COOLDOWN','RE_EVALUATED','REPAIRED','STILL_FAILING','EXHAUSTED','ERROR'));
