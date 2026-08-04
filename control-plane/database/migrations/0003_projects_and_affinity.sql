-- P0 Step 5C.2 — 0003 projects, episodes, shots, prompts, revisions, project_worker_affinity.
-- Workspace-safe hierarchy via composite (workspace_id, id) uniques + composite FKs so a
-- child can never cross workspaces. workers FK is added in 0004 (after workers exists);
-- affinity.worker_id FK is added there too.

SET search_path = public;

CREATE TABLE projects (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'prj')),
  workspace_id          TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  created_by_user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  home_worker_id        TEXT COLLATE "C" NULL,   -- FK added in 0004; mirror of ACTIVE affinity
  title                 TEXT NOT NULL,
  locale                TEXT NULL,
  market                TEXT NULL,
  status                TEXT NOT NULL DEFAULT 'DRAFT',
  storage_relative_root TEXT NOT NULL,
  revision              INTEGER NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz NULL,
  CONSTRAINT projects_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE episodes (
  id             TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'ep')),
  workspace_id   TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id     TEXT COLLATE "C" NOT NULL,
  episode_number INTEGER NOT NULL,
  title          TEXT NULL,
  status         TEXT NOT NULL DEFAULT 'DRAFT',
  revision       INTEGER NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Non-ownership child: cascades with its project. Composite FK forbids cross-workspace.
  CONSTRAINT episodes_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT episodes_number_uq UNIQUE (project_id, episode_number),
  CONSTRAINT episodes_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE shots (
  id                      TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'sh')),
  workspace_id            TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id              TEXT COLLATE "C" NOT NULL,
  episode_id              TEXT COLLATE "C" NOT NULL,
  shot_number             INTEGER NOT NULL,
  image_prompt            TEXT NULL,
  video_prompt            TEXT NULL,
  selected_image_asset_id TEXT COLLATE "C" NULL,   -- weak ref (no FK cascade — preserve history)
  selected_video_asset_id TEXT COLLATE "C" NULL,
  status                  TEXT NOT NULL DEFAULT 'DRAFT',
  revision                INTEGER NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shots_episode_fk FOREIGN KEY (workspace_id, episode_id)
    REFERENCES episodes (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT shots_number_uq UNIQUE (episode_id, shot_number),
  CONSTRAINT shots_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE prompts (
  id                 TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'pmt')),
  workspace_id       TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  shot_id            TEXT COLLATE "C" NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('IMAGE','VIDEO')),
  text               TEXT NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompts_shot_fk FOREIGN KEY (workspace_id, shot_id)
    REFERENCES shots (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE project_revisions (
  id                TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'prev')),
  workspace_id      TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id        TEXT COLLATE "C" NOT NULL,
  revision          INTEGER NOT NULL,
  summary           TEXT NULL,
  diff              JSONB NULL,
  changed_by_user_id TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_revisions_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT project_revisions_uq UNIQUE (project_id, revision)
);

CREATE TABLE project_worker_affinity (
  id             TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'aff')),
  workspace_id   TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id     TEXT COLLATE "C" NOT NULL,
  worker_id      TEXT COLLATE "C" NOT NULL,        -- FK to workers added in 0004
  assigned_by    TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASING','RELEASED','IRRECOVERABLE')),
  generation     INTEGER NOT NULL DEFAULT 0,       -- optimistic concurrency for reassignment
  last_confirmed_at timestamptz NULL,
  released_at    timestamptz NULL,
  release_reason TEXT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affinity_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE RESTRICT
);

-- At most one ACTIVE affinity per project (a real SQL guarantee).
CREATE UNIQUE INDEX affinity_one_active_uq ON project_worker_affinity (project_id) WHERE status = 'ACTIVE';

CREATE TRIGGER projects_touch BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
CREATE TRIGGER episodes_touch BEFORE UPDATE ON episodes FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
CREATE TRIGGER shots_touch BEFORE UPDATE ON shots FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
CREATE TRIGGER projects_revision BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION cp_enforce_revision();
