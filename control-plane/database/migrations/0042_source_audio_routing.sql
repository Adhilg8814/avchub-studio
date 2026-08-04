-- P0 Step 5C.45 — the audio decision, on the record.
--
-- Every Grok clip carries an audio track, and until now the pipeline synthesised narration over all of them
-- without listening once. Deciding whether to keep the clip's own sound is a judgement with a cost attached
-- in both directions, so it gets the same treatment as every other judgement in this system: an immutable,
-- content-hashed artifact naming what was measured and what was concluded.
--
-- Two kinds:
--   SOURCE_AUDIO_AUDIT      — what the clip's audio measures and what class it is. Facts about a file.
--   AUDIO_ROUTING_DECISION  — which narration source the scene uses, why, and whether ElevenLabs was skipped.
--
-- They are separate because they age differently. The measurements are true forever for a given file; the
-- decision changes the moment a transcript exists, a policy is set, or another scene in the same film
-- disagrees. Collapsing them would mean re-measuring audio to re-decide routing.

SET search_path = public;

ALTER TABLE movie_content_artifacts DROP CONSTRAINT IF EXISTS movie_content_artifacts_kind_check;
ALTER TABLE movie_content_artifacts ADD CONSTRAINT movie_content_artifacts_kind_check
  CHECK (kind IN (
    'ADAPTATION', 'CHARACTER_BIBLE', 'LOCATION_BIBLE', 'STYLE_BIBLE', 'BEAT_SHEET',
    'NARRATION_SCRIPT', 'NARRATION_AUDIO', 'AUDIO_ALIGNMENT', 'TRANSCRIPT_VERIFICATION',
    'SHOT_CONTRACT', 'SUBTITLE_TIMELINE', 'SCENE_VISION_VERDICT', 'SCENE_TECHNICAL_VERDICT',
    'MOVIE_SCORECARD', 'AUDIO_MIX_VERDICT',
    -- 5C.45
    'SOURCE_AUDIO_AUDIT', 'AUDIO_ROUTING_DECISION'
  ));

-- The film-wide narration source. A property of the FILM, not of a scene: a viewer notices a voice change
-- between shots immediately, so this is stored where it can be read once and applied to every scene.
ALTER TABLE movie_projects
  ADD COLUMN IF NOT EXISTS audio_policy TEXT NOT NULL DEFAULT 'AUTO'
    CHECK (audio_policy IN ('AUTO', 'PREFER_GROK_NATIVE', 'PREFER_ELEVENLABS', 'MUTE_GROK_SPEECH', 'KEEP_GROK_AMBIENCE')),
  ADD COLUMN IF NOT EXISTS narration_source TEXT NULL
    CHECK (narration_source IS NULL OR narration_source IN ('GROK', 'ELEVENLABS', 'NONE')),
  -- Set only when the format is deliberately multi-voice. Absent it, a film that cannot agree on one source
  -- falls back to the safe one rather than shipping three different voices.
  ADD COLUMN IF NOT EXISTS allow_mixed_voices BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN movie_projects.narration_source IS
  'Which voice the finished film uses. Null means not yet decided; it is never inferred from a scene.';
