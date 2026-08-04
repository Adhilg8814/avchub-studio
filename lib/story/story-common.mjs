// P0 Step 5C.16 — shared pure helpers for the Story Content Factory (no I/O, no secrets).
//
// Deliberately independent of lib/movie so the story layer can be reasoned about + tested on its
// own. Same secret-scan discipline as the movie story schema: no URLs, filesystem paths, or
// credential-looking tokens may ever enter stored story text / metadata.

const SECRETish = /(https?:\/\/|[A-Za-z]:[\\/]|\bcookie\b|\btoken\b|\bpassword\b|\bproxy\b|Bearer\s|api[_-]?key)/i;

export function storyError(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

export function assertNoSecret(value, field) {
  if (typeof value === "string" && SECRETish.test(value)) {
    throw storyError("E_STORY_UNSAFE_TEXT", `${field} must not contain URLs, paths, or secrets`);
  }
}

// Collapse all whitespace (incl. newlines) to single spaces, trim, cap length.
export function cleanInline(v, max) {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Preserve paragraph breaks but normalize runs of blank lines + trailing whitespace; cap length.
export function cleanBlock(v, max) {
  if (typeof v !== "string") return "";
  const s = v.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Word count on Unicode letters/digits runs (locale-agnostic; good enough for range gating).
export function wordCount(text) {
  const m = String(text || "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

// Deterministic lowercase normalization for categorical/lexical comparison. Folds combining diacritics
// (so "é" == "e") but PRESERVES all Unicode letters/digits — Cyrillic (bg-BG) and Scandinavian letters
// must survive, so only combining marks + punctuation are removed, never whole scripts.
export function normalizeToken(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Jaccard similarity over a set of tokens (0..1). Two empty sets are treated as MAXIMALLY DISSIMILAR
// (0), not identical — empty token bags carry no evidence of similarity.
export function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter += 1;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Overlap coefficient: |A∩B| / min(|A|,|B|). Robust when one set is much larger (e.g. a short title vs
// a long story) — measures how much of the SMALLER set is contained in the larger.
export function overlapCoefficient(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter += 1;
  return inter / Math.min(aSet.size, bSet.size);
}

// Bag of normalized word tokens (>=3 chars) for lexical similarity.
export function tokenSet(text, minLen = 3) {
  const norm = normalizeToken(text);
  return new Set(norm.split(" ").filter((t) => t.length >= minLen));
}
