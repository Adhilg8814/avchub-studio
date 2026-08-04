// P0 Step 5C.3 — reconciliation-timeout sweep.
//
// A Worker reconcile barrier is opened (on reconnect) and must be closed by that Worker's
// STATE_RECONCILE reaching its isLast batch for the CURRENT epoch. If it never completes within
// reconcileTimeoutMs the barrier is STUCK. Conservative handling (never invents Worker facts):
//   - do NOT clear possibly_submitted (attempts are not touched at all);
//   - do NOT create a new paid offer (the open barrier already blocks offers);
//   - keep the barrier OPEN (blocking) until authoritative completion or operator action;
//   - record a single RECONCILE_TIMEOUT status-history marker per open window (no spam).
// Re-driving the STATE_RECONCILE_REQUEST outbox itself is handled by the outbox settlement-timeout
// sweep (it re-sends the same messageId, bounded) — this sweep only flags the stuck barrier.

import { newId } from "../persistence/ids.mjs";

export function createReconciliationProcessor({ adapter, clock, config, logger }) {
  const batchSize = config.batchSize;
  const reconcileTimeoutMs = config.reconcileTimeoutMs ?? config.settlementTimeoutMs ?? 60000;

  async function enumerateStuck() {
    if (!adapter.opsEnumerate) return [];
    const r = await adapter.opsEnumerate((c) => c.query(
      `SELECT workspace_id, worker_id, reconcile_epoch, reconcile_barrier_opened_at
         FROM worker_connection_sessions
        WHERE status='ACTIVE' AND reconcile_barrier_open=true
          AND reconcile_barrier_opened_at IS NOT NULL
          AND reconcile_barrier_opened_at <= now() - ($1::bigint * interval '1 millisecond')
        LIMIT $2`, [reconcileTimeoutMs, batchSize]));
    return r.rows;
  }

  async function flag(ws, workerId, openedAt) {
    return adapter.tenantTransaction(ws, async (client) => {
      // Re-check under the row: barrier still open + still stale (another sweep may have handled it).
      const s = (await client.query(
        "SELECT reconcile_barrier_open, reconcile_barrier_opened_at FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE' FOR UPDATE",
        [ws, workerId])).rows[0];
      if (!s || s.reconcile_barrier_open !== true) return { flagged: false, reason: "closed" };
      // Only record ONE marker per open window (idempotent): skip if a RECONCILE_TIMEOUT already
      // exists since the barrier was opened.
      const existing = (await client.query(
        `SELECT 1 FROM worker_status_history
          WHERE workspace_id=$1 AND worker_id=$2 AND status='RECONCILE_TIMEOUT' AND at >= $3::timestamptz LIMIT 1`,
        [ws, workerId, s.reconcile_barrier_opened_at])).rows[0];
      if (existing) return { flagged: false, reason: "already_flagged" };
      await client.query(
        "INSERT INTO worker_status_history (id, workspace_id, worker_id, status, reason, at) VALUES ($1,$2,$3,'RECONCILE_TIMEOUT',$4, now())",
        [newId("wsh"), ws, workerId, "reconcile did not complete within timeout"]);
      // Barrier stays OPEN (blocking new offers). possibly_submitted is deliberately untouched.
      return { flagged: true };
    });
  }

  async function runOnce({ signal } = {}) {
    const stats = { stuck: 0, flagged: 0 };
    const rows = await enumerateStuck();
    for (const row of rows) {
      if (signal && signal.aborted) break;
      stats.stuck += 1;
      const r = await flag(row.workspace_id, row.worker_id, row.reconcile_barrier_opened_at);
      if (r.flagged) stats.flagged += 1;
    }
    return stats;
  }

  return { runOnce, _enumerateStuck: enumerateStuck };
}
