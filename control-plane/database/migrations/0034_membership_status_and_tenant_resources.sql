-- P0 Step 5C.29 Phase 6/7 — 0034 workspace membership status + dedicated tenant resource registry (ADDITIVE).
--
-- Phase 6: a per-membership status so a WORKSPACE_OWNER/ADMIN can SUSPEND a member's access to THIS workspace
-- without disabling the user's global account (a user may be an active member of other workspaces). The
-- access-path membership resolver cp_auth_user_memberships (0024) is narrowed to status='ACTIVE' so a suspended
-- (or removed) membership fails closed everywhere it is consulted: login active-workspace selection,
-- switchWorkspace, resolveAuthorization (the Gateway-PDP), and session re-resolution. The resolver keeps its
-- exact (workspace_id, role) return signature — no caller changes; suspended memberships simply disappear from
-- the access path. The full members LIST (which must show suspended members) reads workspace_members directly
-- under workspace RLS, so it still sees them.
--
-- Phase 7: workspace_resources — the server-side ownership registry for the dedicated-per-customer resource
-- chain (worker registration -> provider account -> Cloak profile -> proxy/network). Each row binds a resource
-- ref to exactly ONE workspace (workspace-RLS) AND is globally unique per (resource_type, resource_ref) so a
-- dedicated resource can never be bound to two customers. Enqueue/readiness resolve a resource ONLY through
-- this registry (RLS-scoped), so a tenant can never see, bind, or use another tenant's worker/provider/profile/
-- proxy. No provider secret is stored here — only the non-secret ref + status + label + metadata.
--
-- Frozen: migrations 0002-0030 + native-auth core are untouched. This migration is additive and forward-only;
-- workspace stays the SOLE RLS boundary (customer_id is never an RLS predicate).

SET search_path = public;

-- ---- Phase 6: membership status (default ACTIVE so every existing row is unaffected) ----
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_status_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_status_check CHECK (status IN ('ACTIVE','SUSPENDED'));

-- Narrow the access-path resolver to ACTIVE memberships (same signature; CREATE OR REPLACE keeps the grants).
-- A SUSPENDED/removed membership is invisible to every access decision -> fail closed, no fallback.
CREATE OR REPLACE FUNCTION cp_auth_user_memberships(p_user_id text)
RETURNS TABLE (workspace_id text, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT workspace_id, role FROM workspace_members
  WHERE user_id = p_user_id AND status = 'ACTIVE' ORDER BY created_at;
$$;

-- ---- Phase 7: dedicated tenant resource registry (workspace-RLS + global dedicated uniqueness) ----
CREATE TABLE IF NOT EXISTS workspace_resources (
  id            TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'wsrc')),
  workspace_id  TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('WORKER','PROVIDER_ACCOUNT','CLOAK_PROFILE','PROXY')),
  resource_ref  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DRAINING','DISABLED','SUSPENDED')),
  label         TEXT NULL,
  metadata      JSONB NULL CHECK (metadata IS NULL OR pg_column_size(metadata) <= 8192),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_resources_ws_ref_uq UNIQUE (workspace_id, resource_type, resource_ref)
);
-- Global dedicated ownership: a given (type, ref) belongs to EXACTLY ONE workspace — enforced at the storage
-- layer (constraint indexes are checked independent of RLS), so binding the SAME worker/provider/profile/proxy
-- to a second customer fails with a unique violation. This is the "dedicated, never shared" guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_resources_dedicated_uq ON workspace_resources (resource_type, resource_ref);
CREATE INDEX IF NOT EXISTS workspace_resources_ws_idx ON workspace_resources (workspace_id, resource_type);

ALTER TABLE workspace_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_resources_select ON workspace_resources FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY workspace_resources_insert ON workspace_resources FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY workspace_resources_update ON workspace_resources FOR UPDATE
  USING (workspace_id = current_setting('app.current_workspace', true))
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY workspace_resources_delete ON workspace_resources FOR DELETE
  USING (workspace_id = current_setting('app.current_workspace', true));

DROP TRIGGER IF EXISTS workspace_resources_touch ON workspace_resources;
CREATE TRIGGER workspace_resources_touch BEFORE UPDATE ON workspace_resources FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();

REVOKE ALL ON workspace_resources FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_resources TO cp_tenant_app;
GRANT SELECT ON workspace_resources TO cp_ops_enumerator;
