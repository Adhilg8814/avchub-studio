// P0 Step 5C.3 — processor CLI (`control-plane:processor:once`).
//
// Runs ONE bounded processor cycle (outbox drain + enabled sweeps) against an EXPLICITLY
// configured local/dev/test database, then exits. Safe by construction:
//   - refuses environment=production;
//   - refuses a non-loopback database host (never touches a remote/staging/prod DB);
//   - opens NO WSS (delivery adapter stays unavailable — this is not Step 5C.4);
//   - processes bounded batches then exits.
//
// It does NOT auto-migrate. If the schema is not DATABASE_READY the cycle no-ops (readiness false).

import { loadConfig, safeConfigSummary } from "../config/config.mjs";
import { createLogger } from "../logging/logger.mjs";
import { createPersistence } from "../persistence/persistence.mjs";
import { createBackgroundProcessor } from "./processor.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function urlHost(u) {
  try { return new URL(u).hostname; } catch { return null; }
}

async function main() {
  // Force the processor ON for this one-shot run; everything else comes from the environment.
  const env = { ...process.env, CONTROL_PLANE_PROCESSOR_ENABLED: "true" };
  let config;
  try {
    config = loadConfig(env);
  } catch (e) {
    console.error("processor:once config invalid:", e.code || e.message);
    process.exit(2);
  }

  if (config.server.environment === "production") {
    console.error("REFUSED: processor:once must not run in production");
    process.exit(3);
  }
  if (!config.database.enabled || !config.database.url) {
    console.error("REFUSED: CONTROL_PLANE_DB_ENABLED=true and CONTROL_PLANE_DB_URL are required");
    process.exit(3);
  }
  const host = urlHost(config.database.url);
  if (!host || !LOOPBACK.has(host)) {
    console.error(`REFUSED: database host must be loopback for processor:once (got ${host ? "non-loopback" : "unparseable"})`);
    process.exit(3);
  }

  const logger = createLogger({ level: config.logging.level, service: "processor-once", instanceId: config.deployment.instanceId, now: () => new Date().toISOString() });
  const persistence = createPersistence(config, { logger });
  const processor = createBackgroundProcessor(config, { logger, adapter: persistence });

  await persistence.start();
  const health = persistence.health();
  if (!health.ready) {
    console.error("processor:once: database not ready (no auto-migrate). reason:", health.reasonCode);
    await persistence.stop();
    process.exit(4);
  }

  const abort = new AbortController();
  const onSig = () => abort.abort();
  process.once("SIGINT", onSig); process.once("SIGTERM", onSig);

  let stats;
  try {
    stats = await processor.runOnce({ signal: abort.signal });
  } catch (e) {
    console.error("processor:once cycle failed:", e.code || e.message);
    await processor.stop().catch(() => {});
    await persistence.stop().catch(() => {});
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, instance: safeConfigSummary(config).instanceId, stats }, null, 2));
  await processor.stop().catch(() => {});
  await persistence.stop().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error("processor:once fatal:", e && (e.code || e.message)); process.exit(1); });
