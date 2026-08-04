#!/usr/bin/env node
// P0 Step 5C.8B1 — ACTUAL Worker child-process runner.
//
// Runs a REAL local Worker using the committed production components — NOT a raw-WebSocket
// fake. It pairs (or reconnects) through the real pairing client + credential store, connects
// to the real Gateway, and runs the real WorkerRuntime with the deterministic fake GENERATE_VIDEO
// provider injected at the JobRegistry handler boundary. Every JOB_ACCEPTED/PROGRESS/COMPLETED
// is emitted by the actual runtime; this process constructs none of them.
//
// Coordination with the parent harness is via NDJSON on stdout (never secrets):
//   {"event":"paired","workerId":"wrk_…","workspaceId":"ws_…"}
//   {"event":"online"} | {"event":"error","code":"…"} | {"event":"stopped"}
// The parent sends a line on stdin: "stop" → clean shutdown (drain + stop + exit 0).
//
// Config comes from ENV only (never argv secrets):
//   S5C8_HTTP_BASE   http://127.0.0.1:PORT   (pairing claim endpoint)
//   S5C8_WS_URL      ws://127.0.0.1:PORT/ws/worker
//   S5C8_ROOT        OS temp root for cred store + journal + pending-ack + provider (OUTSIDE repo)
//   S5C8_MODE        "pair" (first run, needs S5C8_PAIR_CODE) | "reconnect" (reuse DPAPI credential)
//   S5C8_PAIR_CODE   one-time pairing code (pair mode only; consumed, never logged)
//   S5C8_CRED_BACKEND "dpapi" (default on win32) | "memory"
//   S5C8_PROVIDER_MODE "success" (default) | "fail"
//   S5C8_PROVIDER_DELAY_MS  integer

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WorkerPairingClient } from "../lib/worker/pairing-client.mjs";
import { DpapiCredentialStore, MemoryCredentialStore, makeDpapiRunner } from "../lib/worker/credential-store.mjs";
import { createPairedWorker } from "../lib/worker/local-worker-agent.mjs";
import { RecoveryJournal } from "../lib/worker/recovery-journal.mjs";
import { PendingAckStore } from "../lib/worker/pending-ack-store.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { createFakeVideoProvider, makeFakeVideoHandler } from "../tests/helpers/step5c8-fake-provider.mjs";
import { createCrashController } from "../tests/helpers/step5c8-crash-injection.mjs";

function emit(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
function die(code, extra = {}) { emit({ event: "error", code, ...extra }); process.exit(1); }

const HTTP_BASE = process.env.S5C8_HTTP_BASE;
const WS_URL = process.env.S5C8_WS_URL;
const ROOT = process.env.S5C8_ROOT;
const MODE = process.env.S5C8_MODE || "pair";
const CRED_BACKEND = process.env.S5C8_CRED_BACKEND || (process.platform === "win32" ? "dpapi" : "memory");
if (!WS_URL || !ROOT) die("E_RUNNER_CONFIG", { missing: ["S5C8_WS_URL", "S5C8_ROOT"].filter((k) => !process.env[k]) });

const credDir = path.join(ROOT, "cred");
const identityFile = path.join(ROOT, "worker-identity.json"); // workerId/workspaceId — NOT secret
mkdirSync(credDir, { recursive: true });

// Credential store: DPAPI-backed on Windows (secret encrypted at rest via PowerShell over STDIN,
// never argv/env), memory only as an explicit fallback.
function buildCredentialStore() {
  if (CRED_BACKEND === "memory") return new MemoryCredentialStore();
  return new DpapiCredentialStore({ dir: credDir, runner: makeDpapiRunner({ spawn }) });
}

async function main() {
  const credentialStore = buildCredentialStore();
  let workspaceId; let workerId;

  if (MODE === "pair") {
    const code = process.env.S5C8_PAIR_CODE;
    if (!HTTP_BASE || !code) die("E_RUNNER_PAIR_CONFIG");
    const client = new WorkerPairingClient({
      url: HTTP_BASE, credentialStore, installationId: generateId("wrk"),
      capabilities: ["grok.video", "video.generate"], workerName: "step5c8b1-worker"
    });
    let paired;
    try { paired = await client.pair(code); }
    catch (e) { die("E_PAIR_FAILED", { detail: String(e.code || e.name || "err") }); return; }
    workspaceId = paired.workspaceId; workerId = paired.workerId;
    writeFileSync(identityFile, `${JSON.stringify({ workspaceId, workerId })}\n`, "utf8");
    emit({ event: "paired", workerId, workspaceId });
    return startWorker({ credentialStore, client, workspaceId, workerId });
  }

  // reconnect: reuse the persisted identity + the credential already in the DPAPI store.
  if (!existsSync(identityFile)) die("E_NO_IDENTITY");
  ({ workspaceId, workerId } = JSON.parse(readFileSync(identityFile, "utf8")));
  const active = await credentialStore.getActiveCredential();
  if (!active || !active.credential) die("E_NO_CREDENTIAL"); // reconnect must NOT need a new code
  const client = new WorkerPairingClient({ url: HTTP_BASE || "", credentialStore, installationId: workerId, capabilities: ["grok.video", "video.generate"] });
  emit({ event: "reconnecting", workerId, workspaceId });
  return startWorker({ credentialStore, client, workspaceId, workerId });
}

async function startWorker({ credentialStore, client, workspaceId, workerId }) {
  // TEST-ONLY crash/pause controller (NO-OP unless S5C8_CRASH_AT / S5C8_PAUSE_AT are set). Markers +
  // release files live under ROOT/markers so the harness can observe reaching a window / release a pause.
  const crash = createCrashController({ markersDir: process.env.S5C8_MARKERS || path.join(ROOT, "markers") });
  const provider = createFakeVideoProvider({
    root: path.join(ROOT, "provider"),
    delayMs: Number.parseInt(process.env.S5C8_PROVIDER_DELAY_MS || "0", 10) || 0,
    mode: process.env.S5C8_PROVIDER_MODE === "fail" ? "fail" : "success",
    crash
  });
  const journal = new RecoveryJournal({ root: path.join(ROOT, "worker") });
  const pendingAck = new PendingAckStore({ root: path.join(ROOT, "worker") });
  const worker = createPairedWorker({
    url: WS_URL, credentialStore, pairingClient: client, workspaceId, workerId,
    handlers: { GENERATE_VIDEO: makeFakeVideoHandler({ provider, crash }) },
    capabilities: ["grok.video", "video.generate"],
    durationContext: { supportedDurationsSec: [5, 10, 15], defaultDurationSec: 5 },
    journal, pendingAck, backoffMs: [200, 400, 800]
  });

  // Transport-level crash window (scenario 4): the worker received a JOB_OFFER but crashes before the
  // runtime can accept it. Subscribed BEFORE agent.start() so this hook runs before the runtime's own
  // subscriber (Set insertion order) → process exits before JOB_ACCEPTED is emitted. NO-OP unless armed.
  if (crash.crashAt === "AFTER_OFFER_RECEIVED") {
    worker.transport.subscribeWorker((env) => { if (env && env.type === "JOB_OFFER") crash.maybeCrash("AFTER_OFFER_RECEIVED", { jobId: env.jobId }); });
  }

  // Recover any durable in-flight jobs first (never auto-retries a submitted paid generation).
  try { const rec = worker.runtime.recoverJobs(); emit({ event: "recovered", candidates: rec.candidates.length }); } catch { /* first boot: none */ }

  worker.agent.start();
  // Wait for the REAL transport-open + HELLO_ACK before declaring online (authoritative
  // online is also the Gateway's worker_connection_sessions ACTIVE row, checked by the harness).
  try { await worker.agent.waitReady(12000); } catch (e) { die("E_CONNECT_FAILED", { detail: String(e && (e.code || e.message)).slice(0, 60) }); return; }
  emit({ event: "online", workerId });

  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return; stopping = true;
    try { worker.runtime.drain?.(); } catch { /* */ }
    try { await worker.agent.stop?.(); } catch { /* */ }
    try { worker.runtime.stop?.(); } catch { /* */ }
    emit({ event: "stopped", reason });
    process.exit(0);
  };
  process.stdin.on("data", (b) => { if (String(b).trim() === "stop") shutdown("stdin"); });
  process.on("SIGTERM", () => shutdown("sigterm"));
  process.on("SIGINT", () => shutdown("sigint"));
}

main().catch((e) => die("E_RUNNER_FATAL", { detail: String(e && (e.code || e.message)).slice(0, 80) }));
