#!/usr/bin/env node
// P0 Step 5B — multiple Workers per workspace (isolation) + audit/security + clean
// shutdown, over a REAL local WebSocket. Fake handlers only.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { generateId } from "../lib/protocol/ids.mjs";
import { makeEnvelope } from "../lib/protocol/envelope.mjs";
import { InMemoryWorkerIdentityStore } from "../lib/control/worker-identity-store.mjs";
import { PairingService } from "../lib/control/pairing-service.mjs";
import { LocalControlPlane } from "../lib/control/local-control-plane.mjs";
import { MemoryCredentialStore } from "../lib/worker/credential-store.mjs";
import { WorkerPairingClient } from "../lib/worker/pairing-client.mjs";
import { createPairedWorker } from "../lib/worker/local-worker-agent.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let failures = 0, passed = 0;
function check(name, actual, expected = true) { const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected; if (ok) passed += 1; else { failures += 1; console.error(`FAIL ${name}\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); } }
const waitFor = async (p, ms = 2500) => { const s = Date.now(); while (Date.now() - s < ms) { if (p()) return true; await new Promise((r) => setTimeout(r, 3)); } return p(); };
const tick = (n) => new Promise((r) => setTimeout(r, n));
function handleCount() { try { return (process._getActiveHandles?.() || []).filter((h) => h && h.constructor && !/WriteStream|ReadStream|TTY/.test(h.constructor.name)).length; } catch { return 0; } }

const WS1 = "ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3";
const WS2 = "ws_01JQ7ZK9M3N4P5Q6R7S8T9V0C4";
const tmp = []; const workers = []; let plane, svc;
function grokInput() { return { projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"), providerAccountId: generateId("pa"), sourceKeyframeAssetId: generateId("asset"), promptSnapshot: "p", baseRevision: 0, requestedDurationSec: 10 }; }
function countingHandler(state) { return { validate() {}, capabilities: () => ["grok.video"], async execute() { state.n += 1; return { result: { asset: { assetId: generateId("asset"), provider: "FAKE", relativePath: "a/b.mp4", checksum: "x", sizeBytes: 1, mimeType: "video/mp4", reviewStatus: "PENDING", selected: false, approved: false } } }; } }; }

async function pairWorker(workspaceId, opts = {}) {
  const credStore = new MemoryCredentialStore();
  const { code } = plane.createPairingCode({ workspaceId });
  const client = new WorkerPairingClient({ url: `http://127.0.0.1:${plane.port}`, credentialStore: credStore, installationId: generateId("wrk"), capabilities: opts.capabilities ?? ["grok.video"] });
  const paired = await client.pair(code);
  const worker = createPairedWorker({ url: `ws://127.0.0.1:${plane.port}`, credentialStore: credStore, pairingClient: client, workspaceId: paired.workspaceId, workerId: paired.workerId, handlers: opts.handlers, capabilities: opts.capabilities, backoffMs: [10, 20] });
  workers.push(worker); worker.agent.start();
  await worker.agent.waitReady();
  return { paired, worker, credStore };
}

try {
  const store = new InMemoryWorkerIdentityStore();
  svc = new PairingService({ store, pairingPepper: "PP", credentialPepper: "CP", limits: { codeCreate: { max: 50, windowMs: 60000 }, attemptsPerSource: { max: 100, windowMs: 60000 }, maxAttemptsPerCode: 5, rotate: { max: 10, windowMs: 60000 } } });
  plane = new LocalControlPlane({ pairingService: svc });
  await plane.start();

  const stateA = { n: 0 }; const stateB = { n: 0 };
  const A = await pairWorker(WS1, { handlers: { GENERATE_GROK_VIDEO: countingHandler(stateA) } });
  const B = await pairWorker(WS1, { handlers: { GENERATE_GROK_VIDEO: countingHandler(stateB) } });

  // 62/63/64. two workers, same workspace, separate credentials + status
  check("62 two workers in one workspace", svc._store.listWorkersByWorkspace(WS1).length, 2);
  check("62 distinct workerIds", A.paired.workerId !== B.paired.workerId, true);
  check("63 separate credentials", A.credStore.getActiveCredential().credential !== B.credStore.getActiveCredential().credential, true);
  check("64 both online independently", plane.getWorkerStatus(A.paired.workerId) === "ONLINE" && plane.getWorkerStatus(B.paired.workerId) === "ONLINE", true);

  // 65. job targeted to A does not reach B
  const hA = plane.offerJob(A.paired.workerId, "GENERATE_GROK_VIDEO", grokInput());
  await hA.done;
  check("65 job A executed by A", stateA.n, 1);
  check("65 job A NOT executed by B", stateB.n, 0);

  // 69. capabilities/status tracked per worker
  await waitFor(() => plane.store.capabilities(A.paired.workerId).length > 0 && plane.store.capabilities(B.paired.workerId).length > 0);
  check("69 per-worker capabilities", plane.store.capabilities(A.paired.workerId).includes("grok.video") && plane.store.capabilities(B.paired.workerId).includes("grok.video"), true);

  // 67. credential resolves to exactly one workerId (identity from credential, not claim)
  check("67 credential A resolves to worker A only", svc.authenticate(A.credStore.getActiveCredential().credential).workerId, A.paired.workerId);
  check("67 credential B resolves to worker B only", svc.authenticate(B.credStore.getActiveCredential().credential).workerId, B.paired.workerId);

  // 68. cross-workspace targeting rejected
  let xThrew = false; try { plane.offerJob(A.paired.workerId, "GENERATE_GROK_VIDEO", grokInput(), { workspaceId: WS2 }); } catch (e) { xThrew = /WORKSPACE_MISMATCH/.test(e.message); }
  check("68 cross-workspace targeting rejected", xThrew, true);

  // 66. revoke A does not disconnect B
  let repairA = false; A.worker.agent.onRepairRequired(() => { repairA = true; });
  plane.revokeWorker(A.paired.workerId);
  await waitFor(() => repairA);
  check("66 revoke A → A repair-required", A.worker.agent.isRepairRequired(), true);
  check("66 B still online after A revoked", B.worker.transport.isConnected(), true);

  // 67b. over the wire: a raw connection (B's credential) claiming a DIFFERENT workerId
  // → E_IDENTITY_MISMATCH (connection identity comes from the credential, not the frame).
  {
    const raw = new WebSocket(`ws://127.0.0.1:${plane.port}`, { headers: { Authorization: `Bearer ${B.credStore.getActiveCredential().credential}` } });
    const errs = [];
    raw.on("message", (d) => { try { const m = JSON.parse(d.toString()); if (m.type === "ERROR") errs.push(m.payload.code); } catch { /* */ } });
    raw.on("error", () => {});
    await new Promise((r) => raw.on("open", r));
    raw.send(JSON.stringify(makeEnvelope({ type: "WORKER_HEARTBEAT", workspaceId: WS1, workerId: A.paired.workerId, payload: { activeJobs: [], freeBytes: 1 } })));
    await waitFor(() => errs.length > 0);
    check("67 credential B claiming another workerId → E_IDENTITY_MISMATCH", errs[0], "E_IDENTITY_MISMATCH");
    try { raw.close(); } catch { /* */ }
    await tick(10);
  }

  // ---- audit/security ----
  const dump = JSON.stringify(svc._store.snapshot()) + JSON.stringify(svc._store.getAuditEvents()) + JSON.stringify(plane.store.getAudit());
  check("72 no plaintext pairing code in store dump", /-[0-9A-HJKMNP-TV-Z]{4}-/.test(JSON.stringify(svc._store.snapshot().codes.map((c) => c.pairingCodeId))) === false, true);
  check("73 no credential in store dump", dump.includes("wcred_"), false);
  check("74 no Authorization/Bearer header logged", /Bearer\s/i.test(dump), false);
  check("70 audit records worker + credential events", svc._store.getAuditEvents().some((a) => a.type === "WORKER_CREATED") && svc._store.getAuditEvents().some((a) => a.type === "CREDENTIAL_ISSUED"), true);

  // 78. raw stack trace not returned by the pairing endpoint on bad input
  {
    const res = await new Promise((resolve) => {
      const http = { hostname: "127.0.0.1", port: plane.port, path: "/worker/pair", method: "POST", headers: { "Content-Type": "application/json" } };
      import("node:http").then(({ request }) => {
        const req = request(http, (r) => { let o = ""; r.on("data", (d) => { o += d; }); r.on("end", () => resolve(o)); });
        req.on("error", () => resolve(""));
        req.end("{ this is not valid json");
      });
    });
    check("78 no stack trace in bad-request response", /\bat \S+:\d+/.test(res) || /\.mjs:\d+/.test(res), false);
  }

  await tick(20);
  check("no unhandled rejection", un, false);
} finally {
  for (const w of workers) { try { await w.agent.stop(); } catch { /* */ } }
  try { await plane.stop(); } catch { /* */ }
  for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

await tick(40);
check("79 clean shutdown: no leaked active handles", handleCount() <= 1, true);

if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
