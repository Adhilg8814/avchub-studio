// P0 Step 5C.12 — offline license inventory CLI. --write regenerates docs/THIRD_PARTY_NOTICES.md.
// Exit 0 ok (inventory produced) / 1 error. The inventory implies NO legal approval.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, emit, helpAndExit, REPO_ROOT } from "./cli-util.mjs";
import { auditLicenses, renderThirdPartyNotices } from "../../lib/ops/license-audit.mjs";

const { flags } = parseArgs();
helpAndExit(flags, `
license-audit.mjs — offline dependency/license inventory.
  --write   regenerate docs/THIRD_PARTY_NOTICES.md
  --json    machine-readable output
Exit 0 ok / 1 error.`);

try {
  const audit = auditLicenses({ repoRoot: REPO_ROOT });
  if (flags.write) {
    const target = path.join(REPO_ROOT, "docs", "THIRD_PARTY_NOTICES.md");
    writeFileSync(target, renderThirdPartyNotices(audit), "utf8");
    emit(flags, `wrote ${target} (${audit.packages.length} packages, ${audit.flags.length} flag(s))`, { ok: true, wrote: "docs/THIRD_PARTY_NOTICES.md", flags: audit.flags });
  } else {
    emit(flags, renderThirdPartyNotices(audit), { ok: true, audit });
  }
  process.exit(0);
} catch (e) {
  emit(flags, `[FAIL] ${e.code || "E_LICENSE"}: ${e.message}`, { ok: false, code: e.code || "E_LICENSE" });
  process.exit(1);
}
