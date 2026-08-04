// P0 Step 5C.8B1 — Worker child-process control for the strict live E2E.
//
// Spawns scripts/worker-step5c8-runner.mjs as a REAL separate Node process, captures its
// NDJSON readiness events on stdout, and supports clean stop (stdin "stop" / SIGTERM), abrupt
// kill (SIGKILL), restart with the SAME durable roots, premature-exit detection, timeouts, and
// full process-tree teardown. Never logs secrets (the child never prints any).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// waitForMarker(file, {timeoutMs}) — poll a DURABLE crash/pause marker file (no arbitrary sleep as
// proof of reaching a window). Returns the parsed marker JSON, or throws on timeout.
export async function waitForMarker(file, { timeoutMs = 15000, stepMs = 40 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (existsSync(file)) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } }
    if (Date.now() - t0 > timeoutMs) throw new Error(`marker not reached: ${path.basename(file)}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
// releasePause(file) — create the release file a paused worker is polling for (opens the race window).
export function releasePause(file) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${Date.now()}\n`, "utf8"); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "..", "..", "scripts", "worker-step5c8-runner.mjs");

export function spawnWorker(env, { label = "worker" } = {}) {
  const child = spawn(process.execPath, [RUNNER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const events = [];
  const stderr = [];
  const waiters = [];
  let exited = null; // { code, signal }
  let buf = "";

  function pump(line) {
    let obj = null;
    try { obj = JSON.parse(line); } catch { return; }
    events.push(obj);
    for (const w of [...waiters]) if (w.pred(obj)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(obj); }
  }
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) pump(line); }
  });
  child.stderr.on("data", (d) => stderr.push(String(d).slice(0, 400)));
  child.on("exit", (code, signal) => { exited = { code, signal }; for (const w of [...waiters]) { clearTimeout(w.t); w.reject(new Error(`${label} exited (code=${code} signal=${signal}) before "${w.desc}"`)); } waiters.length = 0; });

  function waitFor(pred, desc, timeoutMs = 15000) {
    const found = events.find(pred);
    if (found) return Promise.resolve(found);
    if (exited) return Promise.reject(new Error(`${label} already exited before "${desc}"`));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { const idx = waiters.findIndex((w) => w.t === t); if (idx >= 0) waiters.splice(idx, 1); reject(new Error(`${label} timeout waiting for "${desc}" (events: ${events.map((e) => e.event).join(",")})`)); }, timeoutMs);
      waiters.push({ pred, desc, resolve, reject, t });
    });
  }

  return {
    child,
    pid: child.pid,
    events,
    stderrTail: () => stderr.slice(-5),
    hasExited: () => exited !== null,
    exitInfo: () => exited,
    waitForEvent: (name, timeoutMs) => waitFor((e) => e.event === name, name, timeoutMs),
    waitForOnline: (timeoutMs) => waitFor((e) => e.event === "online", "online", timeoutMs),
    // Clean shutdown: ask the child to drain+stop, then wait for exit.
    async stopClean(timeoutMs = 8000) {
      if (exited) return exited;
      try { child.stdin.write("stop\n"); } catch { /* */ }
      return waitExit(child, timeoutMs).catch(() => { try { child.kill("SIGKILL"); } catch { /* */ } return exited; });
    },
    // Abrupt kill: SIGKILL the process (no clean drain) — models a hard crash.
    async killAbrupt() {
      if (exited) return exited;
      try { child.kill("SIGKILL"); } catch { /* */ }
      return waitExit(child, 5000).catch(() => exited);
    }
  };
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    const t = setTimeout(() => reject(new Error("exit timeout")), timeoutMs);
    child.once("exit", (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
}
