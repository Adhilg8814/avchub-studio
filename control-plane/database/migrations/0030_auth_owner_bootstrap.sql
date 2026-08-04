-- P0 Step 5C.23 — 0030 one-time first-owner bootstrap ceremony (ADDITIVE). The 0022 auth_bootstrap_tokens
-- table is only an operator authorization proof; the ACTUAL owner-creation ceremony needs a durable,
-- atomic, single-winner state machine that (a) never creates a partial owner/workspace/credential and (b)
-- never issues a privileged session before MFA is confirmed. This adds a SINGLETON `auth_bootstrap` row
-- that holds the transient candidate (email + argon2id password hash + AES-GCM TOTP ciphertext) between the
-- begin and confirm steps, and a narrow SECURITY DEFINER that answers "does any owner already exist?"
-- pre-context (workspace_members is workspace-RLS'd, so the NOBYPASSRLS runtime role could not see a
-- foreign-workspace OWNER on its own). Nothing in 0001..0029 is altered destructively. NOT applied to
-- production in this increment (production remains at 0021); validated only on disposable PostgreSQL.

SET search_path = public;

-- ---- singleton ceremony state machine (global, service-only; NO tenant rows until COMPLETED) --------
-- REQUIRED  -> no owner yet, ceremony available
-- IN_PROGRESS -> a candidate has claimed the ceremony and is enrolling TOTP (transient candidate held)
-- COMPLETED -> the first owner exists; the ceremony is permanently closed (candidate material cleared)
CREATE TABLE auth_bootstrap (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id = true),   -- exactly one row
  state                     text NOT NULL DEFAULT 'REQUIRED'
                              CHECK (state IN ('REQUIRED','IN_PROGRESS','COMPLETED')),
  ceremony_proof_hash       text NULL,          -- sha256 of the resume proof; NEVER plaintext
  proof_expires_at          timestamptz NULL,
  candidate_email           citext NULL,
  candidate_display_name    text NULL,
  candidate_password_hash   text NULL,          -- argon2id; transient, cleared on COMPLETED
  candidate_totp_ciphertext text NULL,          -- app-encrypted TOTP secret; transient, cleared on COMPLETED
  claimed_at                timestamptz NULL,
  claimed_ip                text NULL,
  owner_user_id             text COLLATE "C" NULL REFERENCES users(id) ON DELETE SET NULL,
  completed_at              timestamptz NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
-- seed the singleton in the REQUIRED state (idempotent).
INSERT INTO auth_bootstrap (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TRIGGER auth_bootstrap_touch BEFORE UPDATE ON auth_bootstrap
  FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();

-- Service-mediated exactly like auth_bootstrap_tokens / login_attempts (0022): no RLS, reachable only by
-- the runtime role; the auth service is its sole caller and enforces every gate server-side.
GRANT SELECT, INSERT, UPDATE ON auth_bootstrap TO cp_tenant_app;

-- ---- SECURITY DEFINER: pre-context "does any owner already exist?" ----------------------------------
-- workspace_members is ENABLE-not-FORCE and workspace-RLS'd; the NOBYPASSRLS runtime role cannot see an
-- OWNER membership in a workspace it has no context for. This definer (owned by cp_migrator, the migrations
-- role, never a runtime pool) answers the global question with a single narrow EXISTS and returns ONLY a
-- boolean — never any row data. EXECUTE is revoked from PUBLIC (PostgreSQL grants it by default) and given
-- ONLY to cp_tenant_app, matching the 0029 lockdown posture for every auth definer.
CREATE OR REPLACE FUNCTION cp_auth_owner_exists()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_members WHERE role = 'OWNER')
      OR EXISTS (SELECT 1 FROM auth_bootstrap WHERE state = 'COMPLETED');
$$;
REVOKE EXECUTE ON FUNCTION cp_auth_owner_exists() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cp_auth_owner_exists() TO cp_tenant_app;
