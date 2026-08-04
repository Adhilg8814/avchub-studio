// P0 Step 5C.12 — media lifecycle: disk thresholds, safe cleanup planning, package verification.
//
// SAFETY MODEL: cleanup may delete ONLY intermediate/temp artifacts (render work dirs, upload
// temp files, stale partials). Anything referenced by the database (scene clips, narration/music
// assets, render outputs, packages) and ALL certification evidence (jobs/**, generation-jobs JSON,
// result.json correlation) is preserved unconditionally. Unreferenced FINAL media is only ever
// REPORTED (orphans) — never deleted by this module. Dry-run is the default everywhere.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { hashFile } from "./backup-restore.mjs";
import { diskFreeBytes } from "./production-config.mjs";

const toPosix = (p) => p.split(path.sep).join("/");

function* walk(root, base = root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) { yield { abs: full, rel: toPosix(path.relative(base, full)), dir: true }; yield* walk(full, base); }
    else if (entry.isFile()) yield { abs: full, rel: toPosix(path.relative(base, full)), dir: false, bytes: statSync(full).size };
  }
}

// TEMP classification. isTempShape: a recognized temp/intermediate artifact (never an orphan);
// deletable only when the age gate also passes (render scratch is deletable immediately — a
// running render holds its own work dir open only during the ffmpeg run).
function isTempShape(rel) {
  return /(^|\/)renders\/v\d+\/work(\/|$)/.test(rel)
    || (/(^|\/)work(\/|$)/.test(rel) && /(^|\/)movies\//.test(rel))
    || /^uploads\/tmp-[A-Za-z0-9]+\.bin$/.test(rel)
    || /\.partial$/.test(rel);
}
function isTemp(rel, { now, mtimeMs, tempMaxAgeMs }) {
  if (!isTempShape(rel)) return false;
  const old = now - mtimeMs > tempMaxAgeMs;
  if (/^uploads\/tmp-[A-Za-z0-9]+\.bin$/.test(rel)) return old; // an in-flight upload must survive
  if (/\.partial$/.test(rel)) return old;
  return true;
}
// EVIDENCE: never deletable, never even listed as orphan.
function isEvidence(rel) {
  return /^jobs\//.test(rel) || /result\.json$/.test(rel);
}

// Plan a cleanup of mediaRoot. referencedRelPaths: Set of posix relative paths the DB references
// (scene clips, audio assets, render final/srt/jpg, package zips, project finalMedia).
export function planMediaCleanup({ mediaRoot, referencedRelPaths = new Set(), now = Date.now(), tempMaxAgeMs = 6 * 3600 * 1000 } = {}) {
  if (!existsSync(mediaRoot)) return { deletable: [], preserved: [], orphans: [], deletableBytes: 0 };
  const deletable = [], preserved = [], orphans = [];
  let deletableBytes = 0;
  for (const f of walk(mediaRoot)) {
    if (f.dir) continue;
    const mtimeMs = statSync(f.abs).mtimeMs;
    if (isTemp(f.rel, { now, mtimeMs, tempMaxAgeMs })) { deletable.push({ rel: f.rel, bytes: f.bytes }); deletableBytes += f.bytes; continue; }
    if (referencedRelPaths.has(f.rel) || isEvidence(f.rel) || isTempShape(f.rel)) { preserved.push(f.rel); continue; }
    orphans.push({ rel: f.rel, bytes: f.bytes }); // report-only — NEVER deleted here
  }
  return { deletable, preserved, orphans, deletableBytes };
}

// Execute a plan. Dry-run by default; deletes ONLY the plan's deletable list, then prunes any
// now-empty work/ directories. Returns what actually happened.
export function executeMediaCleanup({ mediaRoot, plan, dryRun = true } = {}) {
  if (!plan || !Array.isArray(plan.deletable)) throw new TypeError("executeMediaCleanup requires a plan");
  const deleted = [];
  if (!dryRun) {
    for (const f of plan.deletable) {
      const abs = path.join(mediaRoot, f.rel.split("/").join(path.sep));
      try { rmSync(abs, { force: true }); deleted.push(f.rel); } catch { /* skip locked files */ }
    }
    // Prune empty work dirs (bottom-up).
    const dirs = [...walk(mediaRoot)].filter((e) => e.dir && /(^|\/)work(\/|$)/.test(e.rel)).sort((a, b) => b.rel.length - a.rel.length);
    for (const d of dirs) { try { if (readdirSync(d.abs).length === 0) rmSync(d.abs, { recursive: false, force: true }); } catch { /* */ } }
  }
  return { dryRun, wouldDelete: plan.deletable.length, deleted: deleted.length, freedBytes: dryRun ? 0 : plan.deletable.filter((f) => deleted.includes(f.rel)).reduce((t, f) => t + f.bytes, 0) };
}

// After cleanup, every package the DB knows about must still verify byte-for-byte.
export async function verifyPackagesAfterCleanup({ mediaRoot, packages = [] } = {}) {
  const bad = [];
  for (const p of packages) {
    const abs = path.join(mediaRoot, p.relativePath.split("/").join(path.sep));
    if (!existsSync(abs)) { bad.push({ relativePath: p.relativePath, reason: "MISSING" }); continue; }
    if (p.sha256 && (await hashFile(abs)) !== p.sha256) bad.push({ relativePath: p.relativePath, reason: "HASH_MISMATCH" });
  }
  return { ok: bad.length === 0, bad };
}

export function mediaDiskStatus({ mediaRoot, minFreeGB = 2, warnFreeGB = 10 } = {}) {
  const disk = diskFreeBytes(existsSync(mediaRoot) ? mediaRoot : path.parse(mediaRoot).root);
  const freeGB = disk.freeBytes === null ? null : disk.freeBytes / 1e9;
  return { ...disk, status: freeGB === null ? "UNKNOWN" : freeGB < minFreeGB ? "FAIL" : freeGB < warnFreeGB ? "WARN" : "OK" };
}
