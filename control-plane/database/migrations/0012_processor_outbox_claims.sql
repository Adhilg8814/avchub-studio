-- P0 Step 5C.3 — 0012 durable outbox CLAIM / LEASE / delivery-tracking columns.
--
-- WHY THIS IS A NEW MIGRATION (0001–0011 are frozen): 0007 created the protocol tables as
-- SCHEMA ONLY ("no processor loop in this task") — it deliberately deferred the fields the
-- Background Processor needs to CLAIM an outbox row under a lease and settle it safely across
-- multiple instances and crashes. Those fields (claim owner, unique claim token, lease expiry,
-- sticky delivery-uncertainty, awaiting-settlement clock, safe result/dead-letter codes) belong
-- to the processor step, so they land here in 0012 rather than by editing a frozen migration.
--
-- The macro delivery_state vocabulary (PENDING/SENT/ACKED/DEAD) from 0007 is UNCHANGED — the
-- claim is an ORTHOGONAL lease on top of it. A row is "claimable" when it is due and either
-- unclaimed OR its lease has expired; the claim_token must match on every settling UPDATE so a
-- stale claimant that lost its lease can never settle a row another instance now owns.
--
-- No new GRANTs: cp_tenant_app already holds SELECT/INSERT/UPDATE/DELETE and cp_ops_enumerator
-- SELECT on protocol_outbox (0010); table-level privileges cover added columns automatically.
-- No secrets, no Authorization headers, no absolute paths are ever stored in these columns.

SET search_path = public;

ALTER TABLE protocol_outbox
  -- claim / lease (multi-instance safety)
  ADD COLUMN claimed_by                TEXT NULL,                 -- processor instanceId holding the lease (diagnostic)
  ADD COLUMN claim_token               TEXT COLLATE "C" NULL,     -- unique per claim; REQUIRED to match on any settling UPDATE
  ADD COLUMN claimed_at                timestamptz NULL,
  ADD COLUMN claim_expires_at          timestamptz NULL,          -- lease deadline; past this the row is reclaimable
  -- delivery-outcome tracking (conservative paid-path safety)
  ADD COLUMN delivery_uncertain        BOOLEAN NOT NULL DEFAULT false,  -- STICKY: an uncertain write happened; never re-offer
  ADD COLUMN awaiting_settlement_since timestamptz NULL,          -- set when a row goes SENT awaiting its settlement condition
  ADD COLUMN last_result_code          TEXT NULL,                 -- last delivery adapter result (safe code; never a secret)
  ADD COLUMN dead_letter_code          TEXT NULL;                 -- machine-safe dead-letter reason (distinct from free-text)

-- Reclaim sweep: find leased rows whose lease has expired (small partial index).
CREATE INDEX ix_outbox_claim_expiry ON protocol_outbox (claim_expires_at) WHERE claim_token IS NOT NULL;

-- Settlement-timeout sweep: SENT rows awaiting a lifecycle/ACK response.
CREATE INDEX ix_outbox_awaiting ON protocol_outbox (awaiting_settlement_since) WHERE delivery_state = 'SENT';

-- Reconciliation-timeout: when a Worker's reconcile barrier was opened, so the processor can
-- detect a reconcile epoch that never completed (0004 tracks the open flag + epoch but not the
-- open time). Cleared when the barrier closes. Blocking a new offer never depends on this column
-- — it is only the timeout clock; correctness stays in reconcile_barrier_open + reconcile_epoch.
ALTER TABLE worker_connection_sessions
  ADD COLUMN reconcile_barrier_opened_at timestamptz NULL;

CREATE INDEX ix_worker_sessions_barrier_open ON worker_connection_sessions (reconcile_barrier_opened_at)
  WHERE reconcile_barrier_open = true;
