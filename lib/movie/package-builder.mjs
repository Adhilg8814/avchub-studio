// P0 Step 5C.11 — downloadable publishing package builder (pure Node, no new dependencies).
//
// Builds the Facebook-independent deliverable: a folder + a single .zip containing the final MP4,
// poster thumbnail, subtitles, caption.txt, and a REDACTED metadata.json correlation manifest
// (ids/hashes/sizes only — never prompts-in-full, secrets, absolute paths, or provider URLs).
// The zip writer implements the ZIP APPNOTE "store" method directly (CRC-32 + local file headers +
// central directory) so standard tools (Explorer, Expand-Archive, unzip) open it.

import { mkdir, readFile, writeFile, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

function err(code, message) { return Object.assign(new Error(message), { code }); }

// ---- CRC-32 (IEEE 802.3 polynomial, table-driven) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(0);
  const year = Math.max(1980, d.getFullYear());
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime, dosDate };
}

// Build a store-method zip from entries [{ name, data (Buffer) }]. Entry names are validated as
// safe forward-slash relative paths. Returns the zip Buffer.
export function buildZipBuffer(entries, { now = () => new Date(0) } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw err("E_PACKAGE_EMPTY", "at least one entry is required");
  const { dosTime, dosDate } = dosDateTime(now());
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    // Leading dot allows tracked dotfiles (.gitignore); ".." and path separators outside the safe
    // charset (no backslash, no colon → no absolute/drive paths) stay impossible.
    if (typeof e?.name !== "string" || !/^[A-Za-z0-9.][A-Za-z0-9 ._\-/]{0,180}$/.test(e.name) || e.name.includes("..") || e.name.endsWith("/") || e.name.startsWith("/")) {
      throw err("E_PACKAGE_ENTRY_NAME", "unsafe zip entry name");
    }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(Buffer.concat([central, name]));
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export async function sha256File(file) {
  const buf = await readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

// Build the publishing package for one completed render. Inputs are Worker-local absolute paths
// (validated to exist); the manifest carries ONLY redacted correlation (ids/ordinals/hashes/sizes).
// Returns { packageDir, zipPath, zipSizeBytes, files: [names], manifest }.
export async function buildPublishingPackage({
  packageDir, finalPath, thumbnailPath = null, srtPath = null,
  caption = "", title = "", project = null, scenes = [], render = null, now = () => new Date(0)
}) {
  if (typeof packageDir !== "string" || !path.isAbsolute(packageDir)) throw err("E_PACKAGE_DIR", "absolute package dir required");
  if (typeof finalPath !== "string" || !existsSync(finalPath)) throw err("E_PACKAGE_NO_VIDEO", "the final video file is missing");
  await mkdir(packageDir, { recursive: true });

  const finalInfo = await stat(finalPath);
  const finalSha = await sha256File(finalPath);
  const safeCaption = String(caption ?? "").replace(/\r/g, "").slice(0, 4000);
  const manifest = {
    schema: "avc-publishing-package/1",
    title: String(title ?? "").slice(0, 200),
    projectId: project?.id ?? null,
    render: render ? { id: render.id ?? null, version: render.version ?? null, renderHash: render.renderHash ?? null } : null,
    video: { fileName: "final.mp4", sizeBytes: finalInfo.size, sha256: finalSha, durationSeconds: render?.finalMedia?.durationSeconds ?? null, width: render?.finalMedia?.width ?? null, height: render?.finalMedia?.height ?? null },
    scenes: (scenes || []).map((s) => ({
      ordinal: s.ordinal, heading: s.heading ?? null, state: s.state ?? null,
      generationJobId: s.generationJobId ?? null, generationAttemptId: s.generationAttemptId ?? null,
      resultId: s.resultId ?? null, durationSeconds: s.durationSeconds ?? null
    })),
    generatedAt: now().toISOString()
  };
  // Refuse to write anything that looks like a secret/URL/absolute path into the manifest.
  const manifestJson = JSON.stringify(manifest, null, 2);
  if (/[A-Za-z]:\\\\/.test(manifestJson) || /(token|cookie|password|proxy|credential)/i.test(manifestJson)) {
    throw err("E_PACKAGE_MANIFEST_UNSAFE", "manifest must stay redacted");
  }

  await copyFile(finalPath, path.join(packageDir, "final.mp4"));
  const files = ["final.mp4", "caption.txt", "metadata.json"];
  await writeFile(path.join(packageDir, "caption.txt"), safeCaption || manifest.title || "", "utf8");
  await writeFile(path.join(packageDir, "metadata.json"), manifestJson, "utf8");
  if (thumbnailPath && existsSync(thumbnailPath)) { await copyFile(thumbnailPath, path.join(packageDir, "thumbnail.jpg")); files.push("thumbnail.jpg"); }
  if (srtPath && existsSync(srtPath)) { await copyFile(srtPath, path.join(packageDir, "subtitles.srt")); files.push("subtitles.srt"); }

  const entries = [];
  for (const name of files) entries.push({ name, data: await readFile(path.join(packageDir, name)) });
  const zip = buildZipBuffer(entries, { now });
  const zipPath = path.join(packageDir, "package.zip");
  await writeFile(zipPath, zip);
  return { packageDir, zipPath, zipSizeBytes: zip.length, files, manifest };
}
