// P0 Step 5C.21 — bearer-token repository: invitations, password-reset, email-verification, owner
// bootstrap, and the pre-auth MFA challenge. Every token is stored as a sha256 HASH only (the plaintext is
// returned to the caller exactly once at creation and handed to a cookie / emailed link / QR by a higher
// layer). Consumption is a single conditional UPDATE ... RETURNING so two concurrent redeems yield exactly
// one winner (the rest see AUTH_TOKEN_CONSUMED). These tables are looked up pre-context by hash, so they are
// non-RLS + service-mediated (granted to cp_tenant_app in 0022/0023).

import { newId } from "../ids.mjs";
import { authError, normalizeEmail, canonicalRole } from "../../auth/auth-errors.mjs";

function requireClient(client) { if (!client || typeof client.query !== "function") throw authError("AUTH_CONTEXT_REQUIRED", "repository requires a transaction client"); }
const one = (r) => (r.rows[0] ?? null);

export const invitationRepository = {
  async createInvitation(client, { workspaceId, email, role, tokenHash, expiresAt, invitedBy = null } = {}) {
    requireClient(client);
    const canon = canonicalRole(role);
    if (!canon) throw authError("AUTH_ROLE_INVALID", "invalid role");
    const id = newId("uinv");
    await client.query(
      "INSERT INTO user_invitations (id,workspace_id,email,role,token_hash,status,invited_by,expires_at) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7)",
      [id, workspaceId, normalizeEmail(email), canon, tokenHash, invitedBy, expiresAt]
    );
    return { id, workspaceId, email: normalizeEmail(email), role: canon, expiresAt };
  },

  // Atomic one-time accept: only a PENDING, unexpired invitation flips to ACCEPTED. Returns the binding
  // (workspace/email/role) so the service can create the user + membership. Distinguishes expired vs consumed.
  // Non-consuming peek of a PENDING, unexpired invitation (for the accept-invite metadata preview). Returns
  // ONLY safe fields; never mutates. user_invitations is non-RLS/service-mediated (0022).
  async peekInvitation(client, { tokenHash, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query("SELECT workspace_id, email, role, expires_at FROM user_invitations WHERE token_hash=$1 AND status='PENDING' AND expires_at > to_timestamp($2/1000.0) LIMIT 1", [tokenHash, nowMs]);
    const row = one(r);
    return row ? { workspaceId: row.workspace_id, email: row.email, role: canonicalRole(row.role), expiresAt: row.expires_at } : null;
  },

  async consumeInvitation(client, { tokenHash, acceptedUserId, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      `UPDATE user_invitations SET status='ACCEPTED', accepted_at=now(), accepted_user_id=$2
       WHERE token_hash=$1 AND status='PENDING' AND expires_at > to_timestamp($3/1000.0)
       RETURNING id,workspace_id,email,role`,
      [tokenHash, acceptedUserId, nowMs]
    );
    const row = one(r);
    if (row) return { id: row.id, workspaceId: row.workspace_id, email: row.email, role: canonicalRole(row.role) };
    // classify the failure without leaking existence broadly
    const probe = one(await client.query("SELECT status, (expires_at <= to_timestamp($2/1000.0)) expired FROM user_invitations WHERE token_hash=$1", [tokenHash, nowMs]));
    if (!probe) throw authError("AUTH_TOKEN_INVALID", "invitation not found");
    if (probe.status !== "PENDING") throw authError("AUTH_TOKEN_CONSUMED", "invitation already used/revoked");
    throw authError("AUTH_TOKEN_EXPIRED", "invitation expired");
  },

  async revokeInvitation(client, { invitationId, workspaceId } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE user_invitations SET status='REVOKED' WHERE id=$1 AND workspace_id=$2 AND status='PENDING' RETURNING id", [invitationId, workspaceId]);
    return Boolean(one(r));
  },

  async listInvitations(client, workspaceId) {
    requireClient(client);
    const r = await client.query("SELECT id,workspace_id,email,role,status,invited_by,expires_at,accepted_at,created_at FROM user_invitations WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 200", [workspaceId]);
    return r.rows.map((x) => ({ id: x.id, workspaceId: x.workspace_id, email: x.email, role: canonicalRole(x.role) || x.role, status: x.status, invitedBy: x.invited_by, expiresAt: x.expires_at, acceptedAt: x.accepted_at, createdAt: x.created_at }));
  },

  // P0 Step 5C.29 Phase 6 — RESEND a PENDING invitation: rotate its token hash + expiry so the old link dies
  // and a fresh one is issued. Workspace-scoped (id + workspace_id) so an admin can never resend another
  // workspace's invitation. Returns the binding (email/role) for re-enqueuing the notification, or null.
  async resendInvitation(client, { invitationId, workspaceId, tokenHash, expiresAt } = {}) {
    requireClient(client);
    const r = await client.query(
      "UPDATE user_invitations SET token_hash=$3, expires_at=$4 WHERE id=$1 AND workspace_id=$2 AND status='PENDING' RETURNING email, role",
      [invitationId, workspaceId, tokenHash, expiresAt]
    );
    const row = one(r);
    return row ? { email: row.email, role: canonicalRole(row.role) || row.role } : null;
  }
};

export const passwordResetTokenRepository = {
  async createResetToken(client, { userId, tokenHash, expiresAt } = {}) {
    requireClient(client);
    const id = newId("pwreset");
    await client.query("INSERT INTO password_reset_tokens (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)", [id, userId, tokenHash, expiresAt]);
    return { id };
  },
  async consumeResetToken(client, { tokenHash, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      "UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > to_timestamp($2/1000.0) RETURNING user_id",
      [tokenHash, nowMs]
    );
    const row = one(r);
    if (row) return { userId: row.user_id };
    const probe = one(await client.query("SELECT used_at,(expires_at <= to_timestamp($2/1000.0)) expired FROM password_reset_tokens WHERE token_hash=$1", [tokenHash, nowMs]));
    if (!probe) throw authError("AUTH_TOKEN_INVALID", "reset token invalid");
    if (probe.used_at) throw authError("AUTH_TOKEN_CONSUMED", "reset token used");
    throw authError("AUTH_TOKEN_EXPIRED", "reset token expired");
  },
  async revokeAllForUser(client, userId) {
    requireClient(client);
    await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [userId]);
    return true;
  }
};

export const emailVerificationTokenRepository = {
  async createVerifyToken(client, { userId, email, tokenHash, expiresAt } = {}) {
    requireClient(client);
    const id = newId("emverf");
    await client.query("INSERT INTO email_verification_tokens (id,user_id,email,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)", [id, userId, normalizeEmail(email), tokenHash, expiresAt]);
    return { id };
  },
  // Bind to the email captured at issue time — the service must additionally confirm the user's CURRENT
  // email still matches (an email change invalidates outstanding tokens via invalidateForUser).
  async consumeVerifyToken(client, { tokenHash, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      "UPDATE email_verification_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > to_timestamp($2/1000.0) RETURNING user_id,email",
      [tokenHash, nowMs]
    );
    const row = one(r);
    if (row) return { userId: row.user_id, email: row.email };
    const probe = one(await client.query("SELECT used_at,(expires_at <= to_timestamp($2/1000.0)) expired FROM email_verification_tokens WHERE token_hash=$1", [tokenHash, nowMs]));
    if (!probe) throw authError("AUTH_TOKEN_INVALID", "verification token invalid");
    if (probe.used_at) throw authError("AUTH_TOKEN_CONSUMED", "verification token used");
    throw authError("AUTH_TOKEN_EXPIRED", "verification token expired");
  },
  async invalidateForUser(client, userId) {
    requireClient(client);
    await client.query("UPDATE email_verification_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [userId]);
    return true;
  }
};

export const bootstrapTokenRepository = {
  async createBootstrapToken(client, { tokenHash, expiresAt } = {}) {
    requireClient(client);
    const id = newId("boot");
    await client.query("INSERT INTO auth_bootstrap_tokens (id,token_hash,expires_at) VALUES ($1,$2,$3)", [id, tokenHash, expiresAt]);
    return { id };
  },
  async consumeBootstrapToken(client, { tokenHash, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE auth_bootstrap_tokens SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at > to_timestamp($2/1000.0) RETURNING id", [tokenHash, nowMs]);
    return Boolean(one(r));
  },
  async anyValidUnconsumed(client, { nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query("SELECT 1 FROM auth_bootstrap_tokens WHERE consumed_at IS NULL AND expires_at > to_timestamp($1/1000.0) LIMIT 1", [nowMs]);
    return r.rows.length > 0;
  }
};

// P0 Step 5C.23 — the singleton first-owner bootstrap CEREMONY state machine (0030). Distinct from the
// operator authorization proof above: this holds the transient candidate (email + argon2id password hash +
// AES-GCM TOTP ciphertext) between begin and confirm and is the atomic single-winner authority. `claim`
// (begin) matches exactly one concurrent caller; `lockForConfirm` (SELECT ... FOR UPDATE) serializes
// confirms so the loser blocks then reads a COMPLETED row and creates nothing.
const mapCeremony = (row) => row ? {
  state: row.state, ceremonyProofHash: row.ceremony_proof_hash || null, proofExpiresAt: row.proof_expires_at || null,
  candidateEmail: row.candidate_email || null, candidateDisplayName: row.candidate_display_name || null,
  candidatePasswordHash: row.candidate_password_hash || null, candidateTotpCiphertext: row.candidate_totp_ciphertext || null,
  ownerUserId: row.owner_user_id || null, completedAt: row.completed_at || null
} : null;

export const bootstrapCeremonyRepository = {
  // Non-secret status read (never returns candidate secret material).
  async readState(client) {
    requireClient(client);
    const r = await client.query("SELECT state, proof_expires_at, owner_user_id, completed_at FROM auth_bootstrap WHERE id = true LIMIT 1");
    const row = one(r);
    return row ? { state: row.state, proofExpiresAt: row.proof_expires_at || null, ownerUserId: row.owner_user_id || null, completedAt: row.completed_at || null } : null;
  },
  // Pre-context authoritative "does an owner already exist?" via the 0030 SECURITY DEFINER.
  async ownerExists(client) {
    requireClient(client);
    return one(await client.query("SELECT cp_auth_owner_exists() AS x")).x === true;
  },
  // Atomic single-winner claim (begin). Succeeds ONLY from REQUIRED, or from an IN_PROGRESS ceremony whose
  // resume proof has already expired (a prior abandoned attempt -> restartable). Never from COMPLETED.
  async claim(client, { candidateEmail, candidateDisplayName = null, candidatePasswordHash, candidateTotpCiphertext, ceremonyProofHash, proofExpiresAt, claimedIp = null, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      `UPDATE auth_bootstrap SET state='IN_PROGRESS', candidate_email=$1, candidate_display_name=$2,
         candidate_password_hash=$3, candidate_totp_ciphertext=$4, ceremony_proof_hash=$5,
         proof_expires_at=$6, claimed_at=now(), claimed_ip=$7, owner_user_id=NULL
       WHERE id = true AND state <> 'COMPLETED'
         AND (state = 'REQUIRED' OR (state = 'IN_PROGRESS' AND proof_expires_at < to_timestamp($8/1000.0)))
       RETURNING state`,
      [normalizeEmail(candidateEmail), candidateDisplayName ? String(candidateDisplayName).slice(0, 120) : null, candidatePasswordHash, candidateTotpCiphertext, ceremonyProofHash, proofExpiresAt, claimedIp, nowMs]
    );
    return Boolean(one(r));
  },
  // Lock the singleton FOR UPDATE (serializes confirms) and return the candidate material for the winner.
  async lockForConfirm(client) {
    requireClient(client);
    const r = await client.query("SELECT state, ceremony_proof_hash, proof_expires_at, candidate_email, candidate_display_name, candidate_password_hash, candidate_totp_ciphertext, owner_user_id, completed_at FROM auth_bootstrap WHERE id = true FOR UPDATE");
    return mapCeremony(one(r));
  },
  // Finalize: COMPLETED + record owner + CLEAR every transient candidate secret (defence in depth).
  async complete(client, { ownerUserId } = {}) {
    requireClient(client);
    await client.query(
      `UPDATE auth_bootstrap SET state='COMPLETED', owner_user_id=$1, completed_at=now(),
         candidate_email=NULL, candidate_display_name=NULL, candidate_password_hash=NULL,
         candidate_totp_ciphertext=NULL, ceremony_proof_hash=NULL, proof_expires_at=NULL
       WHERE id = true`, [ownerUserId]);
    return true;
  }
};

export const notificationOutboxRepository = {
  // Enqueue a notification transactionally. The link token is stored ONLY as ciphertext (or null for a
  // token-less security notice); recipient_email is the delivery destination; payload is non-secret.
  async enqueue(client, { kind, recipientEmail, userId = null, workspaceId = null, tokenCiphertext = null, payload = {}, expiresAt = null } = {}) {
    requireClient(client);
    if (!["INVITATION", "PASSWORD_RESET", "EMAIL_VERIFICATION", "SECURITY_NOTICE"].includes(kind)) throw authError("AUTH_INVALID_ARGUMENT", "bad kind");
    const id = newId("noti");
    await client.query(
      "INSERT INTO auth_notification_outbox (id,kind,recipient_email,user_id,workspace_id,token_ciphertext,payload,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, kind, normalizeEmail(recipientEmail), userId, workspaceId, tokenCiphertext, JSON.stringify(payload || {}), expiresAt]
    );
    return { id, kind };
  },
  async listPending(client, { limit = 50 } = {}) {
    requireClient(client);
    const r = await client.query("SELECT id,kind,recipient_email,token_ciphertext,payload,expires_at,created_at FROM auth_notification_outbox WHERE status='PENDING' ORDER BY created_at LIMIT $1", [Math.max(1, Math.min(200, limit))]);
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, recipientEmail: x.recipient_email, tokenCiphertext: x.token_ciphertext, payload: x.payload, expiresAt: x.expires_at, createdAt: x.created_at }));
  },
  // After delivery: mark SENT and WIPE the token ciphertext (no lingering secret).
  async markSent(client, { id } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE auth_notification_outbox SET status='SENT', sent_at=now(), token_ciphertext=NULL WHERE id=$1 AND status='PENDING' RETURNING id", [id]);
    return Boolean(one(r));
  },
  async markFailed(client, { id } = {}) {
    requireClient(client);
    await client.query("UPDATE auth_notification_outbox SET status=CASE WHEN attempts+1>=5 THEN 'FAILED' ELSE 'PENDING' END, attempts=attempts+1 WHERE id=$1", [id]);
    return true;
  },
  async cancelForUserKind(client, { userId, kind } = {}) {
    requireClient(client);
    await client.query("UPDATE auth_notification_outbox SET status='CANCELLED', token_ciphertext=NULL WHERE user_id=$1 AND kind=$2 AND status='PENDING'", [userId, kind]);
    return true;
  }
};

export const reauthProofRepository = {
  async createProof(client, { userId, sessionId = null, tokenHash, action, method, workspaceId = null, expiresAt } = {}) {
    requireClient(client);
    if (!["PASSWORD", "TOTP"].includes(method)) throw authError("AUTH_INVALID_ARGUMENT", "bad method");
    const id = newId("rau");
    await client.query(
      "INSERT INTO reauth_proofs (id,user_id,session_id,token_hash,action,method,workspace_id,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, userId, sessionId, tokenHash, String(action).slice(0, 40), method, workspaceId, expiresAt]
    );
    return { id, action, method };
  },
  async resolveProof(client, { tokenHash, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query("SELECT id,user_id,session_id,action,method,workspace_id,verified,expires_at,consumed_at FROM reauth_proofs WHERE token_hash=$1 LIMIT 1", [tokenHash]);
    const row = one(r);
    if (!row) return { ok: false, code: "AUTH_TOKEN_INVALID" };
    if (row.consumed_at) return { ok: false, code: "AUTH_TOKEN_CONSUMED" };
    if (new Date(row.expires_at).getTime() <= nowMs) return { ok: false, code: "AUTH_TOKEN_EXPIRED" };
    return { ok: true, proof: { id: row.id, userId: row.user_id, sessionId: row.session_id, action: row.action, method: row.method, workspaceId: row.workspace_id, verified: row.verified === true } };
  },
  async markVerified(client, { proofId, userId } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE reauth_proofs SET verified=true WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL RETURNING id", [proofId, userId]);
    return Boolean(one(r));
  },
  // Atomic one-time redeem for a specific action (verified proofs only). Exactly one winner.
  async consumeProof(client, { proofId, userId, action, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      "UPDATE reauth_proofs SET consumed_at=now() WHERE id=$1 AND user_id=$2 AND action=$3 AND verified=true AND consumed_at IS NULL AND expires_at > to_timestamp($4/1000.0) RETURNING id",
      [proofId, userId, action, nowMs]
    );
    return Boolean(one(r));
  },
  async revokeForUser(client, userId) {
    requireClient(client);
    await client.query("UPDATE reauth_proofs SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [userId]);
    return true;
  }
};

export const preAuthChallengeRepository = {
  async createChallenge(client, { userId, tokenHash, purpose, loginAttemptId = null, intendedWorkspaceId = null, expiresAt } = {}) {
    requireClient(client);
    if (!["MFA", "MFA_ENROLLMENT"].includes(purpose)) throw authError("AUTH_INVALID_ARGUMENT", "bad purpose");
    const id = newId("pac");
    await client.query(
      "INSERT INTO pre_auth_challenges (id,user_id,token_hash,purpose,login_attempt_id,intended_workspace_id,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, userId, tokenHash, purpose, loginAttemptId, intendedWorkspaceId, expiresAt]
    );
    return { id, purpose };
  },
  // Resolve a live (unconsumed, unexpired) challenge by hash — pre-context, non-RLS.
  async resolveChallenge(client, { tokenHash, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      "SELECT id,user_id,purpose,login_attempt_id,intended_workspace_id,mfa_verified,expires_at,consumed_at FROM pre_auth_challenges WHERE token_hash=$1 LIMIT 1",
      [tokenHash]
    );
    const row = one(r);
    if (!row) return { ok: false, code: "AUTH_TOKEN_INVALID" };
    if (row.consumed_at) return { ok: false, code: "AUTH_TOKEN_CONSUMED" };
    if (new Date(row.expires_at).getTime() <= nowMs) return { ok: false, code: "AUTH_TOKEN_EXPIRED" };
    return { ok: true, challenge: { id: row.id, userId: row.user_id, purpose: row.purpose, loginAttemptId: row.login_attempt_id, intendedWorkspaceId: row.intended_workspace_id, mfaVerified: row.mfa_verified === true } };
  },
  // Mark the challenge's MFA step satisfied (still unconsumed — consumed happens at session issue).
  async markVerified(client, { challengeId, userId } = {}) {
    requireClient(client);
    const r = await client.query("UPDATE pre_auth_challenges SET mfa_verified=true WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL RETURNING id", [challengeId, userId]);
    return Boolean(one(r));
  },
  // Atomic one-time consume (exchanged for a session). Exactly one winner.
  async consumeChallenge(client, { challengeId, userId, requireVerified = true, nowMs = Date.now() } = {}) {
    requireClient(client);
    const r = await client.query(
      `UPDATE pre_auth_challenges SET consumed_at=now() WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL
        AND expires_at > to_timestamp($3/1000.0) ${requireVerified ? "AND mfa_verified=true" : ""} RETURNING id`,
      [challengeId, userId, nowMs]
    );
    return Boolean(one(r));
  },
  async revokeForUser(client, userId) {
    requireClient(client);
    await client.query("UPDATE pre_auth_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [userId]);
    return true;
  }
};
