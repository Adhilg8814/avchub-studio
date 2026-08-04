// P0 Step 5C.3 — Background Processor (transport-neutral inbox/outbox engine).
//
// Replaces the Step 5C.1 placeholder. It NEVER opens a WSS (that is Step 5C.4); delivery flows
// through an INJECTED adapter (default: unavailable). Everything is DISABLED BY DEFAULT.
//
//   * disabled            → start() is a safe no-op; status ready (non-blocking); no timers.
//   * enabled, DB not ready→ ready=false (fails readiness safely); runOnce no-ops.
//   * enabled, delivery on but no real adapter → ready=false (never fakes delivery).
//   * enabled + ready      → optional poll loop calls runOnce() (outbox drain + enabled sweeps).
//
// runOnce() is the unit of work (also used by control-plane:processor:once). The inbound service
// is exposed for the future gateway to call. No setInterval; the poll loop awaits clock.sleep()
// and is torn down cleanly (abort + await) on stop()/drain() — no leaked timers or pools.

import { createClock } from "./clock.mjs";
import { createRetryPolicy } from "./retry-policy.mjs";
import { createUnavailableDeliveryAdapter, isDeliveryAdapterUsable } from "./delivery-adapter.mjs";
import { createInboxService } from "./inbox-service.mjs";
import { createOutboxProcessor } from "./outbox-processor.mjs";
import { createOfferExpiryProcessor } from "./offer-expiry-processor.mjs";
import { createReconciliationProcessor } from "./reconciliation-processor.mjs";
import { createRetentionProcessor } from "./retention-processor.mjs";

export function createBackgroundProcessor(config, { logger, adapter = null, clock = null, deliveryAdapter = null, now } = {}) {
  const p = config.processor || {};
  const enabled = p.enabled === true;
  const deliveryEnabled = p.deliveryEnabled === true;
  const pollIntervalMs = p.pollIntervalMs ?? 1000;
  const theClock = clock || createClock(now ? { now: () => Date.parse(now()) } : {});
  // Mutable holder: the Gateway (Step 5C.4) installs its real delivery adapter at startup via
  // installDeliveryAdapter(); until then it is the unavailable adapter (fails delivery readiness).
  const deliveryRef = { current: deliveryAdapter || createUnavailableDeliveryAdapter() };
  const retryPolicy = createRetryPolicy({
    initialBackoffMs: p.initialBackoffMs ?? 1000, maxBackoffMs: p.maxBackoffMs ?? 60000, maxAttempts: p.maxAttempts ?? 5
  });

  const pcfg = {
    instanceId: p.instanceId || config.deployment.instanceId,
    batchSize: p.batchSize ?? 50,
    claimLeaseMs: p.claimLeaseMs ?? 30000,
    deliveryTimeoutMs: p.deliveryTimeoutMs ?? 10000,
    settlementTimeoutMs: p.settlementTimeoutMs ?? 30000,
    reconcileTimeoutMs: p.reconcileTimeoutMs ?? 60000,
    pollIntervalMs,
    offlineRecheckMs: p.offlineRecheckMs ?? Math.min(pollIntervalMs, 5000),
    retentionBatchSize: p.retentionBatchSize ?? (p.batchSize ?? 50),
    retentionMs: p.retentionMs ?? 7 * 24 * 3600 * 1000,
    deadLetterRetentionMs: p.deadLetterRetentionMs ?? 30 * 24 * 3600 * 1000
  };

  const deps = { adapter, clock: theClock, config: pcfg, logger };
  const inbox = createInboxService({ adapter, clock: theClock, logger, skewMs: p.skewMs ?? 120000 });
  const outbox = createOutboxProcessor({ ...deps, deliveryRef, retryPolicy });
  const offerExpiry = createOfferExpiryProcessor(deps);
  const reconciliation = createReconciliationProcessor(deps);
  const retention = createRetentionProcessor(deps);

  let started = false, draining = false, busy = false;
  let loopPromise = null;
  let abort = null;
  let lastRunAt = null, lastSuccessAt = null, lastErrorCode = null, activeCycles = 0;

  function dbReady() {
    if (!adapter || typeof adapter.health !== "function") return false;
    if (typeof adapter.isEnabled === "function" && adapter.isEnabled() !== true) return false;
    const h = adapter.health();
    return h && h.ready === true;
  }

  function readinessReason() {
    if (!enabled) return { ready: true, reasonCode: "DISABLED" };
    if (!dbReady()) return { ready: false, reasonCode: "DB_NOT_READY" };
    if (deliveryEnabled && !isDeliveryAdapterUsable(deliveryRef.current)) return { ready: false, reasonCode: "DELIVERY_ADAPTER_UNAVAILABLE" };
    return { ready: true, reasonCode: "READY" };
  }

  // One full processing cycle. No-op (safely) when disabled or DB not ready. Guarded against
  // overlapping runs from THIS instance (multi-instance overlap is handled by row claims/leases).
  async function runOnce({ signal } = {}) {
    if (!enabled) return { skipped: "DISABLED" };
    if (busy) return { skipped: "BUSY" };
    if (!dbReady()) return { skipped: "DB_NOT_READY" };
    if (deliveryEnabled && !isDeliveryAdapterUsable(deliveryRef.current)) return { skipped: "DELIVERY_ADAPTER_UNAVAILABLE" };
    busy = true; activeCycles += 1; lastRunAt = theClock.nowIso();
    try {
      const out = { outbox: await outbox.runOnce({ signal }) };
      if (p.offerExpirySweepEnabled === true && !(signal && signal.aborted)) out.offerExpiry = await offerExpiry.runOnce({ signal });
      if (p.reconciliationSweepEnabled === true && !(signal && signal.aborted)) out.reconciliation = await reconciliation.runOnce({ signal });
      if (p.retentionSweepEnabled === true && !(signal && signal.aborted)) out.retention = await retention.runOnce({ signal });
      lastSuccessAt = theClock.nowIso(); lastErrorCode = null;
      return out;
    } catch (e) {
      lastErrorCode = (e && e.code) || "PROCESSOR_ERROR";
      logger?.warn?.("processor_cycle_error", { component: "processor", event: "processor_cycle_error", reasonCode: lastErrorCode });
      throw e;
    } finally {
      busy = false; activeCycles -= 1;
    }
  }

  async function loop() {
    while (abort && !abort.signal.aborted) {
      try { await runOnce({ signal: abort.signal }); }
      catch { /* recorded in lastErrorCode; keep looping */ }
      if (!abort || abort.signal.aborted) break;
      try { await theClock.sleep(pollIntervalMs, abort.signal); }
      catch { break; } // aborted during sleep
    }
  }

  return {
    isEnabled() { return enabled; },
    // Exposed for the future WSS gateway (Step 5C.4) to hand off already-parsed inbound frames.
    inbox,
    // Exposed for the control-plane:processor:once command + tests.
    runOnce,

    // Install the real outbound delivery adapter (called by the Gateway at startup). Passing a
    // usable adapter enables delivery readiness; passing null reverts to unavailable (drain).
    installDeliveryAdapter(deliveryAdapter) { deliveryRef.current = deliveryAdapter || createUnavailableDeliveryAdapter(); },
    deliveryAvailable() { return isDeliveryAdapterUsable(deliveryRef.current); },

    async start() {
      started = true;
      if (!enabled) { logger?.debug?.("processor_disabled", { component: "processor", reasonCode: "DISABLED" }); return; }
      if (deliveryEnabled && !isDeliveryAdapterUsable(deliveryRef.current)) {
        // Do not start a delivery loop against a fake/absent transport — fail readiness instead.
        logger?.warn?.("processor_delivery_unavailable", { component: "processor", reasonCode: "DELIVERY_ADAPTER_UNAVAILABLE" });
      }
      if (pollIntervalMs > 0) {
        abort = new AbortController();
        loopPromise = loop();
      }
    },

    async stop() { await this.drain(); },

    async drain({ timeoutMs } = {}) {
      draining = true;
      if (abort) abort.abort();
      if (loopPromise) {
        try {
          if (timeoutMs && timeoutMs > 0) {
            await Promise.race([loopPromise, theClock.sleep(timeoutMs)]);
          } else {
            await loopPromise;
          }
        } catch { /* */ }
      }
      loopPromise = null; abort = null; started = false; draining = false;
    },

    getStatus() {
      const r = readinessReason();
      return {
        component: "processor",
        enabled,
        initialized: started,
        ready: r.ready,
        draining,
        reasonCode: r.reasonCode,
        instanceId: pcfg.instanceId,
        deliveryEnabled,
        deliveryAvailable: isDeliveryAdapterUsable(deliveryRef.current),
        activeCycles,
        lastRunAt,
        lastSuccessAt,
        lastErrorCode,
        sweeps: {
          offerExpiry: p.offerExpirySweepEnabled === true,
          reconciliation: p.reconciliationSweepEnabled === true,
          retention: p.retentionSweepEnabled === true
        }
      };
    },

    // Sub-processor handles (for the processor:once command + focused tests).
    _internals: { outbox, offerExpiry, reconciliation, retention, inbox, clock: theClock, retryPolicy, pcfg }
  };
}
