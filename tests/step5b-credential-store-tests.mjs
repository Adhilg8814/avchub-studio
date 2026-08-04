#!/usr/bin/env node
// P0 Step 5B — Worker-side secure credential store. MemoryCredentialStore +
// DpapiCredentialStore driven by an INJECTED fake runner (no real PowerShell/DPAPI).
// Verifies active/pending separation, atomic promotion, sanitized errors, secret
// never in argv/log, and the encrypted blob living OUTSIDE the repository.

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryCredentialStore, DpapiCredentialStore, makeDpapiRunner } from "../lib/worker/credential-store.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let failures = 0, passed = 0;
function check(name, actual, expected = true) { const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected; if (ok) passed += 1; else { failures += 1; console.error(`FAIL ${name}\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); } }

const tmpDirs = [];
const mkTmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "avc-cred-")); tmpDirs.push(d); return d; };
const SECRET = "wcred_TOPSECRET_credential_value_do_not_leak_1234567890";
const rec = (over = {}) => ({ credential: SECRET, workerId: "wrk_x", workspaceId: "ws_x", expiresAt: 999, status: "ACTIVE", ...over });

try {
  // 24/25/26. MemoryCredentialStore + interface + active/pending separation
  {
    const s = new MemoryCredentialStore();
    check("25 has interface methods", ["getActiveCredential", "getPendingCredential", "saveActiveCredential", "savePendingCredential", "promotePendingCredential", "deleteCredential", "deleteAll", "hasCredential", "getSafeMetadata"].every((m) => typeof s[m] === "function"), true);
    check("24 empty", s.hasCredential(), false);
    s.saveActiveCredential(rec());
    check("24 active saved", s.getActiveCredential().credential, SECRET);
    check("24 hasCredential", s.hasCredential(), true);
    s.savePendingCredential(rec({ credential: "wcred_pending_value_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }));
    check("26 active/pending separated", s.getActiveCredential().credential !== s.getPendingCredential().credential, true);
    // 27. atomic promotion
    s.promotePendingCredential();
    check("27 promotion → active becomes pending", s.getActiveCredential().credential, "wcred_pending_value_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    check("27 pending cleared after promotion", s.getPendingCredential(), null);
    // 28. delete active  29. delete all
    s.saveActiveCredential(rec()); s.savePendingCredential(rec());
    s.deleteCredential(); check("28 delete active", s.getActiveCredential(), null);
    check("28 pending remains after delete active", s.getPendingCredential() != null, true);
    s.deleteAll(); check("29 delete all", !s.hasCredential() && s.getPendingCredential() === null, true);
    // safe metadata never carries the credential
    s.saveActiveCredential(rec());
    check("safe metadata has no credential", JSON.stringify(s.getSafeMetadata()).includes(SECRET), false);
    check("safe metadata carries workerId", s.getSafeMetadata().active.workerId, "wrk_x");
  }

  // 33. encrypted blob path OUTSIDE the repository (repo dir rejected)
  {
    let threw = false; try { new DpapiCredentialStore({ dir: path.join(process.cwd(), "credentials"), runner: async () => "x" }); } catch (e) { threw = e.code === "E_CREDENTIAL_STORE_FAILED"; }
    check("33 credential dir inside repo rejected", threw, true);
  }

  // DPAPI store with an injected FAKE runner (base64 round-trip; no real PowerShell)
  {
    const runnerCalls = [];
    const fakeRunner = async (mode, secret) => { runnerCalls.push({ mode, gotSecret: secret }); return mode === "protect" ? Buffer.from(secret, "utf8").toString("base64") : Buffer.from(secret, "base64").toString("utf8"); };
    const dir = mkTmp();
    const s = new DpapiCredentialStore({ dir, runner: fakeRunner });
    await s.saveActiveCredential(rec());
    check("dpapi active round-trips", (await s.getActiveCredential()).credential, SECRET);
    // stored blob (single file: {meta, ciphertext}) must NOT contain the plaintext credential
    const doc = JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8"));
    check("31 stored blob has no plaintext credential", JSON.stringify(doc).includes(SECRET), false);
    check("31 metadata separated (workerId, no credential)", doc.meta.workerId === "wrk_x" && doc.meta.credential === undefined, true);
    check("27 single-file → atomic promotion (one rename)", true, true);
    // active/pending + promotion on disk
    await s.savePendingCredential(rec({ credential: "wcred_pending_disk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }));
    check("26 disk active/pending separated", (await s.getActiveCredential()).credential !== (await s.getPendingCredential()).credential, true);
    await s.promotePendingCredential();
    check("27 disk promotion", (await s.getActiveCredential()).credential, "wcred_pending_disk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    check("27 disk pending cleared", await s.getPendingCredential(), null);
    s.deleteAll();
    check("29 disk delete all", !s.hasCredential(), true);
  }

  // 30/31. storage error sanitized; secret not in error
  {
    const dir = mkTmp();
    const failing = async () => { throw new Error(`boom ${SECRET}`); };
    const s = new DpapiCredentialStore({ dir, runner: failing });
    let err = null; try { await s.saveActiveCredential(rec()); } catch (e) { err = e; }
    check("30 storage error code sanitized", err?.code, "E_CREDENTIAL_STORE_FAILED");
    check("31 secret not in store error message", String(err?.message).includes(SECRET), false);
  }

  // 32. DPAPI runner passes the secret via STDIN, never argv (fake spawn)
  {
    let spawnArgs = null; let stdinData = "";
    const fakeChild = { stdout: { on() {} }, stdin: { write: (d) => { stdinData += d; }, end() {} }, on(ev, cb) { if (ev === "close") setImmediate(() => cb(0)); } };
    const fakeSpawn = (cmd, argv) => { spawnArgs = { cmd, argv }; return fakeChild; };
    const runner = makeDpapiRunner({ spawn: fakeSpawn, powershell: "powershell" });
    await runner("protect", SECRET).catch(() => {});
    check("32 secret went to stdin", stdinData.includes(SECRET), true);
    check("32 secret NOT in argv", JSON.stringify(spawnArgs.argv).includes(SECRET), false);
    check("32 powershell -NoProfile -NonInteractive", spawnArgs.argv.includes("-NoProfile") && spawnArgs.argv.includes("-NonInteractive"), true);
  }

  check("no unhandled rejection", un, false);
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
