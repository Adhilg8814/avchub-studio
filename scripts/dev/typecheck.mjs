#!/usr/bin/env node
// Static checks. This project is plain ESM JavaScript with no TypeScript and no build step, so "typecheck"
// here means the two things a type checker would otherwise catch first, and the two that actually break this
// codebase in practice:
//
//   1. every relative import resolves to a file that exists
//   2. every named import exists in the module it names
//
// The second is the one that matters: renaming an export and missing a caller produces a runtime crash on a
// code path that may not run for days, which is exactly the failure a type checker prevents.
//
// Adding TypeScript with checkJs is on the roadmap; it is a large change to a codebase never annotated for it,
// and pretending it already runs would be worse than saying so.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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

const files = listFiles().filter((f) => /\.(mjs|js)$/.test(f) && !/^node_modules\//.test(f));

const problems = [];
const exportsOf = new Map();

// The browser sees ONE flat /assets/ namespace; the filesystem has two directories behind it, because the
// production UI reuses shared modules from the older asset directory (production-ui.mjs, SHARED_NAMES). A
// `./dom.js` inside prod/assets is therefore correct even though dom.js sits in the sibling directory —
// resolving it purely by directory would report a dozen problems that do not exist at runtime.
const UI_ASSET_NAMESPACE = [
  path.join(ROOT, "control-plane", "staging-ui", "prod", "assets"),
  path.join(ROOT, "control-plane", "staging-ui", "assets")
];

function resolveImport(fromAbs, spec) {
  const direct = path.resolve(path.dirname(fromAbs), spec);
  if (existsSync(direct)) return direct;
  const dir = path.dirname(fromAbs);
  const bare = spec.replace(/^\.\//, "");
  if (!UI_ASSET_NAMESPACE.includes(dir) || bare.includes("/")) return null;
  for (const alt of UI_ASSET_NAMESPACE) {
    const candidate = path.join(alt, bare);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readExports(abs) {
  if (exportsOf.has(abs)) return exportsOf.get(abs);
  let names = null;
  try {
    const text = readFileSync(abs, "utf8");
    names = new Set();
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const as = part.split(/\s+as\s+/);
        const name = (as[1] || as[0] || "").trim();
        if (name) names.add(name);
      }
    }
    // A star re-export means we cannot enumerate; treat the module as opaque rather than report false hits.
    if (/export\s+\*/.test(text)) names = null;
  } catch { names = null; }
  exportsOf.set(abs, names);
  return names;
}

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let text;
  try { text = readFileSync(abs, "utf8"); } catch { continue; }

  // Anchored at the start of a line so one statement's clause cannot run into the next statement's `from`,
  // which is exactly the mistake a loose `[\s\S]*?` makes and which invents hundreds of false problems.
  for (const m of text.matchAll(/^[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*(["'])(\.[^"']+)\2/gm)) {
    const clause = m[1];
    const target = resolveImport(abs, m[3]);
    if (!target) { problems.push(`${rel}: imports ${m[3]} which does not exist`); continue; }

    const named = clause.match(/\{([^}]*)\}/);
    if (!named) continue;
    const available = readExports(target);
    if (!available) continue;
    for (const part of named[1].split(",")) {
      const name = part.split(/\s+as\s+/)[0].trim();
      if (!name || name === "default") continue;
      if (!available.has(name)) {
        problems.push(`${rel}: imports { ${name} } from ${m[3]}, which does not export it`);
      }
    }
  }
}

console.log(`typecheck: ${files.length} modules, ${exportsOf.size} import targets resolved`);
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`typecheck: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("typecheck: clean");
void pathToFileURL;
