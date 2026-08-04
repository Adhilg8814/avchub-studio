// P0 Step 5C.12 — production configuration (dev / test / production modes).
//
// One JSON config file OUTSIDE the repository (default: <ownerRoot>\production\production.config.json)
// drives the operational commands. This module loads + validates it FAIL-FAST with operator-readable
// issues. Credentials/proxy/token values are FORBIDDEN in the config (they live only in the DPAPI
// stores); any secret-looking key or value fails validation. Nothing here logs or returns secrets.

import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { statfsSync } from "node:fs";
import path from "node:path";
import { parseExecutionPaused } from "../protocol/generation-execution-gate.mjs";
import { defaultStudioHome } from "../paths.mjs";

export const CONFIG_MODES = Object.freeze(["dev", "test", "production"]);
const SECRET_KEY_RE = /(password|passwd|secret|token|cookie|credential|apikey|api_key|bearer|authorization)/i;
const SECRET_VALUE_RE = /((https?|socks5?):\/\/[^\s/@]+:[^\s/@]+@|BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{16,})/;

function issue(level, code, message) { return Object.freeze({ level, code, message }); }

export function defaultConfigPath(ownerRoot = process.env.AVC_STUDIO_HOME || defaultStudioHome()) {
  return path.join(ownerRoot, "production", "production.config.json");
}

// The committed example contains ONLY placeholders — never real hosts/credentials/proxies.
export const EXAMPLE_CONFIG = Object.freeze({
  mode: "production",
  repositoryRoot: "<path to this repository>",
  ownerRoot: "<writable data directory outside the repository>",
  runtime: { expectedBranch: "p0/step5c12-production-rc", requireCleanWorktree: true },
  postgres: { binariesDir: "" },
  provider: { realEnabled: true, cloakExecutable: "UNKNOWN" },
  cloak: {
    enabled: false,
    installRoot: "REPLACE_WITH_CLOAK_INSTALL_ROOT",
    executablePath: "REPLACE_WITH_EXACT_CHROME_EXE_PATH",
    licenseFilePath: "REPLACE_WITH_LICENSE_FILE_PATH",
    expectedVersionPrefix: "REPLACE_WITH_VERSION_PREFIX"
  },
  cloud: {
    enabled: false,
    externalOrigin: "https://studio.example.invalid",
    gatewayPort: 8787,
    tunnelName: "studio-tunnel"
  },
  media: { minFreeGB: 2, warnFreeGB: 10 },
  backup: { dir: "", retentionCount: 5, includeSecrets: false },
  logging: { maxFileBytes: 5_000_000, maxFiles: 10 }
});

export function writeExampleConfig(targetPath) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n", "utf8");
  return targetPath;
}

function dirExists(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return statSync(p).isFile(); } catch { return false; } }

export function diskFreeBytes(dir) {
  try { const s = statfsSync(dir); return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }; }
  catch { return { freeBytes: null, totalBytes: null }; }
}

// Resolve a config object (already parsed) into a normalized config + derived paths.
export function normalizeConfig(raw = {}) {
  const ownerRoot = typeof raw.ownerRoot === "string" && raw.ownerRoot ? raw.ownerRoot : (process.env.AVC_STUDIO_HOME || defaultStudioHome());
  const repositoryRoot = typeof raw.repositoryRoot === "string" && raw.repositoryRoot ? raw.repositoryRoot : process.cwd();
  const b3 = path.join(ownerRoot, "b3-local-runtime");
  return Object.freeze({
    mode: raw.mode,
    repositoryRoot, ownerRoot,
    runtime: Object.freeze({
      expectedBranch: raw.runtime?.expectedBranch || "p0/step5c12-production-rc",
      requireCleanWorktree: raw.runtime?.requireCleanWorktree !== false,
      statusFile: path.join(b3, "runtime", "runtime-status.json")
    }),
    postgres: Object.freeze({
      binariesDir: raw.postgres?.binariesDir || path.join(b3, "postgres", "bin"),
      dataDir: path.join(b3, "postgres-data")
    }),
    // P0 Step 5C.29 Phase 0 - generation maintenance pause (server-side, owner-config sourced). Absent keeps
    // the historical behaviour (running); an unrecognised value is FAIL-CLOSED (paused) so an operator typo can
    // never let a deploy auto-resume provider work.
    generation: Object.freeze({
      executionPaused: parseExecutionPaused(raw.generation?.executionPaused),
      // P0 Step 5C.30 — provider submission pacing (ms) for Grok Imagine video. Server-side only; an
      // absent/invalid value falls back to the certified 120s default (fail-safe, never 0 by accident).
      providerCooldownMs: Number.isInteger(raw.generation?.providerCooldownMs) && raw.generation.providerCooldownMs >= 0 && raw.generation.providerCooldownMs <= 3600000
        ? raw.generation.providerCooldownMs : 120000
    }),
    provider: Object.freeze({
      realEnabled: raw.provider?.realEnabled !== false,
      cloakExecutable: typeof raw.provider?.cloakExecutable === "string" ? raw.provider.cloakExecutable : "UNKNOWN"
    }),
    // 5C.13: the production Worker pins ONE exact Cloak executable (authorized external build).
    // Only PATH REFERENCES live here - the license VALUE never enters config/logs.
    cloak: Object.freeze({
      enabled: raw.cloak?.enabled === true,
      installRoot: typeof raw.cloak?.installRoot === "string" ? raw.cloak.installRoot : "",
      executablePath: typeof raw.cloak?.executablePath === "string" ? raw.cloak.executablePath : "",
      licenseFilePath: typeof raw.cloak?.licenseFilePath === "string" && raw.cloak.licenseFilePath
        ? raw.cloak.licenseFilePath
        : path.join(process.env.USERPROFILE || "C:\\Users\\Default", "Desktop", "cloak.txt"),
      expectedVersionPrefix: typeof raw.cloak?.expectedVersionPrefix === "string" ? raw.cloak.expectedVersionPrefix : ""
    }),
    // 5C.13: secure cloud studio (Cloudflare Tunnel + Access in front of a stable loopback gateway).
    cloud: Object.freeze({
      enabled: raw.cloud?.enabled === true,
      externalOrigin: typeof raw.cloud?.externalOrigin === "string" ? raw.cloud.externalOrigin : "https://studio.example.com",
      gatewayPort: Number.isInteger(raw.cloud?.gatewayPort) && raw.cloud.gatewayPort >= 1024 && raw.cloud.gatewayPort <= 65535 ? raw.cloud.gatewayPort : 8787,
      tunnelName: typeof raw.cloud?.tunnelName === "string" && raw.cloud.tunnelName ? raw.cloud.tunnelName : "studio-tunnel",
      cloudDir: path.join(ownerRoot, "cloud")
    }),
    // 5C.24/5C.25: native-auth activation flags (booleans/origins only; NO secrets). All default OFF -> the
    // runtime + gateway behave as before unless the owner turns a flag on in the production config.
    nativeAuth: Object.freeze({
      uiEnabled: raw.nativeAuth?.uiEnabled === true,
      routesEnabled: raw.nativeAuth?.routesEnabled === true,
      enforcementEnabled: raw.nativeAuth?.enforcementEnabled === true,
      bootstrapEnabled: raw.nativeAuth?.bootstrapEnabled === true,
      cutoverConfirmed: raw.nativeAuth?.cutoverConfirmed === true,
      gatewayPepEnabled: raw.nativeAuth?.gatewayPepEnabled === true,
      // P0 Step 5C.28: when set (e.g. "/ws/worker"), the studio gateway raw-tunnels WebSocket upgrades on this
      // exact path so a REMOTE worker can hold its outbound WSS through the Cloudflare tunnel. null/absent = OFF
      // (upgrades dropped, identical to pre-5C.28). Must equal the control-plane gateway path.
      workerWsProxyPath: typeof raw.nativeAuth?.workerWsProxyPath === "string" && raw.nativeAuth.workerWsProxyPath.startsWith("/") ? raw.nativeAuth.workerWsProxyPath : null,
      // P0 Step 5C.31 - which upstream terminates the worker WSS. "enrollment" (the worker runtime, which owns
      // the generation pipeline and therefore the remote delivery hub) is the production value; "controlPlane"
      // preserves the legacy 5C.28 transport-only gateway. Anything else falls back to the safe default.
      workerWsUpstream: raw.nativeAuth?.workerWsUpstream === "controlPlane" ? "controlPlane" : "enrollment",
      cookieSecure: raw.nativeAuth?.cookieSecure !== false,
      allowedOrigins: Array.isArray(raw.nativeAuth?.allowedOrigins) ? raw.nativeAuth.allowedOrigins.filter((s) => typeof s === "string") : []
    }),
    media: Object.freeze({
      root: path.join(ownerRoot, "generated-media"),
      minFreeGB: Number.isFinite(raw.media?.minFreeGB) ? raw.media.minFreeGB : 2,
      warnFreeGB: Number.isFinite(raw.media?.warnFreeGB) ? raw.media.warnFreeGB : 10
    }),
    backup: Object.freeze({
      dir: raw.backup?.dir || path.join(ownerRoot, "backups"),
      retentionCount: Number.isInteger(raw.backup?.retentionCount) && raw.backup.retentionCount >= 1 ? raw.backup.retentionCount : 5,
      includeSecrets: raw.backup?.includeSecrets === true
    }),
    logging: Object.freeze({
      dir: path.join(b3, "logs", "ops"),
      maxFileBytes: Number.isInteger(raw.logging?.maxFileBytes) && raw.logging.maxFileBytes >= 100_000 ? raw.logging.maxFileBytes : 5_000_000,
      maxFiles: Number.isInteger(raw.logging?.maxFiles) && raw.logging.maxFiles >= 2 ? raw.logging.maxFiles : 10
    })
  });
}

// Load + validate. Returns { ok, config|null, issues } — never throws for content problems, only
// for programmer errors. `requireDirs:false` lets unit tests validate shape without a real disk.
export function loadProductionConfig({ configPath, requireDirs = true } = {}) {
  const issues = [];
  if (typeof configPath !== "string" || !configPath) return { ok: false, config: null, issues: [issue("ERROR", "E_CONFIG_PATH", "A config path is required")] };
  if (!fileExists(configPath)) {
    return {
      ok: false, config: null,
      issues: [issue("ERROR", "E_CONFIG_MISSING", `Config file not found: ${configPath}. Copy config/production.config.example.json there and edit the paths.`)]
    };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(configPath, "utf8")); }
  catch (e) { return { ok: false, config: null, issues: [issue("ERROR", "E_CONFIG_PARSE", `Config is not valid JSON: ${e.message}`)] }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, config: null, issues: [issue("ERROR", "E_CONFIG_SHAPE", "Config must be a JSON object")] };

  // Secrets are NEVER allowed in the config file (they live in the DPAPI stores).
  const scanSecrets = (obj, trail = "") => {
    for (const [k, v] of Object.entries(obj)) {
      const where = trail ? `${trail}.${k}` : k;
      // Only STRING values can carry a credential; boolean knobs like backup.includeSecrets are fine.
      if (SECRET_KEY_RE.test(k) && typeof v === "string" && v.length > 0) issues.push(issue("ERROR", "E_CONFIG_SECRET_KEY", `Config key '${where}' looks like a credential — credentials belong in the encrypted stores, never in config`));
      if (typeof v === "string" && SECRET_VALUE_RE.test(v)) issues.push(issue("ERROR", "E_CONFIG_SECRET_VALUE", `Config value at '${where}' looks like a credential/proxy URL — not allowed`));
      if (v && typeof v === "object" && !Array.isArray(v)) scanSecrets(v, where);
    }
  };
  scanSecrets(raw);

  if (!CONFIG_MODES.includes(raw.mode)) issues.push(issue("ERROR", "E_CONFIG_MODE", `mode must be one of ${CONFIG_MODES.join("/")} (got '${raw.mode}')`));
  const config = normalizeConfig(raw);
  if (config.mode === "production" && raw.runtime?.requireCleanWorktree === false) {
    issues.push(issue("ERROR", "E_CONFIG_DIRTY_ALLOWED", "production mode requires runtime.requireCleanWorktree=true"));
  }

  if (requireDirs) {
    if (!dirExists(config.repositoryRoot)) issues.push(issue("ERROR", "E_REPO_ROOT", `repositoryRoot does not exist: ${config.repositoryRoot}`));
    // .git may be a directory (normal clone) or a pointer FILE (linked git worktree) — both are repos.
    else if (!existsSync(path.join(config.repositoryRoot, ".git"))) issues.push(issue("ERROR", "E_REPO_NOT_GIT", `repositoryRoot is not a git repository: ${config.repositoryRoot}`));
    if (!dirExists(config.ownerRoot)) issues.push(issue("ERROR", "E_OWNER_ROOT", `ownerRoot does not exist: ${config.ownerRoot}`));
    for (const exe of ["pg_ctl.exe", "psql.exe"]) {
      if (!fileExists(path.join(config.postgres.binariesDir, exe))) issues.push(issue("ERROR", "E_PG_BINARIES", `PostgreSQL binary missing: ${path.join(config.postgres.binariesDir, exe)}`));
    }
    if (!fileExists(path.join(config.postgres.binariesDir, "pg_dump.exe"))) issues.push(issue("WARN", "W_PG_DUMP", "pg_dump.exe not found — only cold (stopped-runtime) backups are possible"));
    const ffmpegPath = path.join(config.repositoryRoot, "node_modules", "ffmpeg-static", "ffmpeg.exe");
    const ffprobeDir = path.join(config.repositoryRoot, "node_modules", "ffprobe-static");
    if (!fileExists(ffmpegPath)) issues.push(issue("ERROR", "E_FFMPEG", `ffmpeg binary missing (run npm install in the repo): ${ffmpegPath}`));
    if (!dirExists(ffprobeDir)) issues.push(issue("ERROR", "E_FFPROBE", "ffprobe-static package missing (run npm install in the repo)"));
    if (!dirExists(config.media.root)) issues.push(issue("WARN", "W_MEDIA_ROOT", `media root will be created on first use: ${config.media.root}`));
    if (config.provider.realEnabled && !config.cloak.enabled) {
      if (config.provider.cloakExecutable === "UNKNOWN" || !config.provider.cloakExecutable) {
        issues.push(issue("WARN", "W_CLOAK_UNKNOWN", "provider.cloakExecutable is UNKNOWN — real provider sessions rely on the runtime's own Cloak preflights"));
      } else if (!fileExists(config.provider.cloakExecutable)) {
        issues.push(issue("ERROR", "E_CLOAK_MISSING", `provider.cloakExecutable does not exist: ${config.provider.cloakExecutable}`));
      }
    }
    // 5C.13 Cloak pinning: fail-closed when enabled. The executable must be the configured EXACT
    // path inside the install root with a parseable pro-build version matching the policy; the
    // license file must exist (its VALUE is only ever handled by the closure-held preflight).
    if (config.cloak.enabled) {
      if (!dirExists(config.cloak.installRoot)) issues.push(issue("ERROR", "E_CLOAK_ROOT", `cloak.installRoot does not exist: ${config.cloak.installRoot}`));
      if (!fileExists(config.cloak.executablePath)) issues.push(issue("ERROR", "E_CLOAK_EXE", "cloak.executablePath does not exist"));
      else if (config.cloak.installRoot && !path.resolve(config.cloak.executablePath).toLowerCase().startsWith(path.resolve(config.cloak.installRoot).toLowerCase() + path.sep)) {
        issues.push(issue("ERROR", "E_CLOAK_EXE_OUTSIDE_ROOT", "cloak.executablePath is outside cloak.installRoot"));
      }
      if (!config.cloak.expectedVersionPrefix) issues.push(issue("ERROR", "E_CLOAK_VERSION_POLICY", "cloak.expectedVersionPrefix is required when cloak.enabled"));
      if (!fileExists(config.cloak.licenseFilePath)) issues.push(issue("ERROR", "E_CLOAK_LICENSE_FILE", "cloak license file is missing (path reference only; the value never enters config)"));
    } else if (config.mode === "production" && config.provider.realEnabled) {
      issues.push(issue("WARN", "W_CLOAK_NOT_PINNED", "cloak.enabled=false - real provider sessions will use the historical npm-cache binary"));
    }
    const disk = diskFreeBytes(dirExists(config.ownerRoot) ? config.ownerRoot : path.parse(config.ownerRoot).root);
    if (disk.freeBytes !== null) {
      const freeGB = disk.freeBytes / 1e9;
      if (freeGB < config.media.minFreeGB) issues.push(issue("ERROR", "E_DISK_FULL", `Only ${freeGB.toFixed(1)} GB free on the owner volume (< minFreeGB=${config.media.minFreeGB})`));
      else if (freeGB < config.media.warnFreeGB) issues.push(issue("WARN", "W_DISK_LOW", `${freeGB.toFixed(1)} GB free on the owner volume (< warnFreeGB=${config.media.warnFreeGB})`));
    }
  }

  const ok = !issues.some((i) => i.level === "ERROR");
  return { ok, config: ok ? config : config, issues };
}
