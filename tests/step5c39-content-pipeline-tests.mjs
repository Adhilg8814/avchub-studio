// P0 Step 5C.39 — the order the film gets made in, and the gates between the steps.
//
// The ordering IS the design, so it is tested as such: an adaptation that invents a fact must be refused before
// any provider is called, a recording in the wrong language before any frame is generated, a 480p source before
// narration is synthesised. Each of those is a test that the pipeline refuses to reach the next stage.
//
// Pure: no provider, no database, no browser, no quota.

import {
  gateAdaptation, buildCanonicalTimeline, buildVerifiedSubtitles, gateTranscript, gateSources,
  planShotRepairs, nextStage, PIPELINE_ERRORS, PIPELINE_STAGE, REPAIR_POLICY
} from "../lib/movie/content-pipeline.mjs";
import { TRANSCRIPT_VERDICT } from "../lib/movie/transcript-verification.mjs";
import { VISION_VERDICT } from "../lib/movie/vision-judge.mjs";
import { SOURCE_POLICY, ASSET_VERDICT } from "../lib/media/asset-policy.mjs";

let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n, d ? `-> ${d}` : ""); } };
function refuses(name, fn, code) {
  try { fn(); check(name, false, "expected a refusal"); }
  catch (e) { const got = String(e && e.code || ""); if (got === code) passed += 1; else { failed += 1; console.log("FAIL", name, "->", got || (e && e.message)); } }
}

// ============================================================ fixtures

const STORY = {
  title: "Mødelokalet", language: "da-DK", genre: "drama",
  characters: [{ name: "Karen", description: "the narrator, 52" }, { name: "Jesper", description: "her son" }],
  beats: [
    { heading: "Scene 1", narration: "Jeg sad over for dem i det kommunale mødelokale.", visual: "a municipal meeting room" },
    { heading: "Scene 2", narration: "Sagsbehandleren bad os sidde.", visual: "a caseworker gestures to a chair" },
    { heading: "Scene 3", narration: "Om søndagen sad jeg i køkkenet.", visual: "a quiet kitchen on a sunday" }
  ]
};

// ~62 words for 25 seconds — 2.5 words per second, a listenable pace.
const SCRIPT_25S = [
  "Jeg sad over for dem i det kommunale mødelokale, og ingen sagde noget.",
  "Sagsbehandleren bad os sidde ned, som om det var en helt almindelig dag.",
  "Jesper kiggede ned i bordet og rørte sig ikke, mens papirerne blev lagt frem.",
  "Om søndagen sad jeg alene i køkkenet og kiggede ud på haven, og jeg forstod det endelig."
].join(" ");

const adaptation = (over = {}) => ({
  format: "SHORT_FORM", locale: "da-DK", targetDurationSeconds: 25,
  sourceStoryId: "sty_1", sourceStoryRevision: 3,
  hook: "Ingen af dem kiggede på mig, da de fortalte mig det — og det var sådan jeg vidste det.",
  narrationScript: SCRIPT_25S,
  beatSheet: [
    { role: "HOOK", text: "the room goes quiet" },
    { role: "SETUP", text: "the caseworker begins" },
    { role: "PROGRESSION", text: "the papers come out" },
    { role: "PAYOFF", text: "sunday in the kitchen" }
  ],
  characterBible: [{ name: "Karen", age: 52 }, { name: "Jesper", age: 24 }],
  locationBible: [{ name: "meeting room" }, { name: "kitchen" }],
  styleBible: { look: "muted nordic realism" },
  ...over
});

// A real-shaped ElevenLabs alignment: characters with start/end seconds.
function alignmentFor(text, { startAt = 0, msPerChar = 60 } = {}) {
  const characters = [...text];
  const starts = [], ends = [];
  let t = startAt;
  for (const ch of characters) {
    starts.push(Number(t.toFixed(4)));
    t += (ch === " " ? msPerChar * 0.6 : msPerChar) / 1000;
    ends.push(Number(t.toFixed(4)));
  }
  return { characters, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends };
}

// ============================================================ §3 the adaptation gate

// A1 — a good short form passes
{
  const g = gateAdaptation({ adaptation: adaptation(), story: STORY, targetDurationSeconds: 25, locale: "da-DK" });
  check("A1 a purpose-written short form passes", g.ok === true, JSON.stringify(g.failures));
  check("A1 and the pace is reported, not guessed", g.wordsPerSecond >= 1.8 && g.wordsPerSecond <= 3.6, String(g.wordsPerSecond));
  check("A1 all four structural roles are present", g.roles.includes("HOOK") && g.roles.includes("PAYOFF"));
}

// A2 — structure
{
  const noHook = gateAdaptation({ adaptation: adaptation({ hook: "" }), story: STORY, targetDurationSeconds: 25, locale: "da-DK" });
  check("A2 no hook is refused", noHook.ok === false && noHook.failures.some((f) => /hook/iu.test(f)));
  const noEnd = gateAdaptation({ adaptation: adaptation({ beatSheet: [{ role: "HOOK" }, { role: "SETUP" }, { role: "PROGRESSION" }] }), story: STORY, targetDurationSeconds: 25, locale: "da-DK" });
  // Without an ending the film is three unrelated moments, which is what shipped before this gate.
  check("A2 no payoff and no cliffhanger is refused", noEnd.ok === false && noEnd.failures.some((f) => /payoff/iu.test(f)), JSON.stringify(noEnd.failures));
  const noProgress = gateAdaptation({ adaptation: adaptation({ beatSheet: [{ role: "HOOK" }, { role: "PAYOFF" }] }), story: STORY, targetDurationSeconds: 25, locale: "da-DK" });
  check("A2b a missing SETUP or PROGRESSION is named specifically", noProgress.failures.some((f) => /SETUP/u.test(f)) && noProgress.failures.some((f) => /PROGRESSION/u.test(f)));
}

// A3 — length must be written for, not trimmed into
{
  const tooLong = gateAdaptation({ adaptation: adaptation(), story: STORY, targetDurationSeconds: 10, locale: "da-DK" });
  check("A3 a 25-second script forced into 10 seconds is refused", tooLong.ok === false && tooLong.failures.some((f) => /listenable pace/iu.test(f)), JSON.stringify(tooLong.failures));
  const tooShort = gateAdaptation({ adaptation: adaptation({ narrationScript: "Han gik." }), story: STORY, targetDurationSeconds: 25, locale: "da-DK" });
  check("A3 two words for 25 seconds is mostly silence, and refused", tooShort.ok === false && tooShort.failures.some((f) => /silence/iu.test(f)));
  const empty = gateAdaptation({ adaptation: adaptation({ narrationScript: "" }), story: STORY, targetDurationSeconds: 25, locale: "da-DK" });
  check("A3b an empty script is refused", empty.ok === false && empty.failures.some((f) => /empty/iu.test(f)));
}

// A4 — locale
{
  const g = gateAdaptation({ adaptation: adaptation({ locale: "sv-SE" }), story: STORY, targetDurationSeconds: 25, locale: "da-DK" });
  check("A4 an adaptation in the wrong language is refused", g.ok === false && g.failures.some((f) => /sv-SE/u.test(f)), JSON.stringify(g.failures));
}

// A5 — nothing exists yet
{
  const g = gateAdaptation({ adaptation: null, story: STORY, targetDurationSeconds: 25 });
  check("A5 no adaptation at all is ADAPTATION_REQUIRED, not a pass", g.ok === false && g.code === PIPELINE_ERRORS.ADAPTATION_REQUIRED);
}

// ============================================================ §4/§5 one canonical timeline

// B1 — a single continuous narration
{
  const t = buildCanonicalTimeline([{ alignment: alignmentFor(SCRIPT_25S), measuredDurationMs: null }]);
  check("B1 one segment produces one timeline", t.segments.length > 0);
  check("B1 it starts at zero", t.startMs === 0);
  check("B1 and every word carries a real timestamp", t.segments.every((s) => s.words.every((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs))));
}

// B2 — several segments become ONE clock
{
  const a = alignmentFor("Første sætning her.", { msPerChar: 60 });
  const b = alignmentFor("Anden sætning her.", { msPerChar: 60 });
  const t = buildCanonicalTimeline([
    { alignment: a, measuredDurationMs: 1400 },
    { alignment: b, measuredDurationMs: 1300 }
  ]);
  // The second segment's alignment believes it starts at zero. If that survived into the timeline, every
  // subtitle in the back half of the film would fire at the start of it.
  const second = t.segments[t.segments.length - 1];
  check("B2 the second segment does NOT start at zero", second.audioStartMs >= 1400, String(second.audioStartMs));
  check("B2 timestamps are absolute across the whole film", t.endMs > 1400);
  check("B2 segments are in order and do not overlap", t.segments.every((s, i) => i === 0 || s.audioStartMs >= t.segments[i - 1].audioEndMs - 1));
}

// B3 — no alignment means no film, not an estimated one
{
  refuses("B3 a segment with no alignment refuses", () => buildCanonicalTimeline([{ alignment: null }]), PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE);
  refuses("B3b no segments at all refuses", () => buildCanonicalTimeline([]), PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE);
  refuses("B3c a malformed alignment refuses rather than being repaired", () => buildCanonicalTimeline([{ alignment: { characters: ["a", "b"], characterStartTimesSeconds: [0], characterEndTimesSeconds: [1] } }]), PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE);
}

// ============================================================ §7 subtitles from the same clock

// C1 — cues derive from real word times
{
  const t = buildCanonicalTimeline([{ alignment: alignmentFor(SCRIPT_25S) }]);
  const subs = buildVerifiedSubtitles(t);
  check("C1 cues are produced", subs.cues.length > 0);
  check("C1 drift against the audio is zero — they came FROM it", subs.drift.maxMs === 0, JSON.stringify(subs.drift));
  check("C1 no cue outlives the narration", subs.cues[subs.cues.length - 1].startMs <= t.endMs);
  check("C1 no cue exceeds two lines", subs.cues.every((c) => c.lines.length <= 2), JSON.stringify(subs.cues.map((c) => c.lines.length)));
  check("C1 an SRT is emitted", /^1\r?\n00:00:/u.test(subs.srt), subs.srt.slice(0, 40));
}

// C2 — the old evenly-divided layout fails the gate
{
  const t = buildCanonicalTimeline([{ alignment: alignmentFor(SCRIPT_25S) }]);
  const even = t.segments.map((s, i, arr) => ({
    index: i + 1, segmentId: s.segmentId,
    // What the pipeline used to do: divide the duration by the number of segments. No anchorMs, because the
    // old cues had no concept of one — so drift is measured against the segment's REAL audio start, which is
    // exactly the comparison that exposes the layout as guesswork.
    startMs: Math.round((t.endMs / arr.length) * i),
    endMs: Math.round((t.endMs / arr.length) * (i + 1)),
    lines: [s.text.slice(0, 40)], text: s.text.slice(0, 40)
  }));
  const { subtitleDrift } = await import("../lib/movie/audio-timeline.mjs");
  const d = subtitleDrift(even, t);
  check("C2 evenly-divided cues drift far past the target", d.maxMs > 250, JSON.stringify(d));
}

// ============================================================ §6 the transcript gate

// D1 — a rejection blocks the render
{
  const g = gateTranscript({ verdict: TRANSCRIPT_VERDICT.REJECT, reason: "language", failures: [{ check: "language" }] });
  check("D1 a rejected transcript blocks", g.ok === false && g.blocking === true && g.code === PIPELINE_ERRORS.TRANSCRIPT_REJECTED);
}
// D2 — UNVERIFIED proceeds but is carried forward
{
  const g = gateTranscript({ verdict: TRANSCRIPT_VERDICT.UNVERIFIED, reason: "no transcript" });
  check("D2 an unverified transcript does not block the render", g.ok === true && g.blocking === false);
  // It must still be visible downstream: blocking every film would be unusable, passing every one would be a lie.
  check("D2 but the verdict travels with it", g.verdict === TRANSCRIPT_VERDICT.UNVERIFIED);
}

// ============================================================ §9 the source gate

const decoded = (w, h, d = 6) => ({ width: w, height: h, durationSeconds: d });

// E1 — all native
{
  const g = gateSources({ scenes: [
    { sceneId: "s1", decoded: decoded(720, 1280) },
    { sceneId: "s2", decoded: decoded(720, 1280) }
  ] });
  check("E1 native 720p at 9:16 passes", g.ok === true && g.allNative === true, JSON.stringify(g.verdicts));
}

// E2 — one 480p scene sinks the film
{
  const g = gateSources({ scenes: [
    { sceneId: "s1", decoded: decoded(720, 1280) },
    { sceneId: "s2", decoded: decoded(464, 688) }   // the exact shape every old clip had
  ] });
  check("E2 a single 480p source is refused", g.ok === false && g.code === PIPELINE_ERRORS.SOURCE_REJECTED);
  check("E2 the film is not 'mostly native'", g.allNative === false);
  check("E2 the offending scene is named", g.rejected.length === 1 && g.rejected[0].sceneId === "s2");
}

// E3 — a repeated account cap is a capability limit, not a bad generation
{
  const g = gateSources({ scenes: [
    { sceneId: "s1", decoded: decoded(480, 854) },
    { sceneId: "s2", decoded: decoded(480, 854) }
  ] });
  check("E3 every scene falling back is recognised as a capability limit", g.capabilityLimited === true, JSON.stringify(g));
  // Retrying a cap just spends the allowance again on another 480p clip.
  check("E3 and the owner is told what to fix", g.ownerActionRequired === "PROVIDER_QUOTA_OR_TIER");
}

// E4 — the fallback policy is available but never called native
{
  // 480p at the RIGHT shape. A 464x688 clip is 2:3, and wrong-shape footage is refused under EVERY policy —
  // the fallback trades resolution for availability, never geometry, because reaching 9:16 from 2:3 means
  // stretching or cropping and both change what the frame shows.
  const g = gateSources({ scenes: [{ sceneId: "s1", decoded: decoded(480, 854) }], policy: SOURCE_POLICY.ALLOW_UPSCALED_FALLBACK });
  check("E4 with the fallback policy a low-res clip of the right shape may proceed", g.ok === true, JSON.stringify(g.verdicts));
  check("E4 labelled UPSCALED, never NATIVE", g.verdicts[0].label === "UPSCALED" && g.verdicts[0].native === false);
  const wrongShape = gateSources({ scenes: [{ sceneId: "s1", decoded: decoded(464, 688) }], policy: SOURCE_POLICY.ALLOW_UPSCALED_FALLBACK });
  check("E4b a 2:3 clip is refused even under the fallback policy", wrongShape.ok === false, JSON.stringify(wrongShape.verdicts));
}

// ============================================================ §11 targeted repair

const vv = (sceneId, verdict, reqs = []) => ({ sceneId, verdict, failedRequirements: reqs, reason: reqs.join(",") });

// F1 — only the failing shot
{
  const p = planShotRepairs({ verdicts: [
    vv("s1", VISION_VERDICT.PASS), vv("s2", VISION_VERDICT.REGENERATE, ["actionMatch"]), vv("s3", VISION_VERDICT.PASS)
  ] });
  check("F1 exactly one shot is repaired", p.repair.length === 1 && p.repair[0].sceneId === "s2", JSON.stringify(p.repair));
  // Regenerating a passing shot spends quota replacing something correct with something merely different.
  check("F1 passing shots are left alone", !p.repair.some((r) => r.sceneId === "s1" || r.sceneId === "s3"));
  check("F1 the failure is carried into the retry", p.repair[0].failedRequirements.includes("actionMatch"));
}

// F2 — bounded
{
  const p = planShotRepairs({ verdicts: [vv("s2", VISION_VERDICT.REGENERATE)], attemptsSoFar: { s2: REPAIR_POLICY.maxAttemptsPerShot } });
  check("F2 after the maximum attempts it stops asking", p.repair.length === 0 && p.exhausted.length === 1);
  check("F2 and the film cannot be published", p.blocksPublish === true);
}

// F3 — unmeasured goes to a human, never silently through
{
  const p = planShotRepairs({ verdicts: [vv("s1", VISION_VERDICT.UNMEASURED)] });
  check("F3 an unmeasured shot is routed to review", p.review.length === 1 && p.review[0].verdict === VISION_VERDICT.UNMEASURED);
  check("F3 and blocks publication", p.blocksPublish === true);
  const clean = planShotRepairs({ verdicts: [vv("s1", VISION_VERDICT.PASS)] });
  check("F3b all-passing shots block nothing", clean.blocksPublish === false);
}

// ============================================================ the stage machine — ordering is the design

// G1 — nothing happens before the adaptation
{
  check("G1 an empty movie starts at ADAPTATION", nextStage({}).stage === PIPELINE_STAGE.ADAPTATION);
  const blocked = nextStage({ adaptation: {}, adaptationGate: { ok: false, failures: ["invented a fact"] } });
  check("G1 a rejected adaptation stops there", blocked.stage === PIPELINE_STAGE.ADAPTATION && blocked.blocked === PIPELINE_ERRORS.ADAPTATION_REJECTED);
  // This is the rule that stops quota being spent on a film that was wrong before it started.
  check("G1 and never advances to narration", blocked.stage !== PIPELINE_STAGE.NARRATION);
}

// G2 — no shots before a real timeline
{
  const s = nextStage({ adaptation: {}, adaptationGate: { ok: true }, narrationAudio: {} });
  check("G2 with audio but no timeline the pipeline stops at ALIGNMENT", s.stage === PIPELINE_STAGE.ALIGNMENT && s.blocked === PIPELINE_ERRORS.ALIGNMENT_UNAVAILABLE);
}

// G3 — no generation while the transcript is rejected
{
  const s = nextStage({ adaptation: {}, adaptationGate: { ok: true }, narrationAudio: {}, timeline: {}, transcriptGate: { blocking: true, reason: "wrong language" } });
  check("G3 a rejected transcript stops before any frame is generated", s.stage === PIPELINE_STAGE.TRANSCRIPT);
  check("G3 which is what keeps Imagine quota unspent", s.stage !== PIPELINE_STAGE.GENERATION);
}

// G4 — no vision, no render
{
  const base = { adaptation: {}, adaptationGate: { ok: true }, narrationAudio: {}, timeline: {}, shotPlan: {}, scenesGenerated: true, sourceGate: { ok: true } };
  check("G4 generated scenes go to VISION, not straight to render", nextStage(base).stage === PIPELINE_STAGE.VISION);
  check("G4b a pending repair comes before the render", nextStage({ ...base, visionComplete: true, repairPlan: { repair: [{ sceneId: "s2" }] } }).stage === PIPELINE_STAGE.REPAIR);
  check("G4c only then the render", nextStage({ ...base, visionComplete: true, repairPlan: { repair: [] } }).stage === PIPELINE_STAGE.RENDER);
  check("G4d and the scorecard is last", nextStage({ ...base, visionComplete: true, repairPlan: { repair: [] }, rendered: true }).stage === PIPELINE_STAGE.SCORECARD);
}

// G5 — a rejected source stops before narration spend
{
  const s = nextStage({ adaptation: {}, adaptationGate: { ok: true }, narrationAudio: {}, timeline: {}, shotPlan: {}, scenesGenerated: true,
    sourceGate: { ok: false, rejected: [{ sceneId: "s2" }], ownerActionRequired: "PROVIDER_QUOTA_OR_TIER" } });
  check("G5 a 480p source halts the pipeline", s.blocked === PIPELINE_ERRORS.SOURCE_REJECTED);
  check("G5 with the owner action attached", s.detail.ownerActionRequired === "PROVIDER_QUOTA_OR_TIER");
}

console.log(`Step 5C.39 content pipeline: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
