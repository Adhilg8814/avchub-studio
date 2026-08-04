// P0 Step 5C.12 — ops libraries: production config validation (fail-fast, secret refusal),
// structured logger (JSON shape, redaction, rotation, retention), media lifecycle safety
// (temp-only deletion, evidence/referenced preservation, dry-run default), and the offline
// license audit (GPL flags, honest UNKNOWN/PENDING). Provider-free; temp dirs only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProductionConfig, writeExampleConfig, EXAMPLE_CONFIG, normalizeConfig } from "../lib/ops/production-config.mjs";
import { createStructuredLogger, redactFields } from "../lib/ops/structured-logger.mjs";
import { planMediaCleanup, executeMediaCleanup, verifyPackagesAfterCleanup } from "../lib/ops/media-lifecycle.mjs";
import { auditLicenses, renderThirdPartyNotices } from "../lib/ops/license-audit.mjs";
import { repoRoot } from "../lib/paths.mjs";

let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }

const dir = mkdtempSync(path.join(os.tmpdir(), "cp5c12-opslibs-"));
try {
  // ---------------- production config ----------------
  const cfgPath = path.join(dir, "prod.json");
  check("C1 missing config fails with a helpful error", loadProductionConfig({ configPath: cfgPath }).issues[0].code, "E_CONFIG_MISSING");
  writeFileSync(cfgPath, "{not json", "utf8");
  check("C1 invalid JSON fails fast", loadProductionConfig({ configPath: cfgPath }).issues[0].code, "E_CONFIG_PARSE");
  writeExampleConfig(cfgPath);
  check("C1 example config parses + placeholder-only", JSON.parse(readFileSync(cfgPath, "utf8")).provider.cloakExecutable, "UNKNOWN");
  const shapeOnly = loadProductionConfig({ configPath: cfgPath, requireDirs: false });
  check("C1 example config valid at shape level", shapeOnly.ok, true);
  check("C1 modes restricted", loadProductionConfig({ configPath: (writeFileSync(cfgPath, JSON.stringify({ ...EXAMPLE_CONFIG, mode: "staging" })), cfgPath), requireDirs: false }).issues.some((i) => i.code === "E_CONFIG_MODE"), true);
  writeFileSync(cfgPath, JSON.stringify({ ...EXAMPLE_CONFIG, provider: { proxyPassword: "hunter2" } }), "utf8");
  check("C2 secret KEY with string value refused", loadProductionConfig({ configPath: cfgPath, requireDirs: false }).issues.some((i) => i.code === "E_CONFIG_SECRET_KEY"), true);
  writeFileSync(cfgPath, JSON.stringify({ ...EXAMPLE_CONFIG, notes: "socks5://user:pw@1.2.3.4:1080" }), "utf8");
  check("C2 secret VALUE (proxy URL) refused", loadProductionConfig({ configPath: cfgPath, requireDirs: false }).issues.some((i) => i.code === "E_CONFIG_SECRET_VALUE"), true);
  writeFileSync(cfgPath, JSON.stringify({ ...EXAMPLE_CONFIG, backup: { includeSecrets: false } }), "utf8");
  check("C2 boolean 'includeSecrets' knob allowed", loadProductionConfig({ configPath: cfgPath, requireDirs: false }).ok, true);
  writeFileSync(cfgPath, JSON.stringify({ ...EXAMPLE_CONFIG, runtime: { requireCleanWorktree: false } }), "utf8");
  check("C2 production refuses dirty-worktree allowance", loadProductionConfig({ configPath: cfgPath, requireDirs: false }).issues.some((i) => i.code === "E_CONFIG_DIRTY_ALLOWED"), true);
  const norm = normalizeConfig({ ownerRoot: "E:\\X-OWNER" });
  check("C3 derived paths follow ownerRoot", [norm.postgres.dataDir.includes("X-OWNER"), norm.backup.dir.includes("X-OWNER")], [true, true]);

  // ---------------- structured logger ----------------
  const logDir = path.join(dir, "logs");
  let t = 0;
  const logger = createStructuredLogger({ dir: logDir, component: "test", now: () => new Date(1700000000000 + (t += 1000)), maxFileBytes: 400, maxFiles: 3 });
  logger.info("JOB_QUEUED", { jobId: "job_123", prompt: "p".repeat(200), password: "supersecret", nested: { cookieJar: "evil", ok: 1 } });
  const line = JSON.parse(readFileSync(logger.currentFile, "utf8").trim().split("\n")[0]);
  check("L1 JSON line has ts/level/component/event", [typeof line.ts, line.level, line.component, line.event], ["string", "info", "test", "JOB_QUEUED"]);
  check("L1 secret keys masked (top + nested)", [line.password, line.nested.cookieJar], ["[REDACTED]", "[REDACTED]"]);
  check("L1 prompt truncated with sha tag (never full)", line.prompt.includes("…[len:200,sha:") && line.prompt.length < 110, true);
  const red = redactFields({ note: "file at C:\\AVCStudio\\data\\secrets\\pw.txt ok", authorization: "Bearer abc" });
  check("L1 absolute paths scrubbed to basename", red.note.includes("<path:pw.txt>") && !red.note.includes("E:\\"), true);
  check("L1 authorization masked", red.authorization, "[REDACTED]");
  for (let i = 0; i < 40; i += 1) logger.info("FILL", { i, pad: "x".repeat(60) });
  const files = logger.listFiles();
  check("L2 rotation happened", files.length > 1, true);
  check("L2 retention bounded (≤ maxFiles)", files.length <= 3, true);

  // ---------------- media lifecycle ----------------
  const media = path.join(dir, "media");
  const put = (rel, bytes = 10, ageMs = 0) => {
    const abs = path.join(media, rel.split("/").join(path.sep));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.alloc(bytes, 1));
    if (ageMs) { const old = new Date(Date.now() - ageMs); utimesSync(abs, old, old); }
    return abs;
  };
  put("jobs/job_A/generated.mp4", 100);                      // evidence — always preserved
  put("jobs/job_A/result.json", 20);                          // evidence
  put("movies/mov_1/renders/v1/final.mp4", 200);              // referenced
  put("movies/mov_1/renders/v1/package/package.zip", 150);    // referenced
  put("movies/mov_1/renders/v1/work/seg_000.mp4", 500);       // TEMP → deletable
  put("movies/mov_1/audio/aud_1.wav", 50);                    // referenced
  put("movies/mov_1/old-final.mp4", 75);                      // orphan → REPORT ONLY
  put("uploads/tmp-abc123.bin", 40, 24 * 3600 * 1000);        // stale upload temp → deletable
  put("uploads/tmp-fresh1.bin", 40, 60 * 1000);               // fresh upload temp → kept
  const referenced = new Set(["movies/mov_1/renders/v1/final.mp4", "movies/mov_1/renders/v1/package/package.zip", "movies/mov_1/audio/aud_1.wav"]);
  const plan = planMediaCleanup({ mediaRoot: media, referencedRelPaths: referenced });
  check("M1 only temp files planned for deletion", plan.deletable.map((f) => f.rel).sort(), ["movies/mov_1/renders/v1/work/seg_000.mp4", "uploads/tmp-abc123.bin"]);
  check("M1 orphan finals are report-only", plan.orphans.map((f) => f.rel), ["movies/mov_1/old-final.mp4"]);
  check("M1 evidence + referenced + fresh-temp preserved", plan.preserved.length, 6);
  const dry = executeMediaCleanup({ mediaRoot: media, plan, dryRun: true });
  check("M2 dry-run is the default and deletes nothing", [dry.dryRun, dry.deleted, existsSync(path.join(media, "movies/mov_1/renders/v1/work/seg_000.mp4".split("/").join(path.sep)))], [true, 0, true]);
  const real = executeMediaCleanup({ mediaRoot: media, plan, dryRun: false });
  check("M2 execute deletes exactly the plan", [real.deleted, existsSync(path.join(media, "movies", "mov_1", "renders", "v1", "work", "seg_000.mp4")), existsSync(path.join(media, "movies", "mov_1", "old-final.mp4"))], [2, false, true]);
  const pkgOk = await verifyPackagesAfterCleanup({ mediaRoot: media, packages: [{ relativePath: "movies/mov_1/renders/v1/package/package.zip" }] });
  check("M3 packages verify after cleanup", pkgOk.ok, true);
  const pkgBad = await verifyPackagesAfterCleanup({ mediaRoot: media, packages: [{ relativePath: "movies/mov_1/renders/v1/package/package.zip", sha256: "0".repeat(64) }] });
  check("M3 tampered package detected", [pkgBad.ok, pkgBad.bad[0].reason], [false, "HASH_MISMATCH"]);

  // ---------------- license audit ----------------
  const audit = auditLicenses({ repoRoot });
  const declared = Object.keys(JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).dependencies || {});
  // Asserted against what the manifest actually declares, so the check keeps meaning when a dependency is
  // added or dropped rather than pinning one package name forever.
  check("K1 every declared dependency is inventoried", declared.every((name) => audit.packages.some((p) => p.name === name)), true);
  check("K1 every flag names a package and a reason", audit.flags.every((f) => typeof f.name === "string" && typeof f.reason === "string"), true);
  // Readiness is derived from the flags, not asserted: a dependency that is GPL-family or downloads a
  // binary sets a flag, and any flag blocks distribution. The two must never disagree.
  check("K1 distribution readiness follows the flags", audit.publicDistributionReady === (audit.flags.length === 0), true);
  check("K1 every blocker names its cause", audit.publicDistributionBlockers.length === audit.flags.length, true);
  check("K1 FFmpeg recorded as invoked, not bundled", audit.manualComponents.some((c) => /FFmpeg/i.test(c.name) && /never bundled/i.test(c.note)), true);
  const notices = renderThirdPartyNotices(audit);
  check("K2 notices render with no-approval disclaimer", notices.includes("No legal approval is implied"), true);
  // The notices must state their distribution verdict either way, and must never imply legal approval.
  check("K2 notices state the distribution verdict", notices.includes("No distribution blocker found") || notices.includes("Distribution blocked"), true);

  console.log(`Step 5C.12 ops libs: ${passed} passed, 0 failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
