// P0 Step 5C.5 — Worker pairing + credential-lifecycle repository.
//
// Client-taking, workspace-scoped, parameterized SQL only (never string-interpolated values;
// dynamic identifiers are not used here). PostgreSQL is authoritative. Stores NO plaintext: a
// pairing code lives only as pairing_codes.code_hash (peppered HMAC verifier) and a Worker
// credential only as worker_credentials.credential_hash (peppered HMAC verifier).
//
// The claim path resolves the workspace by verifier on the BYPASSRLS ops connection FIRST (the
// workspace is unknown until the code resolves), then performs the authoritative atomic claim on
// the RLS tenant connection with the resolved workspace set.

import { newId } from "../ids.mjs";
import { domainError, DOMAIN_ERRORS } from "../domain-errors.mjs";

function requireClient(client) {
  if (!client || typeof client.query !== "function") throw domainError(DOMAIN_ERRORS.E_INVALID_ARGUMENT, "pairing repository requires a transaction client");
}
const one = (r) => (r.rows[0] ?? null);

// ---- ops (BYPASSRLS, READ ONLY): resolve a pairing code by verifier before workspace is known.
// Returns id + workspace_id + lifecycle columns for the tenant claim to re-lock and re-validate.
export async function lookupPairingByVerifier(opsClient, verifierHex) {
  const r = await opsClient.query(
    `SELECT id, workspace_id, status, expires_at, attempts, max_attempts, purpose
       FROM pairing_codes
      WHERE code_hash = $1 AND status = 'ACTIVE'
      LIMIT 1`, [verifierHex]);
  return r.rows[0] ?? null;
}

export const pairingCodeRepository = {
  async insert(client, workspaceId, { codeHash, expiresAt, requestedLabel = null, capabilities = null, createdByUserId = null, createdByActor = null, maxAttempts = 5, purpose = "WORKER_PAIRING" }) {
    requireClient(client);
    const id = newId("pcode");
    return one(await client.query(
      `INSERT INTO pairing_codes
         (id, workspace_id, code_hash, expires_at, attempts, created_at,
          status, purpose, requested_label, capabilities, created_by_user_id, created_by_actor, max_attempts, revision)
       VALUES ($1,$2,$3,$4,0, now(), 'ACTIVE',$5,$6,$7,$8,$9,$10,0) RETURNING *`,
      [id, workspaceId, codeHash, expiresAt, purpose, requestedLabel, capabilities ? JSON.stringify(capabilities) : null, createdByUserId, createdByActor, maxAttempts]));
  },

  async getById(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query("SELECT * FROM pairing_codes WHERE workspace_id=$1 AND id=$2", [workspaceId, id]));
  },

  async lock(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query("SELECT * FROM pairing_codes WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, id]));
  },

  async countActive(client, workspaceId) {
    requireClient(client);
    const r = await client.query("SELECT count(*)::int AS n FROM pairing_codes WHERE workspace_id=$1 AND status='ACTIVE'", [workspaceId]);
    return r.rows[0].n;
  },

  async listActive(client, workspaceId, { limit = 100 } = {}) {
    requireClient(client);
    return (await client.query(
      "SELECT id, status, purpose, requested_label, expires_at, attempts, max_attempts, created_at, created_by_actor FROM pairing_codes WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2",
      [workspaceId, Math.max(1, Math.min(1000, limit))])).rows;
  },

  // Consume ONLY an ACTIVE row → CONSUMED (guarded); returns the row or null if it was not ACTIVE
  // (already consumed/revoked/locked). This is the atomic one-time-use gate.
  async consume(client, workspaceId, id, workerId) {
    requireClient(client);
    return one(await client.query(
      `UPDATE pairing_codes
         SET status='CONSUMED', used_by_worker_id=$3, used_at=now(), revision=revision+1
       WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' RETURNING *`,
      [workspaceId, id, workerId]));
  },

  // Record a failed presentation of a matched code; lock it once attempts reach max_attempts.
  async recordFailedAttempt(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query(
      `UPDATE pairing_codes
         SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= max_attempts THEN 'LOCKED' ELSE status END,
             revision = revision + 1
       WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' RETURNING id, attempts, max_attempts, status`,
      [workspaceId, id]));
  },

  async revoke(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query(
      `UPDATE pairing_codes SET status='REVOKED', revoked_at=now(), revision=revision+1
       WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' RETURNING id, status`,
      [workspaceId, id]));
  }
};

export const pairedWorkerRepository = {
  async create(client, workspaceId, { name, platform, osVersion = null, architecture = null, workerVersion = null, protocolVersion, installationId = null }) {
    requireClient(client);
    const id = newId("wrk");
    return one(await client.query(
      `INSERT INTO workers
         (id, workspace_id, name, platform, os_version, architecture, worker_version, protocol_version,
          status, installation_id, paired_at, first_seen_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OFFLINE',$9, now(), now(), now(), now()) RETURNING *`,
      [id, workspaceId, name, platform, osVersion, architecture, workerVersion, protocolVersion, installationId]));
  },

  async get(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query("SELECT * FROM workers WHERE workspace_id=$1 AND id=$2", [workspaceId, id]));
  },

  async lock(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query("SELECT * FROM workers WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, id]));
  },

  async list(client, workspaceId) {
    requireClient(client);
    return (await client.query(
      `SELECT id, name, platform, status, protocol_version, installation_id, paired_at, first_seen_at,
              last_seen_at, disabled_at, disable_reason, revoked_at, created_at
         FROM workers WHERE workspace_id=$1 ORDER BY created_at DESC`, [workspaceId])).rows;
  },

  // Disable → terminal REVOKED (gateway auth rejects REVOKED). Only from a non-REVOKED state.
  async disable(client, workspaceId, id, reason = null) {
    requireClient(client);
    return one(await client.query(
      `UPDATE workers
         SET status='REVOKED', disabled_at=now(), disable_reason=$3, revoked_at=now(), updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND status <> 'REVOKED' RETURNING id, status`,
      [workspaceId, id, reason]));
  },

  // Re-enable → OFFLINE (no authority until a fresh credential is issued). Only from REVOKED.
  async enable(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query(
      `UPDATE workers
         SET status='OFFLINE', disabled_at=NULL, disable_reason=NULL, revoked_at=NULL, updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND status='REVOKED' RETURNING id, status`,
      [workspaceId, id]));
  }
};

export const workerCredentialRepository = {
  async getActive(client, workspaceId, workerId) {
    requireClient(client);
    return one(await client.query(
      "SELECT * FROM worker_credentials WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [workspaceId, workerId]));
  },

  async getById(client, workspaceId, id) {
    requireClient(client);
    return one(await client.query("SELECT * FROM worker_credentials WHERE workspace_id=$1 AND id=$2", [workspaceId, id]));
  },

  async insertActive(client, workspaceId, { workerId, credentialHash, expiresAt, rotatedFromCredentialId = null }) {
    requireClient(client);
    const id = newId("cred");   // worker_credentials.id CHECK requires the 'cred_' prefix (NOT the wcred_ plaintext shape)
    return one(await client.query(
      `INSERT INTO worker_credentials
         (id, workspace_id, worker_id, credential_hash, status, issued_at, expires_at,
          rotated_from_credential_id, revision)
       VALUES ($1,$2,$3,$4,'ACTIVE', now(), $5, $6, 0) RETURNING *`,
      [id, workspaceId, workerId, credentialHash, expiresAt, rotatedFromCredentialId]));
  },

  // Revoke the current ACTIVE credential (guarded). Returns the revoked row id or null.
  async revokeActive(client, workspaceId, workerId, reason = null) {
    requireClient(client);
    return one(await client.query(
      `UPDATE worker_credentials
         SET status='REVOKED', revoked_at=now(), revoke_reason=$3, revision=revision+1
       WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE' RETURNING id`,
      [workspaceId, workerId, reason]));
  },

  async revokeById(client, workspaceId, credentialId, reason = null) {
    requireClient(client);
    return one(await client.query(
      `UPDATE worker_credentials
         SET status='REVOKED', revoked_at=now(), revoke_reason=$3, revision=revision+1
       WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' RETURNING id`,
      [workspaceId, credentialId, reason]));
  }
};

// ---- durable idempotency (idempotency_keys). Same (workspace, scope, key) returns the ORIGINAL
// response; a different request_hash for the same key is a conflict. Never stores plaintext
// credentials/codes in `response` — callers pass only safe metadata.
export const idempotencyRepository = {
  async claim(client, workspaceId, { scope, key, requestHash }) {
    requireClient(client);
    const id = newId("idem");
    const ins = await client.query(
      `INSERT INTO idempotency_keys (id, workspace_id, scope, key, request_hash, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'PENDING', now())
       ON CONFLICT (workspace_id, scope, key) DO NOTHING RETURNING *`,
      [id, workspaceId, scope, key, requestHash]);
    if (ins.rowCount === 1) return { fresh: true, row: ins.rows[0] };
    const existing = one(await client.query(
      "SELECT * FROM idempotency_keys WHERE workspace_id=$1 AND scope=$2 AND key=$3", [workspaceId, scope, key]));
    return { fresh: false, row: existing };
  },

  async complete(client, workspaceId, { scope, key, response }) {
    requireClient(client);
    await client.query(
      `UPDATE idempotency_keys SET status='COMPLETED', response=$4
       WHERE workspace_id=$1 AND scope=$2 AND key=$3`,
      [workspaceId, scope, key, response ? JSON.stringify(response) : null]);
  }
};

// ---- durable fixed-window rate limiting (rate_limit_buckets), per (workspace, bucketKey).
export const rateLimitRepository = {
  // Atomically increment the current window's counter; returns the new count.
  async hit(client, workspaceId, bucketKey, windowStartIso) {
    requireClient(client);
    const id = newId("rl");
    const r = await client.query(
      `INSERT INTO rate_limit_buckets (id, workspace_id, bucket_key, window_start, count, updated_at)
       VALUES ($1,$2,$3,$4::timestamptz,1, now())
       ON CONFLICT (bucket_key, window_start)
       DO UPDATE SET count = rate_limit_buckets.count + 1, updated_at = now()
       RETURNING count`,
      [id, workspaceId, bucketKey, windowStartIso]);
    return r.rows[0].count;
  }
};
