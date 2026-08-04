// P0 Step 5C.3 — transport-neutral delivery adapter boundary.
//
// The processor NEVER opens a WSS itself (that is Step 5C.4). It delivers each claimed outbox
// row through an INJECTED adapter implementing:
//
//   sendToWorker({ workerId, connectionSessionId, gatewayInstance, envelope, signal })
//     → Promise<{ result: DELIVERY_RESULTS.*, detail?, reasonCode? }>
//
// A successful socket write is NOT settlement — settlement depends on the row's settlement_mode
// (see settlement-map). The adapter reports only what happened at the transport layer.
//
// The DEFAULT production adapter is UNAVAILABLE: no real gateway exists yet, so enabling delivery
// without injecting a real adapter must fail readiness SAFELY rather than silently pretend to
// deliver. Deterministic FAKE adapters live only under tests/helpers — never in production code.

import { DELIVERY_RESULTS } from "./retry-policy.mjs";

// Shape guard: a usable delivery adapter must expose available===true and a sendToWorker fn.
export function isDeliveryAdapterUsable(adapter) {
  return Boolean(adapter && adapter.available === true && typeof adapter.sendToWorker === "function");
}

// The default, deliberately-unavailable adapter (Step 5C.3). Calling send throws; readiness gates
// on available===false so an operator who turns delivery on without a real gateway is told, not
// silently dropped into a fake transport.
export function createUnavailableDeliveryAdapter({ reason = "PRODUCTION_GATEWAY_NOT_IMPLEMENTED" } = {}) {
  return Object.freeze({
    available: false,
    kind: "unavailable",
    reasonCode: reason,
    async sendToWorker() {
      const e = new Error("delivery adapter unavailable: the production WSS gateway is Step 5C.4");
      e.code = reason;
      throw e;
    }
  });
}

export { DELIVERY_RESULTS };
