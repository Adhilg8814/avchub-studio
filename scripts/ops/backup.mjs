// P0 Step 5C.12 — cold backup CLI (runtime must be stopped). Exit 0 ok / 1 error.
import { parseArgs, resolveConfig, printIssues, emit, helpAndExit } from "./cli-util.mjs";
import { createBackup } from "../../lib/ops/backup-restore.mjs";

const { flags } = parseArgs();
helpAndExit(flags, `
backup.mjs — consistent cold backup of PostgreSQL + media + evidence.
  --config <path>      production config
  --include-secrets    also copy the DPAPI-protected secrets dir (machine-bound)
  --json               machine-readable output
The runtime MUST be stopped (stop-production.ps1) first. Exit 0 ok / 1 error.`);

const { ok, config, issues } = resolveConfig(flags);
if (!ok) { printIssues(issues); process.exit(1); }
try {
  const out = await createBackup({
    ownerRoot: config.ownerRoot, backupDir: config.backup.dir,
    includeSecrets: flags["include-secrets"] === true || config.backup.includeSecrets,
    retentionCount: config.backup.retentionCount
  });
  emit(flags, `backup ${out.name}: ${out.files} files, ${(out.bytes / 1e6).toFixed(1)} MB${out.deletedByRetention.length ? ` (retention removed ${out.deletedByRetention.length} old)` : ""}`, { ok: true, ...out });
  process.exit(0);
} catch (e) {
  emit(flags, `[FAIL] ${e.code || "E_BACKUP"}: ${e.message}`, { ok: false, code: e.code || "E_BACKUP", message: e.message });
  process.exit(1);
}
