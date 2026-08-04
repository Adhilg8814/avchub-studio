-- P0 Step 5C.21B — 0024 login-time membership resolver (ADDITIVE). Login must enumerate a user's
-- workspace memberships BEFORE any workspace context exists (to pick the active workspace + decide MFA
-- policy), but workspace_members is workspace-RLS'd on app.current_workspace, so a cross-workspace read is
-- impossible pre-context. Mirror the cp_auth_session_resolve pattern: relax workspace_members from FORCE to
-- plain ENABLE so the cp_migrator-owned SECURITY DEFINER below can read it, while the runtime role
-- cp_tenant_app (a non-owner, NOBYPASSRLS) stays FULLY RLS-bound (FORCE only ever affected the owner, which
-- is the migrations role — never a runtime pool). No runtime role gains any new access.

SET search_path = public;

ALTER TABLE workspace_members NO FORCE ROW LEVEL SECURITY;

-- Return a user's memberships (workspace_id + role) with NO workspace context. STABLE; search_path pinned.
CREATE OR REPLACE FUNCTION cp_auth_user_memberships(p_user_id text)
RETURNS TABLE (workspace_id text, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT workspace_id, role FROM workspace_members WHERE user_id = p_user_id ORDER BY created_at;
$$;

GRANT EXECUTE ON FUNCTION cp_auth_user_memberships(text) TO cp_tenant_app;
