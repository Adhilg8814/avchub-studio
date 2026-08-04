// The contract a generation provider must satisfy to be usable by the platform.
//
// The platform never talks to a provider directly. It asks a plugin for a capability declaration, hands it a
// prepared request, and later asks whether that request produced a file. Everything the platform then decides
// — whether the result is acceptable, whether to spend again — comes from decoding that file, never from
// anything the plugin says about it. See `lib/media/asset-policy.mjs`.
//
// No plugin ships with this repository. The registry starts empty and an installation supplies its own.

export const PROVIDER_ERRORS = Object.freeze({
  INVALID_PLUGIN: "E_PROVIDER_PLUGIN_INVALID",
  UNKNOWN_PROVIDER: "E_PROVIDER_UNKNOWN",
  DUPLICATE_PROVIDER: "E_PROVIDER_DUPLICATE",
  NOT_SUPPORTED: "E_PROVIDER_REQUEST_NOT_SUPPORTED"
});

/** Terminal states a submission can reach. Anything else means "still running". */
export const SUBMISSION_STATE = Object.freeze({
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  /** The provider refused before consuming quota — retryable without cost. */
  REFUSED: "REFUSED"
});

function err(code, message, detail = {}) { return Object.assign(new Error(message), { code, detail }); }

/**
 * A plugin is a plain object. Required shape:
 *
 *   id            string, stable, uppercase snake — identifies the provider in job records
 *   describe()    → { aspectRatios: string[], durationOptions: string[], resolutions: string[] }
 *   submit(req)   → { submissionId, state }        req = { prompt, plan, accountRef, signal }
 *   poll(id)      → { state, failureReason? }
 *   fetch(id)     → { filePath }                   only meaningful once state is SUCCEEDED
 *
 * Optional:
 *   prepare(req)  → req'                           a chance to normalise before submit
 *   dispose()     → void                           released on shutdown
 *
 * Validation is strict and total: a plugin that is half-implemented fails at registration, not on the first
 * job. A generation that dies mid-flight costs real money to discover.
 */
export function assertValidPlugin(plugin) {
  if (!plugin || typeof plugin !== "object") throw err(PROVIDER_ERRORS.INVALID_PLUGIN, "plugin must be an object");
  if (typeof plugin.id !== "string" || !/^[A-Z][A-Z0-9_]{1,31}$/.test(plugin.id)) {
    throw err(PROVIDER_ERRORS.INVALID_PLUGIN, "plugin.id must be an uppercase identifier", { id: plugin.id });
  }
  for (const fn of ["describe", "submit", "poll", "fetch"]) {
    if (typeof plugin[fn] !== "function") {
      throw err(PROVIDER_ERRORS.INVALID_PLUGIN, `plugin ${plugin.id} is missing ${fn}()`, { id: plugin.id, missing: fn });
    }
  }
  for (const fn of ["prepare", "dispose"]) {
    if (plugin[fn] != null && typeof plugin[fn] !== "function") {
      throw err(PROVIDER_ERRORS.INVALID_PLUGIN, `plugin ${plugin.id}.${fn} must be a function when present`, { id: plugin.id });
    }
  }
  const cap = plugin.describe();
  for (const key of ["aspectRatios", "durationOptions", "resolutions"]) {
    if (!Array.isArray(cap?.[key]) || cap[key].length === 0) {
      throw err(PROVIDER_ERRORS.INVALID_PLUGIN, `plugin ${plugin.id}.describe() must list ${key}`, { id: plugin.id, key });
    }
  }
  return Object.freeze({ id: plugin.id, capability: Object.freeze({ ...cap }) });
}

/**
 * Can this provider render this plan at all?
 *
 * Checked before submission, because a provider that cannot do 9:16 will happily accept the request and
 * return 16:9 — and by then the quota is gone. A refusal here costs nothing.
 */
export function assertPlanSupported(capability, plan) {
  const problems = [];
  if (plan?.aspectRatio && !capability.aspectRatios.includes(plan.aspectRatio)) problems.push(`aspectRatio ${plan.aspectRatio}`);
  if (plan?.resolution && !capability.resolutions.includes(plan.resolution)) problems.push(`resolution ${plan.resolution}`);
  if (plan?.duration && !capability.durationOptions.includes(plan.duration)) problems.push(`duration ${plan.duration}`);
  if (problems.length) {
    throw err(PROVIDER_ERRORS.NOT_SUPPORTED, `provider cannot render ${problems.join(", ")}`, { problems, capability });
  }
  return true;
}
