// AVC Studio P0 Step 4A — local worker wiring (assembly factory).
//
// Composes the whole LOCAL pipeline that Steps 1–3.6 built:
//
//   JobDispatcher → JobTransport (mock) → WorkerRuntime → JobRegistry → JobHandler
//        ▲                                     │
//        └──────── worker→cloud events ────────┘   (+ optional journal / pendingAck)
//
// Everything is in-process and provider-free. This factory imports NO real
// provider automation, NO browser, NO Python, NO WebSocket, NO HTTP, NO database,
// and touches NO filesystem itself — durability arrives ONLY through an injected
// `journal` / `pendingAck`. Step 4B will swap the fake Grok handler for a real
// adapter WITHOUT changing this wiring.

import { generateId } from "../protocol/ids.mjs";
import { MockTransport } from "./mock-transport.mjs";
import { JobRegistry } from "./job-registry.mjs";
import { WorkerRuntime } from "./worker-runtime.mjs";
import { JobDispatcher } from "../control/job-dispatcher.mjs";
import { registerFakeHandlers } from "./handlers/fake-handlers.mjs";

export const DEFAULT_DURATION_CONTEXT = Object.freeze({ supportedDurationsSec: [6, 10, 15], defaultDurationSec: 10 });

// Union of the capabilities declared by every registered handler.
function deriveCapabilities(registry) {
  const caps = new Set();
  for (const action of registry.list()) {
    const h = registry.get(action);
    if (h && typeof h.capabilities === "function") for (const c of h.capabilities()) caps.add(c);
  }
  return [...caps];
}

// createLocalWorkerStack(options): wire dispatcher + transport + runtime + registry.
// options:
//   workspaceId?, workerId?, userId?, durationContext?
//   transport?    (defaults to a fresh connected MockTransport)
//   registry?     (defaults to a fresh JobRegistry)
//   handlers?     ({ [action]: handler }) — register these instead of the fakes
//   registerFakes?(=true), fakeOptions?  — register the default deterministic fakes
//   capabilities? (defaults to the union of handler.capabilities())
//   journal?, pendingAck? — injected durability (fs lives ONLY here)
//   autostart?    (=true) — start the runtime immediately
export function createLocalWorkerStack(options = {}) {
  const workspaceId = options.workspaceId ?? generateId("ws");
  const workerId = options.workerId ?? generateId("wrk");
  const userId = options.userId;
  const durationContext = options.durationContext ?? DEFAULT_DURATION_CONTEXT;

  const transport = options.transport ?? new MockTransport().connect();
  const registry = options.registry ?? new JobRegistry();

  // handlerMode: "FAKE" (default) registers the deterministic fakes; "CUSTOM"/"REAL"
  // expects the caller to supply `handlers` (e.g. the real Grok handler) — the fakes
  // are NEVER silently swapped in. Explicit `handlers` always wins.
  const handlerMode = options.handlerMode ?? (options.handlers ? "CUSTOM" : "FAKE");
  if (options.handlers) {
    for (const [action, handler] of Object.entries(options.handlers)) {
      // No implicit replace → an accidental duplicate registration throws clearly.
      registry.register(action, handler, { replace: options.replaceHandlers === true });
    }
  } else if (handlerMode === "FAKE" && options.registerFakes !== false && registry.list().length === 0) {
    // Only auto-register the fakes into an EMPTY registry — a caller passing a
    // pre-populated registry keeps their own handlers (no double-registration).
    registerFakeHandlers(registry, options.fakeOptions ?? {});
  }

  const capabilities = options.capabilities ?? deriveCapabilities(registry);
  const journal = options.journal ?? null;
  const pendingAck = options.pendingAck ?? null;

  const runtime = new WorkerRuntime({ transport, registry, workerId, capabilities, durationContext, journal, pendingAck });
  if (options.autostart !== false) runtime.start();

  const dispatcher = new JobDispatcher({ transport, workspaceId, workerId, userId, durationContext });

  return { transport, registry, runtime, dispatcher, journal, pendingAck, workspaceId, workerId, durationContext };
}
