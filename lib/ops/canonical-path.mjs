// P0 Step 5C.36 — CANONICAL PATH CONTAINMENT (pure, Windows-aware).
//
// Every media path in this system is a workspace-relative string from the database joined onto a root on
// disk, and every one of them was guarded the same way:
//
//     const abs = path.join(root, rel.split("/").join(path.sep));
//     return abs.startsWith(root) ? abs : null;
//
// That check is wrong in three separate ways, and all three have now been observed:
//
//   * SEPARATOR — a root written "E:/OWNER\media" never prefixes a joined path, because path.join()
//     normalises to backslashes. Every clip is rejected and the caller reports the file as MISSING. That
//     is exactly what happened while re-cutting a finished movie: nothing was missing, the path was simply
//     never allowed to resolve. A containment check that fails CLOSED on a well-formed path is not
//     "conservative", it is broken — and it teaches whoever debugs it to loosen the guard.
//
//   * PREFIX COLLISION — "…\generated-media-old" starts with "…\generated-media". A sibling directory that
//     merely shares a name prefix is treated as inside the root. The fix is not a longer string compare, it
//     is to stop comparing strings: ask for the RELATIVE path and require it to stay below.
//
//   * CASE — Windows paths are case-insensitive, so "e:\owner\Media\x" and "E:\OWNER\media\x" are the same
//     file and a byte compare says they are not. Comparing case-INSENSITIVELY on POSIX would be the
//     opposite error, so the comparison has to follow the platform.
//
// What this module guarantees for a resolved path:
//   1. it is inside the root (or is the root itself when allowed);
//   2. `..` cannot escape, before or after normalisation;
//   3. a sibling with a shared prefix is refused;
//   4. an absolute or drive-relative input is refused — callers pass RELATIVE references, always;
//   5. a symlink / junction / reparse point that leaves the root is refused when the caller asks for it
//      (realpath is a filesystem read, so it is opt-in for hot paths that already know the file exists);
//   6. errors never carry the absolute path — a rejected path is an attacker-supplied string, and echoing
//      where the root lives is how a probe becomes a map.

import path from "node:path";
import { realpathSync } from "node:fs";

export const PATH_ERRORS = Object.freeze({
  ROOT: "E_PATH_ROOT_INVALID",
  INPUT: "E_PATH_INPUT_INVALID",
  ABSOLUTE: "E_PATH_ABSOLUTE_REFUSED",
  ESCAPE: "E_PATH_ESCAPE",
  LINK_ESCAPE: "E_PATH_LINK_ESCAPE"
});

// Windows compares paths case-insensitively; POSIX does not. Choosing per platform is the only correct
// answer — a fixed choice is a false negative on one and a false positive on the other.
const CASE_INSENSITIVE = process.platform === "win32";

export class PathContainmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PathContainmentError";
    this.code = code;
    // Deliberately no `path` property: the message and the code are all a caller may surface.
  }
}
const fail = (code, msg) => { throw new PathContainmentError(code, msg); };

// Normalise a root once. Accepts either separator and any casing; returns an absolute, separator-normal,
// trailing-slash-free path. A root is trusted input (it comes from config, never from a request).
export function canonicalRoot(root) {
  if (typeof root !== "string" || root.trim() === "") fail(PATH_ERRORS.ROOT, "a media root is required");
  // Accept "E:/x/y" as well as "E:\\x\\y": resolve() normalises separators for the running platform.
  const abs = path.resolve(root.trim());
  // Strip a trailing separator so "C:\\root\\" and "C:\\root" behave identically.
  return abs.length > 1 && abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

const sameSegment = (a, b) => (CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Resolve a RELATIVE reference against a root, or throw.
 *
 * @param {string} root            trusted root (config)
 * @param {string} ref             untrusted relative reference; "/" or "\" both accepted as separators
 * @param {object} [opts]
 * @param {boolean} [opts.allowRoot=false]     whether ref may resolve to the root itself
 * @param {boolean} [opts.followLinks=false]   also verify the REAL path (resolves junctions/symlinks)
 * @returns {string} the absolute, canonical path
 */
export function resolveWithin(root, ref, { allowRoot = false, followLinks = false } = {}) {
  const base = canonicalRoot(root);
  if (typeof ref !== "string" || ref.trim() === "") fail(PATH_ERRORS.INPUT, "a relative media reference is required");
  const raw = ref.trim();

  // A NUL byte truncates the path at the syscall boundary, so a string that looks contained can address a
  // different file than the one that was checked.
  if (raw.includes("\0")) fail(PATH_ERRORS.INPUT, "the reference contains an invalid character");
  // Records store POSIX separators; accept both, then let the platform decide.
  const normalisedRef = raw.split("/").join(path.sep).split("\\").join(path.sep);
  // An absolute or drive-relative reference is never legitimate here: callers hold RELATIVE references.
  // "C:x" (drive-relative) and "\\server\share" (UNC) are both refused by these two tests.
  if (path.isAbsolute(normalisedRef) || /^[A-Za-z]:/u.test(normalisedRef)) fail(PATH_ERRORS.ABSOLUTE, "an absolute media reference is not accepted");

  const abs = path.resolve(base, normalisedRef);

  // Containment by RELATIVE path, not by string prefix. path.relative() answers "how do I get from base to
  // abs"; if that answer starts with "..", abs is outside — and a sibling that merely shares a name prefix
  // produces exactly such an answer, which is the collision a startsWith() check cannot see.
  const rel = path.relative(base, abs);
  if (rel === "") {
    if (!allowRoot) fail(PATH_ERRORS.ESCAPE, "the reference resolves to the media root itself");
    return abs;
  }
  if (path.isAbsolute(rel)) fail(PATH_ERRORS.ESCAPE, "the reference resolves outside the media root");
  const first = rel.split(path.sep)[0];
  if (first === "..") fail(PATH_ERRORS.ESCAPE, "the reference escapes the media root");

  if (followLinks) {
    // A junction or symlink inside the root can point anywhere. Verifying the REAL path costs a filesystem
    // read, so it is opt-in — but for anything served to a client it is the only honest check.
    let realAbs, realBase;
    try { realAbs = realpathSync.native ? realpathSync.native(abs) : realpathSync(abs); }
    catch { return abs; }                       // not present yet (a render target): containment above stands
    try { realBase = realpathSync.native ? realpathSync.native(base) : realpathSync(base); }
    catch { realBase = base; }
    const realRel = path.relative(realBase, realAbs);
    if (realRel !== "" && (path.isAbsolute(realRel) || realRel.split(path.sep)[0] === "..")) {
      fail(PATH_ERRORS.LINK_ESCAPE, "the reference resolves through a link that leaves the media root");
    }
    if (realRel === "" && !allowRoot) fail(PATH_ERRORS.LINK_ESCAPE, "the reference resolves through a link to the media root itself");
  }
  return abs;
}

/** Non-throwing form: the absolute path, or null. Keeps the shape existing callers already handle. */
export function resolveWithinOrNull(root, ref, opts) {
  try { return resolveWithin(root, ref, opts); } catch { return null; }
}

/**
 * Is an ABSOLUTE path inside a root? For paths the system produced itself (an upload temp file), where
 * there is no relative reference to check.
 */
export function isWithin(root, absolutePath, { allowRoot = false } = {}) {
  let base;
  try { base = canonicalRoot(root); } catch { return false; }
  if (typeof absolutePath !== "string" || absolutePath.trim() === "" || absolutePath.includes("\0")) return false;
  const abs = path.resolve(absolutePath.trim());
  const rel = path.relative(base, abs);
  if (rel === "") return allowRoot === true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== "..";
}

/** True when two paths denote the same location, honouring the platform's case rules. */
export function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ra = path.resolve(a), rb = path.resolve(b);
  return sameSegment(ra, rb);
}

/** Record form: workspace-relative, POSIX separators — what goes into the database. */
export function toRelativeRecord(root, absolutePath) {
  const base = canonicalRoot(root);
  const rel = path.relative(base, path.resolve(absolutePath));
  if (rel === "" || path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") return null;
  return rel.split(path.sep).join("/");
}
