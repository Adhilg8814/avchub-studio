-- P0 Step 5C.21E — 0029 lock down EXECUTE on the auth SECURITY DEFINER functions (ADDITIVE, grant-only).
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so 0022/0024/0028 left the auth definers
-- callable by EVERY role — including the SELECT-only cp_ops_enumerator and cp_readonly_observer. That is a
-- privilege gap: cp_auth_admin_revoke_sessions is a VOLATILE definer, so a "read-only" role could revoke any
-- user's sessions through it. Revoke PUBLIC and grant EXECUTE to cp_tenant_app ALONE (the only role the auth
-- service runs as). No behavior change for the auth service; a hardening only.

SET search_path = public;

REVOKE EXECUTE ON FUNCTION cp_auth_session_resolve(text)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cp_auth_user_memberships(text)         FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cp_auth_admin_revoke_sessions(text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION cp_auth_session_resolve(text)          TO cp_tenant_app;
GRANT EXECUTE ON FUNCTION cp_auth_user_memberships(text)         TO cp_tenant_app;
GRANT EXECUTE ON FUNCTION cp_auth_admin_revoke_sessions(text,text) TO cp_tenant_app;
