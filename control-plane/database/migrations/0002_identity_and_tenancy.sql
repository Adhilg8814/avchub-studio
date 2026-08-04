-- P0 Step 5C.2 — 0002 identity & tenancy: users, workspaces, memberships, external auth,
-- user_sessions. No human-authentication logic is implemented (schema only).

SET search_path = public;

CREATE TABLE users (
  id                TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'usr')),
  email             CITEXT NOT NULL,
  password_hash     TEXT NULL,                 -- argon2id; NULL if external auth
  external_auth_id  TEXT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('ACTIVE','DISABLED','PENDING')),
  email_verified_at timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  disabled_at       timestamptz NULL,
  CONSTRAINT users_email_uq UNIQUE (email),
  CONSTRAINT users_external_auth_uq UNIQUE (external_auth_id)
);

CREATE TABLE workspaces (
  id            TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'ws')),
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'FREE',
  owner_user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz NULL
);

-- Composite unique used as a target for cross-workspace composite FKs (17. cross-workspace
-- integrity): a child row's (workspace_id, id) must resolve to a workspace whose id matches.
ALTER TABLE workspaces ADD CONSTRAINT workspaces_id_self_uq UNIQUE (id);

CREATE TABLE workspace_members (
  id           TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'mship')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id      TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role         TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','EDITOR','REVIEWER','VIEWER','BILLING_OWNER')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_members_uq UNIQUE (workspace_id, user_id)
);

CREATE TABLE external_auth_identities (
  id         TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'eauth')),
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_auth_provider_subject_uq UNIQUE (provider, subject)
);

CREATE TABLE user_sessions (
  id         TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'sess')),
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,                    -- never plaintext; never a Worker credential
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  ip_address INET NULL,
  user_agent TEXT NULL
);

-- updated_at triggers.
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
CREATE TRIGGER workspaces_touch BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
CREATE TRIGGER workspace_members_touch BEFORE UPDATE ON workspace_members FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
