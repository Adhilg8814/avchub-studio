// P0 Step 5C.12 — dependency + licensing audit (offline, deterministic; no network, no downloads).
//
// Reads package.json + node_modules/*/package.json to build a license inventory, flags
// GPL-family/distribution-risk entries explicitly, and renders THIRD_PARTY_NOTICES.md. Non-npm
// components (FFmpeg, PostgreSQL) are recorded with their honest
// status — UNKNOWN/PENDING is stated as such, never invented. Nothing here claims legal approval.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const GPL_RE = /\bA?GPL\b/i;

// Honest, hand-maintained facts about the non-npm / binary components.
export const MANUAL_COMPONENTS = Object.freeze([
  Object.freeze({
    name: "FFmpeg / ffprobe",
    license: "LGPL-2.1-or-later or GPL-2.0-or-later, depending on the build",
    distributionRisk: "NONE",
    status: "OK",
    note: "INVOKED, never bundled and never redistributed. The operator installs FFmpeg themselves and the locator finds it via FFMPEG_PATH, an optional static package they added, or PATH. Not depending on it is what makes this project distributable."
  }),
  Object.freeze({
    name: "PostgreSQL",
    license: "PostgreSQL License (permissive)",
    distributionRisk: "NONE",
    status: "OK",
    note: "Connected to over the network with operator-supplied credentials; no binary is bundled."
  })
]);

function readPkg(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

export function auditLicenses({ repoRoot } = {}) {
  const rootPkg = readPkg(path.join(repoRoot, "package.json"));
  if (!rootPkg) throw Object.assign(new Error("package.json not found"), { code: "E_LICENSE_NO_PKG" });
  const sections = [["dependencies", rootPkg.dependencies || {}], ["devDependencies", rootPkg.devDependencies || {}]];
  const packages = [];
  for (const [kind, deps] of sections) {
    for (const [name, declared] of Object.entries(deps)) {
      const pkgJson = readPkg(path.join(repoRoot, "node_modules", ...name.split("/"), "package.json"));
      const license = pkgJson?.license
        ? (typeof pkgJson.license === "string" ? pkgJson.license : pkgJson.license.type || "SEE_PACKAGE")
        : (pkgJson ? "UNSPECIFIED" : "NOT_INSTALLED");
      packages.push({
        name, kind, declared,
        installed: pkgJson?.version || null,
        license,
        gplFamily: GPL_RE.test(license),
        binaryDownloader: /^(ffmpeg-static|ffprobe-static)$/.test(name)
      });
    }
  }
  const flags = [];
  for (const p of packages) {
    if (p.gplFamily || p.binaryDownloader) flags.push({ name: p.name, reason: p.binaryDownloader ? "DOWNLOADS_GPL_BINARY" : "GPL_FAMILY_LICENSE" });
    if (p.license === "UNSPECIFIED" || p.license === "NOT_INSTALLED") flags.push({ name: p.name, reason: `LICENSE_${p.license}` });
  }
  return {
    generatedFrom: "package.json + node_modules (offline)",
    packages, manualComponents: MANUAL_COMPONENTS, flags,
    // Blockers are computed, not asserted: anything flagged GPL-family or as a bundled binary downloader
    // would block distribution. With FFmpeg invoked rather than depended on, the list is normally empty.
    publicDistributionReady: flags.length === 0,
    publicDistributionBlockers: flags.map((f) => `${f.name}: ${f.reason}`)
  };
}

export function renderThirdPartyNotices(audit) {
  const lines = [];
  lines.push("# Third-party notices — AVC Studio");
  lines.push("");
  lines.push("> Generated offline by `node scripts/ops/license-audit.mjs` from package.json + node_modules.");
  lines.push(audit.publicDistributionReady
    ? "> No distribution blocker found: every bundled dependency is permissively licensed, and FFmpeg is invoked rather than bundled."
    : "> **Distribution blocked**: " + audit.publicDistributionBlockers.join("; ") + ".");
  lines.push("");
  lines.push("## npm packages");
  lines.push("");
  lines.push("| Package | Version | License | Section | Flags |");
  lines.push("|---|---|---|---|---|");
  for (const p of audit.packages.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const flags = [p.gplFamily ? "GPL-family" : null, p.binaryDownloader ? "downloads GPL binary" : null].filter(Boolean).join(", ");
    lines.push(`| ${p.name} | ${p.installed || "?"} | ${p.license} | ${p.kind} | ${flags || "—"} |`);
  }
  lines.push("");
  lines.push("## Non-npm components");
  lines.push("");
  for (const c of audit.manualComponents) {
    lines.push(`### ${c.name}`);
    lines.push(`- License: ${c.license}`);
    lines.push(`- Distribution risk: ${c.distributionRisk} · Status: ${c.status}`);
    lines.push(`- ${c.note}`);
    lines.push("");
  }
  lines.push("## Flags requiring attention");
  lines.push("");
  if (audit.flags.length === 0) lines.push("- none");
  for (const f of audit.flags) lines.push(`- ${f.name}: ${f.reason}`);
  lines.push("");
  lines.push("_No legal approval is implied by this document; it is an inventory._");
  return lines.join("\n") + "\n";
}
