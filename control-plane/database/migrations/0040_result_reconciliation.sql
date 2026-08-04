-- P0 Step 5C.43 — result reconciliation: settling "did the one irreversible click reach the provider".
--
-- A SUBMIT_UNCERTAIN job has spent its invocation and never seen a result. 5C.30 gave that state a review
-- ledger with three verdicts, which was enough while the only reviewer was a human looking at a screen. It is
-- not enough for an automated reader of the provider's own surface, because that reader can distinguish two
-- things a human summarised as "yes it was submitted":
--
--   the result EXISTS and can be downloaded, and
--   the submission was accepted and the provider has not finished rendering it.
--
-- Those lead to different actions — one completes the job from the asset, the other schedules another look —
-- so they get different verdicts rather than a shared one plus a note nobody parses. AMBIGUOUS_MULTIPLE_MATCHES
-- is the third addition and the most important: when six jobs typed the identical prompt, "I found a match" is
-- sometimes a lie, and the ledger must be able to say so instead of picking one.
--
-- The reconciliation table is the AUDIT. The review table stays the conclusion. Keeping them apart means a
-- reading can be recorded even when it concludes nothing, which is exactly the case that used to vanish.
--
-- Workspace remains the sole RLS boundary. No provider URL with a query string, no absolute path, no token:
-- the asset reference is a workspace-relative media path and a content hash.

SET search_path = public;

-- ============================ (A) the new verdicts ============================
-- CHECK constraints cannot be altered in place; drop and re-add with the wider set. Existing rows all carry
-- one of the original three, so the new constraint validates without rewriting any of them.
ALTER TABLE generation_uncertain_reviews DROP CONSTRAINT IF EXISTS generation_uncertain_reviews_verdict_check;
ALTER TABLE generation_uncertain_reviews ADD CONSTRAINT generation_uncertain_reviews_verdict_check
  CHECK (verdict IN (
    'CONFIRMED_SUBMITTED',                  -- 5C.30, kept: a human said so, and history is not rewritten
    'CONFIRMED_SUBMITTED_RESULT_FOUND',
    'CONFIRMED_SUBMITTED_RESULT_PENDING',
    'CONFIRMED_NOT_SUBMITTED',
    'AMBIGUOUS_MULTIPLE_MATCHES',
    'STILL_UNCERTAIN'
  ));

-- A reconciler run by the runtime is not an owner looking at a GUI, and the source has to say which it was.
ALTER TABLE generation_uncertain_reviews DROP CONSTRAINT IF EXISTS generation_uncertain_reviews_review_source_check;
ALTER TABLE generation_uncertain_reviews ADD CONSTRAINT generation_uncertain_reviews_review_source_check
  CHECK (review_source IN (
    'OWNER_PROVIDER_GUI_INSPECTION', 'PROVIDER_API_RECONCILE', 'OPERATOR_ASSERTION', 'AUTOMATED_RECONCILE',
    'PROVIDER_SURFACE_RECONCILE'            -- 5C.43: the runtime read the provider's own results surface
  ));

-- ============================ (B) the reconciliation audit ============================
CREATE TABLE IF NOT EXISTS generation_result_reconciliations (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'grrec')),
  workspace_id          TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  job_id                TEXT COLLATE "C" NOT NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  -- Keyed on WHAT WAS DECIDED, not on when: the same job against the same surface reading resolves to the
  -- same row, so a retried or restarted reconciliation cannot pile up duplicate conclusions.
  idempotency_key       TEXT NOT NULL CHECK (idempotency_key ~ '^sha256:[0-9a-f]{64}$'),
  state                 TEXT NOT NULL CHECK (state IN (
                          'CONFIRMED_SUBMITTED_RESULT_FOUND', 'CONFIRMED_SUBMITTED_RESULT_PENDING',
                          'CONFIRMED_NOT_SUBMITTED', 'AMBIGUOUS_MULTIPLE_MATCHES', 'STILL_UNCERTAIN')),
  reason                TEXT NOT NULL CHECK (length(reason) <= 64),
  -- 0..1. A conclusion drawn from a card whose time could not be read is worth less than one that was in a
  -- verified window, and collapsing the two would lose the only thing that says which is which.
  confidence            NUMERIC(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- WHERE we looked and WHEN, because an absence is only evidence when both are known.
  inspected_surface     TEXT NOT NULL CHECK (length(inspected_surface) <= 200 AND inspected_surface !~ '://'),
  inspected_at          timestamptz NOT NULL,
  submitted_at          timestamptz NULL,
  prompt_hash           TEXT NOT NULL CHECK (prompt_hash ~ '^sha256:[0-9a-f]{64}$'),
  match_method          TEXT NULL CHECK (match_method IS NULL OR match_method IN ('PROMPT_EXACT','PROMPT_PREFIX','PROMPT_CONTAINS','NONE')),
  matched_result_id     TEXT NULL CHECK (matched_result_id IS NULL OR length(matched_result_id) <= 120),
  -- Workspace-relative media path only; an absolute path or a provider URL is rejected outright.
  matched_asset_path    TEXT NULL CHECK (matched_asset_path IS NULL OR
                          (length(matched_asset_path) <= 300 AND matched_asset_path !~ '://' AND matched_asset_path !~ '^[A-Za-z]:' AND matched_asset_path !~ '^[\\/]' AND matched_asset_path !~ '\.\.')),
  matched_asset_sha256  TEXT NULL CHECK (matched_asset_sha256 IS NULL OR matched_asset_sha256 ~ '^[0-9a-f]{64}$'),
  -- Sanitized DOM/structure evidence: counts, match methods, ancestries, window arithmetic. Never a cookie,
  -- never a token, never a signed URL, and size-capped so a page cannot be accumulated here one row at a time.
  evidence              JSONB NOT NULL CHECK (pg_column_size(evidence) <= 16384),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_result_reconciliations_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES generation_jobs (workspace_id, id) ON DELETE CASCADE
);

-- Idempotency is per workspace, and it is what makes a duplicate reconciliation a no-op rather than a second
-- opinion.
CREATE UNIQUE INDEX IF NOT EXISTS generation_result_reconciliations_idem_uq
  ON generation_result_reconciliations (workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS generation_result_reconciliations_job_idx
  ON generation_result_reconciliations (workspace_id, job_id, created_at DESC);
-- One result may only be claimed by one job. A partial unique index makes the second claim fail loudly
-- instead of two jobs quietly completing from the same clip.
CREATE UNIQUE INDEX IF NOT EXISTS generation_result_reconciliations_result_uq
  ON generation_result_reconciliations (workspace_id, matched_result_id)
  WHERE matched_result_id IS NOT NULL AND state = 'CONFIRMED_SUBMITTED_RESULT_FOUND';

ALTER TABLE generation_result_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_result_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY generation_result_reconciliations_select ON generation_result_reconciliations FOR SELECT
  USING (workspace_id = current_setting('app.current_workspace', true));
CREATE POLICY generation_result_reconciliations_insert ON generation_result_reconciliations FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true));

REVOKE ALL ON generation_result_reconciliations FROM PUBLIC;
GRANT SELECT, INSERT ON generation_result_reconciliations TO cp_tenant_app;
GRANT SELECT ON generation_result_reconciliations TO cp_ops_enumerator;

-- Deliberately no UPDATE and no DELETE grant: a reconciliation is an observation, and an observation that can
-- be edited afterwards is not evidence. A later reading writes a new row with its own key.
