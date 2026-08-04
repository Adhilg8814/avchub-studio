-- P0 Step 5C.21D — 0027 durable auth-notification outbox (ADDITIVE). Onboarding / reset / verification
-- notifications are written transactionally with the state change that triggers them (an outbox row commits
-- with the reset token, or not at all — no lost or phantom emails on rollback). No real email is sent in
-- this increment; a delivery worker/mock drains PENDING rows. The one-time LINK token is the only secret
-- involved: the DB persists it ONLY as AES-256-GCM ciphertext (token_ciphertext) and the delivery step
-- clears it after send; the plaintext link is reconstructed solely in the delivery boundary. The
-- recipient_email is the destination the delivery genuinely needs (not a credential). Service-mediated
-- (non-RLS), reachable only by the auth service role.

SET search_path = public;

CREATE TABLE auth_notification_outbox (
  id               TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'noti')),
  kind             TEXT NOT NULL CHECK (kind IN ('INVITATION','PASSWORD_RESET','EMAIL_VERIFICATION','SECURITY_NOTICE')),
  recipient_email  CITEXT NOT NULL,
  user_id          TEXT COLLATE "C" NULL REFERENCES users(id) ON DELETE SET NULL,
  workspace_id     TEXT COLLATE "C" NULL REFERENCES workspaces(id) ON DELETE SET NULL,
  token_ciphertext TEXT NULL,                       -- AES-256-GCM of the one-time link token; cleared after send
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- non-secret template data only
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','CANCELLED')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  expires_at       timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz NULL
);
CREATE INDEX auth_notification_outbox_status_idx ON auth_notification_outbox(status, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_notification_outbox TO cp_tenant_app;
