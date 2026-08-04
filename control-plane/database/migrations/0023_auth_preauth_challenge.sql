-- P0 Step 5C.21 — 0023 pre-auth MFA challenge (ADDITIVE). Between "password verified" and "session issued",
-- an OWNER/ADMIN (or any MFA-required user) holds a SHORT-LIVED, single-use, opaque challenge that grants
-- EXACTLY ONE capability: complete MFA verification or MFA enrollment. It is NOT a session, carries no Studio
-- data access, and is never placed in a session cookie. The DB stores only the sha256 hash of the challenge
-- token; it is looked up pre-context by that hash, so the table is service-mediated (non-RLS, like the other
-- bearer-token tables in 0022) and reachable only by the auth service role.

SET search_path = public;

CREATE TABLE pre_auth_challenges (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'pac')),
  user_id               TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash            TEXT NOT NULL,                 -- sha256 of the opaque challenge token; NEVER plaintext
  purpose               TEXT NOT NULL CHECK (purpose IN ('MFA','MFA_ENROLLMENT')),
  login_attempt_id      TEXT NULL,                     -- correlation label to the originating login attempt
  intended_workspace_id TEXT COLLATE "C" NULL REFERENCES workspaces(id) ON DELETE SET NULL,
  mfa_verified          boolean NOT NULL DEFAULT false, -- set true once the code/enrollment is confirmed
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz NULL,              -- one-time: set when exchanged for a session
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pre_auth_challenge_token_uq UNIQUE (token_hash)
);
CREATE INDEX pre_auth_challenges_user_idx ON pre_auth_challenges(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON pre_auth_challenges TO cp_tenant_app;
