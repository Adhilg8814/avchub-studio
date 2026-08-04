// P0 Step 5C.8B1 — deterministic FAKE video provider, injected at the real
// handler/provider dependency-injection boundary (JobRegistry handler.execute).
//
// This is a TEST provider. It NEVER: opens a network socket, launches a browser,
// executes Python, touches a real provider account, or consumes real quota. It:
//   - counts provider invocations PER generationAttemptId in a DURABLE evidence file
//     (survives a Worker process restart — the golden-rule exactly-once evidence);
//   - supports a controlled delay, deterministic success, and deterministic failure;
//   - writes exactly one small deterministic `.mp4` (fixed bytes, not playable) into
//     the OS temp media root and returns a RELATIVE ref + SAFE metadata only
//     (never an absolute path);
//   - runs through the NORMAL local-result path (ctx.markLocalResult).
//
// The exported handler wires the recovery-contract barrier ordering exactly:
//   onProgress(VALIDATING) → ctx.markSubmitting() → provider.invoke() [exactly once]
//   → ctx.markSubmittedToProvider() → progress → write .mp4 → ctx.markLocalResult()
//   → return safe result metadata.

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { generateId } from "../../lib/protocol/ids.mjs";
import { defineHandler } from "../../lib/worker/handlers/job-handler.mjs";

// deterministic FNV-1a hash → stable ids/bytes with no randomness
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function hashHex(str, len = 32) {
  let out = ""; let seed = str;
  while (out.length < len) { out += fnv1a32(seed).toString(16).padStart(8, "0"); seed = `${out}:${str}`; }
  return out.slice(0, len);
}
function short(id) { const b = String(id ?? "").split("_")[1] ?? "unknown"; return b.slice(-10).toLowerCase(); }

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (!ms || ms <= 0) return resolve();
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// createFakeVideoProvider({ root, delayMs?, mode?, crash? }) — root is an OS temp dir OUTSIDE
// the repo. Everything the provider writes lives under root/. mode: "success" (default) or "fail".
// crash: an optional test-only crash controller (createCrashController) — no-op when unarmed.
//
// The provider keeps TWO durable stores:
//   - evidence/invocations.json — the exactly-once invocation counter (survives restart).
//   - evidence/ledger.json      — a per-attempt reconciliation ledger { opId, invocationStartedAt,
//     submittedAt, localResultAt, artifactId, relativePath } so a RESTARTED worker can ask
//     `lookupOp(attemptId)` whether a prior provider operation already began/submitted/produced —
//     WITHOUT re-invoking. Ledger holds ONLY ids + relative paths (no secrets/URLs/absolute paths).
export function createFakeVideoProvider({ root, delayMs = 0, mode = "success", crash = null } = {}) {
  if (!root || typeof root !== "string") throw new Error("createFakeVideoProvider requires a root dir");
  const evidenceDir = path.join(root, "evidence");
  const mediaDir = path.join(root, "media");
  const evidenceFile = path.join(evidenceDir, "invocations.json");
  const ledgerFile = path.join(evidenceDir, "ledger.json");
  const noCrash = { maybeCrash() {}, async waitRelease() {} };
  const gate = crash || noCrash;

  function ensure(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
  function readEvidence() {
    try { return JSON.parse(readFileSync(evidenceFile, "utf8")); } catch { return { counts: {}, log: [] }; }
  }
  function writeEvidenceAtomic(data) {
    ensure(evidenceDir);
    const tmp = path.join(evidenceDir, `.tmp-${generateId("msg").slice(4)}-invocations.json`);
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, evidenceFile);
  }
  function readLedger() { try { return JSON.parse(readFileSync(ledgerFile, "utf8")); } catch { return { ops: {} }; } }
  function writeLedger(data) { ensure(evidenceDir); const tmp = path.join(evidenceDir, `.tmp-${generateId("msg").slice(4)}-ledger.json`); writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8"); renameSync(tmp, ledgerFile); }
  // Durably patch the reconciliation op for an attempt (safe fields only).
  function patchOp(generationAttemptId, patch) {
    const led = readLedger();
    const key = generationAttemptId || "unknown";
    led.ops[key] = { generationAttemptId: key, ...(led.ops[key] || {}), ...patch };
    writeLedger(led);
    return led.ops[key];
  }
  // Durably record ONE provider invocation for an attempt, BEFORE doing any work,
  // so the count survives a crash between here and the result (worst case for the
  // golden rule). Returns the new count for that attempt.
  function recordInvocation(generationAttemptId, meta) {
    const ev = readEvidence();
    const key = generationAttemptId || "unknown";
    ev.counts[key] = (ev.counts[key] || 0) + 1;
    ev.log.push({ generationAttemptId: key, at: new Date().toISOString(), n: ev.counts[key], ...meta });
    writeEvidenceAtomic(ev);
    return ev.counts[key];
  }

  return {
    root, evidenceFile, ledgerFile, mediaDir,
    getInvocationCount(generationAttemptId) { return readEvidence().counts[generationAttemptId || "unknown"] || 0; },
    getTotalInvocations() { const c = readEvidence().counts; return Object.values(c).reduce((a, b) => a + b, 0); },
    // The payload the ACTUAL WorkerRuntime handed the handler on its (single) invocation.
    getLastReceived(generationAttemptId) {
      const log = readEvidence().log.filter((e) => e.generationAttemptId === (generationAttemptId || "unknown"));
      return log.length ? (log[log.length - 1].received ?? null) : null;
    },
    readEvidence,
    readLedger,
    // Reconciliation lookup: does a prior provider operation exist for this attempt? (null if none)
    lookupOp(generationAttemptId) { return readLedger().ops[generationAttemptId || "unknown"] || null; },

    // invoke(generationAttemptId, input, { signal, onProgress, received }) — the single
    // provider call. Counts the invocation durably FIRST (recording the exact payload the
    // actual WorkerRuntime handed the handler, for the outbox-vs-Worker comparison), then
    // (success) writes one deterministic .mp4 and returns a relative ref + safe metadata;
    // (fail) throws after counting.
    async invoke(generationAttemptId, input = {}, { signal, onProgress, received } = {}) {
      const providerSubmissionId = generateId("submission");
      const opId = generateId("submission");
      // Count the invocation + record the reconciliation op START durably FIRST, so both survive a
      // crash between here and the result (the worst case for the golden rule).
      recordInvocation(generationAttemptId, { providerSubmissionId, opId, mode, received: received ?? null });
      patchOp(generationAttemptId, { opId, invocationStartedAt: new Date().toISOString() });
      // CRASH WINDOW (scenario 7): provider op has durably started (uncertain), but no accept/media yet.
      gate.maybeCrash("AFTER_INVOKE_START", { generationAttemptId, opId });
      if (typeof onProgress === "function") onProgress({ phase: "SUBMITTING_PROMPT", percent: 25, label: "Submitting (fake)" });
      // Effective delay: a control file (delay-control.txt) overrides the spawn delay at RUNTIME,
      // so one long-lived Worker can serve fast + slow scenarios without a restart.
      let effDelay = delayMs;
      try { const dc = readFileSync(path.join(root, "delay-control.txt"), "utf8").trim(); if (dc) effDelay = Math.max(0, Number.parseInt(dc, 10) || 0); } catch { /* no override */ }
      await sleep(effDelay, signal);
      if (mode === "fail") {
        const err = new Error("fake provider deterministic failure");
        err.code = "E_FAKE_PROVIDER_FAILED";
        throw err;
      }
      // Provider "accepted" the submission (deterministic) — record durable submitted evidence.
      patchOp(generationAttemptId, { submittedAt: new Date().toISOString(), providerSubmissionId });
      if (typeof onProgress === "function") onProgress({ phase: "WAITING_FOR_RESULT", percent: 50, label: "Rendering (fake)" });

      // Deterministic small media bytes (fixed, not a playable video). ~1 KiB.
      const key = `${input.prompt ?? ""}|${input.durationSeconds ?? 0}|${input.aspectRatio ?? ""}`;
      const seedHex = hashHex(`mp4:${key}:${generationAttemptId}`, 64);
      const header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); // "....ftyp" — deterministic marker
      const body = Buffer.from(seedHex.repeat(16).slice(0, 1024), "ascii");
      const bytes = Buffer.concat([header, body]);
      const rel = path.posix.join("media", short(generationAttemptId), `${short(generationAttemptId)}_fake.mp4`);
      const abs = path.join(root, rel.split("/").join(path.sep));
      ensure(path.dirname(abs));
      const tmp = `${abs}.tmp-${generateId("msg").slice(4)}`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, abs);
      if (typeof onProgress === "function") onProgress({ phase: "DOWNLOADING", percent: 75, label: "Downloading (fake)" });

      const meta = {
        checksum: `sha256:${hashHex(`c:${key}:${generationAttemptId}`, 32)}`,
        sizeBytes: bytes.length,
        durationSec: Number.isInteger(input.durationSeconds) ? input.durationSeconds : 5,
        width: 1080, height: 1920, mimeType: "video/mp4",
        relativePath: rel // RELATIVE only — never an absolute path in metadata
      };
      const assetId = generateId("asset");
      patchOp(generationAttemptId, { localResultAt: new Date().toISOString(), artifactId: assetId, relativePath: rel });
      return { providerSubmissionId, relativePath: rel, absolutePath: abs, meta, assetId };
    }
  };
}

// makeFakeVideoHandler({ provider, crash? }) → a GENERATE_VIDEO JobHandler for JobRegistry.
// The handler is the injection boundary: it drives the recovery-contract barrier and calls the
// provider exactly once. It runs inside the REAL WorkerRuntime. `crash` is an optional test-only
// controller whose hooks are NO-OPS unless the Step 5C.8 runner armed them.
export function makeFakeVideoHandler({ provider, crash = null } = {}) {
  if (!provider) throw new Error("makeFakeVideoHandler requires a provider");
  const gate = crash || { maybeCrash() {}, async waitRelease() {} };
  return defineHandler({
    action: "GENERATE_VIDEO",
    capability: "video.generate",
    validate: () => {},
    recover: (record) => ({
      action: "GENERATE_VIDEO",
      submitted: record?.submittedToProvider === true,
      canReuseExistingResult: Boolean(record?.localResultRef)
    }),
    async execute(input, ctx) {
      const gaid = ctx.generationAttemptId;
      ctx.onProgress({ phase: "VALIDATING", percent: 0, label: "Validating" });
      // Deterministic race window for cancel-BEFORE-submit (scenario 11): pause, then re-check abort.
      await gate.waitRelease("BEFORE_MARK_SUBMITTING", { generationAttemptId: gaid });
      if (ctx.signal?.aborted) return { aborted: true };            // cancel arrived pre-submit → provider count 0
      gate.maybeCrash("BEFORE_MARK_SUBMITTING", { generationAttemptId: gaid });   // scenario 5 (no provider call yet)
      // Barrier BEFORE the provider call: persists SUBMITTING + generationOrdinal=1 (UNKNOWN).
      ctx.markSubmitting();
      // Deterministic race window for cancel-racing-SUBMITTING (scenario 12).
      await gate.waitRelease("AFTER_MARK_SUBMITTING", { generationAttemptId: gaid });
      gate.maybeCrash("AFTER_MARK_SUBMITTING", { generationAttemptId: gaid });     // scenario 6 (SUBMITTING persisted, no provider call)
      if (ctx.signal?.aborted) return { aborted: true };            // cancel raced SUBMITTING → provider count 0, ordinal 1 durable
      // EXACTLY ONE provider invocation. Capture the payload the ACTUAL runtime handed us for the
      // outbox comparison. The provider itself hosts the AFTER_INVOKE_START crash (scenario 7).
      const submission = await provider.invoke(gaid, input, {
        signal: ctx.signal, onProgress: (p) => ctx.onProgress(p),
        received: {
          action: "GENERATE_VIDEO",
          requestIdempotencyKey: ctx.requestIdempotencyKey ?? null,
          generationAttemptId: gaid ?? null,
          input
        }
      });
      // Persist the quota-safety flag synchronously right after submission.
      ctx.markSubmittedToProvider(submission.providerSubmissionId);
      if (ctx.signal?.aborted) return { aborted: true };
      // Normal local-result path: relative ref + safe metadata only.
      ctx.markLocalResult(submission.relativePath, submission.assetId, submission.meta);
      gate.maybeCrash("AFTER_LOCAL_RESULT", { generationAttemptId: gaid, relativePath: submission.relativePath }); // scenario 8 (media on disk, no terminal yet)
      ctx.onProgress({ phase: "IMPORTING", percent: 100, label: "Importing" });
      return {
        result: {
          asset: {
            assetId: submission.assetId, kind: "video", provider: "FAKE",
            reviewStatus: "PENDING", selected: false, approved: false, ...submission.meta
          },
          providerSubmissionId: submission.providerSubmissionId
        }
      };
    }
  });
}
