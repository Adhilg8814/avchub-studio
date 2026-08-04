-- P0 Step 5C.39 — MOVIE CONTENT ARTIFACTS (ADDITIVE, forward-only).
--
-- Everything a movie is made of has been living in memory, in a log line, or in an ops script: the adaptation,
-- the character bible, the real audio timestamps, the shot contracts, the subtitle cues, the verdicts. A render
-- could therefore never say what it was made FROM. Asked "why does this shot show a street when the narration
-- says he set the letter on the table", the honest answer was that nothing recorded what the shot was supposed
-- to be.
--
-- One table holds them all, because they share exactly one lifecycle: written once, never mutated, superseded
-- by a newer revision that names its predecessor. Separate tables per artifact kind would duplicate that
-- lifecycle a dozen times and let the copies drift.
--
--   movie_content_artifacts  — immutable, versioned, content-hashed. An artifact is never UPDATEd; a change
--                              writes revision n+1 with supersedes_revision = n. Status moves only
--                              DRAFT -> ACTIVE -> SUPERSEDED, and only forward.
--   movie_render_artifacts   — which exact revision of which artifact a render consumed. This is the join that
--                              makes a finished file explicable: it is provenance, so it is append-only.
--
-- Workspace remains the sole RLS boundary. Existing movies, renders, stories and audio are untouched: they
-- simply have no artifacts, which reads as UNVERIFIED rather than as a pass.

SET search_path = public;

-- ---- artifact kinds ------------------------------------------------------------------------------------
-- A CHECK rather than an enum: adding a kind later is then a one-line forward migration instead of an enum
-- rewrite, and the set is small enough to read.
CREATE TABLE IF NOT EXISTS movie_content_artifacts (
  workspace_id        text        NOT NULL,
  id                  text        PRIMARY KEY,
  movie_project_id    text        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN (
                        'ADAPTATION', 'CHARACTER_BIBLE', 'LOCATION_BIBLE', 'STYLE_BIBLE', 'BEAT_SHEET',
                        'NARRATION_SCRIPT', 'NARRATION_AUDIO', 'AUDIO_ALIGNMENT', 'TRANSCRIPT_VERIFICATION',
                        'SHOT_CONTRACT', 'SUBTITLE_TIMELINE', 'SCENE_VISION_VERDICT', 'SCENE_TECHNICAL_VERDICT',
                        'MOVIE_SCORECARD', 'AUDIO_MIX_VERDICT')),
  -- Scoped artifacts (a shot contract, a per-scene verdict) name their scene; movie-wide ones leave it null.
  scene_id            text        NULL,
  revision            integer     NOT NULL CHECK (revision >= 1),
  supersedes_revision integer     NULL CHECK (supersedes_revision IS NULL OR supersedes_revision >= 1),
  -- What this artifact was derived FROM, so a chain can be walked back to the source story. An adaptation
  -- names the story revision; a subtitle timeline names the alignment it was cut from.
  source_kind         text        NULL,
  source_artifact_id  text        NULL REFERENCES movie_content_artifacts (id),
  source_revision     integer     NULL,
  -- sha256 of the canonical JSON body. Two artifacts with the same hash ARE the same artifact, which is what
  -- makes "did anything actually change" answerable without diffing.
  content_hash        text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  body                jsonb       NOT NULL,
  -- Who caused this to exist. An owner edit and a scheduler repair are different facts about the same movie.
  creator             text        NOT NULL CHECK (creator IN ('SYSTEM', 'SCHEDULER', 'OWNER')),
  created_by_user_id  text        NULL,
  -- Provider provenance where a provider was involved: which provider, which account, which attempt, what it
  -- cost. Null for artifacts computed locally, which is itself the honest statement that nothing was spent.
  provider            text        NULL,
  provider_account_id text        NULL,
  provider_attempt_id text        NULL,
  provider_request    jsonb       NULL,
  status              text        NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'REJECTED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  superseded_at       timestamptz NULL
);

-- One revision per (movie, kind, scene). A null scene_id is a distinct slot from any real scene, so the
-- movie-wide artifact and a per-scene one of the same kind never collide.
CREATE UNIQUE INDEX IF NOT EXISTS movie_content_artifacts_revision_uk
  ON movie_content_artifacts (workspace_id, movie_project_id, kind, COALESCE(scene_id, ''), revision);

-- At most ONE active revision per slot. A partial unique index makes that a database fact rather than a
-- convention every writer has to remember, and concurrent writers collide here instead of both winning.
CREATE UNIQUE INDEX IF NOT EXISTS movie_content_artifacts_active_uk
  ON movie_content_artifacts (workspace_id, movie_project_id, kind, COALESCE(scene_id, ''))
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS movie_content_artifacts_lookup
  ON movie_content_artifacts (workspace_id, movie_project_id, kind, revision DESC);
CREATE INDEX IF NOT EXISTS movie_content_artifacts_scene
  ON movie_content_artifacts (workspace_id, movie_project_id, scene_id, kind) WHERE scene_id IS NOT NULL;

-- An artifact is evidence. Evidence that can be edited is not evidence — the body, hash, revision and lineage
-- are frozen at insert, and only the status transition that retires it may ever be written.
CREATE OR REPLACE FUNCTION movie_content_artifacts_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.movie_project_id IS DISTINCT FROM OLD.movie_project_id
     OR NEW.scene_id IS DISTINCT FROM OLD.scene_id
     OR NEW.source_artifact_id IS DISTINCT FROM OLD.source_artifact_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'movie content artifacts are immutable; write a new revision'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Status moves forward only. A SUPERSEDED artifact never becomes ACTIVE again: the newer revision is the
  -- current one, and resurrecting an old body would silently change what a render claims to be made from.
  IF OLD.status IN ('SUPERSEDED', 'REJECTED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'artifact status is forward-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS movie_content_artifacts_immutable_trg ON movie_content_artifacts;
CREATE TRIGGER movie_content_artifacts_immutable_trg
  BEFORE UPDATE ON movie_content_artifacts
  FOR EACH ROW EXECUTE FUNCTION movie_content_artifacts_immutable();

ALTER TABLE movie_content_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE movie_content_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY movie_content_artifacts_select ON movie_content_artifacts FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY movie_content_artifacts_insert ON movie_content_artifacts FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY movie_content_artifacts_update ON movie_content_artifacts FOR UPDATE
  USING (workspace_id = current_setting('app.current_workspace', true))
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON movie_content_artifacts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON movie_content_artifacts TO cp_tenant_app;
GRANT SELECT ON movie_content_artifacts TO cp_ops_enumerator;

-- ---- render provenance ---------------------------------------------------------------------------------
-- Which exact artifact revisions a render consumed. Append-only by trigger: provenance that can be rewritten
-- after the fact describes a render that no longer exists.
CREATE TABLE IF NOT EXISTS movie_render_artifacts (
  workspace_id    text        NOT NULL,
  render_id       text        NOT NULL,
  artifact_id     text        NOT NULL REFERENCES movie_content_artifacts (id),
  kind            text        NOT NULL,
  scene_id        text        NULL,
  revision        integer     NOT NULL,
  content_hash    text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, render_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS movie_render_artifacts_render
  ON movie_render_artifacts (workspace_id, render_id, kind);

CREATE OR REPLACE FUNCTION movie_render_artifacts_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'render provenance is append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS movie_render_artifacts_append_only_trg ON movie_render_artifacts;
CREATE TRIGGER movie_render_artifacts_append_only_trg
  BEFORE UPDATE OR DELETE ON movie_render_artifacts
  FOR EACH ROW EXECUTE FUNCTION movie_render_artifacts_append_only();

ALTER TABLE movie_render_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE movie_render_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY movie_render_artifacts_select ON movie_render_artifacts FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY movie_render_artifacts_insert ON movie_render_artifacts FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON movie_render_artifacts FROM PUBLIC;
GRANT SELECT, INSERT ON movie_render_artifacts TO cp_tenant_app;
GRANT SELECT ON movie_render_artifacts TO cp_ops_enumerator;

-- ---- the publishable state ------------------------------------------------------------------------------
-- A render finishing has always set the movie to COMPLETED, and COMPLETED has been read as "done, ship it".
-- Those are different claims. The scorecard decides the second one, and until it has, a finished render is
-- QUALITY_REVIEW_REQUIRED — not a failure, just not yet defensible.
--
-- Nullable and additive: the 9 existing movies keep their status untouched and read as never-assessed.
ALTER TABLE movie_projects ADD COLUMN IF NOT EXISTS quality_state text NULL
  CHECK (quality_state IS NULL OR quality_state IN ('PIPELINE_COMPLETED', 'QUALITY_REVIEW_REQUIRED', 'PUBLISHABLE'));
ALTER TABLE movie_projects ADD COLUMN IF NOT EXISTS quality_scorecard_id text NULL;
ALTER TABLE movie_projects ADD COLUMN IF NOT EXISTS quality_assessed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS movie_projects_quality_state
  ON movie_projects (workspace_id, quality_state) WHERE quality_state IS NOT NULL;

-- ---- targeted shot repair ledger ------------------------------------------------------------------------
-- One row per repair attempt on ONE shot. Bounded, idempotent and durable, sharing the shape the story repair
-- scheduler already proved: a conditional claim, a lease that expires rather than a reaper that must run, and
-- an idempotency key that makes a duplicate provider call impossible rather than unlikely.
CREATE TABLE IF NOT EXISTS movie_shot_repairs (
  workspace_id      text        NOT NULL,
  id                text        PRIMARY KEY,
  movie_project_id  text        NOT NULL,
  scene_id          text        NOT NULL,
  attempt           integer     NOT NULL CHECK (attempt >= 1),
  -- sha256(project|scene|shotContractRevision|attempt). The provider call is keyed on this, so a retry after a
  -- crash resolves to the same key and cannot spend twice.
  idempotency_key   text        NOT NULL,
  reason            text        NOT NULL,
  failed_requirements jsonb     NOT NULL DEFAULT '[]'::jsonb,
  vision_verdict_id text        NULL REFERENCES movie_content_artifacts (id),
  shot_contract_id  text        NULL REFERENCES movie_content_artifacts (id),
  state             text        NOT NULL DEFAULT 'PENDING'
                      CHECK (state IN ('PENDING', 'CLAIMED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'ABANDONED')),
  lease_owner       text        NULL,
  lease_expires_at  timestamptz NULL,
  generation_job_id text        NULL,
  error_code        text        NULL,
  revision          integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS movie_shot_repairs_attempt_uk
  ON movie_shot_repairs (workspace_id, movie_project_id, scene_id, attempt);
CREATE UNIQUE INDEX IF NOT EXISTS movie_shot_repairs_idem_uk
  ON movie_shot_repairs (workspace_id, idempotency_key);
-- At most one repair in flight per scene: two workers cannot both be regenerating the same shot.
CREATE UNIQUE INDEX IF NOT EXISTS movie_shot_repairs_inflight_uk
  ON movie_shot_repairs (workspace_id, movie_project_id, scene_id)
  WHERE state IN ('PENDING', 'CLAIMED', 'SUBMITTED');
CREATE INDEX IF NOT EXISTS movie_shot_repairs_claimable
  ON movie_shot_repairs (workspace_id, state, lease_expires_at);

ALTER TABLE movie_shot_repairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE movie_shot_repairs FORCE ROW LEVEL SECURITY;
CREATE POLICY movie_shot_repairs_select ON movie_shot_repairs FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY movie_shot_repairs_insert ON movie_shot_repairs FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY movie_shot_repairs_update ON movie_shot_repairs FOR UPDATE
  USING (workspace_id = current_setting('app.current_workspace', true))
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON movie_shot_repairs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON movie_shot_repairs TO cp_tenant_app;
GRANT SELECT ON movie_shot_repairs TO cp_ops_enumerator;
