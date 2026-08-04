// P0 Step 5C.12 — shared helpers for the operational CLIs. No secrets are ever printed.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProductionConfig, defaultConfigPath } from "../../lib/ops/production-config.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { flags[key] = argv[i + 1]; i += 1; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

export function ownerRootDefault() { return `${REPO_ROOT}-OWNER`; }

export function resolveConfig(flags, { requireDirs = true } = {}) {
  const configPath = typeof flags.config === "string" ? flags.config : defaultConfigPath(ownerRootDefault());
  return { configPath, ...loadProductionConfig({ configPath, requireDirs }) };
}

export function printIssues(issues) {
  for (const i of issues) process.stdout.write(`${i.level === "ERROR" ? "[FAIL]" : "[warn]"} ${i.code}: ${i.message}\n`);
}

export function readRuntimeStatus(ownerRoot) {
  const file = path.join(ownerRoot, "b3-local-runtime", "runtime", "runtime-status.json");
  if (!existsSync(file)) return { state: "STOPPED", missing: true };
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { state: "UNKNOWN", corrupt: true }; }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Fetch the running runtime's ops endpoints through the loopback Worker channel.
export async function fetchOps(status, pathName) {
  const enrollment = status?.ports?.enrollment;
  const cp = status?.ports?.controlPlane ?? status?.ports?.ui ?? status?.ports?.api;
  if (!Number.isInteger(enrollment) || !Number.isInteger(cp)) throw Object.assign(new Error("Runtime ports unavailable"), { code: "E_OPS_NO_PORTS" });
  const res = await fetch(`http://127.0.0.1:${enrollment}/api/provider-management${pathName}`, { headers: { Origin: `http://127.0.0.1:${cp}` } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok !== true) throw Object.assign(new Error(`ops endpoint failed (${res.status})`), { code: "E_OPS_FETCH" });
  return body;
}

export function latestBackupPath(backupDir) {
  if (!existsSync(backupDir)) return null;
  const names = readdirSync(backupDir).filter((d) => /^backup-\d{8}-\d{6}$/.test(d) && existsSync(path.join(backupDir, d, "MANIFEST.json"))).sort();
  return names.length ? path.join(backupDir, names[names.length - 1]) : null;
}

export function emit(flags, human, jsonValue) {
  if (flags.json) process.stdout.write(JSON.stringify(jsonValue, null, 2) + "\n");
  else process.stdout.write(human.endsWith("\n") ? human : human + "\n");
}

export function helpAndExit(flags, text) {
  if (flags.help || flags.h) { process.stdout.write(text.trim() + "\n"); process.exit(0); }
}
