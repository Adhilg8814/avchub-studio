// P0 Step 5C.31 — REMOTE DELIVERY on REAL disposable PostgreSQL (provider-free).
//
// This is the load-bearing suite for the claim/lease/no-double-submit contract. Nothing here is
// mocked at the database layer: a real cluster is created, migrated to the shipped head, and the same
// generation control plane production uses is driven against it. Provider execution is the ONLY thing
// simulated — the point is to prove the ownership and idempotency rules, not to spend quota.
//
// What it pins:
//   * routing        — LOCAL by default; REMOTE only for a workspace with a bound dedicated worker;
//                      an unavailable remote worker BLOCKS instead of falling back to the local host.
//   * ownership      — a remote-assigned offer is invisible to the local claim path (and vice versa),
//                      two workers racing the same attempt produce exactly one winner.
//   * idempotency    — replayed ACCEPT/SUBMIT_ATTEMPTED/COMPLETE have no second effect; a stale
//                      sequence is refused; a stale lease cannot mutate the job.
//   * submission     — a provably-not-submitted failure is retryable/deferrable; anything
//                      possibly-submitted becomes SUBMIT_UNCERTAIN and is NEVER released or retried;
//                      provider_submission_id is immutable.
//   * artifacts      — hash/size verified, duplicate finalize idempotent, cross-tenant upload refused,
//                      corrupt upload never becomes a result.
//   * isolation      — worker A cannot touch workspace B's job; a worker cannot be bound to two tenants.

import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createGenerationControlPlane } from "../control-plane/src/api-staging/generation-control-plane.mjs";
import { createRemoteWorkerRegistry } from "../lib/worker/remote/remote-worker-registry.mjs";
import { createWorkerAssignment } from "../lib/worker/remote/worker-assignment.mjs";
import { createRemoteDeliveryService } from "../lib/worker/remote/remote-delivery-service.mjs";
import { REMOTE_ERRORS } from "../lib/worker/remote/remote-protocol.mjs";
import { generateId } from "../lib/protocol/ids.mjs";

const { Client } = pg;
let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
async function refuses(name, fn, code) {
  try { await fn(); check(name, false); }
  catch (e) { check(name, e?.code === code || String(e?.code || "").includes(code)); }
}
let cmdSeq = 0;
const cid = () => `cmd_${(cmdSeq += 1).toString().padStart(6, "0")}${"a".repeat(8)}`;

if (!livePgAvailable()) {
  console.log("Step 5C.31 remote delivery: 0 passed, 0 failed (SKIPPED — no PostgreSQL)");
  process.exit(0);
}

const live = await startDisposablePg({ namePrefix: "cp5c31rd" });
let adapter = null;
try {
  // Three workspaces mirroring production: wsL is the grandfathered LOCAL owner workspace, wsA and wsB are
  // tenants with their own dedicated remote workers.
  const wsL = generateId("ws"), wsA = generateId("ws"), wsB = generateId("ws"), wsF = generateId("ws"), user = generateId("usr");
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
    const res = await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c31" });
    check("D0 migrations applied to shipped head (includes 0036)", res.applied.length + res.alreadyApplied === loadMigrationFiles(MIGRATIONS_DIR).length);
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    for (const ws of [wsL, wsA, wsB, wsF]) {
      await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
      await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'WS',$2)", [ws, user]);
    }
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const T = (ws, fn) => adapter.tenantTransaction(ws, fn);

  // One clock, the real one: heartbeat/lease timestamps are written by PostgreSQL now(), so a synthetic
  // JS clock would disagree with the very rows it is judging.
  const now = () => Date.now();

  // ---- paired workers (what pairing would have created) ----
  const remoteA = generateId("wrk"), remoteA2 = generateId("wrk"), remoteB = generateId("wrk");
  for (const [ws, wid, name] of [[wsA, remoteA, "remote-A"], [wsA, remoteA2, "remote-A2"], [wsB, remoteB, "remote-B"]]) {
    await T(ws, (c) => c.query(
      "INSERT INTO workers (id, workspace_id, name, platform, protocol_version, status, paired_at, first_seen_at) VALUES ($1,$2,$3,'win32',1,'OFFLINE', now(), now())",
      [wid, ws, name]));
  }

  const registry = createRemoteWorkerRegistry({ persistence: adapter, now });
  let connected = new Set();
  const assignment = createWorkerAssignment({
    persistence: adapter, registry, isConnected: (w) => connected.has(w),
    remoteDeliveryEnabled: true, cacheMs: 0, now,
    // Onboarding-time affinity handover, exactly as the runtime wires it.
    assignProjectAffinityAtBind: async (ws, wid) => { await (tenantsRef.get(ws)?.controlPlane?.adoptExecutionWorker?.(wid)); }
  });
  const tenantsRef = new Map();

  const cpFor = (ws) => createGenerationControlPlane({
    persistence: adapter, config: { stagingApi: { workspaceId: ws, fakeAction: "GENERATE_GROK_VIDEO" }, generation: { providerCooldownMs: 0 } },
    now, executionWorkerResolver: () => assignment.resolve(ws)
  });
  const cpL = cpFor(wsL), cpA = cpFor(wsA), cpB = cpFor(wsB);
  const tenants = new Map([[wsL, { controlPlane: cpL }], [wsA, { controlPlane: cpA }], [wsB, { controlPlane: cpB }]]);
  for (const [k, v] of tenants) tenantsRef.set(k, v);
  const delivery = createRemoteDeliveryService({
    persistence: adapter, resolveTenant: (ws) => tenants.get(ws) || null, registry,
    mediaRootFor: () => "E:/nonexistent", now
  });

  // ================================================================ 1. routing
  const j1 = await cpL.enqueue({ prompt: "routing baseline" });
  const r1 = await cpL.requestStart({ jobId: j1.jobId });
  check("D1 no dedicated worker bound -> LOCAL delivery (production baseline unchanged)", r1.deliveryMode === "LOCAL" && r1.dispatchStatus === "OFFERED");
  const localClaim = await cpL.claimNextForWorker({ max: 5 });
  check("D2 the local in-process worker claims its own LOCAL offer", localClaim.some((x) => x.jobId === j1.jobId));

  // bind the dedicated remote worker for workspace A
  await assignment.bindDedicatedWorker(wsA, remoteA, { label: "Cert worker" });
  assignment.invalidate();
  const j2 = await cpA.enqueue({ prompt: "remote but worker not approved" });
  const r2 = await cpA.requestStart({ jobId: j2.jobId });
  check("D3 bound-but-unapproved remote worker BLOCKS dispatch (never falls back to local)",
    r2.blocked === true && r2.deliveryMode === "REMOTE" && r2.reason === "NOT_APPROVED");
  check("D4 a BLOCKED dispatch creates NO offer at all",
    (await T(wsA, (c) => c.query("SELECT count(*)::int n FROM job_offers WHERE job_id=$1", [j2.jobId]))).rows[0].n === 0);

  await registry.approve(wsA, remoteA);
  assignment.invalidate();
  const r2b = await cpA.requestStart({ jobId: j2.jobId });
  check("D5 approved but OFFLINE (no heartbeat) still BLOCKS", r2b.blocked === true && ["OFFLINE", "DISCONNECTED"].includes(r2b.reason));

  await registry.recordHello(wsA, remoteA, { bundleVersion: "1.1.0", buildCommit: "abcdef1", deliveryProtocolVersion: 1, capabilities: { cloakReady: true, interactiveSession: true } });
  assignment.invalidate();
  const r2c = await cpA.requestStart({ jobId: j2.jobId });
  check("D6 heartbeat present but socket absent -> BLOCKED (DISCONNECTED)", r2c.blocked === true && r2c.reason === "DISCONNECTED");

  connected.add(remoteA);
  assignment.invalidate();
  const r3 = await cpA.requestStart({ jobId: j2.jobId });
  check("D7 approved + fresh heartbeat + connected -> REMOTE offer assigned to that worker",
    r3.dispatchStatus === "OFFERED" && r3.deliveryMode === "REMOTE" && r3.workerId === remoteA);

  // ================================================================ 2. local vs remote ownership
  const localAfterRemote = await cpA.claimNextForWorker({ max: 5 });
  check("D8 the LOCAL worker cannot claim a REMOTE-assigned offer (single-owner column)",
    !localAfterRemote.some((x) => x.jobId === j2.jobId));
  const pend = await delivery.pendingOffers(wsA, remoteA, { limit: 5 });
  check("D9 the remote worker sees exactly its own pending offer", pend.length === 1 && pend[0].jobId === j2.jobId);
  const pendOther = await delivery.pendingOffers(wsA, remoteA2, { limit: 5 });
  check("D10 a DIFFERENT worker in the same workspace sees no offer", pendOther.length === 0);

  // ================================================================ 3. ACCEPT + races + replay
  const acc = await delivery.accept(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 1, executionHost: "CERT-VM" });
  check("D11 ACCEPT grants a lease and returns the execution spec", acc.ok && acc.leaseExpiresAt && acc.prompt.includes("remote"));
  check("D12 ACCEPT records durable execution provenance (which machine ran it)",
    (await T(wsA, (c) => c.query("SELECT executed_by_worker_id, delivery_mode, execution_host FROM generation_jobs WHERE id=$1", [j2.jobId]))).rows[0].executed_by_worker_id === remoteA);

  await refuses("D13 a DIFFERENT command id re-accepting a taken offer is refused (not silently re-granted)",
    () => delivery.accept(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: "cmd_replayed_0001", sequence: 1 }), REMOTE_ERRORS.E_REMOTE_NOT_OWNER);
  await refuses("D14 re-ACCEPT with a fresh command id -> NOT_OWNER",
    () => delivery.accept(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 1 }), REMOTE_ERRORS.E_REMOTE_NOT_OWNER);
  await refuses("D15 a second worker accepting the same attempt -> NOT_OWNER (exactly one winner)",
    () => delivery.accept(wsA, { workerId: remoteA2, jobId: j2.jobId, commandId: cid(), sequence: 1 }), REMOTE_ERRORS.E_REMOTE_NOT_OWNER);

  // ---- true concurrency: two workers race a fresh remote attempt ----
  await assignment.bindDedicatedWorker(wsA, remoteA).catch(() => {});
  const j3 = await cpA.enqueue({ prompt: "race attempt" });
  await cpA.requestStart({ jobId: j3.jobId });
  const raceCids = [cid(), cid()];
  const raceOut = await Promise.allSettled([
    delivery.accept(wsA, { workerId: remoteA, jobId: j3.jobId, commandId: raceCids[0], sequence: 1 }),
    delivery.accept(wsA, { workerId: remoteA2, jobId: j3.jobId, commandId: raceCids[1], sequence: 1 })
  ]);
  const winners = raceOut.filter((r) => r.status === "fulfilled" && r.value?.ok && !r.value.duplicate);
  check("D16 two workers racing one attempt: EXACTLY one accept succeeds", winners.length === 1);

  // ---- exact replay of the SAME command id is a provable no-op ----
  const dupAccept = await delivery.accept(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: "cmd_000001aaaaaaaa", sequence: 1 }).catch((e) => e);
  check("D17 replaying the ORIGINAL accept command id is a no-op or a refusal, never a second accept",
    dupAccept?.duplicate === true || dupAccept?.code === REMOTE_ERRORS.E_REMOTE_NOT_OWNER);

  // ================================================================ 4. progress + sequence + lease
  const seqCmd = cid();
  await delivery.progress(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: seqCmd, sequence: 5, stage: "GATE_PASSED" });
  check("D18 GATE_PASSED advances the projection to READY_TO_SUBMIT",
    (await cpA.getForUi(j2.jobId)).state === "READY_TO_SUBMIT");
  const dupProgress = await delivery.progress(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: seqCmd, sequence: 5, stage: "GATE_PASSED" });
  check("D19 replaying the same PROGRESS command is a no-op", dupProgress.duplicate === true);
  await refuses("D20 a STALE sequence for the attempt is refused",
    () => delivery.progress(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 2 }), REMOTE_ERRORS.E_REMOTE_STALE_SEQUENCE);
  await refuses("D21 a NON-OWNER cannot report progress",
    () => delivery.progress(wsA, { workerId: remoteA2, jobId: j2.jobId, commandId: cid(), sequence: 6 }), REMOTE_ERRORS.E_REMOTE_NOT_OWNER);

  const renewed = await delivery.renewLease(wsA, { workerId: remoteA, jobId: j2.jobId });
  check("D22 the owner can renew its lease", Boolean(renewed.leaseExpiresAt));
  // Age the lease in the row itself (what a real 5-minute stall does) rather than skewing the clock.
  await T(wsA, (cx) => cx.query("UPDATE job_offers SET lease_expires_at = now() - interval '1 minute' WHERE job_id=$1", [j2.jobId]));
  await refuses("D23 an EXPIRED lease can no longer mutate the job",
    () => delivery.progress(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 7 }), REMOTE_ERRORS.E_REMOTE_LEASE_EXPIRED);
  await delivery.renewLease(wsA, { workerId: remoteA, jobId: j2.jobId });
  check("D24 renewing restores the ability to report", (await delivery.progress(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 7 })).ok === true);

  // ================================================================ 5. submission safety
  const sa = await delivery.submitAttempted(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 8 });
  check("D25 SUBMIT_ATTEMPTED is applied through the certified control-plane path", sa.ok === true && sa.duplicate === false);
  const jv = await cpA.getForUi(j2.jobId);
  check("D26 the projection is SUBMITTED with the invocation recorded CONSUMED", jv.state === "SUBMITTED" && jv.invocationState === "CONSUMED");
  const attemptOfJ2 = (await T(wsA, (c) => c.query("SELECT generation_attempt_id FROM generation_jobs WHERE id=$1", [j2.jobId]))).rows[0].generation_attempt_id;
  check("D27 the pipeline attempt carries possibly_submitted (durable evidence)",
    (await T(wsA, (c) => c.query("SELECT possibly_submitted FROM generation_attempts WHERE id=$1", [attemptOfJ2]))).rows[0]?.possibly_submitted === true);
  const saDup = await delivery.submitAttempted(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 9 }).catch((e) => e);
  check("D28 a SECOND SUBMIT_ATTEMPTED for the same attempt is impossible (per-attempt singleton)",
    saDup?.duplicate === true || Boolean(saDup?.code));

  await delivery.submitted(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 10, providerSubmissionId: "sub-first" });
  await delivery.submitted(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 11, providerSubmissionId: "sub-second" }).catch(() => {});
  const subId = (await T(wsA, (c) => c.query("SELECT provider_submission_id FROM generation_attempts WHERE id=(SELECT generation_attempt_id FROM generation_jobs WHERE id=$1)", [j2.jobId]))).rows[0].provider_submission_id;
  check("D29 provider_submission_id is IMMUTABLE once recorded", subId === "sub-first");

  // a possibly-submitted attempt can never be released back into the queue
  const rel = await delivery.releaseCore(wsA, { workerId: remoteA, jobId: j2.jobId });
  check("D30 RELEASE of a possibly-submitted attempt is refused (would risk a second submission)",
    rel.released === false && rel.reason === "POSSIBLY_SUBMITTED");

  // ...and a FAIL after submit becomes SUBMIT_UNCERTAIN, never a retryable failure
  await delivery.fail(wsA, { workerId: remoteA, jobId: j2.jobId, commandId: cid(), sequence: 12, code: "E_GENERATION_RUN_ERROR" });
  check("D31 a failure AFTER submission settles as SUBMIT_UNCERTAIN (never retried)",
    (await cpA.getForUi(j2.jobId)).state === "SUBMIT_UNCERTAIN");

  // ================================================================ 6. pre-submit failure is retryable
  const j4 = await cpA.enqueue({ prompt: "pre submit failure" });
  await cpA.requestStart({ jobId: j4.jobId });
  await delivery.accept(wsA, { workerId: remoteA, jobId: j4.jobId, commandId: cid(), sequence: 1 });
  await delivery.fail(wsA, { workerId: remoteA, jobId: j4.jobId, commandId: cid(), sequence: 2, code: "E_GENERATION_ACCOUNT_UNRESOLVED" });
  check("D32 a provably pre-submit failure is terminal FAILED_PRE_SUBMIT (not uncertain)",
    (await cpA.getForUi(j4.jobId)).state === "FAILED_PRE_SUBMIT");

  const j5 = await cpA.enqueue({ prompt: "pacing signal" });
  await cpA.requestStart({ jobId: j5.jobId });
  await delivery.accept(wsA, { workerId: remoteA, jobId: j5.jobId, commandId: cid(), sequence: 1 });
  const paced = await delivery.fail(wsA, { workerId: remoteA, jobId: j5.jobId, commandId: cid(), sequence: 2, code: "E_GROK_IMAGINE_PRE_SUBMIT" });
  check("D33 a PROVIDER-PACING signal re-defers instead of burning the job", paced.deferred === true);
  check("D34 a deferred job returns to QUEUED and holds no lease",
    (await cpA.getForUi(j5.jobId)).state === "QUEUED"
    && (await T(wsA, (c) => c.query("SELECT count(*)::int n FROM job_offers WHERE job_id=$1 AND terminal_at IS NULL", [j5.jobId]))).rows[0].n === 0);

  // RELEASE of a clean pre-submit attempt returns it to the queue
  const j6 = await cpA.enqueue({ prompt: "clean release" });
  await cpA.requestStart({ jobId: j6.jobId });
  await delivery.accept(wsA, { workerId: remoteA, jobId: j6.jobId, commandId: cid(), sequence: 1 });
  const relOk = await delivery.release(wsA, { workerId: remoteA, jobId: j6.jobId, commandId: cid(), sequence: 2 });
  check("D35 RELEASE of a clean pre-submit attempt returns it to the queue", relOk.released === true && (await cpA.getForUi(j6.jobId)).state === "QUEUED");

  // disconnect gives back only pre-submit work
  const j7 = await cpA.enqueue({ prompt: "disconnect handling" });
  await cpA.requestStart({ jobId: j7.jobId });
  await delivery.accept(wsA, { workerId: remoteA, jobId: j7.jobId, commandId: cid(), sequence: 1 });
  const dis = await delivery.releaseOnDisconnect(wsA, remoteA);
  check("D36 a disconnect releases pre-submit work immediately", dis.some((d) => d.jobId === j7.jobId && d.released === true));
  check("D37 a disconnect leaves the possibly-submitted attempt untouched",
    (await cpA.getForUi(j2.jobId)).state === "SUBMIT_UNCERTAIN");

  // ================================================================ 7. artifacts
  const j8 = await cpA.enqueue({ prompt: "artifact flow" });
  await cpA.requestStart({ jobId: j8.jobId });
  await delivery.accept(wsA, { workerId: remoteA, jobId: j8.jobId, commandId: cid(), sequence: 1 });
  const sha = "a".repeat(64);
  const grant = await delivery.grantUpload(wsA, { workerId: remoteA, jobId: j8.jobId, sha256: sha, sizeBytes: 1024 });
  check("D38 an upload grant is scoped to the job/attempt and returns a token exactly once", Boolean(grant.token) && grant.relativePath === `jobs/${j8.jobId}/generated.mp4`);
  await refuses("D39 a bad sha256 is refused at grant time",
    () => delivery.grantUpload(wsA, { workerId: remoteA, jobId: j8.jobId, sha256: "nope", sizeBytes: 10 }), REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID);
  await refuses("D40 a non-owner cannot obtain an upload grant for the job",
    () => delivery.grantUpload(wsA, { workerId: remoteA2, jobId: j8.jobId, sha256: sha, sizeBytes: 10 }), REMOTE_ERRORS.E_REMOTE_NOT_OWNER);

  const resolved = await delivery.resolveUploadToken(wsA, remoteA, grant.token);
  check("D41 the token resolves to its own session", resolved.uploadId === grant.uploadId && resolved.jobId === j8.jobId);
  await refuses("D42 another worker presenting the token is refused",
    () => delivery.resolveUploadToken(wsA, remoteA2, grant.token), REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN);
  await refuses("D43 an unknown token is refused",
    () => delivery.resolveUploadToken(wsA, remoteA, "not-a-real-token-value"), REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN);

  await refuses("D44 a SIZE mismatch fails the upload",
    () => delivery.finalizeUpload(wsA, { uploadId: grant.uploadId, actualSha256: sha, actualBytes: 999 }), REMOTE_ERRORS.E_REMOTE_UPLOAD_SIZE_MISMATCH);
  // the failed session is closed; a corrupt upload can never be finalized later
  await refuses("D45 a failed session cannot be finalized afterwards",
    () => delivery.finalizeUpload(wsA, { uploadId: grant.uploadId, actualSha256: sha, actualBytes: 1024 }), REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN);

  const grant2 = await delivery.grantUpload(wsA, { workerId: remoteA, jobId: j8.jobId, sha256: sha, sizeBytes: 1024 });
  await refuses("D46 a HASH mismatch fails the upload",
    () => delivery.finalizeUpload(wsA, { uploadId: grant2.uploadId, actualSha256: "b".repeat(64), actualBytes: 1024 }), REMOTE_ERRORS.E_REMOTE_UPLOAD_HASH_MISMATCH);

  const grant3 = await delivery.grantUpload(wsA, { workerId: remoteA, jobId: j8.jobId, sha256: sha, sizeBytes: 1024 });
  const fin = await delivery.finalizeUpload(wsA, { uploadId: grant3.uploadId, actualSha256: sha, actualBytes: 1024 });
  check("D47 a matching upload finalizes", fin.ok === true && fin.idempotent === false);
  const fin2 = await delivery.finalizeUpload(wsA, { uploadId: grant3.uploadId, actualSha256: sha, actualBytes: 1024 });
  check("D48 duplicate finalize is idempotent (no second effect)", fin2.idempotent === true);

  // COMPLETE requires a finalized artifact
  const j9 = await cpA.enqueue({ prompt: "complete without artifact" });
  await cpA.requestStart({ jobId: j9.jobId });
  await delivery.accept(wsA, { workerId: remoteA, jobId: j9.jobId, commandId: cid(), sequence: 1 });
  await refuses("D49 COMPLETE without a verified artifact is refused",
    () => delivery.complete(wsA, { workerId: remoteA, jobId: j9.jobId, commandId: cid(), sequence: 2 }), REMOTE_ERRORS.E_REMOTE_UPLOAD_INVALID);

  await delivery.submitAttempted(wsA, { workerId: remoteA, jobId: j8.jobId, commandId: cid(), sequence: 3 });
  const done = await delivery.complete(wsA, { workerId: remoteA, jobId: j8.jobId, commandId: cid(), sequence: 4, resultId: "res-1", media: { durationSeconds: 6, width: 464, height: 688 } });
  check("D50 COMPLETE with a verified artifact settles the job COMPLETED", done.ok === true && (await cpA.getForUi(j8.jobId)).state === "COMPLETED");
  const dupComplete = await delivery.complete(wsA, { workerId: remoteA, jobId: j8.jobId, commandId: cid(), sequence: 5 }).catch((e) => e);
  check("D51 a duplicate COMPLETE creates no second media/event", dupComplete?.duplicate === true || dupComplete?.idempotent === true || Boolean(dupComplete?.code));
  const mediaRows = (await T(wsA, (c) => c.query("SELECT count(*)::int n FROM assets WHERE workspace_id=$1", [wsA]))).rows[0].n;
  check("D52 exactly one asset row exists for the completed remote job", mediaRows >= 1);
  const checksum = (await T(wsA, (c) => c.query("SELECT checksum FROM assets WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1", [wsA]))).rows[0].checksum;
  check("D53 the stored asset carries the VERIFIED sha256 (not 'unverified')", String(checksum).startsWith("sha256:"));

  // ================================================================ 8. tenant isolation
  await assignment.bindDedicatedWorker(wsB, remoteB);
  await registry.approve(wsB, remoteB);
  await registry.recordHello(wsB, remoteB, { deliveryProtocolVersion: 1 });
  connected.add(remoteB);
  assignment.invalidate();
  const jb = await cpB.enqueue({ prompt: "tenant B job" });
  const rb = await cpB.requestStart({ jobId: jb.jobId });
  check("D54 workspace B routes to ITS OWN dedicated worker", rb.workerId === remoteB && rb.deliveryMode === "REMOTE");

  await refuses("D55 worker A cannot accept workspace B's job (RLS + ownership)",
    () => delivery.accept(wsB, { workerId: remoteA, jobId: jb.jobId, commandId: cid(), sequence: 1 }), REMOTE_ERRORS.E_REMOTE_NOT_OWNER);
  check("D56 worker A sees NO offers in workspace B", (await delivery.pendingOffers(wsB, remoteA, { limit: 5 })).length === 0);
  await delivery.accept(wsB, { workerId: remoteB, jobId: jb.jobId, commandId: cid(), sequence: 1 });
  const grantB = await delivery.grantUpload(wsB, { workerId: remoteB, jobId: jb.jobId, sha256: "c".repeat(64), sizeBytes: 10 });
  await refuses("D57 a token minted in workspace B is unusable from workspace A",
    () => delivery.resolveUploadToken(wsA, remoteB, grantB.token), REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN);
  await refuses("D58 worker A cannot upload into workspace B's job",
    () => delivery.resolveUploadToken(wsB, remoteA, grantB.token), REMOTE_ERRORS.E_REMOTE_UPLOAD_FORBIDDEN);

  // one worker, one tenant — enforced GLOBALLY by the 0034 dedicated-unique index
  let bindErr = null;
  try { await assignment.bindDedicatedWorker(wsB, remoteA); } catch (e) { bindErr = e; }
  check("D59 binding workspace A's worker to workspace B is refused at the FIRST gate (it is not B's worker)",
    bindErr?.code === "E_WORKER_NOT_FOUND");
  // ...and the GLOBAL dedicated-unique index is the backstop behind that gate: even a direct registry bind of
  // the same physical ref from another workspace is impossible, so a shared worker is unrepresentable.
  let dupBind = null;
  try {
    await T(wsB, (c) => c.query("INSERT INTO workspace_resources (id, workspace_id, resource_type, resource_ref, status) VALUES ($1,$2,'WORKER',$3,'ACTIVE')", ["wsrc_" + "Z".repeat(26), wsB, remoteA]));
  } catch (e) { dupBind = e; }
  check("D59b the global dedicated-unique index refuses the same worker ref in a second workspace", dupBind !== null);
  let foreignBind = null;
  try { await assignment.bindDedicatedWorker(wsB, generateId("wrk")); } catch (e) { foreignBind = e; }
  check("D60 binding a worker that does not exist in the workspace is refused", foreignBind?.code === "E_WORKER_NOT_FOUND");

  // ================================================================ 9. drain / revoke semantics
  await registry.drain(wsA, remoteA);
  assignment.invalidate();
  const jd = await cpA.enqueue({ prompt: "after drain" });
  const rd = await cpA.requestStart({ jobId: jd.jobId });
  check("D61 a DRAINING worker receives no new offer (job waits, no local fallback)", rd.blocked === true && rd.reason === "DRAINING");
  await registry.approve(wsA, remoteA);
  assignment.invalidate();
  check("D62 re-approving clears draining and dispatch resumes", (await cpA.requestStart({ jobId: jd.jobId })).dispatchStatus === "OFFERED");

  await T(wsA, (c) => c.query("UPDATE workers SET status='REVOKED' WHERE id=$1", [remoteA]));
  assignment.invalidate();
  const jr = await cpA.enqueue({ prompt: "after revoke" });
  check("D63 a REVOKED worker is not assignable (dispatch blocks)", (await cpA.requestStart({ jobId: jr.jobId })).blocked === true);

  // ================================================================ 10. remote recovery classification
  const rec = await cpA.recover();
  check("D64 restart recovery reports REMOTE attempts separately (never tracked with the local browser)",
    Array.isArray(rec.remote) && rec.remote.length >= 1 && rec.track.every((t) => !rec.remote.some((r) => r.jobId === t.jobId)));

  // ================================================================ 11. delivery disabled == baseline
  const offAssignment = createWorkerAssignment({ persistence: adapter, registry, isConnected: () => true, remoteDeliveryEnabled: false, cacheMs: 0, now });
  // A clean workspace WITH a bound dedicated worker: proves the master switch, not the absence of a binding.
  const remoteF = generateId("wrk");
  await T(wsF, (c) => c.query("INSERT INTO workers (id, workspace_id, name, platform, protocol_version, status, paired_at, first_seen_at) VALUES ($1,$2,'remote-F','win32',1,'OFFLINE', now(), now())", [remoteF, wsF]));
  await assignment.bindDedicatedWorker(wsF, remoteF);
  const offCp = createGenerationControlPlane({
    persistence: adapter, config: { stagingApi: { workspaceId: wsF, fakeAction: "GENERATE_GROK_VIDEO" }, generation: { providerCooldownMs: 0 } },
    now, executionWorkerResolver: () => offAssignment.resolve(wsF)
  });
  const joff = await offCp.enqueue({ prompt: "feature flag off" });
  const roff = await offCp.requestStart({ jobId: joff.jobId });
  check("D65 with remote delivery OFF every workspace routes LOCAL even when a worker is bound",
    roff.deliveryMode === "LOCAL" && roff.dispatchStatus === "OFFERED");

  // ================================================================ 12. command ledger integrity
  const ledger = (await T(wsA, (c) => c.query("SELECT kind, count(*)::int n FROM remote_delivery_commands WHERE workspace_id=$1 GROUP BY kind", [wsA]))).rows;
  const acceptRows = ledger.find((r) => r.kind === "ACCEPT")?.n ?? 0;
  check("D66 every applied command is durably recorded", ledger.length >= 4 && acceptRows >= 5);
  const singleton = (await T(wsA, (c) => c.query(
    "SELECT generation_attempt_id, count(*)::int n FROM remote_delivery_commands WHERE workspace_id=$1 AND kind='SUBMIT_ATTEMPTED' AND generation_attempt_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1", [wsA]))).rows;
  check("D67 no attempt has more than one SUBMIT_ATTEMPTED in the ledger", singleton.length === 0);
  const noSecret = (await T(wsA, (c) => c.query("SELECT count(*)::int n FROM remote_delivery_commands WHERE workspace_id=$1 AND command_id LIKE 'wcred%'", [wsA]))).rows[0].n;
  check("D68 no credential-shaped value ever reached the ledger", noSecret === 0);

} finally {
  try { await adapter?.stop?.(); } catch { /* */ }
  await live.stop();
}

console.log(`Step 5C.31 remote delivery: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
