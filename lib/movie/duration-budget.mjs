// P0 Step 5C.36 — DURATION BUDGET (pure, deterministic, no ffmpeg, no provider).
//
// The defect this replaces: a movie's target duration was an intention nobody enforced. `durationSeconds`
// was stored on each scene, the provider returned ~6 s clips regardless, and the assembler concatenated
// whatever it was given — so "make me a 10-second movie" produced 18.1 s. The only lever left was trimming
// at the very end, which cuts the narration mid-word: the movie becomes the right LENGTH by becoming the
// wrong THING.
//
// A duration is a budget, and a budget has to be spent before the money is gone. So it is decided here,
// before a single provider call or frame of render:
//
//     target duration
//        -> scene allocation          (weighted by how much each scene has to say, clamped, sums to target)
//        -> narration word/time budget(text shortened at SENTENCE boundaries to fit its slot)
//        -> clip trim plan            (what to take from each source clip)
//        -> subtitle timing           (cues that never outlive their speech or the video)
//        -> audio mix                 (per-scene slots the mixer can fill without truncating anything)
//        -> final render
//
// Three rules are absolute, and each one is a thing the old code got wrong:
//
//   * NEVER cut a sentence. Narration is shortened by dropping whole sentences from the end, never by
//     truncating audio. A half-spoken word is worse than a shorter film.
//   * NEVER speed speech up beyond a natural band. Squeezing text in by talking faster is the same defect
//     wearing a disguise; past a few percent it is audible and it sounds broken.
//   * If the content cannot fit honestly, SAY SO — E_MOVIE_DURATION_BUDGET_UNSATISFIABLE — before anything
//     is spent. A budget that cannot be met is a planning answer, not a render failure.

export const DURATION_ERRORS = Object.freeze({
  UNSATISFIABLE: "E_MOVIE_DURATION_BUDGET_UNSATISFIABLE",
  INVALID: "E_MOVIE_DURATION_BUDGET_INVALID"
});

// Final-cut tolerance. Tight on purpose: the whole point is that the number the owner asked for is the
// number they get.
export const DEFAULT_TOLERANCE_SECONDS = 0.15;
// A scene shorter than this is a flash, not a shot.
export const MIN_SCENE_SECONDS = 1.5;
export const MAX_SCENE_SECONDS = 30;
// Plan narration to this fraction of its slot. Synthesis is an estimate until the voice actually speaks;
// the headroom is what stops a 5 % estimation error from becoming a truncated last word.
export const NARRATION_SAFETY = 0.92;
// How far the speech rate may move from natural. ±6 % is inaudible; beyond that it is the "unnaturally
// fast narration" this module exists to prevent.
export const RATE_MIN = 0.94;
export const RATE_MAX = 1.06;
// When a scene's shortest sentence still will not fit, the only sentence-granular move left is to let that
// shot play SILENT. That is a real editing decision — a held image over music — and it is honest in a way a
// half-spoken word never is. But it is content loss, so it is bounded: silence more than this fraction of
// the film and the budget is declared unsatisfiable instead, because a movie that lost most of its
// narration is not the movie that was asked for.
export const MAX_SILENT_SCENE_RATIO = 1 / 3;
// Breath between sentences, and the tail of silence a cue needs so speech does not collide with the cut.
const SENTENCE_PAUSE_SECONDS = 0.22;
const TAIL_SILENCE_SECONDS = 0.12;

// Natural speaking pace per locale. Two independent estimates (words and characters) are taken and the
// LARGER wins: word counts mislead in Vietnamese (many short words), character counts mislead in German-ish
// compounding, and over-estimating the time speech needs is the safe direction — it shortens text rather
// than overrunning the slot.
const PACE = Object.freeze({
  "en-US": { wps: 2.6, cps: 14.5 },
  "da-DK": { wps: 2.35, cps: 13.0 },
  "sv-SE": { wps: 2.35, cps: 13.0 },
  "bg-BG": { wps: 2.25, cps: 12.0 },
  "vi-VN": { wps: 3.1, cps: 12.5 },
  DEFAULT: { wps: 2.4, cps: 13.0 }
});
export function paceFor(locale) {
  if (typeof locale === "string") {
    if (PACE[locale]) return PACE[locale];
    const lang = locale.slice(0, 2).toLowerCase();
    for (const k of Object.keys(PACE)) if (k !== "DEFAULT" && k.slice(0, 2) === lang) return PACE[k];
  }
  return PACE.DEFAULT;
}

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const round3 = (n) => Number(n.toFixed(3));

/** Split prose into sentences, keeping terminal punctuation. Unicode-safe; never loses a character. */
export function splitSentences(text) {
  const raw = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!raw) return [];
  const out = [];
  const re = /[^.!?…]+(?:[.!?…]+["”»“']?)?/gu;
  let m;
  while ((m = re.exec(raw))) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length ? out : [raw];
}

const wordsOf = (s) => (String(s || "").match(/[\p{L}\p{N}'’-]+/gu) || []).length;
const charsOf = (s) => String(s || "").replace(/\s+/gu, " ").trim().length;

/**
 * How long this text takes to say at a natural pace, including a breath between sentences and a short
 * tail so the last word is not clipped by the cut.
 */
export function estimateSpeechSeconds(text, locale, { rate = 1 } = {}) {
  const sentences = splitSentences(text);
  if (!sentences.length) return 0;
  const p = paceFor(locale);
  const w = wordsOf(text), c = charsOf(text);
  const base = Math.max(w / p.wps, c / p.cps);
  const pauses = Math.max(0, sentences.length - 1) * SENTENCE_PAUSE_SECONDS;
  const r = Math.min(RATE_MAX, Math.max(RATE_MIN, Number(rate) || 1));
  return round3((base + pauses) / r + TAIL_SILENCE_SECONDS);
}

/**
 * Fit narration into a slot WITHOUT cutting a sentence.
 * Drops whole sentences from the end until the remainder fits; then, only if that still overruns, allows
 * the rate to rise inside the natural band. Returns null when even the FIRST sentence cannot fit — the
 * caller turns that into an unsatisfiable budget rather than a truncated line.
 */
export function fitNarration(text, slotSeconds, locale, { safety = NARRATION_SAFETY, allowRate = true } = {}) {
  const sentences = splitSentences(text);
  const budget = slotSeconds * safety;
  if (!sentences.length) return { text: "", seconds: 0, rate: 1, keptSentences: 0, droppedSentences: 0, fits: true };

  for (let keep = sentences.length; keep >= 1; keep -= 1) {
    const candidate = sentences.slice(0, keep).join(" ");
    const natural = estimateSpeechSeconds(candidate, locale, { rate: 1 });
    if (natural <= budget) {
      return { text: candidate, seconds: natural, rate: 1, keptSentences: keep, droppedSentences: sentences.length - keep, fits: true };
    }
    if (allowRate) {
      // Not "make it fit at any cost" — only the small, inaudible band. If the text needs more than that,
      // the honest move is to drop another sentence, which the next iteration does.
      const needed = natural / budget;
      if (needed <= RATE_MAX) {
        const seconds = estimateSpeechSeconds(candidate, locale, { rate: needed });
        if (seconds <= budget + 0.001) {
          return { text: candidate, seconds, rate: round3(needed), keptSentences: keep, droppedSentences: sentences.length - keep, fits: true };
        }
      }
    }
  }
  // Even one sentence overruns its slot. Report what it needs at a NATURAL pace — not at the top of the
  // rate band. A caller that sizes the slot from the rushed figure hands back exactly the slot that only
  // works if the narrator hurries, and the rate band stops being headroom and becomes a requirement.
  const first = sentences[0];
  return { text: null, seconds: estimateSpeechSeconds(first, locale, { rate: 1 }), rate: 1, keptSentences: 0, droppedSentences: sentences.length, fits: false, blockingSentence: first };
}

// Allocate the target across scenes, weighted by how much each has to say, clamped, and normalised so the
// parts sum to the whole. A scene with no narration still gets a floor — it is a shot, not a gap.
function allocate(target, weights, { min, max }) {
  const n = weights.length;
  let alloc = new Array(n).fill(target / n);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight > 0) alloc = weights.map((w) => (w / totalWeight) * target);
  // Clamp, then redistribute the difference across the scenes that still have room. Repeat until stable —
  // at most n passes, because each pass fixes at least one scene permanently.
  for (let pass = 0; pass < n + 2; pass += 1) {
    let debt = 0;
    const flexible = [];
    for (let i = 0; i < n; i += 1) {
      if (alloc[i] < min) { debt += min - alloc[i]; alloc[i] = min; }
      else if (alloc[i] > max) { debt -= alloc[i] - max; alloc[i] = max; }
      else flexible.push(i);
    }
    if (Math.abs(debt) < 1e-6 || flexible.length === 0) break;
    const share = debt / flexible.length;
    for (const i of flexible) alloc[i] -= share;
  }
  return alloc;
}

/**
 * Plan the whole budget.
 *
 * @param {object}   input
 * @param {number}   input.targetDurationSeconds
 * @param {Array}    input.scenes                [{ ordinal, narration, heading }]
 * @param {string}   input.locale
 * @param {Array}    [input.clipDurations]       measured source-clip lengths, or null where unknown
 * @param {number}   [input.tolerance]
 * @returns {object} the plan; throws E_MOVIE_DURATION_BUDGET_UNSATISFIABLE when it cannot be met honestly
 */
export function planDurationBudget({
  targetDurationSeconds, scenes = [], locale = "en-US", clipDurations = null,
  tolerance = DEFAULT_TOLERANCE_SECONDS, minSceneSeconds = MIN_SCENE_SECONDS, maxSceneSeconds = MAX_SCENE_SECONDS,
  safety = NARRATION_SAFETY, allowSilentScenes = true, maxSilentSceneRatio = MAX_SILENT_SCENE_RATIO,
  // Two different kinds of "cannot meet the target", and conflating them is a mistake:
  //   * the NARRATION will not fit  -> something would have to be cut. Always fatal.
  //   * the FOOTAGE will not reach  -> nothing is cut; the film is simply as long as its clips.
  // A render tolerates the second and says so; a strict planning preview can refuse it with requireTarget.
  allowShortfall = true
} = {}) {
  const target = Number(targetDurationSeconds);
  if (!Number.isFinite(target) || target <= 0) throw err(DURATION_ERRORS.INVALID, "a positive target duration is required");
  if (!Array.isArray(scenes) || scenes.length === 0) throw err(DURATION_ERRORS.INVALID, "at least one scene is required");
  const n = scenes.length;
  if (target < minSceneSeconds * n) {
    throw err(DURATION_ERRORS.UNSATISFIABLE,
      `a ${round3(target)}s target cannot hold ${n} scenes at a ${minSceneSeconds}s minimum`,
      { targetSeconds: target, sceneCount: n, minimumPossible: round3(minSceneSeconds * n) });
  }

  const texts = scenes.map((s) => String((s && (s.narration || s.heading)) || "").trim());
  // Weight by the SLOT each scene needs — its natural speech plus the safety headroom — not by the speech
  // alone. Weighting by speech and then demanding speech+headroom is how every scene ends up a few percent
  // short of what it was just told it could have.
  const wants = texts.map((t) => (t ? estimateSpeechSeconds(t, locale) : 0));
  const needs = wants.map((w) => (w > 0 ? w / safety : 0));
  const floorWeight = Math.max(0.5, (needs.reduce((a, b) => a + b, 0) / n) * 0.35);
  const weights = needs.map((w) => (w > 0 ? w : floorWeight));

  // A clip shorter than its slot caps that scene: we cannot invent frames. Cap first, then re-allocate the
  // freed time across the scenes whose clips can still absorb it.
  const caps = scenes.map((_, i) => {
    const d = Array.isArray(clipDurations) ? Number(clipDurations[i]) : NaN;
    return Number.isFinite(d) && d > 0 ? Math.min(d, maxSceneSeconds) : maxSceneSeconds;
  });

  let shortfallSeconds = 0;
  let effectiveTarget = round3(target);
  let alloc = allocate(target, weights, { min: minSceneSeconds, max: maxSceneSeconds });
  for (let pass = 0; pass < n + 2; pass += 1) {
    let freed = 0;
    const absorbers = [];
    for (let i = 0; i < n; i += 1) {
      if (alloc[i] > caps[i]) { freed += alloc[i] - caps[i]; alloc[i] = caps[i]; }
      else if (alloc[i] < caps[i] - 1e-6) absorbers.push(i);
    }
    if (freed < 1e-6) break;
    if (!absorbers.length) {
      const reachable = alloc.reduce((a, b) => a + b, 0);
      if (!allowShortfall) {
        throw err(DURATION_ERRORS.UNSATISFIABLE,
          `the available clips total ${round3(reachable)}s and cannot fill a ${round3(target)}s target`,
          { targetSeconds: target, reachableSeconds: round3(reachable), sceneCount: n });
      }
      // Nothing is being cut here — there is simply less footage than the target asked for. Plan to what
      // exists, and say so, rather than refusing to render a film that is perfectly fine, just shorter.
      shortfallSeconds = round3(target - reachable);
      effectiveTarget = round3(reachable);
      break;
    }
    const share = freed / absorbers.length;
    for (const i of absorbers) alloc[i] = Math.min(caps[i], alloc[i] + share);
  }

  // ---- fit narration into the slots -------------------------------------------------------------
  // Three moves, in order of how much they cost the film:
  //   1. move time from a scene with slack to a scene that is short of it;
  //   2. drop whole sentences from the end (fitNarration does this on its own);
  //   3. let a shot play SILENT, and give its speech time to the scenes that still need it.
  // Cutting a sentence is not on the list, at any point, for any reason.
  const fit = (i, a) => fitNarration(texts[i], a, locale, { safety });
  let fits = alloc.map((_, i) => fit(i, alloc[i]));
  const silenced = new Set();
  // The slot a scene needs to say what it has left to say (a silent scene needs only the floor).
  const requiredSlot = (i) => (silenced.has(i) ? minSceneSeconds : (fits[i].fits ? fits[i].seconds / safety : Infinity));

  for (let round = 0; round < n * 2 + 4; round += 1) {
    const short = [];
    for (let i = 0; i < n; i += 1) if (!silenced.has(i) && !fits[i].fits) short.push(i);
    if (!short.length) break;

    // (1) borrow from whoever has slack above what they need and above the floor.
    let moved = false;
    for (const i of short) {
      const need = (fits[i].seconds / safety) - alloc[i];
      const slack = alloc.map((a, j) => (j === i ? 0 : Math.max(0, Math.min(a - minSceneSeconds, a - requiredSlot(j)))));
      const available = slack.reduce((a, b) => a + b, 0);
      if (available + 1e-6 < need) continue;
      const factor = need / available;
      for (let j = 0; j < n; j += 1) if (j !== i) alloc[j] -= slack[j] * factor;
      alloc[i] = Math.min(caps[i], alloc[i] + need);
      fits = alloc.map((_, k) => (silenced.has(k) ? fits[k] : fit(k, alloc[k])));
      moved = true;
      break;
    }
    if (moved) continue;

    // (3) nobody can lend. Silence the scene whose speech is most expensive — it buys the most time back
    // for the scenes that CAN still be heard — and hand its slot down to the floor.
    if (!allowSilentScenes) {
      const i = short[0];
      throw err(DURATION_ERRORS.UNSATISFIABLE,
        `scene ${i + 1}'s narration needs ${round3(fits[i].seconds)}s and the ${round3(target)}s budget cannot give it that without cutting a sentence`,
        { targetSeconds: round3(target), sceneOrdinal: i, neededSeconds: round3(fits[i].seconds), allocatedSeconds: round3(alloc[i]) });
    }
    const victim = short.slice().sort((a, b) => fits[b].seconds - fits[a].seconds)[0];
    silenced.add(victim);
    fits[victim] = { text: "", seconds: 0, rate: 1, keptSentences: 0, droppedSentences: splitSentences(texts[victim]).length, fits: true, silenced: true };
    const freed = Math.max(0, alloc[victim] - minSceneSeconds);
    if (freed > 1e-6) {
      alloc[victim] = minSceneSeconds;
      const takers = [];
      for (let j = 0; j < n; j += 1) if (j !== victim && !silenced.has(j) && alloc[j] < caps[j] - 1e-6) takers.push(j);
      if (takers.length) {
        const share = freed / takers.length;
        for (const j of takers) alloc[j] = Math.min(caps[j], alloc[j] + share);
      } else {
        alloc[victim] += freed;   // nowhere to put it; the shot simply holds longer
      }
      fits = alloc.map((_, k) => (silenced.has(k) ? fits[k] : fit(k, alloc[k])));
    }
  }
  // Anything still short after every move has been tried cannot be said in this budget.
  for (let i = 0; i < n; i += 1) {
    if (silenced.has(i) || fits[i].fits) continue;
    throw err(DURATION_ERRORS.UNSATISFIABLE,
      `scene ${i + 1}'s narration needs ${round3(fits[i].seconds)}s and the ${round3(target)}s budget cannot give it that without cutting a sentence`,
      { targetSeconds: round3(target), sceneOrdinal: i, neededSeconds: round3(fits[i].seconds), allocatedSeconds: round3(alloc[i]) });
  }
  if (silenced.size > Math.floor(n * maxSilentSceneRatio + 1e-9)) {
    throw err(DURATION_ERRORS.UNSATISFIABLE,
      `${silenced.size} of ${n} scenes would have to play silent to reach ${round3(target)}s; that is no longer the film that was asked for`,
      { targetSeconds: round3(target), sceneCount: n, silentScenes: [...silenced], maxSilentScenes: Math.floor(n * maxSilentSceneRatio + 1e-9) });
  }

  // Normalise so the parts sum to the target exactly (clip caps permitting). Any residue lands on the
  // scene with the most room, so the sum is exact rather than "close".
  const sum0 = alloc.reduce((a, b) => a + b, 0);
  const residue = effectiveTarget - sum0;
  if (Math.abs(residue) > 1e-6) {
    const room = alloc.map((a, i) => (residue > 0 ? caps[i] - a : a - Math.max(minSceneSeconds, fits[i].seconds / safety)));
    const totalRoom = room.reduce((a, b) => a + Math.max(0, b), 0);
    if (totalRoom > 1e-6) {
      for (let i = 0; i < n; i += 1) alloc[i] += residue * (Math.max(0, room[i]) / totalRoom);
    }
  }
  alloc = alloc.map((a) => round3(a));
  const planned = round3(alloc.reduce((a, b) => a + b, 0));
  if (Math.abs(planned - effectiveTarget) > tolerance) {
    throw err(DURATION_ERRORS.UNSATISFIABLE,
      `the plan totals ${planned}s against a ${effectiveTarget}s target, outside the ${tolerance}s tolerance`,
      { targetSeconds: round3(target), plannedSeconds: planned, toleranceSeconds: tolerance });
  }

  // Timeline: trims, cues, and the audio slots the mixer will fill.
  let cursor = 0;
  const out = [];
  const warnings = [];
  if (shortfallSeconds > tolerance) warnings.push(`the available clips total ${effectiveTarget}s, ${shortfallSeconds}s short of the ${round3(target)}s target`);
  for (let i = 0; i < n; i += 1) {
    const f = fits[i];
    const clip = Array.isArray(clipDurations) ? Number(clipDurations[i]) : NaN;
    const haveClip = Number.isFinite(clip) && clip > 0;
    const trimOut = haveClip ? round3(Math.min(clip, alloc[i])) : round3(alloc[i]);
    if (haveClip && clip + 1e-6 < alloc[i]) warnings.push(`scene ${i + 1}: the clip is ${round3(clip)}s for a ${alloc[i]}s slot`);
    // A clip that caps the scene BELOW what its narration needed is the reason that scene lost its line;
    // saying only "plays silent" would hide the actual cause from whoever has to fix it.
    else if (haveClip && wants[i] > 0 && clip + 1e-6 < wants[i] / safety) {
      warnings.push(`scene ${i + 1}: the clip is only ${round3(clip)}s and its narration needs ${round3(wants[i] / safety)}s`);
    }
    if (f.silenced) warnings.push(`scene ${i + 1}: plays silent — its narration does not fit ${round3(target)}s and would have had to be cut mid-sentence`);
    else if (f.droppedSentences > 0) warnings.push(`scene ${i + 1}: ${f.droppedSentences} sentence(s) dropped to fit the budget`);
    if (f.rate > 1.001) warnings.push(`scene ${i + 1}: narration paced ${Math.round((f.rate - 1) * 100)}% faster (within the natural band)`);
    // A cue lasts as long as the speech, never longer than the slot, and never past the end of the film.
    const cueEnd = round3(Math.min(cursor + alloc[i], cursor + Math.max(f.seconds, Math.min(alloc[i], 1.2))));
    out.push(Object.freeze({
      ordinal: scenes[i].ordinal ?? i,
      allocatedSeconds: alloc[i],
      narrationText: f.text ?? "",
      narrationSourceText: texts[i],
      estimatedNarrationSeconds: round3(f.seconds),
      narrationRate: f.rate,
      keptSentences: f.keptSentences,
      droppedSentences: f.droppedSentences,
      silent: f.silenced === true,
      trimIn: 0,
      trimOut,
      clipSeconds: haveClip ? round3(clip) : null,
      subtitleStartSeconds: round3(cursor),
      subtitleEndSeconds: cueEnd
    }));
    cursor = round3(cursor + alloc[i]);
  }

  return Object.freeze({
    ok: true,
    locale,
    targetSeconds: round3(target),
    effectiveTargetSeconds: effectiveTarget,
    shortfallSeconds,
    reachedTarget: shortfallSeconds <= tolerance,
    plannedSeconds: planned,
    toleranceSeconds: tolerance,
    safety,
    sceneCount: n,
    silentSceneCount: silenced.size,
    scenes: Object.freeze(out),
    warnings: Object.freeze(warnings),
    estimatedNarrationSeconds: round3(out.reduce((a, s) => a + s.estimatedNarrationSeconds, 0))
  });
}

/**
 * The render-time check the plan cannot make: real narration audio has a real length. If it overruns its
 * slot by more than the headroom, the honest answer is to refuse — truncating is how a movie ends up with
 * a half-spoken word.
 */
export function verifyAgainstMeasured(plan, measuredNarrationSeconds = []) {
  const problems = [];
  for (let i = 0; i < plan.scenes.length; i += 1) {
    const measured = Number(measuredNarrationSeconds[i]);
    if (!Number.isFinite(measured) || measured <= 0) continue;
    const slot = plan.scenes[i].allocatedSeconds;
    if (measured > slot + 1e-6) {
      problems.push({ ordinal: plan.scenes[i].ordinal, measuredSeconds: round3(measured), allocatedSeconds: slot });
    }
  }
  if (problems.length) {
    throw err(DURATION_ERRORS.UNSATISFIABLE,
      `${problems.length} scene(s) have narration longer than their slot; the film would have to cut a sentence`,
      { problems });
  }
  return true;
}

/** Build SRT text straight from the plan, so cues can never disagree with the film. */
export function subtitlesFromPlan(plan) {
  const p = (nn, w = 2) => String(nn).padStart(w, "0");
  const fmt = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
  };
  let out = "", n = 0;
  for (const s of plan.scenes) {
    const text = String(s.narrationText || "").trim();
    if (!text) continue;
    n += 1;
    out += `${n}\n${fmt(s.subtitleStartSeconds)} --> ${fmt(s.subtitleEndSeconds)}\n${text.slice(0, 300)}\n\n`;
  }
  return out;
}
