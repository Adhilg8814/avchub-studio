-- P0 Step 5C.4 — 0013 WebSocket Gateway connection-session fields + auth-lookup grants.
--
-- WHY A NEW MIGRATION (0001–0012 frozen): 0004 created worker_connection_sessions as the
-- advisory session row (id/status/gateway_instance/resume_token_hash/last_seen_at). The
-- production Gateway needs a few more fencing/audit columns (connection epoch, authenticated_at,
-- health/disconnect timestamps + reason, supersede lineage, the credential id used, negotiated
-- protocol/client version, a PRIVACY-SAFE remote label) — those belong to the Gateway step, so
-- they land here rather than by editing a frozen migration. All are nullable / defaulted, so a
-- clean re-migrate is unaffected.
--
-- The session STATUS vocabulary ('ACTIVE','SUPERSEDED','CLOSED') is UNCHANGED (0004). Connection
-- HEALTH (degraded/offline) is tracked by workers.status + degraded_at/disconnected_at here.
-- One ACTIVE session per worker is still guaranteed by worker_sessions_one_active_uq (0004).
--
-- No plaintext credentials / resume tokens / Authorization headers / cookies / IPs are stored:
-- credential_id is the worker_credentials id (a verifier row), resume_token_hash (0004) is a
-- verifier only, and remote_summary carries only a coarse non-PII label (e.g. 'loopback').

SET search_path = public;

ALTER TABLE worker_connection_sessions
  ADD COLUMN connection_epoch        INTEGER NOT NULL DEFAULT 0,   -- monotonic per worker; fences a socket generation
  ADD COLUMN authenticated_at        timestamptz NULL,
  ADD COLUMN degraded_at             timestamptz NULL,             -- heartbeat health transition
  ADD COLUMN disconnected_at         timestamptz NULL,
  ADD COLUMN disconnect_reason       TEXT NULL,                    -- safe reason code (never SQL/creds)
  ADD COLUMN superseded_by_session_id TEXT COLLATE "C" NULL,       -- lineage when replaced by a newer connection
  ADD COLUMN credential_id           TEXT COLLATE "C" NULL,        -- worker_credentials.id used to authenticate (never plaintext)
  ADD COLUMN protocol_version        INTEGER NULL,
  ADD COLUMN client_version          TEXT NULL,
  ADD COLUMN remote_summary          TEXT NULL;                    -- coarse non-PII label only ('loopback'/'remote')

-- Enumerate sessions this Gateway instance owns; recover leased sessions after an instance crash.
CREATE INDEX ix_worker_sessions_instance ON worker_connection_sessions (gateway_instance, status);
CREATE INDEX ix_worker_sessions_active_seen ON worker_connection_sessions (last_seen_at) WHERE status = 'ACTIVE';

-- Credential AUTHENTICATION needs a cross-workspace lookup by verifier BEFORE the workspace is
-- known, so it runs on the BYPASSRLS ops-enumerator connection with SELECT-only access to the
-- verifier rows it must read for auth (credential_hash is a peppered HMAC verifier, not a
-- recoverable secret). The role keeps read-only privilege everywhere and cannot mutate sessions.
GRANT SELECT ON worker_credentials, workers TO cp_ops_enumerator;

-- Fast verifier lookup during authentication (active credentials only).
CREATE INDEX ix_worker_credentials_hash ON worker_credentials (credential_hash) WHERE status = 'ACTIVE';
