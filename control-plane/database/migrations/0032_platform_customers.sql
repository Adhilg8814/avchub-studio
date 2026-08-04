-- P0 Step 5C.29 Phase 1 — 0032 platform + customer plane (ADDITIVE, forward-only).
-- Implements docs/STUDIO_PLATFORM_ADMIN_MULTITENANT_ARCHITECTURE_LOCK.md §1/§2/§11/§12/§R.
-- LOCKED invariants honoured here:
--   R1  customers + platform_admins are PLATFORM-PLANE, NON-RLS, service-mediated (like users); DML to
--       cp_tenant_app; cross-plane reads via cp_ops_enumerator (SELECT) — NOT added to the workspace-RLS loop.
--   R2  workspaces.customer_id is METADATA — it is NOT referenced by any RLS predicate. Workspace stays the
--       sole data-isolation boundary. No 0010 policy is touched.
--   §6  onboarding creates a customer; a customer 1:N workspaces (V1 = 1/customer).
--   §11 per-customer quota limits + a durable daily usage counter (enforced later at enqueue).
--   §12 platform_audit_events is a NEW non-RLS stream (audit_events RLS rejects NULL-workspace rows).
-- Nothing in 0002..0031 is altered on disk. Feature activation is config-gated (flags default OFF); this
-- migration only provisions schema.
SET search_path = public;

-- ---- customers: the onboarding / billing / lifecycle unit (platform-plane, NON-RLS) ------------------
CREATE TABLE IF NOT EXISTS customers (
  id                   TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'cust')),
  legal_name           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','EXPIRED','CLOSED')),
  plan                 TEXT NOT NULL DEFAULT 'FREE',
  billing_ref          TEXT NULL,
  primary_owner_user_id TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  dedicated_worker_mode BOOLEAN NOT NULL DEFAULT true,   -- V1: dedicated-worker-per-customer (shared forbidden)
  -- quota / entitlement limits (NULL = unlimited); enforced server-side at the enqueue choke point (§11/§I3).
  max_users              INTEGER NULL,
  max_provider_accounts  INTEGER NULL,
  max_proxies            INTEGER NULL,
  max_active_movies      INTEGER NULL,
  max_scenes_per_movie   INTEGER NULL,
  max_grok_per_day       INTEGER NULL,
  max_elevenlabs_per_day INTEGER NULL,
  max_queued_jobs        INTEGER NULL,
  storage_bytes_limit    BIGINT  NULL,
  settings             JSONB NULL CHECK (settings IS NULL OR pg_column_size(settings) <= 16384),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at         TIMESTAMPTZ NULL,
  expires_at           TIMESTAMPTZ NULL,
  suspended_at         TIMESTAMPTZ NULL,
  suspend_reason       TEXT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_legal_name_uq ON customers (lower(legal_name));

-- durable per-customer per-day usage counters (the quota ledger; UPSERT on (customer_id, usage_date)).
CREATE TABLE IF NOT EXISTS customer_usage_daily (
  id             TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'cusg')),
  customer_id    TEXT COLLATE "C" NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  usage_date     DATE NOT NULL,
  grok_invocations      INTEGER NOT NULL DEFAULT 0,
  elevenlabs_units      INTEGER NOT NULL DEFAULT 0,
  jobs_enqueued         INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_usage_daily_uq UNIQUE (customer_id, usage_date)
);

-- ---- workspaces.customer_id: METADATA grouping (nullable, backfilled). NOT an RLS predicate (R2). --------
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS customer_id TEXT COLLATE "C" NULL REFERENCES customers(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS workspaces_customer_id_idx ON workspaces (customer_id);

-- ---- platform_admins: the platform authority plane, SEPARATE from workspace roles (§2, platform-plane) --
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id      TEXT COLLATE "C" PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  role         TEXT NOT NULL CHECK (role IN ('PLATFORM_OWNER','PLATFORM_ADMIN','PLATFORM_SUPPORT')),
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  granted_by   TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- platform_audit_events: cross-tenant / lifecycle audit stream (NON-RLS; §12/§R15) -----------------
-- audit_events (0008) is workspace-RLS'd and REJECTS a NULL workspace_id insert from cp_tenant_app, so a
-- platform/system audit row cannot live there. Platform actions + customer lifecycle go here. Append-only.
CREATE TABLE IF NOT EXISTS platform_audit_events (
  id            TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'paud')),
  actor_user_id TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE RESTRICT,   -- the platform admin (or NULL=SYSTEM)
  actor_role    TEXT NULL,                                                        -- PLATFORM_OWNER/ADMIN/SUPPORT/SYSTEM
  action        TEXT NOT NULL,                                                    -- CUSTOMER_CREATED, PLATFORM_ROLE_GRANTED, ...
  target_type   TEXT NULL,
  target_id     TEXT NULL,
  customer_id   TEXT COLLATE "C" NULL REFERENCES customers(id) ON DELETE RESTRICT,
  workspace_id  TEXT COLLATE "C" NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  outcome       TEXT NULL,
  metadata      JSONB NULL CHECK (metadata IS NULL OR pg_column_size(metadata) <= 16384),
  ip_address    INET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_created_idx ON platform_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_customer_idx ON platform_audit_events (customer_id, created_at DESC);

-- ---- updated_at touch triggers (reuse the existing cp_touch_updated_at() convention) -----------------
DROP TRIGGER IF EXISTS customers_touch ON customers;
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
DROP TRIGGER IF EXISTS customer_usage_daily_touch ON customer_usage_daily;
CREATE TRIGGER customer_usage_daily_touch BEFORE UPDATE ON customer_usage_daily FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();
DROP TRIGGER IF EXISTS platform_admins_touch ON platform_admins;
CREATE TRIGGER platform_admins_touch BEFORE UPDATE ON platform_admins FOR EACH ROW EXECUTE FUNCTION cp_touch_updated_at();

-- ---- SECURITY DEFINER: resolve a user's PLATFORM role pre-context (like cp_auth_user_memberships) -----
-- Returns the ACTIVE platform role for a user (or no row). Platform role is NEVER derived from workspace
-- membership or a client assertion (§2/§R6). Owner-owned so it reads platform_admins regardless of RLS
-- (platform_admins is non-RLS anyway); EXECUTE locked to cp_tenant_app (repeat the 0029 discipline).
DROP FUNCTION IF EXISTS cp_platform_role(text);
CREATE FUNCTION cp_platform_role(p_user_id text)
RETURNS TABLE (role text, status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT role, status FROM platform_admins WHERE user_id = p_user_id AND status = 'ACTIVE' LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION cp_platform_role(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cp_platform_role(text) TO cp_tenant_app;

-- ---- grants: platform-plane tables are service-mediated (cp_tenant_app CRUD; ops read-only) -----------
REVOKE ALL ON customers, customer_usage_daily, platform_admins, platform_audit_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON customers, customer_usage_daily, platform_admins, platform_audit_events TO cp_tenant_app;
-- cross-customer read-only observability for the platform console uses the BYPASSRLS ops enumerator.
GRANT SELECT ON customers, customer_usage_daily, platform_admins, platform_audit_events TO cp_ops_enumerator;
