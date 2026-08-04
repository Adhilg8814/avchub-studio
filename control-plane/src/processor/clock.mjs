// P0 Step 5C.3 — injectable clock + abortable sleep for the Background Processor.
//
// All processor time reads and delays go through here so tests are fully deterministic (inject
// a controllable `now`) and shutdown is prompt (sleep rejects on AbortSignal). No module-level
// timers, no setInterval — the processor's optional poll loop awaits clock.sleep() explicitly.

export function abortError(message = "aborted") {
  const e = new Error(message);
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}

// createClock({ now, setTimeoutFn, clearTimeoutFn }):
//   now()          → epoch milliseconds (injectable; defaults to Date.now)
//   nowIso()       → ISO-8601 UTC string at now()
//   sleep(ms, sig) → resolves after ms, or rejects with AbortError if `sig` aborts first.
export function createClock({ now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  return {
    now,
    nowIso() { return new Date(now()).toISOString(); },
    // A timestamp `deltaMs` from now (ISO). POSITIVE for scheduling next_attempt_at / lease
    // expiry; NEGATIVE for "past cutoff" comparisons (settlement/reconcile/retention windows).
    // Must NOT clamp negatives — a clamp would collapse every cutoff to `now`.
    futureIso(deltaMs) { return new Date(now() + deltaMs).toISOString(); },
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(abortError()); return; }
        if (!(ms > 0)) { resolve(); return; }
        let onAbort = null;
        const t = setTimeoutFn(() => { if (onAbort && signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
        if (t && typeof t.unref === "function") t.unref();
        if (signal) {
          onAbort = () => { clearTimeoutFn(t); reject(abortError()); };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  };
}
