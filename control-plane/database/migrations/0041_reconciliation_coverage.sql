-- P0 Step 5C.44 — how far back the reconciler could actually see.
--
-- 5C.43 recorded WHAT each reconciliation concluded. It could not record the one thing that decides whether a
-- CONFIRMED_NOT_SUBMITTED is worth anything: whether the history it read reaches back past the moment the
-- submit click happened. Without that on the row, "no result matched" and "we never looked that far back"
-- are the same sentence, and only one of them is evidence.
--
-- Columns rather than another JSON blob because these four are read to DECIDE, not to explain. A rule that
-- depends on a value buried in an evidence document is a rule nobody can query.

SET search_path = public;

ALTER TABLE generation_result_reconciliations
  ADD COLUMN IF NOT EXISTS coverage_earliest_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS coverage_latest_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS coverage_results_read  integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coverage_results_timed integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coverage_contains_submit boolean   NOT NULL DEFAULT false,
  -- Where the prompt that was matched came from: a network payload, the page's embedded state, or the
  -- rendered DOM. A match on a paragraph scraped off a page is not the same claim as a match on the
  -- provider's own record of what was submitted, and the ledger must be able to say which it was.
  ADD COLUMN IF NOT EXISTS prompt_evidence_source text        NULL
    CHECK (prompt_evidence_source IS NULL OR length(prompt_evidence_source) <= 120);

-- An absence can only be asserted from a history that brackets the click. Enforced here so no future caller
-- can write the conclusion without the evidence that licenses it.
ALTER TABLE generation_result_reconciliations
  DROP CONSTRAINT IF EXISTS generation_result_reconciliations_absence_needs_coverage;
ALTER TABLE generation_result_reconciliations
  ADD CONSTRAINT generation_result_reconciliations_absence_needs_coverage
  CHECK (state <> 'CONFIRMED_NOT_SUBMITTED' OR coverage_contains_submit = true);

CREATE INDEX IF NOT EXISTS generation_result_reconciliations_coverage_idx
  ON generation_result_reconciliations (workspace_id, coverage_contains_submit, created_at DESC);
