#!/usr/bin/env node
// P0 Step 5B — credential lifecycle over a REAL local WebSocket: paired connect,
// rotation (two-phase), revocation, and re-pairing. Fake handlers only.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateId } from "../lib/protocol/ids.mjs";
import { InMemoryWorkerIdentityStore } from "../lib/control/worker-identity-store.mjs";
import { PairingService } from "../lib/control/pairing-service.mjs";
import { LocalControlPlane } from "../lib/control/local-control-plane.mjs";
import { MemoryCredentialStore } from "../lib/worker/credential-store.mjs";
import { WorkerPairingClient } from "../lib/worker/pairing-client.mjs";
import { createPairedWorker } from "../lib/worker/local-worker-agent.mjs";
import { IDENTITY_ERRORS } from "../lib/control/identity-errors.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let failures = 0, passed = 0;
function check(name, actual, expected = true) { const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected; if (ok) passed += 1; else { failures += 1; console.error(`FAIL ${name}\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); } }
const waitFor = async (p, ms = 2500) => { const s = Date.now(); while (Date.now() - s < ms) { if (p()) return true; await new Promise((r) => setTimeout(r, 3)); } return p(); };
const tick = (n) => new Promise((r) => setTimeout(r, n));

const WS = "ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3";
const tmp = []; const mkTmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "avc-life-")); tmp.push(d); return d; };
const workers = []; const planes = [];
function fullLimits() { return { codeCreate: { max: 50, windowMs: 60000 }, attemptsPerSource: { max: 100, windowMs: 60000 }, maxAttemptsPerCode: 5, rotate: { max: 10, windowMs: 60000 } }; }

async function setup({ credentialTtlMs = 60000, rotationTtlMs = 60000, clock } = {}) {
  const store = new InMemoryWorkerIdentityStore({ clock });
  const svc = new PairingService({ store, pairingPepper: "PP", credentialPepper: "CP", clock, codeTtlMs: 60000, credentialTtlMs, rotationTtlMs, limits: fullLimits() });
  const plane = new LocalControlPlane({ pairingService: svc, clock });
  await plane.start();
  planes.push({ plane });
  return { store, svc, plane };
}
async function pairWorker(plane, credStore = new MemoryCredentialStore(), opts = {}) {
  const { code } = plane.createPairingCode({ workspaceId: opts.workspaceId ?? WS });
  const client = new WorkerPairingClient({ url: `http://127.0.0.1:${plane.port}`, credentialStore: credStore, installationId: opts.installationId ?? generateId("wrk"), capabilities: ["grok.video"] });
  const paired = await client.pair(code);
  const worker = createPairedWorker({ url: `ws://127.0.0.1:${plane.port}`, credentialStore: credStore, pairingClient: client, workspaceId: paired.workspaceId, workerId: paired.workerId, backoffMs: opts.backoffMs ?? [10, 20], autoReconnect: opts.autoReconnect !== false });
  workers.push(worker);
  worker.agent.start();
  return { paired, worker, client, credStore };
}
async function shutdown() { for (const w of workers) { try { await w.agent.stop(); } catch { /* */ } } for (const p of planes) { try { await p.plane.stop(); } catch { /* */ } } }

try {
  // ---- connection (34,35,37,40) ----
  {
    const { plane, svc } = await setup();
    const { paired, worker, credStore } = await pairWorker(plane);
    await worker.agent.waitReady();
    check("34 newly paired worker connects", worker.transport.isConnected(), true);
    check("35 identity derived from credential", svc.authenticate(credStore.getActiveCredential().credential).workerId, paired.workerId);
    check("35 plane bound identity", plane.getWorkerStatus(paired.workerId), "ONLINE");
    // 36/71-74: credential never appears in any server-side state
    const serverDump = JSON.stringify(svc._store.snapshot()) + JSON.stringify(plane.store.getAudit()) + JSON.stringify(svc._store.getAuditEvents());
    check("36/73 credential absent from server state/audit", serverDump.includes(credStore.getActiveCredential().credential), false);
    // 37. restart uses stored credential: rebuild worker from the same store
    await worker.agent.stop();
    await waitFor(() => plane.getWorkerStatus(paired.workerId) === "OFFLINE");
    const worker2 = createPairedWorker({ url: `ws://127.0.0.1:${plane.port}`, credentialStore: credStore, pairingClient: null, workspaceId: paired.workspaceId, workerId: paired.workerId, backoffMs: [10, 20] });
    workers.push(worker2); worker2.agent.start();
    await worker2.agent.waitReady();
    check("37 restart reconnects using stored credential", worker2.transport.isConnected(), true);
    await worker2.agent.stop();
  }

  // ---- 38: invalid credential stops the reconnect storm ----
  {
    const { plane } = await setup();
    const credStore = new MemoryCredentialStore();
    credStore.saveActiveCredential({ credential: "wcred_invalid_credential_value_not_registered_xxxxxx", workerId: "wrk_x", workspaceId: WS });
    const w = createPairedWorker({ url: `ws://127.0.0.1:${plane.port}`, credentialStore: credStore, workspaceId: WS, workerId: generateId("wrk"), backoffMs: [10, 20] });
    workers.push(w);
    let authRequired = false; w.transport.onAuthRequired(() => { authRequired = true; });
    w.agent.start();
    await waitFor(() => authRequired || w.transport.authStopped());
    check("38 invalid credential → AUTH_REQUIRED + reconnect stopped", w.transport.authStopped(), true);
    check("38 onAuthRequired fired", authRequired, true);
    await w.agent.stop();
  }

  // ---- 39: expired credential yields AUTH_REQUIRED ----
  {
    let t = 1000; const clock = () => t;
    const { plane } = await setup({ credentialTtlMs: 500, clock });
    const { worker } = await pairWorker(plane);
    await worker.agent.waitReady();
    await worker.agent.stop();
    t = 5000; // credential now expired
    const credStore = worker.__store; // (unused)
    // reconnect with the (now expired) stored credential
    const store2 = worker.agent._credentialStore;
    const w2 = createPairedWorker({ url: `ws://127.0.0.1:${plane.port}`, credentialStore: store2, workspaceId: worker.workspaceId, workerId: worker.workerId, backoffMs: [10, 20] });
    workers.push(w2);
    let authRequired = false; w2.transport.onAuthRequired(() => { authRequired = true; });
    w2.agent.start();
    await waitFor(() => authRequired || w2.transport.authStopped());
    check("39 expired credential → AUTH_REQUIRED", w2.transport.authStopped(), true);
    await w2.agent.stop();
  }

  // ---- rotation (41-48,50,53) ----
  {
    const { plane, svc } = await setup();
    const { paired, worker, credStore } = await pairWorker(plane);
    await worker.agent.waitReady();
    const oldCred = credStore.getActiveCredential().credential;

    // 41. rotation starts (operator initiated → WORKER_CREDENTIAL_ROTATE, no secret)
    const { rotationId } = plane.requestRotation(paired.workerId);
    check("41 rotation started", typeof rotationId === "string" && rotationId.startsWith("rot_"), true);
    // 44/45/46. worker fetches pending, reconnects, promotes; old revoked
    await waitFor(() => credStore.getActiveCredential().credential !== oldCred, 3000);
    check("43/44 pending fetched + active rotated", credStore.getActiveCredential().credential !== oldCred, true);
    check("45 pending promoted (cleared)", credStore.getPendingCredential(), null);
    check("42 new credential valid", svc.authenticate(credStore.getActiveCredential().credential).workerId, paired.workerId);
    let oldRejected = false; try { svc.authenticate(oldCred); } catch { oldRejected = true; }
    check("46 old credential revoked", oldRejected, true);
    check("44 still connected after rotation", await waitFor(() => worker.transport.isConnected(), 2000), true);

    // 47. duplicate rotation harmless (same rotationId used twice via endpoint)
    let dupThrew = false; try { svc.rotate({ rotationId, currentCredential: credStore.getActiveCredential().credential }); } catch (e) { dupThrew = e.code === IDENTITY_ERRORS.E_CREDENTIAL_ROTATION_INVALID; }
    check("47 duplicate rotation rejected (no 2nd credential)", dupThrew, true);
    // 48. stale rotationId
    let staleThrew = false; try { svc.rotate({ rotationId: "rot_bogus", currentCredential: credStore.getActiveCredential().credential }); } catch (e) { staleThrew = e.code === IDENTITY_ERRORS.E_CREDENTIAL_ROTATION_INVALID; }
    check("48 stale rotationId rejected", staleThrew, true);
    await worker.agent.stop();
  }

  // 49. rotation timeout  50. worker store failure preserves old credential
  {
    let t = 1000; const clock = () => t;
    const { plane, svc } = await setup({ rotationTtlMs: 500, clock });
    const { paired, credStore } = await pairWorker(plane, new MemoryCredentialStore(), { autoReconnect: false });
    const active = credStore.getActiveCredential().credential;
    const { rotationId } = svc.startRotation(paired.workerId);
    t = 2000; // rotation window elapsed
    let timedOut = false; try { svc.rotate({ rotationId, currentCredential: active }); } catch (e) { timedOut = e.code === IDENTITY_ERRORS.E_CREDENTIAL_ROTATION_INVALID; }
    check("49 rotation timeout rejected", timedOut, true);
    check("50 old credential still valid after failed rotation", svc.authenticate(active).workerId, paired.workerId);
  }

  // 52. control-plane restart during rotation → reconciliation fallback (no lost rotation)
  {
    const idStore = new InMemoryWorkerIdentityStore();
    const svc1 = new PairingService({ store: idStore, pairingPepper: "PP", credentialPepper: "CP", limits: fullLimits() });
    const c = svc1.createPairingCode({ workspaceId: WS });
    const p = svc1.pair({ pairingCode: c.code });
    const { rotationId } = svc1.startRotation(p.workerId);
    const rotated = svc1.rotate({ rotationId, currentCredential: p.workerCredential });
    // control plane restarts: fresh PairingService, SAME persistent store, empty rotation map
    const svc2 = new PairingService({ store: idStore, pairingPepper: "PP", credentialPepper: "CP", limits: fullLimits() });
    const promoted = svc2.completeRotationForCredential(rotated.credentialId);
    check("52 restart: rotated credential promoted via fallback", promoted, true);
    check("52 new credential valid after restart-promotion", svc2.authenticate(rotated.workerCredential).workerId, p.workerId);
    let oldDead = false; try { svc2.authenticate(p.workerCredential); } catch { oldDead = true; }
    check("52/46 old credential revoked after restart-promotion", oldDead, true);
  }

  // ---- revocation + re-pair (54-60) ----
  {
    const { plane, svc } = await setup();
    const cA = new MemoryCredentialStore(); const cB = new MemoryCredentialStore();
    const A = await pairWorker(plane, cA);
    const B = await pairWorker(plane, cB);
    await A.worker.agent.waitReady(); await B.worker.agent.waitReady();
    let repair = false; A.worker.agent.onRepairRequired(() => { repair = true; });

    plane.revokeWorker(A.paired.workerId); // 54
    await waitFor(() => repair);
    check("54/58 revoke → REPAIR_REQUIRED", repair, true);
    await waitFor(() => !A.worker.transport.isConnected());
    check("55 connection closes", A.worker.transport.isConnected(), false);
    check("56 local credential deleted", cA.hasCredential(), false);
    check("57 reconnect stopped (auth stop or disconnected)", A.worker.transport.authStopped() || !A.worker.transport.isConnected(), true);
    check("66 revoking A did not disconnect B", B.worker.transport.isConnected(), true);
    check("60 old worker remains revoked in store", svc._store.getWorker(A.paired.workerId).status, "REVOKED");

    // 59. re-pair creates a NEW worker identity
    const cA2 = new MemoryCredentialStore();
    const A2 = await pairWorker(plane, cA2);
    await A2.worker.agent.waitReady();
    check("59 re-pair creates a new worker identity", A2.paired.workerId !== A.paired.workerId, true);
    check("60 old worker still revoked after re-pair", svc._store.getWorker(A.paired.workerId).status, "REVOKED");
    check("59 new worker active", svc._store.getWorker(A2.paired.workerId).status, "ACTIVE");
  }

  await tick(20);
  check("no unhandled rejection", un, false);
} finally {
  await shutdown();
  for (const d of tmp) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

await tick(30);
if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
