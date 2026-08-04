-- P0 Step 5C.6 — 0015 Project staging fields (description + generation defaults).
--
-- WHY A NEW MIGRATION (0001–0014 frozen): the staging Project/Generation/Job/Result APIs need a
-- human-editable project `description` and project-level generation DEFAULTS (aspect ratio, default
-- duration, output format) to pre-fill generation requests. 0003 created `projects` with title /
-- status / revision / storage_relative_root / archived_at but no free-form description or a safe
-- settings bag. Both are nullable, so a clean re-migrate is unaffected. Revision history + per-
-- revision config continue to live in the existing `project_revisions.diff` (jsonb); the paid-
-- generation ownership tables (generation_attempts / jobs / job_offers) are unchanged.
--
-- SAFETY: `default_settings` is a SAFE knob bag ONLY (aspectRatio / durationSeconds / outputFormat /
-- prompt defaults). It never stores provider URLs, credentials, or absolute paths — the API layer
-- validates and rejects those before persistence. No new grants: `projects` already carries
-- cp_tenant_app CRUD + RLS FORCE (0010); cp_ops_enumerator is intentionally NOT granted projects
-- access (the staging API reads/writes only on the RLS tenant connection).

SET search_path = public;

ALTER TABLE projects
  ADD COLUMN description      TEXT NULL,
  ADD COLUMN default_settings JSONB NULL;
