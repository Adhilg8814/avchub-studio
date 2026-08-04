-- P0 Step 5C.2 — 0009 correctness triggers/functions. Deterministic, no side effects, stable
-- names + SQLSTATEs. These are backstops; the primary "one paid owner" invariant is the
-- Phase-C transaction. SQLSTATE map: CP002 terminal-immutable, CP003 submission-monotonic,
-- CP004 project-delete-guard.

SET search_path = public;

-- ---- terminal-state immutability + submission freeze (generation_attempts) --------------
CREATE OR REPLACE FUNCTION cp_attempt_terminal_and_submission_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.terminal_state IS NOT NULL THEN
    -- terminal → non-terminal (clearing) is forbidden.
    IF NEW.terminal_state IS NULL THEN
      RAISE EXCEPTION 'terminal state cannot be cleared (attempt %)', OLD.id
        USING ERRCODE = 'CP002', CONSTRAINT = 'cp_attempt_terminal_immutable';
    END IF;
    -- terminal → a different terminal is forbidden.
    IF NEW.terminal_state <> OLD.terminal_state THEN
      RAISE EXCEPTION 'terminal state is immutable (% -> %)', OLD.terminal_state, NEW.terminal_state
        USING ERRCODE = 'CP002', CONSTRAINT = 'cp_attempt_terminal_immutable';
    END IF;
    -- submission facts are frozen once terminal.
    IF NEW.submission_state IS DISTINCT FROM OLD.submission_state
       OR NEW.provider_submission_id IS DISTINCT FROM OLD.provider_submission_id
       OR NEW.generation_ordinal IS DISTINCT FROM OLD.generation_ordinal THEN
      RAISE EXCEPTION 'submission facts frozen after terminal (attempt %)', OLD.id
        USING ERRCODE = 'CP002', CONSTRAINT = 'cp_attempt_submission_frozen';
    END IF;
  END IF;

  -- Submission monotonicity: never downgrade SUBMITTED/SUBMITTING back to NOT_SUBMITTED.
  IF (OLD.submission_state = 'SUBMITTED' AND NEW.submission_state <> 'SUBMITTED')
     OR (OLD.submission_state = 'SUBMITTING' AND NEW.submission_state = 'NOT_SUBMITTED') THEN
    RAISE EXCEPTION 'submission_state cannot regress (% -> %)', OLD.submission_state, NEW.submission_state
      USING ERRCODE = 'CP003', CONSTRAINT = 'cp_attempt_submission_monotonic';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER generation_attempts_guard
  BEFORE UPDATE ON generation_attempts
  FOR EACH ROW EXECUTE FUNCTION cp_attempt_terminal_and_submission_guard();

-- ---- project deletion guard --------------------------------------------------------------
-- Blocks hard-deleting a project while any of its generation attempts is unresolved
-- (terminal_state IS NULL) or possibly_submitted — paid-ownership evidence must survive.
CREATE OR REPLACE FUNCTION cp_project_delete_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM generation_attempts a
    JOIN generation_requests r
      ON r.id = a.generation_request_id AND r.workspace_id = a.workspace_id
    WHERE r.project_id = OLD.id
      AND r.workspace_id = OLD.workspace_id
      AND (a.terminal_state IS NULL OR a.possibly_submitted)
  ) THEN
    RAISE EXCEPTION 'cannot delete project with unresolved generation attempts (project %)', OLD.id
      USING ERRCODE = 'CP004', CONSTRAINT = 'cp_project_unresolved_attempts';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER projects_delete_guard
  BEFORE DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION cp_project_delete_guard();

-- ---- optimistic revision enforcement on collaborative rows -------------------------------
-- projects already has cp_enforce_revision (0003). shots is the other collaborative editing
-- surface in scope.
CREATE TRIGGER shots_revision BEFORE UPDATE ON shots FOR EACH ROW EXECUTE FUNCTION cp_enforce_revision();
