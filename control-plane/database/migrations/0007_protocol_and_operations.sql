-- P0 Step 5C.2 — 0007 protocol tables (inbox/outbox/message_acks) + dedupe tombstones.
-- Schema only — NO processor loop in this task. Fields support future durable dedupe,
-- cached-ACK replay, lifecycle-response settlement, per-(worker,job) single-flight ordering,
-- socket-aware claims, and attempt-tied retention. No Authorization headers / secrets stored.

SET search_path = public;

CREATE TABLE protocol_inbox (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'ib')),
  workspace_id          TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id             TEXT COLLATE "C" NOT NULL,
  job_id                TEXT COLLATE "C" NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  message_id            TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(message_id, 'msg')),
  type                  TEXT NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  processed_at          timestamptz NULL,
  ack_id                TEXT COLLATE "C" NULL,   -- → protocol_message_acks (cached ACK for replay)
  payload_digest        TEXT NULL,
  settled_at            timestamptz NULL,        -- propagated when the referenced attempt settles
  -- durable inbound dedupe key.
  CONSTRAINT protocol_inbox_dedupe_uq UNIQUE (worker_id, message_id),
  CONSTRAINT protocol_inbox_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE protocol_outbox (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'ob')),
  workspace_id          TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id             TEXT COLLATE "C" NOT NULL,
  job_id                TEXT COLLATE "C" NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  message_id            TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(message_id, 'msg')),
  type                  TEXT NOT NULL,
  settlement_mode       TEXT NOT NULL CHECK (settlement_mode IN ('MESSAGE_ACK','LIFECYCLE_RESPONSE','SEND_ONLY')),
  expected_response_types JSONB NULL,           -- e.g. ["JOB_ACCEPTED","JOB_REJECTED"]
  ordering_key          TEXT NULL,              -- (worker_id[, job_id]) single-flight key
  delivery_state        TEXT NOT NULL DEFAULT 'PENDING' CHECK (delivery_state IN ('PENDING','SENT','ACKED','DEAD')),
  payload               JSONB NOT NULL,         -- sanitized; no secrets/Authorization
  payload_bytes         INTEGER NULL CHECK (payload_bytes IS NULL OR payload_bytes >= 0),
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 5,
  dead_letter_reason    TEXT NULL,
  revision              INTEGER NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  available_at          timestamptz NOT NULL DEFAULT now(),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz NULL,
  settled_at            timestamptz NULL,
  -- SEND_ONLY is forbidden for correctness-critical message types (guard, arch §12.1).
  CONSTRAINT protocol_outbox_send_only_safe CHECK (
    settlement_mode <> 'SEND_ONLY'
    OR type IN ('HELLO_ACK','PING','MESSAGE_ACK','WORKER_HEARTBEAT')),
  CONSTRAINT protocol_outbox_message_uq UNIQUE (message_id),
  CONSTRAINT protocol_outbox_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE protocol_message_acks (
  id                    TEXT COLLATE "C" PRIMARY KEY CHECK (cp_valid_id(id, 'ack')),
  workspace_id          TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worker_id             TEXT COLLATE "C" NOT NULL,
  job_id                TEXT COLLATE "C" NULL,
  generation_attempt_id TEXT COLLATE "C" NULL,
  direction             TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  acked_message_id      TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(acked_message_id, 'msg')),
  acked_type            TEXT NOT NULL CHECK (acked_type <> 'MESSAGE_ACK'),  -- never ack an ack
  status                TEXT NOT NULL CHECK (status IN ('ACCEPTED','REJECTED','VALIDATION_FAILED')),
  error_code            TEXT NULL,
  server_revision       INTEGER NULL,
  settled_at            timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT protocol_message_acks_uq UNIQUE (worker_id, acked_message_id, direction),
  CONSTRAINT protocol_message_acks_worker_fk FOREIGN KEY (workspace_id, worker_id)
    REFERENCES workers (workspace_id, id) ON DELETE RESTRICT
);

-- Lightweight dedupe tombstone retained beyond payload sweep (S9). No payload — dedupe only.
CREATE TABLE protocol_dedupe_tombstones (
  worker_id  TEXT COLLATE "C" NOT NULL,
  message_id TEXT COLLATE "C" NOT NULL CHECK (cp_valid_id(message_id, 'msg')),
  workspace_id TEXT COLLATE "C" NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  acked_at   timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, message_id)
);

-- protocol_outbox has no updated_at (delivery state is tracked by explicit *_at columns +
-- revision); no touch trigger needed.
