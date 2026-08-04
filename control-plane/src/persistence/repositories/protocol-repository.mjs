// P0 Step 5C.3 — protocol inbox/outbox/ACK repository (durable messaging layer).
//
// Every method receives a transaction CLIENT (never opens its own txn), is workspace-scoped, and
// uses parameterized SQL only (no string interpolation of values or identifiers). Business-state
// transitions are NOT here — they live in transactions/ownership.mjs. This module owns ONLY the
// inbox dedupe rows, the outbox delivery/claim state machine, and the ACK ledger.
//
// Claim safety: a claimed row carries (claimed_by, claim_token, claimed_at, claim_expires_at).
// Every settling UPDATE is guarded by `claim_token = $token` so a stale claimant that lost its
// lease (its row was reclaimed with a NEW token) can never settle a row another instance now owns
// (rowCount === 0 signals the lost claim). Inbound settlement (from the ACK/lifecycle path) is
// keyed by message_id and is idempotent, independent of any processor claim.

import { newId } from "../ids.mjs";
import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";

function requireClient(client) {
  if (!client || typeof client.query !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "protocol repository requires a transaction client");
}
const one = (r) => (r.rows[0] ?? null);

export const inboxRepository = {
  async find(client, workspaceId, workerId, messageId) {
    requireClient(client);
    return one(await client.query(
      "SELECT * FROM protocol_inbox WHERE workspace_id=$1 AND worker_id=$2 AND message_id=$3", [workspaceId, workerId, messageId]));
  },
  // Insert the dedupe row; ON CONFLICT (worker_id, message_id) DO NOTHING → null on a concurrent
  // duplicate (the winner already inserted). The caller treats null as "duplicate, use cache".
  async insert(client, workspaceId, { workerId, jobId = null, generationAttemptId = null, messageId, type, receivedAtIso, payloadDigest = null }) {
    requireClient(client);
    const id = newId("ib");
    return one(await client.query(
      `INSERT INTO protocol_inbox (id, workspace_id, worker_id, job_id, generation_attempt_id, message_id, type, received_at, payload_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()), $9)
       ON CONFLICT (worker_id, message_id) DO NOTHING RETURNING *`,
      [id, workspaceId, workerId, jobId, generationAttemptId, messageId, type, receivedAtIso ?? null, payloadDigest]));
  },
  async markProcessed(client, workspaceId, inboxId, { ackId = null, processedAtIso = null }) {
    requireClient(client);
    return one(await client.query(
      "UPDATE protocol_inbox SET ack_id = COALESCE($3, ack_id), processed_at = COALESCE($4::timestamptz, now()) WHERE workspace_id=$1 AND id=$2 RETURNING *",
      [workspaceId, inboxId, ackId, processedAtIso]));
  }
};

export const ackRepository = {
  async find(client, workspaceId, workerId, ackedMessageId, direction) {
    requireClient(client);
    return one(await client.query(
      "SELECT * FROM protocol_message_acks WHERE workspace_id=$1 AND worker_id=$2 AND acked_message_id=$3 AND direction=$4",
      [workspaceId, workerId, ackedMessageId, direction]));
  },
  // Record an ACK outcome (idempotent on (worker_id, acked_message_id, direction)). Returns the
  // row (freshly inserted OR the pre-existing cached one).
  async record(client, workspaceId, { workerId, jobId = null, generationAttemptId = null, direction, ackedMessageId, ackedType, status, errorCode = null, serverRevision = null }) {
    requireClient(client);
    const id = newId("ack");
    const ins = await client.query(
      `INSERT INTO protocol_message_acks (id, workspace_id, worker_id, job_id, generation_attempt_id, direction, acked_message_id, acked_type, status, error_code, server_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (worker_id, acked_message_id, direction) DO NOTHING RETURNING *`,
      [id, workspaceId, workerId, jobId, generationAttemptId, direction, ackedMessageId, ackedType, status, errorCode, serverRevision]);
    if (ins.rowCount === 1) return { ack: one(ins), created: true };
    return { ack: await this.find(client, workspaceId, workerId, ackedMessageId, direction), created: false };
  }
};

export const outboxRepository = {
  async getById(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query("SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND id=$2", [workspaceId, id]));
  },
  async findByMessageId(client, workspaceId, messageId) {
    requireClient(client);
    return one(await client.query("SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND message_id=$2", [workspaceId, messageId]));
  },
  // Create an outbox row (delivery_state PENDING). messageId is caller-minted and preserved
  // across all retries. availableAt/nextAttemptAt default to now.
  async insert(client, workspaceId, {
    messageId, workerId, jobId = null, generationAttemptId = null, type, settlementMode,
    expectedResponseTypes = null, orderingKey = null, payload = {}, payloadBytes = null,
    maxAttempts = 5, availableAtIso = null, nextAttemptAtIso = null
  }) {
    requireClient(client);
    const id = newId("ob");
    return one(await client.query(
      `INSERT INTO protocol_outbox (id, workspace_id, worker_id, job_id, generation_attempt_id, message_id, type, settlement_mode,
         expected_response_types, ordering_key, payload, payload_bytes, max_attempts, delivery_state, available_at, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING', COALESCE($14::timestamptz, now()), COALESCE($15::timestamptz, now()))
       RETURNING *`,
      [id, workspaceId, workerId, jobId, generationAttemptId, messageId, type, settlementMode,
       expectedResponseTypes ? JSON.stringify(expectedResponseTypes) : null, orderingKey,
       JSON.stringify(payload ?? {}), payloadBytes, maxAttempts, availableAtIso, nextAttemptAtIso]));
  },

  // ---- CLAIM (multi-instance safe) --------------------------------------------------------
  // Claim up to `batchSize` due, head-of-line (single-flight per ordering_key), un-leased-or-
  // expired-lease PENDING rows in THIS workspace, stamping the lease. FOR UPDATE SKIP LOCKED so
  // two instances processing the same workspace claim DISJOINT rows.
  // "Due now" and "lease expired" are compared with the DATABASE clock (now()), never a JS clock
  // passed in — a freshly-inserted row's next_attempt_at is DB-now, and any JS/DB skew (even a
  // millisecond) would make an immediately-claimable row read as not-yet-due. leaseUntilIso is a
  // FUTURE timestamp (skew-insensitive) so it is fine to pass from the caller.
  async claimDue(client, workspaceId, { instanceId, token, leaseUntilIso, batchSize }) {
    requireClient(client);
    const res = await client.query(
      `WITH due AS (
         SELECT o.id
         FROM protocol_outbox o
         WHERE o.workspace_id = $1
           AND o.delivery_state = 'PENDING'
           AND o.next_attempt_at <= now()
           AND (o.claim_token IS NULL OR o.claim_expires_at <= now())
           AND NOT EXISTS (
             SELECT 1 FROM protocol_outbox e
             WHERE e.workspace_id = o.workspace_id
               AND e.ordering_key IS NOT NULL
               AND e.ordering_key = o.ordering_key
               AND e.id <> o.id
               AND e.delivery_state IN ('PENDING','SENT')
               AND (e.created_at < o.created_at OR (e.created_at = o.created_at AND e.id < o.id))
           )
         ORDER BY o.next_attempt_at, o.created_at, o.id
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       UPDATE protocol_outbox o
         SET claimed_by = $2, claim_token = $3, claimed_at = now(), claim_expires_at = $5::timestamptz
         FROM due WHERE o.id = due.id
         RETURNING o.*`,
      [workspaceId, instanceId, token, batchSize, leaseUntilIso]);
    return res.rows;
  },

  // ---- settle / retry / release / dead-letter (token-guarded) -----------------------------
  // A confirmed write for an ACK/LIFECYCLE row → SENT, awaiting its settlement condition. sent_at
  // and awaiting_settlement_since use the DB clock so the settlement-timeout sweep compares like
  // with like (DB now() minus the window), free of any JS/DB skew.
  async markAwaitingSettlement(client, workspaceId, id, token, { resultCode, incAttempts = true, uncertain = false } = {}) {
    requireClient(client);
    return one(await client.query(
      `UPDATE protocol_outbox
         SET delivery_state='SENT', sent_at = now(), awaiting_settlement_since = now(),
             attempts = attempts + CASE WHEN $4 THEN 1 ELSE 0 END, last_result_code = $5,
             delivery_uncertain = delivery_uncertain OR $6, revision = revision + 1,
             claimed_by = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 RETURNING *`,
      [workspaceId, id, token, incAttempts, resultCode ?? null, uncertain]));
  },
  // A confirmed write for a SEND_ONLY row → settled immediately.
  async markSentSettled(client, workspaceId, id, token, { resultCode } = {}) {
    requireClient(client);
    return one(await client.query(
      `UPDATE protocol_outbox
         SET delivery_state='ACKED', sent_at = now(), settled_at = now(),
             last_result_code = $4, revision = revision + 1,
             claimed_by = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 RETURNING *`,
      [workspaceId, id, token, resultCode ?? null]));
  },
  // Schedule a retry of the SAME messageId (attempts++ optional, backoff).
  async scheduleRetry(client, workspaceId, id, token, { nextAttemptAtIso, incAttempts = true, resultCode, uncertain = false }) {
    requireClient(client);
    return one(await client.query(
      `UPDATE protocol_outbox
         SET next_attempt_at = $4::timestamptz, attempts = attempts + CASE WHEN $5 THEN 1 ELSE 0 END,
             last_result_code = $6, delivery_uncertain = delivery_uncertain OR $7, revision = revision + 1,
             claimed_by = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 RETURNING *`,
      [workspaceId, id, token, nextAttemptAtIso, incAttempts, resultCode ?? null, uncertain]));
  },
  // Release a claim WITHOUT attempts++ (offline/stale socket): keep PENDING, re-check soon.
  async releaseClaim(client, workspaceId, id, token, { nextAttemptAtIso, resultCode }) {
    requireClient(client);
    return one(await client.query(
      `UPDATE protocol_outbox
         SET next_attempt_at = COALESCE($4::timestamptz, next_attempt_at), last_result_code = $5, revision = revision + 1,
             claimed_by = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 RETURNING *`,
      [workspaceId, id, token, nextAttemptAtIso ?? null, resultCode ?? null]));
  },
  // Terminal dead-letter (preserves forensic columns; no payload deletion here).
  async deadLetter(client, workspaceId, id, token, { code, reason }) {
    requireClient(client);
    return one(await client.query(
      `UPDATE protocol_outbox
         SET delivery_state='DEAD', dead_letter_code=$4, dead_letter_reason=$5, settled_at = now(), revision = revision + 1,
             claimed_by = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE workspace_id=$1 AND id=$2 AND claim_token=$3 RETURNING *`,
      [workspaceId, id, token, code ?? "DEAD", reason ?? null]));
  },
  // Settlement-timeout: re-arm a SENT row for another send of the SAME messageId (SENT→PENDING),
  // due immediately (next_attempt_at = DB now()).
  async reArmSent(client, workspaceId, id, { resultCode } = {}) {
    requireClient(client);
    return one(await client.query(
      `UPDATE protocol_outbox
         SET delivery_state='PENDING', awaiting_settlement_since = NULL, next_attempt_at = now(),
             last_result_code = COALESCE($3, last_result_code), revision = revision + 1,
             claimed_by = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE workspace_id=$1 AND id=$2 AND delivery_state='SENT' RETURNING *`,
      [workspaceId, id, resultCode ?? null]));
  },
  // Dead-letter a SENT row that exhausted its settlement window (no claim token required — the
  // sweep owns SENT rows). Idempotent on delivery_state='SENT'.
  async deadLetterSent(client, workspaceId, id, { code, reason }) {
    requireClient(client);
    return one(await client.query(
      `UPDATE protocol_outbox
         SET delivery_state='DEAD', dead_letter_code=$3, dead_letter_reason=$4, settled_at = now(), revision = revision + 1,
             claimed_by = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE workspace_id=$1 AND id=$2 AND delivery_state='SENT' RETURNING *`,
      [workspaceId, id, code ?? "SETTLEMENT_TIMEOUT", reason ?? null]));
  },

  // ---- inbound settlement (idempotent, message-id keyed, NO claim token) ------------------
  // A validated correlated response / ACK settles the outbox row it answers. Only settles a row
  // still in flight (PENDING/SENT). Returns the settled row, or null if not found/already settled.
  async settleByMessageId(client, workspaceId, messageId, { reason = null } = {}) {
    requireClient(client);
    return one(await client.query(
      `UPDATE protocol_outbox
         SET delivery_state='ACKED', settled_at = now(), last_result_code = COALESCE($3, last_result_code), revision = revision + 1,
             claimed_by = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE workspace_id=$1 AND message_id=$2 AND delivery_state IN ('PENDING','SENT') RETURNING *`,
      [workspaceId, messageId, reason]));
  },
  // Find the in-flight outbox row for a job of an expected type (lifecycle correlation).
  async findInFlightForJob(client, workspaceId, jobId, types) {
    requireClient(client);
    return one(await client.query(
      `SELECT * FROM protocol_outbox
        WHERE workspace_id=$1 AND job_id=$2 AND type = ANY($3) AND delivery_state IN ('PENDING','SENT')
        ORDER BY created_at ASC LIMIT 1`,
      [workspaceId, jobId, types]));
  },
  // Find the in-flight worker-scoped outbox row of an expected type (no jobId correlation).
  async findInFlightForWorker(client, workspaceId, workerId, types) {
    requireClient(client);
    return one(await client.query(
      `SELECT * FROM protocol_outbox
        WHERE workspace_id=$1 AND worker_id=$2 AND type = ANY($3) AND delivery_state IN ('PENDING','SENT')
        ORDER BY created_at ASC LIMIT 1`,
      [workspaceId, workerId, types]));
  }
};
