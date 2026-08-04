// P0 Step 5C.40 — actually run the vision judge against a real shot.
//
// Everything this needs already existed and none of it had ever been called in anger: the contact-sheet
// builder, the prompt, the parser, the artifact store. This is the piece that puts them in a line and spends
// one real provider call per shot.
//
// Durability is the whole difficulty. A judgement costs quota, so it must happen at most once per shot
// revision, survive a restart, and never leave a shot in a state where a second worker will judge it again.
// The rules are the same ones the story repair scheduler proved: an idempotency key derived from what is being
// judged, a conditional claim, and a verdict written exactly once.

import { createHash } from "node:crypto";
import path from "node:path";
import { buildContactSheet } from "./contact-sheet.mjs";
import { buildVisionPrompt, parseVisionVerdict, VISION_VERDICT } from "./vision-judge.mjs";

export const VISION_ERRORS = Object.freeze({
  NO_ACTUATOR: "E_VISION_ACTUATOR_UNAVAILABLE",
  SHEET_FAILED: "E_VISION_CONTACT_SHEET_FAILED",
  ATTACHMENT: "E_GROK_VISION_ATTACHMENT_CAPABILITY_REQUIRED",
  RESPONSE_UNUSABLE: "E_GROK_VISION_RESPONSE_UNUSABLE",
  ALREADY_RUNNING: "E_VISION_ALREADY_IN_FLIGHT"
});

const sha = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");

/**
 * The idempotency key for one judgement.
 *
 * Derived from WHAT IS BEING JUDGED — the movie, the scene, the shot contract revision and the exact clip —
 * so re-running after a crash resolves to the same key and cannot spend a second call, while a repaired shot
 * (new clip, new contract revision) is legitimately a different judgement.
 */
export function visionIdempotencyKey({ movieProjectId, sceneId, shotRevision, clipSha256 }) {
  return sha(`vision|${movieProjectId}|${sceneId}|${shotRevision ?? 0}|${clipSha256 || ""}`);
}

/**
 * Judge one shot.
 *
 * `actuator.judgeVision` is the SAME Grok Chat actuator the story factory uses: same account, lease, pacing
 * lane, one-submit reservation and ledger. `onBeforeSubmit` is where the caller reserves the invocation, and it
 * is called only after the page has confirmed it holds the image — so a composer that will not take an
 * attachment costs nothing at all.
 */
export async function judgeShot({
  actuator,
  clipPath,
  sheetPath,
  shot,
  narrationText,
  characterBible = [],
  locationBible = [],
  styleBible = null,
  forbidden = [],
  frameCount = 5,
  onBeforeSubmit = null,
  now = () => Date.now()
} = {}) {
  if (!actuator || typeof actuator.judgeVision !== "function") {
    return Object.freeze({ ok: false, code: VISION_ERRORS.NO_ACTUATOR, verdict: null, reason: "no vision-capable actuator on this runtime" });
  }

  // ---- the picture ---------------------------------------------------------------------------------------
  let sheet;
  try {
    sheet = await buildContactSheet({
      clipPath, outputPath: sheetPath,
      workDir: path.join(path.dirname(sheetPath), `.sheet-${path.basename(sheetPath, ".jpg")}`),
      count: frameCount, columns: 1
    });
  } catch (e) {
    return Object.freeze({ ok: false, code: VISION_ERRORS.SHEET_FAILED, verdict: null, reason: e.code || e.message });
  }

  const prompt = buildVisionPrompt({ shot, narrationText, characterBible, locationBible, styleBible, frames: sheet.frames, forbidden });
  const promptSha = sha(prompt);
  const sheetSha = sha(sheet.base64);
  const startedAt = now();

  // ---- the call ------------------------------------------------------------------------------------------
  let out;
  try {
    out = await actuator.judgeVision({
      prompt, imageBase64: sheet.base64,
      fileName: path.basename(sheetPath), mimeType: sheet.mimeType,
      onBeforeSubmit
    });
  } catch (e) {
    // An attachment refusal is a CAPABILITY finding, not a transient failure: retrying the same page with the
    // same composer will refuse the same way, and each retry costs a browser session.
    const code = /ATTACHMENT|UNSUPPORTED/iu.test(String(e.code || "")) ? VISION_ERRORS.ATTACHMENT : (e.code || VISION_ERRORS.RESPONSE_UNUSABLE);
    return Object.freeze({ ok: false, code, verdict: null, reason: e.message, sheet: sheetSummary(sheet, sheetSha), promptSha });
  }

  if (!out.ok) {
    const attachmentProblem = /ATTACHMENT/iu.test(String(out.reason || ""));
    return Object.freeze({
      ok: false,
      code: attachmentProblem ? VISION_ERRORS.ATTACHMENT : VISION_ERRORS.RESPONSE_UNUSABLE,
      verdict: null, reason: out.reason, submitted: out.submitted === true,
      attachment: out.attachment || null, sheet: sheetSummary(sheet, sheetSha), promptSha
    });
  }

  // ---- the answer ----------------------------------------------------------------------------------------
  // framesAttached is not decoration: the parser refuses to score anything when the picture did not reach the
  // model, and this is where that fact comes from.
  const verdict = parseVisionVerdict(out.text, {
    shot, frames: sheet.frames,
    framesAttached: Boolean(out.attachment && out.attachment.attached === true)
  });

  return Object.freeze({
    ok: true,
    code: null,
    verdict,
    submitted: true,
    // Everything needed to explain the verdict later, without keeping the response text itself: what was sent,
    // what came back, and which frames the model was actually looking at.
    evidence: Object.freeze({
      contactSheetSha256: sheetSha,
      contactSheetPath: sheet.path,
      sampledTimestamps: Object.freeze(sheet.frames.map((f) => f.atSeconds)),
      promptSha256: promptSha,
      responseSha256: sha(out.text || ""),
      responseChars: (out.text || "").length,
      attachment: out.attachment || null,
      clipDurationSeconds: sheet.clipDurationSeconds,
      elapsedMs: now() - startedAt
    })
  });
}

function sheetSummary(sheet, sheetSha) {
  return Object.freeze({ contactSheetSha256: sheetSha, frames: sheet.frames.length, sizeBytes: sheet.sizeBytes });
}

/**
 * The artifact body for one judgement.
 *
 * Written whether the shot passed or failed — a rejection is evidence too, and a repair needs to point at the
 * verdict that caused it. An UNMEASURED verdict is recorded as UNMEASURED and never quietly dropped: a shot
 * with no usable judgement must keep the film out of PUBLISHABLE, and it can only do that if it is on record.
 */
export function visionArtifactBody({ result, shot, narrationText, attempt = 1 }) {
  const v = result.verdict;
  // A failure keeps whatever evidence it managed to collect. The first live run recorded a blocker with no
  // sheet hash and no frame list, so the artifact said something had gone wrong without saying what was being
  // looked at when it did - and that is the one thing a failed judgement still knows.
  const partial = result.evidence || (result.sheet ? { ...result.sheet, promptSha256: result.promptSha || null } : {});
  return {
    verdict: v ? v.verdict : VISION_VERDICT.UNMEASURED,
    measured: Boolean(v && v.measured),
    scores: v ? v.scores : {},
    failedRequirements: v ? v.failedRequirements : [],
    evidence: v ? v.evidence : [],
    missingCharacters: v ? v.missingCharacters : [],
    unexpectedCharacters: v ? v.unexpectedCharacters : [],
    appearanceContradictions: v ? v.appearanceContradictions : [],
    forbiddenElementViolations: v ? v.forbiddenElementViolations : [],
    summary: v ? v.summary : null,
    reason: v ? v.reason : (result.reason || null),
    attempt,
    shotId: shot?.shotId ?? null,
    narrationText: String(narrationText || "").slice(0, 500),
    provider: "GROK_CHAT",
    ...partial
  };
}
