// P0 Step 5C.1 — Control Plane configuration loader (validated, typed, injected once).
//
// THE ONLY MODULE THAT READS THE ENVIRONMENT. `env` is injectable (defaults to
// process.env) so business modules never touch process.env and tests never mutate it.
// loadConfig() returns a frozen, typed config or throws ControlPlaneError(E_CONFIG_INVALID)
// with a list of SAFE issue descriptors (field names + reason codes, never values).
//
// Secrets are read for PRESENCE ONLY — the actual pepper/credential value is never stored
// in the config object, so it can never be printed by /internal/config-summary.

import { ControlPlaneError, CP_ERRORS } from "../errors.mjs";

const ENVIRONMENTS = ["development", "test", "staging", "production"];
const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];
const LOG_FORMATS = ["json"];
const TRUE_SET = new Set(["true", "1", "yes", "on"]);
const FALSE_SET = new Set(["false", "0", "no", "off"]);
// True loopback hosts rejected in production (unreachable / test defaults). NOTE: `0.0.0.0`
// (bind-all behind a reverse proxy) is intentionally NOT here — it is a valid production bind.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// Feature-flag prerequisite lattice (arch §24 / deployment §6 / spec-source-of-truth).
const FLAG_PREREQ = Object.freeze({
  controlPlaneEnabled: null,
  workerExecutionEnabled: "controlPlaneEnabled",
  projectWorkerAffinityEnabled: "controlPlaneEnabled",
  previewSyncEnabled: "controlPlaneEnabled",
  schedulerEnabled: "workerExecutionEnabled",
  realGrokWorkerEnabled: "workerExecutionEnabled"
});

class Issues {
  constructor() { this.list = []; }
  add(field, reason) { this.list.push({ field, reason }); }
  get any() { return this.list.length > 0; }
}

function boolOf(issues, env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const v = String(raw).trim().toLowerCase();
  if (TRUE_SET.has(v)) return true;
  if (FALSE_SET.has(v)) return false;
  issues.add(name, "MALFORMED_BOOLEAN");
  return def;
}

function intOf(issues, env, name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) { issues.add(name, "MALFORMED_INTEGER"); return def; }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) { issues.add(name, "OUT_OF_RANGE"); return def; }
  return n;
}

function enumOf(issues, env, name, allowed, def) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const v = String(raw).trim().toLowerCase();
  if (!allowed.includes(v)) { issues.add(name, "INVALID_ENUM"); return def; }
  return v;
}

function strOf(env, name, def = null) {
  const raw = env[name];
  return raw === undefined || raw === "" ? def : String(raw);
}

function presence(env, name) {
  const raw = env[name];
  return typeof raw === "string" && raw.trim().length > 0;
}

// loadConfig(env?, { mode? }) → frozen config. `mode` lets a caller force validation as if
// running in a given environment (used by the check-config command).
export function loadConfig(env = process.env, { requireProductionSafety = undefined } = {}) {
  const issues = new Issues();

  const environment = enumOf(issues, env, "CONTROL_PLANE_ENV", ENVIRONMENTS, "development");
  const isProd = (requireProductionSafety ?? environment === "production") === true;

  const server = {
    host: strOf(env, "CONTROL_PLANE_HOST", "127.0.0.1"),
    port: intOf(issues, env, "CONTROL_PLANE_PORT", 8787, { min: 0, max: 65535 }),
    environment,
    shutdownTimeoutMs: intOf(issues, env, "CONTROL_PLANE_SHUTDOWN_TIMEOUT_MS", 10000, { min: 0, max: 600000 }),
    requestTimeoutMs: intOf(issues, env, "CONTROL_PLANE_REQUEST_TIMEOUT_MS", 15000, { min: 100, max: 600000 }),
    maxRequestBytes: intOf(issues, env, "CONTROL_PLANE_MAX_REQUEST_BYTES", 262144, { min: 1024, max: 8388608 })
  };
  const hostExplicit = env.CONTROL_PLANE_HOST !== undefined && env.CONTROL_PLANE_HOST !== "";

  const logging = {
    level: enumOf(issues, env, "CONTROL_PLANE_LOG_LEVEL", LOG_LEVELS, isProd ? "info" : "info"),
    format: enumOf(issues, env, "CONTROL_PLANE_LOG_FORMAT", LOG_FORMATS, "json"),
    serviceName: strOf(env, "CONTROL_PLANE_SERVICE_NAME", "control-plane")
  };

  const database = {
    enabled: boolOf(issues, env, "CONTROL_PLANE_DB_ENABLED", false),
    // URLs are stored internally (needed to connect) but NEVER surfaced in summaries. The
    // MIGRATION url is intentionally NOT read here — migration credentials are command-only
    // (the CLI reads CONTROL_PLANE_DB_MIGRATION_URL directly), never in the running service.
    url: strOf(env, "CONTROL_PLANE_DB_URL", null),                  // cp_tenant_app
    opsUrl: strOf(env, "CONTROL_PLANE_DB_OPS_URL", null),           // cp_ops_enumerator
    observerUrl: strOf(env, "CONTROL_PLANE_DB_OBSERVER_URL", null), // cp_readonly_observer (optional)
    appRole: strOf(env, "CONTROL_PLANE_DB_APP_ROLE", "cp_tenant_app"),
    opsRole: strOf(env, "CONTROL_PLANE_DB_OPS_ROLE", "cp_ops_enumerator"),
    migrationRole: strOf(env, "CONTROL_PLANE_DB_MIGRATION_ROLE", "cp_migrator"),
    poolMax: intOf(issues, env, "CONTROL_PLANE_DB_POOL_MAX", 10, { min: 1, max: 1000 }),
    opsPoolMax: intOf(issues, env, "CONTROL_PLANE_DB_OPS_POOL_MAX", 4, { min: 1, max: 1000 }),
    ssl: boolOf(issues, env, "CONTROL_PLANE_DB_SSL", false),
    statementTimeoutMs: intOf(issues, env, "CONTROL_PLANE_DB_STATEMENT_TIMEOUT_MS", 10000, { min: 0, max: 600000 }),
    lockTimeoutMs: intOf(issues, env, "CONTROL_PLANE_DB_LOCK_TIMEOUT_MS", 5000, { min: 0, max: 600000 }),
    idleInTransactionTimeoutMs: intOf(issues, env, "CONTROL_PLANE_DB_IDLE_IN_TXN_TIMEOUT_MS", 15000, { min: 0, max: 600000 })
  };

  // Worker WebSocket Gateway (P0 Step 5C.4). OFF by default. When enabled it requires PostgreSQL,
  // the processor, and a credential pepper (gated below). It executes NO providers.
  const workerGateway = {
    enabled: boolOf(issues, env, "CONTROL_PLANE_GATEWAY_ENABLED", false),
    // P0 Step 5C.28: transport-only mode — auth + connect + heartbeat + registry with NO delivery adapter and
    // NO inbound job processing, so the gateway runs WITHOUT the background processor (no second job-owner).
    transportOnly: boolOf(issues, env, "CONTROL_PLANE_GATEWAY_TRANSPORT_ONLY", false),
    path: strOf(env, "CONTROL_PLANE_GATEWAY_PATH", "/ws/worker"),
    gatewayInstanceId: strOf(env, "CONTROL_PLANE_GATEWAY_INSTANCE_ID", null),   // defaults to deployment.instanceId
    helloTimeoutMs: intOf(issues, env, "CONTROL_PLANE_GATEWAY_HELLO_TIMEOUT_MS", 10000, { min: 100, max: 120000 }),
    maxFrameBytes: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_FRAME_BYTES", 1048576, { min: 1024, max: 16777216 }),
    maxPayloadBytes: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_PAYLOAD_BYTES", 2097152, { min: 1024, max: 16777216 }),
    maxJsonDepth: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_JSON_DEPTH", 24, { min: 2, max: 128 }),
    maxArrayItems: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_ARRAY_ITEMS", 4096, { min: 1, max: 65536 }),
    maxObjectKeys: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_OBJECT_KEYS", 256, { min: 1, max: 4096 }),
    maxMessagesPerWindow: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_MESSAGES_PER_WINDOW", 240, { min: 1, max: 100000 }),
    rateLimitWindowMs: intOf(issues, env, "CONTROL_PLANE_GATEWAY_RATE_LIMIT_WINDOW_MS", 10000, { min: 100, max: 600000 }),
    maxPreAuthPerWindow: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_PREAUTH_PER_WINDOW", 30, { min: 1, max: 100000 }),
    maxPendingInboundMessages: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_PENDING_INBOUND", 64, { min: 1, max: 100000 }),
    maxConcurrentInboundPerConnection: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_CONCURRENT_INBOUND", 1, { min: 1, max: 64 }),
    maxBufferedAmountBytes: intOf(issues, env, "CONTROL_PLANE_GATEWAY_MAX_BUFFERED_BYTES", 4194304, { min: 1024, max: 67108864 }),
    deliveryWriteTimeoutMs: intOf(issues, env, "CONTROL_PLANE_GATEWAY_DELIVERY_WRITE_TIMEOUT_MS", 10000, { min: 100, max: 120000 }),
    heartbeatIntervalMs: intOf(issues, env, "CONTROL_PLANE_GATEWAY_HEARTBEAT_MS", 20000, { min: 1000, max: 120000 }),
    degradedAfterMs: intOf(issues, env, "CONTROL_PLANE_GATEWAY_DEGRADED_MS", 45000, { min: 1000, max: 600000 }),
    offlineAfterMs: intOf(issues, env, "CONTROL_PLANE_GATEWAY_OFFLINE_MS", 90000, { min: 1000, max: 600000 }),
    sessionLeaseMs: intOf(issues, env, "CONTROL_PLANE_GATEWAY_SESSION_LEASE_MS", 120000, { min: 1000, max: 3600000 }),
    resumeTokenTtlMs: intOf(issues, env, "CONTROL_PLANE_GATEWAY_RESUME_TOKEN_TTL_MS", 120000, { min: 1000, max: 3600000 }),
    allowedProtocolVersions: (strOf(env, "CONTROL_PLANE_GATEWAY_ALLOWED_PROTOCOL_VERSIONS", "1") || "1")
      .split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
  };

  // Background Processor (P0 Step 5C.3). ALL execution OFF by default. Delivery cannot enable
  // without the processor AND the database (a real WSS delivery adapter is Step 5C.4).
  const processor = {
    enabled: boolOf(issues, env, "CONTROL_PLANE_PROCESSOR_ENABLED", false),
    deliveryEnabled: boolOf(issues, env, "CONTROL_PLANE_PROCESSOR_DELIVERY_ENABLED", false),
    instanceId: strOf(env, "CONTROL_PLANE_PROCESSOR_INSTANCE_ID", null),   // defaults to deployment.instanceId
    pollIntervalMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_POLL_INTERVAL_MS", 1000, { min: 0, max: 3600000 }),
    batchSize: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_BATCH_SIZE", 50, { min: 1, max: 4096 }),
    claimLeaseMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_CLAIM_LEASE_MS", 30000, { min: 1000, max: 3600000 }),
    deliveryTimeoutMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_DELIVERY_TIMEOUT_MS", 10000, { min: 100, max: 600000 }),
    settlementTimeoutMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_SETTLEMENT_TIMEOUT_MS", 30000, { min: 1000, max: 3600000 }),
    reconcileTimeoutMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_RECONCILE_TIMEOUT_MS", 60000, { min: 1000, max: 3600000 }),
    maxAttempts: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_MAX_ATTEMPTS", 5, { min: 1, max: 100 }),
    initialBackoffMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_INITIAL_BACKOFF_MS", 1000, { min: 0, max: 600000 }),
    maxBackoffMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_MAX_BACKOFF_MS", 60000, { min: 0, max: 3600000 }),
    skewMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_SKEW_MS", 120000, { min: 1000, max: 3600000 }),
    offerExpirySweepEnabled: boolOf(issues, env, "CONTROL_PLANE_PROCESSOR_OFFER_EXPIRY_SWEEP_ENABLED", false),
    reconciliationSweepEnabled: boolOf(issues, env, "CONTROL_PLANE_PROCESSOR_RECONCILIATION_SWEEP_ENABLED", false),
    retentionSweepEnabled: boolOf(issues, env, "CONTROL_PLANE_PROCESSOR_RETENTION_SWEEP_ENABLED", false),
    retentionBatchSize: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_RETENTION_BATCH_SIZE", 50, { min: 1, max: 4096 }),
    retentionMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_RETENTION_MS", 604800000, { min: 0, max: 31536000000 }),
    deadLetterRetentionMs: intOf(issues, env, "CONTROL_PLANE_PROCESSOR_DEAD_LETTER_RETENTION_MS", 2592000000, { min: 0, max: 31536000000 })
  };

  // Worker pairing + credential lifecycle (P0 Step 5C.5). OFF by default. When enabled it requires
  // PostgreSQL + BOTH peppers (pairing + credential). The operator API is a separate gate and the
  // staging service-token adapter is FORBIDDEN in production (gated below). Executes NO providers.
  const pairing = {
    enabled: boolOf(issues, env, "CONTROL_PLANE_PAIRING_ENABLED", false),
    claimPath: strOf(env, "CONTROL_PLANE_PAIRING_CLAIM_PATH", "/worker/pair"),
    operatorApiEnabled: boolOf(issues, env, "CONTROL_PLANE_PAIRING_OPERATOR_API_ENABLED", false),
    stagingOperatorAuthEnabled: boolOf(issues, env, "CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED", false),
    operatorActorId: strOf(env, "CONTROL_PLANE_PAIRING_OPERATOR_ACTOR_ID", "operator:staging"),
    codeTtlMs: intOf(issues, env, "CONTROL_PLANE_PAIRING_CODE_TTL_MS", 900000, { min: 60000, max: 86400000 }),
    maxCodeTtlMs: intOf(issues, env, "CONTROL_PLANE_PAIRING_MAX_CODE_TTL_MS", 86400000, { min: 60000, max: 604800000 }),
    maxActiveCodesPerWorkspace: intOf(issues, env, "CONTROL_PLANE_PAIRING_MAX_ACTIVE_CODES", 50, { min: 1, max: 100000 }),
    maxFailedAttempts: intOf(issues, env, "CONTROL_PLANE_PAIRING_MAX_FAILED_ATTEMPTS", 5, { min: 1, max: 20 }),
    rateLimitWindowMs: intOf(issues, env, "CONTROL_PLANE_PAIRING_RATE_LIMIT_WINDOW_MS", 60000, { min: 1000, max: 3600000 }),
    maxIssuePerWindow: intOf(issues, env, "CONTROL_PLANE_PAIRING_MAX_ISSUE_PER_WINDOW", 30, { min: 1, max: 100000 }),
    maxClaimsPerWindow: intOf(issues, env, "CONTROL_PLANE_PAIRING_MAX_CLAIMS_PER_WINDOW", 20, { min: 1, max: 100000 }),
    credentialTtlMs: intOf(issues, env, "CONTROL_PLANE_PAIRING_CREDENTIAL_TTL_MS", 2592000000, { min: 3600000, max: 31536000000 }),
    // Secret VALUES retained ONLY for the verifiers — DELIBERATELY excluded from safeConfigSummary
    // and never logged. `operatorToken` is the staging break-glass service token.
    pairingPepper: strOf(env, "CONTROL_PLANE_PAIRING_PEPPER", null),
    operatorToken: strOf(env, "CONTROL_PLANE_PAIRING_OPERATOR_TOKEN", null)
  };

  // Staging Project/Generation/Job/Result API (P0 Step 5C.6). OFF by default. Reuses the pairing
  // staging operator token for auth; the workspace is resolved from config (NEVER a request body).
  // Enabling it does NOT enable the Gateway/Processor/Pairing/paid execution. FAKE jobs only in 5C.6.
  const stagingApi = {
    enabled: boolOf(issues, env, "CONTROL_PLANE_STAGING_API_ENABLED", false),
    workspaceId: strOf(env, "CONTROL_PLANE_STAGING_API_WORKSPACE_ID", null),
    maxBodyBytes: intOf(issues, env, "CONTROL_PLANE_STAGING_API_MAX_BODY_BYTES", 65536, { min: 1024, max: 1048576 }),
    defaultPageSize: intOf(issues, env, "CONTROL_PLANE_STAGING_API_DEFAULT_PAGE_SIZE", 25, { min: 1, max: 200 }),
    maxPageSize: intOf(issues, env, "CONTROL_PLANE_STAGING_API_MAX_PAGE_SIZE", 100, { min: 1, max: 500 }),
    maxPromptLength: intOf(issues, env, "CONTROL_PLANE_STAGING_API_MAX_PROMPT_LENGTH", 2000, { min: 1, max: 20000 }),
    allowedDurations: (strOf(env, "CONTROL_PLANE_STAGING_API_ALLOWED_DURATIONS", "5,10,15") || "5,10,15")
      .split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
    allowedAspectRatios: (strOf(env, "CONTROL_PLANE_STAGING_API_ALLOWED_ASPECT_RATIOS", "16:9,9:16,1:1") || "16:9,9:16,1:1")
      .split(",").map((s) => s.trim()).filter(Boolean),
    allowedOutputFormats: (strOf(env, "CONTROL_PLANE_STAGING_API_ALLOWED_OUTPUT_FORMATS", "mp4") || "mp4")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    maxOutputCount: intOf(issues, env, "CONTROL_PLANE_STAGING_API_MAX_OUTPUT_COUNT", 1, { min: 1, max: 4 }),
    dispatchOnCreate: boolOf(issues, env, "CONTROL_PLANE_STAGING_API_DISPATCH_ON_CREATE", false),
    allowFakeJobsOnly: boolOf(issues, env, "CONTROL_PLANE_STAGING_API_ALLOW_FAKE_JOBS_ONLY", true),
    // The canonical Worker action used for FAKE staging jobs (no provider executes it in 5C.6).
    fakeAction: strOf(env, "CONTROL_PLANE_STAGING_API_FAKE_ACTION", "GENERATE_GROK_VIDEO")
  };

  // Creator-focused staging Studio (P0 Step 5C.7). This process-local browser-session adapter is
  // OFF by default, requires the staging API, and is never valid in production. Pairing remains an
  // independent capability: existing Worker projections and affinity continue to work without it.
  const stagingUi = {
    enabled: boolOf(issues, env, "CONTROL_PLANE_STAGING_UI_ENABLED", false),
    sessionTtlMs: intOf(issues, env, "CONTROL_PLANE_STAGING_UI_SESSION_TTL_MS", 1800000, { min: 60000, max: 86400000 }),
    maxSessions: intOf(issues, env, "CONTROL_PLANE_STAGING_UI_MAX_SESSIONS", 64, { min: 1, max: 10000 }),
    maxBodyBytes: intOf(issues, env, "CONTROL_PLANE_STAGING_UI_MAX_BODY_BYTES", 65536, { min: 1024, max: 1048576 }),
    // Safe, non-secret browser bootstrap metadata. It is deliberately limited to an exact
    // numeric-loopback HTTP origin and is used only by the local Providers surface.
    providerLocalOrigin: strOf(env, "CONTROL_PLANE_PROVIDER_LOCAL_ORIGIN", null)
  };

  // P0 Step 5C.23 — native-auth deployment flags. ALL default OFF: production keeps Cloudflare Access as the
  // only gate; the native login/security UI, JSON routes, session enforcement, and the one-time owner
  // bootstrap turn on only in a local/test harness or a future owner-gated cutover.
  const nativeAuth = {
    uiEnabled: boolOf(issues, env, "CONTROL_PLANE_NATIVE_AUTH_UI_ENABLED", false),
    routesEnabled: boolOf(issues, env, "CONTROL_PLANE_NATIVE_AUTH_ROUTES_ENABLED", false),
    enforcementEnabled: boolOf(issues, env, "CONTROL_PLANE_NATIVE_AUTH_ENFORCEMENT_ENABLED", false),
    bootstrapEnabled: boolOf(issues, env, "CONTROL_PLANE_NATIVE_AUTH_BOOTSTRAP_ENABLED", false),
    cloudflareCutoverConfirmed: boolOf(issues, env, "CONTROL_PLANE_NATIVE_AUTH_CUTOVER_CONFIRMED", false),
    // P0 Step 5C.29 — the PLATFORM plane (Boss Manager + multi-tenant per-request workspace). Default OFF:
    // with it off the /api/platform/* surface is not mounted (404 for everyone), the PDP keeps the historical
    // single-tenant data-workspace target, and the tenant quota guard is inert — i.e. byte-identical to the
    // pre-5C.29 runtime. Turning it on is an explicit, config-sourced operator decision.
    platformEnabled: boolOf(issues, env, "CONTROL_PLANE_NATIVE_AUTH_PLATFORM_ENABLED", false),
    // __Host- session/csrf cookies require Secure; production is HTTPS-fronted (studio.example.com). Only a
    // loopback http test transport relaxes this.
    cookieSecure: boolOf(issues, env, "CONTROL_PLANE_NATIVE_AUTH_COOKIE_SECURE", true)
  };

  const featureFlags = {
    controlPlaneEnabled: boolOf(issues, env, "CONTROL_PLANE_FLAG_CONTROL_PLANE_ENABLED", false),
    workerExecutionEnabled: boolOf(issues, env, "CONTROL_PLANE_FLAG_WORKER_EXECUTION_ENABLED", false),
    projectWorkerAffinityEnabled: boolOf(issues, env, "CONTROL_PLANE_FLAG_PROJECT_WORKER_AFFINITY_ENABLED", false),
    schedulerEnabled: boolOf(issues, env, "CONTROL_PLANE_FLAG_SCHEDULER_ENABLED", false),
    realGrokWorkerEnabled: boolOf(issues, env, "CONTROL_PLANE_FLAG_REAL_GROK_WORKER_ENABLED", false),
    previewSyncEnabled: boolOf(issues, env, "CONTROL_PLANE_FLAG_PREVIEW_SYNC_ENABLED", false)
  };

  const security = {
    trustProxy: boolOf(issues, env, "CONTROL_PLANE_TRUST_PROXY", false),
    allowedOrigins: (strOf(env, "CONTROL_PLANE_ALLOWED_ORIGINS", "") || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    // PRESENCE ONLY for pairing/internal secrets — values never stored here.
    credentialPepperConfigured: presence(env, "CONTROL_PLANE_CREDENTIAL_PEPPER"),
    pairingPepperConfigured: presence(env, "CONTROL_PLANE_PAIRING_PEPPER"),
    internalServiceAuthConfigured: presence(env, "CONTROL_PLANE_INTERNAL_SERVICE_AUTH"),
    // The credential pepper VALUE is retained ONLY so the Gateway can verify Worker credentials
    // (HMAC verifier). It is DELIBERATELY excluded from safeConfigSummary and never logged.
    credentialPepper: strOf(env, "CONTROL_PLANE_CREDENTIAL_PEPPER", null),
    // P0 Step 5C.24: 32-byte base64 AES key that seals native-auth TOTP secrets / recovery codes / one-time
    // link tokens. It MUST be stable across restarts (a fresh key makes every stored MFA/enrollment/
    // invitation undecryptable → owner lockout). Provisioned owner-side (minted once, ACL/DPAPI-protected);
    // the VALUE is excluded from safeConfigSummary and never logged.
    authSecretBoxKeyConfigured: presence(env, "CONTROL_PLANE_AUTH_SECRETBOX_KEY"),
    authSecretBoxKey: strOf(env, "CONTROL_PLANE_AUTH_SECRETBOX_KEY", null)
  };

  const deployment = {
    instanceId: strOf(env, "CONTROL_PLANE_INSTANCE_ID", "cp-local-1"),
    version: strOf(env, "CONTROL_PLANE_VERSION", "0.0.0-skeleton"),
    commitSha: strOf(env, "CONTROL_PLANE_COMMIT_SHA", null),
    region: strOf(env, "CONTROL_PLANE_REGION", "local")
  };

  // ---- feature-flag dependency lattice ----
  for (const [flag, prereq] of Object.entries(FLAG_PREREQ)) {
    if (featureFlags[flag] === true && prereq && featureFlags[prereq] !== true) {
      issues.add(`featureFlags.${flag}`, "PREREQUISITE_DISABLED");
    }
  }

  // ---- production-safety gates (reject unsafe loopback/test defaults) ----
  if (isProd) {
    if (!hostExplicit || LOOPBACK_HOSTS.has(server.host)) issues.add("CONTROL_PLANE_HOST", "LOOPBACK_IN_PRODUCTION");
    if (database.enabled && !database.url) issues.add("CONTROL_PLANE_DB_URL", "REQUIRED_WHEN_DB_ENABLED");
    if (!security.credentialPepperConfigured) issues.add("CONTROL_PLANE_CREDENTIAL_PEPPER", "REQUIRED_IN_PRODUCTION");
    if (!security.pairingPepperConfigured) issues.add("CONTROL_PLANE_PAIRING_PEPPER", "REQUIRED_IN_PRODUCTION");
    if (deployment.commitSha === null) issues.add("CONTROL_PLANE_COMMIT_SHA", "REQUIRED_IN_PRODUCTION");
    if (server.environment === "production" && featureFlags.controlPlaneEnabled && security.allowedOrigins.length === 0) {
      issues.add("CONTROL_PLANE_ALLOWED_ORIGINS", "REQUIRED_WHEN_ENABLED_IN_PRODUCTION");
    }
  }

  // Coherence: DB enabled requires a URL even outside production (can't connect otherwise).
  if (database.enabled && !database.url) {
    if (!issues.list.some((i) => i.field === "CONTROL_PLANE_DB_URL")) issues.add("CONTROL_PLANE_DB_URL", "REQUIRED_WHEN_DB_ENABLED");
  }

  // ---- native-auth activation gates (fail startup if turned on without its prerequisites) ----
  // Turning native routes/UI/enforcement on REQUIRES: a stable secret-box key (else stored MFA is
  // undecryptable) and an exact Origin allowlist (else CSRF/Origin defence is void). The DB must be enabled.
  if (nativeAuth.routesEnabled || nativeAuth.uiEnabled || nativeAuth.enforcementEnabled || nativeAuth.bootstrapEnabled) {
    if (!database.enabled) issues.add("CONTROL_PLANE_DB_ENABLED", "REQUIRED_FOR_NATIVE_AUTH");
    if (!security.authSecretBoxKeyConfigured) issues.add("CONTROL_PLANE_AUTH_SECRETBOX_KEY", "REQUIRED_FOR_NATIVE_AUTH");
    if (security.allowedOrigins.length === 0) issues.add("CONTROL_PLANE_ALLOWED_ORIGINS", "REQUIRED_FOR_NATIVE_AUTH");
  }
  // The bootstrap route may only open when the ceremony transport is also on and no cutover is claimed yet.
  if (nativeAuth.bootstrapEnabled && !nativeAuth.routesEnabled) issues.add("CONTROL_PLANE_NATIVE_AUTH_BOOTSTRAP_ENABLED", "REQUIRES_ROUTES_ENABLED");

  // ---- processor safety gates (unsafe combinations fail startup) ----
  if (processor.enabled && !database.enabled) issues.add("CONTROL_PLANE_PROCESSOR_ENABLED", "REQUIRES_DATABASE");
  if (processor.deliveryEnabled && !processor.enabled) issues.add("CONTROL_PLANE_PROCESSOR_DELIVERY_ENABLED", "REQUIRES_PROCESSOR");
  if (processor.deliveryEnabled && !database.enabled) issues.add("CONTROL_PLANE_PROCESSOR_DELIVERY_ENABLED", "REQUIRES_DATABASE");
  if (!processor.enabled && (processor.offerExpirySweepEnabled || processor.reconciliationSweepEnabled || processor.retentionSweepEnabled)) {
    issues.add("CONTROL_PLANE_PROCESSOR_ENABLED", "SWEEP_REQUIRES_PROCESSOR");
  }
  if (processor.maxBackoffMs < processor.initialBackoffMs) issues.add("CONTROL_PLANE_PROCESSOR_MAX_BACKOFF_MS", "LESS_THAN_INITIAL_BACKOFF");

  // ---- worker gateway safety gates (Step 5C.4) ----
  if (workerGateway.enabled) {
    if (!database.enabled) issues.add("CONTROL_PLANE_GATEWAY_ENABLED", "REQUIRES_DATABASE");
    // The processor is required ONLY in full (job-delivery) mode. TRANSPORT-ONLY runs without it (no second
    // job-owner); it still needs the database + credential pepper below.
    if (!processor.enabled && !workerGateway.transportOnly) issues.add("CONTROL_PLANE_GATEWAY_ENABLED", "REQUIRES_PROCESSOR");
    if (!security.credentialPepperConfigured) issues.add("CONTROL_PLANE_CREDENTIAL_PEPPER", "REQUIRED_WHEN_GATEWAY_ENABLED");
    if (workerGateway.allowedProtocolVersions.length === 0) issues.add("CONTROL_PLANE_GATEWAY_ALLOWED_PROTOCOL_VERSIONS", "EMPTY");
    if (workerGateway.offlineAfterMs <= workerGateway.degradedAfterMs) issues.add("CONTROL_PLANE_GATEWAY_OFFLINE_MS", "MUST_EXCEED_DEGRADED");
    // Production must not bind publicly without an explicit trusted TLS-termination config, and
    // must not accept wildcard origins.
    if (isProd) {
      if (!security.trustProxy && !LOOPBACK_HOSTS.has(server.host)) issues.add("CONTROL_PLANE_GATEWAY_ENABLED", "REQUIRES_TRUSTED_TLS_TERMINATION");
      if ((security.allowedOrigins || []).includes("*")) issues.add("CONTROL_PLANE_ALLOWED_ORIGINS", "WILDCARD_FORBIDDEN_IN_PRODUCTION");
    }
  }

  // ---- worker pairing safety gates (Step 5C.5) ----
  if (pairing.enabled) {
    if (!database.enabled) issues.add("CONTROL_PLANE_PAIRING_ENABLED", "REQUIRES_DATABASE");
    // Both peppers are mandatory when pairing is enabled: pairing pepper mints/verifies codes,
    // credential pepper mints Worker credentials. Missing either FAILS startup (never a bypass).
    if (!security.pairingPepperConfigured) issues.add("CONTROL_PLANE_PAIRING_PEPPER", "REQUIRED_WHEN_PAIRING_ENABLED");
    if (!security.credentialPepperConfigured) issues.add("CONTROL_PLANE_CREDENTIAL_PEPPER", "REQUIRED_WHEN_PAIRING_ENABLED");
    if (pairing.maxCodeTtlMs < pairing.codeTtlMs) issues.add("CONTROL_PLANE_PAIRING_MAX_CODE_TTL_MS", "LESS_THAN_DEFAULT_TTL");
  }
  // Operator API gating (independent of the claim surface).
  if (pairing.operatorApiEnabled) {
    if (!pairing.enabled) issues.add("CONTROL_PLANE_PAIRING_OPERATOR_API_ENABLED", "REQUIRES_PAIRING_ENABLED");
    // The ONLY operator auth adapter implemented in 5C.5 is the staging service token. It must be
    // explicitly enabled and carry a token — and it is FORBIDDEN in production.
    if (!pairing.stagingOperatorAuthEnabled) issues.add("CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED", "REQUIRED_FOR_OPERATOR_API");
    if (pairing.stagingOperatorAuthEnabled && (typeof pairing.operatorToken !== "string" || pairing.operatorToken.trim().length < 16)) {
      issues.add("CONTROL_PLANE_PAIRING_OPERATOR_TOKEN", "REQUIRED_MIN_16_CHARS");
    }
  }
  // Staging operator token is a break-glass adapter — never permitted in a production environment.
  if (isProd && pairing.stagingOperatorAuthEnabled) issues.add("CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED", "FORBIDDEN_IN_PRODUCTION");

  // ---- staging API safety gates (Step 5C.6) ----
  if (stagingApi.enabled) {
    if (!database.enabled) issues.add("CONTROL_PLANE_STAGING_API_ENABLED", "REQUIRES_DATABASE");
    // The workspace is resolved from config (never a request body); it must be a valid ws_ id.
    if (typeof stagingApi.workspaceId !== "string" || !/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(stagingApi.workspaceId)) {
      issues.add("CONTROL_PLANE_STAGING_API_WORKSPACE_ID", "REQUIRED_VALID_WS_ID");
    }
    // Auth reuses the pairing staging operator token — it must be enabled + present (>=16 chars).
    if (!pairing.stagingOperatorAuthEnabled) issues.add("CONTROL_PLANE_PAIRING_STAGING_OPERATOR_AUTH_ENABLED", "REQUIRED_FOR_STAGING_API");
    if (typeof pairing.operatorToken !== "string" || pairing.operatorToken.trim().length < 16) issues.add("CONTROL_PLANE_PAIRING_OPERATOR_TOKEN", "REQUIRED_MIN_16_CHARS");
    // 5C.6 supports ONLY fake staging jobs — no real provider dispatch.
    if (!stagingApi.allowFakeJobsOnly) issues.add("CONTROL_PLANE_STAGING_API_ALLOW_FAKE_JOBS_ONLY", "MUST_BE_TRUE_IN_STEP_5C6");
    if (stagingApi.maxPageSize < stagingApi.defaultPageSize) issues.add("CONTROL_PLANE_STAGING_API_MAX_PAGE_SIZE", "LESS_THAN_DEFAULT");
    if (stagingApi.allowedDurations.length === 0) issues.add("CONTROL_PLANE_STAGING_API_ALLOWED_DURATIONS", "EMPTY");
    if (stagingApi.allowedAspectRatios.length === 0) issues.add("CONTROL_PLANE_STAGING_API_ALLOWED_ASPECT_RATIOS", "EMPTY");
  }
  // The staging API is a staging-only surface — never permitted in a production environment.
  if (isProd && stagingApi.enabled) issues.add("CONTROL_PLANE_STAGING_API_ENABLED", "FORBIDDEN_IN_PRODUCTION");

  // The temporary browser-session surface depends on the staging API and its configured workspace,
  // but deliberately does not depend on pairing-code issuance.
  if (stagingUi.enabled) {
    if (!stagingApi.enabled) issues.add("CONTROL_PLANE_STAGING_UI_ENABLED", "REQUIRES_STAGING_API");
    if (typeof stagingApi.workspaceId !== "string" || !/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(stagingApi.workspaceId)) {
      issues.add("CONTROL_PLANE_STAGING_API_WORKSPACE_ID", "REQUIRED_VALID_WS_ID_FOR_STAGING_UI");
    }
    if (stagingUi.maxBodyBytes > server.maxRequestBytes) {
      issues.add("CONTROL_PLANE_STAGING_UI_MAX_BODY_BYTES", "EXCEEDS_SERVER_MAX_REQUEST_BYTES");
    }
    if (stagingUi.maxBodyBytes > stagingApi.maxBodyBytes) {
      issues.add("CONTROL_PLANE_STAGING_UI_MAX_BODY_BYTES", "EXCEEDS_STAGING_API_MAX_BODY_BYTES");
    }
    if (stagingUi.providerLocalOrigin !== null) {
      try {
        const local = new URL(stagingUi.providerLocalOrigin);
        if (local.protocol !== "http:" || local.hostname !== "127.0.0.1" ||
            local.username || local.password || local.pathname !== "/" || local.search || local.hash ||
            !Number.isInteger(Number(local.port)) || Number(local.port) < 1 || Number(local.port) > 65535 ||
            local.origin !== stagingUi.providerLocalOrigin) {
          issues.add("CONTROL_PLANE_PROVIDER_LOCAL_ORIGIN", "REQUIRED_NUMERIC_LOOPBACK_ORIGIN");
        }
      } catch {
        issues.add("CONTROL_PLANE_PROVIDER_LOCAL_ORIGIN", "REQUIRED_NUMERIC_LOOPBACK_ORIGIN");
      }
    }
  }
  if (isProd && stagingUi.enabled) issues.add("CONTROL_PLANE_STAGING_UI_ENABLED", "FORBIDDEN_IN_PRODUCTION");

  if (issues.any) {
    throw new ControlPlaneError(CP_ERRORS.E_CONFIG_INVALID, "Invalid Control Plane configuration", { issues: issues.list });
  }

  return Object.freeze({
    server: Object.freeze(server),
    logging: Object.freeze(logging),
    database: Object.freeze(database),
    workerGateway: Object.freeze(workerGateway),
    processor: Object.freeze(processor),
    pairing: Object.freeze(pairing),
    stagingApi: Object.freeze(stagingApi),
    stagingUi: Object.freeze(stagingUi),
    nativeAuth: Object.freeze(nativeAuth),
    featureFlags: Object.freeze(featureFlags),
    security: Object.freeze(security),
    deployment: Object.freeze(deployment),
    // convenience predicates
    isProduction: environment === "production",
    isDevOrTest: environment === "development" || environment === "test",
    isTest: environment === "test"
  });
}

// safeConfigSummary(config): an ALLOWLIST of non-secret metadata for /internal/config-summary.
// Never includes: env values, database.url, peppers, credentials, paths, origins verbatim.
export function safeConfigSummary(config) {
  return {
    service: config.logging.serviceName,
    environment: config.server.environment,
    host: config.server.host,
    port: config.server.port,
    instanceId: config.deployment.instanceId,
    version: config.deployment.version,
    commitConfigured: config.deployment.commitSha !== null,
    region: config.deployment.region,
    logging: { level: config.logging.level, format: config.logging.format },
    database: {
      enabled: config.database.enabled,
      urlConfigured: config.database.url !== null,          // boolean only — never the URL
      opsUrlConfigured: config.database.opsUrl !== null,
      observerUrlConfigured: config.database.observerUrl !== null,
      ssl: config.database.ssl,
      appRole: config.database.appRole,
      opsRole: config.database.opsRole,
      migrationRole: config.database.migrationRole,
      poolMax: config.database.poolMax,
      opsPoolMax: config.database.opsPoolMax
    },
    workerGateway: {
      enabled: config.workerGateway.enabled,
      path: config.workerGateway.path,
      gatewayInstanceId: config.workerGateway.gatewayInstanceId || config.deployment.instanceId,
      maxFrameBytes: config.workerGateway.maxFrameBytes,
      helloTimeoutMs: config.workerGateway.helloTimeoutMs,
      heartbeatIntervalMs: config.workerGateway.heartbeatIntervalMs,
      offlineAfterMs: config.workerGateway.offlineAfterMs,
      maxMessagesPerWindow: config.workerGateway.maxMessagesPerWindow,
      maxPendingInboundMessages: config.workerGateway.maxPendingInboundMessages,
      allowedProtocolVersions: config.workerGateway.allowedProtocolVersions
    },
    processor: {
      enabled: config.processor.enabled,
      deliveryEnabled: config.processor.deliveryEnabled,
      pollIntervalMs: config.processor.pollIntervalMs,
      batchSize: config.processor.batchSize,
      claimLeaseMs: config.processor.claimLeaseMs,
      settlementTimeoutMs: config.processor.settlementTimeoutMs,
      maxAttempts: config.processor.maxAttempts,
      offerExpirySweepEnabled: config.processor.offerExpirySweepEnabled,
      reconciliationSweepEnabled: config.processor.reconciliationSweepEnabled,
      retentionSweepEnabled: config.processor.retentionSweepEnabled
    },
    pairing: {
      // Booleans + non-secret knobs ONLY. NEVER the pairing pepper or operator token.
      enabled: config.pairing.enabled,
      claimPath: config.pairing.claimPath,
      operatorApiEnabled: config.pairing.operatorApiEnabled,
      stagingOperatorAuthEnabled: config.pairing.stagingOperatorAuthEnabled,
      operatorTokenConfigured: typeof config.pairing.operatorToken === "string" && config.pairing.operatorToken.length > 0,
      codeTtlMs: config.pairing.codeTtlMs,
      maxActiveCodesPerWorkspace: config.pairing.maxActiveCodesPerWorkspace,
      maxFailedAttempts: config.pairing.maxFailedAttempts,
      maxClaimsPerWindow: config.pairing.maxClaimsPerWindow,
      credentialTtlMs: config.pairing.credentialTtlMs
    },
    stagingApi: {
      // Booleans + non-secret knobs ONLY. The workspace id is a non-secret binding but surfaced as
      // a boolean to keep the summary free of environment-specific identifiers.
      enabled: config.stagingApi.enabled,
      workspaceConfigured: typeof config.stagingApi.workspaceId === "string" && config.stagingApi.workspaceId.length > 0,
      maxBodyBytes: config.stagingApi.maxBodyBytes,
      defaultPageSize: config.stagingApi.defaultPageSize,
      maxPageSize: config.stagingApi.maxPageSize,
      maxPromptLength: config.stagingApi.maxPromptLength,
      allowedDurations: config.stagingApi.allowedDurations,
      allowedAspectRatios: config.stagingApi.allowedAspectRatios,
      allowedOutputFormats: config.stagingApi.allowedOutputFormats,
      maxOutputCount: config.stagingApi.maxOutputCount,
      dispatchOnCreate: config.stagingApi.dispatchOnCreate,
      allowFakeJobsOnly: config.stagingApi.allowFakeJobsOnly
    },
    stagingUi: {
      enabled: config.stagingUi.enabled,
      sessionTtlMs: config.stagingUi.sessionTtlMs,
      maxSessions: config.stagingUi.maxSessions,
      maxBodyBytes: config.stagingUi.maxBodyBytes,
      pairingAvailable: Boolean(config.pairing.enabled && config.pairing.operatorApiEnabled),
      providerLocalOriginConfigured: typeof config.stagingUi.providerLocalOrigin === "string"
    },
    nativeAuth: { ...(config.nativeAuth || {}) },
    featureFlags: { ...config.featureFlags },
    security: {
      trustProxy: config.security.trustProxy,
      allowedOriginCount: config.security.allowedOrigins.length, // count, not values
      credentialPepperConfigured: config.security.credentialPepperConfigured,
      pairingPepperConfigured: config.security.pairingPepperConfigured,
      internalServiceAuthConfigured: config.security.internalServiceAuthConfigured
    }
  };
}

export { FLAG_PREREQ };
