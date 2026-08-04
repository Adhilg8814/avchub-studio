// P0 Step 5C.16 — Story Content Factory control plane (facade).
//
// The durable, staged pipeline that turns Country/Locale + a Content Brand Profile + an Archetype into
// a validated, original long-form story + package. It sits BEFORE the certified Movie Factory and never
// touches it except through a story_movie_links row created by an explicit, separately-authorized
// movie-adaptation action (which only plans a dynamic storyboard — it NEVER submits a Grok Imagine
// video or spends video quota). Text stages reuse the injected Grok Chat actuator (non-video); each
// stage is a durable, idempotent, exactly-once story_generation_attempts row. PostgreSQL is the source
// of truth; restart-safety comes from resuming off the project's current_* pointers.

import { storyRepository as repo } from "../persistence/repositories/story-repository.mjs";
import { asGate } from "../../../lib/protocol/generation-execution-gate.mjs";
import { validateContentBrandProfile, SEED_BRAND_PROFILES, resolveWordRange } from "../../../lib/story/content-brand-profile.mjs";
import { resolveLengthTarget, planSectionCount } from "../../../lib/story/length-presets.mjs";
import { computeStoryMetrics, lengthGate, fillerScore, DEFAULT_LENGTH_GATE_THRESHOLDS } from "../../../lib/story/story-metrics.mjs";
import { entitiesFromDna, repairTargets, dominantLocale, REPETITION_BAND } from "../../../lib/story/repetition-detector.mjs";
import { SEED_ARCHETYPES, selectArchetype, validateArchetype } from "../../../lib/story/archetype-library.mjs";
import { validateStoryDNA, dnaChecksum, currencyForLocale } from "../../../lib/story/story-dna.mjs";
import { validateOutline, analyzeStoryArc } from "../../../lib/story/story-structure.mjs";
import { buildFingerprint, assessNovelty, DEFAULT_NOVELTY_THRESHOLDS } from "../../../lib/story/novelty.mjs";
import { validateDnaLogic, checkStoryContinuity, dnaCoverage } from "../../../lib/story/logic-continuity.mjs";
import { computeScorecard, DEFAULT_QUALITY_THRESHOLDS } from "../../../lib/story/quality-scorecard.mjs";
import { rankTitleCandidates, buildTitlePrompt, parseTitleCandidates } from "../../../lib/story/title-engine.mjs";
import { deriveTitle } from "../../../lib/story/deterministic-title.mjs";
import { createHash } from "node:crypto";
import {
  buildDnaPrompt, parseDnaResponse, buildOutlinePrompt, parseOutlineResponse,
  buildStoryPrompt, parseStoryResponseText, buildEditPrompt, buildMetadataPrompt, parseMetadataResponse,
  buildQualityRepairPrompt,
  buildQualityPrompt, parseQualityResponse, stagePromptHash,
  buildActPlanPrompt, parseActPlanResponse, buildSectionPlanPrompt, parseSectionPlanResponse,
  buildSectionPrompt, parseSectionResponse, buildSectionExpandPrompt
} from "../../../lib/story/story-text-stages.mjs";

function cpErr(code, message) { return Object.assign(new Error(message), { code }); }
const STP = /^stp_[0-9A-HJKMNP-TV-Z]{26}$/u;
const MAX_DNA_NOVELTY_RETRIES = 3;
// A quality repair is bounded HARD. Two targeted attempts is the whole budget: the first is usually free
// (a re-evaluation with the corrected detector spends nothing), the second is one provider call. Past that
// the story goes to a human rather than burning quota on a model that is not converging.
const MAX_QUALITY_REPAIRS = 2;
// Statuses a repair may start from. READY is excluded (nothing to repair); DRAFT and the *_GENERATING
// states are excluded (nothing produced yet). FAILED_GENERATION is included ONLY because of the historical
// rows this shipped to fix — a project with prose that was mislabelled a generation failure. The guard is
// not the status, it is `currentTextId`: no output, no repair.
const REPAIRABLE_STATUSES = new Set(["QUALITY_REPAIR_REQUIRED", "FAILED_VALIDATION", "FAILED_GENERATION", "NEEDS_REVIEW", "QUALITY_REPAIRING", "WAITING_REPAIR_COOLDOWN"]);
// Statuses the AUTO scheduler may pick up. Narrower than the manual set on purpose: a human may ask for a
// repair on anything repairable, but unattended work only ever starts from the state that explicitly says
// "output exists, quality declined" — or from a state this scheduler itself left behind.
const AUTO_REPAIRABLE_STATUSES = new Set(["QUALITY_REPAIR_REQUIRED", "WAITING_REPAIR_COOLDOWN", "QUALITY_REPAIRING"]);
// The unit of work: this story, this draft revision, this attempt. Same three facts -> same key -> the
// UNIQUE index refuses to let it start twice, whatever restarted or retried.
const idempotencyKeyFor = (projectId, revision, attempt) =>
  createHash("sha256").update(`${projectId}|${revision}|${attempt}`).digest("hex");

// The durable, human-readable verdict stored on the project and in the repair ledger. It carries the score,
// the band, the confidence, the explanation and the offending spans WITH their offsets, so a reviewer can
// see exactly what the detector objected to instead of a bare error code.
function qualityVerdictOf(gate, metrics) {
  const rep = metrics && metrics.repetition ? metrics.repetition : null;
  return {
    at: new Date().toISOString(),
    gateState: gate.state,
    // Whether the gate PASSED, recorded explicitly. The state string alone is ambiguous: ABOVE_MAX_SOFT is
    // a passing state whose name does not say so, and reading pass/fail out of a name is how a story that
    // was merely long got treated as one a machine must not touch.
    gatePass: gate.pass === true,
    reasons: gate.reasons.slice(0, 5),
    repairable: gate.repairable === true,
    wordCount: metrics ? metrics.actualWordCount : null,
    repetition: rep ? {
      locale: rep.locale, score: rep.score, band: rep.band, confidence: rep.confidence,
      explanation: rep.explanation, classes: rep.classes, bands: rep.bands,
      spans: rep.countedSpans.slice(0, 12).map((x) => ({ text: x.text.slice(0, 160), count: x.count, class: x.class, offsets: x.offsets.slice(0, 8) }))
    } : null
  };
}

// Guardrails a repaired draft must clear before it is allowed to REPLACE the current text. A repair that
// drifts is worse than the repetition it fixed, so a draft that changes language, loses a character, loses
// length or breaks continuity is rejected and the original stays current.
function repairIsAcceptable({ original, repaired, dna, locale, continuityBefore, continuityAfter, scoreBefore, scoreAfter, wordsMin }) {
  const problems = [];
  const w0 = original.wordCount, w1 = repaired.wordCount;
  // Language check. A script comparison catches Bulgarian rewritten in Latin, but Danish rewritten in
  // English is Latin either way — so the real test is function words, which almost no two languages share.
  // The bar is relative to the ORIGINAL rather than absolute: locales differ in how function-word-heavy
  // they are, and the question is only whether this text is still the same language as that one.
  const scriptCyrillic = (t) => {
    const letters = (t.match(/\p{L}/gu) || []);
    if (!letters.length) return 0;
    return letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length / letters.length;
  };
  if (Math.abs(scriptCyrillic(original.storyText) - scriptCyrillic(repaired.storyText)) > 0.25) problems.push("E_REPAIR_LOCALE_DRIFT");
  const l0 = dominantLocale(original.storyText), l1 = dominantLocale(repaired.storyText);
  if (l0.density > 0.05 && l1.locale !== l0.locale) problems.push(`E_REPAIR_LOCALE_DRIFT:${l0.locale}->${l1.locale}`);
  // Characters must survive verbatim.
  const names = [dna?.protagonist, ...(Array.isArray(dna?.antagonistList) ? dna.antagonistList.map((x) => x.name) : [])].filter((x) => typeof x === "string" && x.length > 1);
  for (const nm of names) if (original.storyText.includes(nm) && !repaired.storyText.includes(nm)) problems.push(`E_REPAIR_LOST_CHARACTER:${nm.slice(0, 32)}`);
  // Length last: a translated or gutted draft should be named for what it actually did, not for its size.
  if (w1 < Math.round(w0 * 0.85)) problems.push(`E_REPAIR_SHORTENED:${w1}<${Math.round(w0 * 0.85)}`);
  if (w1 > Math.round(w0 * 1.20)) problems.push(`E_REPAIR_INFLATED:${w1}>${Math.round(w0 * 1.20)}`);
  if (wordsMin && w1 < wordsMin) problems.push(`E_REPAIR_BELOW_MIN:${w1}<${wordsMin}`);
  // Continuity must not get worse (frozen facts, quoted line, evidence-before-reversal ordering).
  if (continuityBefore.pass && !continuityAfter.pass) problems.push(`E_REPAIR_CONTINUITY_BROKEN:${(continuityAfter.violations || [])[0] || "?"}`);
  // And the repair has to actually repair something.
  if (!(scoreAfter < scoreBefore)) problems.push(`E_REPAIR_NO_IMPROVEMENT:${scoreAfter}>=${scoreBefore}`);
  return { ok: problems.length === 0, problems, locale };
}

export function createStoryFactoryControlPlane({ persistence, config, chatActuator = null, chatConversationFactory = null, movie = null, ensureBootstrap = null, now = () => Date.now(), noveltyThresholds = DEFAULT_NOVELTY_THRESHOLDS, qualityThresholds = DEFAULT_QUALITY_THRESHOLDS, lengthGateThresholds = DEFAULT_LENGTH_GATE_THRESHOLDS, executionGate = null } = {}) {
  // P0 Step 5C.29 Phase 0 — maintenance pause: the staged story pipeline and the movie adaptation both reach
  // the GROK CHAT provider, so they refuse while generation is paused. Reads/list/archive stay available.
  const execGate = asGate(executionGate);
  if (!persistence || typeof persistence.tenantTransaction !== "function") throw new TypeError("createStoryFactoryControlPlane requires a persistence adapter");
  const ws = config?.stagingApi?.workspaceId;
  if (typeof ws !== "string" || !/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(ws)) throw cpErr("E_STORY_WORKSPACE", "A configured staging workspace is required");
  const tx = (fn, opts) => persistence.tenantTransaction(ws, fn, opts);
  const chatAvailable = typeof chatActuator === "function";

  async function boot() { if (typeof ensureBootstrap === "function") await ensureBootstrap(); }

  // ---- seeds (idempotent) ----
  async function ensureSeeds() {
    await boot();
    return tx(async (client) => {
      const profiles = [];
      for (const p of SEED_BRAND_PROFILES) profiles.push(await repo.upsertSeedBrandProfile(client, ws, { ...p, seedKey: `seed:${p.locale}` }));
      const archetypes = [];
      for (const a of SEED_ARCHETYPES) archetypes.push(await repo.upsertSeedArchetype(client, ws, a));
      return { profiles: profiles.length, archetypes: archetypes.length };
    });
  }
  async function listBrandProfiles() { await ensureSeeds(); return tx((c) => repo.listBrandProfiles(c, ws)); }
  async function listArchetypes() { await ensureSeeds(); return tx((c) => repo.listArchetypes(c, ws)); }
  async function createBrandProfile(input) {
    await boot();
    const p = validateContentBrandProfile(input);
    return tx((c) => repo.insertBrandProfile(c, ws, p));
  }
  async function updateBrandProfile(id, patch, expectedRevision = null) {
    // validate the merged view to reject unsafe text before persisting
    const cur = await tx((c) => repo.getBrandProfile(c, ws, id));
    if (!cur) throw cpErr("E_BRAND_NOT_FOUND", "profile not found");
    validateContentBrandProfile({ ...cur, ...patch, id: cur.id, locale: cur.locale });
    return tx((c) => repo.updateBrandProfile(c, ws, id, { patch, expectedRevision }));
  }

  // ---- projects ----
  async function createProject(input = {}) {
    await ensureSeeds();
    const locale = String(input.locale || "").trim();
    if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) throw cpErr("E_STORY_LOCALE", "a valid locale (e.g. bg-BG) is required");
    return tx(async (client) => {
      const profiles = await repo.listBrandProfiles(client, ws);
      let brand = input.brandProfileId ? profiles.find((p) => p.id === input.brandProfileId) : profiles.find((p) => p.locale === locale);
      if (!brand) throw cpErr("E_STORY_NO_BRAND", "no content brand profile for this locale");
      const lengthPreset = ["SHORT", "STANDARD", "LONG", "CUSTOM"].includes(input.lengthPreset) ? input.lengthPreset : "STANDARD";
      const customReadingMinutes = lengthPreset === "CUSTOM" && Array.isArray(input.customReadingMinutes) ? input.customReadingMinutes.slice(0, 2).map((n) => Math.max(3, Math.min(45, Math.round(Number(n) || 10)))) : null;
      const lengthTarget = resolveLengthTarget({ preset: lengthPreset, locale, profile: brand, customReadingMinutes });
      const project = await repo.insertProject(client, ws, {
        brandProfileId: brand.id, archetypeId: input.archetypeId && input.archetypeId !== "AUTO" ? input.archetypeId : null,
        country: input.country || brand.country, locale, language: brand.language,
        targetAudience: input.targetAudience || brand.audience, targetLength: input.targetLength || "medium",
        dramaIntensity: Number.isFinite(input.dramaIntensity) ? Math.max(1, Math.min(5, Math.round(input.dramaIntensity))) : brand.dramaIntensity,
        realismLevel: input.realismLevel || brand.realismLevel, seedIdea: input.seedIdea ? String(input.seedIdea).slice(0, 600) : null,
        lengthPreset, customReadingMinutes, lengthTarget
      });
      await repo.appendEvent(client, ws, project.id, { type: "STORY_PROJECT_CREATED", detail: { locale, brandProfileId: brand.id } });
      return project;
    });
  }
  async function listProjects() { return tx((c) => repo.listProjects(c, ws)); }

  async function getProjectView(id) {
    return tx(async (client) => {
      const project = await repo.getProject(client, ws, id);
      if (!project) return null;
      const [dna, outline, text, quality, fingerprint, pkg, titles, events, attempts, links] = await Promise.all([
        project.currentDnaId ? repo.getDnaVersion(client, ws, project.currentDnaId) : null,
        project.currentOutlineId ? repo.getOutlineVersion(client, ws, project.currentOutlineId) : null,
        project.currentTextId ? repo.getTextVersion(client, ws, project.currentTextId) : null,
        project.currentQualityId ? repo.getQualityReport(client, ws, project.currentQualityId) : null,
        project.currentFingerprintId ? repo.getFingerprint(client, ws, project.currentFingerprintId) : null,
        project.currentPackageId ? repo.getPackage(client, ws, project.currentPackageId) : null,
        repo.listTitleCandidates(client, ws, id), repo.listEvents(client, ws, id, { limit: 60 }),
        repo.listGenerationAttempts(client, ws, id, { limit: 60 }), repo.listMovieLinks(client, ws, id)
      ]);
      return Object.freeze({ project, dna, outline, text, quality, novelty: fingerprint, package: pkg, titles, events, attempts, movieLinks: links });
    });
  }

  // ---- a single durable chat stage (exactly-once) ----
  async function runChatStage({ projectId, stage, prompt, chat = null }) {
    // A multi-turn conversation (chat.turn), if supplied, runs every stage as a turn in ONE held browser
    // session; otherwise each stage opens its own per-turn actuator. Both honour exactly-once (onBeforeSubmit).
    const turn = chat && typeof chat.turn === "function" ? chat.turn : chatActuator;
    if (typeof turn !== "function") throw cpErr("E_STORY_TEXT_PROVIDER_UNAVAILABLE", "Grok Chat is not available on this runtime");
    const promptHash = stagePromptHash(prompt);
    const attempt = await tx(async (client) => {
      const a = await repo.insertGenerationAttempt(client, ws, { storyProjectId: projectId, stage, provider: "GROK_CHAT", promptHash });
      await repo.reserveInvocation(client, ws, a.id);
      await repo.updateGenerationAttempt(client, ws, a.id, { patch: { state: "RUNNING" } });
      await repo.appendEvent(client, ws, projectId, { type: "STORY_STAGE_STARTED", detail: { stage } });
      return a;
    });
    const onBeforeSubmit = async () => { await tx(async (client) => { await repo.updateGenerationAttempt(client, ws, attempt.id, { patch: { submitState: "SUBMITTED" } }); await repo.consumeInvocation(client, ws, attempt.id); }); };
    let out;
    try {
      out = await turn({ prompt, onBeforeSubmit });
      if (!out || typeof out.text !== "string" || !out.text.trim()) throw cpErr("E_STORY_STAGE_EMPTY", "provider returned no text");
    } catch (e) {
      const row = await tx((c) => repo.getGenerationAttempt(c, ws, attempt.id));
      const submitted = Boolean(row && row.submitState === "SUBMITTED") || e.submitted === true;
      await tx(async (client) => {
        await repo.updateGenerationAttempt(client, ws, attempt.id, { patch: submitted ? { state: "UNCERTAIN", submitState: "UNCERTAIN", errorCode: e.code || "E_STORY_STAGE_UNCERTAIN" } : { state: "FAILED", errorCode: e.code || "E_STORY_STAGE_FAILED" } });
        await repo.appendEvent(client, ws, projectId, { type: submitted ? "STORY_STAGE_UNCERTAIN" : "STORY_STAGE_FAILED", detail: { stage, code: e.code || null } });
      });
      throw cpErr(e.code || "E_STORY_STAGE_FAILED", submitted ? "The story stage outcome is uncertain; it will NOT be retried automatically" : (e.message || "story stage failed"));
    }
    const ref = typeof out.responseId === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(out.responseId) ? out.responseId : null;
    // Diagnostic: overwrite a single file with the most recent stage's raw response (story text, not a
    // secret). If a downstream parse throws, this holds the exact block the parser rejected. Best effort.
    if (config && config.stageResponseDebugPath) {
      try {
        const fs = await import("node:fs");
        fs.writeFileSync(config.stageResponseDebugPath, JSON.stringify({ stage, len: out.text.length, text: out.text }, null, 2));
      } catch { /* diagnostics must never affect the pipeline */ }
    }
    await tx(async (client) => { await repo.updateGenerationAttempt(client, ws, attempt.id, { patch: { state: "COMPLETED", submitState: "SUBMITTED", responseHash: stagePromptHash(out.text), providerResultRef: ref } }); });
    return { attemptId: attempt.id, text: out.text, responseId: ref };
  }

  async function setStatus(projectId, status, extra = {}) { await tx((c) => repo.updateProject(c, ws, projectId, { patch: { status, ...extra } })); }

  // ---- the staged pipeline (resumable off current_* pointers) ----
  // Set by any branch that has already recorded the accurate terminal state for this run, so the catch
  // handler below never overwrites a considered verdict with a generic one.
  async function generateStory(projectId, { force = false } = {}) {
    let statusDecided = false;
    execGate.assertRunning("generateStory");
    if (!STP.test(projectId || "")) throw cpErr("E_STORY_NOT_FOUND", "invalid project id");
    let project = await tx((c) => repo.getProject(c, ws, projectId));
    if (!project) throw cpErr("E_STORY_NOT_FOUND", "project not found");
    if (project.status === "READY" && !force) return getProjectView(projectId);
    const brand = await tx((c) => repo.getBrandProfile(c, ws, project.brandProfileId));
    if (!brand) throw cpErr("E_STORY_NO_BRAND", "brand profile missing");
    const archetypes = await tx((c) => repo.listArchetypes(c, ws));
    const locale = project.locale;
    const lengthTarget = project.lengthTarget || resolveLengthTarget({ preset: project.lengthPreset || "STANDARD", locale, profile: brand, customReadingMinutes: project.customReadingMinutes });
    const MAX_SECTION_EXPANDS = 3;

    // Long-form runs ~11 chat stages; open ONE held conversation (one browser + one lease) for the whole
    // story rather than re-opening the provider per stage (which proved fragile past ~3 fresh sessions). If the
    // open fails, conv stays null and runChatStage falls back to the per-stage actuator.
    let conv = null;
    if (typeof chatConversationFactory === "function") {
      try {
        const c = await chatConversationFactory();
        if (c && c.ok === true && typeof c.turn === "function") conv = c;
        else if (c && typeof c.close === "function") { try { await c.close(); } catch { /* */ } }
      } catch { conv = null; }
    }

    try {
      // ---- Stage 1+2: DNA (with novelty pre-check + bounded regeneration) + logic validation ----
      let dnaId = force ? null : project.currentDnaId;
      let dna, chosenArchetype = null;
      if (!dnaId) {
        await setStatus(projectId, "DNA_GENERATING");
        const existing = await tx((c) => repo.listAcceptedFingerprints(c, ws, { excludeProjectId: projectId }));
        let accepted = null, lastNovelty = null;
        for (let attempt = 0; attempt <= MAX_DNA_NOVELTY_RETRIES; attempt += 1) {
          chosenArchetype = selectArchetype({ archetypes, profile: brand, locale, requestedId: project.archetypeId, seed: `${projectId}:${attempt}` });
          const noveltyAvoid = lastNovelty ? lastNovelty.nearest.map((n) => `${n.title || n.storyProjectId}`) : [];
          const prompt = buildDnaPrompt({ profile: brand, archetype: chosenArchetype, locale, seedIdea: project.seedIdea || "", noveltyAvoid });
          const stageOut = await runChatStage({ projectId, chat: conv, stage: "DNA", prompt });
          let candidateDna;
          try { candidateDna = parseDnaResponse(stageOut.text, { locale }); }
          catch (e) { if (attempt === MAX_DNA_NOVELTY_RETRIES) throw e; continue; }
          const fp = buildFingerprint({ originalityDimensions: candidateDna.originalityDimensions, title: "", storyText: "", outlineBeats: [] });
          const nv = assessNovelty({ candidate: fp, existing, thresholds: noveltyThresholds });
          lastNovelty = nv;
          if (nv.pass || !nv.nearest.some((n) => n.structuralDuplicate)) { accepted = candidateDna; break; }
          await tx((c) => repo.appendEvent(c, ws, projectId, { type: "STORY_DNA_NOVELTY_RETRY", detail: { attempt, reason: nv.reason } }));
          if (attempt === MAX_DNA_NOVELTY_RETRIES) { statusDecided = true; await setStatus(projectId, "FAILED_VALIDATION", { errorCode: "E_NOVELTY_STRUCTURAL_DUPLICATE" }); throw cpErr("E_NOVELTY_STRUCTURAL_DUPLICATE", "could not produce a novel Story DNA"); }
        }
        dna = accepted;
        const logic = validateDnaLogic(dna);
        if (!logic.pass) { statusDecided = true; await tx(async (c) => { await repo.insertDnaVersion(c, ws, { storyProjectId: projectId, archetypeId: chosenArchetype.id, dna, checksum: dnaChecksum(dna), logicReport: logic }); }); await setStatus(projectId, "FAILED_VALIDATION", { errorCode: logic.errors[0] || "E_LOGIC_INVALID" }); throw cpErr(logic.errors[0] || "E_LOGIC_INVALID", "Story DNA failed logic validation"); }
        const saved = await tx(async (c) => { const v = await repo.insertDnaVersion(c, ws, { storyProjectId: projectId, archetypeId: chosenArchetype.id, dna, checksum: dnaChecksum(dna), logicReport: logic }); await repo.updateProject(c, ws, projectId, { patch: { currentDnaId: v.id, archetypeId: chosenArchetype.id, status: "DNA_VALIDATING" } }); await repo.appendEvent(c, ws, projectId, { type: "STORY_DNA_READY", detail: { archetype: chosenArchetype.id, checksum: v.checksum } }); return v; });
        dnaId = saved.id;
      } else {
        dna = (await tx((c) => repo.getDnaVersion(c, ws, dnaId))).dna;
      }

      // ---- Stage 3: outline ----
      let outlineId = force ? null : project.currentOutlineId;
      let outline;
      if (!outlineId) {
        const stageOut = await runChatStage({ projectId, chat: conv, stage: "OUTLINE", prompt: buildOutlinePrompt({ dna, profile: brand }) });
        outline = parseOutlineResponse(stageOut.text);
        const saved = await tx(async (c) => { const v = await repo.insertOutlineVersion(c, ws, { storyProjectId: projectId, dnaId, outline }); await repo.updateProject(c, ws, projectId, { patch: { currentOutlineId: v.id, status: "WRITING" } }); return v; });
        outlineId = saved.id;
      } else { outline = (await tx((c) => repo.getOutlineVersion(c, ws, outlineId))).outline; outline = validateOutline(outline); }

      // ---- Long-form: ACT PLAN + SECTION PLAN (persisted on the project) ----
      let storyPlan = force ? null : project.storyPlan;
      if (!storyPlan || !Array.isArray(storyPlan.sections) || !storyPlan.sections.length) {
        await setStatus(projectId, "WRITING");
        const actCount = lengthTarget.preset === "LONG" ? 4 : 3;
        const actOut = await runChatStage({ projectId, chat: conv, stage: "ACT_PLAN", prompt: buildActPlanPrompt({ dna, profile: brand, target: lengthTarget, actCount }) });
        const actPlan = parseActPlanResponse(actOut.text);
        const sectionCount = planSectionCount(lengthTarget);
        const secOut = await runChatStage({ projectId, chat: conv, stage: "SECTION_PLAN", prompt: buildSectionPlanPrompt({ dna, outline, actPlan, profile: brand, target: lengthTarget, sectionCount }) });
        const sectionPlan = parseSectionPlanResponse(secOut.text, { sectionCount, target: lengthTarget });
        storyPlan = { acts: actPlan.acts, sections: sectionPlan.sections.map((s) => ({ ...s, text: null, wordCount: 0, state: "PLANNED", attemptId: null, expandCount: 0 })) };
        await tx((c) => repo.updateProject(c, ws, projectId, { patch: { storyPlan, lengthTarget, status: "WRITING" } }));
      }

      // ---- Long-form: write each PLANNED section (durable, resumable, exactly-once per section) ----
      let sections = storyPlan.sections.map((s) => ({ ...s }));
      const sectionPlanRef = { sections: storyPlan.sections };
      for (let i = 0; i < sections.length; i += 1) {
        if (sections[i].state === "COMPLETED" && sections[i].text) continue;
        const priorContext = sections.slice(0, i).filter((s) => s.text).map((s) => s.text).join("\n\n");
        const out = await runChatStage({ projectId, chat: conv, stage: "SECTION", prompt: buildSectionPrompt({ dna, section: sections[i], sectionPlan: sectionPlanRef, profile: brand, priorContext, isFirst: i === 0, isLast: i === sections.length - 1 }) });
        const parsed = parseSectionResponse(out.text);
        sections[i] = { ...sections[i], text: parsed.section, wordCount: parsed.wordCount, state: "COMPLETED", attemptId: out.attemptId };
        await tx((c) => repo.updateProject(c, ws, projectId, { patch: { storyPlan: { ...storyPlan, sections } } }));
      }

      // ---- Long-form: assemble + length gate + bounded targeted EXPANSION ----
      const assemble = () => sections.map((s) => s.text).filter(Boolean).join("\n\n");
      const dnaEntities = entitiesFromDna(dna);
      let metrics = computeStoryMetrics(assemble(), { locale, profile: brand, characterNames: dnaEntities });
      let gate = lengthGate(metrics, lengthTarget, lengthGateThresholds);
      let expandLoops = 0;
      while (gate.state === "BELOW_MIN" && expandLoops < sections.length * MAX_SECTION_EXPANDS) {
        // expand the thinnest section that still has expansion budget
        const cand = sections.map((s, idx) => ({ idx, s })).filter((x) => x.s.expandCount < MAX_SECTION_EXPANDS).sort((a, b) => a.s.wordCount - b.s.wordCount)[0];
        if (!cand) break;
        const deficit = Math.max(120, Math.round((lengthTarget.idealMin - metrics.actualWordCount) / Math.max(1, sections.filter((s) => s.expandCount < MAX_SECTION_EXPANDS).length)));
        const out = await runChatStage({ projectId, chat: conv, stage: "EXPAND", prompt: buildSectionExpandPrompt({ dna, section: cand.s, sectionText: cand.s.text, profile: brand, deficitWords: deficit }) });
        let expanded; try { expanded = parseSectionResponse(out.text); } catch { expanded = null; }
        if (expanded && expanded.wordCount > cand.s.wordCount) sections[cand.idx] = { ...cand.s, text: expanded.section, wordCount: expanded.wordCount, expandCount: cand.s.expandCount + 1 };
        else sections[cand.idx] = { ...cand.s, expandCount: cand.s.expandCount + 1 };
        await tx((c) => repo.updateProject(c, ws, projectId, { patch: { storyPlan: { ...storyPlan, sections } } }));
        metrics = computeStoryMetrics(assemble(), { locale, profile: brand, characterNames: dnaEntities });
        gate = lengthGate(metrics, lengthTarget, lengthGateThresholds);
        expandLoops += 1;
      }

      await setStatus(projectId, "VALIDATING");
      const fullStory = assemble();
      metrics = computeStoryMetrics(fullStory, { locale, profile: brand, characterNames: dnaEntities });
      gate = lengthGate(metrics, lengthTarget, lengthGateThresholds);
      const continuity = checkStoryContinuity(fullStory, dna, { locale });
      const text = await tx(async (c) => {
        const v = await repo.insertTextVersion(c, ws, { storyProjectId: projectId, dnaId, outlineId, storyText: fullStory, wordCount: metrics.actualWordCount, edited: true, continuityReport: { ...continuity, coverage: dnaCoverage(fullStory, dna) } });
        await repo.updateProject(c, ws, projectId, { patch: { currentTextId: v.id, wordCount: metrics.actualWordCount, metrics, lengthGateState: gate.state, storyPlan: { ...storyPlan, sections } } });
        await repo.appendEvent(c, ws, projectId, { type: "STORY_TEXT_READY", detail: { wordCount: metrics.actualWordCount, sections: sections.length, lengthGate: gate.state, continuityPass: continuity.pass } });
        return v;
      });
      const textId = text.id;

      // ---- quality gate ----
      // The prose above is already persisted. A gate failure here therefore says "this output needs work",
      // NOT "generation failed" — the distinction the recovery path depends on. Usable output goes to
      // QUALITY_REPAIR_REQUIRED (a targeted repair fixes it); only a truncated/empty draft is a real
      // validation dead end.
      if (!gate.pass) {
        statusDecided = true;
        const repairable = gate.repairable === true;
        await setStatus(projectId, repairable ? "QUALITY_REPAIR_REQUIRED" : "FAILED_VALIDATION", {
          errorCode: gate.reasons[0] || "E_STORY_LENGTH_GATE",
          qualityVerdict: qualityVerdictOf(gate, metrics)
        });
        await tx((c) => repo.appendEvent(c, ws, projectId, {
          type: repairable ? "STORY_QUALITY_REPAIR_REQUIRED" : "STORY_VALIDATION_FAILED",
          detail: { state: gate.state, reasons: gate.reasons.slice(0, 3), band: gate.repetitionBand, score: gate.repetitionScore }
        }));
        throw cpErr(gate.reasons[0] || "E_STORY_LENGTH_GATE", `story quality gate: ${gate.state}`);
      }

      // Continuity gate (continuity was computed on the assembled long-form story above).
      if (!continuity.pass) { statusDecided = true; await setStatus(projectId, "FAILED_VALIDATION", { errorCode: continuity.violations[0] || "E_CONTINUITY_FAILED" }); throw cpErr(continuity.violations[0] || "E_CONTINUITY_FAILED", "story failed continuity validation"); }

      // ---- final novelty (full fingerprint) ----
      const finalFp = buildFingerprint({ originalityDimensions: dna.originalityDimensions, title: project.title || "", storyText: text.storyText, outlineBeats: outline.beats });
      const existingFps = await tx((c) => repo.listAcceptedFingerprints(c, ws, { excludeProjectId: projectId }));
      const novelty = assessNovelty({ candidate: finalFp, existing: existingFps, thresholds: noveltyThresholds });
      const fpRow = await tx((c) => repo.insertFingerprint(c, ws, { storyProjectId: projectId, locale, title: project.title || null, fingerprint: finalFp, nearest: novelty.nearest, maxOverall: novelty.maxOverall, pass: novelty.pass, accepted: false }));
      await tx((c) => repo.updateProject(c, ws, projectId, { patch: { currentFingerprintId: fpRow.id } }));
      if (!novelty.pass) { statusDecided = true; await setStatus(projectId, "FAILED_VALIDATION", { errorCode: novelty.reason }); throw cpErr(novelty.reason, "story failed novelty validation"); }

      // ---- Stage 6: titles ----
      const titleOut = await runChatStage({ projectId, chat: conv, stage: "TITLE", prompt: buildTitlePrompt({ dna, profile: brand, count: 6 }) });
      const recentTitles = existingFps.map((f) => f.title).filter(Boolean);
      const ranked = rankTitleCandidates(parseTitleCandidates(titleOut.text), { dna, profile: brand, storyText: text.storyText, recentTitles });
      const chosenTitle = ranked[0];
      const persistedTitles = await tx(async (c) => {
        const rows = await repo.insertTitleCandidates(c, ws, { storyProjectId: projectId, textVersionId: textId, candidates: ranked.map((r, i) => ({ title: r.title, valid: r.valid, score: r.score, reasons: r.reasons, chosen: i === 0 })) });
        await repo.updateProject(c, ws, projectId, { patch: { title: chosenTitle.title } });
        return rows;
      });
      project = await tx((c) => repo.getProject(c, ws, projectId));

      // ---- Stage 7: metadata + package ----
      let pkg = null;
      let metaId = force ? null : project.currentPackageId;
      if (!metaId) {
        const metaOut = await runChatStage({ projectId, chat: conv, stage: "METADATA", prompt: buildMetadataPrompt({ dna, profile: brand, title: chosenTitle.title, storyText: text.storyText }) });
        const meta = parseMetadataResponse(metaOut.text);
        const packageJson = { schemaVersion: 1, locale, title: chosenTitle.title, ...meta, wordCount: text.wordCount, fullStory: text.storyText, dnaChecksum: dnaChecksum(dna), archetype: project.archetypeId };
        const saved = await tx(async (c) => { const v = await repo.insertPackage(c, ws, { storyProjectId: projectId, fields: { title: chosenTitle.title, ...meta }, packageJson }); await repo.updateProject(c, ws, projectId, { patch: { currentPackageId: v.id } }); await repo.appendEvent(c, ws, projectId, { type: "STORY_PACKAGE_READY", detail: { version: v.version } }); return v; });
        metaId = saved.id; pkg = await tx((c) => repo.getPackage(c, ws, metaId));
      } else pkg = await tx((c) => repo.getPackage(c, ws, metaId));

      // ---- Stage 8: quality (deterministic + optional model self-assessment) ----
      let modelScores = {};
      try { const q = await runChatStage({ projectId, chat: conv, stage: "QUALITY", prompt: buildQualityPrompt({ profile: brand, title: chosenTitle.title }) }); modelScores = parseQualityResponse(q.text); } catch { /* self-assessment is optional */ }
      const arc = analyzeStoryArc(text.storyText, dna);
      const titleValidation = { valid: chosenTitle.valid, score: chosenTitle.score };
      const scorecard = computeScorecard({ storyText: text.storyText, dna, continuity, novelty, titleValidation, arc, locale, modelScores, metrics, lengthTarget, lengthGateResult: gate }, qualityThresholds);
      const qRow = await tx(async (c) => { const v = await repo.insertQualityReport(c, ws, { storyProjectId: projectId, dimensions: scorecard.dimensions, overallScore: scorecard.overallScore, ready: scorecard.ready, failures: scorecard.failures }); await repo.updateProject(c, ws, projectId, { patch: { currentQualityId: v.id, overallScore: scorecard.overallScore } }); return v; });

      // ---- READY gate ----
      if (!scorecard.ready) { statusDecided = true; await setStatus(projectId, "NEEDS_REVIEW", { errorCode: scorecard.criticalFailures[0] || "E_QUALITY_BELOW_THRESHOLD" }); await tx((c) => repo.appendEvent(c, ws, projectId, { type: "STORY_NEEDS_REVIEW", detail: { failures: scorecard.criticalFailures } })); return getProjectView(projectId); }
      await tx(async (c) => { await repo.markFingerprintAccepted(c, ws, fpRow.id); await repo.updateProject(c, ws, projectId, { patch: { status: "READY", errorCode: null } }); await repo.appendEvent(c, ws, projectId, { type: "STORY_READY", detail: { overallScore: scorecard.overallScore, wordCount: text.wordCount } }); });
      return getProjectView(projectId);
    } catch (e) {
      // Only mark FAILED_GENERATION when nothing upstream already recorded a more accurate terminal.
      //
      // This used to be decided by pattern-matching the error CODE, which meant every gate whose code did
      // not happen to start with E_NOVELTY/E_LOGIC/E_CONTINUITY/E_QUALITY had its correct status silently
      // overwritten. That is how a finished 2932-word story ended up labelled "the model failed to
      // generate": the length gate had already set the right state, and this handler replaced it.
      //
      // A flag set by the branch that actually knows is not guessable and cannot drift as codes are added.
      if (!statusDecided) { try { await setStatus(projectId, "FAILED_GENERATION", { errorCode: e.code || "E_STORY_PIPELINE" }); } catch { /* */ } }
      throw e;
    } finally {
      if (conv) { try { await conv.close(); } catch { /* */ } }
    }
  }

  // ---- regenerate just the title (authorized, does not touch the story) ----
  async function regenerateTitle(projectId) {
    execGate.assertRunning("regenerateTitle");
    const view = await getProjectView(projectId);
    if (!view || !view.text || !view.dna) throw cpErr("E_STORY_NOT_READY", "no story text to title");
    const brand = await tx((c) => repo.getBrandProfile(c, ws, view.project.brandProfileId));
    const dna = view.dna.dna;
    const out = await runChatStage({ projectId, stage: "TITLE", prompt: buildTitlePrompt({ dna, profile: brand, count: 6 }) });
    const existingFps = await tx((c) => repo.listAcceptedFingerprints(c, ws, { excludeProjectId: projectId }));
    const ranked = rankTitleCandidates(parseTitleCandidates(out.text), { dna, profile: brand, storyText: view.text.storyText, recentTitles: existingFps.map((f) => f.title).filter(Boolean) });
    return tx(async (c) => { const rows = await repo.insertTitleCandidates(c, ws, { storyProjectId: projectId, textVersionId: view.text.id, candidates: ranked.map((r, i) => ({ title: r.title, valid: r.valid, score: r.score, reasons: r.reasons, chosen: i === 0 })) }); await repo.updateProject(c, ws, projectId, { patch: { title: ranked[0].title } }); return { titles: rows }; });
  }
  async function chooseTitle(projectId, candidateId) {
    return tx(async (c) => { const title = await repo.chooseTitle(c, ws, projectId, candidateId); if (title) await repo.updateProject(c, ws, projectId, { patch: { title } }); return { title }; });
  }
  async function archiveProject(id) { return tx((c) => repo.updateProject(c, ws, id, { patch: { status: "ARCHIVED" } })); }

  // ---- optional movie adaptation (separate authorized action; dynamic storyboard; NO Grok Imagine) ----
  async function createMovieAdaptation(projectId, { targetDurationSeconds = 36, sceneDurationSeconds = 6, aspectRatio = "9:16" } = {}) {
    execGate.assertRunning("createMovieAdaptation");
    if (!movie || typeof movie.createProject !== "function" || typeof movie.setStory !== "function" || typeof movie.planStoryboard !== "function") throw cpErr("E_STORY_MOVIE_UNAVAILABLE", "movie adaptation is not available on this runtime");
    const view = await getProjectView(projectId);
    if (!view || view.project.status !== "READY") throw cpErr("E_STORY_NOT_READY", "the story must be READY before a movie adaptation");
    const dna = view.dna.dna; const brand = await tx((c) => repo.getBrandProfile(c, ws, view.project.brandProfileId));
    const movieStory = deriveMovieStory({ storyText: view.text.storyText, dna, brand, title: view.project.title, targetDurationSeconds, sceneDurationSeconds, aspectRatio });
    const created = await movie.createProject({ title: view.project.title || movieStory.title, language: view.project.language, targetDurationSeconds, aspectRatio, inputMode: "IDEA", idea: dna.incitingIncident || movieStory.synopsis });
    const movieProjectId = created.id;
    await movie.setStory({ projectId: movieProjectId, story: movieStory });
    const scenes = await movie.planStoryboard({ projectId: movieProjectId });
    const sceneCount = Array.isArray(scenes) ? scenes.length : (scenes && Array.isArray(scenes.scenes) ? scenes.scenes.length : movieStory.beats.length);
    const link = await tx(async (c) => { const l = await repo.insertMovieLink(c, ws, { storyProjectId: projectId, movieProjectId, sceneCount, storyboardOnly: true }); await repo.appendEvent(c, ws, projectId, { type: "STORY_MOVIE_ADAPTATION_CREATED", detail: { movieProjectId, sceneCount, videoInvoked: false } }); return l; });
    return Object.freeze({ movieProjectId, sceneCount, storyboardOnly: true, videoInvoked: false, link });
  }

  // ================================ QUALITY REPAIR (P0 Step 5C.34) ================================
  //
  // Finish a story whose PROSE already exists: continuity -> novelty -> title -> package -> scorecard ->
  // READY. Every stage is skipped when its current_* pointer is already set, so this is idempotent and
  // restart-safe, and it never re-runs the SECTION stages — the expensive part is already on disk. This is
  // what makes "repair" different from "regenerate": a recovered story keeps the prose the model wrote.
  async function completeFromText(projectId, { conv = null, modelSelfAssessment = false } = {}) {
    let project = await tx((c) => repo.getProject(c, ws, projectId));
    const brand = await tx((c) => repo.getBrandProfile(c, ws, project.brandProfileId));
    const dnaRow = await tx((c) => repo.getDnaVersion(c, ws, project.currentDnaId));
    const outlineRow = project.currentOutlineId ? await tx((c) => repo.getOutlineVersion(c, ws, project.currentOutlineId)) : null;
    const text = await tx((c) => repo.getTextVersion(c, ws, project.currentTextId));
    if (!dnaRow || !text) throw cpErr("E_STORY_NOT_READY", "the story has no DNA or no text to complete");
    const dna = dnaRow.dna;
    const locale = project.locale;
    const lengthTarget = project.lengthTarget || resolveLengthTarget({ preset: project.lengthPreset || "STANDARD", locale, profile: brand, customReadingMinutes: project.customReadingMinutes });
    const metrics = computeStoryMetrics(text.storyText, { locale, profile: brand, characterNames: entitiesFromDna(dna) });
    const gate = lengthGate(metrics, lengthTarget, lengthGateThresholds);
    if (!gate.pass) throw cpErr(gate.reasons[0] || "E_STORY_LENGTH_GATE", `story quality gate: ${gate.state}`);

    const continuity = checkStoryContinuity(text.storyText, dna, { locale });
    if (!continuity.pass) { await setStatus(projectId, "FAILED_VALIDATION", { errorCode: continuity.violations[0] || "E_CONTINUITY_FAILED" }); throw cpErr(continuity.violations[0] || "E_CONTINUITY_FAILED", "story failed continuity validation"); }

    // ---- novelty (reuse the existing fingerprint when one was already accepted for this text) ----
    const existingFps = await tx((c) => repo.listAcceptedFingerprints(c, ws, { excludeProjectId: projectId }));
    let fpRow = project.currentFingerprintId ? await tx((c) => repo.getFingerprint(c, ws, project.currentFingerprintId)) : null;
    if (!fpRow) {
      const finalFp = buildFingerprint({ originalityDimensions: dna.originalityDimensions, title: project.title || "", storyText: text.storyText, outlineBeats: outlineRow ? outlineRow.outline.beats : [] });
      const novelty = assessNovelty({ candidate: finalFp, existing: existingFps, thresholds: noveltyThresholds });
      fpRow = await tx((c) => repo.insertFingerprint(c, ws, { storyProjectId: projectId, locale, title: project.title || null, fingerprint: finalFp, nearest: novelty.nearest, maxOverall: novelty.maxOverall, pass: novelty.pass, accepted: false }));
      await tx((c) => repo.updateProject(c, ws, projectId, { patch: { currentFingerprintId: fpRow.id } }));
      if (!novelty.pass) { await setStatus(projectId, "FAILED_VALIDATION", { errorCode: novelty.reason }); throw cpErr(novelty.reason, "story failed novelty validation"); }
    }

    // ---- title (only when missing: a story that already has a chosen title keeps it) ----
    let chosenTitle = project.title ? { title: project.title, valid: true, score: 1 } : null;
    let titleSource = project.title ? "EXISTING" : null;
    if (!chosenTitle) {
      const recentTitles = existingFps.map((f) => f.title).filter(Boolean);
      // A good title for this genre is a clause the story already wrote. Try that first: it is native by
      // construction, grounded by construction, and costs no provider call, no browser and no pacing slot.
      // It is judged by the SAME validator the model's candidates go through — nothing is waved through.
      const derived = deriveTitle({ storyText: text.storyText, dna, profile: brand, recentTitles });
      let ranked;
      if (derived) {
        titleSource = "DETERMINISTIC";
        chosenTitle = { title: derived.title, valid: true, score: derived.score };
        ranked = derived.candidates.map((c) => ({ title: c.title, valid: c.valid, score: c.score, reasons: c.reasons }));
      } else {
        titleSource = "PROVIDER";
        const titleOut = await runChatStage({ projectId, chat: conv, stage: "TITLE", prompt: buildTitlePrompt({ dna, profile: brand, count: 6 }) });
        ranked = rankTitleCandidates(parseTitleCandidates(titleOut.text), { dna, profile: brand, storyText: text.storyText, recentTitles });
        chosenTitle = ranked[0];
      }
      await tx(async (c) => {
        await repo.insertTitleCandidates(c, ws, { storyProjectId: projectId, textVersionId: text.id, candidates: ranked.map((r, i) => ({ title: r.title, valid: r.valid, score: r.score, reasons: r.reasons, chosen: i === 0 })) });
        await repo.updateProject(c, ws, projectId, { patch: { title: chosenTitle.title } });
        await repo.appendEvent(c, ws, projectId, { type: "STORY_TITLE_CHOSEN", detail: { source: titleSource, score: chosenTitle.score, providerCalls: titleSource === "PROVIDER" ? 1 : 0 } });
      });
      project = await tx((c) => repo.getProject(c, ws, projectId));
    }

    // ---- package ----
    let pkg = project.currentPackageId ? await tx((c) => repo.getPackage(c, ws, project.currentPackageId)) : null;
    if (!pkg) {
      const metaOut = await runChatStage({ projectId, chat: conv, stage: "METADATA", prompt: buildMetadataPrompt({ dna, profile: brand, title: chosenTitle.title, storyText: text.storyText }) });
      const meta = parseMetadataResponse(metaOut.text);
      const packageJson = { schemaVersion: 1, locale, title: chosenTitle.title, ...meta, wordCount: text.wordCount, fullStory: text.storyText, dnaChecksum: dnaChecksum(dna), archetype: project.archetypeId };
      pkg = await tx(async (c) => { const v = await repo.insertPackage(c, ws, { storyProjectId: projectId, fields: { title: chosenTitle.title, ...meta }, packageJson }); await repo.updateProject(c, ws, projectId, { patch: { currentPackageId: v.id } }); await repo.appendEvent(c, ws, projectId, { type: "STORY_PACKAGE_READY", detail: { version: v.version } }); return v; });
    }

    // ---- scorecard. The model self-assessment is OPTIONAL and off by default here: it costs a provider
    // call and the deterministic dimensions are what the READY gate actually reads.
    let modelScores = {};
    if (modelSelfAssessment) { try { const q = await runChatStage({ projectId, chat: conv, stage: "QUALITY", prompt: buildQualityPrompt({ profile: brand, title: chosenTitle.title }) }); modelScores = parseQualityResponse(q.text); } catch { /* optional */ } }
    const arc = analyzeStoryArc(text.storyText, dna);
    const novelty = { pass: true, maxOverall: fpRow.maxOverall ?? 0, nearest: fpRow.nearest ?? null };
    const scorecard = computeScorecard({ storyText: text.storyText, dna, continuity, novelty, titleValidation: { valid: chosenTitle.valid !== false, score: chosenTitle.score ?? 1 }, arc, locale, modelScores, metrics, lengthTarget, lengthGateResult: gate }, qualityThresholds);
    await tx(async (c) => { const v = await repo.insertQualityReport(c, ws, { storyProjectId: projectId, dimensions: scorecard.dimensions, overallScore: scorecard.overallScore, ready: scorecard.ready, failures: scorecard.failures }); await repo.updateProject(c, ws, projectId, { patch: { currentQualityId: v.id, overallScore: scorecard.overallScore, metrics, lengthGateState: gate.state } }); return v; });

    if (!scorecard.ready) { await setStatus(projectId, "NEEDS_REVIEW", { errorCode: scorecard.criticalFailures[0] || "E_QUALITY_BELOW_THRESHOLD" }); await tx((c) => repo.appendEvent(c, ws, projectId, { type: "STORY_NEEDS_REVIEW", detail: { failures: scorecard.criticalFailures } })); return getProjectView(projectId); }
    await tx(async (c) => { await repo.markFingerprintAccepted(c, ws, fpRow.id); await repo.updateProject(c, ws, projectId, { patch: { status: "READY", errorCode: null, qualityVerdict: qualityVerdictOf(gate, metrics) } }); await repo.appendEvent(c, ws, projectId, { type: "STORY_READY", detail: { overallScore: scorecard.overallScore, wordCount: text.wordCount, viaRepair: true } }); });
    return getProjectView(projectId);
  }

  // Re-judge an existing story with the CURRENT detector, spending nothing.
  //
  // This is the honest half of the recovery: a story that was rejected by a language-blind detector should
  // not have to be edited to be exonerated, it should be re-read. It costs no provider call, consumes no
  // repair attempt, and never touches the prose — it only replaces a stale verdict with an accurate one and
  // moves the project to the status that verdict implies. Safe to run over every non-READY project.
  async function reassessStoryQuality(projectId) {
    if (!STP.test(projectId || "")) throw cpErr("E_STORY_NOT_FOUND", "invalid project id");
    const project = await tx((c) => repo.getProject(c, ws, projectId));
    if (!project) throw cpErr("E_STORY_NOT_FOUND", "project not found");
    if (!project.currentTextId) return Object.freeze({ projectId, changed: false, reason: "NO_TEXT", status: project.status });
    if (project.status === "READY" || project.status === "ARCHIVED") return Object.freeze({ projectId, changed: false, reason: "TERMINAL_OK", status: project.status });

    const brand = await tx((c) => repo.getBrandProfile(c, ws, project.brandProfileId));
    const dnaRow = project.currentDnaId ? await tx((c) => repo.getDnaVersion(c, ws, project.currentDnaId)) : null;
    const text = await tx((c) => repo.getTextVersion(c, ws, project.currentTextId));
    if (!text) return Object.freeze({ projectId, changed: false, reason: "NO_TEXT", status: project.status });
    const locale = project.locale;
    const lengthTarget = project.lengthTarget || resolveLengthTarget({ preset: project.lengthPreset || "STANDARD", locale, profile: brand, customReadingMinutes: project.customReadingMinutes });
    const metrics = computeStoryMetrics(text.storyText, { locale, profile: brand, characterNames: dnaRow ? entitiesFromDna(dnaRow.dna) : [] });
    const gate = lengthGate(metrics, lengthTarget, lengthGateThresholds);
    const verdict = qualityVerdictOf(gate, metrics);

    // The prose exists. Whatever the verdict, this is not a generation failure — that label is reserved for
    // a run that produced nothing. A passing gate leaves the project OPEN for completion rather than
    // silently declaring it READY: the title, package and scorecard stages still have to run.
    const nextStatus = gate.pass || gate.repairable ? "QUALITY_REPAIR_REQUIRED"
      : project.status === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "FAILED_VALIDATION";
    const nextError = gate.pass ? null : (gate.reasons[0] || "E_STORY_LENGTH_GATE");
    const changed = nextStatus !== project.status || (project.errorCode || null) !== nextError;
    await tx(async (c) => {
      await repo.updateProject(c, ws, projectId, { patch: { status: nextStatus, errorCode: nextError, metrics, lengthGateState: gate.state, qualityVerdict: verdict } });
      if (changed) await repo.appendEvent(c, ws, projectId, { type: "STORY_QUALITY_REASSESSED", detail: { from: project.status, to: nextStatus, gate: gate.state, band: gate.repetitionBand, score: gate.repetitionScore, providerCalls: 0 } });
    });
    return Object.freeze({ projectId, changed, from: project.status, status: nextStatus, gate: gate.state, band: gate.repetitionBand, score: gate.repetitionScore, gatePass: gate.pass, verdict });
  }

  // Repair a story whose OUTPUT EXISTS but whose quality gate declined it.
  //
  // Attempt 1 costs nothing: the text is re-judged by the language-aware detector, and a story that only
  // ever failed because the old detector could not read Danish passes on the spot (outcome RE_EVALUATED).
  // Only if it genuinely still fails does attempt 2 spend ONE provider call on a targeted rewrite of the
  // repeated spans — never a regeneration, never a second project. The original text version is immutable;
  // a repair writes a NEW version and the ledger records which version it came from.
  async function repairStoryQuality(projectId, { maxAttempts = MAX_QUALITY_REPAIRS, modelSelfAssessment = false, actor = "MANUAL", idempotencyKey = null } = {}) {
    execGate.assertRunning("repairStoryQuality");
    if (!STP.test(projectId || "")) throw cpErr("E_STORY_NOT_FOUND", "invalid project id");
    const project = await tx((c) => repo.getProject(c, ws, projectId));
    if (!project) throw cpErr("E_STORY_NOT_FOUND", "project not found");
    if (project.status === "READY") return getProjectView(projectId);           // already recovered: idempotent
    if (project.status === "ARCHIVED") throw cpErr("E_STORY_ARCHIVED", "archived projects are not repaired");
    if (!REPAIRABLE_STATUSES.has(project.status)) throw cpErr("E_STORY_NOT_REPAIRABLE", `status ${project.status} is not a repairable state`);
    // The real guard: a repair needs something to repair. Without prose this WAS a generation failure and
    // the honest action is to generate, not to edit nothing.
    if (!project.currentTextId) throw cpErr("E_STORY_NO_OUTPUT_TO_REPAIR", "this project produced no story text; it needs generation, not repair");

    const attempt = (project.qualityRepairCount || 0) + 1;
    if (attempt > maxAttempts) {
      await setStatus(projectId, "NEEDS_REVIEW", { errorCode: "E_STORY_REPAIR_EXHAUSTED" });
      throw cpErr("E_STORY_REPAIR_EXHAUSTED", `quality repair is exhausted after ${maxAttempts} attempts; this story needs a human`);
    }

    const brand = await tx((c) => repo.getBrandProfile(c, ws, project.brandProfileId));
    const dnaRow = await tx((c) => repo.getDnaVersion(c, ws, project.currentDnaId));
    if (!dnaRow) throw cpErr("E_STORY_NOT_READY", "the story has no DNA");
    const dna = dnaRow.dna;
    const locale = project.locale;
    const lengthTarget = project.lengthTarget || resolveLengthTarget({ preset: project.lengthPreset || "STANDARD", locale, profile: brand, customReadingMinutes: project.customReadingMinutes });
    const source = await tx((c) => repo.getTextVersion(c, ws, project.currentTextId));
    if (!source) throw cpErr("E_STORY_NO_OUTPUT_TO_REPAIR", "the current text version is missing");
    const names = entitiesFromDna(dna);
    const metrics = computeStoryMetrics(source.storyText, { locale, profile: brand, characterNames: names });
    const gate = lengthGate(metrics, lengthTarget, lengthGateThresholds);
    const verdict = qualityVerdictOf(gate, metrics);

    // Claim the attempt. UNIQUE(workspace, project, attempt) means exactly one caller proceeds.
    const claim = await tx((c) => repo.claimQualityRepair(c, ws, {
      storyProjectId: projectId, attempt, sourceTextId: source.id,
      triggerCode: (project.errorCode || gate.reasons[0] || "E_STORY_LENGTH_GATE").split(":")[0],
      band: gate.state === "BELOW_MIN" || gate.state === "TRUNCATED" ? gate.state : (gate.repetitionBand || (gate.pass ? "PASS" : "HARD_REPAIR_OR_REVIEW")),
      verdictBefore: verdict,
      stage: gate.pass ? "RE_EVALUATE" : (gate.state === "BELOW_MIN" ? "EXPAND" : "REPAIR"),
      idempotencyKey, actor
    }));
    if (!claim) {
      // The attempt row already exists. If its provider call was reached, this is NOT something to retry:
      // re-sending would spend a second invocation on work that may already have happened. Say so plainly.
      const existing = await tx((c) => repo.getQualityRepairAttempt(c, ws, { storyProjectId: projectId, attempt }));
      if (existing && existing.submitState !== "NOT_SUBMITTED") {
        throw cpErr("E_STORY_REPAIR_SUBMIT_UNCERTAIN", "this repair attempt may already have reached the provider; it will not be re-sent");
      }
      throw cpErr("E_STORY_REPAIR_IN_PROGRESS", "a repair attempt for this story is already running");
    }
    // Set once the attempt has been given its final outcome, so the error handler below cannot overwrite a
    // considered verdict ("the repair was rejected because it dropped a character") with a generic ERROR.
    let settled = false;
    await tx((c) => repo.updateProject(c, ws, projectId, { patch: { qualityRepairCount: attempt, qualityVerdict: verdict } }));

    try {
      // ---- step 1: re-evaluate. The cheapest honest outcome, and the only one that spends nothing. ----
      if (gate.pass) {
        settled = true;
        await tx(async (c) => {
          await repo.finishQualityRepair(c, ws, claim.id, { outcome: "RE_EVALUATED", resultTextId: source.id, verdictAfter: verdict, providerCalls: 0 });
          await repo.appendEvent(c, ws, projectId, { type: "STORY_QUALITY_RE_EVALUATED", detail: { attempt, band: gate.repetitionBand, score: gate.repetitionScore, providerCalls: 0 } });
        });
        return completeFromText(projectId, { modelSelfAssessment });
      }
      if (gate.repairable !== true) {
        settled = true;
        await tx((c) => repo.finishQualityRepair(c, ws, claim.id, { outcome: "STILL_FAILING", verdictAfter: verdict, providerCalls: 0, errorCode: (gate.reasons[0] || "E_STORY_LENGTH_GATE").split(":")[0] }));
        throw cpErr(gate.reasons[0] || "E_STORY_LENGTH_GATE", `this story is not repairable by editing (${gate.state})`);
      }

      // ---- step 2: ONE targeted provider call ----
      let repairedText = null;
      if (gate.state === "BELOW_MIN") {
        // Too short: deepen the thinnest section rather than "make it longer", which is how padding starts.
        const plan = project.storyPlan || {};
        const sections = Array.isArray(plan.sections) ? plan.sections.map((x) => ({ ...x })) : [];
        if (!sections.length) throw cpErr("E_STORY_NO_SECTIONS", "no section plan to expand");
        const idx = sections.map((sec, i) => ({ i, sec })).sort((a, b) => (a.sec.wordCount || 0) - (b.sec.wordCount || 0))[0].i;
        const deficit = Math.max(150, lengthTarget.idealMin - metrics.actualWordCount);
        await tx((c) => repo.markQualityRepairSubmitted(c, ws, claim.id, { submitState: "SUBMITTED", stage: "EXPAND" }));
        const out = await runChatStage({ projectId, stage: "EXPAND", prompt: buildSectionExpandPrompt({ dna, section: sections[idx], sectionText: sections[idx].text, profile: brand, deficitWords: deficit }) });
        const expanded = parseSectionResponse(out.text);
        if (expanded.wordCount <= (sections[idx].wordCount || 0)) throw cpErr("E_STORY_EXPAND_NO_GAIN", "the expansion returned no additional prose");
        sections[idx] = { ...sections[idx], text: expanded.section, wordCount: expanded.wordCount, expandCount: (sections[idx].expandCount || 0) + 1 };
        repairedText = sections.map((sec) => sec.text).filter(Boolean).join("\n\n");
        await tx((c) => repo.updateProject(c, ws, projectId, { patch: { storyPlan: { ...plan, sections } } }));
      } else {
        const targets = repairTargets(metrics.repetition, { max: 12 });
        await tx((c) => repo.markQualityRepairSubmitted(c, ws, claim.id, { submitState: "SUBMITTED", stage: "REPAIR" }));
        const out = await runChatStage({ projectId, stage: "EDIT", prompt: buildQualityRepairPrompt({ dna, profile: brand, storyText: source.storyText, spans: targets, targetWords: source.wordCount }) });
        repairedText = parseStoryResponseText(out.text, { locale, wordRange: [lengthTarget.wordsMin, lengthTarget.wordsMax] }).story;
      }

      // ---- judge the repair on its own merits ----
      const newMetrics = computeStoryMetrics(repairedText, { locale, profile: brand, characterNames: names });
      const newGate = lengthGate(newMetrics, lengthTarget, lengthGateThresholds);
      const newVerdict = qualityVerdictOf(newGate, newMetrics);
      const contBefore = checkStoryContinuity(source.storyText, dna, { locale });
      const contAfter = checkStoryContinuity(repairedText, dna, { locale });
      const check = repairIsAcceptable({
        original: { storyText: source.storyText, wordCount: source.wordCount },
        repaired: { storyText: repairedText, wordCount: newMetrics.actualWordCount },
        dna, locale, continuityBefore: contBefore, continuityAfter: contAfter,
        scoreBefore: gate.state === "BELOW_MIN" ? (lengthTarget.wordsMin - metrics.actualWordCount) : (gate.repetitionScore ?? 1),
        scoreAfter: gate.state === "BELOW_MIN" ? (lengthTarget.wordsMin - newMetrics.actualWordCount) : (newGate.repetitionScore ?? 1),
        wordsMin: gate.state === "BELOW_MIN" ? null : Math.round(lengthTarget.wordsMin * 0.9)
      });

      // The repaired draft is persisted either way — an audit must be able to read what the repair produced
      // even when it was refused — but it only becomes CURRENT when it is accepted.
      const version = await tx((c) => repo.insertTextVersion(c, ws, {
        storyProjectId: projectId, dnaId: project.currentDnaId, outlineId: project.currentOutlineId,
        storyText: repairedText, wordCount: newMetrics.actualWordCount, edited: true,
        continuityReport: { ...contAfter, coverage: dnaCoverage(repairedText, dna), repair: { attempt, accepted: check.ok, problems: check.problems } }
      }));

      if (!check.ok || !newGate.pass) {
        settled = true;
        const code = (check.problems[0] || newGate.reasons[0] || "E_STORY_REPAIR_REJECTED").split(":")[0];
        await tx(async (c) => {
          await repo.finishQualityRepair(c, ws, claim.id, { outcome: "STILL_FAILING", resultTextId: version.id, verdictAfter: newVerdict, providerCalls: 1, errorCode: code });
          await repo.appendEvent(c, ws, projectId, { type: "STORY_QUALITY_REPAIR_REJECTED", detail: { attempt, problems: check.problems.slice(0, 3), gate: newGate.state } });
        });
        const exhausted = attempt >= maxAttempts;
        // The verdict on the PROJECT must describe the draft that is still current — which, after a refused
        // repair, is the original. Storing the refused candidate's verdict there would have the project
        // reporting the length and confidence of prose nobody will ever read; the candidate's verdict lives
        // in the ledger's verdict_after, which is exactly what that column is for.
        await setStatus(projectId, exhausted ? "NEEDS_REVIEW" : "QUALITY_REPAIR_REQUIRED", { errorCode: exhausted ? "E_STORY_REPAIR_EXHAUSTED" : code, qualityVerdict: verdict });
        throw cpErr(code, exhausted ? "the repair did not converge; this story needs a human" : "the repair was rejected; one attempt remains");
      }

      settled = true;
      await tx(async (c) => {
        await repo.updateProject(c, ws, projectId, { patch: { currentTextId: version.id, wordCount: newMetrics.actualWordCount, metrics: newMetrics, lengthGateState: newGate.state, qualityVerdict: newVerdict } });
        await repo.finishQualityRepair(c, ws, claim.id, { outcome: "REPAIRED", resultTextId: version.id, verdictAfter: newVerdict, providerCalls: 1 });
        await repo.appendEvent(c, ws, projectId, { type: "STORY_QUALITY_REPAIRED", detail: { attempt, from: source.id, to: version.id, scoreBefore: gate.repetitionScore, scoreAfter: newGate.repetitionScore, providerCalls: 1 } });
      });
      return completeFromText(projectId, { modelSelfAssessment });
    } catch (e) {
      // A repair that blew up mid-flight must not leave a PENDING row claiming the attempt forever — but a
      // row that already has its verdict keeps it.
      if (!settled) { try { await tx((c) => repo.finishQualityRepair(c, ws, claim.id, { outcome: "ERROR", errorCode: (e.code || "E_STORY_REPAIR_FAILED").split(":")[0] })); } catch { /* */ } }
      throw e;
    }
  }

  // ============================ AUTONOMOUS REPAIR (P0 Step 5C.35) ============================
  //
  // The repair itself is unchanged and still certified; this is the part that decides WHEN to run it and
  // makes sure exactly one runner does. Everything durable lives in story_repair_schedule: the eligible
  // record, the lease, and the pacing deadline. Nothing is held in memory that a restart would need back.
  //
  // Three rules shape the code below and are worth stating once:
  //   * a provider call NEVER happens inside a database transaction — claim, call, record are separate;
  //   * waiting for a paced lane holds NOTHING: no lease, no browser, no account lock, no transaction;
  //   * an attempt whose provider call may already have been sent is never re-sent, only judged.

  const AUTO_LEASE_MS = 5 * 60 * 1000;          // a repair step is minutes, not hours
  const AUTO_LEASE_RENEW_MS = 60 * 1000;        // heartbeat well inside the lease
  const AUTO_MAX_DEFERRALS = 60;                // ~2h of pacing at the production interval, then a human

  // Why this story cannot be auto-repaired right now, or null when it can.
  async function autoRepairIneligibility(project) {
    if (!project) return "E_STORY_NOT_FOUND";
    if (project.status === "READY") return "READY";
    if (project.status === "ARCHIVED") return "ARCHIVED";
    // Order matters: a story that has spent its attempts, or that a gate sent to a human, must be reported
    // as NEEDING REVIEW — not as a generic "wrong status". The two look the same from the outside and read
    // completely differently to whoever is looking at the queue.
    if ((project.qualityRepairCount || 0) >= MAX_QUALITY_REPAIRS) return "ATTEMPTS_EXHAUSTED";
    if (project.status === "NEEDS_REVIEW") return "MANUAL_REVIEW_ONLY";
    if (!AUTO_REPAIRABLE_STATUSES.has(project.status)) return "NOT_REPAIRABLE_STATUS";
    // The real gate: a repair needs prose. Without it this WAS a generation failure and the honest action is
    // to generate — which is a human decision, not something to do unattended.
    if (!project.currentTextId) return "NO_OUTPUT";
    const text = await tx((c) => repo.getTextVersion(c, ws, project.currentTextId));
    if (!text || !text.storyText || text.wordCount < 50) return "DRAFT_UNUSABLE";
    // A verdict the detector could not judge confidently is a review, not an unattended rewrite.
    const v = project.qualityVerdict;
    if (v && v.repetition && Number(v.repetition.confidence) < 0.4) return "MANUAL_REVIEW_ONLY";
    // "Not repairable" only means a human is needed when the gate also FAILED. A story whose gate passes
    // has nothing to repair — it just has stages left to run, which is precisely this scheduler's job.
    const gatePassed = v ? (v.gatePass === true || (v.gatePass === undefined && ["PASS", "ABOVE_MAX_SOFT"].includes(v.gateState))) : true;
    if (v && v.repairable === false && !gatePassed) return "MANUAL_REVIEW_ONLY";
    return null;
  }

  // Publish the durable eligible record for every story that qualifies, and retire the rows that no longer
  // do. Idempotent; safe to run on every tick.
  async function autoRepairEnqueue() {
    // Oldest first. listProjects is newest-first for the UI; enqueuing in that order would stamp
    // enqueued_at backwards and make the FIFO queue run newest-first — the opposite of no-starvation.
    const projects = (await tx((c) => repo.listProjects(c, ws, { limit: 500 }))).slice().reverse();
    let enqueued = 0, retired = 0, blocked = 0;
    for (const p of projects) {
      const reason = await autoRepairIneligibility(p);
      const existing = await tx((c) => repo.getRepairSchedule(c, ws, p.id));
      if (reason === null) {
        if (!existing) { await tx((c) => repo.upsertRepairSchedule(c, ws, { storyProjectId: p.id })); enqueued += 1; }
        else if (existing.state === "BLOCKED") {
          // A tenant that was suspended and is now active again picks up exactly where it left off.
          await tx((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: p.id, state: "ELIGIBLE", lastError: null, lastAction: "REACTIVATED" }));
          enqueued += 1;
        }
        continue;
      }
      if (!existing) continue;
      if (reason === "READY" && existing.state !== "DONE") { await tx((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: p.id, state: "DONE", lastAction: "READY" })); retired += 1; }
      else if (reason === "ATTEMPTS_EXHAUSTED" || reason === "MANUAL_REVIEW_ONLY") {
        if (existing.state !== "MANUAL_REVIEW") { await tx((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: p.id, state: "MANUAL_REVIEW", lastAction: reason })); blocked += 1; }
      } else if (existing.state !== "BLOCKED" && existing.state !== "DONE" && existing.state !== "MANUAL_REVIEW") {
        await tx((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: p.id, state: "BLOCKED", lastAction: reason })); blocked += 1;
      }
    }
    return Object.freeze({ enqueued, retired, blocked });
  }

  async function autoRepairDue({ nowMs = now(), limit = 20 } = {}) {
    return tx((c) => repo.listDueRepairs(c, ws, { nowMs, limit }));
  }
  async function autoRepairSnapshot() {
    const rows = await tx((c) => repo.listRepairSchedule(c, ws, {}));
    const byState = {};
    let nearest = null;
    for (const r of rows) {
      byState[r.state] = (byState[r.state] || 0) + 1;
      if ((r.state === "ELIGIBLE" || r.state === "WAITING_COOLDOWN") && r.nextEligibleAt) {
        const t = new Date(r.nextEligibleAt).getTime();
        if (nearest === null || t < nearest) nearest = t;
      }
    }
    return Object.freeze({
      waiting: (byState.ELIGIBLE || 0) + (byState.WAITING_COOLDOWN || 0),
      active: byState.LEASED || 0,
      completed: byState.DONE || 0,
      needsManualReview: (byState.MANUAL_REVIEW || 0),
      blocked: byState.BLOCKED || 0,
      nearestEligibleAt: nearest === null ? null : new Date(nearest).toISOString(),
      rows: Object.freeze(rows.map((r) => Object.freeze({ storyProjectId: r.storyProjectId, state: r.state, attempt: r.attempt, deferrals: r.deferrals, nextEligibleAt: r.nextEligibleAt, lastError: r.lastError, lastAction: r.lastAction })))
    });
  }

  /**
   * Advance ONE story by one idempotent step. Returns an action describing what happened; every branch
   * leaves the durable state consistent enough that simply calling it again is the correct recovery.
   *
   * `pacing.reserve()` must be the SAME durable provider-lane reservation the generation path uses — the
   * point of pacing is that Grok sees one submission per lane per interval regardless of which subsystem
   * asked. `tenancy.assertActive()` is the customer lifecycle gate.
   */
  async function autoRepairStep(projectId, { owner, pacing = null, tenancy = null, leaseMs = AUTO_LEASE_MS } = {}) {
    if (!STP.test(projectId || "")) return { projectId, action: "NOT_FOUND" };
    if (typeof owner !== "string" || owner.length < 4) throw cpErr("E_STORY_REPAIR_OWNER", "an auto-repair step needs a lease owner id");

    let project = await tx((c) => repo.getProject(c, ws, projectId));
    const ineligible = await autoRepairIneligibility(project);
    if (ineligible !== null) {
      const state = ineligible === "READY" ? "DONE" : (ineligible === "ATTEMPTS_EXHAUSTED" || ineligible === "MANUAL_REVIEW_ONLY") ? "MANUAL_REVIEW" : "BLOCKED";
      await tx((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: projectId, state, lastAction: ineligible }));
      return { projectId, action: "SKIPPED", reason: ineligible };
    }

    // Tenant lifecycle. A suspended customer stops NEW work; the schedule row is parked, not lost, so a
    // reactivated tenant resumes from exactly here.
    if (tenancy && typeof tenancy.assertActive === "function") {
      try { await tenancy.assertActive(ws); }
      catch (e) {
        await tx((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: projectId, state: "BLOCKED", lastError: (e.code || "E_CUSTOMER_SUSPENDED").split(":")[0], lastAction: "TENANT_BLOCKED" }));
        return { projectId, action: "BLOCKED", reason: e.code || "E_CUSTOMER_SUSPENDED" };
      }
    }

    const attempt = (project.qualityRepairCount || 0) + 1;
    const text = await tx((c) => repo.getTextVersion(c, ws, project.currentTextId));
    const key = idempotencyKeyFor(projectId, text.version, attempt);


    // ---- claim. One conditional UPDATE; a racing scheduler simply gets nothing. ----
    const claimed = await tx((c) => repo.claimRepairSchedule(c, ws, {
      storyProjectId: projectId, owner, leaseMs, attempt, sourceRevision: text.version, idempotencyKey: key, nowMs: now()
    }));
    if (!claimed) return { projectId, action: "NOT_CLAIMED" };

    // Only the caller that actually WON the claim asks this question — otherwise a racing scheduler would
    // read a half-written outcome and reach a verdict about work it never owned.
    //
    // The previous attempt's evidence decides whether unattended work may continue. If its provider call was
    // reached and it did not resolve, a model may have produced a repair this system threw away; spending
    // another invocation on top of that is exactly the quiet double-charge a scheduler must never make. A
    // human looks at it instead — a manual repair can still be requested explicitly.
    if (attempt > 1) {
      const prev = await tx((c) => repo.getQualityRepairAttempt(c, ws, { storyProjectId: projectId, attempt: attempt - 1 }));
      // Note the distinction: STILL_FAILING is a RESOLVED attempt — the call completed, the result was
      // judged and refused, and the story kept its original draft. What must stop unattended work is an
      // attempt that reached the provider and never reached a verdict.
      const UNRESOLVED = new Set(["PENDING", "RUNNING", "WAITING_COOLDOWN", "ERROR"]);
      if (prev && prev.submitState !== "NOT_SUBMITTED" && UNRESOLVED.has(prev.outcome)) {
        await tx(async (c) => {
          await repo.releaseRepairSchedule(c, ws, { storyProjectId: projectId, owner, state: "MANUAL_REVIEW", lastError: "E_STORY_REPAIR_SUBMIT_UNCERTAIN", lastAction: "SUBMIT_UNCERTAIN" });
          await repo.updateProject(c, ws, projectId, { patch: { status: "NEEDS_REVIEW", errorCode: "E_STORY_REPAIR_SUBMIT_UNCERTAIN" } });
        });
        return { projectId, action: "MANUAL_REVIEW", code: "E_STORY_REPAIR_SUBMIT_UNCERTAIN" };
      }
    }

    // ---- pacing. Reserve the physical lane BEFORE doing anything that costs. A refusal is not a failure:
    // the lease is dropped, the deadline is recorded, and the story says so. ----
    if (pacing && typeof pacing.reserve === "function") {
      let slot;
      try { slot = await pacing.reserve({ nowMs: now() }); }
      catch (e) { slot = { granted: false, nextEligibleAt: new Date(now() + 60_000), error: e.code || null }; }
      if (!slot || slot.granted !== true) {
        const nextAt = slot && slot.nextEligibleAt ? new Date(slot.nextEligibleAt) : new Date(now() + 60_000);
        const deferrals = (claimed.deferrals || 0) + 1;
        const exhausted = deferrals > AUTO_MAX_DEFERRALS;
        await tx(async (c) => {
          await repo.releaseRepairSchedule(c, ws, {
            storyProjectId: projectId, owner,
            state: exhausted ? "MANUAL_REVIEW" : "WAITING_COOLDOWN",
            nextEligibleAt: nextAt.toISOString(), lastAction: exhausted ? "DEFERRALS_EXHAUSTED" : "COOLDOWN", bumpDeferrals: true
          });
          await repo.updateProject(c, ws, projectId, { patch: { status: exhausted ? "NEEDS_REVIEW" : "WAITING_REPAIR_COOLDOWN", repairNextEligibleAt: nextAt.toISOString() } });
        });
        return { projectId, action: exhausted ? "MANUAL_REVIEW" : "DEFERRED", nextEligibleAt: nextAt.toISOString(), deferrals };
      }
    }

    // ---- run. The lease is renewed on a heartbeat so a long step keeps its claim without holding a
    // transaction; a scheduler that dies simply stops renewing and the lease expires. ----
    let heartbeat = null;
    if (leaseMs > AUTO_LEASE_RENEW_MS * 2) {
      heartbeat = setInterval(() => {
        void tx((c) => repo.renewRepairLease(c, ws, { storyProjectId: projectId, owner, leaseMs, nowMs: now() })).catch(() => {});
      }, AUTO_LEASE_RENEW_MS);
      if (heartbeat.unref) heartbeat.unref();
    }
    await tx((c) => repo.updateProject(c, ws, projectId, { patch: { status: "QUALITY_REPAIRING", repairNextEligibleAt: null } }));

    try {
      const view = await repairStoryQuality(projectId, { actor: "SCHEDULER", idempotencyKey: key });
      const done = view && view.project && view.project.status === "READY";
      if (pacing && typeof pacing.note === "function") { try { await pacing.note({ outcome: "SUBMITTED", nowMs: now() }); } catch { /* pacing telemetry only */ } }
      await tx((c) => repo.releaseRepairSchedule(c, ws, {
        storyProjectId: projectId, owner,
        state: done ? "DONE" : "MANUAL_REVIEW",
        lastAction: done ? "READY" : (view?.project?.status || "NOT_READY")
      }));
      return { projectId, action: done ? "READY" : "NEEDS_REVIEW", status: view?.project?.status || null, title: view?.project?.title || null, score: view?.project?.overallScore ?? null };
    } catch (e) {
      const code = String(e.code || "E_STORY_REPAIR_FAILED").split(":")[0];
      // A provider signal that provably never reached the provider is a pacing event, not a failure.
      const pace = code === "E_STORY_TEXT_PROVIDER_UNAVAILABLE" || code === "E_GROK_CHAT_OPEN_FAILED" || code === "E_PROVIDER_RATE_LIMITED" || code === "E_STORY_STAGE_FAILED";
      if (pacing && typeof pacing.note === "function") { try { await pacing.note({ outcome: pace ? "COOLDOWN" : "FAILED", nowMs: now() }); } catch { /* */ } }
      const nextAt = new Date(now() + (pace ? 120_000 : 0));
      const stillRepairable = (await tx((c) => repo.getProject(c, ws, projectId)))?.status;
      const park = code === "E_STORY_REPAIR_SUBMIT_UNCERTAIN" || code === "E_STORY_REPAIR_EXHAUSTED";
      await tx(async (c) => {
        await repo.releaseRepairSchedule(c, ws, {
          storyProjectId: projectId, owner,
          state: park ? "MANUAL_REVIEW" : pace ? "WAITING_COOLDOWN" : "ELIGIBLE",
          nextEligibleAt: pace ? nextAt.toISOString() : null,
          lastError: code, lastAction: park ? "SUBMIT_UNCERTAIN" : pace ? "PROVIDER_COOLDOWN" : "RETRY",
          bumpDeferrals: pace
        });
        if (pace && stillRepairable === "QUALITY_REPAIRING") {
          await repo.updateProject(c, ws, projectId, { patch: { status: "WAITING_REPAIR_COOLDOWN", repairNextEligibleAt: nextAt.toISOString() } });
        } else if (!park && stillRepairable === "QUALITY_REPAIRING") {
          await repo.updateProject(c, ws, projectId, { patch: { status: "QUALITY_REPAIR_REQUIRED" } });
        }
      });
      return { projectId, action: park ? "MANUAL_REVIEW" : pace ? "DEFERRED" : "ERROR", code, nextEligibleAt: pace ? nextAt.toISOString() : null };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  return Object.freeze({
    ensureSeeds, listBrandProfiles, listArchetypes, createBrandProfile, updateBrandProfile,
    createProject, listProjects, getProjectView, generateStory, regenerateTitle, chooseTitle, archiveProject,
    repairStoryQuality, reassessStoryQuality, completeFromText,
    autoRepairEnqueue, autoRepairDue, autoRepairStep, autoRepairSnapshot, autoRepairIneligibility,
    createMovieAdaptation, chatAvailable: () => chatAvailable
  });
}

// Dynamic storyboard derivation (pure): pick evenly-spaced native paragraphs as scene narration, size
// the scene count from target duration / clip duration (NOT hard-coded), and build character + style
// bibles from the DNA. Produces a movie-facade story object; NEVER triggers video generation.
export function deriveMovieStory({ storyText, dna, brand, title, targetDurationSeconds = 36, sceneDurationSeconds = 6, aspectRatio = "9:16" }) {
  const paragraphs = String(storyText || "").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const desired = Math.max(3, Math.min(10, Math.round(targetDurationSeconds / Math.max(2, sceneDurationSeconds))));
  const count = Math.max(3, Math.min(desired, paragraphs.length || desired));
  const step = paragraphs.length ? paragraphs.length / count : 1;
  const characters = [
    { name: dna.protagonist, description: `${dna.protagonistOccupation || "the narrator"}, ${dna.protagonistAgeRange || "adult"}; keep appearance consistent across scenes.` },
    ...dna.antagonistList.slice(0, 3).map((a) => ({ name: a.name, description: `${a.relationship || "relative"} — ${a.role || ""}`.slice(0, 200) }))
  ];
  const styleBible = brand.visualStyle || "grounded, natural light, emotional close-ups, consistent characters";
  const beats = Array.from({ length: count }, (_, i) => {
    const para = paragraphs.length ? paragraphs[Math.min(paragraphs.length - 1, Math.floor(i * step))] : (dna.escalationSteps[i] || dna.incitingIncident);
    const firstSentence = String(para).split(/(?<=[.!?…])\s+/)[0] || para;
    return { heading: `Scene ${i + 1}`, narration: firstSentence.slice(0, 300), visual: `${styleBible}. ${String(para).slice(0, 220)}` };
  });
  return { title: title || dna.incitingIncident.slice(0, 80) || "Story", synopsis: (dna.incitingIncident || "").slice(0, 400), language: brand.language, genre: brand.genreFamily, styleBible, characters, beats };
}
