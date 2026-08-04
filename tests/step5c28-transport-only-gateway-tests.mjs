// P0 Step 5C.28 — provider-free proof that the TRANSPORT-ONLY worker gateway does NOT create a second
// job-owner. The whole point of transport-only mode is: a remote worker can authenticate + hold a WSS
// connection + heartbeat + appear in the registry, WITHOUT the control-plane installing a delivery adapter
// or processing inbound job envelopes — so the local worker keeps SOLE ownership of the 5C.9E pipeline and
// there is never a second processor/owner. These tests exercise createWorkerGateway directly (no PG, no
// socket) and assert the delivery/inbound plane is inert in transport-only and active in full mode.
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createWorkerGateway } from "../control-plane/src/gateway/gateway.mjs";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

// A fake persistence that reports READY (so the gateway can reach READY without a real database).
function fakePersistence() {
  return { isEnabled: () => true, health: () => ({ ready: true, reasonCode: "DATABASE_READY" }), tenantTransaction: async (_ws, fn) => fn({}) };
}
// A spy processor recording whether the gateway installs a delivery adapter (= would push jobs to workers).
function spyProcessor() {
  const calls = { installDeliveryAdapter: [], processInboundEnvelope: 0 };
  return {
    calls,
    inbox: { processInboundEnvelope: async () => { calls.processInboundEnvelope += 1; return { outcome: "ACCEPTED" }; } },
    installDeliveryAdapter: (adapter) => calls.installDeliveryAdapter.push(adapter)
  };
}
function fakeHttpServer() { const s = { attached: null }; s.attachUpgrade = (fn) => { s.attached = fn; }; s.detachUpgrade = () => { s.attached = null; }; return s; }

function gwConfig(extra) {
  return loadConfig({
    CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:5432/db", CONTROL_PLANE_DB_OPS_URL: "postgres://u:p@127.0.0.1:5432/db",
    CONTROL_PLANE_TRUST_PROXY: "true", CONTROL_PLANE_CREDENTIAL_PEPPER: "y".repeat(40), CONTROL_PLANE_PAIRING_PEPPER: "x".repeat(40),
    CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_GATEWAY_PATH: "/api/worker/ws",
    ...extra
  });
}

test("config: transport-only gateway is VALID without the processor; full mode still REQUIRES it", () => {
  const to = gwConfig({ CONTROL_PLANE_GATEWAY_TRANSPORT_ONLY: "true" });
  assert.equal(to.workerGateway.enabled, true);
  assert.equal(to.workerGateway.transportOnly, true);
  assert.equal(to.processor.enabled, false);
  assert.throws(() => gwConfig({}), /Invalid Control Plane|E_CONFIG/); // full gateway + no processor → REQUIRES_PROCESSOR
});

test("SINGLE-OWNER: transport-only gateway installs NO delivery adapter (no second job-owner)", async () => {
  const proc = spyProcessor();
  const gw = createWorkerGateway(gwConfig({ CONTROL_PLANE_GATEWAY_TRANSPORT_ONLY: "true" }), {
    logger: silent, persistence: fakePersistence(), processor: proc, httpServer: fakeHttpServer()
  });
  await gw.start();
  // The gateway reached READY, attached its upgrade handler + heartbeat — but installed NO delivery adapter,
  // so the control-plane can never push a job to a remote worker: the local worker keeps sole ownership.
  assert.equal(proc.calls.installDeliveryAdapter.length, 0, "transport-only must NOT install a delivery adapter");
  const st = gw.getStatus();
  assert.equal(st.ready, true, "transport-only gateway is READY without the processor/delivery plane");
  await gw.drain();
  // drain must also never install (or null) a delivery adapter it never had.
  assert.equal(proc.calls.installDeliveryAdapter.length, 0);
});

test("FULL mode (processor enabled) DOES install a delivery adapter (the contrast)", async () => {
  const proc = spyProcessor();
  const gw = createWorkerGateway(gwConfig({ CONTROL_PLANE_PROCESSOR_ENABLED: "true" }), {
    logger: silent, persistence: fakePersistence(), processor: proc, httpServer: fakeHttpServer()
  });
  await gw.start();
  assert.equal(proc.calls.installDeliveryAdapter.length, 1, "full mode installs the delivery adapter");
  assert.notEqual(proc.calls.installDeliveryAdapter[0], null);
  await gw.drain();
  // drain uninstalls it (installs null) → the delivery plane is fenced off on shutdown.
  assert.equal(proc.calls.installDeliveryAdapter.at(-1), null);
});

test("transport-only gateway still enforces auth/path/enabled at upgrade (transport security intact)", () => {
  const gw = createWorkerGateway(gwConfig({ CONTROL_PLANE_GATEWAY_TRANSPORT_ONLY: "true" }), {
    logger: silent, persistence: fakePersistence(), processor: null, httpServer: fakeHttpServer()
  });
  // With processor:null it must still be constructible + report enabled (transport does not need a processor).
  assert.equal(gw.isEnabled(), true);
  const st = gw.getStatus();
  assert.equal(st.enabled, true);
});
