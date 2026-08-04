// P0 Step 5C.24 — provision the STABLE native-auth secret-box key. AuthService seals TOTP secrets, recovery
// codes, and one-time link tokens with an AES-256-GCM 32-byte key that MUST survive restarts (a fresh key
// makes every stored MFA/enrollment/invitation undecryptable → owner lockout). This mints the key ONCE into
// an ACL-restricted owner-side file and reuses it thereafter. The key VALUE is never printed/logged.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateSecretBoxKey } from "../auth/secret-box.mjs";

// Mint-or-load. Idempotent. Returns the base64 key (44 chars for 32 bytes). ACL-tightens on Windows so only
// the current user + SYSTEM can read it (best-effort defense-in-depth, like the gateway secret).
export function ensureAuthSecretBoxKey(keyFile, { acl = true } = {}) {
  if (typeof keyFile !== "string" || !keyFile) { const e = new Error("keyFile required"); e.code = "E_AUTH_SECRETBOX_KEY"; throw e; }
  mkdirSync(path.dirname(keyFile), { recursive: true });
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, generateSecretBoxKey(), { encoding: "utf8", mode: 0o600 });
    if (acl && process.platform === "win32") {
      try { execFileSync("icacls.exe", [keyFile, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`, "/grant:r", "SYSTEM:F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 }); } catch { /* ACL tightening is defense-in-depth */ }
    }
  }
  const key = readFileSync(keyFile, "utf8").trim();
  if (Buffer.from(key, "base64").length !== 32) { const e = new Error("auth secret-box key invalid (must be 32 bytes base64)"); e.code = "E_AUTH_SECRETBOX_KEY"; throw e; }
  return key;
}
