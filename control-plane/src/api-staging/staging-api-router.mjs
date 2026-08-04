// P0 Step 5C.6 — staging Project/Generation/Job/Result HTTP router.
//
// Reuses the Step 5C.5 staging operator-auth boundary (Authorization header only; constant-time;
// forbidden in production). The workspace is resolved from CONFIG (never a request body). All routes
// are workspace-scoped; a cross-workspace resource id returns a safe not-found. Strict body limits,
// unknown-field rejection, pagination limits, and stable sanitized errors. No prompt/protocol/SQL
// logging. Everything OFF by default.

import { validateId } from "../../../lib/protocol/ids.mjs";
import { ControlPlaneError, CP_ERRORS } from "../errors.mjs";
import { sendJson, sendError } from "../api/responses.mjs";
import { authenticateOperator } from "../pairing/operator-auth.mjs";
import { toApiError, apiError } from "./staging-api-errors.mjs";

const ROUTES = [
  { m: "POST", re: /^\/internal\/v1\/projects$/, fn: "createProject", params: [] },
  { m: "GET", re: /^\/internal\/v1\/projects$/, fn: "listProjects", params: [] },
  { m: "GET", re: /^\/internal\/v1\/projects\/([^/]+)$/, fn: "getProject", params: ["projectId"] },
  { m: "PATCH", re: /^\/internal\/v1\/projects\/([^/]+)$/, fn: "updateProject", params: ["projectId"] },
  { m: "POST", re: /^\/internal\/v1\/projects\/([^/]+)\/archive$/, fn: "archiveProject", params: ["projectId"] },
  { m: "GET", re: /^\/internal\/v1\/projects\/([^/]+)\/workers$/, fn: "listWorkers", params: ["projectId"] },
  { m: "PUT", re: /^\/internal\/v1\/projects\/([^/]+)\/worker-affinity$/, fn: "assignAffinity", params: ["projectId"] },
  { m: "DELETE", re: /^\/internal\/v1\/projects\/([^/]+)\/worker-affinity$/, fn: "releaseAffinity", params: ["projectId"] },
  { m: "POST", re: /^\/internal\/v1\/projects\/([^/]+)\/generations$/, fn: "createGeneration", params: ["projectId"] },
  { m: "GET", re: /^\/internal\/v1\/projects\/([^/]+)\/jobs$/, fn: "listJobs", params: ["projectId"] },
  { m: "POST", re: /^\/internal\/v1\/jobs\/([^/]+)\/dispatch$/, fn: "dispatchJob", params: ["jobId"] },
  { m: "GET", re: /^\/internal\/v1\/jobs\/([^/]+)$/, fn: "getJob", params: ["jobId"] },
  { m: "GET", re: /^\/internal\/v1\/jobs\/([^/]+)\/events$/, fn: "jobEvents", params: ["jobId"] },
  { m: "POST", re: /^\/internal\/v1\/jobs\/([^/]+)\/cancel$/, fn: "cancelJob", params: ["jobId"] },
  { m: "POST", re: /^\/internal\/v1\/jobs\/([^/]+)\/retry$/, fn: "retryJob", params: ["jobId"] },
  { m: "GET", re: /^\/internal\/v1\/jobs\/([^/]+)\/results$/, fn: "getResults", params: ["jobId"] },
  { m: "PATCH", re: /^\/internal\/v1\/assets\/([^/]+)\/review$/, fn: "reviewAsset", params: ["assetId"] }
];

export function createStagingApiRouter({ config, service, logger } = {}) {
  const scfg = config.stagingApi;
  const pcfg = config.pairing;
  const production = config.isProduction;
  const WS = scfg.workspaceId;

  function handles(method, path) {
    if (!scfg.enabled) return false;
    return /^\/internal\/v1\/(projects|jobs|assets)(\/|$)/.test(path);
  }
  function fail(res, code, message, ctx) { sendError(res, new ControlPlaneError(code, message), { correlationId: ctx.correlationId, production }); }
  function body(req) { const b = req.cpBody; return (b && typeof b === "object" && !Array.isArray(b)) ? b : {}; }
  function unknownKeys(obj, allowed) { return Object.keys(obj).some((k) => !allowed.includes(k)); }
  function query(req) { const i = (req.url || "").indexOf("?"); return new URLSearchParams(i >= 0 ? req.url.slice(i + 1) : ""); }
  function pageArgs(req) {
    const q = query(req);
    let limit = parseInt(q.get("limit") || q.get("pageSize") || "", 10);
    let offset = parseInt(q.get("offset") || "", 10);
    const page = parseInt(q.get("page") || "", 10);
    if (!Number.isInteger(limit) || limit <= 0) limit = scfg.defaultPageSize;
    limit = Math.max(1, Math.min(scfg.maxPageSize, limit));
    if (!Number.isInteger(offset) || offset < 0) offset = Number.isInteger(page) && page > 1 ? (page - 1) * limit : 0;
    offset = Math.max(0, Math.min(1_000_000, offset));
    return { limit, offset };
  }
  function idem(req) {
    const h = req.headers && (req.headers["idempotency-key"] || req.headers["x-idempotency-key"]);
    const raw = typeof h === "string" ? h.trim() : "";
    return /^[A-Za-z0-9._:-]{1,200}$/.test(raw) ? raw : null;
  }
  function reqRevision(v) { return Number.isInteger(v) ? v : (typeof v === "string" && /^\d+$/.test(v) ? parseInt(v, 10) : null); }

  // Build a validated { settings } bag from safe project/generation knobs, or an error string.
  function buildSettings(b) {
    const s = {};
    if (b.aspectRatio !== undefined) { if (!scfg.allowedAspectRatios.includes(b.aspectRatio)) return { error: "aspectRatio not allowed" }; s.aspectRatio = b.aspectRatio; }
    if (b.defaultDuration !== undefined) { if (!scfg.allowedDurations.includes(b.defaultDuration)) return { error: "defaultDuration not allowed" }; s.durationSeconds = b.defaultDuration; }
    if (b.outputFormat !== undefined) { if (!scfg.allowedOutputFormats.includes(String(b.outputFormat).toLowerCase())) return { error: "outputFormat not allowed" }; s.outputFormat = String(b.outputFormat).toLowerCase(); }
    if (b.promptDefault !== undefined) { if (typeof b.promptDefault !== "string" || b.promptDefault.length > scfg.maxPromptLength) return { error: "promptDefault invalid" }; s.promptDefault = b.promptDefault; }
    return { settings: Object.keys(s).length ? s : null };
  }
  // Reject provider URLs / absolute paths / obvious secrets in free-text fields.
  function unsafeText(v) {
    return typeof v === "string" && (/:\/\//.test(v) || /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(v) || /\b(authorization|password|secret|wcred_|bearer)\b/i.test(v));
  }

  const handlers = {
    async createProject(req, res, ctx) {
      const b = body(req);
      if (unknownKeys(b, ["title", "description", "aspectRatio", "defaultDuration", "outputFormat", "promptDefault"])) return fail(res, CP_ERRORS.E_BAD_REQUEST, "Unknown field", ctx);
      if (typeof b.title !== "string" || b.title.trim().length === 0 || b.title.length > 200) return fail(res, CP_ERRORS.E_BAD_REQUEST, "title required", ctx);
      if (b.description !== undefined && (typeof b.description !== "string" || b.description.length > 4000)) return fail(res, CP_ERRORS.E_BAD_REQUEST, "description invalid", ctx);
      if (unsafeText(b.title) || unsafeText(b.description)) return fail(res, CP_ERRORS.E_BAD_REQUEST, "unsafe value", ctx);
      const set = buildSettings(b); if (set.error) return fail(res, CP_ERRORS.E_BAD_REQUEST, set.error, ctx);
      const out = await service.createProject({ ws: WS, actorId: ctx.actorId, title: b.title.trim(), description: b.description ?? null, settings: set.settings, idempotencyKey: idem(req) });
      sendJson(res, out.replayed ? 200 : 201, out.project, { correlationId: ctx.correlationId });
    },
    async listProjects(req, res, ctx) {
      const { limit, offset } = pageArgs(req);
      const includeArchived = query(req).get("includeArchived") === "true";
      const out = await service.listProjects({ ws: WS, limit, offset, includeArchived });
      sendJson(res, 200, { projects: out.projects, page: { limit, offset, total: out.total } }, { correlationId: ctx.correlationId });
    },
    async getProject(req, res, ctx, p) {
      if (!validateId(p.projectId, "prj")) return fail(res, CP_ERRORS.E_PROJECT_NOT_FOUND, "Project not found", ctx);
      sendJson(res, 200, await service.getProject({ ws: WS, projectId: p.projectId }), { correlationId: ctx.correlationId });
    },
    async updateProject(req, res, ctx, p) {
      if (!validateId(p.projectId, "prj")) return fail(res, CP_ERRORS.E_PROJECT_NOT_FOUND, "Project not found", ctx);
      const b = body(req);
      if (unknownKeys(b, ["title", "description", "aspectRatio", "defaultDuration", "outputFormat", "promptDefault", "expectedRevision"])) return fail(res, CP_ERRORS.E_BAD_REQUEST, "Unknown field", ctx);
      const rev = reqRevision(b.expectedRevision);
      if (rev === null) return fail(res, CP_ERRORS.E_BAD_REQUEST, "expectedRevision required", ctx);
      if (b.title !== undefined && (typeof b.title !== "string" || b.title.trim().length === 0 || b.title.length > 200)) return fail(res, CP_ERRORS.E_BAD_REQUEST, "title invalid", ctx);
      if (b.description !== undefined && b.description !== null && (typeof b.description !== "string" || b.description.length > 4000)) return fail(res, CP_ERRORS.E_BAD_REQUEST, "description invalid", ctx);
      if (unsafeText(b.title) || unsafeText(b.description)) return fail(res, CP_ERRORS.E_BAD_REQUEST, "unsafe value", ctx);
      const set = buildSettings(b); if (set.error) return fail(res, CP_ERRORS.E_BAD_REQUEST, set.error, ctx);
      const patch = { ws: WS, actorId: ctx.actorId, projectId: p.projectId, expectedRevision: rev };
      if (b.title !== undefined) patch.title = b.title.trim();
      if (b.description !== undefined) patch.description = b.description;
      if (set.settings !== null || b.aspectRatio !== undefined || b.defaultDuration !== undefined || b.outputFormat !== undefined || b.promptDefault !== undefined) patch.settings = set.settings;
      sendJson(res, 200, await service.updateProject(patch), { correlationId: ctx.correlationId });
    },
    async archiveProject(req, res, ctx, p) {
      if (!validateId(p.projectId, "prj")) return fail(res, CP_ERRORS.E_PROJECT_NOT_FOUND, "Project not found", ctx);
      const rev = reqRevision(body(req).expectedRevision);
      sendJson(res, 200, await service.archiveProject({ ws: WS, actorId: ctx.actorId, projectId: p.projectId, expectedRevision: rev }), { correlationId: ctx.correlationId });
    },
    async listWorkers(req, res, ctx, p) {
      if (!validateId(p.projectId, "prj")) return fail(res, CP_ERRORS.E_PROJECT_NOT_FOUND, "Project not found", ctx);
      sendJson(res, 200, await service.listProjectWorkers({ ws: WS, projectId: p.projectId }), { correlationId: ctx.correlationId });
    },
    async assignAffinity(req, res, ctx, p) {
      if (!validateId(p.projectId, "prj")) return fail(res, CP_ERRORS.E_PROJECT_NOT_FOUND, "Project not found", ctx);
      const b = body(req);
      if (unknownKeys(b, ["workerId", "expectedGeneration"])) return fail(res, CP_ERRORS.E_BAD_REQUEST, "Unknown field", ctx);
      if (!validateId(b.workerId, "wrk")) return fail(res, CP_ERRORS.E_WORKER_NOT_FOUND, "Worker not found", ctx);
      sendJson(res, 200, await service.assignAffinity({ ws: WS, actorId: ctx.actorId, projectId: p.projectId, workerId: b.workerId, expectedGeneration: reqRevision(b.expectedGeneration) }), { correlationId: ctx.correlationId });
    },
    async releaseAffinity(req, res, ctx, p) {
      if (!validateId(p.projectId, "prj")) return fail(res, CP_ERRORS.E_PROJECT_NOT_FOUND, "Project not found", ctx);
      const b = body(req);
      sendJson(res, 200, await service.releaseAffinity({ ws: WS, actorId: ctx.actorId, projectId: p.projectId, expectedGeneration: reqRevision(b.expectedGeneration), reason: b.reason }), { correlationId: ctx.correlationId });
    },
    async createGeneration(req, res, ctx, p) {
      if (!validateId(p.projectId, "prj")) return fail(res, CP_ERRORS.E_PROJECT_NOT_FOUND, "Project not found", ctx);
      const b = body(req);
      if (unknownKeys(b, ["kind", "prompt", "durationSeconds", "aspectRatio", "outputCount"])) return fail(res, CP_ERRORS.E_BAD_REQUEST, "Unknown field", ctx);
      const kind = b.kind === undefined ? "VIDEO" : b.kind;
      if (kind !== "VIDEO") return fail(res, CP_ERRORS.E_BAD_REQUEST, "unsupported kind", ctx);
      if (typeof b.prompt !== "string" || b.prompt.trim().length === 0 || b.prompt.length > scfg.maxPromptLength) return fail(res, CP_ERRORS.E_BAD_REQUEST, "prompt invalid", ctx);
      if (unsafeText(b.prompt)) return fail(res, CP_ERRORS.E_BAD_REQUEST, "unsafe prompt", ctx);
      const duration = b.durationSeconds === undefined ? scfg.allowedDurations[0] : b.durationSeconds;
      if (!scfg.allowedDurations.includes(duration)) return fail(res, CP_ERRORS.E_BAD_REQUEST, "durationSeconds not allowed", ctx);
      const aspect = b.aspectRatio === undefined ? scfg.allowedAspectRatios[0] : b.aspectRatio;
      if (!scfg.allowedAspectRatios.includes(aspect)) return fail(res, CP_ERRORS.E_BAD_REQUEST, "aspectRatio not allowed", ctx);
      const outputCount = b.outputCount === undefined ? scfg.maxOutputCount : b.outputCount;
      if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > scfg.maxOutputCount) return fail(res, CP_ERRORS.E_BAD_REQUEST, "outputCount invalid", ctx);
      const ik = idem(req);
      if (!ik) return fail(res, CP_ERRORS.E_BAD_REQUEST, "Idempotency-Key required", ctx);
      const input = { kind: "VIDEO", prompt: b.prompt, durationSeconds: duration, aspectRatio: aspect, outputCount };
      const out = await service.createGeneration({ ws: WS, actorId: ctx.actorId, projectId: p.projectId, input, idempotencyKey: ik });
      sendJson(res, out.duplicate ? 200 : 202, out, { correlationId: ctx.correlationId });
    },
    async listJobs(req, res, ctx, p) {
      if (!validateId(p.projectId, "prj")) return fail(res, CP_ERRORS.E_PROJECT_NOT_FOUND, "Project not found", ctx);
      const { limit, offset } = pageArgs(req);
      const out = await service.listJobs({ ws: WS, projectId: p.projectId, limit, offset });
      sendJson(res, 200, { jobs: out.jobs, page: { limit, offset, total: out.total } }, { correlationId: ctx.correlationId });
    },
    async dispatchJob(req, res, ctx, p) {
      if (!validateId(p.jobId, "job")) return fail(res, CP_ERRORS.E_JOB_NOT_FOUND, "Job not found", ctx);
      const out = await service.dispatchJob({ ws: WS, actorId: ctx.actorId, jobId: p.jobId });
      sendJson(res, 202, out, { correlationId: ctx.correlationId });
    },
    async getJob(req, res, ctx, p) {
      if (!validateId(p.jobId, "job")) return fail(res, CP_ERRORS.E_JOB_NOT_FOUND, "Job not found", ctx);
      sendJson(res, 200, await service.getJob({ ws: WS, jobId: p.jobId }), { correlationId: ctx.correlationId });
    },
    async jobEvents(req, res, ctx, p) {
      if (!validateId(p.jobId, "job")) return fail(res, CP_ERRORS.E_JOB_NOT_FOUND, "Job not found", ctx);
      const { limit, offset } = pageArgs(req);
      const out = await service.jobEvents({ ws: WS, jobId: p.jobId, limit, offset });
      sendJson(res, 200, { events: out.events, page: { limit, offset, total: out.total } }, { correlationId: ctx.correlationId });
    },
    async cancelJob(req, res, ctx, p) {
      if (!validateId(p.jobId, "job")) return fail(res, CP_ERRORS.E_JOB_NOT_FOUND, "Job not found", ctx);
      sendJson(res, 200, await service.cancelJob({ ws: WS, actorId: ctx.actorId, jobId: p.jobId }), { correlationId: ctx.correlationId });
    },
    async retryJob(req, res, ctx, p) {
      if (!validateId(p.jobId, "job")) return fail(res, CP_ERRORS.E_JOB_NOT_FOUND, "Job not found", ctx);
      const ik = idem(req);
      if (!ik) return fail(res, CP_ERRORS.E_BAD_REQUEST, "Idempotency-Key required", ctx);
      const out = await service.retryJob({ ws: WS, actorId: ctx.actorId, jobId: p.jobId, idempotencyKey: ik });
      sendJson(res, 202, out, { correlationId: ctx.correlationId });
    },
    async getResults(req, res, ctx, p) {
      if (!validateId(p.jobId, "job")) return fail(res, CP_ERRORS.E_JOB_NOT_FOUND, "Job not found", ctx);
      sendJson(res, 200, await service.getJobResults({ ws: WS, jobId: p.jobId }), { correlationId: ctx.correlationId });
    },
    async reviewAsset(req, res, ctx, p) {
      if (!validateId(p.assetId, "asset")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Asset not found", ctx);
      const b = body(req);
      if (unknownKeys(b, ["reviewStatus", "expectedRevision"])) return fail(res, CP_ERRORS.E_BAD_REQUEST, "Unknown field", ctx);
      const rev = reqRevision(b.expectedRevision);
      if (rev === null) return fail(res, CP_ERRORS.E_BAD_REQUEST, "expectedRevision required", ctx);
      sendJson(res, 200, await service.reviewAsset({ ws: WS, actorId: ctx.actorId, assetId: p.assetId, reviewStatus: b.reviewStatus, expectedRevision: rev }), { correlationId: ctx.correlationId });
    }
  };

  async function handle(req, res, ctx) {
    try {
      // Stricter per-API body cap (413) beyond the transport-level cap.
      if (typeof req.cpBodyBytes === "number" && req.cpBodyBytes > scfg.maxBodyBytes) return fail(res, CP_ERRORS.E_PAYLOAD_TOO_LARGE, "Request body too large", ctx);

      let route = null, m = null, pathMatched = false;
      for (const r of ROUTES) { const mm = r.re.exec(ctx.path); if (mm) { pathMatched = true; if (r.m === ctx.method) { route = r; m = mm; break; } } }
      if (!route) return fail(res, pathMatched ? CP_ERRORS.E_METHOD_NOT_ALLOWED : CP_ERRORS.E_NOT_FOUND, pathMatched ? "Method not allowed" : "Route not found", ctx);

      // Operator auth (reuses the pairing staging token; workspace comes from config, not the body).
      const auth = authenticateOperator({ enabled: scfg.enabled && pcfg.stagingOperatorAuthEnabled, operatorToken: pcfg.operatorToken, operatorActorId: pcfg.operatorActorId, headers: req.headers });
      if (!auth.ok) return fail(res, auth.code, auth.code === CP_ERRORS.E_OPERATOR_FORBIDDEN ? "Staging API unavailable" : "Operator unauthorized", ctx);

      const p = {};
      route.params.forEach((name, i) => { p[name] = decodeURIComponent(m[i + 1]); });
      const rctx = { ...ctx, actorId: auth.actorId };
      await handlers[route.fn](req, res, rctx, p);
    } catch (err) {
      const cp = toApiError(err);
      if (cp.code === CP_ERRORS.E_INTERNAL) logger?.error?.("staging_api_error", { component: "stagingApi", reasonCode: "E_INTERNAL", correlationId: ctx.correlationId });
      sendError(res, cp, { correlationId: ctx.correlationId, production });
    }
  }

  return { handles, handle };
}
