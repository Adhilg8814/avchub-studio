// What a generation provider was asked for, what it actually returned, and whether those are the same thing.
//
// Provider-neutral by construction. Every input here comes from DECODING the downloaded file — not from the
// response JSON, not from the provider's UI, not from a container header some later step wrote. A provider
// can show 720p, accept the request, and still return 480p when the account is past its allowance; the only
// way to know is to measure the file.
//
// Three decisions live here:
//   1. WHAT TO ASK FOR   — turn a media profile into concrete provider selections, refusing an ask no option
//                          can satisfy rather than silently rounding it down.
//   2. WHAT CAME BACK    — classify the decoded file: resolution tier, aspect, duration.
//   3. WHAT TO DO ABOUT IT — a policy the operator owns, defaulting to "native or nothing", because the
//                          alternative is upscaling and calling it 720p.
//
// Pure: no DOM, no network, no ffmpeg. The caller supplies decoded facts; this decides what they mean.

export const ASSET_ERRORS = Object.freeze({
  DURATION_CONTROL_UNAVAILABLE: "E_ASSET_DURATION_CONTROL_UNAVAILABLE",
  // A shot asking for longer than the provider's longest option. Refused BEFORE the provider, because the
  // alternative is generating 15 s, calling it 20, and finding out at assembly time.
  DURATION_UNSUPPORTED: "E_ASSET_DURATION_UNSUPPORTED",
  SOURCE_REJECTED: "E_ASSET_SOURCE_RESOLUTION_REJECTED"
});

export const ASSET_VERDICT = Object.freeze({
  NATIVE_720P: "NATIVE_720P",
  PROVIDER_FELL_BACK_TO_480P: "PROVIDER_FELL_BACK_TO_480P",
  WRONG_ASPECT_RATIO: "WRONG_ASPECT_RATIO",
  UPSCALED_SOURCE: "UPSCALED_SOURCE",
  INVALID_MEDIA: "INVALID_MEDIA"
});

export const SOURCE_POLICY = Object.freeze({
  NATIVE_720P_REQUIRED: "NATIVE_720P_REQUIRED",
  ALLOW_UPSCALED_FALLBACK: "ALLOW_UPSCALED_FALLBACK"
});

// "720p" on a vertical clip means the SHORT side is 720 — 720x1280 at 9:16. Providers round to a multiple of
// 16, so 480p at 2:3 arrives as 464x688 rather than a clean 480x720. The tier is therefore matched by
// proximity, not equality: 464 is a 480p frame, and treating it as "not quite 480p" would be pedantry.
export const RESOLUTION_TIERS = Object.freeze([
  Object.freeze({ key: "480p", shortSide: 480 }),
  Object.freeze({ key: "720p", shortSide: 720 }),
  Object.freeze({ key: "1080p", shortSide: 1080 })
]);
const TIER_TOLERANCE = 0.10;   // 464/480 = 0.967 — inside. 688 is nowhere near 720 as a SHORT side.
const ASPECT_TOLERANCE = 0.04; // 2:3 = 0.6667 vs 9:16 = 0.5625 — far apart; rounding never confuses them.

export const KNOWN_ASPECTS = Object.freeze([
  Object.freeze({ key: "9:16", value: 9 / 16 }),
  Object.freeze({ key: "2:3", value: 2 / 3 }),
  Object.freeze({ key: "3:4", value: 3 / 4 }),
  Object.freeze({ key: "4:5", value: 4 / 5 }),
  Object.freeze({ key: "1:1", value: 1 }),
  Object.freeze({ key: "3:2", value: 3 / 2 }),
  Object.freeze({ key: "16:9", value: 16 / 9 })
]);

function err(code, message, detail = {}) { return Object.assign(new Error(message), { code, detail }); }
const round = (n, d = 3) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

/** Which tier a decoded frame belongs to, by its short side. null when it matches none. */
export function resolutionTierOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const shortSide = Math.min(width, height);
  let best = null;
  for (const t of RESOLUTION_TIERS) {
    const rel = Math.abs(shortSide - t.shortSide) / t.shortSide;
    if (rel <= TIER_TOLERANCE && (!best || rel < best.rel)) best = { key: t.key, rel };
  }
  return best ? best.key : null;
}

/** The nearest named aspect, plus the raw ratio. Unnamed ratios return key null and keep the number, because
 *  "not one of ours" is a finding worth reporting rather than an error to swallow. */
export function aspectOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { key: null, ratio: null };
  const ratio = width / height;
  let best = null;
  for (const a of KNOWN_ASPECTS) {
    const rel = Math.abs(ratio - a.value) / a.value;
    if (rel <= ASPECT_TOLERANCE && (!best || rel < best.rel)) best = { key: a.key, rel };
  }
  return { key: best ? best.key : null, ratio: round(ratio, 4) };
}

/**
 * Which duration option a request maps to.
 *
 * Snapped UP to a real option, never down: a shot needing 7 s must be given 10 and trimmed, because 6 s of
 * footage under a 7 s line is a gap no edit can close. Above the longest option the answer is a REFUSAL, not
 * the longest option — silently clamping 22 s to 15 s produces a scene that does not fit its narration.
 *
 * A request that is not a positive number is refused for the same reason: falling through to the LAST option
 * means an unset duration quietly buys the most expensive one on offer.
 */
export function durationOptionFor(durationSeconds, durationOptions = ["6s", "10s", "15s"]) {
  const opts = durationOptions
    .map((k) => ({ key: k, seconds: Number(String(k).replace(/[^0-9.]/gu, "")) }))
    .filter((o) => Number.isFinite(o.seconds) && o.seconds > 0)
    .sort((a, b) => a.seconds - b.seconds);
  if (opts.length === 0) throw err(ASSET_ERRORS.DURATION_CONTROL_UNAVAILABLE, "no duration options");
  const secs = Number(durationSeconds);
  if (!Number.isFinite(secs) || secs <= 0) {
    throw err(ASSET_ERRORS.DURATION_UNSUPPORTED, `a shot duration of ${durationSeconds} is not a length`,
      { requestedDurationSeconds: durationSeconds, options: opts.map((o) => o.key) });
  }
  const longest = opts[opts.length - 1];
  if (secs > longest.seconds + 1e-9) {
    throw err(ASSET_ERRORS.DURATION_UNSUPPORTED,
      `this shot asks for ${secs}s and the longest option is ${longest.key}`,
      { requestedDurationSeconds: secs, longestSeconds: longest.seconds, options: opts.map((o) => o.key) });
  }
  const fit = opts.find((o) => o.seconds + 1e-9 >= secs);
  return Object.freeze({ key: fit.key, seconds: fit.seconds, requestedDurationSeconds: secs });
}

/** The provider selections a media profile implies. */
export function actuationPlanFor({ aspectRatio = "9:16", resolution = "720p", durationSeconds = 6, durationOptions = ["6s", "10s", "15s"] } = {}) {
  const fit = durationOptionFor(durationSeconds, durationOptions);
  return Object.freeze({
    mode: "VIDEO",
    resolution,
    aspectRatio,
    duration: fit.key,
    // What the SELECTION will be, and what the shot actually asked for. These are different numbers whenever
    // the ask falls between options — a 4 s shot is rendered at 6 s — and conflating them turns the option
    // granularity into a provider fault the first time anything compares the file against the plan.
    durationSeconds: fit.seconds,
    requestedDurationSeconds: fit.requestedDurationSeconds
  });
}

export const DURATION_VERDICT = Object.freeze({
  MATCHES_SELECTION: "MATCHES_SELECTION",
  PROVIDER_DURATION_MISMATCH: "PROVIDER_DURATION_MISMATCH",
  UNMEASURED: "UNMEASURED"
});

// Encoders round up to a whole frame — a 6 s selection commonly decodes to 6.041667 s (145 frames at 24 fps).
// Measured across a full library the largest deviation was 0.042 s, so half a second is an order of magnitude
// above the observed noise and still nowhere near the gap a wrong option would produce.
const DURATION_TOLERANCE_SECONDS = 0.5;

/**
 * Did the provider render the length that was SELECTED?
 *
 * Compared against the selection, never against the shot's ask: options are discrete, so a 4 s shot is
 * correctly rendered at 6 s and calling that a provider fault would flag most of a library. What this exists
 * to catch is the other case — the selection said 10 s, the file is 6 s — which means the request did not
 * take effect even though the provider reported that it had.
 */
export function classifyDuration({ requestedDurationSeconds = null, selectedDurationSeconds = null, decodedDurationSeconds = null, toleranceSeconds = DURATION_TOLERANCE_SECONDS } = {}) {
  const sel = Number(selectedDurationSeconds);
  const dec = Number(decodedDurationSeconds);
  const base = {
    requestedDurationSeconds: Number.isFinite(Number(requestedDurationSeconds)) ? Number(requestedDurationSeconds) : null,
    selectedDurationSeconds: Number.isFinite(sel) ? sel : null,
    actualDecodedDurationSeconds: Number.isFinite(dec) && dec > 0 ? round(dec, 3) : null,
    toleranceSeconds
  };
  // No decode means no reading. "We could not measure it" must never round to "it was right" — that is the
  // substitution that lets a 464x688 file be recorded as 720x1280 for months.
  if (!Number.isFinite(sel) || sel <= 0 || !Number.isFinite(dec) || dec <= 0) {
    return Object.freeze({ ...base, verdict: DURATION_VERDICT.UNMEASURED, matches: false, deltaSeconds: null,
      reason: !Number.isFinite(dec) || dec <= 0 ? "the file was not decoded, so its length is unknown" : "no duration was selected" });
  }
  const delta = round(dec - sel, 3);
  if (Math.abs(dec - sel) <= toleranceSeconds) {
    return Object.freeze({ ...base, verdict: DURATION_VERDICT.MATCHES_SELECTION, matches: true, deltaSeconds: delta,
      reason: `${sel}s was selected and the file decodes to ${base.actualDecodedDurationSeconds}s` });
  }
  return Object.freeze({ ...base, verdict: DURATION_VERDICT.PROVIDER_DURATION_MISMATCH, matches: false, deltaSeconds: delta,
    reason: `${sel}s was selected and confirmed, but the file decodes to ${base.actualDecodedDurationSeconds}s` });
}

export const RESOLUTION_VERDICT = Object.freeze({
  MATCHES_SELECTION: "MATCHES_SELECTION",
  PROVIDER_RESOLUTION_MISMATCH: "PROVIDER_RESOLUTION_MISMATCH",
  UNMEASURED: "UNMEASURED"
});

/**
 * Did the provider render the resolution that was SELECTED?
 *
 * Deliberately the same shape as `classifyDuration`, and deliberately separate from `sourceGateDecision`.
 * They answer different questions: this one is "the selection said 720p and the file is 480p", a fact about
 * the provider ignoring a confirmed request; the gate decides what the asset IS overall, including aspect and
 * upscaling. Collapsing them would lose the ability to say which of the two went wrong.
 */
export function classifyResolution({ requestedResolution = null, selectedResolution = null, decodedTier = null } = {}) {
  const base = { requestedResolution: requestedResolution || null, selectedResolution: selectedResolution || null, actualResolutionTier: decodedTier || null };
  if (!selectedResolution || !decodedTier) {
    return Object.freeze({ ...base, verdict: RESOLUTION_VERDICT.UNMEASURED, matches: false,
      reason: !decodedTier ? "the file was not decoded, so its resolution tier is unknown" : "no resolution was selected" });
  }
  if (selectedResolution === decodedTier) {
    return Object.freeze({ ...base, verdict: RESOLUTION_VERDICT.MATCHES_SELECTION, matches: true,
      reason: `${selectedResolution} was selected and the file decodes to ${decodedTier}` });
  }
  return Object.freeze({ ...base, verdict: RESOLUTION_VERDICT.PROVIDER_RESOLUTION_MISMATCH, matches: false,
    reason: `${selectedResolution} was selected and confirmed, but the file decodes to ${decodedTier}` });
}

/**
 * What the decoded file actually is.
 *
 * Every input must come from decoding the downloaded file. A provider rate-limiting an account to 480p will
 * happily report the 720p request as accepted and return 480p — the UI is not evidence about the output, and
 * neither is the response body.
 */
export function classifyGeneratedAsset({ requested = {}, decoded = null, upscaleApplied = false } = {}) {
  const wantRes = requested.resolution || "720p";
  const wantAspect = requested.aspectRatio || "9:16";

  if (!decoded || !Number.isFinite(decoded.width) || !Number.isFinite(decoded.height)
      || decoded.width <= 0 || decoded.height <= 0
      || !Number.isFinite(decoded.durationSeconds) || decoded.durationSeconds <= 0) {
    return Object.freeze({
      verdict: ASSET_VERDICT.INVALID_MEDIA, native: false, acceptable: false,
      requestedResolution: wantRes, requestedAspectRatio: wantAspect,
      actualWidth: decoded ? decoded.width ?? null : null, actualHeight: decoded ? decoded.height ?? null : null,
      actualDurationSeconds: decoded ? decoded.durationSeconds ?? null : null,
      actualResolutionTier: null, actualAspectRatio: null, actualAspectValue: null,
      accountFallbackSuspected: false,
      reason: "the file could not be decoded into a picture with a size and a length"
    });
  }

  const tier = resolutionTierOf(decoded.width, decoded.height);
  const asp = aspectOf(decoded.width, decoded.height);
  const base = {
    requestedResolution: wantRes, requestedAspectRatio: wantAspect,
    actualWidth: decoded.width, actualHeight: decoded.height,
    actualDurationSeconds: round(decoded.durationSeconds, 3),
    actualResolutionTier: tier, actualAspectRatio: asp.key, actualAspectValue: asp.ratio
  };

  // Aspect first: a 16:9 clip is wrong regardless of how many pixels it has, and cropping it to vertical
  // would throw away most of the frame — a different decision from "the resolution is short".
  if (asp.key !== wantAspect) {
    return Object.freeze({ ...base, verdict: ASSET_VERDICT.WRONG_ASPECT_RATIO, native: false, acceptable: false, accountFallbackSuspected: false,
      reason: `asked for ${wantAspect}, decoded ${asp.key || asp.ratio}` });
  }

  // An upscale is never native, whatever size the file now reports.
  if (upscaleApplied) {
    return Object.freeze({ ...base, verdict: ASSET_VERDICT.UPSCALED_SOURCE, native: false, acceptable: false, accountFallbackSuspected: false,
      reason: "the frame reaches the target size only because it was scaled up" });
  }

  if (tier === wantRes) {
    return Object.freeze({ ...base, verdict: ASSET_VERDICT.NATIVE_720P, native: true, acceptable: true, accountFallbackSuspected: false,
      reason: `decoded ${decoded.width}x${decoded.height}, which is native ${tier}` });
  }

  // We asked for 720p, the request was accepted, and 480p came back. That is the account cap.
  if (wantRes === "720p" && tier === "480p") {
    return Object.freeze({ ...base, verdict: ASSET_VERDICT.PROVIDER_FELL_BACK_TO_480P, native: false, acceptable: false, accountFallbackSuspected: true,
      reason: "720p was requested and confirmed, but the provider returned a 480p frame — typically a per-account allowance" });
  }

  return Object.freeze({ ...base, verdict: ASSET_VERDICT.PROVIDER_FELL_BACK_TO_480P, native: false, acceptable: false,
    accountFallbackSuspected: tier !== null && tier !== wantRes,
    reason: `asked for ${wantRes}, decoded ${decoded.width}x${decoded.height}${tier ? ` (${tier})` : " (no known tier)"}` });
}

/**
 * Whether a classified asset may proceed.
 *
 * Default is NATIVE_720P_REQUIRED. Not because a fallback is worthless, but because the alternative silently
 * produces a blurry film labelled 720p. An installation that genuinely wants the fallback can have it —
 * labelled UPSCALED, never NATIVE, and visible in the UI.
 */
export function sourceGateDecision({ classification, policy = SOURCE_POLICY.NATIVE_720P_REQUIRED } = {}) {
  if (!classification) return Object.freeze({ allow: false, code: ASSET_ERRORS.SOURCE_REJECTED, label: null, reason: "no classification" });
  const v = classification.verdict;

  if (v === ASSET_VERDICT.NATIVE_720P) {
    return Object.freeze({ allow: true, code: null, label: "NATIVE", spendMoreProviderQuota: true, reason: classification.reason });
  }
  // Never worth another provider call: a broken file or a wrong-shaped frame is not fixed by continuing, and
  // the scene's narration has not been synthesised yet, so refusing here also saves the speech spend.
  if (v === ASSET_VERDICT.INVALID_MEDIA || v === ASSET_VERDICT.WRONG_ASPECT_RATIO) {
    return Object.freeze({ allow: false, code: ASSET_ERRORS.SOURCE_REJECTED, label: null, spendMoreProviderQuota: false,
      ownerActionRequired: v === ASSET_VERDICT.WRONG_ASPECT_RATIO ? "ASPECT_CONTROL_REVIEW" : "REGENERATE",
      reason: classification.reason });
  }

  if (policy === SOURCE_POLICY.ALLOW_UPSCALED_FALLBACK) {
    return Object.freeze({ allow: true, code: null, label: "UPSCALED", spendMoreProviderQuota: true,
      warning: "this scene is below the native source resolution and will look softer than 720p",
      reason: classification.reason });
  }

  return Object.freeze({
    allow: false, code: ASSET_ERRORS.SOURCE_REJECTED, label: null, spendMoreProviderQuota: false,
    // Retrying a per-account cap just spends the allowance again on another 480p clip.
    ownerActionRequired: classification.accountFallbackSuspected ? "PROVIDER_QUOTA_OR_TIER" : "REGENERATE",
    reason: classification.reason
  });
}

/** The capability record for an account, from what its generations actually returned. Belief follows
 *  evidence: one native 720p file proves 720p works far better than any capability flag a human typed in. */
export function capabilityFromObservations(observations = []) {
  const obs = observations.filter((o) => o && o.verdict);
  const native = obs.filter((o) => o.verdict === ASSET_VERDICT.NATIVE_720P).length;
  const fellBack = obs.filter((o) => o.verdict === ASSET_VERDICT.PROVIDER_FELL_BACK_TO_480P).length;
  let state = "UNKNOWN";
  if (native > 0) state = "AVAILABLE";
  else if (fellBack > 0) state = "CAPPED_480P";
  return Object.freeze({
    resolution720p: state,
    observedNative: native, observedFallback: fellBack, observations: obs.length,
    // A cap can lift and an allowance can refill, so this is a reading, not a permanent fact.
    lastVerdict: obs.length ? obs[obs.length - 1].verdict : null
  });
}
