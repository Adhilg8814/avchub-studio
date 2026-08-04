-- P0 Step 5C.5 — 0014 Worker pairing + credential lifecycle columns.
--
-- WHY A NEW MIGRATION (0001–0013 frozen): 0004 created pairing_codes / worker_credentials /
-- workers as the pairing skeleton (id + verifier + expiry + attempts). The staging pairing +
-- credential-rotation/revocation flow needs a few more lifecycle/audit columns (status, purpose,
-- requested label, capabilities, operator attribution, max-attempts, revocation, revision;
-- credential lineage + revoke reason + grace; worker first-seen + disable). Those belong to this
-- step, so they land here rather than by editing a frozen migration. All are nullable/defaulted,
-- so a clean re-migrate is unaffected. The (worker_id) partial-unique-active-credential index and
-- one-active-session invariant from 0004 are preserved.
--
-- NO plaintext pairing code or credential is ever stored: pairing_codes.code_hash (0004) and
-- worker_credentials.credential_hash (0004) are peppered HMAC verifiers only.

SET search_path = public;

-- pairing_codes: reuse used_by_worker_id=consumed_by, used_at=consumed_at, attempts=failed_attempts.
ALTER TABLE pairing_codes
  ADD COLUMN status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','REVOKED','LOCKED')),
  ADD COLUMN purpose          TEXT NOT NULL DEFAULT 'WORKER_PAIRING',
  ADD COLUMN requested_label  TEXT NULL,
  ADD COLUMN capabilities     JSONB NULL,
  ADD COLUMN created_by_actor TEXT NULL,        -- operator actor id (service/user) — never a secret
  ADD COLUMN max_attempts     INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  ADD COLUMN revoked_at       timestamptz NULL,
  ADD COLUMN revision         INTEGER NOT NULL DEFAULT 0;

-- worker_credentials: rotation lineage + revoke reason + optional grace + revision.
ALTER TABLE worker_credentials
  ADD COLUMN rotated_from_credential_id TEXT COLLATE "C" NULL,
  ADD COLUMN revoke_reason              TEXT NULL,
  ADD COLUMN grace_until                timestamptz NULL,
  ADD COLUMN revision                   INTEGER NOT NULL DEFAULT 0;

-- workers: first-seen + explicit disable (status REVOKED remains the terminal state).
ALTER TABLE workers
  ADD COLUMN first_seen_at   timestamptz NULL,
  ADD COLUMN disabled_at     timestamptz NULL,
  ADD COLUMN disable_reason  TEXT NULL;

-- Active-code counting per workspace + fast verifier lookup at claim time.
CREATE INDEX ix_pairing_codes_ws_status ON pairing_codes (workspace_id, status) WHERE status = 'ACTIVE';
CREATE INDEX ix_pairing_codes_hash_active ON pairing_codes (code_hash) WHERE status = 'ACTIVE';
CREATE INDEX ix_worker_credentials_rotated_from ON worker_credentials (rotated_from_credential_id) WHERE rotated_from_credential_id IS NOT NULL;

-- Claim resolves the workspace by verifier BEFORE the workspace is known, so it reads pairing_codes
-- on the BYPASSRLS ops connection (SELECT ONLY; code_hash is a peppered HMAC verifier). The role
-- keeps read-only privilege and cannot mutate pairing rows.
GRANT SELECT ON pairing_codes TO cp_ops_enumerator;
