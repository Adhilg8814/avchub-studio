// P0 Step 5C.41 — the scene count is the adaptation's decision, and a failed judgement is not a judgement.
//
// Both rules exist because breaking them costs real money. The planner used to pad a one-beat story to three
// scenes by REPEATING the beat, and the runtime dutifully generated all three: four Grok generations during
// the 5C.40 cert that nobody asked for and that produced the same shot three times. And a vision attempt that
// died before reaching the browser recorded itself as a verdict, which made the film permanently unjudgeable
// the moment the bug was fixed.
//
// Pure: no provider, no database, no browser.

import { planScenes } from "../lib/movie/scene-planner.mjs";
import { planShotRepairs, REPAIR_POLICY } from "../lib/movie/content-pipeline.mjs";
import { VISION_VERDICT } from "../lib/movie/vision-judge.mjs";
import { visionIdempotencyKey, visionArtifactBody, VISION_ERRORS } from "../lib/movie/scene-vision-runner.mjs";

let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n, d ? `-> ${d}` : ""); } };

const story = (beats) => ({
  title: "Beat count", synopsis: "A short film.", language: "da-DK", genre: "drama",
  styleBible: "muted nordic realism", characters: [{ name: "Karen", description: "the narrator" }],
  beats
});
const beat = (i) => ({ heading: `Scene ${i}`, narration: `Line ${i}.`, visual: `visual ${i}` });

// ============================================================ §4 scene count follows the adaptation

// S1 — one beat is one shot
{
  const p = planScenes(story([beat(1)]), { aspectRatio: "9:16", targetDurationSeconds: 25, sceneDurationSeconds: 6 });
  // The old planner returned 3 here — the same beat three times — and each one became a provider call.
  check("S1 one beat plans exactly one scene", p.length === 1, `${p.length}`);
  check("S1 and it is the beat that was given", p[0].visualDescription.includes("visual 1"));
}

// S2 — three beats are three shots, in order, once each
{
  const p = planScenes(story([beat(1), beat(2), beat(3)]), { aspectRatio: "9:16", targetDurationSeconds: 25, sceneDurationSeconds: 6 });
  check("S2 three beats plan exactly three scenes", p.length === 3, `${p.length}`);
  check("S2 in order", p.every((x, i) => x.visualDescription.includes(`visual ${i + 1}`)), JSON.stringify(p.map((x) => x.visualDescription.slice(0, 12))));
  const ordinals = p.map((x) => x.ordinal);
  check("S2 no duplicate ordinal", new Set(ordinals).size === ordinals.length, JSON.stringify(ordinals));
  // Three identical scenes is the signature of the padding bug.
  check("S2 the scenes are distinct from each other", new Set(p.map((x) => x.visualDescription)).size === 3);
}

// S3 — a long target does not buy extra scenes
{
  const short = planScenes(story([beat(1), beat(2)]), { targetDurationSeconds: 60, sceneDurationSeconds: 6 });
  check("S3 a 60-second target with two beats is still two scenes", short.length === 2, `${short.length}`);
}

// S4 — no beats at all
{
  const p = planScenes({ title: "Idea only", synopsis: "A quiet kitchen at dawn.", language: "da-DK", beats: [] }, { targetDurationSeconds: 25, sceneDurationSeconds: 6 });
  check("S4 a story with no beats plans ONE scene from its synopsis", p.length === 1, `${p.length}`);
  check("S4 not several identical ones", p.length === 1 && p[0].visualDescription.includes("quiet kitchen"));
}

// S5 — replanning is stable
{
  const s = story([beat(1), beat(2), beat(3)]);
  const a = planScenes(s, { targetDurationSeconds: 25, sceneDurationSeconds: 6 });
  const b = planScenes(s, { targetDurationSeconds: 25, sceneDurationSeconds: 6 });
  // A restart that replans must not grow the film.
  check("S5 replanning the same story yields the same count", a.length === b.length && a.length === 3);
  check("S5 and the same ordinals", JSON.stringify(a.map((x) => x.ordinal)) === JSON.stringify(b.map((x) => x.ordinal)));
}

// S6 — the old behaviour is still reachable, deliberately
{
  const p = planScenes(story([beat(1)]), { targetDurationSeconds: 18, sceneDurationSeconds: 6, padToMinimum: true });
  check("S6 padToMinimum still pads for a caller that asks for it", p.length >= 3, `${p.length}`);
  check("S6 but it is off by default", planScenes(story([beat(1)]), { targetDurationSeconds: 18, sceneDurationSeconds: 6 }).length === 1);
}

// S7 — the cap still holds
{
  const many = Array.from({ length: 20 }, (_, i) => beat(i + 1));
  const p = planScenes(story(many), { targetDurationSeconds: 200, sceneDurationSeconds: 6 });
  check("S7 the maximum scene count is still enforced", p.length <= 10 && p.length > 3, `${p.length}`);
}

// ============================================================ §2 a failed attempt is not a judgement

const verdictBody = (over = {}) => visionArtifactBody({
  result: { ok: false, code: VISION_ERRORS.RESPONSE_UNUSABLE, verdict: null, reason: "no JSON in the reply", ...over },
  shot: { shotId: "shot_1" }, narrationText: "Han lagde brevet på bordet."
});

// V1 — a blocked attempt records UNMEASURED and says why
{
  const b = verdictBody();
  check("V1 a failed attempt is UNMEASURED", b.verdict === VISION_VERDICT.UNMEASURED && b.measured === false);
  check("V1 with the reason kept", b.reason === "no JSON in the reply");
  check("V1 and no invented scores", Object.keys(b.scores).length === 0);
}

// V2 — the evidence survives a failure
{
  const b = verdictBody({ sheet: { contactSheetSha256: "abc", frames: 5, sizeBytes: 1000 }, promptSha: "def" });
  // Without this the artifact says something went wrong without saying what was being looked at when it did.
  check("V2 a failure keeps the contact-sheet hash", b.contactSheetSha256 === "abc", JSON.stringify(b));
  check("V2 and the prompt hash", b.promptSha256 === "def");
}

// V3 — a successful judgement carries its full evidence
{
  const b = visionArtifactBody({
    result: { ok: true, verdict: { verdict: VISION_VERDICT.PASS, measured: true, scores: { semanticMatch: 0.9 }, failedRequirements: [], evidence: [{ atSeconds: 1.2, observed: "a man sets a letter down", anchored: true }], missingCharacters: [], unexpectedCharacters: [], appearanceContradictions: [], forbiddenElementViolations: [], summary: "ok", reason: "matches" },
      evidence: { contactSheetSha256: "s", promptSha256: "p", responseSha256: "r", responseChars: 900, sampledTimestamps: [0.3, 1.2, 2.4] } },
    shot: { shotId: "shot_1" }, narrationText: "x"
  });
  check("V3 a PASS carries scores, evidence and hashes", b.verdict === VISION_VERDICT.PASS && b.measured === true && b.contactSheetSha256 === "s" && b.sampledTimestamps.length === 3);
  check("V3 and no blocker", b.blocker === undefined);
}

// V4 — idempotency distinguishes a repair from a replay
{
  const base = { movieProjectId: "mov_1", sceneId: "scn_1", shotRevision: 1, clipSha256: "aaa" };
  check("V4 the same clip and contract is the same judgement", visionIdempotencyKey(base) === visionIdempotencyKey({ ...base }));
  // A repaired shot is a NEW picture, so judging it is a first call and not a duplicate.
  check("V4 a new clip is a new judgement", visionIdempotencyKey(base) !== visionIdempotencyKey({ ...base, clipSha256: "bbb" }));
  check("V4 a new contract revision is a new judgement", visionIdempotencyKey(base) !== visionIdempotencyKey({ ...base, shotRevision: 2 }));
  check("V4 a different scene is a different judgement", visionIdempotencyKey(base) !== visionIdempotencyKey({ ...base, sceneId: "scn_2" }));
}

// ============================================================ §3 targeted repair, bounded and narrow

const vv = (sceneId, verdict, reqs = []) => ({ sceneId, verdict, failedRequirements: reqs, reason: reqs.join(",") });

// R1 — only the failing shot, and the failure travels with it
{
  const p = planShotRepairs({ verdicts: [
    vv("s0", VISION_VERDICT.REGENERATE, ["actionMatch 0 < 0.65", "no letter visible"]),
    vv("s1", VISION_VERDICT.PASS),
    vv("s2", VISION_VERDICT.UNMEASURED)
  ] });
  check("R1 exactly the REGENERATE shot is repaired", p.repair.length === 1 && p.repair[0].sceneId === "s0");
  // Regenerating a passing shot spends quota replacing something correct with something merely different.
  check("R1 the PASS shot is untouched", !p.repair.some((r) => r.sceneId === "s1"));
  check("R1 the UNMEASURED shot goes to review, not to the provider", p.review.some((r) => r.sceneId === "s2") && !p.repair.some((r) => r.sceneId === "s2"));
  check("R1 the failed requirements are carried into the retry", p.repair[0].failedRequirements.includes("no letter visible"));
  check("R1 and none of this is publishable", p.blocksPublish === true);
}

// R2 — bounded at two attempts
{
  const first = planShotRepairs({ verdicts: [vv("s0", VISION_VERDICT.REGENERATE)], attemptsSoFar: {} });
  check("R2 attempt 1 is offered", first.repair[0].attempt === 1);
  const second = planShotRepairs({ verdicts: [vv("s0", VISION_VERDICT.REGENERATE)], attemptsSoFar: { s0: 1 } });
  check("R2 attempt 2 is offered", second.repair[0].attempt === 2);
  const third = planShotRepairs({ verdicts: [vv("s0", VISION_VERDICT.REGENERATE)], attemptsSoFar: { s0: REPAIR_POLICY.maxAttemptsPerShot } });
  check("R2 there is no attempt 3", third.repair.length === 0 && third.exhausted.length === 1);
  check("R2 and an exhausted shot blocks publication rather than looping", third.blocksPublish === true);
}

// R3 — all passing is the only state that clears
{
  const p = planShotRepairs({ verdicts: [vv("s0", VISION_VERDICT.PASS), vv("s1", VISION_VERDICT.PASS)] });
  check("R3 all-PASS needs no repair and blocks nothing", p.repair.length === 0 && p.blocksPublish === false);
}

console.log(`Step 5C.41 scene count + repair: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
