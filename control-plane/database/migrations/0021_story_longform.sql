-- P0 Step 5C.16 (long-form) — additive long-form fields on the Story Factory (0001-0020 frozen).
--
-- Story generation moves from a single STORY stage to a section-based pipeline (act plan → section plan
-- → per-section prose → assemble → length gate → bounded expansion → edit). This migration is ADDITIVE:
-- new JSONB/scalar columns on story_projects (length target, story plan, per-section durable state, final
-- metrics, length-gate state, revision count) + widens the story_generation_attempts stage enum to cover
-- the new stages. No table is dropped or renamed; RLS/grants on story_projects are unchanged.

SET search_path = public;

ALTER TABLE story_projects
  ADD COLUMN IF NOT EXISTS length_preset     TEXT NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS custom_reading_minutes JSONB NULL,
  ADD COLUMN IF NOT EXISTS length_target     JSONB NULL,
  ADD COLUMN IF NOT EXISTS story_plan        JSONB NULL,   -- { acts:[...], sections:[...] }
  ADD COLUMN IF NOT EXISTS sections          JSONB NULL,   -- [{ ordinal,title,purpose,beatsCovered,targetWords,text,wordCount,state,attemptId,expandCount }]
  ADD COLUMN IF NOT EXISTS metrics           JSONB NULL,   -- computeStoryMetrics(...) of the final assembled story
  ADD COLUMN IF NOT EXISTS length_gate_state TEXT NULL,
  ADD COLUMN IF NOT EXISTS revision_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_run_id    TEXT COLLATE "C" NULL;

-- Widen the staged-attempt enum to cover the long-form stages (relaxing a CHECK is additive).
ALTER TABLE story_generation_attempts DROP CONSTRAINT IF EXISTS story_generation_attempts_stage_check;
ALTER TABLE story_generation_attempts ADD CONSTRAINT story_generation_attempts_stage_check
  CHECK (stage IN ('DNA','OUTLINE','STORY','EDIT','TITLE','METADATA','QUALITY','ACT_PLAN','SECTION_PLAN','SECTION','EXPAND'));
