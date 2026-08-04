#!/usr/bin/env node
// P0 Step 5C.5 — worker:pair — exchange a one-time pairing code for a Worker credential against a
// REAL Control Plane and store the credential securely (DPAPI on Windows). Thin CLI over the
// shipped lib/worker WorkerPairingClient — it POSTs {url}/worker/pair and writes the plaintext
// credential into the secure store BEFORE reporting success. The plaintext credential is NEVER
// printed, logged, or placed in argv/URL; only safe metadata (workerId/workspaceId/expiry) is shown.
//
// Usage:
//   node scripts/worker-pair.mjs --url http://127.0.0.1:8787 --code XXXX-XXXX-XXXX \
//        --name my-studio --store-dir C:\\ProgramData\\avc-worker\\creds
//   node scripts/worker-pair.mjs --url ... --code ... --dry-run   # in-memory store (no persistence)
//
// The pairing code may be passed via --code or the WORKER_PAIRING_CODE env var (preferred, so it
// never lands in shell history / process listing). The credential store dir MUST be OUTSIDE the
// repo (enforced by DpapiCredentialStore); default is a per-user AVC data dir.

import os from "node:os";
import path from "node:path";
import { WorkerPairingClient } from "../lib/worker/pairing-client.mjs";
import { MemoryCredentialStore, DpapiCredentialStore } from "../lib/worker/credential-store.mjs";

function parseArgs(argv) {
  const a = { capabilities: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--url") a.url = next();
    else if (k === "--code") a.code = next();
    else if (k === "--name") a.name = next();
    else if (k === "--install") a.installationId = next();
    else if (k === "--store-dir") a.storeDir = next();
    else if (k === "--capability") a.capabilities.push(next());
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("worker:pair --url <controlPlaneUrl> --code <XXXX-XXXX-XXXX> [--name <label>] [--install <id>] [--store-dir <dirOutsideRepo>] [--dry-run]");
    process.exit(0);
  }
  const url = args.url || process.env.CONTROL_PLANE_URL;
  const code = args.code || process.env.WORKER_PAIRING_CODE;
  if (!url) { console.error("ERROR: --url (or CONTROL_PLANE_URL) is required"); process.exit(2); }
  if (!code) { console.error("ERROR: --code (or WORKER_PAIRING_CODE) is required"); process.exit(2); }

  const store = args.dryRun
    ? new MemoryCredentialStore()
    : new DpapiCredentialStore({ dir: args.storeDir || path.join(os.homedir(), ".avc-worker", "credentials") });

  const client = new WorkerPairingClient({
    url, credentialStore: store,
    workerName: args.name || os.hostname(),
    installationId: args.installationId || null,
    capabilities: args.capabilities
  });

  try {
    const r = await client.pair(code);   // stores credential securely; returns SAFE metadata only
    console.log(JSON.stringify({
      ok: true, stored: r.stored, workerId: r.workerId, workspaceId: r.workspaceId,
      credentialExpiresAt: r.credentialExpiresAt, store: args.dryRun ? "memory" : "dpapi"
    }));
    process.exit(0);
  } catch (err) {
    // Never echo the code/credential; surface only a stable error code + generic message.
    console.error(JSON.stringify({ ok: false, code: err && err.code ? err.code : "E_PAIRING_FAILED", message: "Pairing failed" }));
    process.exit(1);
  }
}

main();
