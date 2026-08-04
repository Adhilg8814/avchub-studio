-- P0 Step 5C.2 — 0008 feature flags (+ normalized targets + kill targets), one-shot paid
-- approval grants, audit, rate limits, generic idempotency keys.
-- feature_flags / grants are GLOBAL platform tables (no workspace_id) — excluded from RLS
-- (documented in 0010). paid_generation_approval_grants IS workspace-scoped.

SET search_path = public;

CREATE TABLE feature_flags (
  id                 TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'flag')),
  name               TEXT NOT NULL,
  global_enabled     BOOLEAN NOT NULL DEFAULT false,
  global_kill_switch BOOLEAN NOT NULL DEFAULT false,
  requires_flag      TEXT NULL,               -- prerequisite name (dependency lattice)
  updated_by         TEXT NULL,               -- platform-operator attribution
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_flags_name_uq UNIQUE (name)
);

CREATE TABLE feature_flag_targets (
  id         TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'fft')),
  flag_id    TEXT COLLATE "C" NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  list_kind  TEXT NOT NULL CHECK (list_kind IN ('ALLOW','KILL')),
  scope      TEXT NOT NULL CHECK (scope IN ('WORKSPACE','USER','PROJECT')),
  target_id  TEXT COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_flag_targets_uq UNIQUE (flag_id, list_kind, scope, target_id)
);

-- Kept as a distinct view/table name per task §15; here KILL rows live in feature_flag_targets
-- (list_kind='KILL'). A convenience view exposes them.
CREATE VIEW feature_flag_kill_targets AS
  SELECT id, flag_id, scope, target_id, created_at FROM feature_flag_targets WHERE list_kind = 'KILL';

-- One-shot paid-generation approval grant (arch §24 DC1). Consumed exactly once at dispatch.
CREATE TABLE paid_generation_approval_grants (
  id                   TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'grant')),
  workspace_id         TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id           TEXT COLLATE "C" NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  granted_by           TEXT NULL,             -- platform-operator attribution
  max_paid_generations INTEGER NOT NULL DEFAULT 1 CHECK (max_paid_generations >= 1),
  consumed_count       INTEGER NOT NULL DEFAULT 0 CHECK (consumed_count >= 0),
  consumed_by_attempt_id TEXT COLLATE "C" NULL,
  consumed_at          timestamptz NULL,
  expires_at           timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_grant_not_over_consumed CHECK (consumed_count <= max_paid_generations)
);

CREATE TABLE audit_events (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'audit')),
  workspace_id TEXT COLLATE "C" NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('USER','WORKER','ADMIN','SYSTEM')),
  actor_id     TEXT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NULL,
  target_id    TEXT NULL,
  metadata     JSONB NULL CHECK (metadata IS NULL OR pg_column_size(metadata) <= 16384),
  ip_address   INET NULL,
  user_agent   TEXT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limit_buckets (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'rl')),
  workspace_id TEXT COLLATE "C" NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  bucket_key   TEXT NOT NULL,
  window_start timestamptz NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_limit_buckets_uq UNIQUE (bucket_key, window_start)
);

CREATE TABLE idempotency_keys (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'idem')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NULL,
  response     JSONB NULL,
  status       TEXT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NULL,
  CONSTRAINT idempotency_keys_uq UNIQUE (workspace_id, scope, key)
);
