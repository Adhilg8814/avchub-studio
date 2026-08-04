// P0 Step 5C.5 — pairing + credential lifecycle HTTP router.
//
// Two surfaces, both OFF by default:
//   • Worker claim   POST {claimPath}  — unauthenticated by human/operator, code-authenticated,
//                    per-remote rate limited, GENERIC errors (never distinguishes invalid/expired/
//                    consumed/revoked). Returns the Worker credential plaintext EXACTLY ONCE.
//   • Operator API   /internal/v1/workspaces/:ws/...  — staging service-token authenticated
//                    (constant-time), gated by operatorApiEnabled, forbidden in production.
//
// The router maps ControlPlaneError codes to their HTTP status via the shared response helpers;
// no stack trace, SQL text, credential, code, or token ever reaches the client or the logs.

import { validateId } from "../../../lib/protocol/ids.mjs";
import { ControlPlaneError, CP_ERRORS, toControlPlaneError } from "../errors.mjs";
import { sendJson, sendError } from "../api/responses.mjs";
import { authenticateOperator } from "./operator-auth.mjs";

// Operator route table (exact regexes; path params captured positionally).
const OPERATOR_ROUTES = [
  { method: "POST", re: /^\/internal\/v1\/workspaces\/([^/]+)\/pairing-codes$/, params: ["ws"], fn: "issue" },
  { method: "GET", re: /^\/internal\/v1\/workspaces\/([^/]+)\/pairing-codes$/, params: ["ws"], fn: "listCodes" },
  { method: "GET", re: /^\/internal\/v1\/workspaces\/([^/]+)\/pairing-codes\/([^/]+)$/, params: ["ws", "codeId"], fn: "getCode" },
  { method: "POST", re: /^\/internal\/v1\/workspaces\/([^/]+)\/pairing-codes\/([^/]+)\/revoke$/, params: ["ws", "codeId"], fn: "revokeCode" },
  { method: "GET", re: /^\/internal\/v1\/workspaces\/([^/]+)\/workers$/, params: ["ws"], fn: "listWorkers" },
  { method: "GET", re: /^\/internal\/v1\/workspaces\/([^/]+)\/workers\/([^/]+)$/, params: ["ws", "workerId"], fn: "getWorker" },
  { method: "POST", re: /^\/internal\/v1\/workspaces\/([^/]+)\/workers\/([^/]+)\/credentials\/rotate$/, params: ["ws", "workerId"], fn: "rotate" },
  { method: "POST", re: /^\/internal\/v1\/workspaces\/([^/]+)\/workers\/([^/]+)\/credentials\/revoke$/, params: ["ws", "workerId"], fn: "revokeCred" },
  { method: "POST", re: /^\/internal\/v1\/workspaces\/([^/]+)\/workers\/([^/]+)\/disable$/, params: ["ws", "workerId"], fn: "disable" },
  { method: "POST", re: /^\/internal\/v1\/workspaces\/([^/]+)\/workers\/([^/]+)\/enable$/, params: ["ws", "workerId"], fn: "enable" }
];

export function createPairingRouter({ config, pairingService, logger } = {}) {
  const pcfg = config.pairing;
  const production = config.isProduction;
  const claimPath = pcfg.claimPath;

  function handles(method, path) {
    if (!pcfg.enabled) return false;
    if (path === claimPath) return true;
    // Only the pairing operator surface (/internal/v1/workspaces/...) — NOT every /internal/v1 path
    // (the 5C.6 staging API owns /internal/v1/projects|jobs|assets).
    if (pcfg.operatorApiEnabled && /^\/internal\/v1\/workspaces(\/|$)/.test(path)) return true;
    return false;
  }

  function body(req) { const b = req.cpBody; return (b && typeof b === "object" && !Array.isArray(b)) ? b : {}; }
  function remoteKey(req) { try { return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : "unknown"; } catch { return "unknown"; } }
  function fail(res, code, message, ctx) { sendError(res, new ControlPlaneError(code, message), { correlationId: ctx.correlationId, production }); }

  // -------------------------------------------------------------- worker claim
  async function handleClaim(req, res, ctx) {
    if (ctx.method !== "POST") return fail(res, CP_ERRORS.E_METHOD_NOT_ALLOWED, "Method not allowed", ctx);
    const b = body(req);
    if (typeof b.pairingCode !== "string" || b.pairingCode.length === 0) return fail(res, CP_ERRORS.E_PAIRING_INVALID, "Invalid pairing code", ctx);
    const out = await pairingService.claimCode({
      code: b.pairingCode,
      installationId: b.installationId, requestedWorkerName: b.requestedWorkerName,
      platform: b.platform, osVersion: b.osVersion, architecture: b.architecture,
      workerVersion: b.workerVersion, protocolVersion: b.protocolVersion, capabilities: b.capabilities,
      remoteKey: remoteKey(req)
    });
    // The credential plaintext is returned ONCE. Shape + 200 status match the shipped lib/worker
    // WorkerPairingClient (it treats any non-200 as a pairing failure), so that client works
    // unchanged against the real Control Plane.
    sendJson(res, 200, {
      workerCredential: out.credential, workerId: out.workerId, workspaceId: out.workspaceId,
      credentialExpiresAt: out.credentialExpiresAt, controlPlaneUrl: null
    }, { correlationId: ctx.correlationId });
  }

  // -------------------------------------------------------------- operator dispatch
  function authOperator(req) {
    return authenticateOperator({
      enabled: pcfg.operatorApiEnabled && pcfg.stagingOperatorAuthEnabled,
      operatorToken: pcfg.operatorToken, operatorActorId: pcfg.operatorActorId, headers: req.headers
    });
  }

  const handlers = {
    async issue(req, res, ctx, p, actorId) {
      const b = body(req);
      const out = await pairingService.issueCode({
        workspaceId: p.ws, actorId, requestedLabel: b.requestedLabel, capabilities: b.capabilities,
        ttlMs: b.ttlMs, maxAttempts: b.maxAttempts, idempotencyKey: idem(req, b)
      });
      const status = out.replayed ? 200 : 201;
      const resp = out.replayed
        ? { replayed: true, pairingCodeId: out.pairingCodeId, expiresAt: out.expiresAt, workspaceId: out.workspaceId, note: "code shown only once at creation" }
        : { pairingCode: out.pairingCode, pairingCodeId: out.pairingCodeId, expiresAt: out.expiresAt, workspaceId: out.workspaceId };
      sendJson(res, status, resp, { correlationId: ctx.correlationId });
    },
    async listCodes(req, res, ctx, p) {
      sendJson(res, 200, { pairingCodes: await pairingService.listPairingCodes({ workspaceId: p.ws }) }, { correlationId: ctx.correlationId });
    },
    async getCode(req, res, ctx, p) {
      if (!validateId(p.codeId, "pcode")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Pairing code not found", ctx);
      sendJson(res, 200, await pairingService.getPairingCode({ workspaceId: p.ws, codeId: p.codeId }), { correlationId: ctx.correlationId });
    },
    async revokeCode(req, res, ctx, p, actorId) {
      if (!validateId(p.codeId, "pcode")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Pairing code not found", ctx);
      sendJson(res, 200, await pairingService.revokePairingCode({ workspaceId: p.ws, codeId: p.codeId, actorId }), { correlationId: ctx.correlationId });
    },
    async listWorkers(req, res, ctx, p) {
      sendJson(res, 200, { workers: await pairingService.getWorkers({ workspaceId: p.ws }) }, { correlationId: ctx.correlationId });
    },
    async getWorker(req, res, ctx, p) {
      if (!validateId(p.workerId, "wrk")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Worker not found", ctx);
      sendJson(res, 200, await pairingService.getWorker({ workspaceId: p.ws, workerId: p.workerId }), { correlationId: ctx.correlationId });
    },
    async rotate(req, res, ctx, p, actorId) {
      if (!validateId(p.workerId, "wrk")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Worker not found", ctx);
      const out = await pairingService.rotateCredential({ workspaceId: p.ws, workerId: p.workerId, actorId, idempotencyKey: idem(req, body(req)) });
      const status = out.replayed ? 200 : 201;
      const resp = out.replayed
        ? { replayed: true, credentialId: out.credentialId, expiresAt: out.expiresAt, note: "credential shown only once at rotation" }
        : { workerCredential: out.credential, credentialId: out.credentialId, expiresAt: out.expiresAt, rotatedFrom: out.rotatedFrom };
      sendJson(res, status, resp, { correlationId: ctx.correlationId });
    },
    async revokeCred(req, res, ctx, p, actorId) {
      if (!validateId(p.workerId, "wrk")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Worker not found", ctx);
      const b = body(req);
      const cid = typeof b.credentialId === "string" && validateId(b.credentialId, "cred") ? b.credentialId : null;
      sendJson(res, 200, await pairingService.revokeCredential({ workspaceId: p.ws, workerId: p.workerId, credentialId: cid, actorId, reason: b.reason }), { correlationId: ctx.correlationId });
    },
    async disable(req, res, ctx, p, actorId) {
      if (!validateId(p.workerId, "wrk")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Worker not found", ctx);
      sendJson(res, 200, await pairingService.disableWorker({ workspaceId: p.ws, workerId: p.workerId, actorId, reason: body(req).reason }), { correlationId: ctx.correlationId });
    },
    async enable(req, res, ctx, p, actorId) {
      if (!validateId(p.workerId, "wrk")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Worker not found", ctx);
      sendJson(res, 200, await pairingService.enableWorker({ workspaceId: p.ws, workerId: p.workerId, actorId }), { correlationId: ctx.correlationId });
    }
  };

  function idem(req, b) {
    const h = req.headers && (req.headers["idempotency-key"] || req.headers["x-idempotency-key"]);
    const raw = (typeof h === "string" && h) || (typeof b.idempotencyKey === "string" && b.idempotencyKey) || null;
    if (!raw) return null;
    const s = String(raw).trim();
    return /^[A-Za-z0-9._:-]{1,200}$/.test(s) ? s : null;
  }

  async function handleOperator(req, res, ctx) {
    // Find a path match first (so a known path with a wrong method → 405, unknown → 404).
    let route = null, m = null, pathMatched = false;
    for (const r of OPERATOR_ROUTES) {
      const mm = r.re.exec(ctx.path);
      if (mm) { pathMatched = true; if (r.method === ctx.method) { route = r; m = mm; break; } }
    }
    if (!route) return fail(res, pathMatched ? CP_ERRORS.E_METHOD_NOT_ALLOWED : CP_ERRORS.E_NOT_FOUND, pathMatched ? "Method not allowed" : "Route not found", ctx);

    // Operator authentication (constant-time; generic failures).
    const auth = authOperator(req);
    if (!auth.ok) return fail(res, auth.code, auth.code === CP_ERRORS.E_OPERATOR_FORBIDDEN ? "Operator API unavailable" : "Operator unauthorized", ctx);

    const p = {};
    route.params.forEach((name, i) => { p[name] = decodeURIComponent(m[i + 1]); });
    if (!validateId(p.ws, "ws")) return fail(res, CP_ERRORS.E_NOT_FOUND, "Workspace not found", ctx);
    return handlers[route.fn](req, res, ctx, p, auth.actorId);
  }

  async function handle(req, res, ctx) {
    try {
      if (ctx.path === claimPath) return await handleClaim(req, res, ctx);
      return await handleOperator(req, res, ctx);
    } catch (err) {
      const cp = toControlPlaneError(err);
      if (cp.code === CP_ERRORS.E_INTERNAL) logger?.error?.("pairing_router_error", { component: "pairing", reasonCode: "E_INTERNAL", correlationId: ctx.correlationId });
      sendError(res, cp, { correlationId: ctx.correlationId, production });
    }
  }

  return { handles, handle };
}
