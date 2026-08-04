import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root = parent of lib/. Every default path is anchored here so the
// scripts behave the same no matter which directory they are invoked from.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function fromRoot(...segments) {
  return path.join(repoRoot, ...segments);
}

// Absolute paths pass through; relative paths resolve against the repo root.
export function resolveFromRoot(value) {
  const text = String(value ?? "").trim();
  if (!text) return repoRoot;
  return path.isAbsolute(text) ? text : path.join(repoRoot, text);
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
