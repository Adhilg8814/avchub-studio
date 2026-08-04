import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root = parent of lib/. Every default path is anchored here so the
// scripts behave the same no matter which directory they are invoked from.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function fromRoot(...segments) {
  return path.join(repoRoot, ...segments);
}

/**
 * Is this path absolute on EITHER platform's rules?
 *
 * `path.isAbsolute` answers for the platform it is running on, and that is the wrong question here. Config
 * files, job records and test fixtures written on Windows travel to Linux — in CI, in a container, in a
 * database row — and `path.posix.isAbsolute("C:\\media\\clip.mp4")` is false, so a Windows path would be
 * silently joined onto the repository root and become
 * `/home/runner/work/avchub-studio/avchub-studio/C:\media\clip.mp4`, a path that exists nowhere.
 *
 * Checking both rule sets is deliberate: `path.win32.isAbsolute` covers a drive letter (`C:\x`, `C:/x`) and
 * a UNC share (`\\server\share`), `path.posix.isAbsolute` covers a leading slash. Neither treats a
 * drive-RELATIVE path like `C:x` as absolute, which is correct — that one still resolves against the root.
 *
 * The trade-off, stated plainly: a Linux file genuinely named `C:\x\y.txt` is legal and would now be read as
 * absolute rather than joined. That is the right call for a project whose records are written on Windows,
 * and the alternative silently corrupts every such path the moment it crosses platforms.
 */
export function isAbsolutePath(value) {
  const text = String(value ?? "");
  return path.posix.isAbsolute(text) || path.win32.isAbsolute(text);
}

// Absolute paths pass through; relative paths resolve against the repo root.
export function resolveFromRoot(value) {
  const text = String(value ?? "").trim();
  if (!text) return repoRoot;
  return isAbsolutePath(text) ? text : path.join(repoRoot, text);
}

// Where this installation keeps everything that must NOT live in the repository: provider profiles,
// generated media, credentials, model caches, backups.
//
// Kept outside the working tree on purpose — a data directory inside the repo ends up in a commit, a release
// archive, or a `git clean` sooner or later. `AVC_STUDIO_HOME` overrides it; the default sits beside the repo
// so a fresh clone has somewhere to write without the operator choosing a path first.
export function defaultStudioHome(env = process.env) {
  const configured = String(env.AVC_STUDIO_HOME ?? "").trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-data`);
}

// index.csv and other cross-tool records use forward slashes so the same
// file works for Node, Python, and the WPF viewer.
export function toPosix(value) {
  return String(value).replaceAll("\\", "/");
}

// Path stored in records: relative to repo root when inside it, POSIX style.
export function toRecordPath(absolutePath) {
  const relative = path.relative(repoRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return toPosix(absolutePath);
  }
  return toPosix(relative);
}
