// AVC Studio P0 Step 3 — pending-ACK persistence (filesystem-backed).
//
// Second designated impure worker module (uses node:fs). Persists important
// OUTBOUND worker→cloud messages until the cloud confirms delivery with
// MESSAGE_ACK{ status:"ACCEPTED" }. This is what lets a crashed worker re-deliver
// a terminal result / recovery report / reconcile batch on restart instead of
// losing it (or, worse, re-running the paid job to reproduce it).
//
// Scope for this step: persistence + acknowledge/diagnostics transitions only.
// There are deliberately NO retry timers here (a later step owns re-send timing).
//
// Layout under the configurable root:
//   <root>/pending-ack/<messageId>.json   one file per un-acked message
//   <root>/diagnostics/<messageId>.*.json ack that was REJECTED/VALIDATION_FAILED
//
// A MESSAGE_ACK is NEVER itself persisted for acknowledgement (no ack loops).

import {
  mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync,
  existsSync, rmSync
} from "node:fs";
import path from "node:path";
import { generateId, validateId } from "../protocol/ids.mjs";
import {
  JOURNAL_SCHEMA_VERSION, WORKER_ERRORS, workerError, assertRecordSafe, ackFileName
} from "./journal-safety.mjs";

// The only worker→cloud messages worth persisting for delivery. Matches
// ACK_REQUIRING_TYPES minus WORKER_CREDENTIAL_ROTATE (cloud→worker).
export const PENDING_ACK_TYPES = Object.freeze([
  "JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED",
  "JOB_RECOVERY_REPORT", "STATE_RECONCILE", "ASSET_METADATA_UPSERT"
]);
const PENDING_ACK_SET = new Set(PENDING_ACK_TYPES);

export class PendingAckStore {
  constructor({ root, now, schemaVersion } = {}) {
    if (!root || typeof root !== "string") throw new Error("PendingAckStore requires a root directory");
    this._dir = path.join(root, "pending-ack");
    this._diagnosticsDir = path.join(root, "diagnostics");
    this._now = typeof now === "function" ? now : () => new Date().toISOString();
    this._schemaVersion = Number.isInteger(schemaVersion) ? schemaVersion : JOURNAL_SCHEMA_VERSION;
    this._dSeq = 0;
  }

  _pathFor(messageId) { return path.join(this._dir, ackFileName(messageId)); }
  _ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }

  _writeAtomic(filePath, data) {
    this._ensureDir(path.dirname(filePath));
    const tmp = path.join(path.dirname(filePath), `.tmp-${generateId("msg").slice(4)}-${path.basename(filePath)}`);
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, filePath);
  }

  // put(envelope): persist an outbound message pending its ACK. Rejects any type
  // that is not in PENDING_ACK_TYPES (in particular MESSAGE_ACK) so we never try
  // to "await an ack for an ack".
  put(envelope) {
    if (!envelope || typeof envelope !== "object") throw workerError(WORKER_ERRORS.E_JOURNAL_UNSAFE, "put requires an envelope", {});
    if (envelope.type === "MESSAGE_ACK") throw workerError(WORKER_ERRORS.E_JOURNAL_UNSAFE, "MESSAGE_ACK is never persisted for ack", { field: "type" });
    if (!PENDING_ACK_SET.has(envelope.type)) throw workerError(WORKER_ERRORS.E_JOURNAL_UNSAFE, `Type ${envelope.type} is not ack-tracked`, { field: "type" });
    if (!validateId(envelope.messageId, "msg")) throw workerError(WORKER_ERRORS.E_JOURNAL_INVALID_REF, "envelope.messageId must be msg_<ULID>", { field: "messageId" });

    const ts = this._now();
    const record = {
      schemaVersion: this._schemaVersion,
      messageId: envelope.messageId,
      type: envelope.type,
      jobId: envelope.jobId ?? null,
      status: "PENDING",
      envelope, // safe by construction; re-checked below
      createdAt: ts,
      updatedAt: ts
    };
    assertRecordSafe(record); // defense-in-depth: no secret/URL/absolute-path leaks
    this._writeAtomic(this._pathFor(envelope.messageId), record);
    return record;
  }

  get(messageId) {
    if (!validateId(messageId, "msg")) return null;
    const file = this._pathFor(messageId);
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch { return this._moveToDiagnostics(messageId, "invalid-json"); }
  }

  has(messageId) {
    if (!validateId(messageId, "msg")) return false;
    return existsSync(this._pathFor(messageId));
  }

  // list(): all still-pending records, deterministic order (messageId sort).
  list() {
    if (!existsSync(this._dir)) return [];
    const out = [];
    for (const file of readdirSync(this._dir).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-")).sort()) {
      const messageId = file.slice(0, -".json".length);
      if (!validateId(messageId, "msg")) continue;
      const rec = this.get(messageId);
      if (rec && !rec.diagnostic) out.push(rec);
    }
    return out;
  }

  // markAcknowledged(messageId): the ACCEPTED path — delivery confirmed, so the
  // pending record is removed. (Persistence removed ONLY after ACCEPTED.)
  markAcknowledged(messageId) {
    return this.remove(messageId);
  }

  remove(messageId) {
    if (!validateId(messageId, "msg")) return false;
    const file = this._pathFor(messageId);
    if (existsSync(file)) { rmSync(file, { force: true }); return true; }
    return false;
  }

  // onAck(ackEnvelope): apply a received MESSAGE_ACK. ACCEPTED → remove pending.
  // REJECTED / VALIDATION_FAILED → move to diagnostics (kept for the operator; no
  // auto-resend in this step). Returns { found, accepted, status }.
  onAck(ackEnvelope) {
    const payload = ackEnvelope && ackEnvelope.payload ? ackEnvelope.payload : ackEnvelope;
    const ackedMessageId = payload && payload.ackedMessageId;
    const status = payload && payload.status;
    if (!validateId(ackedMessageId, "msg")) return { found: false, accepted: false, status: null };
    if (!this.has(ackedMessageId)) return { found: false, accepted: false, status: status ?? null };

    if (status === "ACCEPTED") {
      this.remove(ackedMessageId);
      return { found: true, accepted: true, status };
    }
    // REJECTED / VALIDATION_FAILED (or anything non-ACCEPTED): quarantine to diagnostics.
    this._moveToDiagnostics(ackedMessageId, status ? `ack-${status}` : "ack-non-accepted", payload && payload.errorCode);
    return { found: true, accepted: false, status: status ?? null };
  }

  _moveToDiagnostics(messageId, reason, errorCode) {
    const src = this._pathFor(messageId);
    if (!existsSync(src)) return { messageId, diagnostic: true, reason };
    this._ensureDir(this._diagnosticsDir);
    this._dSeq += 1;
    const dest = path.join(this._diagnosticsDir, `${ackFileName(messageId)}.${this._dSeq}.diag.json`);
    try { renameSync(src, dest); }
    catch {
      try { const bytes = readFileSync(src); writeFileSync(dest, bytes); rmSync(src, { force: true }); }
      catch { return { messageId, diagnostic: true, reason }; }
    }
    try {
      const code = typeof errorCode === "string" && /^E_[A-Z_]+$/.test(errorCode) ? errorCode : null;
      writeFileSync(`${dest}.note.json`, `${JSON.stringify({ reason, errorCode: code, at: this._now() }, null, 2)}\n`, "utf8");
    } catch { /* best effort */ }
    return { messageId, diagnostic: true, reason };
  }

  listDiagnostics() {
    if (!existsSync(this._diagnosticsDir)) return [];
    return readdirSync(this._diagnosticsDir).filter((f) => f.endsWith(".diag.json")).sort();
  }
}
