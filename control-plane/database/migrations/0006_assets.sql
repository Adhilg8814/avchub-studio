-- P0 Step 5C.2 — 0006 assets, variants, review state, locality, preview refs.
-- storage_tier + liveness are INDEPENDENT columns (no combined availability enum). No
-- absolute path, no provider URL, no credentials.

SET search_path = public;

-- Reject an absolute path or a raw provider URL in any relative-ref / metadata text.
CREATE OR REPLACE FUNCTION cp_is_relative_ref(v text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT v IS NOT NULL
     AND v !~ '^[A-Za-z]:[\\/]'   -- no Windows drive absolute
     AND v !~ '^[\\/]'            -- no POSIX absolute
     AND v !~ '\.\.'             -- no traversal
     AND v !~ '://'              -- no scheme://host URL
$$;

CREATE TABLE assets (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'asset')),
  workspace_id          TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id            TEXT COLLATE "C" NOT NULL,
  episode_id            TEXT COLLATE "C" NULL,
  shot_id               TEXT COLLATE "C" NULL,
  producing_worker_id   TEXT COLLATE "C" NULL,
  source_asset_id       TEXT COLLATE "C" NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  provider              TEXT NULL,
  provider_account_ref  TEXT NULL,
  relative_path         TEXT NOT NULL CHECK (cp_is_relative_ref(relative_path)),
  file_name             TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  size_bytes            BIGINT NULL CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum              TEXT NOT NULL,
  actual_duration_sec   DOUBLE PRECISION NULL CHECK (actual_duration_sec IS NULL OR actual_duration_sec >= 0),
  width                 INTEGER NULL CHECK (width IS NULL OR width >= 0),
  height                INTEGER NULL CHECK (height IS NULL OR height >= 0),
  storage_tier          TEXT NOT NULL DEFAULT 'LOCAL_ONLY' CHECK (storage_tier IN ('LOCAL_ONLY','PREVIEW_AVAILABLE','BACKED_UP')),
  liveness              TEXT NOT NULL DEFAULT 'ONLINE' CHECK (liveness IN ('ONLINE','WORKER_OFFLINE','MISSING','CORRUPT','MIGRATION_REQUIRED')),
  review_status         TEXT NOT NULL DEFAULT 'PENDING',
  selected              BOOLEAN NOT NULL DEFAULT false,
  approved              BOOLEAN NOT NULL DEFAULT false,
  base_revision         INTEGER NULL,
  prompt_snapshot       TEXT NULL,
  revision              INTEGER NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz NULL,
  CONSTRAINT assets_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT assets_worker_fk FOREIGN KEY (workspace_id, producing_worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT,
  -- generation-attempt linkage uses RESTRICT (ownership evidence must not vanish).
  CONSTRAINT assets_attempt_fk FOREIGN KEY (workspace_id, generation_attempt_id)
    REFERENCES generation_attempts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT assets_ws_id_uq UNIQUE (workspace_id, id)
);
-- one LIVE asset per relative path (soft-deleted rows free the path).
CREATE UNIQUE INDEX assets_live_path_uq ON assets (workspace_id, project_id, relative_path) WHERE deleted_at IS NULL;

CREATE TABLE asset_variants (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'avar')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id     TEXT COLLATE "C" NOT NULL,
  kind         TEXT NOT NULL,
  relative_path TEXT NULL CHECK (relative_path IS NULL OR cp_is_relative_ref(relative_path)),
  checksum     TEXT NULL,
  size_bytes   BIGINT NULL CHECK (size_bytes IS NULL OR size_bytes >= 0),
  meta         JSONB NULL,
  CONSTRAINT asset_variants_uq UNIQUE (asset_id, kind),
  CONSTRAINT asset_variants_asset_fk FOREIGN KEY (workspace_id, asset_id)
    REFERENCES assets (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE asset_review_state (
  id                 TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'arev')),
  workspace_id       TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id           TEXT COLLATE "C" NOT NULL,
  reviewed_by_user_id TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  review_status      TEXT NOT NULL DEFAULT 'PENDING',
  selected           BOOLEAN NOT NULL DEFAULT false,
  approved           BOOLEAN NOT NULL DEFAULT false,
  reviewed_at        timestamptz NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT asset_review_state_uq UNIQUE (asset_id),
  CONSTRAINT asset_review_state_asset_fk FOREIGN KEY (workspace_id, asset_id)
    REFERENCES assets (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE asset_locality (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'aloc')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id     TEXT COLLATE "C" NOT NULL,
  worker_id    TEXT COLLATE "C" NULL,
  storage_tier TEXT NOT NULL DEFAULT 'LOCAL_ONLY' CHECK (storage_tier IN ('LOCAL_ONLY','PREVIEW_AVAILABLE','BACKED_UP')),
  liveness     TEXT NOT NULL DEFAULT 'ONLINE' CHECK (liveness IN ('ONLINE','WORKER_OFFLINE','MISSING','CORRUPT','MIGRATION_REQUIRED')),
  checked_at   timestamptz NULL,
  CONSTRAINT asset_locality_asset_fk FOREIGN KEY (workspace_id, asset_id)
    REFERENCES assets (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE asset_preview_refs (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'preview')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id     TEXT COLLATE "C" NOT NULL,
  object_key   TEXT NOT NULL,                 -- server-derived; scoped; never a public URL
  kind         TEXT NOT NULL,
  size_bytes   BIGINT NULL CHECK (size_bytes IS NULL OR size_bytes >= 0),
  expires_at   timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_preview_object_key_no_url CHECK (object_key !~ '://'),
  CONSTRAINT asset_preview_asset_fk FOREIGN KEY (workspace_id, asset_id)
    REFERENCES assets (workspace_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER assets_touch BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
