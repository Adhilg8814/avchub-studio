// P0 Step 5C.3 — outbox delivery processor.
//
// Global drain WITHOUT a per-instance socket assumption baked into correctness:
//   1. ops pool (BYPASSRLS, READ ONLY) enumerates due (workspace) work — never mutates.
//   2. per workspace, a TENANT transaction claims head-of-line, un-leased/expired-lease PENDING
//      rows with FOR UPDATE SKIP LOCKED, stamping (claimed_by, claim_token, claim_expires_at).
//      Two instances on the same workspace claim DISJOINT rows; an expired lease is reclaimable.
//   3. delivery calls the INJECTED adapter (never a socket here). The original messageId is
//      preserved across retries; sentAt is re-stamped each send.
//   4. the outcome is persisted in a TENANT transaction GUARDED BY the claim token — a stale
//      claimant that lost its lease settles nothing (rowCount 0).
//
// A confirmed socket write is NOT settlement unless the row is SEND_ONLY. ACK/LIFECYCLE rows go
// to SENT (awaiting their settlement condition); a settlement-timeout sweep re-sends the SAME
// messageId (bounded) or dead-letters per the row's per-type policy. An uncertain write is
// treated as possibly-delivered (SENT + sticky delivery_uncertain) so a paid offer is never
// re-offered on uncertainty.

import { makeEnvelope } from "../../../lib/protocol/envelope.mjs";
import { newId } from "../persistence/ids.mjs";
import { outboxRepository } from "../persistence/repositories/protocol-repository.mjs";
import { settlementFor } from "./settlement-map.mjs";
import { DELIVERY_RESULTS, dispositionFor, isDeliveryResult } from "./retry-policy.mjs";

// deliveryRef is a mutable holder ({ current }) so the Gateway can INSTALL its real delivery
// adapter at startup (the processor is constructed before the Gateway). If a plain adapter is
// passed as `deliveryAdapter` it is wrapped in a holder for backward compatibility (5C.3 tests).
export function createOutboxProcessor({ adapter, clock, deliveryAdapter, deliveryRef, retryPolicy, config, logger }) {
  const delRef = deliveryRef || { current: deliveryAdapter };
  const currentDelivery = () => delRef.current;
  const instanceId = config.instanceId;
  const batchSize = config.batchSize;
  const claimLeaseMs = config.claimLeaseMs;
  const deliveryTimeoutMs = config.deliveryTimeoutMs;
  const settlementTimeoutMs = config.settlementTimeoutMs;
  const offlineRecheckMs = config.offlineRecheckMs ?? Math.min(config.pollIntervalMs ?? 1000, 5000);

  function buildEnvelope(ws, row) {
    const input = { messageId: row.message_id, type: row.type, workspaceId: ws, workerId: row.worker_id, sentAt: clock.nowIso(), payload: row.payload || {} };
    if (row.job_id) input.jobId = row.job_id;
    return makeEnvelope(input);
  }

  // Ops enumeration (READ ONLY, BYPASSRLS): distinct workspaces with due deliverable rows. All
  // time comparisons use the DB clock (now()) — see claimDue for why JS clock skew is avoided.
  async function dueWorkspaces() {
    if (!adapter.opsEnumerate) return [];
    const r = await adapter.opsEnumerate((c) => c.query(
      `SELECT DISTINCT workspace_id FROM protocol_outbox
        WHERE delivery_state='PENDING' AND next_attempt_at <= now()
          AND (claim_token IS NULL OR claim_expires_at <= now())
        LIMIT 500`));
    return r.rows.map((x) => x.workspace_id);
  }
  async function settlementTimeoutWorkspaces() {
    if (!adapter.opsEnumerate) return [];
    const r = await adapter.opsEnumerate((c) => c.query(
      `SELECT DISTINCT workspace_id FROM protocol_outbox
        WHERE delivery_state='SENT' AND awaiting_settlement_since IS NOT NULL
          AND awaiting_settlement_since <= now() - ($1::bigint * interval '1 millisecond')
        LIMIT 500`, [settlementTimeoutMs]));
    return r.rows.map((x) => x.workspace_id);
  }

  // Claim a batch for one workspace and attach the active session (delivery target) to each row.
  async function claimBatch(ws) {
    return adapter.tenantTransaction(ws, async (client) => {
      const token = newId("clm");
      const rows = await outboxRepository.claimDue(client, ws, {
        instanceId, token, leaseUntilIso: clock.futureIso(claimLeaseMs), batchSize
      });
      for (const r of rows) {
        const s = (await client.query(
          "SELECT id, gateway_instance, status FROM worker_connection_sessions WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE' LIMIT 1",
          [ws, r.worker_id])).rows[0] || null;
        r._session = s;
        r._token = token;
      }
      return rows;
    });
  }

  // Resolve the transport result for a claimed row (never throws; a timeout is UNCERTAIN).
  async function deliver(ws, row, signal) {
    const session = row._session;
    if (!session) return { result: DELIVERY_RESULTS.WORKER_OFFLINE, reasonCode: "NO_ACTIVE_SESSION" };
    if (session.gateway_instance && session.gateway_instance !== instanceId) {
      // Session is owned by ANOTHER gateway instance — never send here; release so the owning
      // instance can deliver it (NOT a supersede — the row stays eligible, no attempts++).
      return { result: DELIVERY_RESULTS.SESSION_NOT_LOCAL, reasonCode: "FOREIGN_INSTANCE" };
    }
    const deliveryAdapter = currentDelivery();
    if (!deliveryAdapter || deliveryAdapter.available !== true || typeof deliveryAdapter.sendToWorker !== "function") {
      return { result: DELIVERY_RESULTS.WORKER_OFFLINE, reasonCode: "ADAPTER_UNAVAILABLE" };
    }
    let envelope;
    try { envelope = buildEnvelope(ws, row); }
    catch (e) { return { result: DELIVERY_RESULTS.PERMANENT_FAILURE, reasonCode: "ENVELOPE_INVALID" }; }
    // Cancel the delivery-timeout timer as soon as the send resolves (or the outer signal aborts)
    // so no unref'd timer lingers past the delivery — bounded, leak-free timers.
    const to = new AbortController();
    if (signal) { if (signal.aborted) to.abort(); else signal.addEventListener("abort", () => to.abort(), { once: true }); }
    const sendP = Promise.resolve()
      .then(() => deliveryAdapter.sendToWorker({ workspaceId: ws, workerId: row.worker_id, connectionSessionId: session.id, gatewayInstance: session.gateway_instance, envelope, signal }))
      .then((res) => (res && isDeliveryResult(res.result) ? res : { result: DELIVERY_RESULTS.TRANSIENT_FAILURE, reasonCode: "BAD_ADAPTER_RESULT" }))
      .catch(() => ({ result: DELIVERY_RESULTS.TRANSIENT_FAILURE, reasonCode: "ADAPTER_THREW" }));
    const timeoutP = clock.sleep(deliveryTimeoutMs, to.signal)
      .then(() => ({ result: DELIVERY_RESULTS.DELIVERY_UNCERTAIN, reasonCode: "TIMEOUT" }))
      .catch(() => ({ result: DELIVERY_RESULTS.TRANSIENT_FAILURE, reasonCode: "ABORTED" }));
    try { return await Promise.race([sendP, timeoutP]); }
    finally { to.abort(); }
  }

  // Persist the delivery outcome for one row (token-guarded). Returns a disposition tag.
  async function settle(ws, row, resultCode) {
    const desc = settlementFor(row.type) || { mode: "SEND_ONLY", deadLetterOnMax: false };
    const token = row._token;
    return adapter.tenantTransaction(ws, async (client) => {
      if (resultCode === DELIVERY_RESULTS.WRITTEN) {
        if (desc.mode === "SEND_ONLY") {
          const r = await outboxRepository.markSentSettled(client, ws, row.id, token, { resultCode });
          return r ? "SETTLED" : "LOST_CLAIM";
        }
        const r = await outboxRepository.markAwaitingSettlement(client, ws, row.id, token, { resultCode, incAttempts: true, uncertain: false });
        return r ? "SENT_AWAITING" : "LOST_CLAIM";
      }
      if (resultCode === DELIVERY_RESULTS.DELIVERY_UNCERTAIN) {
        // Possibly delivered → SENT + sticky uncertain (never re-offer a paid offer on uncertainty).
        const r = await outboxRepository.markAwaitingSettlement(client, ws, row.id, token, { resultCode, incAttempts: true, uncertain: true });
        return r ? "SENT_UNCERTAIN" : "LOST_CLAIM";
      }
      const disp = dispositionFor(resultCode);
      if (disp.kind === "release") { // WORKER_OFFLINE / SESSION_STALE → keep PENDING, no attempts++
        const r = await outboxRepository.releaseClaim(client, ws, row.id, token, { nextAttemptAtIso: clock.futureIso(offlineRecheckMs), resultCode });
        return r ? "RELEASED" : "LOST_CLAIM";
      }
      if (resultCode === DELIVERY_RESULTS.PERMANENT_FAILURE) {
        const r = await outboxRepository.deadLetter(client, ws, row.id, token, { code: "PERMANENT_FAILURE", reason: "permanent delivery failure" });
        return r ? "DEAD" : "LOST_CLAIM";
      }
      // BACKPRESSURE (no attempts++, never dead-letters) or TRANSIENT_FAILURE (attempts++)
      const counts = disp.counts === true;
      const newAttempts = row.attempts + (counts ? 1 : 0);
      if (counts && desc.deadLetterOnMax && newAttempts >= row.max_attempts) {
        const r = await outboxRepository.deadLetter(client, ws, row.id, token, { code: "MAX_ATTEMPTS", reason: `dead-lettered after ${newAttempts} attempts (${resultCode})` });
        return r ? "DEAD" : "LOST_CLAIM";
      }
      const r = await outboxRepository.scheduleRetry(client, ws, row.id, token, { nextAttemptAtIso: clock.futureIso(retryPolicy.backoffMs(Math.max(1, newAttempts))), incAttempts: counts, resultCode });
      return r ? "RETRIED" : "LOST_CLAIM";
    });
  }

  // Settlement-timeout: re-send the SAME messageId (bounded) or dead-letter per per-type policy.
  async function sweepSettlementTimeouts(ws) {
    return adapter.tenantTransaction(ws, async (client) => {
      const rows = (await client.query(
        `SELECT * FROM protocol_outbox WHERE workspace_id=$1 AND delivery_state='SENT'
           AND awaiting_settlement_since IS NOT NULL
           AND awaiting_settlement_since <= now() - ($2::bigint * interval '1 millisecond')
         ORDER BY awaiting_settlement_since FOR UPDATE SKIP LOCKED LIMIT $3`,
        [ws, settlementTimeoutMs, batchSize])).rows;
      let reArmed = 0, dead = 0;
      for (const row of rows) {
        const desc = settlementFor(row.type) || { deadLetterOnMax: true };
        if (desc.deadLetterOnMax && row.attempts >= row.max_attempts) {
          await outboxRepository.deadLetterSent(client, ws, row.id, { code: "SETTLEMENT_TIMEOUT", reason: "no settlement within window" });
          dead += 1;
        } else {
          await outboxRepository.reArmSent(client, ws, row.id, { resultCode: "SETTLEMENT_TIMEOUT" });
          reArmed += 1;
        }
      }
      return { reArmed, dead };
    });
  }

  // One full drain cycle. Bounded by batchSize per workspace; honors AbortSignal between rows.
  async function runOnce({ signal } = {}) {
    const stats = { claimed: 0, settled: 0, sentAwaiting: 0, sentUncertain: 0, retried: 0, released: 0, deadLettered: 0, lostClaim: 0, reArmed: 0 };
    const wsList = await dueWorkspaces();
    for (const ws of wsList) {
      if (signal && signal.aborted) break;
      const rows = await claimBatch(ws);
      stats.claimed += rows.length;
      for (const row of rows) {
        if (signal && signal.aborted) break;
        const res = await deliver(ws, row, signal);
        const tag = await settle(ws, row, res.result);
        if (tag === "SETTLED") stats.settled += 1;
        else if (tag === "SENT_AWAITING") stats.sentAwaiting += 1;
        else if (tag === "SENT_UNCERTAIN") stats.sentUncertain += 1;
        else if (tag === "RETRIED") stats.retried += 1;
        else if (tag === "RELEASED") stats.released += 1;
        else if (tag === "DEAD") stats.deadLettered += 1;
        else if (tag === "LOST_CLAIM") stats.lostClaim += 1;
      }
    }
    const stList = await settlementTimeoutWorkspaces();
    for (const ws of stList) {
      if (signal && signal.aborted) break;
      const s = await sweepSettlementTimeouts(ws);
      stats.reArmed += s.reArmed;
      stats.deadLettered += s.dead;
    }
    return stats;
  }

  return { runOnce, _claimBatch: claimBatch, _deliver: deliver, _settle: settle, _sweepSettlementTimeouts: sweepSettlementTimeouts };
}
