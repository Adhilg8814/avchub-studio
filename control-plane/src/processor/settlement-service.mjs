// P0 Step 5C.3 — settlement service: apply a validated, correlated inbound response/ACK to the
// outbox row it settles. Uses the ONE canonical settlement map — never a second mapping. All
// functions are client-taking (run inside the caller's tenant transaction) and idempotent (a
// duplicate/late response finds the row already ACKED and settles nothing further).

import { outboxRepository } from "../persistence/repositories/protocol-repository.mjs";
import { outboxTypesSettledBy, settlementFor, ORDERING } from "./settlement-map.mjs";

// Settle a JOB-scoped lifecycle response (JOB_ACCEPTED/JOB_REJECTED → JOB_OFFER;
// JOB_CANCELED → JOB_CANCEL_REQUEST). Returns the settled outbox row or null.
export async function settleLifecycleForJob(client, workspaceId, jobId, responseType) {
  if (!jobId) return null;
  const types = outboxTypesSettledBy(responseType).filter((t) => {
    const d = settlementFor(t); return d && d.ordering === ORDERING.WORKER_JOB;
  });
  if (types.length === 0) return null;
  const inflight = await outboxRepository.findInFlightForJob(client, workspaceId, jobId, types);
  if (!inflight) return null;
  return outboxRepository.settleByMessageId(client, workspaceId, inflight.message_id, { reason: `LIFECYCLE:${responseType}` });
}

// Settle a WORKER-scoped lifecycle response (PROVIDER_SESSION_STATUS → SESSION_CHECK_REQUEST;
// STATE_RECONCILE → STATE_RECONCILE_REQUEST). Returns the settled outbox row or null.
export async function settleLifecycleForWorker(client, workspaceId, workerId, responseType) {
  const types = outboxTypesSettledBy(responseType).filter((t) => {
    const d = settlementFor(t); return d && d.ordering === ORDERING.WORKER;
  });
  if (types.length === 0) return null;
  const inflight = await outboxRepository.findInFlightForWorker(client, workspaceId, workerId, types);
  if (!inflight) return null;
  return outboxRepository.settleByMessageId(client, workspaceId, inflight.message_id, { reason: `LIFECYCLE:${responseType}` });
}

// Settle a MESSAGE_ACK-mode outbox row by the ackedMessageId the worker returned. Only an
// ACCEPTED ack that correlates to an in-flight MESSAGE_ACK-mode row for THIS worker settles it.
// A mismatched ackedMessageId settles nothing; a REJECTED/VALIDATION_FAILED ack dead-letters the
// row (the worker refused it — do not resend forever).
export async function settleMessageAck(client, workspaceId, { workerId, ackedMessageId, status }) {
  const row = await outboxRepository.findByMessageId(client, workspaceId, ackedMessageId);
  if (!row || row.worker_id !== workerId) return { settled: false, reason: "NO_CORRELATED_ROW" };
  const d = settlementFor(row.type);
  if (!d || d.mode !== "MESSAGE_ACK") return { settled: false, reason: "NOT_MESSAGE_ACK_MODE" };
  if (!["PENDING", "SENT"].includes(row.delivery_state)) return { settled: true, reason: "ALREADY_SETTLED", row };
  if (status === "ACCEPTED") {
    const settled = await outboxRepository.settleByMessageId(client, workspaceId, ackedMessageId, { reason: "MESSAGE_ACK:ACCEPTED" });
    return { settled: Boolean(settled), reason: "ACCEPTED", row: settled };
  }
  // REJECTED / VALIDATION_FAILED — stop resending; preserve forensic evidence (arch §12).
  await client.query(
    `UPDATE protocol_outbox SET delivery_state='DEAD', dead_letter_code=$3, dead_letter_reason=$4, settled_at=now(), revision=revision+1,
       claimed_by=NULL, claim_token=NULL, claimed_at=NULL, claim_expires_at=NULL
     WHERE workspace_id=$1 AND message_id=$2 AND delivery_state IN ('PENDING','SENT')`,
    [workspaceId, ackedMessageId, `ACK_${status}`, `worker ${status} the message`]);
  return { settled: false, reason: `ACK_${status}` };
}
