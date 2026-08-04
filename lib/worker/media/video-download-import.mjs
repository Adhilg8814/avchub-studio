// P0 Step 5C.9A — bounded provider-result download and atomic local import.
//
// Provider URLs are strictly internal inputs. Returned metadata and public errors
// contain no URL or absolute path. Redirects are manual and each destination must
// pass an injected policy. No cookies, authorization headers, ambient credentials,
// shell, browser, or provider-specific behavior live here.

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { validateId } from "../../protocol/ids.mjs";
import { assertRecordSafe, isRelativeRef } from "../journal-safety.mjs";
import {
  inspectMp4File,
  MediaSafetyError,
  MP4_DEFAULT_LIMITS,
  MP4_ERRORS,
  normalizeMp4Limits
} from "./mp4-validator.mjs";

export const VIDEO_IMPORT_DEFAULTS = Object.freeze({
  ...MP4_DEFAULT_LIMITS,
  timeoutMs: 5 * 60 * 1000,
  maxRedirects: 3
});

export const VIDEO_IMPORT_ERRORS = Object.freeze({
  ...MP4_ERRORS,
  E_MEDIA_SOURCE_REJECTED: "E_MEDIA_SOURCE_REJECTED",
  E_MEDIA_REDIRECT_LIMIT: "E_MEDIA_REDIRECT_LIMIT",
  E_MEDIA_HTTP_FAILED: "E_MEDIA_HTTP_FAILED",
  E_MEDIA_TIMEOUT: "E_MEDIA_TIMEOUT",
  E_MEDIA_ABORTED: "E_MEDIA_ABORTED",
  E_MEDIA_DEST_EXISTS: "E_MEDIA_DEST_EXISTS",
  E_MEDIA_IMPORT_FAILED: "E_MEDIA_IMPORT_FAILED"
});

export class VideoImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VideoImportError";
    this.code = code;
  }
}

function fail(code, message) { throw new VideoImportError(code, message); }

function isLoopback(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}

// Exact origins only. HTTP is allowed solely for an explicitly allowlisted loopback
// origin in local tests; normal provider destinations must be HTTPS.
export function createExactOriginPolicy({ allowedOrigins = [], allowHttpLoopback = false } = {}) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "At least one media origin must be allowlisted");
  }
  const origins = new Set();
  for (const raw of allowedOrigins) {
    let parsed;
    try { parsed = new URL(raw); } catch { fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media origin allowlist is invalid"); }
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media origin allowlist is invalid");
    }
    if (parsed.protocol !== "https:" && !(allowHttpLoopback && parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
      fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media origin scheme is not allowed");
    }
    origins.add(parsed.origin);
  }
  return Object.freeze({
    assertAllowed(value) {
      let parsed;
      try { parsed = value instanceof URL ? new URL(value.href) : new URL(value); }
      catch { fail(VIDEO_IMPORT_ERRORS.E_MEDIA_SOURCE_REJECTED, "Media source is not allowed"); }
      if (parsed.username || parsed.password || !origins.has(parsed.origin)) {
        fail(VIDEO_IMPORT_ERRORS.E_MEDIA_SOURCE_REJECTED, "Media source is not allowed");
      }
      if (parsed.protocol !== "https:" && !(allowHttpLoopback && parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
        fail(VIDEO_IMPORT_ERRORS.E_MEDIA_SOURCE_REJECTED, "Media source is not allowed");
      }
      parsed.hash = "";
      return parsed;
    }
  });
}

function normalizeOptions(options) {
  const limits = normalizeMp4Limits(options);
  const timeoutMs = options.timeoutMs ?? VIDEO_IMPORT_DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? VIDEO_IMPORT_DEFAULTS.maxRedirects;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30 * 60 * 1000) {
    fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media timeout is invalid");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) {
    fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media redirect limit is invalid");
  }
  return Object.freeze({ ...limits, timeoutMs, maxRedirects });
}

function assertRelativeDirectory(value) {
  if (!isRelativeRef(value) || value.length > 240) {
    fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media destination reference is invalid");
  }
  const segments = value.split("/");
  if (segments.some((part) => part === "." || part === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(part))) {
    fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media destination reference is invalid");
  }
  return segments.join("/");
}

function safeFileName(generationAttemptId) {
  if (!validateId(generationAttemptId, "attempt")) {
    fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Generation attempt identity is invalid");
  }
  const digest = createHash("sha256").update(generationAttemptId, "utf8").digest("hex").slice(0, 24);
  return `video_${digest}.mp4`;
}

function bodyAsNodeStream(body) {
  if (!body) fail(VIDEO_IMPORT_ERRORS.E_MEDIA_HTTP_FAILED, "Media response has no body");
  if (body instanceof Readable) return body;
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  if (typeof body[Symbol.asyncIterator] === "function" || typeof body[Symbol.iterator] === "function") return Readable.from(body);
  fail(VIDEO_IMPORT_ERRORS.E_MEDIA_HTTP_FAILED, "Media response body is unsupported");
}

async function cancelBody(response) {
  try { await response?.body?.cancel?.(); } catch { /* best effort */ }
  try { response?.body?.destroy?.(); } catch { /* best effort */ }
}

async function fetchApprovedResponse({ source, fetchImpl, originPolicy, signal, maxRedirects }) {
  let current = originPolicy.assertAllowed(source);
  for (let redirects = 0; ; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { Accept: "video/mp4, application/octet-stream;q=0.8" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
    } catch (err) {
      if (signal.aborted) throw err;
      fail(VIDEO_IMPORT_ERRORS.E_MEDIA_HTTP_FAILED, "Media request failed");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= maxRedirects) {
        await cancelBody(response);
        fail(VIDEO_IMPORT_ERRORS.E_MEDIA_REDIRECT_LIMIT, "Media redirect limit was exceeded");
      }
      const location = response.headers?.get?.("location");
      await cancelBody(response);
      if (!location) fail(VIDEO_IMPORT_ERRORS.E_MEDIA_HTTP_FAILED, "Media redirect was invalid");
      let next;
      try { next = new URL(location, current); }
      catch { fail(VIDEO_IMPORT_ERRORS.E_MEDIA_SOURCE_REJECTED, "Media redirect was not allowed"); }
      current = originPolicy.assertAllowed(next);
      continue;
    }
    if (response.status !== 200) {
      await cancelBody(response);
      fail(VIDEO_IMPORT_ERRORS.E_MEDIA_HTTP_FAILED, "Media request did not succeed");
    }
    return response;
  }
}

function makeAbortScope(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = externalSignal?.aborted === true;
  const onExternalAbort = () => { externallyAborted = true; controller.abort(); };
  if (externalSignal) externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  if (externallyAborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    get externallyAborted() { return externallyAborted; },
    close() {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
    }
  };
}

function isKnownError(err) {
  return err instanceof VideoImportError || err instanceof MediaSafetyError;
}

export async function downloadAndImportVideo({
  source,
  outputRoot,
  relativeDirectory = "media/video",
  generationAttemptId,
  originPolicy,
  fetchImpl = globalThis.fetch,
  unlinkImpl = unlink,
  signal = undefined,
  ...rawOptions
} = {}) {
  if (typeof fetchImpl !== "function" || typeof unlinkImpl !== "function" ||
      !originPolicy || typeof originPolicy.assertAllowed !== "function") {
    fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media download dependencies are not configured");
  }
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) {
    fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media output root is invalid");
  }
  const options = normalizeOptions(rawOptions);
  const relDir = assertRelativeDirectory(relativeDirectory);
  const fileName = safeFileName(generationAttemptId);
  const relativePath = path.posix.join(relDir, fileName);
  const abortScope = makeAbortScope(signal, options.timeoutMs);
  let partialPath = null;
  let stage = "prepare";

  try {
    await mkdir(outputRoot, { recursive: true });
    const realRoot = await realpath(outputRoot);
    const requestedDir = path.join(realRoot, ...relDir.split("/"));
    await mkdir(requestedDir, { recursive: true });
    const realDir = await realpath(requestedDir);
    const containment = path.relative(realRoot, realDir);
    if (containment.startsWith("..") || path.isAbsolute(containment)) {
      fail(VIDEO_IMPORT_ERRORS.E_MEDIA_CONFIG, "Media destination escaped its root");
    }
    const finalPath = path.join(realDir, fileName);
    partialPath = path.join(realDir, `.${fileName}.part-${randomBytes(12).toString("hex")}`);

    stage = "request";
    const response = await fetchApprovedResponse({
      source, fetchImpl, originPolicy, signal: abortScope.signal, maxRedirects: options.maxRedirects
    });
    const contentType = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
      await cancelBody(response);
      fail(VIDEO_IMPORT_ERRORS.E_MEDIA_INVALID, "Media response type is not allowed");
    }
    const lengthHeader = response.headers?.get?.("content-length");
    if (lengthHeader && /^\d+$/.test(lengthHeader)) {
      const advertised = Number(lengthHeader);
      if (!Number.isSafeInteger(advertised) || advertised > options.maxBytes) {
        await cancelBody(response);
        fail(VIDEO_IMPORT_ERRORS.E_MEDIA_TOO_LARGE, "Media exceeds the configured safety maximum");
      }
    }

    stage = "stream";
    let sizeBytes = 0;
    const hash = createHash("sha256");
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += bytes.length;
        if (sizeBytes > options.maxBytes) {
          callback(new VideoImportError(VIDEO_IMPORT_ERRORS.E_MEDIA_TOO_LARGE, "Media exceeds the configured safety maximum"));
          return;
        }
        hash.update(bytes);
        callback(null, bytes);
      }
    });
    await pipeline(
      bodyAsNodeStream(response.body),
      limiter,
      createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
      { signal: abortScope.signal }
    );

    stage = "validate";
    const validation = await inspectMp4File(partialPath, options);
    if (validation.sizeBytes !== sizeBytes) fail(VIDEO_IMPORT_ERRORS.E_MEDIA_INVALID, "Media size changed during validation");
    // Windows requires a writable handle for FlushFileBuffers/fsync.
    const handle = await open(partialPath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }

    stage = "commit";
    try {
      // Same-directory hard-link publication is atomic and fails if finalPath already
      // exists. Removing the private partial link afterwards cannot expose a partial.
      await link(partialPath, finalPath);
    } catch (err) {
      if (err?.code === "EEXIST") fail(VIDEO_IMPORT_ERRORS.E_MEDIA_DEST_EXISTS, "Media destination already exists");
      fail(VIDEO_IMPORT_ERRORS.E_MEDIA_IMPORT_FAILED, "Media could not be committed atomically");
    }
    // Publication is already committed once the hard link succeeds. Failure to
    // remove the private link must never turn that committed artifact into an
    // ambiguous failure; the finally block makes one further best-effort cleanup.
    try {
      await unlinkImpl(partialPath);
      partialPath = null;
    } catch { /* committed final artifact remains authoritative */ }

    const metadata = Object.freeze({
      relativePath,
      fileName,
      mimeType: "video/mp4",
      sizeBytes,
      checksum: `sha256:${hash.digest("hex")}`
    });
    assertRecordSafe(metadata);
    return metadata;
  } catch (err) {
    if (abortScope.timedOut) throw new VideoImportError(VIDEO_IMPORT_ERRORS.E_MEDIA_TIMEOUT, "Media download timed out");
    if (abortScope.externallyAborted) throw new VideoImportError(VIDEO_IMPORT_ERRORS.E_MEDIA_ABORTED, "Media download was canceled");
    if (isKnownError(err)) throw err;
    throw new VideoImportError(VIDEO_IMPORT_ERRORS.E_MEDIA_IMPORT_FAILED, `Media download or import failed safely (${stage})`);
  } finally {
    abortScope.close();
    if (partialPath) {
      try { await rm(partialPath, { force: true }); } catch { /* best effort */ }
    }
  }
}
