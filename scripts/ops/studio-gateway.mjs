// P0 Step 5C.13 - studio gateway CLI: run | status | stop. Loopback-only; duplicate-safe.
// Exit codes: run 0 on clean shutdown / 1 error; status 0 running+upstream-ready, 2 running
// degraded, 3 not running; stop 0 stopped/not-running, 1 error. Never prints secrets.
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs, resolveConfig, printIssues, emit, helpAndExit, pidAlive } from "./cli-util.mjs";
import { createStudioGateway, probeGateway } from "../../lib/ops/studio-gateway.mjs";

const { flags, positional } = parseArgs();
helpAndExit(flags, `
studio-gateway.mjs <run|status|stop> [--config <path>] [--json]
Stable loopback reverse-proxy for the cloud Studio (Cloudflare tunnel targets it).
  run     start in the foreground (Scheduled Task/service wrapper keeps it alive)
  status  0 running+ready | 2 running, upstream not ready | 3 not running
  stop    stop a running gateway via its pid file`);

const cmd = positional[0] || "run";
const { ok, config, issues } = resolveConfig(flags, { requireDirs: false });
if (!ok && cmd === "run") { printIssues(issues); process.exit(1); }
const cloudDir = config.cloud.cloudDir;
const pidFile = path.join(cloudDir, "gateway.pid");
const port = config.cloud.gatewayPort;

if (cmd === "status") {
  const probe = await probeGateway(port);
  if (!probe.running) { emit(flags, `gateway: NOT RUNNING (port ${port})`, { ok: false, running: false }); process.exit(3); }
  emit(flags, `gateway: RUNNING on 127.0.0.1:${port} (upstream ${probe.upstreamReady ? "READY" : "NOT READY - fail-closed 503"})`, { ok: true, running: true, upstreamReady: probe.upstreamReady });
  process.exit(probe.upstreamReady ? 0 : 2);
}
if (cmd === "stop") {
  let pid = null;
  try { pid = Number(readFileSync(pidFile, "utf8").trim()); } catch { /* */ }
  if (!pid || !pidAlive(pid)) { rmSync(pidFile, { force: true }); emit(flags, "gateway: not running", { ok: true, running: false }); process.exit(0); }
  try { process.kill(pid); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 500));
  rmSync(pidFile, { force: true });
  emit(flags, `gateway: stopped (pid ${pid})`, { ok: true, stopped: true });
  process.exit(0);
}
if (cmd !== "run") { emit(flags, "unknown command (see --help)", { ok: false }); process.exit(1); }

// run (duplicate-safe): an existing healthy AVC gateway on the port means we are done.
const existing = await probeGateway(port);
if (existing.running) { emit(flags, `gateway already running on 127.0.0.1:${port}`, { ok: true, alreadyRunning: true }); process.exit(0); }
if (existing.foreign) { emit(flags, `[FAIL] port ${port} is served by a FOREIGN process - refusing`, { ok: false, code: "E_GATEWAY_PORT_FOREIGN" }); process.exit(1); }

// P0 Step 5C.25: enable the gateway PEP (authorize-before-forward) when the production config turns it on.
// OFF (default) => the pre-PEP passthrough behaviour; the data path is protected by Cloudflare Access.
const pepEnabled = Boolean(config.nativeAuth && config.nativeAuth.gatewayPepEnabled === true);
// P0 Step 5C.28: remote-worker WSS upgrade proxy path. OFF (null) unless production config sets it.
const workerWsPath = (config.nativeAuth && config.nativeAuth.workerWsProxyPath) || null;
const gateway = createStudioGateway({
  pepEnabled,
  workerWsPath,
  // P0 Step 5C.31 - the production remote-delivery hub lives in the worker runtime (enrollment upstream).
  workerWsUpstream: (config.nativeAuth && config.nativeAuth.workerWsUpstream) || "enrollment",
  port,
  statusFile: config.runtime.statusFile,
  secretFile: path.join(cloudDir, "gateway-secret.txt"),
  externalOrigin: config.cloud.externalOrigin
});
try {
  const started = await gateway.start();
  mkdirSync(cloudDir, { recursive: true });
  writeFileSync(pidFile, String(process.pid), "utf8");
  emit(flags, `gateway: listening on http://127.0.0.1:${started.port} for ${config.cloud.externalOrigin} (fail-closed when runtime is not READY)`, { ok: true, port: started.port });
  const shutdown = async () => { try { await gateway.stop(); } catch { /* */ } rmSync(pidFile, { force: true }); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (e) {
  emit(flags, `[FAIL] ${e.code || "E_GATEWAY"}: ${e.message}`, { ok: false, code: e.code || "E_GATEWAY" });
  process.exit(1);
}
