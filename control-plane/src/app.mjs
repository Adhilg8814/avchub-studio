// P0 Step 5C.1 — ControlPlaneApp: the modular-monolith composition root + process lifecycle.
//
// Wires the modules together via dependency injection and drives the deterministic startup /
// shutdown sequence. It owns the Control Plane PROCESS lifecycle only — it NEVER touches
// WorkerRuntime or any provider. Startup can reach READY (process live, HTTP listening) while
// /readyz is still false if an enabled dependency is unavailable (k8s-style liveness vs
// readiness split).

import { LIFECYCLE } from "./lifecycle.mjs";
import { ControlPlaneError, CP_ERRORS, toControlPlaneError } from "./errors.mjs";
import { createLogger } from "./logging/logger.mjs";
import { createFeatureFlags } from "./feature-flags/feature-flags.mjs";
import { createPersistence } from "./persistence/persistence.mjs";
import { createWorkerGateway } from "./gateway/gateway.mjs";
import { createBackgroundProcessor } from "./processor/processor.mjs";
import { createHealthRegistry } from "./health/health-registry.mjs";
import { createRouter } from "./api/router.mjs";
import { createHttpServer } from "./api/http-server.mjs";
import { createPairingService } from "./pairing/pairing-service.mjs";
import { createPairingRouter } from "./pairing/pairing-router.mjs";
import { createStagingApiService } from "./api-staging/staging-api-service.mjs";
import { createStagingApiRouter } from "./api-staging/staging-api-router.mjs";
import { createStagingSessionStore } from "./staging-ui/session-store.mjs";
// The web UI is an OPTIONAL layer. A build that ships it mounts it exactly as before; a build that does not
// serves the HTTP API alone rather than failing to start. Loaded through `optionalUi` below — a static
// import would make the whole control plane unstartable whenever the UI is not present.
import { createAuthRuntime } from "./auth/runtime/auth-runtime.mjs";

// Resolve an optional UI sub-router factory. A missing module is a deployment choice, not an error; anything
// else (a syntax error in a UI that IS present, say) is re-thrown, because silently serving no UI when one
// was shipped would look identical to a routing bug.
async function optionalUi(specifier, exportName) {
  try {
    const mod = await import(specifier);
    return mod[exportName] || null;
  } catch (e) {
    if (e && (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND")) return null;
    throw e;
  }
}

export async function createApp({ config, logger, now = () => new Date().toISOString() } = {}) {
  if (!config || typeof config !== "object") throw new ControlPlaneError(CP_ERRORS.E_CONFIG_INVALID, "createApp requires a validated config");

  const log = logger || createLogger({
    level: config.logging.level, service: config.logging.serviceName,
    instanceId: config.deployment.instanceId, now
  });

  // ---- module construction (DI) ----
  const featureFlags = createFeatureFlags({ featureFlags: config.featureFlags });
  const persistence = createPersistence(config, { logger: log, now });
  // The processor drives the durable inbox/outbox engine through the persistence adapter. It
  // opens NO socket — the Gateway installs the real delivery adapter into it at startup.
  const processor = createBackgroundProcessor(config, { logger: log, adapter: persistence, now });
  // The Gateway (Step 5C.4) is constructed after the HTTP server (below) so it can attach its WS
  // upgrade handler; declared here and health-registered lazily.
  let gateway = null;
  const health = createHealthRegistry({ now });

  health.register("featureFlags", () => featureFlags.getStatus());
  health.register("persistence", () => persistence.health());
  health.register("workerGateway", () => (gateway ? gateway.getStatus() : { component: "workerGateway", enabled: config.workerGateway.enabled, initialized: false, ready: !config.workerGateway.enabled, reasonCode: config.workerGateway.enabled ? "INITIALIZING" : "DISABLED" }));
  health.register("processor", () => processor.getStatus());
  health.register("api", () => ({ component: "api", enabled: true, initialized: httpStarted, ready: httpStarted, reasonCode: httpStarted ? "READY" : "INITIALIZING" }));

  let phase = LIFECYCLE.CREATED;
  let httpStarted = false;
  let stopRequested = false;
  let startPromise = null;

  function setPhase(next) { phase = next; log.debug("lifecycle_phase", { event: "lifecycle_phase", outcome: next }); }

  let httpServerRef = null;
  function readiness() {
    const snap = health.snapshot();
    // Ready only when the process is READY (not draining/failed), not draining at the HTTP
    // layer, AND every component reports ready.
    const draining = httpServerRef ? httpServerRef.isDraining() : false;
    const ready = phase === LIFECYCLE.READY && !draining && snap.ready;
    return { ready, phase, draining, components: snap.components };
  }

  // Worker pairing + credential lifecycle (Step 5C.5). OFF by default. The service disconnects a
  // worker's live socket AFTER a lifecycle change commits — via a lazy ref to the Gateway (built
  // just below), so a revoked/rotated/disabled worker loses its current authority immediately.
  const pairingService = createPairingService({
    config, persistence, logger: log, now: () => Date.now(),
    disconnectWorker: (ws, workerId, reason) => (gateway && typeof gateway.disconnectWorker === "function" ? gateway.disconnectWorker(ws, workerId, reason) : undefined)
  });
  const pairingRouter = createPairingRouter({ config, pairingService, logger: log });

  // Staging Project/Generation/Job/Result API (Step 5C.6). OFF by default. Reuses persistence +
  // the existing ownership transactions; the workspace is resolved from config, never a request body.
  const stagingApiService = createStagingApiService({ config, persistence, logger: log, now: () => Date.now() });
  const stagingApiRouter = createStagingApiRouter({ config, service: stagingApiService, logger: log });
  const stagingSessionStore = createStagingSessionStore({
    ttlMs: config.stagingUi.sessionTtlMs,
    maxSessions: config.stagingUi.maxSessions
  });
  const createStagingUiRouter = await optionalUi("./staging-ui/staging-ui-router.mjs", "createStagingUiRouter");
  const stagingUiRouter = createStagingUiRouter && createStagingUiRouter({
    config,
    sessions: stagingSessionStore,
    stagingApi: stagingApiRouter,
    pairing: pairingRouter,
    stagingApiService,
    logger: log
  });

  // P0 Step 5C.14: the internal production Content Studio UI (canonical routes, Vietnamese-default,
  // Worker-channel-backed, no operator token). Consulted FIRST so it owns "/" + the canonical routes
  // and the legacy /staging page redirects, leaving /staging/api|session|assets for the legacy router.
  // Legacy /staging PAGE shells redirect to canonical in every real deployment (the cloud runtime
  // runs as `development`); ONLY the `test` environment keeps them live for the operator-unlock tests.
  const createProductionUi = await optionalUi("./staging-ui/production-ui.mjs", "createProductionUi");
  const productionUiRouter = createProductionUi && createProductionUi({
    redirectLegacy: !config.isTest,
    production: config.isProduction,
    // The worker enrollment channel's loopback origin — injected into runtime-config ONLY for direct
    // local access (open-studio -Local), so the local UI can mutate via the security-approved
    // split-origin loopback path. Never injected for gateway/domain requests.
    providerLocalOrigin: config.stagingUi.providerLocalOrigin
  });

  // P0 Step 5C.23: the native-auth UI (login/security/bootstrap). INERT unless config.nativeAuth.uiEnabled
  // (production default OFF) — when off it claims no path and production routing is byte-for-byte unchanged.
  const createAuthUi = await optionalUi("./staging-ui/auth-ui.mjs", "createAuthUi");
  const authUiRouter = createAuthUi && createAuthUi({
    uiEnabled: config.nativeAuth.uiEnabled,
    bootstrapEnabled: config.nativeAuth.bootstrapEnabled,
    production: config.isProduction
  });

  // P0 Step 5C.24: the native-auth HTTP transport (AuthService + /api/auth/* + bootstrap). INERT unless
  // config.nativeAuth.routesEnabled (production default OFF) — when off it claims no path and routing is
  // byte-for-byte unchanged; when on it owns /api/auth/* (identity only from the opaque __Host- cookie).
  const authRuntime = createAuthRuntime({ persistence, config, logger: log });

  const router = createRouter({
    config,
    readiness,
    logger: log,
    authUi: authUiRouter,
    authRuntime,
    authAuthorize: authRuntime && authRuntime.authorize ? authRuntime.authorize : null,
    productionUi: productionUiRouter,
    stagingUi: stagingUiRouter,
    pairing: pairingRouter,
    stagingApi: stagingApiRouter
  });
  const httpServer = createHttpServer({ config, logger: log, router, now });
  httpServerRef = httpServer;
  // Now the HTTP server exists, build the Gateway (attaches its upgrade handler at start()).
  gateway = createWorkerGateway(config, { logger: log, persistence, processor, httpServer, now });

  async function runStart() {
    setPhase(LIFECYCLE.INITIALIZING);
    try {
      // Deterministic init order (config already validated before createApp):
      // logger → feature flags → persistence → processor → gateway → HTTP listener.
      log.info("control_plane_starting", {
        event: "control_plane_starting", environment: config.server.environment,
        component: "app", outcome: "INITIALIZING"
      });
      // Order: persistence → processor → HTTP listener → gateway (attaches WS upgrade to the
      // listening server + installs the delivery adapter into the processor).
      await persistence.start();
      await processor.start();
      await httpServer.start();
      httpStarted = true;
      await gateway.start();
      setPhase(LIFECYCLE.READY);
      const r = readiness();
      log.info("control_plane_ready", {
        event: "control_plane_ready", component: "app", outcome: r.ready ? "READY" : "READY_DEPENDENCIES_PENDING"
      });
    } catch (err) {
      setPhase(LIFECYCLE.FAILED);
      const cp = toControlPlaneError(err);
      log.error("control_plane_start_failed", { event: "control_plane_start_failed", component: "app", reasonCode: cp.code, outcome: "FAILED" });
      // A failed late dependency start must not leave the temporary session authority, HTTP
      // listener, pools, processor, or Gateway alive after start() rejects.
      httpServer.beginDrain();
      stagingSessionStore.clear();
      try { if (gateway) await gateway.stop(); } catch { /* original start error remains authoritative */ }
      try { await processor.stop(); } catch { /* */ }
      try { await httpServer.stop(); } catch { /* */ }
      httpStarted = false;
      try { await persistence.stop(); } catch { /* */ }
      stagingSessionStore.clear();
      throw cp;
    }
  }

  async function doStop({ timeoutMs } = {}) {
    setPhase(LIFECYCLE.DRAINING);                 // 1-2: readiness false + DRAINING
    httpServer.beginDrain();                       // 3: refuse new HTTP work
    stagingSessionStore.clear();
    log.info("control_plane_draining", { event: "control_plane_draining", component: "app", outcome: "DRAINING" });
    // Drain the Gateway FIRST (detach upgrades, close sockets, uninstall the delivery adapter),
    // then the processor, then the HTTP listener, then persistence.
    try { if (gateway) await gateway.stop(); } catch (e) { log.warn("gateway_stop_error", { event: "gateway_stop_error", reasonCode: toControlPlaneError(e).code }); }        // 4
    try { await processor.stop(); } catch (e) { log.warn("processor_stop_error", { event: "processor_stop_error", reasonCode: toControlPlaneError(e).code }); } // 5
    try { await httpServer.stop({ timeoutMs }); } catch (e) { log.warn("http_stop_error", { event: "http_stop_error", reasonCode: toControlPlaneError(e).code }); } // 6
    httpStarted = false;
    // An admitted request may have been waiting in transport body parsing when drain began. Clear
    // again after the listener and in-flight requests are fully stopped.
    stagingSessionStore.clear();
    try { await persistence.stop(); } catch (e) { log.warn("persistence_stop_error", { event: "persistence_stop_error", reasonCode: toControlPlaneError(e).code }); } // 7
    // 8: flush logger — the stream logger needs no explicit flush.
    setPhase(LIFECYCLE.STOPPED);                    // 9
    log.info("control_plane_stopped", { event: "control_plane_stopped", component: "app", outcome: "STOPPED" });
  }

  return {
    // ---- lifecycle ----
    async start() {
      if (phase === LIFECYCLE.READY || phase === LIFECYCLE.INITIALIZING) return this; // idempotent
      if (phase !== LIFECYCLE.CREATED) throw new ControlPlaneError(CP_ERRORS.E_INTERNAL, `cannot start from ${phase}`);
      startPromise = runStart();
      await startPromise;
      return this;
    },

    async stop(opts = {}) {
      stopRequested = true;
      // Serialize behind an in-progress start so we never drain a half-initialized app racily.
      if (startPromise) { try { await startPromise; } catch { /* start failed → still attempt cleanup */ } }
      if (phase === LIFECYCLE.STOPPED || phase === LIFECYCLE.DRAINING) return this; // idempotent / in-progress
      if (phase === LIFECYCLE.CREATED) { stagingSessionStore.clear(); setPhase(LIFECYCLE.STOPPED); return this; } // stop before start
      if (phase === LIFECYCLE.FAILED) {
        httpServer.beginDrain();
        stagingSessionStore.clear();
        try { if (gateway) await gateway.stop(); } catch { /* */ }
        try { await processor.stop(); } catch { /* */ }
        try { await httpServer.stop(opts); } catch { /* */ }
        httpStarted = false;
        try { await persistence.stop(); } catch { /* */ }
        stagingSessionStore.clear();
        setPhase(LIFECYCLE.STOPPED);
        return this;
      }
      await doStop(opts);
      return this;
    },

    // ---- introspection (for tests + endpoints) ----
    getPhase() { return phase; },
    readiness,
    isStopRequested() { return stopRequested; },
    address() { return httpServer.address(); },
    inFlight() { return httpServer.inFlight(); },
    openSockets() { return httpServer.openSockets(); },
    // module handles (read-only access for tests)
    modules: Object.freeze({
      config, logger: log, featureFlags, persistence, gateway, processor, health, httpServer,
      pairingService, stagingApiService, stagingSessionStore, stagingUiRouter
    })
  };
}
