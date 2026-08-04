-- P0 Step 5C.48 — one provider invocation per shot-contract revision, as a database fact.
--
-- A targeted repair writes a NEW shot-contract revision and then asks Grok Imagine for one clip from it. The
-- ledger recorded which revision the repair was DECIDED from (shot_contract_id) but not which one it
-- PRODUCED, so nothing could answer the question that matters after a crash: has this revision already been
-- generated? Recovery had to guess, and both guesses are wrong — re-submitting buys the same clip twice,
-- refusing forever leaves the film with the shot the judge rejected.
--
-- generated_contract_id closes that. It is the revision the repair actually enqueued, written in the same
-- transaction as the SUBMITTED state, and unique across the workspace: a second invocation for the same
-- revision cannot be recorded, so it cannot happen unnoticed.

SET search_path = public;

ALTER TABLE movie_shot_repairs ADD COLUMN IF NOT EXISTS generated_contract_id text NULL
  REFERENCES movie_content_artifacts (id);

-- The whole point: a revision is generated at most once. A partial index so the many NULLs (claimed but not
-- yet submitted) do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS movie_shot_repairs_generated_contract_uk
  ON movie_shot_repairs (workspace_id, generated_contract_id)
  WHERE generated_contract_id IS NOT NULL;

-- Recovery reads by lease, so it must be able to find an abandoned claim without scanning the table.
CREATE INDEX IF NOT EXISTS movie_shot_repairs_inflight_lookup
  ON movie_shot_repairs (workspace_id, movie_project_id, scene_id, state);

COMMENT ON COLUMN movie_shot_repairs.generated_contract_id IS
  'The shot-contract revision this repair enqueued a generation for. Unique per workspace: one provider invocation per revision.';
