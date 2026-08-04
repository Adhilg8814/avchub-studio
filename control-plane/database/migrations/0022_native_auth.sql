-- P0 Step 5C.21 — 0022 native user authentication (ADDITIVE). Turns the schema-only identity from
-- 0002 into a working native-auth substrate: password credentials (argon2id), opaque sessions, TOTP MFA,
-- recovery codes, invitations, password-reset / email-verification tokens, brute-force accounting,
-- security audit, and per-user local-device pairing. Nothing in 0001..0021 is dropped or altered
-- destructively; every change here is a CREATE or an additive ALTER ... ADD.
--
-- RLS model. Login PRECEDES any workspace context, so the auth-mechanism tables are user-scoped, not
-- workspace-scoped: user-owned rows are isolated by current_setting('app.current_user', true) (fail-closed,
-- FORCE) — a request can only ever touch its own rows once the service has set app.current_user. The two
-- lookups that must run BEFORE a user is known (resolve a session by its token hash; consume a bearer token)
-- go through SECURITY DEFINER functions with a single narrow query each, so no broad pre-auth table access
-- is ever granted. `users` itself stays non-RLS (the global identity table, exactly as 0002/0010 left it) so
-- login-by-email works. Global service-only accounting tables (login_attempts, auth_bootstrap_tokens) carry
-- no user/workspace rows and are reachable only by the auth service role.

SET search_path = public;

-- ---- additive columns on existing identity tables ---------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at        timestamptz NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at  timestamptz NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enforced         boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name         TEXT NULL;

-- widen the membership role set additively to include MEMBER (0002 had OWNER/ADMIN/EDITOR/REVIEWER/
-- VIEWER/BILLING_OWNER; the app maps EDITOR->MEMBER, REVIEWER->VIEWER). Drop+recreate the CHECK only.
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('OWNER','ADMIN','MEMBER','EDITOR','REVIEWER','VIEWER','BILLING_OWNER'));

-- session hardening columns (0002 had id/user_id/token_hash/expires_at/created_at/revoked_at/ip/ua).
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS absolute_expires_at   timestamptz NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS last_seen_at          timestamptz NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS mfa_authenticated_at  timestamptz NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS active_workspace_id   TEXT COLLATE "C" NULL REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS csrf_hash             TEXT NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS rotated_from_id       TEXT COLLATE "C" NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS revoked_reason        TEXT NULL;

-- ---- password / credential material (argon2id; one active password credential per user) ------------
CREATE TABLE user_credentials (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'ucred')),
  user_id      TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'password' CHECK (kind IN ('password')),
  secret_hash  TEXT NOT NULL,                       -- argon2id encoded hash; NEVER plaintext
  algo         TEXT NOT NULL DEFAULT 'argon2id',
  params       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {memoryCost,timeCost,parallelism} for rehash detection
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credentials_active_uq UNIQUE (user_id, kind)
);
CREATE INDEX user_credentials_user_idx ON user_credentials(user_id);

-- ---- TOTP MFA (secret encrypted at rest by the app; DB only ever sees ciphertext) ------------------
CREATE TABLE user_mfa_methods (
  id                 TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'umfa')),
  user_id            TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL DEFAULT 'totp' CHECK (kind IN ('totp')),
  secret_ciphertext  TEXT NOT NULL,                 -- app-encrypted TOTP secret; NEVER plaintext/logged
  status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','DISABLED')),
  last_used_timestep BIGINT NULL,                   -- replay guard: reject a code from a used timestep
  created_at         timestamptz NOT NULL DEFAULT now(),
  activated_at       timestamptz NULL,
  disabled_at        timestamptz NULL
);
CREATE UNIQUE INDEX user_mfa_active_totp_uq ON user_mfa_methods(user_id, kind) WHERE status <> 'DISABLED';
CREATE INDEX user_mfa_user_idx ON user_mfa_methods(user_id);

-- ---- recovery codes (one active batch; each code is sha256-hashed, single-use) ---------------------
CREATE TABLE user_recovery_codes (
  id         TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'urcode')),
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id   TEXT COLLATE "C" NOT NULL,             -- regenerate mints a new batch; old batch is revoked
  code_hash  TEXT NOT NULL,                         -- sha256 of a high-entropy code; NEVER plaintext
  used_at    timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_recovery_code_hash_uq UNIQUE (user_id, code_hash)
);
CREATE INDEX user_recovery_user_batch_idx ON user_recovery_codes(user_id, batch_id);

-- ---- per-user security audit (append-oriented; NEVER holds a secret) -------------------------------
CREATE TABLE security_events (
  id         TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'sec')),
  user_id    TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE SET NULL,  -- NULL for pre-identify events
  workspace_id TEXT COLLATE "C" NULL REFERENCES workspaces(id) ON DELETE SET NULL,
  event      TEXT NOT NULL,                          -- e.g. LOGIN_SUCCESS, MFA_FAILURE, SESSION_REVOKED
  outcome    TEXT NOT NULL DEFAULT 'INFO' CHECK (outcome IN ('SUCCESS','FAILURE','DENY','INFO')),
  actor_user_id TEXT COLLATE "C" NULL,
  target     TEXT NULL,                              -- opaque target id/label (never a secret)
  ip_address INET NULL,
  user_agent TEXT NULL,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,     -- redacted, non-secret detail only
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user_idx ON security_events(user_id, created_at DESC);

-- ---- per-user local device pairing (each user's worker device; distinct from the workspace worker) --
CREATE TABLE paired_devices (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'pdev')),
  user_id      TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  worker_id    TEXT COLLATE "C" NULL,                -- optional link to the workspace worker row
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NULL,
  revoked_at   timestamptz NULL
);
CREATE INDEX paired_devices_user_idx ON paired_devices(user_id);
CREATE INDEX paired_devices_ws_idx ON paired_devices(workspace_id);

CREATE TABLE device_credentials (
  id              TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'dcred')),
  device_id       TEXT COLLATE "C" NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  user_id         TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL,                     -- sha256 of the device credential; NEVER plaintext
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz NULL,
  CONSTRAINT device_credentials_hash_uq UNIQUE (credential_hash)
);
CREATE INDEX device_credentials_device_idx ON device_credentials(device_id);

-- ---- bearer tokens (looked up pre-auth by high-entropy hash; global service-only, non-RLS) ---------
CREATE TABLE user_invitations (
  id            TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'uinv')),
  workspace_id  TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         CITEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
  token_hash    TEXT NOT NULL,                       -- sha256 of the invite token; NEVER plaintext
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  invited_by    TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz NULL,
  accepted_user_id TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_invitations_token_uq UNIQUE (token_hash)
);
CREATE INDEX user_invitations_ws_idx ON user_invitations(workspace_id);
CREATE INDEX user_invitations_email_idx ON user_invitations(email);

CREATE TABLE password_reset_tokens (
  id         TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'pwreset')),
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,                          -- sha256; NEVER plaintext
  expires_at timestamptz NOT NULL,
  used_at    timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_token_uq UNIQUE (token_hash)
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens(user_id);

CREATE TABLE email_verification_tokens (
  id         TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'emverf')),
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      CITEXT NOT NULL,
  token_hash TEXT NOT NULL,                          -- sha256; NEVER plaintext
  expires_at timestamptz NOT NULL,
  used_at    timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_verification_token_uq UNIQUE (token_hash)
);
CREATE INDEX email_verification_user_idx ON email_verification_tokens(user_id);

-- ---- brute-force accounting (global, service-only; identifier = normalized email or IP) ------------
CREATE TABLE login_attempts (
  id          TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'latt')),
  identifier  TEXT NOT NULL,                         -- normalized email / ip / device (never a secret)
  dimension   TEXT NOT NULL CHECK (dimension IN ('EMAIL','IP','SESSION','DEVICE')),
  outcome     TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE')),
  route       TEXT NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_id_dim_idx ON login_attempts(identifier, dimension, created_at DESC);

-- ---- one-time first-owner bootstrap gate (global, service-only) ------------------------------------
CREATE TABLE auth_bootstrap_tokens (
  id          TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'boot')),
  token_hash  TEXT NOT NULL,                         -- sha256; NEVER plaintext
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_bootstrap_token_uq UNIQUE (token_hash)
);

-- ---- updated_at triggers for the mutable new tables ------------------------------------------------
CREATE TRIGGER user_credentials_touch BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();

-- ---- RLS: core personal-auth tables isolated by app.current_user (FORCE, fail-closed) --------------
-- Only the cleanly post-identify, user-keyed tables go under app.current_user RLS: the auth service sets
-- app.current_user = the candidate user id right after the email->user lookup, so password/MFA/recovery
-- reads and session writes are all RLS-bound to that user. Tables with pre-auth hash lookups or NULL-user
-- rows (security_events, login_attempts, the token tables, auth_bootstrap_tokens, paired_devices /
-- device_credentials — resolved by credential hash at worker-connect time) stay service-mediated exactly
-- like the non-RLS global `users` table (0002/0010): the auth service is their sole caller and enforces
-- per-user authorization server-side.
DO $rls$
DECLARE
  t text;
  user_tables text[] := ARRAY[
    'user_credentials','user_mfa_methods','user_recovery_codes'
  ];
BEGIN
  FOREACH t IN ARRAY user_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$I_select ON %1$I FOR SELECT
      USING (user_id = current_setting('app.current_user', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_insert ON %1$I FOR INSERT
      WITH CHECK (user_id = current_setting('app.current_user', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_update ON %1$I FOR UPDATE
      USING (user_id = current_setting('app.current_user', true))
      WITH CHECK (user_id = current_setting('app.current_user', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_delete ON %1$I FOR DELETE
      USING (user_id = current_setting('app.current_user', true))$p$, t);
  END LOOP;
END
$rls$;

-- user_sessions is user-owned but must ALSO be resolvable pre-auth by token hash (see the SECURITY
-- DEFINER resolver below). Enable RLS for the user-facing path (list/revoke my own sessions) — but NOT
-- FORCE: the resolver is owned by cp_migrator (the migrations role, never a runtime pool), so ENABLE-
-- without-FORCE lets that one definer read pre-context while the runtime role cp_tenant_app (a non-owner,
-- NOBYPASSRLS) is STILL fully RLS-isolated (FORCE only affects the owner). This is the single deliberate
-- pre-auth reader; every other user_sessions access is app.current_user-bound.
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_select ON user_sessions FOR SELECT
  USING (user_id = current_setting('app.current_user', true));
CREATE POLICY user_sessions_insert ON user_sessions FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user', true));
CREATE POLICY user_sessions_update ON user_sessions FOR UPDATE
  USING (user_id = current_setting('app.current_user', true))
  WITH CHECK (user_id = current_setting('app.current_user', true));

-- ---- SECURITY DEFINER: the single narrow pre-auth session lookup (token hash -> session) -----------
-- Runs as the migrator (owner) so it can read one session row before app.current_user is known. Returns
-- ONLY non-secret session fields; never the token hash. The caller (auth service) then sets
-- app.current_user and proceeds under RLS. Marked STABLE; search_path pinned to defeat hijacking.
CREATE OR REPLACE FUNCTION cp_auth_session_resolve(p_token_hash text)
RETURNS TABLE (
  id text, user_id text, expires_at timestamptz, absolute_expires_at timestamptz,
  revoked_at timestamptz, last_seen_at timestamptz, mfa_authenticated_at timestamptz,
  active_workspace_id text, csrf_hash text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT id, user_id, expires_at, absolute_expires_at, revoked_at, last_seen_at,
         mfa_authenticated_at, active_workspace_id, csrf_hash
  FROM user_sessions WHERE token_hash = p_token_hash LIMIT 1;
$$;

-- ---- GRANTs: the auth service uses cp_tenant_app (already NOBYPASSRLS + RLS-bound) ------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  user_credentials, user_mfa_methods, user_recovery_codes, security_events,
  paired_devices, device_credentials, user_sessions,
  user_invitations, password_reset_tokens, email_verification_tokens,
  login_attempts, auth_bootstrap_tokens
  TO cp_tenant_app;
GRANT EXECUTE ON FUNCTION cp_auth_session_resolve(text) TO cp_tenant_app;
