#!/usr/bin/env node
// There is no bundler here: the control plane is plain ESM run by Node, and the studio UI is hand-written ESM
// the browser loads directly. "build" therefore verifies that what would ship is loadable and complete, which
// is the property a bundler would otherwise give us for free.
//
//   1. every entry point imports cleanly (catches a broken module graph that --check cannot see)
//   2. every asset the UI references exists on disk
//
// Exit 1 on failure.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRIES = [
  "control-plane/src/main.mjs",
  "control-plane/src/app.mjs",
  "lib/protocol/index.mjs",
  "lib/providers/provider-registry.mjs",
  "lib/providers/mock-provider.mjs",
  "lib/media/asset-policy.mjs",
  "lib/media/ffmpeg-locator.mjs"
].filter((p) => existsSync(path.join(ROOT, p)));

let failed = 0;
for (const rel of ENTRIES) {
  try { await import(pathToFileURL(path.join(ROOT, rel)).href); console.log(`  ok   ${rel}`); }
  catch (e) { console.error(`  FAIL ${rel}: ${e.message}`); failed++; }
}

const shells = ["control-plane/staging-ui/prod/index.html", "control-plane/staging-ui/auth/index.html"]
  .filter((p) => existsSync(path.join(ROOT, p)));
const NAMESPACES = {
  "/assets/": ["control-plane/staging-ui/prod/assets", "control-plane/staging-ui/assets"],
  "/auth-assets/": ["control-plane/staging-ui/auth/assets"]
};
let assets = 0;
for (const shell of shells) {
  const dir = path.dirname(path.join(ROOT, shell));
  const html = readFileSync(path.join(ROOT, shell), "utf8");
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith("data:") || ref.startsWith("#")) continue;
    // Synthesized per request by the UI router (it embeds the runtime origin), so there is no file to find.
    if (ref === "/assets/runtime-config.js") continue;
    assets++;
    // These are server-side URL namespaces, not directories: /assets/* is served from prod/assets AND the
    // shared asset directory, /auth-assets/* from auth/assets. Resolving them as paths reports misses that
    // do not exist at runtime.
    const ns = Object.keys(NAMESPACES).find((p) => ref.startsWith(p));
    const candidates = ns
      ? NAMESPACES[ns].map((d) => path.join(ROOT, d, ref.slice(ns.length)))
      : [path.resolve(dir, ref.replace(/^\//, ""))];
    if (!candidates.some((c) => existsSync(c))) { console.error(`  FAIL ${shell} references missing asset ${ref}`); failed++; }
  }
}

// Every file an npm script runs must exist. A chained script that names a missing file fails on the day
// someone runs it, and in a tree assembled by copying a subset that is exactly what happens — four scripts
// here pointed at test files that were not part of the public export.
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

// Nothing may import a package the manifest does not declare. This is how ffmpeg-static kept reappearing:
// it was installed on the author's machine, so the import resolved locally and failed only for everyone else.
const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
const { execFileSync: exec } = await import("node:child_process");
let sources = [];
try { sources = exec("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n"); }
catch { sources = []; }
for (const rel of sources.filter((f) => /\.(mjs|js)$/.test(f))) {
  let src;
  try { src = readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
  for (const m of src.matchAll(/^[ \t]*import\s+[^;]*?from\s*["']([^."'][^"']*)["']/gm)) {
    const spec = m[1];
    // node: builtins, and URL paths the BROWSER resolves — the UI suites import page modules by their served
    // path, which is not an npm specifier and has no entry in package.json by design.
    if (spec.startsWith("node:") || spec.startsWith("/") || /^https?:/.test(spec)) continue;
    const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!declared.has(pkgName)) { console.error(`  FAIL ${rel} imports "${pkgName}", which package.json does not declare`); failed++; }
  }
}
const SCRIPT_FILE = /(?:^|\s)((?:tests|scripts|control-plane|lib)\/[A-Za-z0-9._/-]+\.(?:mjs|js))/g;
let scriptRefs = 0;
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  for (const m of String(cmd).matchAll(SCRIPT_FILE)) {
    scriptRefs++;
    if (!existsSync(path.join(ROOT, m[1]))) { console.error(`  FAIL npm script "${name}" runs ${m[1]}, which does not exist`); failed++; }
  }
}

console.log(`build: ${ENTRIES.length} entry points, ${assets} asset references from ${shells.length} shells, ${scriptRefs} npm script targets`);
if (failed) { console.error(`build: ${failed} failure(s)`); process.exit(1); }
console.log("build: ok");
