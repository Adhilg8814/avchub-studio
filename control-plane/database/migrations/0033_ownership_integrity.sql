-- P0 Step 5C.29 Phase 1 — 0033 ownership integrity (ADDITIVE, forward-only, idempotent).
-- docs/STUDIO_PLATFORM_ADMIN_MULTITENANT_ARCHITECTURE_LOCK.md §O1/§O2/§R12/§R13.
--   §R12  a DB-level guard so a workspace can never reach zero OWNER members (previously application-only).
--   §R13  workspace_members OWNER role is the authoritative owner fact; reconcile workspaces.owner_user_id
--         from it (the data-workspace adoption legitimately left owner_user_id stale).
-- Safe on a fresh DB (no workspaces/members -> the reconcile is a no-op; the trigger never fires until a
-- member row changes). Nothing in 0002..0032 is altered on disk. This migration carries NO production-
-- specific data backfill (customer/platform-owner linkage is a separate rehearsed idempotent script).
SET search_path = public;

-- ---- owner-guard: a workspace with any members MUST retain at least one OWNER (§R12) -----------------
-- SECURITY DEFINER (owner-owned) so it reads ALL members of the affected workspace regardless of the caller's
-- app.current_workspace RLS context (workspace_members is ENABLE-not-FORCE, so the owner bypasses RLS).
-- DEFERRABLE INITIALLY DEFERRED: the check runs at COMMIT, so multi-step transactions (e.g. transferOwnership
-- promoting the target then demoting the old owner) are valid at their intermediate states.
CREATE OR REPLACE FUNCTION cp_assert_workspace_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ws text;
BEGIN
  ws := COALESCE(NEW.workspace_id, OLD.workspace_id);
  IF EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ws)
     AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ws AND role = 'OWNER') THEN
    RAISE EXCEPTION 'workspace % must retain at least one OWNER member', ws USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION cp_assert_workspace_owner() FROM PUBLIC;

-- CONSTRAINT TRIGGER supports only AFTER + FOR EACH ROW; DEFERRABLE lets it fire at commit. Fires on the
-- operations that can REMOVE the last owner (role demotion via UPDATE, or DELETE). INSERT can only add an
-- owner, so it is not guarded (cheaper, and a fresh workspace's first OWNER insert always satisfies it).
DROP TRIGGER IF EXISTS workspace_members_owner_guard ON workspace_members;
CREATE CONSTRAINT TRIGGER workspace_members_owner_guard
  AFTER UPDATE OR DELETE ON workspace_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cp_assert_workspace_owner();

-- ---- reconcile workspaces.owner_user_id from the authoritative OWNER membership (§R13, idempotent) ----
-- For every workspace that has an OWNER member, set owner_user_id to the earliest OWNER (deterministic).
-- Runs under the migrator (owner) which bypasses the ENABLE-not-FORCE RLS on both tables. No-op on a DB
-- with no OWNER memberships. Re-running produces the identical result.
UPDATE workspaces w
   SET owner_user_id = sub.uid
  FROM (
    SELECT DISTINCT ON (workspace_id) workspace_id, user_id AS uid
      FROM workspace_members WHERE role = 'OWNER'
      ORDER BY workspace_id, created_at, user_id
  ) sub
 WHERE sub.workspace_id = w.id
   AND (w.owner_user_id IS DISTINCT FROM sub.uid);
