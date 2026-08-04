// P0 Step 5C.1 — module dependency-boundary scanner (dev/test utility).
//
// Static import scan that enforces the Control Plane core boundary (task §15). This file is
// imported ONLY by tests — never by the running server — so the core stays free of fs.
//
// The Control Plane core MAY import shared PURE protocol modules (lib/protocol/*). It MUST
// NOT import ui-server, WorkerRuntime, worker handlers, provider adapters, the local
// Control Plane simulator, browser/Python code, or local media implementations.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Forbidden substrings in an import/require specifier.
export const FORBIDDEN_IMPORT_SUBSTRINGS = Object.freeze([
  "ui-server",
  "lib/worker",            // WorkerRuntime, handlers, providers, recovery runtime, simulator client
  "lib/control",           // local Control Plane simulator + cloud store
  "lib/grok-video",
  "grok-video-browser",
  "provider-session",
  "provider-smoke",
  "provider-accounts",
  "worker-runtime",
  "local-control-plane",
  "local-cloud-store",
  "local-worker",
  "video-projects",
  "video-export",
  "puppeteer",
  "playwright",
  ".py"
]);

// Provider/brand + browser terms that must not appear as an import target.
export const FORBIDDEN_IMPORT_REGEXES = Object.freeze([
  /(^|[/'"])ui\//i,               // Studio UI modules
  /\b(chatgpt|elevenlabs|cloakbrowser)\b/i
]);

// Allowed cross-repo import prefixes (pure protocol values only).
const ALLOWED_CROSS_REPO = [/lib\/protocol\//];

function listMjs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listMjs(full));
    else if (entry.endsWith(".mjs")) out.push(full);
  }
  return out;
}

// Extract import/export-from/dynamic-import specifiers from source text.
function extractSpecifiers(src) {
  const specs = [];
  const patterns = [
    /\bimport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g
  ];
  for (const re of patterns) { let m; while ((m = re.exec(src))) specs.push(m[1]); }
  return specs;
}

// scanForbiddenImports(rootDir): returns [{ file, specifier, rule }] violations (empty = ok).
export function scanForbiddenImports(rootDir) {
  const violations = [];
  for (const file of listMjs(rootDir)) {
    const src = readFileSync(file, "utf8");
    for (const spec of extractSpecifiers(src)) {
      if (ALLOWED_CROSS_REPO.some((re) => re.test(spec))) continue;
      for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) {
        if (spec.includes(bad)) violations.push({ file, specifier: spec, rule: bad });
      }
      for (const re of FORBIDDEN_IMPORT_REGEXES) {
        if (re.test(spec)) violations.push({ file, specifier: spec, rule: re.source });
      }
    }
  }
  return violations;
}
