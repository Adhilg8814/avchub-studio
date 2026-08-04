// P0 Step 5C.13 - mint (idempotent) the trusted-proxy gateway secret before the runtime starts, so
// the enrollment channel loads it and accepts the gateway's proxied external-origin requests. The
// gateway reuses the same file. Never prints the secret.
import path from "node:path";
import { parseArgs, resolveConfig } from "./cli-util.mjs";
import { ensureGatewaySecret } from "../../lib/ops/studio-gateway.mjs";

const { flags } = parseArgs();
const { config } = resolveConfig(flags, { requireDirs: false });
if (!config?.cloud?.enabled) { process.stdout.write("[cloud] disabled - no gateway secret needed\n"); process.exit(0); }
try {
  ensureGatewaySecret(path.join(config.cloud.cloudDir, "gateway-secret.txt"));
  process.stdout.write("[cloud] trusted-proxy gateway secret ready (ACL-restricted)\n");
  process.exit(0);
} catch (e) {
  process.stdout.write(`[cloud] gateway secret error: ${e.code || e.message}\n`);
  process.exit(1);
}
