// P0 Step 5C.21 — credential / MFA / recovery-code repository. All three tables are RLS-isolated by
// app.current_user (0022, FORCE): the caller MUST have set app.current_user to the owning user before any
// call, so a row can only ever be reached by its owner. Race safety is in-DB: rehash uses optimistic
// version matching; TOTP replay uses a monotonic last_used_timestep guard; recovery-code consume is a
// single conditional UPDATE ... RETURNING so concurrent double-use yields exactly one winner. The argon2
// hash is returned ONLY by loadPasswordForVerification (the one place verification needs it); nothing else
// exposes secret_hash / secret_ciphertext / code_hash to the business layer.

import { newId } from "../ids.mjs";
import { authError } from "../../auth/auth-errors.mjs";

function requireClient(client) { if (!client || typeof client.query !== "function") throw authError("AUTH_CONTEXT_REQUIRED", "repository requires a transaction client"); }
const one = (r) => (r.rows[0] ?? null);

export const credentialRepository = {
  async createPasswordCredential(client, { userId, secretHash, params = {}, version = 1 } = {}) {
    requireClient(client);
    if (!userId || !secretHash) throw authError("AUTH_INVALID_ARGUMENT", "userId + secretHash required");
    const id = newId("ucred");
    try {
      await client.query(
        "INSERT INTO user_credentials (id,user_id,kind,secret_hash,algo,params,version) VALUES ($1,$2,'password',$3,'argon2id',$4,$5)",
        [id, userId, secretHash, JSON.stringify(params || {}), version]
      );
      return { id, version };
    } catch (e) {
      if (e && e.code === "23505") throw authError("AUTH_CREDENTIAL_CONFLICT", "password credential already exists");
      throw e;
    }
  },

  // The ONLY method that returns the hash — used solely to verify a login. Caller must not log/echo it.
  async loadPasswordForVerification(client, userId) {
    requireClient(client);
    const r = await client.query("SELECT id,secret_hash,version,params FROM user_credentials WHERE user_id=$1 AND kind='password' LIMIT 1", [userId]);
    const row = one(r);
    return row ? { id: row.id, secretHash: row.secret_hash, version: row.version, params: row.params } : null;
  },

  // Non-secret metadata (has-password? version) for the business layer.
  async getPasswordMetadata(client, userId) {
    requireClient(client);
    const r = await client.query("SELECT id,version,updated_at FROM user_credentials WHERE user_id=$1 AND kind='password' LIMIT 1", [userId]);
    const row = one(r); return row ? { id: row.id, version: row.version, updatedAt: row.updated_at } : null;
  },

  // Optimistic-concurrency replace (rehash-on-login OR password change/reset). Only succeeds if the stored
  // version still equals expectedVersion; a concurrent replace bumps the version so the loser gets 0 rows.
  async replaceHashIfVersionMatches(client, { userId, newHash, params = {}, expectedVersion } = {}) {
    requireClient(client);
    const r = await client.query(
      "UPDATE user_credentials SET secret_hash=$3, params=$4, version=version+1 WHERE user_id=$1 AND kind='password' AND version=$2 RETURNING version",
      [userId, expectedVersion, newHash, JSON.stringify(params || {})]
    );
    const row = one(r);
    if (!row) throw authError("AUTH_CREDENTIAL_CONFLICT", "credential version conflict");
    return { version: row.version };
  },

  // Upsert-style set for invitation-accept / bootstrap (create if absent, else replace + bump version).
  async setPasswordCredential(client, { userId, secretHash, params = {} } = {}) {
    requireClient(client);
    const cur = await credentialRepository.getPasswordMetadata(client, userId);
    if (!cur) return credentialRepository.createPasswordCredential(client, { userId, secretHash, params, version: 1 });
    return credentialRepository.replaceHashIfVersionMatches(client, { userId, newHash: secretHash, params, expectedVersion: cur.version });
  },

  async deletePasswordCredential(client, userId) {
    requireClient(client);
    await client.query("DELETE FROM user_credentials WHERE user_id=$1 AND kind='password'", [userId]);
    return true;
  }
};

export const mfaRepository = {
  // Begin TOTP enrollment: reject if an ACTIVE method exists; retire any stale PENDING; insert a fresh
  // PENDING with the encrypted secret. The partial unique index guarantees at most one non-DISABLED row.
  // allowWithActive: the TOTP REPLACEMENT flow keeps the current ACTIVE method usable while a new PENDING is
  // confirmed (never lock the owner out). Fresh enrollment (allowWithActive=false) still rejects a duplicate.
  async createPendingTotp(client, { userId, secretCiphertext, allowWithActive = false } = {}) {
    requireClient(client);
    if (!userId || !secretCiphertext) throw authError("AUTH_INVALID_ARGUMENT", "userId + secretCiphertext required");
    if (!allowWithActive) {
      const active = await client.query("SELECT id FROM user_mfa_methods WHERE user_id=$1 AND kind='totp' AND status='ACTIVE' LIMIT 1", [userId]);
      if (active.rows.length) throw authError("AUTH_MFA_ALREADY_ACTIVE", "TOTP already active");
    }
    await client.query("UPDATE user_mfa_methods SET status='DISABLED', disabled_at=now() WHERE user_id=$1 AND kind='totp' AND status='PENDING'", [userId]);
    const id = newId("umfa");
    await client.query("INSERT INTO user_mfa_methods (id,user_id,kind,secret_ciphertext,status) VALUES ($1,$2,'totp',$3,'PENDING')", [id, userId, secretCiphertext]);
    return { id, status: "PENDING" };
  },

  // Load the current usable TOTP method (PENDING for confirm, ACTIVE for verify). Returns the ciphertext
  // so the caller can decrypt it in memory to check a code; never persisted/logged by the caller.
  async loadUsableTotp(client, userId, { status = null } = {}) {
    requireClient(client);
    const r = status
      ? await client.query("SELECT id,secret_ciphertext,status,last_used_timestep,activated_at FROM user_mfa_methods WHERE user_id=$1 AND kind='totp' AND status=$2 LIMIT 1", [userId, status])
      : await client.query("SELECT id,secret_ciphertext,status,last_used_timestep,activated_at FROM user_mfa_methods WHERE user_id=$1 AND kind='totp' AND status IN ('ACTIVE','PENDING') ORDER BY (status='ACTIVE') DESC LIMIT 1", [userId]);
    const row = one(r);
    return row ? { id: row.id, secretCiphertext: row.secret_ciphertext, status: row.status, lastUsedTimestep: row.last_used_timestep, activatedAt: row.activated_at } : null;
  },

  async activateTotp(client, { userId, methodId } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE user_mfa_methods SET status='ACTIVE', activated_at=now() WHERE id=$1 AND user_id=$2 AND status='PENDING' RETURNING id", [methodId, userId]);
    if (!one(r)) throw authError("AUTH_MFA_NOT_PENDING", "no pending TOTP to activate");
    return true;
  },

  // Monotonic replay guard: record the accepted timestep ONLY if it is strictly newer than the last one.
  // Returns true on success; false means a code from this-or-an-older timestep was already accepted (replay).
  async recordTimestepIfNewer(client, { userId, methodId, timestep } = {}) {
    requireClient(client);
    const r = await client.query(
      "UPDATE user_mfa_methods SET last_used_timestep=$3 WHERE id=$1 AND user_id=$2 AND (last_used_timestep IS NULL OR last_used_timestep < $3) RETURNING id",
      [methodId, userId, timestep]
    );
    return Boolean(one(r));
  },

  async disableTotp(client, userId) {
    requireClient(client);
    await client.query("UPDATE user_mfa_methods SET status='DISABLED', disabled_at=now() WHERE user_id=$1 AND kind='totp' AND status<>'DISABLED'", [userId]);
    return true;
  },

  async listSafeMfaMetadata(client, userId) {
    requireClient(client);
    const r = await client.query("SELECT kind,status,activated_at,created_at FROM user_mfa_methods WHERE user_id=$1 AND status<>'DISABLED' ORDER BY created_at", [userId]);
    return r.rows.map((x) => ({ kind: x.kind, status: x.status, activatedAt: x.activated_at, createdAt: x.created_at }));
  }
};

export const recoveryCodeRepository = {
  // Replace the whole set: revoke any prior unused codes, then insert the new batch's hashes.
  async createRecoveryCodeSet(client, { userId, batchId, hashes } = {}) {
    requireClient(client);
    if (!Array.isArray(hashes) || hashes.length === 0) throw authError("AUTH_INVALID_ARGUMENT", "hashes required");
    await client.query("UPDATE user_recovery_codes SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [userId]);
    for (const h of hashes) {
      await client.query("INSERT INTO user_recovery_codes (id,user_id,batch_id,code_hash) VALUES ($1,$2,$3,$4)", [newId("urcode"), userId, batchId, h]);
    }
    return { count: hashes.length, batchId };
  },

  // Atomic single-use consume: exactly one concurrent caller can flip used_at. Returns true on success.
  async consumeRecoveryCode(client, { userId, codeHash } = {}) {
    requireClient(client);
    const r = await client.query(
      "UPDATE user_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL AND revoked_at IS NULL RETURNING id",
      [userId, codeHash]
    );
    return Boolean(one(r));
  },

  async revokeAll(client, userId) {
    requireClient(client);
    await client.query("UPDATE user_recovery_codes SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [userId]);
    return true;
  },

  async countActive(client, userId) {
    requireClient(client);
    const r = await client.query("SELECT count(*)::int n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [userId]);
    return one(r).n;
  },

  // Load active code hashes (to do a constant-time match in memory, then consume the matched one).
  async listActiveHashes(client, userId) {
    requireClient(client);
    const r = await client.query("SELECT code_hash FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [userId]);
    return r.rows.map((x) => x.code_hash);
  }
};
