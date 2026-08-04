-- P0 Step 5C.21C — 0026 allow a PENDING TOTP method to coexist with the ACTIVE one during replacement.
-- 0022's partial unique index forbade two non-DISABLED methods, which blocked the "old TOTP stays usable
-- until the new one is confirmed" replacement flow (so the owner is never locked out). Replace it with TWO
-- partial unique indexes: at most one ACTIVE and at most one PENDING per (user, kind). Index-only change; no
-- row data is touched.

SET search_path = public;

DROP INDEX IF EXISTS user_mfa_active_totp_uq;
CREATE UNIQUE INDEX user_mfa_one_active_totp_uq  ON user_mfa_methods(user_id, kind) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX user_mfa_one_pending_totp_uq ON user_mfa_methods(user_id, kind) WHERE status = 'PENDING';
