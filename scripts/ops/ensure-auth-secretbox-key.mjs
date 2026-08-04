// P0 Step 5C.24 — mint (idempotent) the STABLE native-auth secret-box key before the runtime starts, so the
// control-plane loads the SAME key every restart (a fresh key makes stored MFA/enrollment/invitations
// undecryptable → owner lockout). Stored ACL-restricted under <owner>/cloud/. Never prints the key.
import path from "node:path";
import { parseArgs, resolveConfig } from "./cli-util.mjs";
import { ensureAuthSecretBoxKey } from "../../lib/ops/auth-secretbox-key.mjs";

const { flags } = parseArgs();
const { config } = resolveConfig(flags, { requireDirs: false });
try {
  const cloudDir = (config && config.cloud && config.cloud.cloudDir) || path.join((config && config.ownerRoot) || `${process.cwd()}-OWNER`, "cloud");
  ensureAuthSecretBoxKey(path.join(cloudDir, "auth-secretbox-key.txt"));
  process.stdout.write("[auth] native-auth secret-box key ready (ACL-restricted)\n");
  process.exit(0);
} catch (e) {
  process.stdout.write(`[auth] secret-box key error: ${e.code || e.message}\n`);
  process.exit(1);
}
