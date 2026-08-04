#!/usr/bin/env node
// LOCAL Step 5B pairing dev CLI (localhost only, dev credentials, fake handlers).
// Subcommands (mapped to npm scripts):
//   serve   → run the pairing Control Plane (admin API enabled) + offer a fake job
//   code    → create a one-time pairing code (shown ONCE)
//   pair <CODE> → pair a fake-handler worker, store credential securely, connect
//   list    → list workers (sanitized; no secrets)
//   rotate <workerId> → operator-initiated credential rotation
//   revoke <workerId> → revoke a worker
// A Worker credential is NEVER printed. NOT part of test-all.

import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFileWorkerIdentityStore } from "../lib/control/worker-identity-store.mjs";
import { PairingService } from "../lib/control/pairing-service.mjs";
import { LocalControlPlane } from "../lib/control/local-control-plane.mjs";
import { MemoryCredentialStore } from "../lib/worker/credential-store.mjs";
import { WorkerPairingClient } from "../lib/worker/pairing-client.mjs";
import { createPairedWorker } from "../lib/worker/local-worker-agent.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { DEV_HOST, DEV_PAIR_PORT, DEV_PAIR_WS, DEV_PAIRING_PEPPER, DEV_CREDENTIAL_PEPPER, DEV_IDENTITY_FILE } from "./worker-dev-config.mjs";

const cmd = process.argv[2];
const base = `http://${DEV_HOST}:${DEV_PAIR_PORT}`;
const post = (p, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body || {});
  const req = http.request({ hostname: DEV_HOST, port: DEV_PAIR_PORT, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (r) => { let o = ""; r.on("data", (d) => { o += d; }); r.on("end", () => { let j = null; try { j = JSON.parse(o || "{}"); } catch { /* */ } resolve({ status: r.statusCode, json: j }); }); });
  req.on("error", reject); req.write(data); req.end();
});

async function serve() {
  const store = makeFileWorkerIdentityStore({ file: DEV_IDENTITY_FILE });
  const svc = new PairingService({ store, pairingPepper: DEV_PAIRING_PEPPER, credentialPepper: DEV_CREDENTIAL_PEPPER, controlPlaneUrl: `ws://${DEV_HOST}:${DEV_PAIR_PORT}` });
  const plane = new LocalControlPlane({ pairingService: svc, port: DEV_PAIR_PORT, adminEnabled: true });
  await plane.start();
  console.log(`\n[pairing-local] Control Plane on ${base}  (admin API enabled — LOCAL DEV ONLY)`);
  console.log(`[pairing-local] identity file: ${DEV_IDENTITY_FILE}`);
  console.log("[pairing-local] Create a code:  npm run worker-pair-code-local");
  console.log("[pairing-local] Pair a worker:  npm run worker-pair-local -- <CODE>\n");
  let offered = new Set();
  setInterval(() => {
    for (const w of (svc._store.listWorkersByWorkspace?.(DEV_PAIR_WS) || [])) {
      if (plane.getWorkerStatus(w.workerId) === "ONLINE" && !offered.has(w.workerId)) {
        offered.add(w.workerId);
        console.log(`[pairing-local] worker ${w.workerId} online → offering fake job`);
        const h = plane.offerJob(w.workerId, "GENERATE_GROK_VIDEO", { projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"), providerAccountId: generateId("pa"), sourceKeyframeAssetId: generateId("asset"), promptSnapshot: "demo", baseRevision: 0, requestedDurationSec: 10 });
        h.done.then((r) => console.log(`[pairing-local] job ${r.type} (provider ${r.payload?.result?.asset?.provider ?? "-"})`)).catch(() => {});
      }
    }
  }, 500);
  process.on("SIGINT", async () => { await plane.stop(); console.log("\n[pairing-local] stopped."); process.exit(0); });
}

async function code() { const r = await post("/admin/pair-code", { workspaceId: DEV_PAIR_WS }); if (r.status !== 200) return fail("could not create code (is `serve` running?)"); console.log(`\nPairing code (valid ~10 min, one-time): ${r.json.code}\n`); }
async function list() { const r = await post("/admin/list", { workspaceId: DEV_PAIR_WS }); if (r.status !== 200) return fail("could not list (is `serve` running?)"); console.log(JSON.stringify(r.json.workers, null, 2)); }
async function rotate(id) { const r = await post("/admin/rotate", { workerId: id }); console.log(r.status === 200 ? `rotation requested (${r.json.rotationId})` : "rotate failed"); }
async function revoke(id) { const r = await post("/admin/revoke", { workerId: id }); console.log(r.status === 200 ? "worker revoked" : "revoke failed"); }

async function pair(codeArg) {
  if (!codeArg) return fail("usage: npm run worker-pair-local -- <CODE>");
  const dir = mkdtempSync(path.join(os.tmpdir(), "avc-worker-cred-"));
  const credStore = new MemoryCredentialStore(); // (DPAPI store for real installs)
  const client = new WorkerPairingClient({ url: base, credentialStore: credStore, installationId: generateId("wrk"), capabilities: ["grok.video"] });
  const paired = await client.pair(codeArg).catch((e) => { fail(`pairing failed: ${e.code || e.message}`); return null; });
  if (!paired) return;
  console.log(`\n[worker-local] credential stored successfully. workerId=${paired.workerId}`); // credential itself NEVER printed
  const worker = createPairedWorker({ url: `ws://${DEV_HOST}:${DEV_PAIR_PORT}`, credentialStore: credStore, pairingClient: client, workspaceId: paired.workspaceId, workerId: paired.workerId, backoffMs: [500, 1000, 2000] });
  worker.transport.onOpen(({ reconnect }) => console.log(`[worker-local] socket open${reconnect ? " (reconnect)" : ""}`));
  worker.agent.onRepairRequired(() => console.log("[worker-local] REVOKED → re-pairing required."));
  worker.agent.start();
  await worker.agent.waitReady().catch(() => {});
  console.log("[worker-local] connected. Waiting for jobs… Ctrl+C to stop.");
  process.on("SIGINT", async () => { await worker.agent.stop(); try { require("node:fs").rmSync(dir, { recursive: true, force: true }); } catch { /* */ } process.exit(0); });
}

function fail(msg) { console.error(msg); process.exitCode = 1; }

const map = { serve, code, list, rotate: () => rotate(process.argv[3]), revoke: () => revoke(process.argv[3]), pair: () => pair(process.argv[3]) };
(map[cmd] || (() => fail(`unknown subcommand: ${cmd}`)))();
