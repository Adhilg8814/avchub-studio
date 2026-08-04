#!/usr/bin/env node
// LOCAL Step 5A dev command: run the local Control-Plane simulator on 127.0.0.1 and
// offer one fake job to the first worker that connects. Fake handlers, dev
// credential, sanitized event printing. NOT production, NOT in test-all. Ctrl+C to stop.

import { LocalControlPlane } from "../lib/control/local-control-plane.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { DEV_HOST, DEV_PORT, DEV_CREDENTIAL, DEV_CREDENTIALS, DEV_WORKER_ID } from "./worker-dev-config.mjs";

const plane = new LocalControlPlane({ credentials: DEV_CREDENTIALS, port: DEV_PORT });
await plane.start();
console.log(`\n[control-local] listening ws://${DEV_HOST}:${plane.port}  (dev credential: "${DEV_CREDENTIAL}")`);
console.log("[control-local] LOCAL simulator only — no cloud, no DB, no production route. Fake handlers only.\n");

let seenAudit = 0, offered = false;
const timer = setInterval(async () => {
  const audit = plane.getAudit();
  for (; seenAudit < audit.length; seenAudit += 1) console.log("[control-local] audit:", JSON.stringify(audit[seenAudit]));
  if (!offered && plane.getWorkerStatus(DEV_WORKER_ID) === "ONLINE") {
    offered = true;
    console.log("[control-local] worker online → offering fake GENERATE_GROK_VIDEO");
    const input = { projectId: generateId("prj"), episodeId: generateId("ep"), shotId: generateId("sh"), providerAccountId: generateId("pa"), sourceKeyframeAssetId: generateId("asset"), promptSnapshot: "dev demo", baseRevision: 0, requestedDurationSec: 10 };
    const h = plane.offerJob(DEV_WORKER_ID, "GENERATE_GROK_VIDEO", input);
    plane.getDispatcher(DEV_WORKER_ID).subscribe(h.jobId, (e) => console.log(`[control-local] job ${e.type}${e.payload?.percent != null ? ` ${e.payload.percent}%` : ""}`));
    h.done.then((res) => console.log(`[control-local] TERMINAL ${res.type} (provider ${res.payload?.result?.asset?.provider ?? "-"})`)).catch(() => {});
  }
}, 500);

process.on("SIGINT", async () => { clearInterval(timer); await plane.stop(); console.log("\n[control-local] stopped."); process.exit(0); });
