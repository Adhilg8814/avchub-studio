// P0 Step 5C.21 — identity + tenancy repository (users, workspaces, workspace_members).
//
// Client-taking, parameterized SQL only; no HTTP, no cookies, no UI strings. `users` is the global identity
// table (NO RLS — resolvable pre-context by normalized email). `workspaces` / `workspace_members` are
// workspace-RLS'd (0010): creating them requires the caller to have set app.current_workspace to the target
// id first (the onboarding pattern) — createWorkspace does that itself so a bootstrap/invite-accept txn can
// then insert the membership under the same context. The last-OWNER invariant is enforced in-DB with a row
// lock so two concurrent revoke/downgrade attempts cannot both win.

import { newId } from "../ids.mjs";
import { authError, normalizeEmail, canonicalRole } from "../../auth/auth-errors.mjs";

function requireClient(client) { if (!client || typeof client.query !== "function") throw authError("AUTH_CONTEXT_REQUIRED", "repository requires a transaction client"); }
const one = (r) => (r.rows[0] ?? null);

function mapUser(row) {
  if (!row) return null;
  // NEVER expose password_hash. Safe identity projection only.
  return {
    id: row.id, email: row.email, status: row.status,
    emailVerifiedAt: row.email_verified_at, displayName: row.display_name || null,
    mfaEnforced: row.mfa_enforced === true, lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export const userRepository = {
  normalizeEmail,

  async findByNormalizedEmail(client, email) {
    requireClient(client);
    const r = await client.query("SELECT id,email,status,email_verified_at,display_name,mfa_enforced,last_login_at,created_at,updated_at FROM users WHERE email = $1 LIMIT 1", [normalizeEmail(email)]);
    return mapUser(one(r));
  },

  async findById(client, userId) {
    requireClient(client);
    const r = await client.query("SELECT id,email,status,email_verified_at,display_name,mfa_enforced,last_login_at,created_at,updated_at FROM users WHERE id = $1 LIMIT 1", [userId]);
    return mapUser(one(r));
  },

  // Create a not-yet-usable user (no password, PENDING) — used by invitation acceptance / bootstrap.
  // Fails closed on a duplicate normalized email (unique constraint → AUTH_EMAIL_TAKEN).
  async createInvitedUser(client, { email, displayName = null, status = "PENDING" } = {}) {
    requireClient(client);
    const id = newId("usr");
    try {
      const r = await client.query(
        "INSERT INTO users (id,email,status,display_name) VALUES ($1,$2,$3,$4) RETURNING id,email,status,email_verified_at,display_name,mfa_enforced,last_login_at,created_at,updated_at",
        [id, normalizeEmail(email), status, displayName ? String(displayName).slice(0, 120) : null]
      );
      return mapUser(one(r));
    } catch (e) {
      if (e && e.code === "23505") throw authError("AUTH_EMAIL_TAKEN", "email already registered");
      throw e;
    }
  },

  // First-owner bootstrap primitive: create an ACTIVE owner user. Idempotent-guard is the caller's job
  // (the auth_bootstrap gate); the unique email still fails closed.
  async createBootstrapOwner(client, { email, displayName = null } = {}) {
    return userRepository.createInvitedUser(client, { email, displayName, status: "ACTIVE" });
  },

  async updateStatus(client, userId, status) {
    requireClient(client);
    if (!["ACTIVE", "DISABLED", "PENDING"].includes(status)) throw authError("AUTH_INVALID_ARGUMENT", "bad status");
    const r = await client.query("UPDATE users SET status=$2 WHERE id=$1 RETURNING id,email,status,email_verified_at,display_name,mfa_enforced,last_login_at,created_at,updated_at", [userId, status]);
    const u = mapUser(one(r)); if (!u) throw authError("AUTH_USER_NOT_FOUND", "user not found"); return u;
  },

  async updateEmailVerifiedAt(client, userId, whenIso = null) {
    requireClient(client);
    const r = await client.query("UPDATE users SET email_verified_at = COALESCE($2, now()), status = CASE WHEN status='PENDING' THEN 'ACTIVE' ELSE status END WHERE id=$1 RETURNING id", [userId, whenIso]);
    if (!one(r)) throw authError("AUTH_USER_NOT_FOUND", "user not found"); return true;
  },

  async updateLastLoginMetadata(client, userId, { ip = null } = {}) {
    requireClient(client);
    await client.query("UPDATE users SET last_login_at = now() WHERE id=$1", [userId]);
    return true;
  },

  async setMfaEnforced(client, userId, enforced) {
    requireClient(client);
    await client.query("UPDATE users SET mfa_enforced=$2 WHERE id=$1", [userId, enforced === true]);
    return true;
  },

  // Safe metadata for a set of user ids (admin listing). Never includes secrets.
  async listSafeUserMetadata(client, userIds = null) {
    requireClient(client);
    const r = userIds
      ? await client.query("SELECT id,email,status,email_verified_at,display_name,mfa_enforced,last_login_at,created_at,updated_at FROM users WHERE id = ANY($1) ORDER BY created_at", [userIds])
      : await client.query("SELECT id,email,status,email_verified_at,display_name,mfa_enforced,last_login_at,created_at,updated_at FROM users ORDER BY created_at LIMIT 500");
    return r.rows.map(mapUser);
  }
};

function mapMembership(row) {
  if (!row) return null;
  return { id: row.id, workspaceId: row.workspace_id, userId: row.user_id, role: canonicalRole(row.role) || row.role, createdAt: row.created_at };
}

export const workspaceRepository = {
  // Create a workspace. workspaces RLS requires app.current_workspace == the NEW id for the INSERT, so we
  // set it here (txn-local) — subsequent membership inserts in the same txn then run under that context.
  async createWorkspace(client, { name, ownerUserId } = {}) {
    requireClient(client);
    if (!ownerUserId) throw authError("AUTH_INVALID_ARGUMENT", "ownerUserId required");
    const id = newId("ws");
    await client.query("SELECT set_config('app.current_workspace', $1, true)", [id]);
    const r = await client.query(
      "INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,$2,$3) RETURNING id,name,owner_user_id,created_at",
      [id, String(name || "Workspace").slice(0, 120), ownerUserId]
    );
    const w = one(r);
    return { id: w.id, name: w.name, ownerUserId: w.owner_user_id, createdAt: w.created_at };
  },

  async findWorkspaceById(client, workspaceId) {
    requireClient(client);
    const r = await client.query("SELECT id,name,owner_user_id,created_at FROM workspaces WHERE id=$1 LIMIT 1", [workspaceId]);
    const w = one(r); return w ? { id: w.id, name: w.name, ownerUserId: w.owner_user_id, createdAt: w.created_at } : null;
  },

  // Create a membership (app.current_workspace must already be the target workspace). Duplicate (ws,user)
  // fails closed (unique constraint) → AUTH_MEMBERSHIP_EXISTS.
  async createMembership(client, { workspaceId, userId, role } = {}) {
    requireClient(client);
    const canon = canonicalRole(role);
    if (!canon) throw authError("AUTH_ROLE_INVALID", "invalid role");
    const id = newId("mship");
    try {
      const r = await client.query(
        "INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ($1,$2,$3,$4) RETURNING id,workspace_id,user_id,role,created_at",
        [id, workspaceId, userId, canon]
      );
      return mapMembership(one(r));
    } catch (e) {
      if (e && e.code === "23505") throw authError("AUTH_MEMBERSHIP_EXISTS", "membership already exists");
      throw e;
    }
  },

  async findMembership(client, { workspaceId, userId } = {}) {
    requireClient(client);
    const r = await client.query("SELECT id,workspace_id,user_id,role,created_at FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 LIMIT 1", [workspaceId, userId]);
    return mapMembership(one(r));
  },

  // Enumerate a user's memberships across ALL workspaces WITHOUT a workspace context (login workspace
  // selection). Uses the cp_auth_user_memberships SECURITY DEFINER (0024) — the one pre-context reader.
  async listUserMemberships(client, userId) {
    requireClient(client);
    const r = await client.query("SELECT workspace_id, role FROM cp_auth_user_memberships($1)", [userId]);
    return r.rows.map((x) => ({ workspaceId: x.workspace_id, role: canonicalRole(x.role) || x.role }));
  },

  // All memberships for a user (across workspaces). Runs pre-workspace-context: workspace_members is
  // workspace-RLS'd, so this must be called with app.current_workspace UNSET is NOT possible — instead the
  // caller lists via the non-RLS users→a dedicated path. We expose it as a definer-free helper that the
  // service calls per-workspace, OR (here) rely on the membership being visible only under its workspace.
  // For cross-workspace listing the service iterates candidate workspaces resolved from a trusted source.
  async listMembershipsForUserInWorkspace(client, { workspaceId, userId } = {}) {
    requireClient(client);
    const r = await client.query("SELECT id,workspace_id,user_id,role,created_at FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId]);
    return r.rows.map(mapMembership);
  },

  // Count ACTIVE OWNER memberships in a workspace WITH a row lock, so concurrent revoke/downgrade/suspend of
  // the last active owner cannot both proceed. A SUSPENDED owner does NOT count — a workspace must always
  // retain at least one ACTIVE owner (a suspended-only owner would lock everyone out). Caller holds the txn
  // open across the subsequent mutate.
  async countOwnersForUpdate(client, workspaceId) {
    requireClient(client);
    const r = await client.query("SELECT id FROM workspace_members WHERE workspace_id=$1 AND role='OWNER' AND status='ACTIVE' FOR UPDATE", [workspaceId]);
    return r.rows.length;
  },

  async updateMembershipRole(client, { workspaceId, userId, role } = {}) {
    requireClient(client);
    const canon = canonicalRole(role);
    if (!canon) throw authError("AUTH_ROLE_INVALID", "invalid role");
    const cur = await workspaceRepository.findMembership(client, { workspaceId, userId });
    if (!cur) throw authError("AUTH_MEMBERSHIP_NOT_FOUND", "membership not found");
    if (cur.role === "OWNER" && canon !== "OWNER") {
      if ((await workspaceRepository.countOwnersForUpdate(client, workspaceId)) <= 1) throw authError("AUTH_LAST_OWNER", "cannot downgrade the last owner");
    }
    const r = await client.query("UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2 RETURNING id,workspace_id,user_id,role,created_at", [workspaceId, userId, canon]);
    return mapMembership(one(r));
  },

  // Atomic ownership transfer: promote the target to OWNER + set the old owner's new role. Never leaves the
  // workspace with zero owners (the target becomes OWNER in the same txn as any old-owner downgrade).
  async transferOwnership(client, { workspaceId, fromUserId, toUserId, oldOwnerRole = "ADMIN" } = {}) {
    requireClient(client);
    const target = await workspaceRepository.findMembership(client, { workspaceId, userId: toUserId });
    if (!target) throw authError("AUTH_MEMBERSHIP_NOT_FOUND", "target is not a member");
    const canon = canonicalRole(oldOwnerRole) || "ADMIN";
    await client.query("UPDATE workspace_members SET role='OWNER' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, toUserId]);
    await client.query("UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2", [workspaceId, fromUserId, canon]);
    await client.query("UPDATE workspaces SET owner_user_id=$2 WHERE id=$1", [workspaceId, toUserId]);
    return true;
  },

  async revokeMembership(client, { workspaceId, userId } = {}) {
    requireClient(client);
    const cur = await workspaceRepository.findMembership(client, { workspaceId, userId });
    if (!cur) throw authError("AUTH_MEMBERSHIP_NOT_FOUND", "membership not found");
    if (cur.role === "OWNER" && (await workspaceRepository.countOwnersForUpdate(client, workspaceId)) <= 1) throw authError("AUTH_LAST_OWNER", "cannot revoke the last owner");
    await client.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId]);
    return true;
  },

  // P0 Step 5C.29 Phase 6 — SUSPEND/REACTIVATE a membership (workspace-scoped, distinct from disabling the
  // global user). A suspended membership is invisible to cp_auth_user_memberships (0034) so it fails closed on
  // every access decision. Never suspend the last ACTIVE owner (would lock the workspace out).
  async setMembershipStatus(client, { workspaceId, userId, status } = {}) {
    requireClient(client);
    if (status !== "ACTIVE" && status !== "SUSPENDED") throw authError("AUTH_STATUS_INVALID", "invalid membership status");
    const cur = await workspaceRepository.findMembership(client, { workspaceId, userId });
    if (!cur) throw authError("AUTH_MEMBERSHIP_NOT_FOUND", "membership not found");
    if (status === "SUSPENDED" && cur.role === "OWNER" && (await workspaceRepository.countOwnersForUpdate(client, workspaceId)) <= 1) throw authError("AUTH_LAST_OWNER", "cannot suspend the last active owner");
    const r = await client.query("UPDATE workspace_members SET status=$3 WHERE workspace_id=$1 AND user_id=$2 RETURNING id,workspace_id,user_id,role,status,created_at", [workspaceId, userId, status]);
    const row = one(r);
    return { id: row.id, workspaceId: row.workspace_id, userId: row.user_id, role: canonicalRole(row.role) || row.role, status: row.status, createdAt: row.created_at };
  },

  // All members of a workspace (role + status) — the Members list. Runs under workspace RLS, so it sees ONLY
  // this workspace's members (including SUSPENDED ones, which the access-path resolver hides).
  async listWorkspaceMembers(client, workspaceId) {
    requireClient(client);
    const r = await client.query("SELECT id,workspace_id,user_id,role,status,created_at FROM workspace_members WHERE workspace_id=$1 ORDER BY created_at", [workspaceId]);
    return r.rows.map((x) => ({ id: x.id, workspaceId: x.workspace_id, userId: x.user_id, role: canonicalRole(x.role) || x.role, status: x.status, createdAt: x.created_at }));
  }
};
