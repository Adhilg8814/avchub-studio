// P0 Step 5C.29 Phase 7 — the dedicated tenant RESOURCE ownership registry (over workspace_resources, 0034).
// The V1 ownership chain is customer -> workspace -> dedicated worker -> provider account -> Cloak profile ->
// proxy/network -> (job -> ledger -> media, already workspace-RLS from earlier phases). This module records +
// resolves the worker/provider/profile/proxy bindings server-side, workspace-scoped, so a tenant can never see,
// bind, or use another tenant's resource:
//   • every read/list/resolve is workspace-RLS (the caller runs inside the workspace tenant transaction), so a
//     foreign binding is simply invisible -> cross-tenant lookups fail closed;
//   • every (resource_type, resource_ref) is GLOBALLY unique (0034 index), so binding the SAME worker/provider/
//     profile/proxy to a second workspace fails with E_RESOURCE_ALREADY_BOUND — dedicated, never shared;
//   • readiness (assertReady) refuses enqueue BEFORE any provider invocation when the dedicated worker +
//     provider account are not present/ACTIVE — no fallback to the owner's or another tenant's resources.
import { DomainError } from "../persistence/domain-errors.mjs";
import { newId } from "../persistence/ids.mjs";

export const RESOURCE_TYPES = Object.freeze(["WORKER", "PROVIDER_ACCOUNT", "CLOAK_PROFILE", "PROXY"]);
export const RESOURCE_ERRORS = Object.freeze({
  ALREADY_BOUND: "E_RESOURCE_ALREADY_BOUND",       // (type, ref) already owned by SOME workspace (dedicated)
  NOT_OWNED: "E_RESOURCE_NOT_OWNED",               // ref not owned by the current workspace (cross-tenant)
  TYPE_INVALID: "E_RESOURCE_TYPE_INVALID",
  DEDICATED_WORKER_REQUIRED: "E_DEDICATED_WORKER_REQUIRED",
  PROVIDER_NOT_READY: "E_PROVIDER_ACCOUNT_NOT_READY"
});

export class ResourceError extends DomainError {
  constructor(code, message) { super("E_INVALID_STATE_TRANSITION", message || code); this.code = code; this.name = "ResourceError"; this.isResourceError = true; }
}

function mapRow(r) { return r ? { id: r.id, workspaceId: r.workspace_id, resourceType: r.resource_type, resourceRef: r.resource_ref, status: r.status, label: r.label, metadata: r.metadata, createdAt: r.created_at } : null; }
const assertType = (t) => { if (!RESOURCE_TYPES.includes(t)) throw new ResourceError(RESOURCE_ERRORS.TYPE_INVALID, `invalid resource type ${t}`); };

// All methods run under the caller's WORKSPACE tenant transaction (app.current_workspace set) so RLS scopes
// every row to that workspace. bind() also inserts the workspace_id explicitly (RLS WITH CHECK verifies it).
export const tenantResourceRepository = {
  async bind(client, { workspaceId, resourceType, resourceRef, label = null, metadata = null, status = "ACTIVE" } = {}) {
    assertType(resourceType);
    if (typeof resourceRef !== "string" || resourceRef.length < 1 || resourceRef.length > 256) throw new ResourceError(RESOURCE_ERRORS.TYPE_INVALID, "invalid resource ref");
    try {
      const r = await client.query(
        "INSERT INTO workspace_resources (id, workspace_id, resource_type, resource_ref, status, label, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [newId("wsrc"), workspaceId, resourceType, resourceRef, status, label, metadata]
      );
      return mapRow(r.rows[0]);
    } catch (e) {
      // 23505 on the GLOBAL (resource_type, resource_ref) unique index = the resource is already dedicated to a
      // workspace (possibly another tenant's). Never leak which workspace — a flat "already bound".
      if (e && e.code === "23505") throw new ResourceError(RESOURCE_ERRORS.ALREADY_BOUND, "resource already bound");
      throw e;
    }
  },

  // List THIS workspace's resources of a type (RLS-scoped), optionally filtered by status.
  async list(client, { resourceType = null, status = null } = {}) {
    const where = [], args = [];
    if (resourceType) { assertType(resourceType); args.push(resourceType); where.push(`resource_type=$${args.length}`); }
    if (status) { args.push(status); where.push(`status=$${args.length}`); }
    const sql = `SELECT * FROM workspace_resources ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at`;
    return (await client.query(sql, args)).rows.map(mapRow);
  },

  // Resolve a resource by (type, ref) but ONLY if it belongs to the CURRENT workspace (RLS hides others). A
  // foreign ref returns null -> the caller treats it as not-owned (cross-tenant use fails closed).
  async resolveOwned(client, { resourceType, resourceRef } = {}) {
    assertType(resourceType);
    const r = await client.query("SELECT * FROM workspace_resources WHERE resource_type=$1 AND resource_ref=$2 LIMIT 1", [resourceType, resourceRef]);
    return mapRow(r.rows[0]);
  },

  // Assert a (type, ref) is owned by the current workspace, else throw NOT_OWNED (used before binding/using it).
  async assertOwned(client, { resourceType, resourceRef } = {}) {
    const row = await tenantResourceRepository.resolveOwned(client, { resourceType, resourceRef });
    if (!row) throw new ResourceError(RESOURCE_ERRORS.NOT_OWNED, "resource not owned by this workspace");
    return row;
  },

  async setStatus(client, { resourceRef, resourceType, status } = {}) {
    assertType(resourceType);
    const r = await client.query("UPDATE workspace_resources SET status=$3 WHERE resource_type=$1 AND resource_ref=$2 RETURNING *", [resourceType, resourceRef, status]);
    return mapRow(r.rows[0]);
  },

  async unbind(client, { resourceRef, resourceType } = {}) {
    assertType(resourceType);
    const r = await client.query("DELETE FROM workspace_resources WHERE resource_type=$1 AND resource_ref=$2 RETURNING id", [resourceType, resourceRef]);
    return r.rows.length > 0;
  },

  // Readiness: the dedicated ownership chain must have an ACTIVE (non-DRAINING) worker AND an ACTIVE provider
  // account bound to THIS workspace before any generation is enqueued. Missing worker -> DEDICATED_WORKER_
  // REQUIRED; missing provider -> PROVIDER_ACCOUNT_NOT_READY. No fallback to another workspace's resources.
  async assertReady(client, { requireProvider = true } = {}) {
    const workers = await tenantResourceRepository.list(client, { resourceType: "WORKER", status: "ACTIVE" });
    if (workers.length === 0) throw new ResourceError(RESOURCE_ERRORS.DEDICATED_WORKER_REQUIRED, "no active dedicated worker");
    if (requireProvider) {
      const providers = await tenantResourceRepository.list(client, { resourceType: "PROVIDER_ACCOUNT", status: "ACTIVE" });
      if (providers.length === 0) throw new ResourceError(RESOURCE_ERRORS.PROVIDER_NOT_READY, "no active provider account");
    }
    return true;
  }
};
