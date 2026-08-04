// P0 Step 5C.32 — WORKER RELEASE REGISTRY (server-side source of truth).
//
// A released bundle is a thing users execute on machines we do not own. So the server never "finds a
// file and serves it": it consults a registry that says exactly which versions exist, which bytes each
// one is, and whether this server can talk to them — and it re-verifies the bytes before every download.
//
// The registry is the authority for: current version, supported versions, protocol compatibility, the
// SHA-256, the server-side path, signing status, and release notes. Nothing downstream is allowed to
// infer any of those from a filename or a directory listing.
//
// Fail-closed by construction:
//   * a version the index does not list cannot be resolved (no path is ever built from user input);
//   * a file whose bytes no longer hash to the published SHA-256 is REFUSED, not served with a warning —
//     a modified release is the exact case a download endpoint must not paper over;
//   * the release root is resolved once and every resolved path is re-asserted to live under it.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const RELEASE_INDEX_FILE = "index.json";
export const RELEASE_PRODUCT = "avc-worker-bundle";

export const RELEASE_ERRORS = Object.freeze({
  NOT_FOUND: "E_RELEASE_NOT_FOUND",
  INDEX_MISSING: "E_RELEASE_INDEX_MISSING",
  FILE_MISSING: "E_RELEASE_FILE_MISSING",
  HASH_MISMATCH: "E_RELEASE_HASH_MISMATCH",
  SIZE_MISMATCH: "E_RELEASE_SIZE_MISMATCH",
  PATH_ESCAPE: "E_RELEASE_PATH_ESCAPE"
});

const VERSION_RE = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$/;
function rerr(code, message) { return Object.assign(new Error(message || code), { code }); }

export function isReleaseVersion(v) { return typeof v === "string" && VERSION_RE.test(v); }

export function sha256OfFile(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

// Streaming hash for large artifacts (the bundle is ~131 MB; a full-buffer read per verification would
// be wasteful and would spike memory under concurrent downloads).
export function sha256OfFileStreaming(absPath) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(absPath);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export function createWorkerReleaseRegistry({ releaseRoot, serverProtocolVersion = 1, now = () => Date.now(), verifyTtlMs = 5 * 60_000 } = {}) {
  if (typeof releaseRoot !== "string" || !releaseRoot) throw new TypeError("createWorkerReleaseRegistry requires releaseRoot");
  const ROOT = path.resolve(releaseRoot);
  // version -> { at, sha256 } : a successful full-file verification, cached briefly so a burst of range
  // requests does not re-hash 131 MB per request. Any miss/expiry re-verifies from disk.
  const verified = new Map();

  function indexPath() { return path.join(ROOT, RELEASE_INDEX_FILE); }

  function readIndex() {
    const p = indexPath();
    if (!existsSync(p)) throw rerr(RELEASE_ERRORS.INDEX_MISSING, "release index not published");
    let idx;
    try { idx = JSON.parse(readFileSync(p, "utf8")); } catch { throw rerr(RELEASE_ERRORS.INDEX_MISSING, "release index unreadable"); }
    if (!idx || !Array.isArray(idx.releases)) throw rerr(RELEASE_ERRORS.INDEX_MISSING, "release index malformed");
    return idx;
  }

  // Resolve a path INSIDE the release root from registry-controlled components only, then re-assert
  // containment. There is no code path where a client-supplied string reaches this.
  function resolveInRoot(...parts) {
    const abs = path.resolve(ROOT, ...parts);
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw rerr(RELEASE_ERRORS.PATH_ESCAPE, "resolved outside the release root");
    return abs;
  }

  function entryOf(idx, version) {
    if (!isReleaseVersion(version)) throw rerr(RELEASE_ERRORS.NOT_FOUND, "unknown release");
    const e = idx.releases.find((r) => r && r.version === version && r.status !== "WITHDRAWN");
    if (!e) throw rerr(RELEASE_ERRORS.NOT_FOUND, "unknown release");
    return e;
  }

  // Compatibility is a SERVER statement about a bundle, not the bundle's claim about itself.
  function compatibilityOf(entry) {
    const bundleProtocol = Number.isInteger(entry.deliveryProtocolVersion) ? entry.deliveryProtocolVersion : null;
    const compatible = bundleProtocol !== null && bundleProtocol === serverProtocolVersion;
    return {
      compatible,
      bundleProtocolVersion: bundleProtocol,
      serverProtocolVersion,
      reason: compatible ? "PROTOCOL_MATCH" : bundleProtocol === null ? "PROTOCOL_UNKNOWN" : "PROTOCOL_MISMATCH"
    };
  }

  // Safe public projection. Deliberately carries NO absolute path — an operator UI never needs one and a
  // leaked disk layout is free reconnaissance.
  function projectEntry(entry, { isCurrent = false } = {}) {
    return Object.freeze({
      product: RELEASE_PRODUCT,
      version: entry.version,
      isCurrent,
      status: entry.status || "PUBLISHED",
      targetOs: entry.targetOs || "windows",
      targetArch: entry.targetArch || "x64",
      fileName: entry.fileName,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      deliveryProtocolVersion: entry.deliveryProtocolVersion ?? null,
      buildCommit: entry.buildCommit || null,
      builtAtIso: entry.builtAtIso || null,
      publishedAtIso: entry.publishedAtIso || null,
      signing: entry.signing || "UNSIGNED_INTERNAL_BUILD",
      nodeVersion: entry.nodeVersion || null,
      ffmpeg: entry.ffmpeg || null,
      cloakRequirement: entry.cloakRequirement || "BRING_YOUR_OWN",
      minServerVersion: entry.minServerVersion || null,
      maxServerVersion: entry.maxServerVersion || null,
      releaseNotes: entry.releaseNotes || null,
      documents: Array.isArray(entry.documents) ? entry.documents : [],
      compatibility: compatibilityOf(entry)
    });
  }

  function list() {
    const idx = readIndex();
    const cur = idx.currentVersion || null;
    return idx.releases
      .filter((r) => r && r.status !== "WITHDRAWN")
      .map((r) => projectEntry(r, { isCurrent: r.version === cur }))
      .sort((a, b) => (a.version < b.version ? 1 : -1));
  }

  function current() {
    const idx = readIndex();
    if (!idx.currentVersion) throw rerr(RELEASE_ERRORS.NOT_FOUND, "no current release");
    return projectEntry(entryOf(idx, idx.currentVersion), { isCurrent: true });
  }

  function describe(version) {
    const idx = readIndex();
    return projectEntry(entryOf(idx, version), { isCurrent: idx.currentVersion === version });
  }

  // Verify-then-open. The verification is the point: if the published bytes were replaced, moved or
  // truncated since publication, this refuses. A download endpoint that served them anyway would be
  // distributing something nobody signed off on.
  async function openArtifact(version, { force = false } = {}) {
    const idx = readIndex();
    const entry = entryOf(idx, version);
    const abs = resolveInRoot(entry.version, entry.fileName);
    if (!existsSync(abs)) throw rerr(RELEASE_ERRORS.FILE_MISSING, "release artifact missing");
    const st = statSync(abs);
    if (!st.isFile()) throw rerr(RELEASE_ERRORS.FILE_MISSING, "release artifact is not a file");
    if (Number(st.size) !== Number(entry.sizeBytes)) throw rerr(RELEASE_ERRORS.SIZE_MISMATCH, "release artifact size does not match the registry");

    const cached = verified.get(version);
    const fresh = cached && !force && (now() - cached.at) < verifyTtlMs && cached.size === st.size && cached.mtimeMs === st.mtimeMs;
    if (!fresh) {
      const actual = await sha256OfFileStreaming(abs);
      if (actual !== entry.sha256) {
        verified.delete(version);
        throw rerr(RELEASE_ERRORS.HASH_MISMATCH, "release artifact does not match its published SHA-256");
      }
      verified.set(version, { at: now(), sha256: actual, size: st.size, mtimeMs: st.mtimeMs });
    }
    return Object.freeze({
      version: entry.version,
      path: abs,                       // server-side only; never projected to a client
      fileName: entry.fileName,
      sizeBytes: Number(st.size),
      sha256: entry.sha256,
      contentType: "application/zip"
    });
  }

  // Documents shipped alongside the artifact (INSTALL.md etc). Same registry-only resolution.
  function readDocument(version, name) {
    const idx = readIndex();
    const entry = entryOf(idx, version);
    const allowed = Array.isArray(entry.documents) ? entry.documents : [];
    if (!allowed.includes(name)) throw rerr(RELEASE_ERRORS.NOT_FOUND, "unknown release document");
    const abs = resolveInRoot(entry.version, name);
    if (!existsSync(abs)) throw rerr(RELEASE_ERRORS.FILE_MISSING, "release document missing");
    return readFileSync(abs, "utf8");
  }

  function health() {
    try {
      const idx = readIndex();
      return { ok: true, releaseRootConfigured: true, currentVersion: idx.currentVersion || null, releaseCount: idx.releases.filter((r) => r.status !== "WITHDRAWN").length };
    } catch (e) {
      return { ok: false, releaseRootConfigured: true, code: e?.code || RELEASE_ERRORS.INDEX_MISSING, currentVersion: null, releaseCount: 0 };
    }
  }

  return Object.freeze({ list, current, describe, openArtifact, readDocument, health, _root: ROOT, _indexPath: indexPath });
}
