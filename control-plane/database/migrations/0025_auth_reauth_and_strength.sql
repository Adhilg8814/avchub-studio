-- P0 Step 5C.21C — 0025 re-authentication proofs + session auth-strength (ADDITIVE).
--
-- (1) A recovery-code or password-only session is weaker than a fresh-TOTP session; record how a session
--     was authenticated (auth_strength) so sensitive actions can demand a stronger, RECENT proof.
-- (2) Sensitive actions (disable/reset MFA, regenerate recovery codes, change password with a stale
--     authTime) require a SHORT-LIVED, ONE-TIME, action-bound re-authentication proof — distinct from a
--     session (it grants no data access). The DB stores only the sha256 hash; it is looked up pre-context by
--     that hash, so the table is service-mediated (non-RLS, like the other bearer-token tables).

SET search_path = public;

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS auth_strength TEXT NULL; -- PASSWORD | MFA_TOTP | MFA_RECOVERY

CREATE TABLE reauth_proofs (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'rau')),
  user_id      TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   TEXT COLLATE "C" NULL,                 -- opaque ref to the initiating session (not FK: session may be revoked)
  token_hash   TEXT NOT NULL,                          -- sha256 of the opaque proof token; NEVER plaintext
  action       TEXT NOT NULL,                          -- DISABLE_MFA | REGENERATE_RECOVERY | REPLACE_TOTP | CHANGE_PASSWORD | ...
  method       TEXT NOT NULL CHECK (method IN ('PASSWORD','TOTP')),
  workspace_id TEXT COLLATE "C" NULL REFERENCES workspaces(id) ON DELETE SET NULL,
  verified     boolean NOT NULL DEFAULT false,         -- set true once the password/TOTP step succeeds
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz NULL,                        -- one-time: set when the sensitive action redeems it
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reauth_proof_token_uq UNIQUE (token_hash)
);
CREATE INDEX reauth_proofs_user_idx ON reauth_proofs(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON reauth_proofs TO cp_tenant_app;
