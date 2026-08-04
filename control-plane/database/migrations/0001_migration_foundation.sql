-- P0 Step 5C.2 — 0001 migration foundation: shared IMMUTABLE helpers + trigger functions.
-- Applied by cp_migrator inside a transaction. No CREATE ROLE / CREATE DATABASE here
-- (those are non-transactional and live in database/bootstrap/*).
--
-- Conventions (docs/control-plane-postgres-schema.md): prefixed-ULID TEXT COLLATE "C",
-- timestamptz UTC, fail-closed RLS, RESTRICT on paid-ownership evidence.

-- Fixed, safe search_path for every object created here.
SET search_path = public;

-- Extensions the schema depends on. citext (users.email) is a TRUSTED extension in PG13+, so
-- the database owner (cp_migrator, non-superuser) may create it. Self-contained: migrations
-- never assume the harness pre-created it.
CREATE EXTENSION IF NOT EXISTS citext;

-- ---- id validation (DRY) -------------------------------------------------------
-- A prefixed-ULID id: <prefix>_<26-char Crockford base32 (no I/L/O/U)>. Mirrors the
-- shipped lib/protocol/ids.mjs ULID_RE. IMMUTABLE so it is usable in CHECK constraints.
CREATE OR REPLACE FUNCTION cp_valid_id(id text, prefix text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT id IS NOT NULL AND id ~ ('^' || prefix || '_[0-9A-HJKMNP-TV-Z]{26}$')
$$;

-- ---- updated_at maintenance ----------------------------------------------------
CREATE OR REPLACE FUNCTION cp_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---- optimistic-concurrency revision guard -------------------------------------
-- Asserts the caller advanced revision by exactly 1 (WHERE revision = expected). A writer
-- that omits the guard (revision unchanged) or skips values is rejected, so a stale write
-- can never silently last-writer-win. SQLSTATE 'CP001' = revision conflict / bad increment.
CREATE OR REPLACE FUNCTION cp_enforce_revision()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'revision must increment by exactly 1 (old=%, new=%)', OLD.revision, NEW.revision
      USING ERRCODE = 'CP001', CONSTRAINT = 'cp_revision_increment';
  END IF;
  RETURN NEW;
END;
$$;

-- Runtime roles must never execute the helper functions with elevated intent; EXECUTE on
-- these is granted to PUBLIC implicitly for IMMUTABLE SQL, which is harmless (pure). No table
-- access is implied. (PUBLIC privileges on the schema itself are revoked in 0010.)
