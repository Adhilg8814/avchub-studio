#!/usr/bin/env node
// LOCAL Step 5A dev command: connect a Studio Worker (FAKE handlers) to the local
// Control-Plane simulator over a real WebSocket and print sanitized connection/job
// events. NEVER launches a provider (fake handlers only). NOT in test-all. Ctrl+C to stop.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebSocketWorker } from "../lib/worker/local-worker-agent.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import { PendingAckStore } from "../lib/worker/pending-ack-store.mjs";
import { DEV_URL, DEV_CREDENTIAL, DEV_WORKER_ID, DEV_WORKSPACE_ID } from "./worker-dev-config.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "avc-worker-local-"));
const journal = new RecoveryJournal({ root });
const pendingAck = new PendingAckStore({ root });

const worker = createWebSocketWorker({ url: DEV_URL, credential: DEV_CREDENTIAL, workspaceId: DEV_WORKSPACE_ID, workerId: DEV_WORKER_ID, journal, pendingAck });

console.log(`\n[worker-local] connecting to ${DEV_URL} (FAKE handlers: ${worker.registry.list().join(", ")})`);
worker.transport.onOpen(({ reconnect }) => console.log(`[worker-local] socket open${reconnect ? " (reconnect)" : ""}`));
worker.transport.onClose(({ intentional }) => console.log(`[worker-local] socket closed${intentional ? " (intentional)" : " — will retry"}`));
worker.transport.subscribeWorker((env) => { if (["HELLO_ACK", "JOB_OFFER", "STATE_RECONCILE_REQUEST", "MESSAGE_ACK"].includes(env.type)) console.log(`[worker-local] ← ${env.type}`); });

worker.agent.start();
await worker.agent.waitReady().catch(() => {});
console.log("[worker-local] ready (hello acked). Waiting for jobs… Ctrl+C to stop.");
worker.agent.startHeartbeat(5000);

process.on("SIGINT", async () => { await worker.agent.stop({ goodbye: true }); try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } console.log("\n[worker-local] stopped."); process.exit(0); });
