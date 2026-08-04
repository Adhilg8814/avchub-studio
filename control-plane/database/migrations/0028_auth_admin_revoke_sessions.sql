-- P0 Step 5C.21D — 0028 admin-initiated session revocation (ADDITIVE). A role change / membership revoke /
-- user disable / ownership transfer must immediately kill the TARGET user's sessions, but user_sessions is
-- RLS-isolated by app.current_user (the actor, not the target). A single narrow SECURITY DEFINER — owned by
-- cp_migrator, and user_sessions is ENABLE-not-FORCE (0022) so the owner bypasses RLS — revokes exactly the
-- target's live sessions and returns the count. It can ONLY revoke (set revoked_at); it never reads or
-- returns session data. The auth service calls it strictly after an OWNER/ADMIN authorization check.

SET search_path = public;

CREATE OR REPLACE FUNCTION cp_auth_admin_revoke_sessions(p_user_id text, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE user_sessions SET revoked_at = now(), revoked_reason = p_reason
    WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION cp_auth_admin_revoke_sessions(text, text) TO cp_tenant_app;
