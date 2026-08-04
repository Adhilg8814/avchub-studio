// P0 Step 5C.9A — bounded, provider-neutral MP4 structural validation.
//
// This module intentionally does not try to decode media or identify codecs. It
// checks the safety properties needed before a provider download is committed:
// bounded size, non-text content, a structurally valid top-level ISO-BMFF box
// sequence, one valid `ftyp`, and both `moov` and non-empty `mdat` boxes.
// File validation reads only small box headers/probes; media payloads are skipped.

import { open, stat } from "node:fs/promises";

export const MP4_DEFAULT_LIMITS = Object.freeze({
  minBytes: 32 * 1024,
  maxBytes: 512 * 1024 * 1024
});

const MIN_CONFIGURABLE_BYTES = 1024;
const HARD_MAX_BYTES = MP4_DEFAULT_LIMITS.maxBytes;
const MAX_TOP_LEVEL_BOXES = 8192;
const MAX_FTYP_PROBE_BYTES = 4096;

export const MP4_ERRORS = Object.freeze({
  E_MEDIA_CONFIG: "E_MEDIA_CONFIG",
  E_MEDIA_TOO_SMALL: "E_MEDIA_TOO_SMALL",
  E_MEDIA_TOO_LARGE: "E_MEDIA_TOO_LARGE",
  E_MEDIA_INVALID: "E_MEDIA_INVALID"
});

export class MediaSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MediaSafetyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MediaSafetyError(code, message);
}

export function normalizeMp4Limits(options = {}) {
  const minBytes = options.minBytes ?? MP4_DEFAULT_LIMITS.minBytes;
  const maxBytes = options.maxBytes ?? MP4_DEFAULT_LIMITS.maxBytes;
  if (!Number.isSafeInteger(minBytes) || minBytes < MIN_CONFIGURABLE_BYTES) {
    fail(MP4_ERRORS.E_MEDIA_CONFIG, "Minimum media size is invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < minBytes || maxBytes > HARD_MAX_BYTES) {
    fail(MP4_ERRORS.E_MEDIA_CONFIG, "Maximum media size is invalid");
  }
  return Object.freeze({ minBytes, maxBytes });
}

function assertBoundedSize(sizeBytes, limits) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    fail(MP4_ERRORS.E_MEDIA_INVALID, "Media size is invalid");
  }
  if (sizeBytes < limits.minBytes) {
    fail(MP4_ERRORS.E_MEDIA_TOO_SMALL, "Media is smaller than the configured safety minimum");
  }
  if (sizeBytes > limits.maxBytes) {
    fail(MP4_ERRORS.E_MEDIA_TOO_LARGE, "Media exceeds the configured safety maximum");
  }
}

function looksLikeTextOrMarkup(prefix) {
  if (!prefix || prefix.length === 0) return true;
  let offset = 0;
  // UTF-8 BOM is meaningful for text, not a valid first ISO-BMFF box header.
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) return true;
  while (offset < prefix.length && [0x09, 0x0a, 0x0d, 0x20].includes(prefix[offset])) offset += 1;
  const s = prefix.subarray(offset, Math.min(prefix.length, offset + 96)).toString("ascii").toLowerCase();
  return s.startsWith("<!doctype") || s.startsWith("<html") || s.startsWith("<body")
    || s.startsWith("<?xml") || s.startsWith("{") || s.startsWith("[")
    || s.startsWith("http/") || s.startsWith("%pdf-");
}

function boxType(buffer, offset = 0) {
  if (buffer.length - offset < 4) fail(MP4_ERRORS.E_MEDIA_INVALID, "Media box type is truncated");
  for (let i = offset; i < offset + 4; i += 1) {
    if (buffer[i] < 0x20 || buffer[i] > 0x7e) {
      fail(MP4_ERRORS.E_MEDIA_INVALID, "Media box type is invalid");
    }
  }
  return buffer.toString("ascii", offset, offset + 4);
}

function parseBoxHeader(header, remainingBytes) {
  if (header.length < 8) fail(MP4_ERRORS.E_MEDIA_INVALID, "Media box header is truncated");
  const size32 = header.readUInt32BE(0);
  const type = boxType(header, 4);
  let headerBytes = 8;
  let sizeBytes = size32;
  if (size32 === 1) {
    if (header.length < 16) fail(MP4_ERRORS.E_MEDIA_INVALID, "Extended media box header is truncated");
    const extended = header.readBigUInt64BE(8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail(MP4_ERRORS.E_MEDIA_INVALID, "Extended media box is too large");
    }
    sizeBytes = Number(extended);
    headerBytes = 16;
  } else if (size32 === 0) {
    sizeBytes = remainingBytes;
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < headerBytes || sizeBytes > remainingBytes) {
    fail(MP4_ERRORS.E_MEDIA_INVALID, "Media box length is invalid");
  }
  return { type, sizeBytes, headerBytes, extendsToEnd: size32 === 0 };
}

function validateFtyp(payload) {
  if (payload.length < 8 || (payload.length - 8) % 4 !== 0) {
    fail(MP4_ERRORS.E_MEDIA_INVALID, "MP4 file-type box is invalid");
  }
  const majorBrand = boxType(payload, 0);
  if (!majorBrand.trim()) fail(MP4_ERRORS.E_MEDIA_INVALID, "MP4 major brand is invalid");
  for (let offset = 8; offset < payload.length; offset += 4) boxType(payload, offset);
  return majorBrand;
}

async function validateReader(sizeBytes, readAt, options = {}) {
  const limits = normalizeMp4Limits(options);
  assertBoundedSize(sizeBytes, limits);
  const prefix = await readAt(0, Math.min(128, sizeBytes));
  if (looksLikeTextOrMarkup(prefix)) fail(MP4_ERRORS.E_MEDIA_INVALID, "Media content is not an MP4 file");

  let offset = 0;
  let boxCount = 0;
  let majorBrand = null;
  let sawFtyp = false;
  let sawMoov = false;
  let sawMdat = false;

  while (offset < sizeBytes) {
    if (++boxCount > MAX_TOP_LEVEL_BOXES) fail(MP4_ERRORS.E_MEDIA_INVALID, "Media has too many top-level boxes");
    const remaining = sizeBytes - offset;
    if (remaining < 8) fail(MP4_ERRORS.E_MEDIA_INVALID, "Media has trailing truncated data");
    const shortHeader = await readAt(offset, Math.min(16, remaining));
    const parsed = parseBoxHeader(shortHeader, remaining);
    if (parsed.type === "ftyp") {
      if (sawFtyp || parsed.sizeBytes - parsed.headerBytes > MAX_FTYP_PROBE_BYTES) {
        fail(MP4_ERRORS.E_MEDIA_INVALID, "MP4 file-type box is invalid");
      }
      const payload = await readAt(offset + parsed.headerBytes, parsed.sizeBytes - parsed.headerBytes);
      majorBrand = validateFtyp(payload);
      sawFtyp = true;
    } else if (parsed.type === "moov") {
      sawMoov = true;
    } else if (parsed.type === "mdat") {
      if (parsed.sizeBytes <= parsed.headerBytes) fail(MP4_ERRORS.E_MEDIA_INVALID, "MP4 media-data box is empty");
      sawMdat = true;
    }
    offset += parsed.sizeBytes;
    if (parsed.extendsToEnd && offset !== sizeBytes) {
      fail(MP4_ERRORS.E_MEDIA_INVALID, "Terminal media box length is invalid");
    }
  }

  if (!sawFtyp || !sawMoov || !sawMdat) {
    fail(MP4_ERRORS.E_MEDIA_INVALID, "Media is missing required MP4 structure");
  }
  return Object.freeze({
    mimeType: "video/mp4",
    sizeBytes,
    majorBrand,
    boxCount,
    hasMovieBox: true,
    hasMediaData: true
  });
}

export async function validateMp4Bytes(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail(MP4_ERRORS.E_MEDIA_INVALID, "Media bytes are invalid");
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return validateReader(buffer.length, async (offset, length) => buffer.subarray(offset, offset + length), options);
}

export async function inspectMp4File(filePath, options = {}) {
  let handle;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) fail(MP4_ERRORS.E_MEDIA_INVALID, "Media is not a regular file");
    handle = await open(filePath, "r");
    return await validateReader(info.size, async (offset, length) => {
      const out = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(out, read, length - read, offset + read);
        if (result.bytesRead <= 0) fail(MP4_ERRORS.E_MEDIA_INVALID, "Media ended unexpectedly");
        read += result.bytesRead;
      }
      return out;
    }, options);
  } catch (err) {
    if (err instanceof MediaSafetyError) throw err;
    throw new MediaSafetyError(MP4_ERRORS.E_MEDIA_INVALID, "Media could not be inspected safely");
  } finally {
    try { await handle?.close(); } catch { /* best effort */ }
  }
}
