// P0 Step 5C.31 — REMOTE WORKER END-TO-END over a REAL socket, REAL PostgreSQL, REAL HTTP upload.
//
// Everything here is the shipped code path: the real pairing service mints a real single-use code, a real
// worker credential is issued once, the real hub terminates a real WSS upgrade, the real agent drives the
// real delivery protocol, and the artifact really travels over HTTP and is really hashed on arrival.
// The ONLY simulated component is the provider itself — the executor writes a byte-exact file instead of
// driving Cloak, so the suite proves the transport/ownership/upload contract without spending quota.
//
// Fault injection covers what actually happens to a machine in someone else's house: it disconnects
// mid-run, it reconnects and replays, it gets revoked, it gets drained, and it comes back after a restart.

import http from "node:http";
import pg from "pg";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createPairingService } from "../control-plane/src/pairing/pairing-service.mjs";
import { createGenerationControlPlane } from "../control-plane/src/api-staging/generation-control-plane.mjs";
import { createRemoteWorkerRegistry } from "../lib/worker/remote/remote-worker-registry.mjs";
import { createWorkerAssignment } from "../lib/worker/remote/worker-assignment.mjs";
import { createRemoteWorkerHub } from "../lib/worker/remote/remote-worker-hub.mjs";
import { createRemoteWorkerAgent } from "../lib/worker/remote/remote-worker-agent.mjs";
import { generateId } from "../lib/protocol/ids.mjs";

const { Client } = pg;
let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 20_000, everyMs = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

if (!livePgAvailable()) {
  console.log("Step 5C.31 remote e2e: 0 passed, 0 failed (SKIPPED — no PostgreSQL)");
  process.exit(0);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "avc5c31-"));
const mediaRoot = path.join(tmp, "media");
const live = await startDisposablePg({ namePrefix: "cp5c31e2e" });
let adapter = null, server = null, hub = null, agent = null;
try {
  const ws = generateId("ws"), user = generateId("usr");
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
    await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c31e2e" });
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'WS',$2)", [ws, user]);
  } finally { await mc.end(); }

  const env = {
    CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl,
    CONTROL_PLANE_PAIRING_ENABLED: "true",
    CONTROL_PLANE_PAIRING_PEPPER: "pairing-pepper-for-the-disposable-cert-run-0001",
    CONTROL_PLANE_CREDENTIAL_PEPPER: "credential-pepper-for-the-disposable-cert-run-01"
  };
  const config = loadConfig(env);
  adapter = createPostgresAdapter(config, {});
  await adapter.start();
  const T = (fn) => adapter.tenantTransaction(ws, fn);

  const registry = createRemoteWorkerRegistry({ persistence: adapter });
  const tenants = new Map();
  const assignment = createWorkerAssignment({
    persistence: adapter, registry, isConnected: (w) => hub.isConnected(w), remoteDeliveryEnabled: true, cacheMs: 0,
    assignProjectAffinityAtBind: async (wsId, wid) => { await tenants.get(wsId)?.controlPlane?.adoptExecutionWorker?.(wid); }
  });
  const cp = createGenerationControlPlane({
    persistence: adapter, config: { stagingApi: { workspaceId: ws, fakeAction: "GENERATE_GROK_VIDEO" }, generation: { providerCooldownMs: 0 } },
    executionWorkerResolver: () => assignment.resolve(ws)
  });
  tenants.set(ws, { controlPlane: cp });

  hub = createRemoteWorkerHub({
    persistence: adapter, credentialPepper: config.security.credentialPepper,
    resolveTenant: (w) => tenants.get(w) || null, registry,
    mediaRootFor: () => mediaRoot, enabled: true, offerPollMs: 300
  });
  hub.start();

  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    void hub.handleHttp(req, res, url).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  server.on("upgrade", (req, socket, head) => { void hub.handleUpgrade(req, socket, head); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const studioUrl = `http://127.0.0.1:${server.address().port}`;

  // ================================================================ 1. pairing
  const pairing = createPairingService({ config, persistence: adapter, disconnectWorker: (w, k, r) => hub.disconnectWorker(w, k, r) });
  const issued = await pairing.issueCode({ workspaceId: ws, actorId: user, requestedLabel: "Cert VM" });
  check("E1 a pairing code is minted and returned exactly once", typeof issued.pairingCode === "string" && issued.pairingCode.length > 0);
  check("E2 only the HMAC verifier is stored (the code itself is nowhere in the row)",
    (await T((c) => c.query("SELECT code_hash FROM pairing_codes WHERE id=$1", [issued.pairingCodeId]))).rows[0].code_hash !== issued.pairingCode);

  const claimed = await pairing.claimCode({ code: issued.pairingCode, platform: "win32", workerVersion: "1.1.0", protocolVersion: 1, remoteKey: "cert" });
  const workerId = claimed.workerId;
  const credential = claimed.credential;
  check("E3 claiming the code yields a worker identity + a credential", /^wrk_/.test(workerId) && /^wcred_/.test(credential));
  check("E4 the credential is stored only as a peppered verifier",
    (await T((c) => c.query("SELECT credential_hash FROM worker_credentials WHERE worker_id=$1", [workerId]))).rows[0].credential_hash.startsWith("wcred_") === false);

  let replayErr = null;
  try { await pairing.claimCode({ code: issued.pairingCode, platform: "win32", remoteKey: "cert" }); } catch (e) { replayErr = e; }
  check("E5 the pairing code is SINGLE-USE (replay refused)", replayErr !== null);
  let badErr = null;
  try { await pairing.claimCode({ code: "AAAA-BBBB-CCCC", platform: "win32", remoteKey: "cert" }); } catch (e) { badErr = e; }
  check("E6 an unknown pairing code is refused generically", badErr !== null);

  const issued2 = await pairing.issueCode({ workspaceId: ws, actorId: user, ttlMs: 60_000 });
  await T((c) => c.query("UPDATE pairing_codes SET expires_at = now() - interval '1 minute' WHERE id=$1", [issued2.pairingCodeId]));
  let expErr = null;
  try { await pairing.claimCode({ code: issued2.pairingCode, platform: "win32", remoteKey: "cert" }); } catch (e) { expErr = e; }
  check("E7 an EXPIRED pairing code is refused", expErr !== null);

  const concurrent = await pairing.issueCode({ workspaceId: ws, actorId: user });
  const both = await Promise.allSettled([
    pairing.claimCode({ code: concurrent.pairingCode, platform: "win32", remoteKey: "c1" }),
    pairing.claimCode({ code: concurrent.pairingCode, platform: "win32", remoteKey: "c2" })
  ]);
  check("E8 concurrent consume of one code yields EXACTLY one worker", both.filter((r) => r.status === "fulfilled").length === 1);

  // ================================================================ 2. connect + handshake
  const madeFiles = [];
  function fakeMedia(bytes = 4096) {
    const p = path.join(tmp, `clip-${madeFiles.length}.mp4`);
    const buf = Buffer.alloc(bytes, 7);
    buf.write("ftypisom", 4);
    writeFileSync(p, buf);
    madeFiles.push(p);
    return p;
  }
  const executor = {
    hostLabel: "CERT-VM", osCaption: "Windows 11 Pro",
    behaviour: "OK",
    async probeCapabilities() { return { cloakReady: true, ffmpegReady: true, interactiveSession: true, providerReady: true, actions: ["GENERATE_IMAGINE_VIDEO"], maxConcurrentGenerations: 1 }; },
    async runGeneration(spec, hooks) {
      hooks.onGatePassed?.();
      if (executor.behaviour === "PRE_SUBMIT_FAIL") return { status: "FAILED", code: "E_GENERATION_ACCOUNT_UNRESOLVED" };
      hooks.onSubmitAttempted?.();
      if (executor.behaviour === "HANG") { await sleep(30_000); return { status: "FAILED", code: "E_GENERATION_RUN_ERROR" }; }
      if (executor.behaviour === "UNCERTAIN") return { status: "UNCERTAIN", code: "E_GENERATION_SUBMIT_UNCERTAIN", possiblySubmitted: true };
      hooks.onSubmitted?.("provider-sub-1");
      const p = fakeMedia();
      return { status: "COMPLETED", mediaPath: p, resultId: "res-remote-1", durationSeconds: 6, width: 464, height: 688 };
    }
  };

  agent = createRemoteWorkerAgent({
    studioUrl, workerId, getCredential: async () => credential, executor,
    bundleVersion: "1.1.0", buildCommit: "cert001", reconnect: true
  });
  await agent.start();
  const connectedState = await until(() => agent.status().connected && agent.status().workspaceId === ws);
  check("E9 the agent authenticates with the credential and completes the handshake", Boolean(connectedState));
  check("E10 the hub TELLS the agent its workspace (never client-asserted)", agent.status().workspaceId === ws);
  check("E11 a freshly paired worker is NOT approved -> comes up DRAINING", agent.status().draining === true && agent.status().approved === false);
  const helloRow = await until(async () => (await registry.get(ws, workerId))?.last_hello_at);
  check("E12 the durable registry records the reported bundle/protocol/capabilities", Boolean(helloRow));
  const st = await registry.get(ws, workerId);
  check("E13 the reported version/commit are persisted", st.bundle_version === "1.1.0" && st.build_commit === "cert001" && st.delivery_protocol_version === 1);
  check("E14 capabilities are sanitised into the fixed shape", st.capabilities && st.capabilities.cloakReady === true && st.cloak_ready === true);

  // a bad credential can never connect
  const rogue = createRemoteWorkerAgent({ studioUrl, workerId, getCredential: async () => "wcred_totally_wrong_value_0000000000", executor, reconnect: false });
  await rogue.start();
  await sleep(700);
  check("E15 a WRONG credential never reaches an authenticated session", rogue.status().workspaceId === null);
  await rogue.stop();

  // ================================================================ 3. enable + dedicated binding
  await assignment.bindDedicatedWorker(ws, workerId, { label: "Cert VM" });
  await registry.approve(ws, workerId);
  assignment.invalidate();
  const resolved = await assignment.resolve(ws);
  check("E16 the workspace now resolves to the dedicated REMOTE worker", resolved.mode === "REMOTE" && resolved.workerId === workerId && resolved.assignable === true);

  // the agent must learn it may work again (it asks on the next READY sweep)
  await agent.stop();
  agent = createRemoteWorkerAgent({ studioUrl, workerId, getCredential: async () => credential, executor, bundleVersion: "1.1.0", buildCommit: "cert001", reconnect: true });
  await agent.start();
  check("E17 after Enable the agent reconnects as approved + not draining",
    Boolean(await until(() => agent.status().approved === true && agent.status().draining === false)));

  // ================================================================ 4. the happy path, end to end
  const job = await cp.enqueue({ prompt: "a wooden boat at dawn, slow push-in" });
  const dispatch = await cp.requestStart({ jobId: job.jobId });
  check("E18 the job is dispatched REMOTE to the paired worker", dispatch.deliveryMode === "REMOTE" && dispatch.workerId === workerId);

  const completed = await until(async () => (await cp.getForUi(job.jobId)).state === "COMPLETED", { timeoutMs: 30_000 });
  check("E19 the job reaches COMPLETED entirely through the remote path", Boolean(completed));
  const view = await cp.getForUi(job.jobId);
  const prov = (await T((c) => c.query("SELECT executed_by_worker_id, delivery_mode, execution_host FROM generation_jobs WHERE id=$1", [job.jobId]))).rows[0];
  check("E20 provenance proves WHICH machine executed it", prov.executed_by_worker_id === workerId && prov.delivery_mode === "REMOTE" && prov.execution_host === "CERT-VM");

  const stored = path.join(mediaRoot, "jobs", job.jobId, "generated.mp4");
  check("E21 the artifact really landed on the server filesystem", existsSync(stored));
  const storedSha = createHash("sha256").update(readFileSync(stored)).digest("hex");
  const recordedSha = (await T((c) => c.query("SELECT actual_sha256, status FROM worker_upload_sessions WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1", [job.jobId]))).rows[0];
  check("E22 the stored bytes hash to exactly what the worker declared", recordedSha.actual_sha256 === storedSha && recordedSha.status === "FINALIZED");
  const asset = (await T((c) => c.query("SELECT checksum, size_bytes FROM assets WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1", [ws]))).rows[0];
  check("E23 the control plane recorded the VERIFIED checksum against the job", asset.checksum === `sha256:${storedSha}`);
  check("E24 the local worker never claimed this job", view.assignedWorkerId === workerId);

  const ledger = (await T((c) => c.query("SELECT kind FROM remote_delivery_commands WHERE workspace_id=$1 AND job_id=$2 ORDER BY received_at", [ws, job.jobId]))).rows.map((r) => r.kind);
  check("E25 the durable command trail shows the full lifecycle exactly once",
    ledger.filter((k) => k === "ACCEPT").length === 1
    && ledger.filter((k) => k === "SUBMIT_ATTEMPTED").length === 1
    && ledger.filter((k) => k === "COMPLETE").length === 1);

  // ================================================================ 5. fault injection
  // (a) disconnect BEFORE the provider is touched -> the job goes straight back to the queue
  executor.behaviour = "PRE_SUBMIT_FAIL";
  const job2 = await cp.enqueue({ prompt: "pre-submit failure path" });
  await cp.requestStart({ jobId: job2.jobId });
  const failed2 = await until(async () => (await cp.getForUi(job2.jobId)).state === "FAILED_PRE_SUBMIT", { timeoutMs: 20_000 });
  check("E26 a provably pre-submit failure settles as FAILED_PRE_SUBMIT", Boolean(failed2));

  // (b) the worker dies AFTER reporting SUBMIT_ATTEMPTED: the hub must NOT release or retry it
  executor.behaviour = "HANG";
  const job3 = await cp.enqueue({ prompt: "disconnect after submit" });
  await cp.requestStart({ jobId: job3.jobId });
  const submitted3 = await until(async () => (await cp.getForUi(job3.jobId)).state === "SUBMITTED", { timeoutMs: 20_000 });
  check("E27 SUBMIT_ATTEMPTED is durable before the provider result is known", Boolean(submitted3));
  await agent.stop();                       // simulate the machine vanishing mid-run
  await sleep(800);
  const after = await cp.getForUi(job3.jobId);
  check("E28 a disconnect does NOT release a possibly-submitted attempt", after.state === "SUBMITTED");
  const stillOwned = (await T((c) => c.query("SELECT assigned_worker_id, terminal_at FROM job_offers WHERE job_id=$1", [job3.jobId]))).rows[0];
  check("E29 the attempt stays owned by the vanished worker (no re-offer, no second submission)",
    stillOwned.assigned_worker_id === workerId && stillOwned.terminal_at === null);

  // (c) reconnect + replay: the agent comes back and re-reports; nothing happens twice
  executor.behaviour = "OK";
  agent = createRemoteWorkerAgent({ studioUrl, workerId, getCredential: async () => credential, executor, bundleVersion: "1.1.0", buildCommit: "cert001", reconnect: true });
  await agent.start();
  check("E30 the worker reconnects after a restart", Boolean(await until(() => agent.status().connected)));
  const cmdCountBefore = Number((await T((c) => c.query("SELECT count(*)::int n FROM remote_delivery_commands WHERE workspace_id=$1 AND job_id=$2", [ws, job3.jobId]))).rows[0].n);
  await sleep(1500);
  const cmdCountAfter = Number((await T((c) => c.query("SELECT count(*)::int n FROM remote_delivery_commands WHERE workspace_id=$1 AND job_id=$2", [ws, job3.jobId]))).rows[0].n);
  check("E31 reconnecting replays nothing into the durable ledger", cmdCountAfter === cmdCountBefore);
  const invocations = Number((await T((c) => c.query("SELECT count(*)::int n FROM generation_jobs WHERE workspace_id=$1 AND invocation_state='CONSUMED'", [ws]))).rows[0].n);
  check("E32 the invocation ledger counts exactly the attempts that reached the provider", invocations === 2);

  // (d) the stranded attempt is settled by the hub, not by a retry
  await hub.delivery.fail(ws, { workerId, jobId: job3.jobId, commandId: "cmd_settle_stranded01", sequence: 99, code: "E_GENERATION_RUN_ERROR" });
  check("E33 a stranded post-submit attempt settles SUBMIT_UNCERTAIN (never re-run)",
    (await cp.getForUi(job3.jobId)).state === "SUBMIT_UNCERTAIN");

  // (e) DRAIN: no new work, existing identity intact
  await hub.requestDrain(ws, workerId);
  assignment.invalidate();
  const drained = await until(() => agent.status().draining === true, { timeoutMs: 5000 });
  check("E34 DRAIN reaches the live agent", Boolean(drained));
  const job4 = await cp.enqueue({ prompt: "must not run while draining" });
  const blocked4 = await cp.requestStart({ jobId: job4.jobId });
  check("E35 a draining worker gets no new offer and the job is NOT run locally instead",
    blocked4.blocked === true && blocked4.reason === "DRAINING");
  await sleep(1200);
  check("E36 the drained worker really did not execute it", (await cp.getForUi(job4.jobId)).state === "QUEUED");

  // (f) revoke: the socket drops and cannot come back
  await registry.approve(ws, workerId);
  assignment.invalidate();
  await pairing.revokeCredential({ workspaceId: ws, workerId, actorId: user, reason: "cert" });
  const gone = await until(() => agent.status().connected === false, { timeoutMs: 8000 });
  check("E37 revoking the credential drops the live session", Boolean(gone));
  await sleep(1500);
  check("E38 a revoked worker cannot re-authenticate", agent.status().connected === false);
  check("E39 the hub reports no connected workers after revocation", hub.connectedWorkerIds().length === 0);

  // (g) rotation restores service with a NEW credential, and the old one stays dead
  const rotated = await pairing.rotateCredential({ workspaceId: ws, workerId, actorId: user });
  check("E40 rotation issues a new credential (plaintext returned once, never to a browser)", typeof rotated.credential === "string" && rotated.credential !== credential);
  await agent.stop();
  const agent2 = createRemoteWorkerAgent({ studioUrl, workerId, getCredential: async () => rotated.credential, executor, bundleVersion: "1.1.0", buildCommit: "cert001", reconnect: true });
  agent = agent2;
  await agent.start();
  check("E41 the worker reconnects with the rotated credential", Boolean(await until(() => agent.status().connected, { timeoutMs: 8000 })));
  const oldCredAgent = createRemoteWorkerAgent({ studioUrl, workerId, getCredential: async () => credential, executor, reconnect: false });
  await oldCredAgent.start();
  await sleep(700);
  check("E42 the OLD credential is dead after rotation", oldCredAgent.status().workspaceId === null);
  await oldCredAgent.stop();

  // (h) the queued job now runs on the re-enabled worker — proving the queue never lost it
  await registry.approve(ws, workerId);
  assignment.invalidate();
  await cp.requestStart({ jobId: job4.jobId });
  check("E43 the job that waited through drain/revoke/rotate finally completes remotely",
    Boolean(await until(async () => (await cp.getForUi(job4.jobId)).state === "COMPLETED", { timeoutMs: 30_000 })));

  // ================================================================ 6. upload hardening over real HTTP
  // Hold the attempt open (the executor blocks after SUBMIT_ATTEMPTED) so the upload endpoint can be
  // exercised against a LIVE, owned attempt rather than a settled one.
  executor.behaviour = "HANG";
  const job5 = await cp.enqueue({ prompt: "upload hardening" });
  await cp.requestStart({ jobId: job5.jobId });
  await until(async () => (await T((c) => c.query("SELECT accepted_at FROM job_offers WHERE job_id=$1", [job5.jobId]))).rows[0]?.accepted_at, { timeoutMs: 15_000 });
  // grant an upload for job5, then try to abuse it
  const g = await hub.delivery.grantUpload(ws, { workerId, jobId: job5.jobId, sha256: "d".repeat(64), sizeBytes: 16 });
  const noAuth = await fetch(`${studioUrl}/api/worker/artifact`, { method: "POST", headers: { "x-avc-upload": g.token, "content-length": "16" }, body: Buffer.alloc(16) });
  check("E44 an upload without a worker credential is refused 401", noAuth.status === 401);
  const wrongLen = await fetch(`${studioUrl}/api/worker/artifact`, {
    method: "POST", headers: { Authorization: `Bearer ${rotated.credential}`, "x-avc-upload": g.token, "content-length": "8" }, body: Buffer.alloc(8)
  });
  check("E45 a Content-Length that disagrees with the grant is refused", wrongLen.status === 409);
  const badToken = await fetch(`${studioUrl}/api/worker/artifact`, {
    method: "POST", headers: { Authorization: `Bearer ${rotated.credential}`, "x-avc-upload": "x".repeat(40), "content-length": "16" }, body: Buffer.alloc(16)
  });
  check("E46 an unknown upload token is refused 403", badToken.status === 403);
  const corrupt = await fetch(`${studioUrl}/api/worker/artifact`, {
    method: "POST", headers: { Authorization: `Bearer ${rotated.credential}`, "x-avc-upload": g.token, "content-length": "16" }, body: Buffer.alloc(16, 1)
  });
  check("E47 bytes that do not hash to the declared sha256 are refused", corrupt.status === 409);
  const corruptBody = await corrupt.json().catch(() => ({}));
  check("E48 the refusal names the hash mismatch (a safe, actionable code)", corruptBody.code === "E_REMOTE_UPLOAD_HASH_MISMATCH");
  check("E49 a corrupt upload leaves NO file behind", !existsSync(path.join(mediaRoot, "jobs", job5.jobId, "generated.mp4")));
  const wrongMethod = await fetch(`${studioUrl}/api/worker/artifact`, { method: "GET" });
  check("E50 the artifact endpoint refuses non-POST", wrongMethod.status === 405);
  // Settle the held attempt honestly: it reported SUBMIT_ATTEMPTED, so its only truthful terminal is uncertain.
  await hub.delivery.fail(ws, { workerId, jobId: job5.jobId, commandId: "cmd_settle_upload001", sequence: 99, code: "E_GENERATION_RUN_ERROR" });
  check("E50b the held attempt settles SUBMIT_UNCERTAIN, never a retry", (await cp.getForUi(job5.jobId)).state === "SUBMIT_UNCERTAIN");

  // ================================================================ 7. secrets never surfaced
  const anyCredInEvents = Number((await T((c) => c.query(
    "SELECT count(*)::int n FROM generation_job_events WHERE workspace_id=$1 AND detail::text LIKE '%wcred_%'", [ws]))).rows[0].n);
  check("E51 no credential value ever reached a job event", anyCredInEvents === 0);
  const anyCredInState = Number((await T((c) => c.query(
    "SELECT count(*)::int n FROM worker_runtime_state WHERE workspace_id=$1 AND (capabilities::text LIKE '%wcred_%' OR COALESCE(build_commit,'') LIKE '%wcred_%')", [ws]))).rows[0].n);
  check("E52 no credential value ever reached the worker runtime state", anyCredInState === 0);
  const statusJson = JSON.stringify(agent.status());
  check("E53 the agent status surface exposes no credential", !statusJson.includes("wcred_"));
  check("E54 the hub status surface exposes no credential or token", !JSON.stringify(hub.getStatus()).includes("wcred_"));

} finally {
  try { await agent?.stop?.(); } catch { /* */ }
  try { await hub?.stop?.(); } catch { /* */ }
  try { await new Promise((r) => (server ? server.close(r) : r())); } catch { /* */ }
  try { await adapter?.stop?.(); } catch { /* */ }
  await live.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`Step 5C.31 remote e2e: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
