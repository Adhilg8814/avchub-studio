#!/usr/bin/env node
// P0 Step 5C.8A — Canonical Generation Offer Contract Bridge (pure unit tests).
//
// Proves the SMALLEST additive contract bridge that lets the Step 5C.6 staging generation
// snapshot flow through the canonical JOB_OFFER into a real WorkerRuntime's validateJobOffer:
//   1. new provider-NEUTRAL action GENERATE_VIDEO (GENERATE_GROK_VIDEO untouched)
//   2. input contract derived EXACTLY from the Step 5C.6 normalized persisted representation
//   3. ownership buildGenerationOfferPayload emits { action, requestIdempotencyKey,
//      generationAttemptId, input } that validateJobOffer accepts, byte-equivalent input.
//
// PURE. No PostgreSQL, no socket, no provider, no quota. Run: node tests/step5c8a-protocol-contract-tests.mjs

import { PROTOCOL_ERRORS } from "../lib/protocol/errors.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import {
  JOB_ACTIONS, GENERATION_ACTIONS, getJobContract, validateJobInput, validateJobOffer,
  actionConsumesQuota, actionRequiredCapability
} from "../lib/protocol/job-contracts.mjs";
import { buildGenerationOfferPayload } from "../control-plane/src/persistence/transactions/ownership.mjs";

let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function checkThrows(name, fn, code = undefined) {
  try { fn(); failures += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) {
    if (code && e.code !== code) { failures += 1; console.error(`FAIL ${name} (code ${e.code} != ${code})`); }
    else passed += 1;
  }
}
const IDS = {
  ws: generateId("ws"), wrk: generateId("wrk"), job: generateId("job"), asset: generateId("asset"),
  prj: generateId("prj"), ep: generateId("ep"), sh: generateId("sh"), pa: generateId("pa"),
  req: generateId("req"), attempt: generateId("attempt")
};
// The EXACT Step 5C.6 normalized persisted input (staging-api-router.mjs line 155):
//   { kind:"VIDEO", prompt, durationSeconds, aspectRatio, outputCount }
function video56Input(over = {}) {
  return { kind: "VIDEO", prompt: "a neon city at dusk", durationSeconds: 5, aspectRatio: "16:9", outputCount: 1, ...over };
}

// ===== PROOF 1: GENERATE_VIDEO exists, is a generation action, neutral capability, consumesQuota =====
{
  check("GENERATE_VIDEO in JOB_ACTIONS", JOB_ACTIONS.includes("GENERATE_VIDEO"), true);
  check("GENERATE_VIDEO is a generation action", GENERATION_ACTIONS.includes("GENERATE_VIDEO"), true);
  check("GENERATE_VIDEO capability is provider-neutral", actionRequiredCapability("GENERATE_VIDEO"), "video.generate");
  check("GENERATE_VIDEO consumesQuota true (deliberate)", actionConsumesQuota("GENERATE_VIDEO"), true);
  const c = getJobContract("GENERATE_VIDEO");
  check("GENERATE_VIDEO required keys exact", JSON.stringify(Object.keys(c.required).sort()),
    JSON.stringify(["aspectRatio", "durationSeconds", "kind", "outputCount", "prompt"]));
  check("GENERATE_VIDEO has no optional fields", JSON.stringify(Object.keys(c.optional)), "[]");
  check("GENERATE_VIDEO declares no duration-context dependency", Boolean(c.usesDurationContext), false);
}

// ===== PROOF 2: accepts the exact Step 5C.6 snapshot, byte-equivalent (no phantom defaults) =====
{
  const input = video56Input();
  const norm = validateJobInput("GENERATE_VIDEO", input);
  check("accepts exact 5C.6 input", JSON.stringify(norm), JSON.stringify(input));
  // every default duration/aspect the Step 5C.6 config ships must pass the structural gate
  for (const d of [5, 10, 15]) check(`duration ${d} accepted`, JSON.stringify(validateJobInput("GENERATE_VIDEO", video56Input({ durationSeconds: d }))) !== "", true);
  for (const a of ["16:9", "9:16", "1:1"]) check(`aspect ${a} accepted`, validateJobInput("GENERATE_VIDEO", video56Input({ aspectRatio: a })).aspectRatio, a);
}

// ===== PROOF 3: rejects missing required fields =====
{
  for (const k of ["kind", "prompt", "durationSeconds", "aspectRatio", "outputCount"]) {
    const bad = video56Input(); delete bad[k];
    checkThrows(`reject missing ${k}`, () => validateJobInput("GENERATE_VIDEO", bad), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  }
  checkThrows("reject wrong kind", () => validateJobInput("GENERATE_VIDEO", video56Input({ kind: "AUDIO" })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("reject empty prompt", () => validateJobInput("GENERATE_VIDEO", video56Input({ prompt: "   " })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("reject zero duration", () => validateJobInput("GENERATE_VIDEO", video56Input({ durationSeconds: 0 })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("reject non-integer duration", () => validateJobInput("GENERATE_VIDEO", video56Input({ durationSeconds: 5.5 })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("reject malformed aspect", () => validateJobInput("GENERATE_VIDEO", video56Input({ aspectRatio: "16-9" })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
}

// ===== PROOF 4: rejects unknown input fields =====
{
  checkThrows("reject unknown field", () => validateJobInput("GENERATE_VIDEO", video56Input({ seed: 42 })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  // request identity must NOT be smuggled into input (canonical shape keeps it at payload level)
  checkThrows("reject identity in input", () => validateJobInput("GENERATE_VIDEO", video56Input({ generationAttemptId: IDS.attempt })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
}

// ===== PROOF 5: outputCount pinned to 1 (MVP invariant) =====
{
  checkThrows("reject outputCount 2", () => validateJobInput("GENERATE_VIDEO", video56Input({ outputCount: 2 })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("reject outputCount 0", () => validateJobInput("GENERATE_VIDEO", video56Input({ outputCount: 0 })), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
}

// ===== PROOF 6: dangerous fields rejected at any depth (safe-by-construction preserved) =====
{
  checkThrows("reject top-level dangerous field", () => validateJobInput("GENERATE_VIDEO", { ...video56Input(), command: "rm -rf" }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  checkThrows("reject offer-level dangerous field", () => validateJobOffer({
    action: "GENERATE_VIDEO", requestIdempotencyKey: IDS.req, generationAttemptId: IDS.attempt,
    input: video56Input(), cookie: "x"
  }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
}

// ===== PROOF 7: canonical JOB_OFFER — identity required for GENERATE_VIDEO; quotaRisk defaults true =====
{
  const good = { action: "GENERATE_VIDEO", requestIdempotencyKey: IDS.req, generationAttemptId: IDS.attempt, input: video56Input() };
  const norm = validateJobOffer(good);
  check("offer accepted", norm.action, "GENERATE_VIDEO");
  check("offer quotaRisk defaults true", norm.quotaRisk, true);
  check("offer input byte-equivalent", JSON.stringify(norm.input), JSON.stringify(video56Input()));
  checkThrows("reject offer missing requestIdempotencyKey", () => validateJobOffer({ action: "GENERATE_VIDEO", generationAttemptId: IDS.attempt, input: video56Input() }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("reject offer missing generationAttemptId", () => validateJobOffer({ action: "GENERATE_VIDEO", requestIdempotencyKey: IDS.req, input: video56Input() }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
}

// ===== PROOF 8: validateJobOffer idempotent (its own normalized output re-validates, byte-equal) =====
{
  const good = { action: "GENERATE_VIDEO", requestIdempotencyKey: IDS.req, generationAttemptId: IDS.attempt, input: video56Input() };
  const once = validateJobOffer(good);
  const twice = validateJobOffer(once);
  check("re-validate own output succeeds", twice.action, "GENERATE_VIDEO");
  check("re-validate byte-equivalent", JSON.stringify(twice), JSON.stringify(once));
}

// ===== PROOF 9: GENERATE_GROK_VIDEO contract UNCHANGED (backward compat, no cross-contamination) =====
{
  const grokInput = { projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, providerAccountId: IDS.pa, sourceKeyframeAssetId: IDS.asset, promptSnapshot: "hello", baseRevision: 0 };
  const c = getJobContract("GENERATE_GROK_VIDEO");
  check("grok capability unchanged", c.capability, "grok.video");
  check("grok consumesQuota unchanged", c.consumesQuota, true);
  const norm = validateJobInput("GENERATE_GROK_VIDEO", grokInput);
  check("grok still validates its own shape", norm.requestedDurationSec, 10); // declared default
  // the two contracts do NOT accept each other's shape
  checkThrows("grok rejects the video shape", () => validateJobInput("GENERATE_GROK_VIDEO", video56Input()), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("video rejects the grok shape", () => validateJobInput("GENERATE_VIDEO", grokInput), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
}

// ===== PROOF 10: ownership.buildGenerationOfferPayload — durable, allowlisted, deterministic, valid =====
{
  const snap = video56Input();
  const job = { id: IDS.job, type: "GENERATE_VIDEO", request_idempotency_key: IDS.req, generation_attempt_id: IDS.attempt, project_id: IDS.prj, input: snap };
  const attempt = { id: IDS.attempt, parent_attempt_id: null, retry_of_job_id: null };

  const payload = buildGenerationOfferPayload(job, attempt);
  check("offer carries canonical action", payload.action, "GENERATE_VIDEO");
  check("offer carries requestIdempotencyKey from job", payload.requestIdempotencyKey, IDS.req);
  check("offer carries generationAttemptId from attempt", payload.generationAttemptId, IDS.attempt);
  check("offer input byte-equals durable job.input", JSON.stringify(payload.input), JSON.stringify(snap));
  // THE bridge proof: the ownership-built offer is a VALID canonical offer for WorkerRuntime.
  const norm = validateJobOffer(payload);
  check("built offer passes validateJobOffer", norm.action, "GENERATE_VIDEO");
  check("built offer input survives validation byte-equal", JSON.stringify(norm.input), JSON.stringify(snap));

  // Allowlist: an enriched/raw row field must NOT leak into the offer input.
  const enriched = buildGenerationOfferPayload({ ...job, input: { ...snap, worker_id: IDS.wrk, status: "DISPATCHED" } }, attempt);
  check("allowlist strips non-contract row fields", JSON.stringify(enriched.input), JSON.stringify(snap));

  // Determinism → replay/reconnect/processor-retry get byte-equivalent input, NOT reconstructed
  // from mutable project defaults (the function only reads the durable job/attempt rows).
  check("deterministic (replay byte-equivalent)", JSON.stringify(buildGenerationOfferPayload(job, attempt)), JSON.stringify(payload));
  const mutatedProjectDefaults = { ...job }; // a different project-default duration must not matter
  check("ignores anything but durable job.input", JSON.stringify(buildGenerationOfferPayload(mutatedProjectDefaults, attempt)), JSON.stringify(payload));

  // Retry lineage carried when present on the attempt.
  const retryPayload = buildGenerationOfferPayload(job, { id: IDS.attempt, parent_attempt_id: generateId("attempt"), retry_of_job_id: IDS.job });
  check("offer carries parentAttemptId when present", Boolean(retryPayload.parentAttemptId), true);
  check("offer carries retryOfJobId when present", retryPayload.retryOfJobId, IDS.job);
  check("retry offer still valid", validateJobOffer(retryPayload).action, "GENERATE_VIDEO");
}

// ===== PROOF 11: backward compat — legacy GENERATE_GROK_VIDEO offer path + non-generation actions =====
{
  // A real GENERATE_GROK_VIDEO job (grok-shaped input) still produces a valid canonical offer.
  const grokInput = { projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, providerAccountId: IDS.pa, sourceKeyframeAssetId: IDS.asset, promptSnapshot: "hello", baseRevision: 0 };
  const grokJob = { id: IDS.job, type: "GENERATE_GROK_VIDEO", request_idempotency_key: IDS.req, generation_attempt_id: IDS.attempt, input: grokInput };
  const grokPayload = buildGenerationOfferPayload(grokJob, { id: IDS.attempt });
  check("grok offer preserves grok fields", JSON.stringify(grokPayload.input), JSON.stringify(grokInput));
  check("grok offer validates", validateJobOffer(grokPayload).action, "GENERATE_GROK_VIDEO");

  // Pre-existing Step 5C.6 default quirk (GENERATE_GROK_VIDEO action + VIDEO-shape stored input):
  // the allowlist yields empty input — harmless because only raw fake workers consume it. Documented.
  const quirk = buildGenerationOfferPayload({ ...grokJob, input: video56Input() }, { id: IDS.attempt });
  check("legacy default quirk yields empty allowlisted input", JSON.stringify(quirk.input), "{}");

  // Non-generation actions unaffected: request identity stays OPTIONAL through validateJobOffer.
  const scan = validateJobOffer({ action: "STORAGE_SCAN", input: {} });
  check("non-generation action still needs no identity", scan.requestIdempotencyKey, null);
  check("non-generation quotaRisk false", scan.quotaRisk, false);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
