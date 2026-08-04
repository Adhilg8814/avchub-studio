// P0 Step 5C.3 — minimal, safe retention sweep (disabled by default).
//
// Cleans ONLY records proven safe by the active spec, ALWAYS preserving a dedupe tombstone so
// exactly-once survives payload cleanup. Retained (never swept): inbox/ack of unresolved or
// possibly_submitted attempts, pending-ACK evidence, active/recovering reconcile state, and
// dead-letter rows within their configured window. No paid-ownership evidence is cascade-deleted
// (ownership rows in generation_attempts/job_offers/job_terminal_results are NEVER touched here).
// Bounded batches + FOR UPDATE ... SKIP LOCKED. No cold archive / object storage.

export function createRetentionProcessor({ adapter, clock, config, logger }) {
  const batchSize = config.retentionBatchSize ?? config.batchSize;
  const retentionMs = config.retentionMs ?? 7 * 24 * 3600 * 1000;             // inbox/settled payloads
  const deadLetterRetentionMs = config.deadLetterRetentionMs ?? 30 * 24 * 3600 * 1000; // forensic window

  async function retentionWorkspaces() {
    if (!adapter.opsEnumerate) return [];
    const r = await adapter.opsEnumerate((c) => c.query(
      `SELECT DISTINCT workspace_id FROM protocol_inbox
        WHERE received_at <= now() - ($1::bigint * interval '1 millisecond') LIMIT 500`, [retentionMs]));
    return r.rows.map((x) => x.workspace_id);
  }

  // Move terminal-safe expired inbox rows to dedupe tombstones (preserve dedupe, drop payload).
  async function sweepInbox(ws) {
    return adapter.tenantTransaction(ws, async (client) => {
      // Safe to sweep an inbox row ONLY when its referenced attempt is RESOLVED (terminal) — the
      // paid-ownership evidence then lives durably in generation_attempts/job_terminal_results and
      // a tombstone preserves dedupe. An UNRESOLVED attempt (terminal_state IS NULL — which also
      // covers a submitted-but-not-terminal, i.e. possibly_submitted, attempt) is retained.
      const rows = (await client.query(
        `SELECT i.id, i.worker_id, i.message_id
           FROM protocol_inbox i
           LEFT JOIN generation_attempts a
             ON a.workspace_id = i.workspace_id AND a.id = i.generation_attempt_id
          WHERE i.workspace_id = $1 AND i.received_at <= now() - ($2::bigint * interval '1 millisecond')
            AND (i.generation_attempt_id IS NULL OR a.terminal_state IS NOT NULL)
          ORDER BY i.received_at
          FOR UPDATE OF i SKIP LOCKED
          LIMIT $3`,
        [ws, retentionMs, batchSize])).rows;
      let cleaned = 0;
      for (const r of rows) {
        await client.query(
          `INSERT INTO protocol_dedupe_tombstones (worker_id, message_id, workspace_id, acked_at, created_at)
           VALUES ($1,$2,$3, now(), now()) ON CONFLICT (worker_id, message_id) DO NOTHING`,
          [r.worker_id, r.message_id, ws]);
        await client.query("DELETE FROM protocol_inbox WHERE workspace_id=$1 AND id=$2", [ws, r.id]);
        cleaned += 1;
      }
      return cleaned;
    });
  }

  // Delete settled (ACKED) outbox rows past retention, and DEAD rows past their forensic window.
  async function sweepOutbox(ws) {
    return adapter.tenantTransaction(ws, async (client) => {
      const acked = (await client.query(
        `DELETE FROM protocol_outbox WHERE ctid IN (
           SELECT ctid FROM protocol_outbox
            WHERE workspace_id=$1 AND delivery_state='ACKED' AND settled_at IS NOT NULL
              AND settled_at <= now() - ($2::bigint * interval '1 millisecond')
            ORDER BY settled_at FOR UPDATE SKIP LOCKED LIMIT $3)
         RETURNING id`, [ws, retentionMs, batchSize])).rowCount;
      const dead = (await client.query(
        `DELETE FROM protocol_outbox WHERE ctid IN (
           SELECT ctid FROM protocol_outbox
            WHERE workspace_id=$1 AND delivery_state='DEAD' AND settled_at IS NOT NULL
              AND settled_at <= now() - ($2::bigint * interval '1 millisecond')
            ORDER BY settled_at FOR UPDATE SKIP LOCKED LIMIT $3)
         RETURNING id`, [ws, deadLetterRetentionMs, batchSize])).rowCount;
      return { acked, dead };
    });
  }

  async function runOnce({ signal } = {}) {
    const stats = { inboxTombstoned: 0, outboxAckedDeleted: 0, outboxDeadDeleted: 0 };
    const wsList = await retentionWorkspaces();
    for (const ws of wsList) {
      if (signal && signal.aborted) break;
      stats.inboxTombstoned += await sweepInbox(ws);
      const o = await sweepOutbox(ws);
      stats.outboxAckedDeleted += o.acked;
      stats.outboxDeadDeleted += o.dead;
    }
    return stats;
  }

  return { runOnce, _sweepInbox: sweepInbox, _sweepOutbox: sweepOutbox };
}
