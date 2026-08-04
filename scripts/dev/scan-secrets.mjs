#!/usr/bin/env node
// Refuse to ship a secret. Runs over the tracked tree, in CI and before a release.
//
// Two classes are checked separately because they need different reactions: a CREDENTIAL is an incident (the
// value must be rotated, not merely deleted), while a PRIVATE IDENTIFIER is a privacy problem (replace it with
// a placeholder). Both fail the build.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const CREDENTIALS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\beyJhbGciO[A-Za-z0-9_-]{10,}/, "JSON web token"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9]{24,}/, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\b[a-z]+:\/\/[^\s/:@]+:[^\s/@]{6,}@/, "credential embedded in a URL"],
  [/\botpauth:\/\/totp\/[^\s"']*secret=[A-Z2-7]{16,}/i, "TOTP enrolment secret"]
];

const IDENTIFIERS = [
  [/\bavchub\.com\b/i, "the maintainer's production domain"],
  [/FACEBOOK-5C8/, "the private repository name"],
  [/DESKTOP-[A-Z0-9]{5,}/, "a machine name"],
  [/[A-Za-z]:[\\/]Users[\\/](?!operator\b|Default\b)[A-Za-z0-9._-]+/, "a personal home directory"]
];

const SKIP_FILE = /^(scripts\/dev\/scan-secrets\.mjs|SECURITY\.md)$/;
const BINARY = /\.(png|jpe?g|gif|webp|mp4|mp3|wav|zip|exe|dll|pdf|ico|woff2?)$/i;

const SKIP_DIR = /^(node_modules|\.git|dist|coverage)$/;

// Falls back to walking the filesystem when git is unavailable — a downloaded tarball has no repository, and
// a check that silently examines zero files is worse than one that refuses to run.
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
  }
  return out;
}

function listFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return walk(ROOT); }
}

const files = listFiles().filter((f) => !BINARY.test(f) && !SKIP_FILE.test(f));

// A deliberate non-secret — a redaction fixture, a connection-string template — is annotated in place with
// `scan-secrets:allow <reason>`. Requiring the reason on the line keeps the exception visible to the next
// reader and to review, which a silent path allowlist would not.
const ALLOW_MARKER = /scan-secrets:allow\s+\S/;

const findings = [];
let suppressed = 0;
for (const rel of files) {
  let text;
  try { text = readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // The marker may sit on the line itself or on the line above, for values too long to annotate in place.
    const allowed = ALLOW_MARKER.test(line) || (i > 0 && ALLOW_MARKER.test(lines[i - 1]));
    const hits = [];
    for (const [re, label] of CREDENTIALS) if (re.test(line)) hits.push({ severity: "CREDENTIAL", rel, line: i + 1, label });
    for (const [re, label] of IDENTIFIERS) if (re.test(line)) hits.push({ severity: "IDENTIFIER", rel, line: i + 1, label });
    if (allowed) suppressed += hits.length; else findings.push(...hits);
  });
}

console.log(`scan-secrets: ${files.length} text files${suppressed ? `, ${suppressed} annotated exception(s)` : ""}`);
if (!findings.length) { console.log("scan-secrets: clean"); process.exit(0); }
for (const f of findings) console.error(`  [${f.severity}] ${f.rel}:${f.line} — ${f.label}`);
console.error(`scan-secrets: ${findings.length} finding(s).`);
console.error("A CREDENTIAL finding means the value must be ROTATED, not just deleted from the file.");
process.exit(1);
