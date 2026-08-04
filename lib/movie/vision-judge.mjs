// P0 Step 5C.39 — does the picture show what the voice is saying?
//
// This is the dimension the previous milestone reported as UNMEASURED, and it is the one that matters most: a
// film whose narration says "he set the letter on the table" over a shot of an empty street is wrong in a way
// no technical check can see. Every frame is a valid 720p frame. The container is perfect. The film is broken.
//
// The judge is a real model looking at real frames — Grok Chat, through the browser runtime, account, lease,
// pacing and submission ledger that already exist. This module is the pure half: what to ask, how to read the
// answer, and when to refuse it. The actuation lives with the actuator.
//
// The refusal rules matter more than the scoring. A judge that returns prose instead of JSON, or scores
// without evidence, or is asked about a frame that was never attached, must produce UNMEASURED — which routes
// to a human. It must never produce a number, because a number is indistinguishable from a real measurement
// once it is written down.

export const VISION_VERDICT = Object.freeze({
  PASS: "PASS",
  REGENERATE: "REGENERATE",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  TECHNICAL_REJECT: "TECHNICAL_REJECT",
  UNMEASURED: "UNMEASURED"
});

export const VISION_FLOORS = Object.freeze({
  semanticMatch: 0.70,     // is this the moment the narration describes
  actionMatch: 0.65,       // is the described action happening
  characterMatch: 0.70,    // are the right people present, and only them
  objectMatch: 0.60,       // are the objects the line names actually there
  locationMatch: 0.65,
  emotionMatch: 0.50,      // read from a still frame, so held to a looser bar on purpose
  styleMatch: 0.60,
  continuityMatch: 0.65
});

// Scored 0..1 by the judge. Kept separate from the floors so a caller can loosen a floor without silently
// dropping a dimension out of the schema.
export const VISION_DIMENSIONS = Object.freeze([
  "semanticMatch", "actionMatch", "characterMatch", "objectMatch",
  "locationMatch", "emotionMatch", "styleMatch", "continuityMatch"
]);

// Failing any of these means the shot is WRONG, not merely weak, so they are never averaged away.
export const VISION_HARD = Object.freeze(["semanticMatch", "actionMatch", "characterMatch"]);

/**
 * The question.
 *
 * Written to make the honest answer easy and the lazy answer hard. Two things drive that: the judge is told
 * exactly what the voice says over these frames, and it is required to cite a frame timestamp for every claim.
 * Asked to "rate this shot", a model rates the photography. Asked "at 2.4s the narration says X — is X
 * happening in these frames", it has to look.
 */
export function buildVisionPrompt({ shot, narrationText, characterBible = [], locationBible = [], styleBible = null, frames = [], forbidden = [] } = {}) {
  const chars = (characterBible || []).map((c) =>
    `- ${c.name}: ${[c.age && `age ${c.age}`, c.gender, c.hair, c.build, c.clothing, c.distinguishing].filter(Boolean).join(", ")}`).join("\n");
  const locs = (locationBible || []).map((l) => `- ${l.name}: ${[l.description, l.timeOfDay, l.lighting].filter(Boolean).join(", ")}`).join("\n");
  const stamps = frames.map((f) => `${f.label} (${(f.atSeconds ?? 0).toFixed(2)}s)`).join(", ");

  return [
    "You are grading a single shot of a short vertical film against the line of narration that plays over it.",
    "The image is a contact sheet: several frames from THIS shot, in order, each labelled with its timestamp.",
    "",
    `FRAMES IN THE SHEET: ${stamps || "(unlabelled)"}`,
    "",
    "THE NARRATION HEARD OVER THIS SHOT, word for word:",
    `"${String(narrationText || "").trim()}"`,
    "",
    "WHAT THE SHOT WAS COMMISSIONED TO SHOW:",
    `- intent: ${shot?.semanticIntent || "(none given)"}`,
    `- action: ${shot?.action || "(none given)"}`,
    `- location: ${shot?.location || "(none given)"}, ${shot?.timeOfDay || "unspecified time"}`,
    `- characters who must be visible: ${(shot?.visibleCharacters || []).join(", ") || "(none required)"}`,
    `- objects that must be visible: ${(shot?.requiredObjects || []).join(", ") || "(none required)"}`,
    `- emotional tone: ${shot?.emotion || "(unspecified)"}`,
    `- framing: ${shot?.framing || "(unspecified)"}`,
    "",
    chars ? `CHARACTER BIBLE (appearance must stay consistent across the whole film):\n${chars}` : "",
    locs ? `LOCATION BIBLE:\n${locs}` : "",
    styleBible ? `VISUAL STYLE: ${typeof styleBible === "string" ? styleBible : JSON.stringify(styleBible)}` : "",
    forbidden.length ? `MUST NOT APPEAR: ${forbidden.join(", ")}` : "",
    "",
    "HOW TO GRADE — read this carefully:",
    "- Grade whether the frames show THE SPECIFIC MOMENT THE NARRATION DESCRIBES. Not whether they are",
    "  attractive, well-composed, or thematically related. A beautiful shot of a street while the narration",
    "  says a man sets a letter on a table scores near zero on semanticMatch and actionMatch.",
    "- If the described action is not visibly happening, actionMatch is low even when the setting is right.",
    "- If a required character is absent, or a person appears who should not be there, or someone's hair,",
    "  age, gender, build or clothing contradicts the character bible, characterMatch is low. Say which.",
    "- Cite a frame timestamp for every claim you make. A claim with no timestamp will be discarded.",
    "- If the sheet is unreadable, or you cannot see the frames, set \"readable\": false and do not invent scores.",
    "",
    "Reply with ONE JSON object and nothing else — no prose before or after, no markdown fence:",
    "{",
    '  "readable": true,',
    '  "semanticMatch": 0.0, "actionMatch": 0.0, "characterMatch": 0.0, "objectMatch": 0.0,',
    '  "locationMatch": 0.0, "emotionMatch": 0.0, "styleMatch": 0.0, "continuityMatch": 0.0,',
    '  "charactersSeen": ["..."], "unexpectedCharacters": ["..."], "missingCharacters": ["..."],',
    '  "appearanceContradictions": [{"character": "...", "expected": "...", "seen": "...", "atSeconds": 0.0}],',
    '  "forbiddenElementViolations": [{"element": "...", "atSeconds": 0.0}],',
    '  "evidence": [{"atSeconds": 0.0, "observed": "what is actually visible in this frame"}],',
    '  "failedRequirements": ["short phrases naming what the shot does not deliver"],',
    '  "summary": "one sentence on what these frames actually show"',
    "}"
  ].filter(Boolean).join("\n");
}

/** Pull the JSON object out of a chat reply. Models add fences and preambles; a strict parse would reject a
 *  perfectly good answer for its packaging. Balanced-brace scanning, so a nested object survives. */
export function extractJson(raw) {
  const text = String(raw || "");
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null);

/**
 * Read the judge's answer into a verdict.
 *
 * `framesAttached` is not decoration: if the picture never reached the model, whatever it replied is about
 * nothing at all. That is the single most dangerous failure mode here — a fluent, confident, entirely
 * imaginary assessment — so it is checked before the content is even looked at.
 */
export function parseVisionVerdict(raw, { shot = null, floors = VISION_FLOORS, framesAttached = true, frames = [] } = {}) {
  const F = { ...VISION_FLOORS, ...floors };

  if (!framesAttached) {
    return Object.freeze({
      verdict: VISION_VERDICT.UNMEASURED, measured: false, scores: {}, failedRequirements: [],
      evidence: [], reason: "no frames were attached, so any answer describes nothing"
    });
  }

  const j = extractJson(raw);
  if (!j || typeof j !== "object") {
    return Object.freeze({
      verdict: VISION_VERDICT.UNMEASURED, measured: false, scores: {}, failedRequirements: [],
      evidence: [], raw: String(raw || "").slice(0, 400),
      reason: "the judge did not return a JSON object"
    });
  }
  if (j.readable === false) {
    return Object.freeze({
      verdict: VISION_VERDICT.UNMEASURED, measured: false, scores: {}, failedRequirements: [],
      evidence: [], reason: "the judge reported it could not read the frames"
    });
  }

  const scores = {};
  const missing = [];
  for (const d of VISION_DIMENSIONS) {
    const v = clamp01(Number(j[d]));
    if (v === null) missing.push(d); else scores[d] = v;
  }
  // A hard dimension the judge simply did not answer cannot be assumed good.
  const missingHard = missing.filter((d) => VISION_HARD.includes(d));
  if (missingHard.length > 0) {
    return Object.freeze({
      verdict: VISION_VERDICT.UNMEASURED, measured: false, scores, failedRequirements: [],
      evidence: [], reason: `the judge did not score ${missingHard.join(", ")}`
    });
  }

  // Evidence must be anchored in time, and in a frame that was actually in the sheet. An "observation" at a
  // timestamp nobody sent is a fabrication, and it is the tell that the model is describing a film it imagined.
  const stamps = frames.map((f) => Number(f.atSeconds)).filter(Number.isFinite);
  const nearFrame = (t) => stamps.length === 0 || stamps.some((s) => Math.abs(s - t) <= 0.75);
  const evidence = (Array.isArray(j.evidence) ? j.evidence : [])
    .filter((e) => e && Number.isFinite(Number(e.atSeconds)) && typeof e.observed === "string" && e.observed.trim())
    .map((e) => ({ atSeconds: Number(Number(e.atSeconds).toFixed(2)), observed: String(e.observed).slice(0, 240), anchored: nearFrame(Number(e.atSeconds)) }));
  const anchored = evidence.filter((e) => e.anchored);

  if (anchored.length === 0) {
    return Object.freeze({
      verdict: VISION_VERDICT.UNMEASURED, measured: false, scores, failedRequirements: [],
      evidence, reason: "no observation was anchored to a frame that was actually sent"
    });
  }

  const violations = (Array.isArray(j.forbiddenElementViolations) ? j.forbiddenElementViolations : [])
    .filter((v) => v && typeof v.element === "string").map((v) => ({ element: String(v.element).slice(0, 80), atSeconds: Number.isFinite(Number(v.atSeconds)) ? Number(v.atSeconds) : null }));
  const contradictions = (Array.isArray(j.appearanceContradictions) ? j.appearanceContradictions : [])
    .filter((c) => c && typeof c.character === "string")
    .map((c) => ({ character: String(c.character).slice(0, 60), expected: String(c.expected || "").slice(0, 120), seen: String(c.seen || "").slice(0, 120), atSeconds: Number.isFinite(Number(c.atSeconds)) ? Number(c.atSeconds) : null }));
  const missingChars = (Array.isArray(j.missingCharacters) ? j.missingCharacters : []).map((x) => String(x).slice(0, 60));
  const unexpectedChars = (Array.isArray(j.unexpectedCharacters) ? j.unexpectedCharacters : []).map((x) => String(x).slice(0, 60));

  const failed = [];
  for (const d of VISION_DIMENSIONS) {
    if (scores[d] == null) continue;
    if (scores[d] < F[d]) failed.push({ dimension: d, score: scores[d], floor: F[d], hard: VISION_HARD.includes(d) });
  }
  for (const v of violations) failed.push({ dimension: "forbidden", detail: v.element, hard: true });
  for (const c of contradictions) failed.push({ dimension: "characterContinuity", detail: `${c.character}: expected ${c.expected}, seen ${c.seen}`, hard: true });
  if (missingChars.length) failed.push({ dimension: "characterMatch", detail: `missing: ${missingChars.join(", ")}`, hard: true });

  const hardFailed = failed.filter((f) => f.hard);
  const softFailed = failed.filter((f) => !f.hard);

  // A wrong shot is regenerated; a merely weak one goes to a human. Regenerating on a soft miss burns provider
  // quota chasing a judgement call that a person should make.
  const verdict = hardFailed.length > 0 ? VISION_VERDICT.REGENERATE
    : softFailed.length > 0 ? VISION_VERDICT.MANUAL_REVIEW
      : VISION_VERDICT.PASS;

  return Object.freeze({
    verdict, measured: true,
    scores: Object.freeze(scores),
    charactersSeen: Object.freeze((Array.isArray(j.charactersSeen) ? j.charactersSeen : []).map((x) => String(x).slice(0, 60))),
    missingCharacters: Object.freeze(missingChars),
    unexpectedCharacters: Object.freeze(unexpectedChars),
    appearanceContradictions: Object.freeze(contradictions),
    forbiddenElementViolations: Object.freeze(violations),
    failedRequirements: Object.freeze([
      ...failed.map((f) => f.detail ? `${f.dimension}: ${f.detail}` : `${f.dimension} ${f.score} < ${f.floor}`),
      ...(Array.isArray(j.failedRequirements) ? j.failedRequirements.map((x) => String(x).slice(0, 120)) : [])
    ]),
    failedDimensions: Object.freeze(failed),
    evidence: Object.freeze(evidence),
    summary: typeof j.summary === "string" ? j.summary.slice(0, 300) : null,
    shotId: shot?.shotId ?? null,
    reason: verdict === VISION_VERDICT.PASS
      ? "the frames show the moment the narration describes"
      : failed.map((f) => f.dimension).join(", ")
  });
}

/**
 * A retry prompt built from what failed, not a repeat of the original.
 *
 * Re-sending the same prompt after a rejection is how a pipeline spends its whole retry budget getting the
 * same wrong shot three times. The judge said what was missing and cited frames; that is the correction.
 */
export function refineShotPrompt({ shot, verdict, characterBible = [] } = {}) {
  if (!shot) return null;
  const fixes = [];
  const seen = new Set();
  for (const f of (verdict?.failedDimensions || [])) {
    if (seen.has(f.dimension)) continue;
    seen.add(f.dimension);
    switch (f.dimension) {
      case "actionMatch": fixes.push(`The action MUST be visibly happening: ${shot.action}. Show it mid-motion, not before or after.`); break;
      case "semanticMatch": fixes.push(`The frame must depict exactly this moment: ${shot.semanticIntent}.`); break;
      case "characterMatch": fixes.push(`These characters must be clearly visible: ${(shot.visibleCharacters || []).join(", ")}. No other people in frame.`); break;
      case "objectMatch": fixes.push(`These objects must be clearly visible: ${(shot.requiredObjects || []).join(", ")}.`); break;
      case "locationMatch": fixes.push(`The setting must be ${shot.location}, ${shot.timeOfDay}.`); break;
      case "characterContinuity": fixes.push(`Appearance must match exactly: ${(characterBible || []).map((c) => `${c.name} — ${[c.age && `age ${c.age}`, c.gender, c.hair, c.clothing].filter(Boolean).join(", ")}`).join("; ")}`); break;
      case "forbidden": fixes.push(`Must NOT appear: ${f.detail}.`); break;
      case "styleMatch": fixes.push(`Visual style must be: ${shot.visualStyle}.`); break;
      default: break;
    }
  }
  const observed = (verdict?.evidence || []).slice(0, 3).map((e) => e.observed).filter(Boolean);
  return [
    shot.generationPrompt,
    fixes.length ? `\nCORRECTIONS — the previous attempt failed on these:\n- ${fixes.join("\n- ")}` : "",
    observed.length ? `\nThe previous attempt showed instead: ${observed.join(" / ")}. Do not repeat that.` : ""
  ].filter(Boolean).join("\n").slice(0, 1800);
}
