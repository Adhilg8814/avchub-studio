// P0 Step 5C.43 — the declared shape of what we know about a media file, in ONE place.
//
// Two independent allow-lists used to decide this, and both silently dropped anything they did not name:
// `generation-projection-repository.validateMediaMeta` for a job's media, and `movie-repository`'s for a
// scene's. That is where 5C.38's decode verdict and 5C.42's duration record died — computed, attached,
// carried through finalize, and deleted one layer above the database. Worse, the movie UI projection reads
// `sourceVerdict`, `sourceNative` and `accountFallbackSuspected` off scene media that the movie repository
// had already stripped, so those fields have read null since the day they were written.
//
// So: one schema, imported by both, and an UNKNOWN FIELD IS AN ERROR rather than a silent deletion. A field
// that gets dropped without a word is worse than one that is rejected loudly — the second is a bug you fix in
// an afternoon, the first is a measurement everybody believes exists.
//
// Nothing here is inferred. A file that was never decoded carries nulls, not guesses, and there is no path by
// which a final display size can become a claim about the source it was scaled from.

function bad(message) {
  return Object.assign(new Error(message), { code: "E_MEDIA_EVIDENCE_INVALID" });
}

const isUnsafeRef = (v) =>
  typeof v === "string" && (/^[A-Za-z]:[\\/]/u.test(v) || /^[\\/]/u.test(v) || /:\/\//u.test(v) || v.includes(".."));

const SECRET_KEY_RE = /(token|cookie|secret|password|authorization|proxy|credential|bearer|apikey|api_key|signed)/iu;

const num = (v) => (v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
const bool = (v) => v === true;
const str = (n) => (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).slice(0, n);
  return isUnsafeRef(s) ? null : s;
};
const hash = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).toLowerCase();
  return /^[0-9a-f]{64}$/u.test(s) ? s : null;
};

/** A small, sanitized record of how a composer selection was PROVEN on the page: the option, the attribute
 *  that expressed it, and the path through the composer that found it. Structure only. */
function selectionEvidence(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw bad("selection evidence must be an object");
  for (const k of Object.keys(v)) if (SECRET_KEY_RE.test(k)) throw bad(`selection evidence key '${k}' not allowed`);
  const o = v.option && typeof v.option === "object" && !Array.isArray(v.option) ? v.option : null;
  if (o) for (const k of Object.keys(o)) if (SECRET_KEY_RE.test(k)) throw bad(`selection evidence option key '${k}' not allowed`);
  const s40 = str(40), s20 = str(20), s60 = str(60), s200 = str(200);
  return {
    groupSelected: s20(v.groupSelected),
    confident: bool(v.confident),
    reason: s60(v.reason),
    provenDuringActuation: bool(v.provenDuringActuation),
    available: Array.isArray(v.available) ? v.available.slice(0, 8).map((x) => s20(x)) : [],
    option: o ? {
      key: s20(o.key), label: s40(o.label), role: s20(o.role),
      selected: o.selected === true ? true : o.selected === false ? false : null,
      selectedVia: str(30)(o.selectedVia), selectedRaw: str(30)(o.selectedRaw),
      disabled: bool(o.disabled), ancestry: s200(o.ancestry), testId: s60(o.testId)
    } : null
  };
}

/** What the provider's own page claimed about its output — kept SEPARATE from the decode so the two can be
 *  compared rather than conflated. This is the number that said 464x688 was fine. */
function reportedByPage(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw bad("reportedByPage must be an object");
  return { width: int(v.width), height: int(v.height), durationSeconds: num(v.durationSeconds) };
}

// The declared schema. Every key a media record may carry, and how it is coerced. Anything else is rejected.
export const MEDIA_EVIDENCE_SCHEMA = Object.freeze({
  // ---- the file itself
  relativePath: { required: true, coerce: (v) => { if (typeof v !== "string" || isUnsafeRef(v)) throw bad("relativePath must be a safe relative reference"); return v; } },
  sizeBytes: { required: true, coerce: (v) => { if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad("sizeBytes invalid"); return v; } },
  container: { coerce: (v) => (typeof v === "string" ? v.slice(0, 16) : "mp4") },
  checksum: { coerce: str(128) },
  durationSeconds: { coerce: num },
  width: { coerce: int },
  height: { coerce: int },
  // ---- assembled film only
  sceneCount: { coerce: int },
  hasSubtitles: { coerce: (v) => (v === null || v === undefined ? null : v === true) },

  // ---- what we ASKED the provider for
  requestedResolution: { coerce: str(16) },
  requestedAspectRatio: { coerce: str(16) },
  requestedDurationSeconds: { coerce: num },

  // ---- what the COMPOSER was actually set to, and the DOM reading that proved it
  selectedResolution: { coerce: str(16) },
  selectedResolutionEvidence: { coerce: selectionEvidence },
  selectedAspectRatio: { coerce: str(16) },
  selectedDurationSeconds: { coerce: num },
  selectedDurationEvidence: { coerce: selectionEvidence },

  // ---- what the FILE measures, from decoding the bytes we received
  decodedFromFile: { coerce: bool },
  actualDecodedWidth: { coerce: int },
  actualDecodedHeight: { coerce: int },
  actualDecodedDurationSeconds: { coerce: num },
  actualAspectRatio: { coerce: str(16) },
  actualResolutionTier: { coerce: str(16) },
  sourceFrameRate: { coerce: num },
  sourceHash: { coerce: hash },

  // ---- the verdicts comparing the three
  resolutionVerdict: { coerce: str(40) },
  durationVerdict: { coerce: str(40) },
  durationDeltaSeconds: { coerce: num },
  sourceVerdict: { coerce: str(40) },
  providerFallbackSuspected: { coerce: bool },

  // ---- the provider's own claim, kept apart from the decode
  reportedByPage: { coerce: reportedByPage }
});

export const MEDIA_EVIDENCE_FIELDS = Object.freeze(Object.keys(MEDIA_EVIDENCE_SCHEMA));

/**
 * Coerce a media record to the declared schema.
 *
 * Every declared field is present in the output, explicitly null when it has no value: a missing key and a
 * measured null are indistinguishable to a reader, and only one of them is honest about a file nobody decoded.
 *
 * An undeclared key throws. That is the whole point of this module.
 */
export function normalizeMediaEvidence(input, { field = "mediaMeta" } = {}) {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw bad(`${field} must be an object`);

  const unknown = Object.keys(input).filter((k) => !Object.prototype.hasOwnProperty.call(MEDIA_EVIDENCE_SCHEMA, k));
  if (unknown.length) {
    throw bad(`${field} carries undeclared field(s): ${unknown.slice(0, 6).join(", ")}`);
  }
  const out = {};
  for (const [key, spec] of Object.entries(MEDIA_EVIDENCE_SCHEMA)) {
    const raw = input[key];
    if (spec.required && (raw === null || raw === undefined)) throw bad(`${field}.${key} is required`);
    out[key] = spec.coerce(raw);
  }
  return out;
}

/** True when a record carries a real decode rather than numbers copied off a page. Used by callers that must
 *  not treat a provider's own claim as a measurement. */
export function isDecoded(meta) {
  return Boolean(meta && meta.decodedFromFile === true && Number.isFinite(meta.actualDecodedWidth) && Number.isFinite(meta.actualDecodedHeight));
}
