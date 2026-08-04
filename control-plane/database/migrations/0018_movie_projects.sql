-- P0 Step 5C.10 — Story-to-Movie MVP durable data model (additive; 0001-0017 frozen).
--
-- A movie_project holds the story + settings; movie_scenes are the ordered storyboard, each of
-- which is generated as ONE video through the FROZEN 5C.9E generation pipeline (a scene references
-- its generation job/attempt/result by id — a correlation link, NOT a second generation system).
-- PostgreSQL is the source of truth; RLS FORCE + workspace scoping like every collaborative table
-- (0010). No secrets, proxy refs, credentials, absolute paths, or signed URLs are ever stored here
-- (media_meta / final_media carry a SAFE relative path + sizes only; the repository validates).

SET search_path = public;

CREATE TABLE movie_projects (
  workspace_id            TEXT COLLATE "C" NOT NULL,
  id                      TEXT COLLATE "C" NOT NULL,          -- mov_<ULID>
  title                   TEXT NOT NULL,
  genre                   TEXT NULL,
  language                TEXT NOT NULL DEFAULT 'en',
  target_duration_seconds INTEGER NOT NULL DEFAULT 30 CHECK (target_duration_seconds BETWEEN 3 AND 1200),
  aspect_ratio            TEXT NOT NULL DEFAULT '9:16',
  visual_style            TEXT NULL,
  character_bible         JSONB NULL,                          -- [{name, description, appearance?}] safe text only
  input_mode              TEXT NOT NULL DEFAULT 'IDEA' CHECK (input_mode IN ('IDEA','PASTED')),
  idea                    TEXT NULL,
  pasted_story            TEXT NULL,
  synopsis                TEXT NULL,
  story                   JSONB NULL,                          -- validated {title,synopsis,characters,styleBible,scenes}
  status                  TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                            'DRAFT','STORY_READY','STORYBOARD_READY','GENERATING','ASSEMBLING','COMPLETED','FAILED')),
  final_media             JSONB NULL,                          -- {relativePath, sizeBytes, durationSeconds, width?, height?, sceneCount?}
  source                  TEXT NOT NULL DEFAULT 'UI' CHECK (source IN ('UI','IMPORT')),
  created_by_user_id      TEXT COLLATE "C" NULL,
  revision                BIGINT NOT NULL DEFAULT 1,           -- optimistic concurrency
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  archived_at             timestamptz NULL,                    -- soft delete
  CONSTRAINT movie_projects_pk PRIMARY KEY (workspace_id, id)
);
CREATE INDEX movie_projects_active_idx ON movie_projects (workspace_id, created_at) WHERE archived_at IS NULL;

CREATE TABLE movie_scenes (
  workspace_id            TEXT COLLATE "C" NOT NULL,
  id                      TEXT COLLATE "C" NOT NULL,          -- msc_<ULID>
  movie_project_id        TEXT COLLATE "C" NOT NULL,
  ordinal                 INTEGER NOT NULL CHECK (ordinal >= 0),
  heading                 TEXT NULL,
  narration               TEXT NULL,                           -- narration/dialogue (also drives the SRT subtitle)
  visual_description      TEXT NULL,
  video_prompt            TEXT NOT NULL,                        -- self-contained: carries character + style bible
  duration_seconds        INTEGER NOT NULL DEFAULT 6 CHECK (duration_seconds BETWEEN 1 AND 30),
  aspect_ratio            TEXT NOT NULL DEFAULT '9:16',
  continuity              JSONB NULL,                          -- {characters:[names], styleRef, previousSceneId?}
  -- Correlation to the frozen generation pipeline (soft references by id; the movie layer drives
  -- generation through the 5C.9E facade, never by coupling to its tables).
  generation_job_id       TEXT COLLATE "C" NULL,
  generation_attempt_id   TEXT COLLATE "C" NULL,
  result_id               TEXT NULL,
  media_meta              JSONB NULL,                          -- {relativePath, sizeBytes, container, durationSeconds?, width?, height?}
  state                   TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state IN (
                            'PLANNED','QUEUED','GENERATING','COMPLETED','FAILED','UNCERTAIN')),
  attempt_count           INTEGER NOT NULL DEFAULT 0,          -- how many generation attempts this scene has had
  error_code              TEXT NULL,
  revision                BIGINT NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movie_scenes_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT movie_scenes_project_fk FOREIGN KEY (workspace_id, movie_project_id)
    REFERENCES movie_projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT movie_scenes_ordinal_uq UNIQUE (workspace_id, movie_project_id, ordinal)
);
CREATE INDEX movie_scenes_project_idx ON movie_scenes (workspace_id, movie_project_id, ordinal);

-- Append-only, per-project ordered event log (redacted; no prompt beyond the stored columns).
CREATE TABLE movie_project_events (
  workspace_id  TEXT COLLATE "C" NOT NULL,
  project_id    TEXT COLLATE "C" NOT NULL,
  seq           BIGINT NOT NULL,
  type          TEXT NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  detail        JSONB NULL,
  CONSTRAINT movie_project_events_pk PRIMARY KEY (workspace_id, project_id, seq),
  CONSTRAINT movie_project_events_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES movie_projects (workspace_id, id) ON DELETE CASCADE
);

-- RLS FORCE + tenant policies (identical predicate to every collaborative table, 0010).
DO $rls$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['movie_projects','movie_scenes','movie_project_events'] LOOP
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
