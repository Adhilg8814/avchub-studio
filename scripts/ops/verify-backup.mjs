// P0 Step 5C.12 — verify a backup's manifest + SHA-256; optional full restore DRILL into a
// disposable directory (starts the restored PostgreSQL copy and checks durable content).
// Exit 0 ok / 1 failed.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs, resolveConfig, printIssues, latestBackupPath, emit, helpAndExit } from "./cli-util.mjs";
import { verifyBackup, restoreBackup, runRestoreDrill } from "../../lib/ops/backup-restore.mjs";

const { flags } = parseArgs();
helpAndExit(flags, `
verify-backup.mjs — verify backup integrity (and optionally drill-restore it).
  --config <path>    production config
  --backup <path>    backup dir (default: the latest backup)
  --drill            restore into a disposable dir, start the restored PostgreSQL copy,
                     verify migrations/projects/correlation/media hashes, then clean up
  --json             machine-readable output
Exit 0 ok / 1 failed.`);

const { ok, config, issues } = resolveConfig(flags);
if (!ok) { printIssues(issues); process.exit(1); }
const backupPath = typeof flags.backup === "string" ? flags.backup : latestBackupPath(config.backup.dir);
if (!backupPath) { emit(flags, "[FAIL] no backup found", { ok: false, code: "E_NO_BACKUP" }); process.exit(1); }

const v = await verifyBackup({ backupPath });
if (!v.ok) {
  emit(flags, `[FAIL] backup verification failed: ${v.error || `${v.mismatched.length} mismatched, ${v.missing.length} missing`}`, { ok: false, ...v });
  process.exit(1);
}
let drill = null;
if (flags.drill) {
  const work = mkdtempSync(path.join(config.backup.dir, ".drill-"));
  try {
    await restoreBackup({ backupPath, targetOwnerRoot: work, productionOwnerRoot: config.ownerRoot });
    drill = await runRestoreDrill({ restoredOwnerRoot: work, pgBinDir: config.postgres.binariesDir });
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  if (!drill.ok) { emit(flags, `[FAIL] restore drill failed: ${JSON.stringify(drill.checks)}`, { ok: false, verify: v, drill }); process.exit(1); }
}
emit(flags,
  `backup OK: ${path.basename(backupPath)} (${v.manifest.totals.files} files, ${(v.manifest.totals.bytes / 1e6).toFixed(1)} MB)` +
  (drill ? `\ndrill OK: migrations=${drill.checks.migrations} projects=${drill.checks.movieProjects} scenesCorrelated=${drill.checks.completedScenesWithCorrelation} rendersVerified=${drill.checks.renderMediaVerified}` : ""),
  { ok: true, verify: v, drill });
process.exit(0);
