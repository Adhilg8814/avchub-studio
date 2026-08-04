// P0 Step 5C.31 — REMOTE WORKER HUB (server side).
//
// The hub lives in the WORKER RUNTIME process — the same process that already owns the 5C.9E
// generation pipeline. That placement is the whole point: a remote worker is an EXTENSION of the
// existing job owner, not a second one. There is exactly one dispatcher, one claim engine and one
// state machine; the hub only changes WHERE a claimed attempt is executed.
//
// Responsibilities:
//   * terminate the authenticated WSS session (credential -> workspace, never client-declared);
//   * negotiate the delivery protocol and refuse an incompatible worker with a safe reason;
//   * push offers that the pipeline has ALREADY claimed for that worker, and translate the worker's
//     reports into certified control-plane calls through the delivery service;
//   * stream artifact uploads into the workspace media root with hash+size verification;
//   * keep the durable worker registry honest (heartbeat, current work, drain).
//
// It authenticates, it routes, it verifies. It decides nothing about ownership.

import { WebSocketServer } from "ws";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { extractBearer, authenticateCredential, createAuthRateLimiter } from "../../../control-plane/src/gateway/gateway-auth.mjs";
import { createRemoteDeliveryService } from "./remote-delivery-service.mjs";
import {
  DELIVERY_PROTOCOL_VERSION, SUPPORTED_DELIVERY_PROTOCOL_VERSIONS, REMOTE_WORKER_WS_PATH,
  MAX_FRAME_BYTES, HELLO_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS,
  S2W, W2S, CLOSE_REASON, REMOTE_ERRORS, parseFrame, makeFrame, sanitizeCapabilities, buildOfferPayload
} from "./remote-protocol.mjs";

const UPLOAD_PATH = "/api/worker/artifact";
const RETIRE_PATH = "/api/worker/retire";
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function jsonRes(res, status, body) {
  const b = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(b),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(b);
}

export function createRemoteWorkerHub({
  persistence, credentialPepper, resolveTenant, registry, mediaRootFor,
  enabled = false, logger = null, now = () => Date.now(),
  bundleChannel = null,            // release channel metadata for UPDATE_AVAILABLE (optional)
  offerPollMs = 2000
} = {}) {
  if (typeof resolveTenant !== "function") throw new TypeError("remote hub requires resolveTenant(workspaceId)");
  if (typeof mediaRootFor !== "function") throw new TypeError("remote hub requires mediaRootFor(workspaceId)");

  const delivery = createRemoteDeliveryService({ persistence, resolveTenant, registry, mediaRootFor, now, logger });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const authLimiter = createAuthRateLimiter({ windowMs: 60_000, maxPerWindow: 20, now });
  // workerId -> connection. ONE live session per worker: a second connection supersedes the first, so a
  // worker can never end up with two sockets racing to accept the same offer.
  const sessions = new Map();
  let offerTimer = null, started = false, draining = false;

  const log = (lvl, event, fields) => { try { logger?.[lvl]?.(event, { component: "remote-worker-hub", ...fields }); } catch { /* */ } };

  function send(conn, frame) {
    try { conn.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }
  function sendAck(conn, frame, extra = {}) {
    return send(conn, makeFrame({ type: S2W.ACK, messageId: `msg_${randomBytes(9).toString("hex")}`, jobId: frame.j || null, payload: { cid: frame.cid || null, ...extra } }));
  }
  function sendNack(conn, frame, code, extra = {}) {
    return send(conn, makeFrame({ type: S2W.NACK, messageId: `msg_${randomBytes(9).toString("hex")}`, jobId: frame.j || null, payload: { cid: frame.cid || null, code, ...extra } }));
  }
  function closeConn(conn, info) {
    if (conn.closed) return;
    conn.closed = true;
    try { conn.ws.close(info.code, info.reason); } catch { /* */ }
    const t = setTimeout(() => { try { conn.ws.terminate(); } catch { /* */ } }, 2000);
    if (t.unref) t.unref();
  }

  // ---------------------------------------------------------------- upgrade + auth
  async function handleUpgrade(req, socket, head) {
    const pathOnly = String(req.url || "").split("?")[0];
    if (!enabled || draining || pathOnly !== REMOTE_WORKER_WS_PATH) { try { socket.destroy(); } catch { /* */ } return; }
    const remoteKey = (req.socket && req.socket.remoteAddress) || "unknown";
    if (!authLimiter.check(remoteKey)) { try { socket.destroy(); } catch { /* */ } return; }
    const ext = extractBearer(req.headers);
    if (!ext.ok) { authLimiter.record(remoteKey); rejectUpgrade(socket, 401); return; }
    let auth;
    try { auth = await authenticateCredential({ persistence, pepper: credentialPepper, credential: ext.credential, now }); }
    catch { rejectUpgrade(socket, 503); return; }
    if (!auth.ok) {
      authLimiter.record(remoteKey);
      // A revoked/expired/unknown credential is refused identically — never reveals which.
      log("info", "REMOTE_WORKER_AUTH_FAILED", { reasonCode: auth.code });
      rejectUpgrade(socket, 401); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth));
  }

  function rejectUpgrade(socket, status) {
    try {
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Service Unavailable"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    } catch { /* */ }
  }

  // ---------------------------------------------------------------- connection lifecycle
  function onConnection(ws, auth) {
    const conn = {
      ws, workspaceId: auth.workspaceId, workerId: auth.workerId, credentialId: auth.credentialId,
      sessionId: `rsess_${randomBytes(12).toString("hex")}`,
      state: "HELLO_WAIT", closed: false, lastSeen: now(), executionHost: null,
      capabilities: null, inflight: new Set(), wantsWork: false, helloTimer: null, busy: false
    };
    ws.on("error", () => { /* never crash on a socket error */ });
    conn.helloTimer = setTimeout(() => { if (conn.state === "HELLO_WAIT") closeConn(conn, CLOSE_REASON.BAD_HANDSHAKE); }, HELLO_TIMEOUT_MS);
    if (conn.helloTimer.unref) conn.helloTimer.unref();
    ws.on("message", (data, isBinary) => { void onMessage(conn, data, isBinary); });
    ws.on("close", () => { void onClose(conn); });
  }

  async function onMessage(conn, data, isBinary) {
    if (conn.closed) return;
    const fr = parseFrame(data, isBinary);
    if (!fr.ok) {
      log("info", "REMOTE_FRAME_REJECTED", { workerId: conn.workerId, reason: fr.reason });
      closeConn(conn, fr.code === REMOTE_ERRORS.E_REMOTE_PROTOCOL_VERSION ? CLOSE_REASON.INCOMPATIBLE : CLOSE_REASON.MALFORMED);
      return;
    }
    const frame = fr.frame;
    conn.lastSeen = now();
    if (conn.state === "HELLO_WAIT") {
      if (frame.t !== W2S.HELLO) { closeConn(conn, CLOSE_REASON.BAD_HANDSHAKE); return; }
      await onHello(conn, frame);
      return;
    }
    if (conn.state !== "ACTIVE") return;
    try { await dispatchFrame(conn, frame); }
    catch (e) {
      const code = (e && e.code) || REMOTE_ERRORS.E_REMOTE_FRAME_INVALID;
      log("warn", "REMOTE_COMMAND_REFUSED", { workerId: conn.workerId, type: frame.t, code });
      sendNack(conn, frame, code);
      try { await registry.recordSafeError(conn.workspaceId, conn.workerId, code); } catch { /* */ }
    }
  }

  async function onHello(conn, frame) {
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    const d = frame.d || {};
    // Identity is the AUTHENTICATED connection. A worker that claims a different id/workspace is closed.
    if (typeof d.workerId === "string" && d.workerId !== conn.workerId) { closeConn(conn, CLOSE_REASON.BAD_HANDSHAKE); return; }
    if (typeof d.workspaceId === "string" && d.workspaceId !== conn.workspaceId) { closeConn(conn, CLOSE_REASON.BAD_HANDSHAKE); return; }
    const pv = Number.isInteger(d.deliveryProtocolVersion) ? d.deliveryProtocolVersion : frame.p;
    const caps = sanitizeCapabilities(d.capabilities);
    conn.capabilities = caps;
    conn.executionHost = typeof d.hostLabel === "string" ? d.hostLabel.slice(0, 64) : null;
    try {
      await registry.recordHello(conn.workspaceId, conn.workerId, {
        bundleVersion: d.bundleVersion, buildCommit: d.buildCommit, deliveryProtocolVersion: pv,
        osCaption: d.osCaption, architecture: d.architecture, capabilities: caps, sessionId: conn.sessionId
      });
    } catch (e) { log("warn", "REMOTE_HELLO_STATE_FAILED", { workerId: conn.workerId, code: e?.code || null }); }

    if (!SUPPORTED_DELIVERY_PROTOCOL_VERSIONS.includes(pv)) {
      send(conn, makeFrame({ type: S2W.HELLO_ACK, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId: conn.workerId,
        payload: { accepted: false, code: REMOTE_ERRORS.E_REMOTE_WORKER_INCOMPATIBLE, serverProtocolVersion: DELIVERY_PROTOCOL_VERSION, supported: SUPPORTED_DELIVERY_PROTOCOL_VERSIONS } }));
      closeConn(conn, CLOSE_REASON.INCOMPATIBLE);
      return;
    }

    // ONE live session per worker (the previous socket loses all authority immediately).
    const prev = sessions.get(conn.workerId);
    if (prev && prev !== conn) { sessions.delete(conn.workerId); closeConn(prev, CLOSE_REASON.SUPERSEDED); }
    sessions.set(conn.workerId, conn);
    conn.state = "ACTIVE";

    const state = await registry.get(conn.workspaceId, conn.workerId).catch(() => null);
    send(conn, makeFrame({
      type: S2W.HELLO_ACK, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId: conn.workerId,
      payload: {
        accepted: true,
        // The hub TELLS the worker which tenant it serves; the worker never asserts it.
        workspaceId: conn.workspaceId, workerId: conn.workerId, sessionId: conn.sessionId,
        serverProtocolVersion: DELIVERY_PROTOCOL_VERSION,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        uploadPath: UPLOAD_PATH, retirePath: RETIRE_PATH,
        approved: state?.approved === true,
        draining: state?.draining !== false,
        updateAvailable: state?.update_available === true,
        latestBundleVersion: bundleChannel?.version || null,
        serverTime: new Date(now()).toISOString()
      }
    }));
    log("info", "REMOTE_WORKER_CONNECTED", { workspaceId: conn.workspaceId, workerId: conn.workerId, bundleVersion: d.bundleVersion || null, protocol: pv });
    if (state?.draining !== false) send(conn, makeFrame({ type: S2W.DRAIN, messageId: `msg_${randomBytes(9).toString("hex")}`, payload: { reason: state?.approved ? "OWNER_DRAIN" : "NOT_APPROVED" } }));
  }

  async function dispatchFrame(conn, frame) {
    const wsId = conn.workspaceId, workerId = conn.workerId;
    const cid = frame.cid;
    const seq = Number.isInteger(frame.seq) ? frame.seq : 0;
    switch (frame.t) {
      case W2S.HEARTBEAT:
      case W2S.PONG: {
        await registry.recordHeartbeat(wsId, workerId, frame.d || {}).catch(() => {});
        return;
      }
      case W2S.READY: {
        conn.wantsWork = true;
        conn.busy = false;
        await pushOffers(conn);
        return;
      }
      case W2S.ACCEPT: {
        requireCid(cid); requireJob(frame.j);
        const out = await delivery.accept(wsId, { workerId, jobId: frame.j, commandId: cid, sequence: seq, executionHost: conn.executionHost });
        if (out.duplicate) { sendAck(conn, frame, { duplicate: true }); return; }
        conn.busy = true;
        conn.inflight.add(frame.j);
        await registry.setCurrentWork(wsId, workerId, { jobId: out.jobId, attemptId: out.attemptId, leaseExpiresAt: out.leaseExpiresAt }).catch(() => {});
        send(conn, makeFrame({
          type: S2W.LEASE_GRANTED, messageId: `msg_${randomBytes(9).toString("hex")}`, jobId: out.jobId, attemptId: out.attemptId,
          payload: buildOfferPayload({
            prompt: out.prompt, durationSeconds: out.durationSeconds, aspectRatio: out.aspectRatio,
            leaseExpiresAt: out.leaseExpiresAt, offerExpiresAt: null, providerAccountHint: out.providerAccountHint
          })
        }));
        return;
      }
      case W2S.REJECT: {
        requireCid(cid); requireJob(frame.j);
        await delivery.release(wsId, { workerId, jobId: frame.j, commandId: cid, sequence: seq });
        conn.inflight.delete(frame.j);
        conn.busy = false;
        sendAck(conn, frame);
        return;
      }
      case W2S.LEASE_RENEW: {
        requireJob(frame.j);
        const out = await delivery.renewLease(wsId, { workerId, jobId: frame.j });
        await registry.setCurrentWork(wsId, workerId, { jobId: frame.j, attemptId: frame.a || null, leaseExpiresAt: out.leaseExpiresAt }).catch(() => {});
        send(conn, makeFrame({ type: S2W.LEASE_RENEWED, messageId: `msg_${randomBytes(9).toString("hex")}`, jobId: frame.j, payload: { leaseExpiresAt: out.leaseExpiresAt } }));
        return;
      }
      case W2S.PROGRESS: {
        requireCid(cid); requireJob(frame.j);
        await delivery.progress(wsId, { workerId, jobId: frame.j, commandId: cid, sequence: seq, stage: frame.d?.stage });
        sendAck(conn, frame);
        return;
      }
      case W2S.SUBMIT_ATTEMPTED: {
        requireCid(cid); requireJob(frame.j);
        await delivery.submitAttempted(wsId, { workerId, jobId: frame.j, commandId: cid, sequence: seq });
        sendAck(conn, frame);
        return;
      }
      case W2S.SUBMITTED: {
        requireCid(cid); requireJob(frame.j);
        await delivery.submitted(wsId, { workerId, jobId: frame.j, commandId: cid, sequence: seq, providerSubmissionId: frame.d?.providerSubmissionId ?? null });
        sendAck(conn, frame);
        return;
      }
      case W2S.RESULT_READY: {
        requireJob(frame.j);
        const grant = await delivery.grantUpload(wsId, {
          workerId, jobId: frame.j,
          sha256: frame.d?.sha256, sizeBytes: frame.d?.sizeBytes, mime: frame.d?.mime || "video/mp4"
        });
        send(conn, makeFrame({
          type: S2W.UPLOAD_GRANT, messageId: `msg_${randomBytes(9).toString("hex")}`, jobId: frame.j,
          payload: { uploadId: grant.uploadId, uploadToken: grant.token, uploadPath: UPLOAD_PATH, expiresAt: grant.expiresAt, sha256: grant.sha256, sizeBytes: grant.sizeBytes }
        }));
        return;
      }
      case W2S.ARTIFACT_UPLOADED: {
        requireCid(cid); requireJob(frame.j);
        // The upload itself is verified by the HTTP endpoint; this frame is only the worker's marker.
        await delivery.progress(wsId, { workerId, jobId: frame.j, commandId: cid, sequence: seq, stage: "ARTIFACT_UPLOADED" });
        sendAck(conn, frame);
        return;
      }
      case W2S.COMPLETE: {
        requireCid(cid); requireJob(frame.j);
        const out = await delivery.complete(wsId, {
          workerId, jobId: frame.j, commandId: cid, sequence: seq,
          resultId: frame.d?.resultId ?? null, media: frame.d?.media ?? null
        });
        conn.inflight.delete(frame.j);
        conn.busy = false;
        await registry.setCurrentWork(wsId, workerId, {}).catch(() => {});
        sendAck(conn, frame, { duplicate: out.duplicate === true });
        await pushOffers(conn);
        return;
      }
      case W2S.FAIL: {
        requireCid(cid); requireJob(frame.j);
        const out = await delivery.fail(wsId, {
          workerId, jobId: frame.j, commandId: cid, sequence: seq,
          code: frame.d?.code ?? null, possiblySubmitted: frame.d?.possiblySubmitted === true
        });
        conn.inflight.delete(frame.j);
        conn.busy = false;
        await registry.setCurrentWork(wsId, workerId, {}).catch(() => {});
        sendAck(conn, frame, { terminal: out.terminal || null, deferred: out.deferred === true });
        return;
      }
      case W2S.RELEASE: {
        requireCid(cid); requireJob(frame.j);
        const out = await delivery.release(wsId, { workerId, jobId: frame.j, commandId: cid, sequence: seq });
        if (out.released) { conn.inflight.delete(frame.j); conn.busy = false; await registry.setCurrentWork(wsId, workerId, {}).catch(() => {}); }
        sendAck(conn, frame, { released: out.released === true, reason: out.reason || null });
        return;
      }
      case W2S.DRAIN_ACK: {
        conn.wantsWork = false;
        if (conn.inflight.size === 0) await registry.markDrained(wsId, workerId).catch(() => {});
        sendAck(conn, frame);
        return;
      }
      default:
        sendNack(conn, frame, REMOTE_ERRORS.E_REMOTE_FRAME_INVALID);
    }
  }

  function requireCid(cid) { if (!cid) throw Object.assign(new Error("command id required"), { code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID }); }
  function requireJob(j) { if (!j) throw Object.assign(new Error("job id required"), { code: REMOTE_ERRORS.E_REMOTE_FRAME_INVALID }); }

  async function onClose(conn) {
    conn.closed = true;
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    if (sessions.get(conn.workerId) === conn) sessions.delete(conn.workerId);
    if (conn.state !== "ACTIVE") return;
    log("info", "REMOTE_WORKER_DISCONNECTED", { workspaceId: conn.workspaceId, workerId: conn.workerId, inflight: conn.inflight.size });
    await registry.markDisconnected(conn.workspaceId, conn.workerId).catch(() => {});
    // Pre-submit work is handed straight back to the queue; possibly-submitted work is deliberately
    // left owned (releasing it could produce a second provider submission).
    await delivery.releaseOnDisconnect(conn.workspaceId, conn.workerId).catch(() => {});
  }

  // ---------------------------------------------------------------- offer push
  async function pushOffers(conn) {
    if (!conn || conn.closed || conn.state !== "ACTIVE" || conn.busy || !conn.wantsWork) return 0;
    // Approval/draining/liveness is read from the DURABLE registry, inside a transaction, right before the
    // offer goes on the wire -> an owner clicking Drain cannot be raced by an in-flight offer push.
    const a = await persistence.tenantTransaction(conn.workspaceId, (c) => registry.assignableCore(c, conn.workspaceId, conn.workerId));
    if (!a.assignable) {
      if (a.reason === "DRAINING" || a.reason === "NOT_APPROVED") {
        send(conn, makeFrame({ type: S2W.DRAIN, messageId: `msg_${randomBytes(9).toString("hex")}`, payload: { reason: a.reason } }));
      }
      return 0;
    }
    const offers = await delivery.pendingOffers(conn.workspaceId, conn.workerId, { limit: 1 }).catch(() => []);
    let sent = 0;
    for (const o of offers) {
      const ok = send(conn, makeFrame({
        type: S2W.OFFER, messageId: `msg_${randomBytes(9).toString("hex")}`, jobId: o.jobId, attemptId: o.attemptId,
        payload: buildOfferPayload({
          prompt: o.prompt, durationSeconds: o.durationSeconds, aspectRatio: o.aspectRatio,
          leaseExpiresAt: o.leaseExpiresAt, offerExpiresAt: o.offerExpiresAt, providerAccountHint: o.providerAccountHint
        })
      }));
      if (ok) sent += 1;
    }
    return sent;
  }

  async function offerSweep() {
    for (const conn of [...sessions.values()]) {
      if (now() - conn.lastSeen > HEARTBEAT_TIMEOUT_MS) { closeConn(conn, CLOSE_REASON.HEARTBEAT_TIMEOUT); continue; }
      send(conn, makeFrame({ type: S2W.PING, messageId: `msg_${randomBytes(9).toString("hex")}` }));
      try { await pushOffers(conn); } catch { /* a sweep failure must never stop the loop */ }
    }
  }

  // ---------------------------------------------------------------- artifact upload (HTTP)
  // POST /api/worker/artifact with Authorization: Bearer <wcred_…> and x-avc-upload: <token>.
  // The token authorizes exactly ONE (workspace, worker, job, attempt) write of an exact hash+size.
  async function handleHttp(req, res, url) {
    const pathOnly = (url && url.pathname) || String(req.url || "").split("?")[0];
    if (pathOnly !== UPLOAD_PATH && pathOnly !== RETIRE_PATH) return false;
    if (!enabled) { jsonRes(res, 503, { ok: false, code: "E_REMOTE_DELIVERY_DISABLED" }); return true; }
    if (req.method !== "POST") { jsonRes(res, 405, { ok: false, code: "E_METHOD_NOT_ALLOWED" }); return true; }
    const ext = extractBearer(req.headers);
    if (!ext.ok) { jsonRes(res, 401, { ok: false, code: "E_AUTH_REQUIRED" }); return true; }
    let auth;
    try { auth = await authenticateCredential({ persistence, pepper: credentialPepper, credential: ext.credential, now }); }
    catch { jsonRes(res, 503, { ok: false, code: "E_AUTH_UNAVAILABLE" }); return true; }
    if (!auth.ok) { jsonRes(res, 401, { ok: false, code: "E_AUTH_FAILED" }); return true; }

    // ---- self-retirement: a worker being uninstalled kills its OWN credential --------------------
    // It can only ever revoke itself (the identity comes from the credential it just presented), and it
    // is refused while it owns work — an uninstall must not orphan an attempt. The owner's Revoke in
    // Studio remains the authoritative action; this is the machine doing the polite thing on its way out.
    if (pathOnly === RETIRE_PATH) {
      const owned = await persistence.tenantTransaction(auth.workspaceId, async (c) => Number((await c.query(
        "SELECT count(*)::int n FROM job_offers WHERE workspace_id=$1 AND assigned_worker_id=$2 AND terminal_at IS NULL", [auth.workspaceId, auth.workerId])).rows[0].n));
      if (owned > 0) { jsonRes(res, 409, { ok: false, code: "E_REMOTE_WORKER_BUSY", ownedAttempts: owned }); return true; }
      await persistence.tenantTransaction(auth.workspaceId, (c) => c.query(
        "UPDATE worker_credentials SET status='REVOKED', revoked_at=now() WHERE workspace_id=$1 AND worker_id=$2 AND status='ACTIVE'", [auth.workspaceId, auth.workerId]));
      await registry.drain(auth.workspaceId, auth.workerId).catch(() => {});
      await disconnectWorker(auth.workspaceId, auth.workerId, "CREDENTIAL_REVOKED");
      log("info", "REMOTE_WORKER_SELF_RETIRED", { workspaceId: auth.workspaceId, workerId: auth.workerId });
      jsonRes(res, 200, { ok: true, retired: true });
      return true;
    }

    const token = req.headers["x-avc-upload"];
    if (typeof token !== "string" || token.length < 16 || token.length > 200) { jsonRes(res, 400, { ok: false, code: REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID }); return true; }
    let session;
    try { session = await delivery.resolveUploadToken(auth.workspaceId, auth.workerId, token); }
    catch (e) { jsonRes(res, 403, { ok: false, code: e?.code || REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN }); return true; }

    const declared = Number(req.headers["content-length"]);
    if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_UPLOAD_BYTES) { jsonRes(res, 413, { ok: false, code: REMOTE_ERRORS.E_REMOTE_UPLOAD_SIZE_MISMATCH }); return true; }
    if (declared !== session.expectedBytes) { jsonRes(res, 409, { ok: false, code: REMOTE_ERRORS.E_REMOTE_UPLOAD_SIZE_MISMATCH }); return true; }

    const mediaRoot = mediaRootFor(auth.workspaceId);
    // The destination is derived SERVER-side from the session (job id), never from a client filename —
    // there is nothing for a path-traversal payload to influence.
    const rel = session.relativePath.split("/").join(path.sep);
    const dest = path.resolve(mediaRoot, rel);
    if (!dest.startsWith(path.resolve(mediaRoot) + path.sep)) { jsonRes(res, 400, { ok: false, code: REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN }); return true; }
    const tmp = `${dest}.${session.uploadId}.part`;
    await mkdir(path.dirname(dest), { recursive: true });

    const hash = createHash("sha256");
    let bytes = 0;
    let overflow = false;
    try {
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length;
          if (bytes > session.expectedBytes) { overflow = true; cb(Object.assign(new Error("overflow"), { code: REMOTE_ERRORS.E_REMOTE_UPLOAD_SIZE_MISMATCH })); return; }
          hash.update(chunk); cb(null, chunk);
        }
      });
      await pipeline(req, counter, createWriteStream(tmp, { mode: 0o600 }));
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      jsonRes(res, overflow ? 409 : 400, { ok: false, code: overflow ? REMOTE_ERRORS.E_REMOTE_UPLOAD_SIZE_MISMATCH : REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID });
      return true;
    }
    const actualSha256 = hash.digest("hex");
    let fin;
    try { fin = await delivery.finalizeUpload(auth.workspaceId, { uploadId: session.uploadId, actualSha256, actualBytes: bytes }); }
    catch (e) {
      // A mismatch never becomes a result: the partial file is discarded and the session is closed failed.
      await rm(tmp, { force: true }).catch(() => {});
      jsonRes(res, 409, { ok: false, code: e?.code || REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID });
      return true;
    }
    if (fin.idempotent) {
      await rm(tmp, { force: true }).catch(() => {});
      jsonRes(res, 200, { ok: true, idempotent: true, sha256: fin.sha256, sizeBytes: fin.sizeBytes });
      return true;
    }
    // Atomic publish: the verified temp file replaces the destination in one rename.
    await rename(tmp, dest);
    const st = await stat(dest).catch(() => null);
    log("info", "REMOTE_ARTIFACT_STORED", { workspaceId: auth.workspaceId, workerId: auth.workerId, jobId: session.jobId, sizeBytes: st?.size ?? bytes });
    jsonRes(res, 200, { ok: true, sha256: actualSha256, sizeBytes: bytes, relativePath: session.relativePath });
    return true;
  }

  // ---------------------------------------------------------------- owner-side control
  async function requestDrain(workspaceId, workerId) {
    await registry.drain(workspaceId, workerId);
    const conn = sessions.get(workerId);
    if (conn && conn.workspaceId === workspaceId && !conn.closed) {
      conn.wantsWork = false;
      send(conn, makeFrame({ type: S2W.DRAIN, messageId: `msg_${randomBytes(9).toString("hex")}`, payload: { reason: "OWNER_DRAIN" } }));
      if (conn.inflight.size === 0) await registry.markDrained(workspaceId, workerId).catch(() => {});
    } else {
      await registry.markDrained(workspaceId, workerId).catch(() => {});
    }
    return { drained: true, inflight: conn ? conn.inflight.size : 0 };
  }

  // Called AFTER a credential revoke/rotate/disable has committed: the live socket loses its authority
  // immediately instead of at the next heartbeat.
  async function disconnectWorker(workspaceId, workerId, reason = "CREDENTIAL_REVOKED") {
    const conn = sessions.get(workerId);
    if (!conn || conn.workspaceId !== workspaceId) return { closed: false };
    sessions.delete(workerId);
    closeConn(conn, reason === "WORKER_DISABLED" ? CLOSE_REASON.WORKER_DISABLED : CLOSE_REASON.CREDENTIAL_REVOKED);
    return { closed: true };
  }

  function connectedWorkerIds() { return [...sessions.keys()]; }
  function isConnected(workerId) { const c = sessions.get(workerId); return Boolean(c && !c.closed && c.state === "ACTIVE"); }

  return Object.freeze({
    isEnabled: () => enabled === true,
    handleUpgrade, handleHttp, requestDrain, disconnectWorker, connectedWorkerIds, isConnected,
    delivery,
    uploadPath: UPLOAD_PATH,
    wsPath: REMOTE_WORKER_WS_PATH,
    protocolVersion: DELIVERY_PROTOCOL_VERSION,
    start() {
      if (started || !enabled) return;
      started = true;
      offerTimer = setInterval(() => { void offerSweep(); }, offerPollMs);
      if (offerTimer.unref) offerTimer.unref();
      log("info", "REMOTE_HUB_READY", { path: REMOTE_WORKER_WS_PATH, protocolVersion: DELIVERY_PROTOCOL_VERSION });
    },
    async stop() {
      draining = true;
      if (offerTimer) { clearInterval(offerTimer); offerTimer = null; }
      for (const conn of [...sessions.values()]) closeConn(conn, CLOSE_REASON.DRAINING);
      sessions.clear();
      try { wss.close(); } catch { /* */ }
      started = false;
    },
    getStatus() {
      return {
        component: "remoteWorkerHub", enabled, ready: enabled && started && !draining,
        protocolVersion: DELIVERY_PROTOCOL_VERSION, path: REMOTE_WORKER_WS_PATH,
        connectedWorkers: sessions.size
      };
    },
    _sessions: sessions
  });
}
