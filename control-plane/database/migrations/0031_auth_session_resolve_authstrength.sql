-- P0 Step 5C.29 — 0031 §Q1 FIX (ADDITIVE, forward-only). The pre-context session resolver
-- cp_auth_session_resolve (created in 0022) returns mfa_authenticated_at but NOT auth_strength (added to
-- user_sessions in 0025). The Gateway-PDP path (auth-service.resolveAuthorization) therefore read a session
-- object with neither mfaAuthenticatedAt nor authStrength surfaced, making authenticatedWithMfa=false and
-- authStrength=null for EVERY session — so STRONG_AUTH / step-up routes authorized through the Gateway PDP
-- over-denied even for genuinely MFA-authenticated sessions (docs/STUDIO_PLATFORM_ADMIN_MULTITENANT_ARCHITECTURE_LOCK.md §Q1).
--
-- Fix: add auth_strength to the definer's projection so the resolver returns the full non-secret strength
-- state the PDP needs. RETURNS TABLE signature changes require DROP + CREATE (CREATE OR REPLACE cannot alter
-- the return type). The function stays SECURITY DEFINER / STABLE / search_path-pinned; EXECUTE is re-locked
-- to cp_tenant_app only (re-applying the 0029 posture, since DROP drops the grants). Still returns ONLY
-- non-secret fields; never the token hash. Nothing in 0001..0030 is altered on disk.
SET search_path = public;

DROP FUNCTION IF EXISTS cp_auth_session_resolve(text);

CREATE FUNCTION cp_auth_session_resolve(p_token_hash text)
RETURNS TABLE (
  id text, user_id text, expires_at timestamptz, absolute_expires_at timestamptz,
  revoked_at timestamptz, last_seen_at timestamptz, mfa_authenticated_at timestamptz,
  active_workspace_id text, csrf_hash text, auth_strength text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT id, user_id, expires_at, absolute_expires_at, revoked_at, last_seen_at,
         mfa_authenticated_at, active_workspace_id, csrf_hash, auth_strength
  FROM user_sessions WHERE token_hash = p_token_hash LIMIT 1;
$$;

-- Re-lock EXECUTE to the runtime role only (DROP cleared the 0022/0029 grants).
REVOKE EXECUTE ON FUNCTION cp_auth_session_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cp_auth_session_resolve(text) TO cp_tenant_app;
