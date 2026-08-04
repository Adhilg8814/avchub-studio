#!/usr/bin/env node
// P0 Step 5C.31 — worker self-retirement. Called by uninstall-worker.ps1 so a machine being
// decommissioned kills its OWN credential before its files disappear.
//
// It can only ever retire ITSELF: the server derives the identity from the credential presented, so
// there is no worker id to pass and nothing to spoof. The server refuses while the worker still owns
// an attempt — an uninstall must not orphan work. The owner's Revoke in Studio remains the
// authoritative action; this is the polite version the machine can do on its way out.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DpapiCredentialStore, makeDpapiRunner } from "../lib/worker/credential-store.mjs";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

async function main() {
  const configPath = argOf("--config");
  if (!configPath || !existsSync(configPath)) { out({ ok: false, code: "E_WORKER_CONFIG_MISSING" }); process.exit(2); }
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const credDir = cfg.credentialDir || path.join(cfg.ownerRoot, "credentials");
  const runner = makeDpapiRunner({ spawn: (c, a, o = {}) => spawn(c, a, { ...o, windowsHide: true }) });
  const store = new DpapiCredentialStore({ dir: credDir, runner, ensureOutsideRepo: false });
  const rec = await store.getActiveCredential().catch(() => null);
  if (!rec || !rec.credential) { out({ ok: false, code: "E_WORKER_NOT_PAIRED" }); process.exit(3); }

  const url = `${String(cfg.studioUrl).replace(/\/+$/, "")}/api/worker/retire`;
  let res;
  try { res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${rec.credential}` } }); }
  catch { out({ ok: false, code: "E_STUDIO_UNREACHABLE" }); process.exit(4); }
  let body = {};
  try { body = await res.json(); } catch { /* */ }
  if (!res.ok) { out({ ok: false, code: body.code || `E_HTTP_${res.status}`, ownedAttempts: body.ownedAttempts ?? null }); process.exit(5); }
  out({ ok: true, retired: true });
}

// Only safe fields are ever printed — never the credential, never the response body verbatim.
function out(o) { process.stdout.write(JSON.stringify(o) + "\n"); }

main().catch(() => { out({ ok: false, code: "E_WORKER_RETIRE_FAILED" }); process.exit(6); });
