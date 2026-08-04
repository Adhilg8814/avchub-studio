-- P0 Step 5C.2 — 0004 workers, credentials (verifier-only), capabilities, storage, sessions,
-- status history, pairing codes. Human and Worker credentials remain separate (Worker
-- verifiers here; user_sessions.token_hash lives in 0002). No plaintext credential/code field
-- exists anywhere — only *_hash verifiers.

SET search_path = public;

CREATE TABLE workers (
  id              TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'wrk')),
  workspace_id    TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  platform        TEXT NOT NULL,
  os_version      TEXT NULL,
  architecture    TEXT NULL,
  worker_version  TEXT NULL,
  protocol_version INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE','OFFLINE','DEGRADED','REVOKED')),
  installation_id TEXT NULL,                 -- opaque, not a fingerprint, not an auth factor
  last_seen_at    timestamptz NULL,
  paired_at       timestamptz NULL,
  revoked_at      timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workers_ws_id_uq UNIQUE (workspace_id, id)
);

-- Deferred FKs from 0003 now that workers exists (composite = workspace-safe).
ALTER TABLE projects
  ADD CONSTRAINT projects_home_worker_fk FOREIGN KEY (workspace_id, home_worker_id)
  REFERENCES workers (workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE project_worker_affinity
  ADD CONSTRAINT affinity_worker_fk FOREIGN KEY (workspace_id, worker_id)
  REFERENCES workers (workspace_id, id) ON DELETE RESTRICT;

CREATE TABLE worker_credentials (
  id              TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'cred')),
  workspace_id    TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id       TEXT COLLATE "C" NOT NULL,
  credential_hash TEXT NOT NULL,             -- HMAC-SHA256(pepper, credential) verifier ONLY
  status          TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','ROTATING','REVOKED','EXPIRED')),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  rotated_at      timestamptz NULL,
  revoked_at      timestamptz NULL,
  last_used_at    timestamptz NULL,
  rotation_id     TEXT NULL,
  -- Defensive: forbid a column literally named/typed to hold a plaintext credential. The
  -- verifier must not equal a wcred_ token shape.
  CONSTRAINT worker_credentials_hash_not_plaintext CHECK (credential_hash NOT LIKE 'wcred_%'),
  CONSTRAINT worker_credentials_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX worker_credentials_one_active_uq ON worker_credentials (worker_id) WHERE status = 'ACTIVE';

CREATE TABLE worker_capabilities (
  id                 TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'wcap')),
  workspace_id       TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id          TEXT COLLATE "C" NOT NULL,
  capability         TEXT NOT NULL,
  provider_durations JSONB NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_capabilities_uq UNIQUE (worker_id, capability),
  CONSTRAINT worker_capabilities_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE worker_storage_status (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'wsto')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id    TEXT COLLATE "C" NOT NULL,
  root_label   TEXT NULL,                    -- label only; NEVER an absolute path
  free_bytes   BIGINT NULL CHECK (free_bytes IS NULL OR free_bytes >= 0),
  total_bytes  BIGINT NULL CHECK (total_bytes IS NULL OR total_bytes >= 0),
  health       TEXT NULL,
  reported_at  timestamptz NULL,
  CONSTRAINT worker_storage_one_per_worker_uq UNIQUE (worker_id),
  CONSTRAINT worker_storage_root_not_absolute CHECK (root_label IS NULL OR (root_label !~ '^[A-Za-z]:[\\/]' AND root_label !~ '^/')),
  CONSTRAINT worker_storage_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE worker_connection_sessions (
  id                TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'sess')),
  workspace_id      TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id         TEXT COLLATE "C" NOT NULL,
  gateway_instance  TEXT NULL,
  session_id        TEXT NULL,
  resume_token_hash TEXT NULL,               -- hash only
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE','SUPERSEDED','CLOSED')),
  reconcile_barrier_open BOOLEAN NOT NULL DEFAULT false,   -- while true: no new offers for this worker
  reconcile_epoch   INTEGER NOT NULL DEFAULT 0,
  connected_at      timestamptz NULL,
  last_seen_at      timestamptz NULL,
  closed_at         timestamptz NULL,
  CONSTRAINT worker_sessions_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX worker_sessions_one_active_uq ON worker_connection_sessions (worker_id) WHERE status = 'ACTIVE';

CREATE TABLE worker_status_history (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'wsh')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id    TEXT COLLATE "C" NOT NULL,
  status       TEXT NOT NULL,
  reason       TEXT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_status_history_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE pairing_codes (
  id                 TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'pcode')),
  workspace_id       TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  created_by_user_id TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  used_by_worker_id  TEXT COLLATE "C" NULL,
  code_hash          TEXT NOT NULL,          -- HMAC(pairing pepper) verifier ONLY; never plaintext
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pairing_code_hash_not_plaintext CHECK (code_hash !~ '^[A-HJKMNP-TV-Z0-9]{4}-[A-HJKMNP-TV-Z0-9]{4}-[A-HJKMNP-TV-Z0-9]{4}$')
);

CREATE TRIGGER workers_touch BEFORE UPDATE ON workers FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
