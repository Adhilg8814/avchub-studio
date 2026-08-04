-- P0 Step 5C.31 — REMOTE WORKER DELIVERY (ADDITIVE, forward-only).
--
-- Until now a paired remote worker could only hold a transport-only WSS session: it authenticated,
-- said HELLO and heartbeated, but no production job could ever reach it (5C.28 deliberately installed
-- NO delivery adapter so the local worker kept SOLE ownership of the 5C.9E pipeline).
--
-- This migration adds the DURABLE state a real delivery protocol needs, WITHOUT inventing a second
-- claim/lease engine: ownership stays exactly where it already is — `job_offers.assigned_worker_id`
-- plus its lease — so "who owns this attempt" has, and keeps having, exactly one answer. What is new:
--
--  (1) worker_runtime_state  — the durable operational truth for a worker (approved / draining /
--      bundle+protocol version / capabilities / readiness / last heartbeat / current job). Previously
--      this lived in a JSON file next to the runtime, which cannot survive a restart race, cannot be
--      read transactionally with a claim, and cannot be shown honestly in the UI.
--  (2) remote_delivery_commands — the at-least-once transport's idempotency ledger. Every inbound
--      worker command is recorded once per (worker, command_id); a replayed frame after a reconnect
--      therefore has NO second effect, and a stale sequence for an attempt is refused outright.
--  (3) worker_upload_sessions — job/attempt-scoped artifact upload sessions (expected SHA-256 + size,
--      short-lived capability digest, atomic finalize). A worker can only ever write into the job it
--      currently owns; the filename is NEVER a source of ownership.
--  (4) generation_jobs.executed_by_worker_id / delivery_mode — provenance: which worker actually ran
--      the attempt, and whether it ran LOCAL or REMOTE. Load-bearing evidence for the cert.
--
-- Workspace remains the SOLE RLS boundary: every table here is workspace-scoped + FORCE RLS, and
-- customer_id appears nowhere. Tenant isolation of a DEDICATED worker is enforced on top of this by
-- the 0034 workspace_resources registry (globally unique dedicated binding), not by a new predicate.

SET search_path = public;

-- ============================ (1) durable worker runtime state ============================
-- One row per paired worker. Created on demand (pair / first HELLO / first owner action). Holds NO
-- secret: no credential, no resume token, no cookie, no proxy password, no absolute path.
CREATE TABLE IF NOT EXISTS worker_runtime_state (
  workspace_id        TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id           TEXT COLLATE "C" NOT NULL,
  -- Owner approval gate: a freshly paired worker is NOT approved, so it comes up DRAINING and may not
  -- be offered a production job until the owner Enables it after diagnostics.
  approved            BOOLEAN NOT NULL DEFAULT false,
  draining            BOOLEAN NOT NULL DEFAULT true,
  removed             BOOLEAN NOT NULL DEFAULT false,
  display_name        TEXT NULL CHECK (display_name IS NULL OR length(display_name) <= 80),
  -- reported by the worker at HELLO (advisory metadata, never an authority)
  bundle_version      TEXT NULL CHECK (bundle_version IS NULL OR length(bundle_version) <= 40),
  build_commit        TEXT NULL CHECK (build_commit IS NULL OR length(build_commit) <= 40),
  delivery_protocol_version INTEGER NULL,
  os_caption          TEXT NULL CHECK (os_caption IS NULL OR length(os_caption) <= 120),
  architecture        TEXT NULL CHECK (architecture IS NULL OR length(architecture) <= 32),
  capabilities        JSONB NULL CHECK (capabilities IS NULL OR pg_column_size(capabilities) <= 8192),
  cloak_ready         BOOLEAN NULL,
  ffmpeg_ready        BOOLEAN NULL,
  interactive_ready   BOOLEAN NULL,
  provider_ready      BOOLEAN NULL,
  -- liveness + current work (projection only; the offer/lease remains the authority)
  last_hello_at       timestamptz NULL,
  last_heartbeat_at   timestamptz NULL,
  connected_session_id TEXT NULL,
  current_job_id      TEXT COLLATE "C" NULL,
  current_attempt_id  TEXT COLLATE "C" NULL,
  current_lease_expires_at timestamptz NULL,
  -- operational surface
  update_available    BOOLEAN NOT NULL DEFAULT false,
  incompatible        BOOLEAN NOT NULL DEFAULT false,
  updating            BOOLEAN NOT NULL DEFAULT false,
  last_safe_error     TEXT NULL CHECK (last_safe_error IS NULL OR last_safe_error ~ '^[A-Z0-9_]{3,64}$'),
  drain_requested_at  timestamptz NULL,
  drained_at          timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_runtime_state_pk PRIMARY KEY (workspace_id, worker_id),
  CONSTRAINT worker_runtime_state_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS worker_runtime_state_assignable_idx
  ON worker_runtime_state (workspace_id) WHERE approved AND NOT draining AND NOT removed;

DROP TRIGGER IF EXISTS worker_runtime_state_touch ON worker_runtime_state;
CREATE TRIGGER worker_runtime_state_touch BEFORE UPDATE ON worker_runtime_state
  FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();

ALTER TABLE worker_runtime_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_runtime_state FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_runtime_state_select ON worker_runtime_state FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY worker_runtime_state_insert ON worker_runtime_state FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY worker_runtime_state_update ON worker_runtime_state FOR UPDATE
  USING (workspace_id = current_setting('app.current_workspace', true))
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON worker_runtime_state FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON worker_runtime_state TO cp_tenant_app;
GRANT SELECT ON worker_runtime_state TO cp_ops_enumerator;

-- ============================ (2) inbound command idempotency ledger ============================
-- The transport is at-least-once (a reconnect may replay). Effects must be at-most-once. Every inbound
-- command is inserted here FIRST inside the same transaction as its effect: the unique key makes a
-- replay a no-op, and the per-attempt sequence makes an out-of-order/stale frame refusable.
CREATE TABLE IF NOT EXISTS remote_delivery_commands (
  id                  TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'rdc')),
  workspace_id        TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id           TEXT COLLATE "C" NOT NULL,
  job_id              TEXT COLLATE "C" NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  command_id          TEXT NOT NULL CHECK (length(command_id) BETWEEN 8 AND 80),
  kind                TEXT NOT NULL CHECK (kind IN (
                        'ACCEPT','REJECT','PROGRESS','SUBMIT_ATTEMPTED','SUBMITTED',
                        'RESULT_READY','ARTIFACT_UPLOADED','COMPLETE','FAIL','RELEASE','DRAIN_ACK')),
  sequence            INTEGER NOT NULL CHECK (sequence >= 0),
  outcome             TEXT NOT NULL DEFAULT 'APPLIED' CHECK (outcome IN ('APPLIED','DUPLICATE','REFUSED')),
  received_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remote_delivery_commands_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT,
  -- Replay protection: the SAME command id from the SAME worker can only ever land once.
  CONSTRAINT remote_delivery_commands_idem_uq UNIQUE (workspace_id, worker_id, command_id)
);
-- A kind that may only ever happen once per attempt (the single-submission invariant's transport half).
CREATE UNIQUE INDEX IF NOT EXISTS remote_delivery_commands_singleton_uq
  ON remote_delivery_commands (workspace_id, generation_attempt_id, kind)
  WHERE generation_attempt_id IS NOT NULL AND kind IN ('ACCEPT','SUBMIT_ATTEMPTED','SUBMITTED','COMPLETE');
CREATE INDEX IF NOT EXISTS remote_delivery_commands_attempt_idx
  ON remote_delivery_commands (workspace_id, generation_attempt_id, sequence DESC);

ALTER TABLE remote_delivery_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_delivery_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY remote_delivery_commands_select ON remote_delivery_commands FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY remote_delivery_commands_insert ON remote_delivery_commands FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON remote_delivery_commands FROM PUBLIC;
GRANT SELECT, INSERT ON remote_delivery_commands TO cp_tenant_app;
GRANT SELECT ON remote_delivery_commands TO cp_ops_enumerator;

-- ============================ (3) artifact upload sessions ============================
-- An upload is authorized by a SESSION that the server minted for a job/attempt the worker provably
-- owns. The worker presents an opaque token whose DIGEST is stored (never the token). Finalize is
-- atomic and idempotent; a hash/size mismatch fails the session and the partial file is discarded.
CREATE TABLE IF NOT EXISTS worker_upload_sessions (
  id                 TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'wup')),
  workspace_id       TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id          TEXT COLLATE "C" NOT NULL,
  job_id             TEXT COLLATE "C" NOT NULL,
  generation_attempt_id TEXT COLLATE "C" NOT NULL,
  -- capability: sha256 digest of the one-time upload token (the token itself is returned exactly once)
  token_digest       TEXT NOT NULL CHECK (length(token_digest) = 64),
  kind               TEXT NOT NULL DEFAULT 'GENERATED_VIDEO' CHECK (kind IN ('GENERATED_VIDEO')),
  expected_sha256    TEXT NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  expected_bytes     BIGINT NOT NULL CHECK (expected_bytes > 0 AND expected_bytes <= 2147483648),
  expected_mime      TEXT NOT NULL CHECK (expected_mime IN ('video/mp4')),
  -- storage is a RELATIVE path under the workspace media root; never absolute, never provider-supplied
  relative_path      TEXT NOT NULL CHECK (relative_path !~ '(^[A-Za-z]:)|(^[\\/])|(\.\.)'),
  status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','FINALIZED','ABORTED','EXPIRED')),
  received_bytes     BIGINT NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  actual_sha256      TEXT NULL CHECK (actual_sha256 IS NULL OR actual_sha256 ~ '^[0-9a-f]{64}$'),
  failure_code       TEXT NULL CHECK (failure_code IS NULL OR failure_code ~ '^E_[A-Z0-9_]{2,60}$'),
  expires_at         timestamptz NOT NULL,
  finalized_at       timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_upload_sessions_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT worker_upload_sessions_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES generation_jobs (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_upload_sessions_token_uq ON worker_upload_sessions (token_digest);
-- At most ONE live (PENDING) upload session per attempt+kind: a worker cannot open a second writer.
CREATE UNIQUE INDEX IF NOT EXISTS worker_upload_sessions_live_uq
  ON worker_upload_sessions (workspace_id, generation_attempt_id, kind) WHERE status = 'PENDING';

DROP TRIGGER IF EXISTS worker_upload_sessions_touch ON worker_upload_sessions;
CREATE TRIGGER worker_upload_sessions_touch BEFORE UPDATE ON worker_upload_sessions
  FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();

ALTER TABLE worker_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_upload_sessions_select ON worker_upload_sessions FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY worker_upload_sessions_insert ON worker_upload_sessions FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY worker_upload_sessions_update ON worker_upload_sessions FOR UPDATE
  USING (workspace_id = current_setting('app.current_workspace', true))
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON worker_upload_sessions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON worker_upload_sessions TO cp_tenant_app;
GRANT SELECT ON worker_upload_sessions TO cp_ops_enumerator;

-- ============================ (4) execution provenance ============================
-- Which worker actually executed the attempt, and over which delivery path. Additive projection
-- columns only — the job state machine is untouched.
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS executed_by_worker_id TEXT COLLATE "C" NULL;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS delivery_mode TEXT NULL
  CHECK (delivery_mode IS NULL OR delivery_mode IN ('LOCAL','REMOTE'));
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS execution_host TEXT NULL;
CREATE INDEX IF NOT EXISTS generation_jobs_executor_idx
  ON generation_jobs (workspace_id, executed_by_worker_id) WHERE executed_by_worker_id IS NOT NULL;
