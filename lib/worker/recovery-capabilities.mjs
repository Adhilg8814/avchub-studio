// AVC Studio P0 Step 5.7a — provider recovery-capability model (PURE).
//
// PURE MODULE. Zero side effects. Describes, per provider/action, WHICH recovery moves
// a provider can actually support. Recovery planning must never assume a capability the
// provider does not have: e.g. a provider with no submission lookup cannot be asked
// "did my crashed submit go through?" — that record must go to the operator, not a
// blind retry.
//
// These flags are intentionally CONSERVATIVE by default (everything unsupported). A
// provider adapter opts in to only what it can prove it supports. Defaulting to "false"
// means: when in doubt, recovery degrades to manual/inspect, never to auto-regenerate.

import { IDEMPOTENCY_SUPPORT, isIdempotencySupport } from "./recovery-states.mjs";

// The capability surface a provider may declare for recovery purposes.
export const RECOVERY_CAPABILITY_KEYS = Object.freeze([
  // Can we attach an idempotency key so a duplicate submit collapses to one generation?
  "supportsIdempotencyKey",
  // Can we ask the provider "is there already a submission for <key/tag>?" after a crash
  // in the submit window, WITHOUT creating a new generation?
  "supportsSubmissionLookup",
  // Can an in-flight generation be re-attached to and its result awaited after a restart
  // (as opposed to only starting fresh)?
  "supportsResume",
  // Can an interrupted download of a finished result be continued/re-fetched safely?
  "supportsDownloadResume",
  // Can an interrupted import (result → local asset) be re-run idempotently?
  "supportsImportResume"
]);

// The idempotency LEVEL the provider offers (NONE/NATIVE/DERIVED). Kept alongside the
// booleans so a planner can distinguish "no key at all" from "key, provider dedupes".
const DEFAULT_CAPABILITIES = Object.freeze({
  supportsIdempotencyKey: false,
  supportsSubmissionLookup: false,
  supportsResume: false,
  supportsDownloadResume: false,
  supportsImportResume: false,
  idempotencySupport: IDEMPOTENCY_SUPPORT.NONE
});

// resolveRecoveryCapabilities(declared): merge a provider's declared capabilities over
// the conservative defaults, validating the idempotency level. Unknown keys are ignored;
// non-boolean values are coerced to false so a malformed declaration can only ever
// REMOVE capability, never fabricate one.
export function resolveRecoveryCapabilities(declared = {}) {
  const out = { ...DEFAULT_CAPABILITIES };
  if (declared && typeof declared === "object") {
    for (const key of RECOVERY_CAPABILITY_KEYS) {
      out[key] = declared[key] === true;
    }
    if (isIdempotencySupport(declared.idempotencySupport)) {
      out.idempotencySupport = declared.idempotencySupport;
    }
  }
  // Coherence: a NATIVE/DERIVED idempotency level implies a key is used; and a provider
  // that dedupes natively implicitly supports submission lookup (the key IS the lookup).
  if (out.idempotencySupport !== IDEMPOTENCY_SUPPORT.NONE) out.supportsIdempotencyKey = true;
  if (out.idempotencySupport === IDEMPOTENCY_SUPPORT.NATIVE) out.supportsSubmissionLookup = true;
  return Object.freeze(out);
}

// Convenience presets. Grok (browser automation) has NO provider-side idempotency and
// no lookup API — the safest possible profile: a crashed submit must be inspected by a
// human, never auto-resubmitted.
export const GROK_RECOVERY_CAPABILITIES = resolveRecoveryCapabilities({
  idempotencySupport: IDEMPOTENCY_SUPPORT.NONE,
  supportsSubmissionLookup: false,
  supportsResume: false,
  supportsDownloadResume: false,
  supportsImportResume: false
});

export function defaultRecoveryCapabilities() { return DEFAULT_CAPABILITIES; }
