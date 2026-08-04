// AVC Studio P0 Step 4C — Worker bridge feature flag (OFF BY DEFAULT).
//
// The ONLY gate for the Worker↔Grok bridge. It is false unless WORKER_RUNTIME_BRIDGE
// is explicitly "true"/"1". No ui-server route, no production code path reads this —
// production always uses LOCAL_LEGACY. Only the manual integration harness consults
// it, so the bridge is inert until an operator deliberately enables it.

export const BRIDGE_FLAG = "WORKER_RUNTIME_BRIDGE";

// isWorkerBridgeEnabled(env?) -> boolean. Default false for any unset/other value.
export function isWorkerBridgeEnabled(env = process.env) {
  const v = String((env && env[BRIDGE_FLAG]) ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}
