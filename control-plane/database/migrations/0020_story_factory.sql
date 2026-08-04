-- P0 Step 5C.16 — Story Content Factory durable model (additive; 0001-0019 frozen).
--
-- A long-form original-story factory that sits BEFORE the certified Movie Factory. Country/locale +
-- an editable Content Brand Profile + an Archetype selection-space produce a frozen Story DNA, then a
-- validated long-form native-language story, title/hook/metadata, an originality fingerprint and a
-- quality report. PostgreSQL is the source of truth; RLS FORCE + workspace scoping like every
-- collaborative table. No secrets/proxy/credentials/absolute-paths/provider-URLs are ever stored
-- (JSONB carries validated, sanitized content only; the repository validates before persistence).
-- Nothing here touches the movie_* tables or the generation pipeline — a story_movie_links row is the
-- only bridge, created by an explicit, separately-authorized movie-adaptation action.

SET search_path = public;

-- ---- content brand profiles (editable market voices; seeded, then user-editable) ----------------
CREATE TABLE content_brand_profiles (
  workspace_id        TEXT COLLATE "C" NOT NULL,
  id                  TEXT COLLATE "C" NOT NULL,            -- cbp_<ULID>
  seed_key            TEXT NULL,                            -- 'seed:<locale>' for the shipped seeds (idempotent upsert)
  name                TEXT NOT NULL,
  country             TEXT NOT NULL DEFAULT '',
  locale              TEXT NOT NULL,
  language            TEXT NOT NULL DEFAULT '',
  audience            TEXT NOT NULL DEFAULT '',
  genre_family        TEXT NOT NULL DEFAULT '',
  narrator_perspective TEXT NOT NULL DEFAULT 'FIRST_PERSON',
  narrative_tense     TEXT NOT NULL DEFAULT 'PAST',
  tone                TEXT NOT NULL DEFAULT '',
  emotional_arc       JSONB NULL,
  title_pattern       TEXT NOT NULL DEFAULT '',
  hook_pattern        TEXT NOT NULL DEFAULT '',
  ending_pattern      TEXT NOT NULL DEFAULT '',
  preferred_archetypes JSONB NULL,
  prohibited_patterns JSONB NULL,
  target_word_range   JSONB NULL,
  paragraph_style     TEXT NOT NULL DEFAULT '',
  dialogue_density    TEXT NOT NULL DEFAULT 'MEDIUM',
  drama_intensity     INTEGER NOT NULL DEFAULT 3,
  realism_level       TEXT NOT NULL DEFAULT 'GROUNDED',
  visual_style        TEXT NOT NULL DEFAULT '',
  archived            BOOLEAN NOT NULL DEFAULT FALSE,
  revision            BIGINT NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_brand_profiles_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT content_brand_profiles_seed_uq UNIQUE (workspace_id, seed_key)
);

-- ---- archetype library (structured selection space; seeded, then user-editable) ------------------
CREATE TABLE story_archetypes (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- kebab slug, e.g. 'parental-favoritism'
  name             TEXT NOT NULL,
  protagonist_roles JSONB NULL,
  antagonist_relationships JSONB NULL,
  core_conflicts   JSONB NULL,
  humiliation_types JSONB NULL,
  leverage_types   JSONB NULL,
  reversal_types   JSONB NULL,
  consequence_types JSONB NULL,
  emotional_resolution_types JSONB NULL,
  compatible_locales JSONB NULL,
  prohibited_combinations JSONB NULL,
  novelty_dimensions JSONB NULL,
  archived         BOOLEAN NOT NULL DEFAULT FALSE,
  revision         BIGINT NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_archetypes_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_archetypes_slug_ck CHECK (id ~ '^[a-z][a-z0-9-]{2,48}$')
);

-- ---- story projects (the durable lifecycle root) ------------------------------------------------
CREATE TABLE story_projects (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- stp_<ULID>
  brand_profile_id TEXT COLLATE "C" NULL,
  archetype_id     TEXT COLLATE "C" NULL,
  country          TEXT NOT NULL DEFAULT '',
  locale           TEXT NOT NULL,
  language         TEXT NOT NULL DEFAULT '',
  target_audience  TEXT NOT NULL DEFAULT '',
  target_length    TEXT NOT NULL DEFAULT 'medium' CHECK (target_length IN ('short','medium','long')),
  drama_intensity  INTEGER NOT NULL DEFAULT 3,
  realism_level    TEXT NOT NULL DEFAULT 'GROUNDED',
  seed_idea        TEXT NULL,
  status           TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                     'DRAFT','DNA_GENERATING','DNA_VALIDATING','WRITING','EDITING','VALIDATING','READY',
                     'FAILED_PRE_GENERATION','FAILED_GENERATION','FAILED_VALIDATION','NEEDS_REVIEW','ARCHIVED')),
  current_dna_id       TEXT COLLATE "C" NULL,
  current_outline_id   TEXT COLLATE "C" NULL,
  current_text_id      TEXT COLLATE "C" NULL,
  current_package_id   TEXT COLLATE "C" NULL,
  current_quality_id   TEXT COLLATE "C" NULL,
  current_fingerprint_id TEXT COLLATE "C" NULL,
  title            TEXT NULL,
  word_count       INTEGER NULL,
  overall_score    NUMERIC NULL,
  error_code       TEXT NULL,
  revision         BIGINT NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_projects_pk PRIMARY KEY (workspace_id, id)
);
CREATE INDEX story_projects_ws_idx ON story_projects (workspace_id, created_at DESC);

-- ---- versioned outputs (immutable rows; a project points at its current_* id) --------------------
CREATE TABLE story_dna_versions (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- sdv_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  version          INTEGER NOT NULL,
  archetype_id     TEXT COLLATE "C" NULL,
  dna              JSONB NOT NULL,
  checksum         TEXT NOT NULL,
  logic_report     JSONB NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_dna_versions_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_dna_versions_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT story_dna_versions_uq UNIQUE (workspace_id, story_project_id, version)
);

CREATE TABLE story_outline_versions (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- sov_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  version          INTEGER NOT NULL,
  dna_id           TEXT COLLATE "C" NULL,
  outline          JSONB NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_outline_versions_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_outline_versions_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT story_outline_versions_uq UNIQUE (workspace_id, story_project_id, version)
);

CREATE TABLE story_text_versions (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- stv_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  version          INTEGER NOT NULL,
  dna_id           TEXT COLLATE "C" NULL,
  outline_id       TEXT COLLATE "C" NULL,
  story_text       TEXT NOT NULL,
  word_count       INTEGER NOT NULL DEFAULT 0,
  edited           BOOLEAN NOT NULL DEFAULT FALSE,
  continuity_report JSONB NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_text_versions_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_text_versions_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT story_text_versions_uq UNIQUE (workspace_id, story_project_id, version)
);

CREATE TABLE story_title_candidates (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- stc_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  text_version_id  TEXT COLLATE "C" NULL,
  title            TEXT NOT NULL,
  valid            BOOLEAN NOT NULL DEFAULT FALSE,
  score            NUMERIC NOT NULL DEFAULT 0,
  reasons          JSONB NULL,
  chosen           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_title_candidates_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_title_candidates_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX story_title_candidates_project_idx ON story_title_candidates (workspace_id, story_project_id, created_at);

CREATE TABLE story_content_packages (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- scp_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  version          INTEGER NOT NULL,
  title            TEXT NULL,
  hook             TEXT NULL,
  excerpt          TEXT NULL,
  seo_description  TEXT NULL,
  hero_image_prompt TEXT NULL,
  social_teaser    TEXT NULL,
  cliffhanger      TEXT NULL,
  cta              TEXT NULL,
  package          JSONB NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_content_packages_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_content_packages_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT story_content_packages_uq UNIQUE (workspace_id, story_project_id, version)
);

CREATE TABLE story_quality_reports (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- sqr_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  version          INTEGER NOT NULL,
  dimensions       JSONB NOT NULL,
  overall_score    NUMERIC NOT NULL DEFAULT 0,
  ready            BOOLEAN NOT NULL DEFAULT FALSE,
  failures         JSONB NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_quality_reports_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_quality_reports_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX story_quality_reports_project_idx ON story_quality_reports (workspace_id, story_project_id, created_at);

CREATE TABLE story_novelty_fingerprints (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- snf_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  locale           TEXT NOT NULL DEFAULT '',
  title            TEXT NULL,
  fingerprint      JSONB NOT NULL,
  nearest          JSONB NULL,
  max_overall      NUMERIC NOT NULL DEFAULT 0,
  pass             BOOLEAN NOT NULL DEFAULT FALSE,
  accepted         BOOLEAN NOT NULL DEFAULT FALSE,          -- true once the story is READY (used for future comparisons)
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_novelty_fingerprints_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_novelty_fingerprints_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX story_novelty_fingerprints_accepted_idx ON story_novelty_fingerprints (workspace_id, accepted, created_at);

-- ---- staged text-generation attempts (exactly-once per attempt; one per stage call) -------------
CREATE TABLE story_generation_attempts (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- sgn_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  stage            TEXT NOT NULL CHECK (stage IN ('DNA','OUTLINE','STORY','EDIT','TITLE','METADATA','QUALITY')),
  provider         TEXT NOT NULL DEFAULT 'GROK_CHAT' CHECK (provider IN ('LOCAL','GROK_CHAT','MANUAL')),
  prompt_hash      TEXT NOT NULL,
  response_hash    TEXT NULL,
  invocation_state TEXT NULL CHECK (invocation_state IS NULL OR invocation_state IN ('RESERVED','CONSUMED')),
  submit_state     TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (submit_state IN ('NOT_SUBMITTED','SUBMITTED','UNCERTAIN')),
  result           JSONB NULL,
  provider_result_ref TEXT NULL,
  state            TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','COMPLETED','FAILED','UNCERTAIN')),
  error_code       TEXT NULL,
  revision         BIGINT NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_generation_attempts_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_generation_attempts_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX story_generation_attempts_project_idx ON story_generation_attempts (workspace_id, story_project_id, created_at);

-- ---- durable audit events -----------------------------------------------------------------------
CREATE TABLE story_events (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- sev_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  type             TEXT NOT NULL,
  detail           JSONB NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_events_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_events_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX story_events_project_idx ON story_events (workspace_id, story_project_id, created_at);

-- ---- story -> movie adaptation bridge (the ONLY link to the Movie Factory) -----------------------
CREATE TABLE story_movie_links (
  workspace_id     TEXT COLLATE "C" NOT NULL,
  id               TEXT COLLATE "C" NOT NULL,               -- sml_<ULID>
  story_project_id TEXT COLLATE "C" NOT NULL,
  movie_project_id TEXT COLLATE "C" NOT NULL,
  scene_count      INTEGER NULL,
  storyboard_only  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_movie_links_pk PRIMARY KEY (workspace_id, id),
  CONSTRAINT story_movie_links_project_fk FOREIGN KEY (workspace_id, story_project_id) REFERENCES story_projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT story_movie_links_movie_fk FOREIGN KEY (workspace_id, movie_project_id) REFERENCES movie_projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT story_movie_links_uq UNIQUE (workspace_id, story_project_id, movie_project_id)
);

-- RLS FORCE + tenant policies for the 13 new tables (identical predicate to 0010/0018/0019).
DO $rls$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content_brand_profiles','story_archetypes','story_projects','story_dna_versions',
    'story_outline_versions','story_text_versions','story_title_candidates','story_content_packages',
    'story_quality_reports','story_novelty_fingerprints','story_generation_attempts','story_events','story_movie_links'
  ] LOOP
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
