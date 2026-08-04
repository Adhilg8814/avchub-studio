#!/usr/bin/env node
// Project lint. There is no ESLint dependency here on purpose: the rules worth enforcing in this codebase are
// project invariants, not style, and a syntax check plus four invariants runs in under a second with nothing
// to install. Style is left to review.
//
// Rules:
//   1. every .mjs/.js file parses
//   2. no absolute machine path in a source file
//   3. no `debugger`
//   4. no relative import that resolves outside the repository
//
// Exit code 1 on any violation.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = /(^|[\\/])(node_modules|\.git|dist|coverage)([\\/]|$)/;
const ABSOLUTE_PATH = /(["'`])[A-Za-z]:[\\/](?!\\?\s)[^"'`\n]{2,}\1/;
// Well-known OS locations are not machine-specific: a Windows font directory or the Default profile is the
// same on every install, and both are probed with existsSync rather than assumed to exist.
// The doubled separator is the JS source form of a single backslash, so both must match.
const SYSTEM_PATH = /[A-Za-z]:[\\/]{1,2}(Windows|Program Files( \(x86\))?|Users[\\/]{1,2}Default)([\\/]|["']|$)/i;
// A fixture naming a path that does not exist is the point of a fixture.
const FIXTURE_FILE = /^tests[\\/]/;

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

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return walk(ROOT);
  }
}


const violations = [];
const files = trackedFiles().filter((f) => /\.(mjs|js)$/.test(f) && !SKIP.test(f));

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue;

  try {
    execFileSync(process.execPath, ["--check", abs], { stdio: "pipe" });
  } catch (e) {
    violations.push(`${rel}: does not parse — ${String(e.stderr || e.message).split("\n")[0]}`);
    continue;
  }

  const text = readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    if (ABSOLUTE_PATH.test(line) && !SYSTEM_PATH.test(line) && !FIXTURE_FILE.test(rel) && !/^\s*(\/\/|\*)/.test(line)) {
      violations.push(`${rel}:${i + 1}: absolute machine path in source — use configuration instead`);
    }
    if (/(^|[^.\w])debugger\s*;?\s*$/.test(line)) {
      violations.push(`${rel}:${i + 1}: leftover debugger statement`);
    }
  });

  for (const m of text.matchAll(/from\s*(["'])(\.[^"']+)\1/g)) {
    const target = path.resolve(path.dirname(abs), m[2]);
    if (!target.startsWith(ROOT)) violations.push(`${rel}: imports outside the repository (${m[2]})`);
  }
}

console.log(`lint: ${files.length} files checked`);
if (violations.length) {
  for (const v of violations) console.error(`  ${v}`);
  console.error(`lint: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log("lint: clean");
