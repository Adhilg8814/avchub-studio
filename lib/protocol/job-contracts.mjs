// AVC Studio Worker Protocol v1 — job action allowlist + strict input contracts.
//
// PURE MODULE. Imports only sibling pure modules. No fs/net/child_process/env.
// Safe for cloud + Worker.
//
// The cloud may ONLY send allowlisted actions whose input is identifiers +
// enumerated options. Worker resolves every real path from ids. This module
// rejects: unknown actions, unknown input fields, and dangerous field names at
// ANY nesting depth (command/cookie/token/path/…). No RUN_COMMAND ever.
//
// Spec: docs/local-first-saas-architecture.md §E, §E.1, §J; docs/protocol-v1.md §6.

import { PROTOCOL_ERRORS, protocolError } from "./errors.mjs";
import { validateId } from "./ids.mjs";

// ---- allowlisted actions ----
export const JOB_ACTIONS = Object.freeze([
  "CHECK_PROVIDER_SESSION",
  "OPEN_PROVIDER_LOGIN",
  "OPEN_PROVIDER",
  "GENERATE_CHATGPT_IMAGE",
  "GENERATE_GROK_IMAGE",
  "GENERATE_GROK_VIDEO",
  "GENERATE_VIDEO",
  "IMPORT_MEDIA",
  "EXPORT_PROJECT",
  "STORAGE_SCAN",
  "CLEANUP_DRY_RUN",
  "CREATE_PROJECT_ARCHIVE",
  "IMPORT_PROJECT_ARCHIVE"
]);
const ACTION_SET = new Set(JOB_ACTIONS);

// ---- enums ----
export const GROK_DURATIONS = Object.freeze([6, 10, 15]);
export const GROK_DEFAULT_DURATION = 10;
export const ASPECT_FIXED = "9:16";
export const PROVIDERS_ENUM = Object.freeze(["CHATGPT", "GROK", "ELEVENLABS", "OTHER"]);
export const OPEN_PROVIDER_TARGETS = Object.freeze(["home", "imagine", "chat", "voice", "library"]);
export const IMPORT_KINDS = Object.freeze(["image", "video", "audio", "reference"]);
export const EXPORT_LOCALES = Object.freeze([
  "en-US", "es-ES", "de-DE", "fr-FR", "it-IT", "sv-SE", "da-DK", "bg-BG"
]);
const MAX_PROMPT_CHARS = 4000;
const MAX_OPAQUE_KEY_CHARS = 64;
const OPAQUE_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/; // opaque Worker-local temp refs (transferRef/archiveRef)
const ASPECT_RATIO_RE = /^[0-9]{1,2}:[0-9]{1,2}$/; // structural ratio "W:H" (fine-grained allowlist lives at the Step 5C.6 API layer)
const VIDEO_DURATION_MAX_SEC = 3600; // safety ceiling only — NOT a business enum (see GENERATE_VIDEO)

// ---- dangerous field names (rejected at ANY depth) ----
export const DANGEROUS_FIELDS = Object.freeze([
  "command", "cmd", "shell", "executable", "executablePath",
  "script", "scriptPath", "browserArgs", "outputPath", "absolutePath",
  "cookie", "cookies", "password", "token", "accessToken", "refreshToken",
  "proxy", "proxyPassword", "fingerprint", "profilePath"
]);
// Case-insensitive match so `Cookie`, `COOKIE`, `passWord` are all caught.
const DANGEROUS_SET = new Set(DANGEROUS_FIELDS.map((f) => f.toLowerCase()));
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Recursively reject dangerous + pollution keys anywhere in the input.
function assertNoDangerousFields(value, path = "input") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertNoDangerousFields(value[i], `${path}[${i}]`);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (POLLUTION_KEYS.has(key)) {
        throw protocolError(PROTOCOL_ERRORS.E_DANGEROUS_FIELD, `Forbidden key at ${path}`, { key });
      }
      if (DANGEROUS_SET.has(key.toLowerCase())) {
        throw protocolError(PROTOCOL_ERRORS.E_DANGEROUS_FIELD,
          `Dangerous field "${key}" not allowed at ${path}`, { field: key });
      }
      assertNoDangerousFields(value[key], `${path}.${key}`);
    }
  }
}

// ---- field validators (each returns true/false) ----
const V = {
  id: (prefix) => (x) => validateId(x, prefix),
  bool: (x) => typeof x === "boolean",
  nonNegInt: (x) => Number.isInteger(x) && x >= 0,
  prompt: (x) => typeof x === "string" && x.trim().length > 0 && x.length <= MAX_PROMPT_CHARS,
  opaqueKey: (x) => typeof x === "string" && OPAQUE_KEY_RE.test(x),
  enum: (set) => (x) => set.has(x),
  durationReq: (x) => Number.isInteger(x) && GROK_DURATIONS.includes(x),
  aspect: (x) => x === ASPECT_FIXED,
  localeArray: (x) => Array.isArray(x) && x.length > 0 && x.every((l) => EXPORT_LOCALES.includes(l)),
  transferRef: (x) => validateId(x, "asset") || (typeof x === "string" && OPAQUE_KEY_RE.test(x)) // asset id OR opaque temp ref, never a path
};

const PROVIDER_SET = new Set(PROVIDERS_ENUM);
const TARGET_SET = new Set(OPEN_PROVIDER_TARGETS);
const KIND_SET = new Set(IMPORT_KINDS);

// ---- contracts ----
// Each: { capability, consumesQuota, required:{f:validator}, optional:{f:validator}, extra?(input,ctx) }
const CONTRACTS = {
  CHECK_PROVIDER_SESSION: {
    capability: null, consumesQuota: false,
    required: { providerAccountId: V.id("pa") }, optional: {}
  },
  OPEN_PROVIDER_LOGIN: {
    capability: null, consumesQuota: false,
    required: { providerAccountId: V.id("pa") }, optional: {}
  },
  OPEN_PROVIDER: {
    capability: null, consumesQuota: false,
    required: { providerAccountId: V.id("pa") },
    optional: { target: V.enum(TARGET_SET) } // enum, NEVER an arbitrary URL
  },
  // NOTE (P0 Step 3 canonical shape): action `input` holds ONLY action-specific
  // business data. Job-request identity (requestIdempotencyKey, generationAttemptId,
  // parentAttemptId, retryOfJobId) lives at JOB_OFFER.payload level and is validated
  // by validateJobOffer() — NOT here. `baseRevision` stays in input because the
  // action executes against that immutable project snapshot.
  GENERATE_CHATGPT_IMAGE: {
    capability: "chatgpt.image", consumesQuota: true,
    required: {
      projectId: V.id("prj"), episodeId: V.id("ep"), shotId: V.id("sh"),
      providerAccountId: V.id("pa"), promptSnapshot: V.prompt, baseRevision: V.nonNegInt
    },
    optional: { refAssetId: V.id("asset") }
  },
  GENERATE_GROK_IMAGE: {
    capability: "grok.image", consumesQuota: true,
    required: {
      projectId: V.id("prj"), episodeId: V.id("ep"), shotId: V.id("sh"),
      providerAccountId: V.id("pa"), promptSnapshot: V.prompt, baseRevision: V.nonNegInt
    },
    optional: {}
  },
  GENERATE_GROK_VIDEO: {
    capability: "grok.video", consumesQuota: true,
    // Declares that this action's validation needs the worker's duration-capability
    // context (supportedDurationsSec). The runtime reads this flag generically —
    // it does NOT compare action/provider strings itself (see actionUsesDurationContext).
    usesDurationContext: true,
    required: {
      projectId: V.id("prj"), episodeId: V.id("ep"), shotId: V.id("sh"),
      providerAccountId: V.id("pa"), sourceKeyframeAssetId: V.id("asset"),
      promptSnapshot: V.prompt, baseRevision: V.nonNegInt
    },
    optional: {
      requestedDurationSec: V.durationReq, allowShortFallback: V.bool, aspect: V.aspect
    },
    defaults: { requestedDurationSec: GROK_DEFAULT_DURATION, allowShortFallback: false, aspect: ASPECT_FIXED },
    extra: (input, ctx) => {
      // Capability validation MUST occur before any provider submission.
      const dur = input.requestedDurationSec ?? GROK_DEFAULT_DURATION;
      const supported = ctx && Array.isArray(ctx.supportedDurationsSec) ? ctx.supportedDurationsSec : null;
      if (supported && !supported.includes(dur)) {
        throw protocolError(PROTOCOL_ERRORS.E_DURATION_OPTION_UNAVAILABLE,
          `Requested duration ${dur}s not supported by this provider profile`,
          { requestedDurationSec: dur, supportedDurationsSec: supported });
      }
    }
  },
  // P0 Step 5C.8A — provider-NEUTRAL canonical video generation action.
  // `input` is the DURABLE Step 5C.6 staging generation snapshot:
  //   { kind:"VIDEO", prompt, durationSeconds, aspectRatio, outputCount }.
  // The fine-grained duration/aspect allowlist is config/env-driven at the Step 5C.6
  // API layer (allowedDurations / allowedAspectRatios) — NOT normative — so this
  // protocol contract stays structurally strict with SAFE BOUNDS only; the API layer
  // remains the fine-grained gate. outputCount is pinned to 1 (MVP invariant — the UI
  // has no output-count control).
  //
  // consumesQuota:true is DELIBERATE (docs/p0-step5c8-notes.md): GENERATE_VIDEO models a
  // real quota-consuming generation, so validateJobOffer defaults quotaRisk=true and the
  // SUBMITTING/POSSIBLY_SUBMITTED quota-safety recovery machinery stays engaged. It does
  // NOT force a Control-Plane paid-approval grant (that is the SEPARATE `requireApproval`
  // dispatch arg, which Step 5C.6 leaves false for fake jobs). A fake provider handler
  // exercises the machinery WITHOUT touching a real provider → no real quota consumed.
  GENERATE_VIDEO: {
    capability: "video.generate", consumesQuota: true,
    required: {
      kind: (x) => x === "VIDEO",
      prompt: V.prompt,
      durationSeconds: (x) => Number.isInteger(x) && x >= 1 && x <= VIDEO_DURATION_MAX_SEC,
      aspectRatio: (x) => typeof x === "string" && ASPECT_RATIO_RE.test(x),
      outputCount: (x) => x === 1
    },
    optional: {}
  },
  IMPORT_MEDIA: {
    capability: "media.import", consumesQuota: false,
    required: {
      projectId: V.id("prj"), episodeId: V.id("ep"), shotId: V.id("sh"),
      kind: V.enum(KIND_SET), transferRef: V.transferRef // asset id or opaque temp ref, NEVER a path
    },
    optional: { promptSnapshot: V.prompt, providerAccountId: V.id("pa") }
  },
  EXPORT_PROJECT: {
    capability: "export.capcut", consumesQuota: false,
    required: { projectId: V.id("prj"), episodeId: V.id("ep") },
    optional: { locales: V.localeArray }
  },
  STORAGE_SCAN: {
    capability: "storage.scan", consumesQuota: false,
    required: {}, optional: { projectId: V.id("prj") }
  },
  CLEANUP_DRY_RUN: {
    capability: "storage.cleanup", consumesQuota: false,
    required: {}, optional: { projectId: V.id("prj") }
  },
  CREATE_PROJECT_ARCHIVE: {
    capability: "archive.create", consumesQuota: false,
    required: { projectId: V.id("prj") }, optional: { includeRejected: V.bool }
  },
  IMPORT_PROJECT_ARCHIVE: {
    capability: "archive.import", consumesQuota: false,
    required: { archiveRef: V.transferRef }, // opaque ref, NEVER a path
    optional: { targetProjectId: V.id("prj") }
  }
};

// ---- public API ----

export function getJobContract(action) {
  return ACTION_SET.has(action) ? CONTRACTS[action] : null;
}

export function actionConsumesQuota(action) {
  const c = getJobContract(action);
  return c ? Boolean(c.consumesQuota) : false;
}

export function actionRequiredCapability(action) {
  const c = getJobContract(action);
  return c ? (c.capability ?? null) : null;
}

// Whether an action's validation needs the worker's duration-capability context.
// Lets the runtime obtain validation context generically (no action-string checks).
export function actionUsesDurationContext(action) {
  const c = getJobContract(action);
  return Boolean(c && c.usesDurationContext);
}

// validateJobInput(action, input, context?):
//  - throws E_UNKNOWN_ACTION for unknown action
//  - throws E_DANGEROUS_FIELD for any dangerous/pollution key at any depth
//  - throws E_INVALID_JOB_INPUT for unknown fields, missing/invalid required,
//    or invalid optional
//  - runs contract.extra (e.g. Grok capability → E_DURATION_OPTION_UNAVAILABLE)
//  - returns a NORMALIZED copy with declared defaults applied
export function validateJobInput(action, input, context = undefined) {
  const contract = getJobContract(action);
  if (!contract) {
    throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_ACTION, "Unknown job action", { field: "action" });
  }
  if (!isPlainObject(input)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Job input must be a plain object", { action });
  }

  // 1) dangerous / pollution keys at ANY depth
  assertNoDangerousFields(input);

  const requiredKeys = Object.keys(contract.required);
  const optionalKeys = Object.keys(contract.optional);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);

  // 2) no unknown top-level input fields
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, `Unknown input field "${key}"`, { action, field: key });
    }
  }

  // 3) required present + valid
  for (const key of requiredKeys) {
    if (!(key in input)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, `Missing required field "${key}"`, { action, field: key });
    }
    if (!contract.required[key](input[key])) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, `Invalid value for "${key}"`, { action, field: key });
    }
  }

  // 4) optional valid if present
  for (const key of optionalKeys) {
    if (key in input && !contract.optional[key](input[key])) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, `Invalid value for "${key}"`, { action, field: key });
    }
  }

  // 5) build normalized copy with defaults
  const normalized = { ...input };
  if (contract.defaults) {
    for (const [key, value] of Object.entries(contract.defaults)) {
      if (!(key in normalized)) normalized[key] = value;
    }
  }

  // 6) cross-field / capability checks (must run before provider submission)
  if (contract.extra) contract.extra(normalized, context);

  return normalized;
}

// ---- JOB_OFFER payload contract (canonical shape, P0 Step 3) ----
//
// JOB_OFFER.payload = {
//   action, requestIdempotencyKey, generationAttemptId, parentAttemptId?,
//   retryOfJobId?, quotaRisk?, expiresAt?, acceptedBaseRevision?, input:{...}
// }
// Request identity lives HERE, not in `input`. `input` is validated by
// validateJobInput and must NOT contain requestIdempotencyKey/generationAttemptId.
const OFFER_FIELDS = new Set([
  "action", "requestIdempotencyKey", "generationAttemptId", "parentAttemptId",
  "retryOfJobId", "quotaRisk", "expiresAt", "acceptedBaseRevision", "input"
]);
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// validateJobOffer(payload, context?): validates the whole JOB_OFFER payload and
// returns a normalized copy (with input defaults applied). Throws ProtocolError.
export function validateJobOffer(payload, context = undefined) {
  if (!isPlainObject(payload)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "JOB_OFFER payload must be an object", {});
  }
  // Dangerous/pollution keys rejected at ANY depth (covers input too).
  assertNoDangerousFields(payload, "payload");

  const action = payload.action;
  if (!ACTION_SET.has(action)) {
    throw protocolError(PROTOCOL_ERRORS.E_UNKNOWN_ACTION, "Unknown job action", { field: "action" });
  }
  for (const key of Object.keys(payload)) {
    if (!OFFER_FIELDS.has(key)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, `Unknown JOB_OFFER field "${key}"`, { field: key });
    }
  }

  const isGen = GENERATION_ACTION_SET.has(action);
  // requestIdempotencyKey + generationAttemptId: required for generation actions.
  if (isGen) {
    if (!validateId(payload.requestIdempotencyKey, "req")) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Invalid requestIdempotencyKey (req_<ULID>)", { field: "requestIdempotencyKey" });
    }
    if (!validateId(payload.generationAttemptId, "attempt")) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Invalid generationAttemptId (attempt_<ULID>)", { field: "generationAttemptId" });
    }
  } else {
    // Non-generation actions: request identity is OPTIONAL. Treat BOTH `undefined`
    // and `null` as "absent" so validateJobOffer is idempotent — its own normalized
    // output (which sets these to null) must re-validate cleanly on the worker side.
    if (payload.requestIdempotencyKey != null && !validateId(payload.requestIdempotencyKey, "req")) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Invalid requestIdempotencyKey", { field: "requestIdempotencyKey" });
    }
    if (payload.generationAttemptId != null && !validateId(payload.generationAttemptId, "attempt")) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Invalid generationAttemptId", { field: "generationAttemptId" });
    }
  }
  // parentAttemptId / retryOfJobId optional
  if (payload.parentAttemptId !== undefined && payload.parentAttemptId !== null && !validateId(payload.parentAttemptId, "attempt")) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Invalid parentAttemptId", { field: "parentAttemptId" });
  }
  if (payload.retryOfJobId !== undefined && payload.retryOfJobId !== null && !validateId(payload.retryOfJobId, "job")) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Invalid retryOfJobId", { field: "retryOfJobId" });
  }
  if (payload.quotaRisk !== undefined && typeof payload.quotaRisk !== "boolean") {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "quotaRisk must be boolean", { field: "quotaRisk" });
  }
  if (payload.expiresAt !== undefined && payload.expiresAt !== null && !(typeof payload.expiresAt === "string" && ISO_UTC_RE.test(payload.expiresAt))) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "expiresAt must be ISO-8601 UTC", { field: "expiresAt" });
  }
  if (payload.acceptedBaseRevision !== undefined && payload.acceptedBaseRevision !== null && !(Number.isInteger(payload.acceptedBaseRevision) && payload.acceptedBaseRevision >= 0)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "acceptedBaseRevision must be a non-negative integer", { field: "acceptedBaseRevision" });
  }

  // input: action-specific business data ONLY (rejects request identity fields
  // because they are no longer in any action contract → "unknown field").
  const normalizedInput = validateJobInput(action, payload.input ?? {}, context);

  return {
    action,
    requestIdempotencyKey: payload.requestIdempotencyKey ?? null,
    generationAttemptId: payload.generationAttemptId ?? null,
    parentAttemptId: payload.parentAttemptId ?? null,
    retryOfJobId: payload.retryOfJobId ?? null,
    quotaRisk: payload.quotaRisk ?? actionConsumesQuota(action),
    expiresAt: payload.expiresAt ?? null,
    acceptedBaseRevision: payload.acceptedBaseRevision ?? (Number.isInteger(normalizedInput.baseRevision) ? normalizedInput.baseRevision : null),
    input: normalizedInput
  };
}

export const GENERATION_ACTIONS = Object.freeze([
  "GENERATE_CHATGPT_IMAGE", "GENERATE_GROK_IMAGE", "GENERATE_GROK_VIDEO", "GENERATE_VIDEO"
]);
const GENERATION_ACTION_SET = new Set(GENERATION_ACTIONS);

// ---- Grok video result schema helper (3 distinct duration concepts) ----
// Builds/validates the duration portion of a GENERATE_GROK_VIDEO result. Keeps
// requested/confirmed/actual separate (docs §E.1). PURE — no I/O.
//
// Tolerance is capability/relative, NOT a hardcoded 1.5s:
//   toleranceSec = max(0.5, requestedDurationSec * 0.05)
//   → requested 6 → 0.5 ; 10 → 0.5 ; 15 → 0.75
// An optional `toleranceSec` override is honored when a finite number is passed.
export function grokDurationTolerance(requestedDurationSec) {
  return Math.max(0.5, requestedDurationSec * 0.05);
}

export function makeGrokVideoDurationResult({ requestedDurationSec, confirmedUiDurationSec = null, actualDurationSec = null, toleranceSec = undefined }) {
  if (!GROK_DURATIONS.includes(requestedDurationSec)) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "requestedDurationSec invalid", { field: "requestedDurationSec" });
  }
  const finiteOrNull = (v, name) => {
    if (v === null) return;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, `${name} must be a finite number or null`, { field: name });
    }
  };
  finiteOrNull(confirmedUiDurationSec, "confirmedUiDurationSec");
  finiteOrNull(actualDurationSec, "actualDurationSec");

  let tol;
  if (toleranceSec === undefined) {
    tol = grokDurationTolerance(requestedDurationSec);
  } else {
    if (typeof toleranceSec !== "number" || !Number.isFinite(toleranceSec) || toleranceSec < 0) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "toleranceSec must be a non-negative finite number", { field: "toleranceSec" });
    }
    tol = toleranceSec;
  }

  // Mismatch: measured file duration differs from requested beyond tolerance,
  // OR UI-confirmed duration differs from requested. Reviewer resolves it.
  let durationMismatch = false;
  if (actualDurationSec !== null && Math.abs(actualDurationSec - requestedDurationSec) > tol) durationMismatch = true;
  if (confirmedUiDurationSec !== null && confirmedUiDurationSec !== requestedDurationSec) durationMismatch = true;
  return { requestedDurationSec, confirmedUiDurationSec, actualDurationSec, toleranceSec: tol, durationMismatch };
}

// Pure idempotency helper: given the incoming requestIdempotencyKey (req_<ULID>)
// and a set of keys already seen (Set), returns whether this is a duplicate
// request. The transport/server layer owns the actual store + expiry window;
// this is only the pure predicate. Does NOT block a NEW generationAttemptId with
// a new req_ key (same prompt may be generated again).
export function isDuplicateRequest(requestIdempotencyKey, seenKeys) {
  if (!validateId(requestIdempotencyKey, "req")) {
    throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT, "Invalid requestIdempotencyKey (expected req_<ULID>)", { field: "requestIdempotencyKey" });
  }
  if (!(seenKeys instanceof Set)) return false;
  return seenKeys.has(requestIdempotencyKey);
}

export { MAX_PROMPT_CHARS, MAX_OPAQUE_KEY_CHARS };
