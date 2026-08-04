// P0 Step 5C.12 — restore CLI. Restores into an EMPTY target by default; overwriting a non-empty
// target needs --confirm-overwrite; restoring over the PRODUCTION owner root additionally needs
// --confirm-production AND a stopped runtime. Exit 0 ok / 1 error.
import path from "node:path";
import { parseArgs, resolveConfig, printIssues, latestBackupPath, emit, helpAndExit } from "./cli-util.mjs";
import { restoreBackup } from "../../lib/ops/backup-restore.mjs";

const { flags } = parseArgs();
helpAndExit(flags, `
restore.mjs — restore a verified backup.
  --config <path>        production config
  --backup <path>        backup dir (default: the latest backup)
  --target <path>        restore target owner root (REQUIRED unless --confirm-production)
  --confirm-overwrite    allow a non-empty target
  --confirm-production   restore over the PRODUCTION owner root (runtime must be stopped)
  --json                 machine-readable output
Exit 0 ok / 1 error.`);

const { ok, config, issues } = resolveConfig(flags);
if (!ok) { printIssues(issues); process.exit(1); }
const backupPath = typeof flags.backup === "string" ? flags.backup : latestBackupPath(config.backup.dir);
if (!backupPath) { emit(flags, "[FAIL] no backup found", { ok: false, code: "E_NO_BACKUP" }); process.exit(1); }
const target = flags["confirm-production"] === true ? config.ownerRoot : flags.target;
if (typeof target !== "string" || !path.isAbsolute(target)) {
  emit(flags, "[FAIL] --target <absolute path> is required (or --confirm-production)", { ok: false, code: "E_RESTORE_TARGET" });
  process.exit(1);
}
try {
  const out = await restoreBackup({
    backupPath, targetOwnerRoot: target, productionOwnerRoot: config.ownerRoot,
    confirmNonEmpty: flags["confirm-overwrite"] === true || flags["confirm-production"] === true,
    allowProduction: flags["confirm-production"] === true
  });
  emit(flags, `restored ${out.restored} files from ${out.from} into ${out.target}`, { ok: true, ...out });
  process.exit(0);
} catch (e) {
  emit(flags, `[FAIL] ${e.code || "E_RESTORE"}: ${e.message}`, { ok: false, code: e.code || "E_RESTORE", message: e.message });
  process.exit(1);
}
