// Shared config for the LOCAL Step 5A dev commands (worker-control-local /
// worker-connect-local). Fixed localhost port + a DEV-ONLY fake credential mapped
// to fixed valid ULIDs. Never used in production; never a real secret.

export const DEV_HOST = "127.0.0.1";
export const DEV_PORT = Number(process.env.PORT || 7830);
export const DEV_CREDENTIAL = process.env.DEV_CREDENTIAL || "dev-worker-local";
export const DEV_WORKER_ID = "wrk_01JQ7ZK9M3N4P5Q6R7S8T9V0C4";
export const DEV_WORKSPACE_ID = "ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3";
export const DEV_URL = `ws://${DEV_HOST}:${DEV_PORT}`;
export const DEV_CREDENTIALS = { [DEV_CREDENTIAL]: { workerId: DEV_WORKER_ID, workspaceId: DEV_WORKSPACE_ID } };

// ---- Step 5B pairing dev config (localhost, dev-only, NOT production secrets) ----
import os from "node:os";
import path from "node:path";
export const DEV_PAIR_PORT = Number(process.env.PAIR_PORT || 7831);
export const DEV_PAIR_WS = process.env.DEV_WORKSPACE || DEV_WORKSPACE_ID;
export const DEV_PAIRING_PEPPER = process.env.DEV_PAIRING_PEPPER || "dev-pairing-pepper-not-a-real-secret";
export const DEV_CREDENTIAL_PEPPER = process.env.DEV_CREDENTIAL_PEPPER || "dev-credential-pepper-not-a-real-secret";
export const DEV_IDENTITY_FILE = process.env.DEV_IDENTITY_FILE || path.join(os.tmpdir(), "avc-dev-identity", "identity.json");
