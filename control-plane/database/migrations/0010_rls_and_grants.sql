-- P0 Step 5C.2 — 0010 Row-Level Security (ENABLE + FORCE, fail-closed) + role GRANTs.
--
-- Runs as cp_migrator (owner). Roles cp_tenant_app / cp_ops_enumerator / cp_readonly_observer
-- MUST already exist (created by database/bootstrap/roles.sql before migrating). Role names
-- are the canonical fixed names from the schema spec.
--
-- RLS predicate: workspace_id = current_setting('app.current_workspace', true). The `true`
-- (missing_ok) makes an UNSET setting return NULL → NULL = x is NULL/false → ZERO rows
-- (fail-closed). A malformed value simply matches no workspace_id → zero rows. FORCE makes
-- even a table owner subject to RLS.

SET search_path = public;

-- Defensive: strip any PUBLIC table privileges; grant explicitly below.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- ---- workspaces: the tenant boundary itself (id IS the workspace) -------------------------
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_select ON workspaces FOR SELECT
  USING (id = current_setting('app.current_workspace', true));
CREATE POLICY workspaces_update ON workspaces FOR UPDATE
  USING (id = current_setting('app.current_workspace', true))
  WITH CHECK (id = current_setting('app.current_workspace', true));
-- Onboarding creates a workspace by first setting app.current_workspace to the intended NEW
-- id, then inserting it. FORCE RLS applies to the owner too, so without this policy NO role
-- could ever create a workspace. The WITH CHECK keeps it scoped: a caller can only insert the
-- workspace whose id equals the (server-resolved) current context — never another tenant's.
CREATE POLICY workspaces_insert ON workspaces FOR INSERT
  WITH CHECK (id = current_setting('app.current_workspace', true));

-- ---- all other tenant tables (uniform workspace_id policies) ------------------------------
DO $rls$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'workspace_members','projects','episodes','shots','prompts','project_revisions',
    'project_worker_affinity','workers','worker_credentials','worker_capabilities',
    'worker_storage_status','worker_connection_sessions','worker_status_history','pairing_codes',
    'generation_requests','generation_attempts','jobs','job_offers','job_events',
    'job_recovery_reports','job_terminal_results','assets','asset_variants','asset_review_state',
    'asset_locality','asset_preview_refs','protocol_inbox','protocol_outbox','protocol_message_acks',
    'protocol_dedupe_tombstones','audit_events','rate_limit_buckets','paid_generation_approval_grants',
    'idempotency_keys'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$I_select ON %1$I FOR SELECT
      USING (workspace_id = current_setting('app.current_workspace', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_insert ON %1$I FOR INSERT
      WITH CHECK (workspace_id = current_setting('app.current_workspace', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_update ON %1$I FOR UPDATE
      USING (workspace_id = current_setting('app.current_workspace', true))
      WITH CHECK (workspace_id = current_setting('app.current_workspace', true))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$I_delete ON %1$I FOR DELETE
      USING (workspace_id = current_setting('app.current_workspace', true))$p$, t);
  END LOOP;
END
$rls$;

-- ---- GRANTs: cp_tenant_app (business CRUD; RLS still applies; NOBYPASSRLS) ----------------
DO $grants$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'workspaces','workspace_members','projects','episodes','shots','prompts','project_revisions',
    'project_worker_affinity','workers','worker_credentials','worker_capabilities',
    'worker_storage_status','worker_connection_sessions','worker_status_history','pairing_codes',
    'generation_requests','generation_attempts','jobs','job_offers','job_events',
    'job_recovery_reports','job_terminal_results','assets','asset_variants','asset_review_state',
    'asset_locality','asset_preview_refs','protocol_inbox','protocol_outbox','protocol_message_acks',
    'protocol_dedupe_tombstones','audit_events','rate_limit_buckets','paid_generation_approval_grants',
    'idempotency_keys','users'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO cp_tenant_app', t);
  END LOOP;
END
$grants$;
-- feature flags: read-only for evaluation (writes require platform operator, not this role).
GRANT SELECT ON feature_flags, feature_flag_targets TO cp_tenant_app;
GRANT SELECT ON feature_flag_kill_targets TO cp_tenant_app;
-- user_sessions/external auth read for future auth; no migration-table access ever.

-- ---- GRANTs: cp_ops_enumerator (SELECT-only on approved protocol/sweep tables) ------------
-- BYPASSRLS is a ROLE attribute (set in bootstrap); containment here = SELECT-only + a
-- minimal table set. It gets NO INSERT/UPDATE/DELETE anywhere → cannot mutate business state.
GRANT SELECT ON
  protocol_inbox, protocol_outbox, protocol_message_acks, protocol_dedupe_tombstones,
  worker_connection_sessions, job_offers, generation_attempts, jobs
  TO cp_ops_enumerator;

-- ---- GRANTs: cp_readonly_observer (schema version only; no payloads) ----------------------
GRANT SELECT ON cp_schema_migrations TO cp_readonly_observer;

-- Migration ledger: runtime roles may READ the schema version (for readiness) but NEVER
-- modify it. Only cp_migrator (owner) may INSERT/UPDATE/DELETE.
REVOKE ALL ON cp_schema_migrations FROM cp_tenant_app, cp_ops_enumerator;
GRANT SELECT ON cp_schema_migrations TO cp_tenant_app;
