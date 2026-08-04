// P0 Step 5C.1 — Control Plane process entry point.
//
// Independent executable. Does NOT import ui-server, WorkerRuntime, or any provider. Runs
// only when executed directly; importing it (tests) does not start anything. Signal handlers
// are installed only in serve mode and are removable/testable.

import { pathToFileURL } from "node:url";
import { loadConfig, safeConfigSummary } from "./config/config.mjs";
import { createApp } from "./app.mjs";
import { createLogger } from "./logging/logger.mjs";
import { ControlPlaneError, CP_ERRORS, toControlPlaneError } from "./errors.mjs";

// runCheckConfig: validate config and print a sanitized summary. Never starts a server.
// Returns an exit code (0 ok, 1 invalid). `out`/`err` are injectable for tests.
export function runCheckConfig(env = process.env, { out = console.log, err = console.error } = {}) {
  try {
    const config = loadConfig(env);
    out(JSON.stringify({ ok: true, summary: safeConfigSummary(config) }, null, 2));
    return 0;
  } catch (e) {
    const cp = toControlPlaneError(e);
    // Print ONLY safe issue descriptors (field + reason), never values.
    err(JSON.stringify({ ok: false, code: cp.code, issues: cp.details?.issues ?? [] }, null, 2));
    return 1;
  }
}

// startServer: load config, build the app, start it, print a sanitized summary. Returns the
// running app (or throws ControlPlaneError). Does not install signal handlers.
export async function startServer(env = process.env) {
  const config = loadConfig(env); // throws E_CONFIG_INVALID on bad config
  const logger = createLogger({
    level: config.logging.level, service: config.logging.serviceName,
    instanceId: config.deployment.instanceId
  });
  const app = await createApp({ config, logger });
  await app.start();
  logger.info("control_plane_summary", { event: "control_plane_summary", outcome: "READY", summary: safeConfigSummary(config) });
  return app;
}

// installSignalHandlers(app, { signals, onExit }): wire SIGTERM/SIGINT → graceful stop.
// Returns a remove() that detaches the handlers (so tests never leak process listeners).
export function installSignalHandlers(app, { signals = ["SIGTERM", "SIGINT"], onExit = (code) => process.exit(code) } = {}) {
  let shuttingDown = false;
  const handler = async () => {
    if (shuttingDown) return;   // double-signal safe
    shuttingDown = true;
    try { await app.stop(); onExit(0); }
    catch { onExit(1); }
  };
  for (const sig of signals) process.on(sig, handler);
  return function remove() { for (const sig of signals) process.removeListener(sig, handler); };
}

async function mainServe(env) {
  let app;
  try { app = await startServer(env); }
  catch (e) {
    const cp = toControlPlaneError(e);
    console.error(JSON.stringify({ event: "control_plane_start_failed", code: cp.code, issues: cp.details?.issues ?? [] }));
    process.exitCode = 1;
    return;
  }
  installSignalHandlers(app);
}

// Direct-execution dispatch (never runs on import).
const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  const mode = process.argv[2] === "check-config" ? "check-config" : "serve";
  if (mode === "check-config") process.exit(runCheckConfig(process.env));
  else mainServe(process.env);
}

export { loadConfig, createApp };
