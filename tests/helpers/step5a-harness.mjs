// Shared helper for P0 Step 5A WebSocket tests. NOT a test file (not in test-all).
// Localhost only, fake handlers, fake credentials, temp recovery dirs.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import { generateId } from "../../lib/protocol/ids.mjs";
import { LocalControlPlane } from "../../lib/control/local-control-plane.mjs";
import { InMemoryCloudStore } from "../../lib/control/local-cloud-store.mjs";
import { createWebSocketWorker } from "../../lib/worker/local-worker-agent.mjs";
import { RecoveryJournal } from "../../lib/worker/recovery-journal.mjs";
import { PendingAckStore } from "../../lib/worker/pending-ack-store.mjs";

export { generateId, LocalControlPlane, InMemoryCloudStore, createWebSocketWorker, RecoveryJournal, PendingAckStore, WebSocket };

const tmpDirs = [];
export function mkTmp() { const d = mkdtempSync(path.join(os.tmpdir(), "avc-step5a-")); tmpDirs.push(d); return d; }
export function cleanupTmp() { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } }

// Time-based poll so real-time timers (reconnect backoff, heartbeat) can fire.
export async function waitFor(pred, budgetMs = 2000, stepMs = 3) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) { if (pred()) return true; await new Promise((r) => setTimeout(r, stepMs)); }
  return pred();
}
export const tick = (n = 1) => new Promise((r) => setTimeout(r, n));

// A control plane + a mutable credential map. Small heartbeat thresholds by default.
export async function startPlane(opts = {}) {
  const credentials = opts.credentials || {};
  const store = opts.store || new InMemoryCloudStore();
  const plane = new LocalControlPlane({ credentials, store, port: opts.port ?? 0, degradedMs: opts.degradedMs ?? 100, offlineMs: opts.offlineMs ?? 300, clock: opts.clock });
  await plane.start();
  return { plane, credentials, store };
}

let idSeq = 0;
export function makeIdentity(prefixHint = "") {
  idSeq += 1;
  return { workerId: generateId("wrk"), workspaceId: generateId("ws"), credential: `test-cred-${prefixHint}${idSeq}` };
}

// Connect a fake-handler worker. Returns { transport, runtime, agent, journal, pendingAck, ... }.
export function connectFakeWorker(plane, ident, opts = {}) {
  const journalRoot = opts.durable === false ? null : mkTmp();
  const journal = journalRoot ? new RecoveryJournal({ root: journalRoot }) : null;
  const pendingAck = journalRoot ? new PendingAckStore({ root: journalRoot }) : null;
  const worker = createWebSocketWorker({
    url: `ws://127.0.0.1:${plane.port}`, credential: ident.credential,
    workspaceId: opts.workspaceId ?? ident.workspaceId, workerId: opts.workerId ?? ident.workerId,
    journal, pendingAck, handlers: opts.handlers, backoffMs: opts.backoffMs ?? [10, 20, 40],
    autoReconnect: opts.autoReconnect !== false, checkSkew: opts.checkSkew === true
  });
  worker.agent.start();
  return { ...worker, journal, pendingAck };
}

export function grokInput(over = {}) {
  return { projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"),
    providerAccountId: generateId("pa"), sourceKeyframeAssetId: generateId("asset"),
    promptSnapshot: "Slow push-in", baseRevision: 1, requestedDurationSec: 10, ...over };
}
export function exportInput(over = {}) {
  return { projectId: generateId("prj"), episodeId: generateId("ep"), locales: ["en-US"], ...over };
}

// Raw ws client for protocol-error tests. Resolves with { ws, messages, closes }.
export function rawConnect(port, { authorization } = {}) {
  const headers = authorization ? { Authorization: authorization } : {};
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const messages = [];
  const closes = [];
  const unexpected = [];
  ws.on("message", (d) => { try { messages.push(JSON.parse(d.toString())); } catch { messages.push({ raw: d.toString() }); } });
  ws.on("close", (code) => closes.push(code));
  ws.on("unexpected-response", (_req, res) => { unexpected.push(res.statusCode); try { res.resume(); } catch { /* drain */ } });
  ws.on("error", () => {});
  return { ws, messages, closes, unexpected,
    open: () => new Promise((resolve, reject) => { ws.on("open", () => resolve(true)); ws.on("close", () => reject(new Error("closed"))); ws.on("unexpected-response", (_r, res) => reject(new Error(`HTTP ${res.statusCode}`))); ws.on("error", (e) => reject(e)); }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

// Count active handles that would keep the process alive (sockets/timers). For the
// clean-shutdown assertion. Best-effort; excludes stdio.
export function activeHandleCount() {
  try { return (process._getActiveHandles?.() || []).filter((h) => h && h.constructor && !/WriteStream|ReadStream|TTY/.test(h.constructor.name)).length; }
  catch { return 0; }
}
