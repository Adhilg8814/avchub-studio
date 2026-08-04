-- P0 Step 5C.11 — Content Studio V1 durable model (additive; 0001-0018 frozen).
--
-- Extends the 5C.10 movie_projects/movie_scenes with content-studio fields and adds durable
-- attempt/version tables for story text generation, per-scene audio (TTS/upload/music), FFmpeg
-- render versions, and Facebook/package publish attempts. PostgreSQL is the source of truth; RLS
-- FORCE + workspace scoping like every collaborative table. No secrets, proxy/credentials, absolute
-- paths, or provider URLs are ever stored (JSONB knob bags carry SAFE relative media paths + sizes
-- + sanitized ids only; the repository layer validates before persistence).

SET search_path = public;

-- ---- content-studio columns on the existing (0018) project + scene tables --------------------
ALTER TABLE movie_projects
  ADD COLUMN IF NOT EXISTS tone TEXT NULL,
  ADD COLUMN IF NOT EXISTS target_platform TEXT NOT NULL DEFAULT 'GENERIC' CHECK (target_platform IN ('FACEBOOK_REELS','FACEBOOK_VIDEO','GENERIC')),
  ADD COLUMN IF NOT EXISTS world_bible TEXT NULL,
  ADD COLUMN IF NOT EXISTS negative_instructions TEXT NULL,
  ADD COLUMN IF NOT EXISTS narration_settings JSONB NULL,
  ADD COLUMN IF NOT EXISTS music_settings JSONB NULL,
  ADD COLUMN IF NOT EXISTS subtitle_settings JSONB NULL,
  ADD COLUMN IF NOT EXISTS render_settings JSONB NULL,
  ADD COLUMN IF NOT EXISTS publishing_metadata JSONB NULL,
  ADD COLUMN IF NOT EXISTS story_approved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS text_provider TEXT NOT NULL DEFAULT 'LOCAL' CHECK (text_provider IN ('LOCAL','GROK_CHAT','MANUAL'));

ALTER TABLE movie_scenes
  ADD COLUMN IF NOT EXISTS dialogue TEXT NULL,
  ADD COLUMN IF NOT EXISTS camera TEXT NULL,
  ADD COLUMN IF NOT EXISTS lighting TEXT NULL,
  ADD COLUMN IF NOT EXISTS character_ids JSONB NULL,
  ADD COLUMN IF NOT EXISTS negative_instructions TEXT NULL,
  ADD COLUMN IF NOT EXISTS trim_in NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS trim_out NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS transition_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS transition_seconds NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS audio_meta JSONB NULL;

-- ---- story text-generation attempts (exactly-once per attempt) --------------------------------
CREATE TABLE story_text_attempts (
  workspace_id        TEXT COLLATE "C" NOT NULL,
  id                  TEXT COLLATE "C" NOT NULL,             -- sga_<ULID>
  movie_project_id    TEXT COLLATE "C" NOT NULL,
  provider            TEXT NOT NULL DEFAULT 'LOCAL' CHECK (provider IN ('LOCAL','GROK_CHAT','MANUAL')),
  prompt_hash         TEXT NOT NULL,
  response_hash       TEXT NULL,
  invocation_state    TEXT NULL CHECK (invocation_state IS NULL OR invocation_state IN ('RESERVED','CONSUMED')),
  submit_state        TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submit_state IN ('NOT_SUBMITTED','SUBMITTED','UNCERTAIN')),
  result              JSONB NULL,                            -- validated story
  provider_result_ref TEXT NULL,                             -- correlated response id (redacted)
  state               TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','COMPLETED','FAILED','UNCERTAIN')),
  error_code          TEXT NULL,
  revision            BIGINT NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_text_attempts_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_text_attempts_project_fk FOREIGN KEY (workspace_id, movie_project_id)
    REFERENCES movie_projects (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX story_text_attempts_project_idx ON story_text_attempts (workspace_id, movie_project_id, created_at);

-- ---- per-scene / per-project audio assets (TTS narration, uploaded voiceover, music) ----------
CREATE TABLE scene_audio_assets (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,                -- aud_<ULID>
  movie_project_id TEXT COLLATE "C" NOT NULL,
  scene_id         TEXT COLLATE "C" NULL,                    -- msc_ (null => project-level, e.g. music)
  kind             TEXT NOT NULL CHECK (kind IN ('NARRATION','MUSIC','UPLOAD')),
  provider         TEXT NULL,                                -- SAPI voice id / 'UPLOAD'
  audio_attempt_id TEXT COLLATE "C" NULL,
  invocation_state TEXT NULL CHECK (invocation_state IS NULL OR invocation_state IN ('RESERVED','CONSUMED')),
  media_meta       JSONB NULL,                               -- {relativePath, sizeBytes, container, durationSeconds}
  state            TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','GENERATING','COMPLETED','FAILED')),
  error_code       TEXT NULL,
  revision         BIGINT NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scene_audio_assets_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT scene_audio_assets_project_fk FOREIGN KEY (workspace_id, movie_project_id)
    REFERENCES movie_projects (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX scene_audio_assets_project_idx ON scene_audio_assets (workspace_id, movie_project_id);

-- ---- FFmpeg render versions (renderHash-keyed; completed renders are immutable evidence) -------
CREATE TABLE movie_renders (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,                -- rnd_<ULID>
  movie_project_id TEXT COLLATE "C" NOT NULL,
  version          INTEGER NOT NULL,
  render_hash      TEXT NOT NULL,                            -- deterministic hash of the render inputs
  final_media      JSONB NULL,
  subtitle_media   JSONB NULL,
  thumbnail_media  JSONB NULL,
  package_media    JSONB NULL,
  probe            JSONB NULL,                               -- sanitized ffprobe summary + sha256
  state            TEXT NOT NULL DEFAULT 'RENDERING' CHECK (state IN ('RENDERING','COMPLETED','FAILED')),
  error_code       TEXT NULL,
  revision         BIGINT NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movie_renders_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT movie_renders_project_fk FOREIGN KEY (workspace_id, movie_project_id)
    REFERENCES movie_projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT movie_renders_version_uq UNIQUE (workspace_id, movie_project_id, version)
);

-- ---- publish attempts (Facebook draft/only-me, or downloadable package; exactly-once) ----------
CREATE TABLE publish_attempts (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,                -- pub_<ULID>
  movie_project_id TEXT COLLATE "C" NOT NULL,
  render_id        TEXT COLLATE "C" NULL,
  target           TEXT NOT NULL DEFAULT 'PACKAGE' CHECK (target IN ('FACEBOOK','PACKAGE')),
  audience         TEXT NULL CHECK (audience IS NULL OR audience IN ('DRAFT','ONLY_ME','PUBLIC')),
  invocation_state TEXT NULL CHECK (invocation_state IS NULL OR invocation_state IN ('RESERVED','CONSUMED')),
  submit_state     TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submit_state IN ('NOT_SUBMITTED','SUBMITTED','UNCERTAIN')),
  post_ref         TEXT NULL,                                -- redacted post/draft correlation
  state            TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','COMPLETED','FAILED','UNCERTAIN')),
  error_code       TEXT NULL,
  revision         BIGINT NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publish_attempts_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT publish_attempts_project_fk FOREIGN KEY (workspace_id, movie_project_id)
    REFERENCES movie_projects (workspace_id, id) ON DELETE CASCADE
);

-- RLS FORCE + tenant policies for the 4 new tables (identical predicate to 0010/0018).
DO $rls$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['story_text_attempts','scene_audio_assets','movie_renders','publish_attempts'] LOOP
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
