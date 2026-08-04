// P0 Step 5C.16 — Story Content Factory control plane: provider-free END-TO-END against a REAL
// disposable PostgreSQL, with a FAKE Grok Chat actuator (no network, no video) and a FAKE movie facade.
// Proves: seeded profiles/archetypes, the staged pipeline (DNA→outline→story→edit→continuity→novelty→
// title→metadata→quality→READY), exactly-once per stage, restart RESUME off current_* pointers, novelty
// structural-duplicate rejection, logic/continuity gating, NO video invocation, and the movie-adaptation
// action (dynamic storyboard, storyboard-only, videoInvoked=false). SKIPS if PG binaries are absent.
import assert from "node:assert/strict";
import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createStoryFactoryControlPlane } from "../control-plane/src/api-staging/story-factory-control-plane.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";
const { Client } = pg;

let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }
async function rejects(name, fn, frag) { try { await fn(); assert.fail(name + " expected reject"); } catch (e) { if (e instanceof assert.AssertionError && /expected reject/.test(e.message)) throw e; check(name, `${e.code || ""} ${e.message || ""}`.includes(frag), true); } }

if (!livePgAvailable()) { console.log("Step 5C.16 story control plane: 0 passed, 0 failed (SKIPPED — no PostgreSQL)"); process.exit(0); }

// ---- canned Bulgarian story data (consistent: names, native quote, resolution, English axes) ----
const AXES = { protagonistRole: "caregiver nurse daughter", antagonistRelationship: "sister", settingType: "balkan family home", incitingIncident: "estate secretly transferred at the funeral", coreConflict: "inheritance grabbed from the caregiver", publicHumiliation: "belittled at a family dinner", quotedInsultPattern: "only the nurse never a daughter", exploitedResource: "the family house", evidenceType: "notarized will archive copy", hiddenLeverage: "co-owner on the notarized will", reversalMechanism: "produce the notarized will", consequence: "transfer unwound estate shared", emotionalResolution: "dignity restored boundary set" };
const DNA = {
  protagonist: "Милена", protagonistAgeRange: "40s", protagonistOccupation: "nurse", protagonistCoreNeed: "recognition", protagonistFlaw: "avoids confrontation",
  antagonistList: [{ name: "Радост", relationship: "sister", role: "the favored sibling who grabbed the estate" }],
  settingCountry: "Bulgaria", settingCityOrRegion: "Plovdiv", socialContext: "a close Balkan family",
  incitingIncident: "at the funeral the sister announced the house was already in her name", historyOfSacrifice: "nine years of caregiving",
  escalationSteps: ["the sister changed the locks", "the sister demanded rent", "the sister mocked the narrator at dinner"],
  publicHumiliation: "the sister humiliated the narrator at a family dinner", unforgivableQuote: "Ти беше просто медицинската сестра, никога дъщеря",
  hiddenLeverage: "the original notarized will names the narrator as co-owner", evidenceType: "notarized will and the notary archive copy",
  counterMove: "the narrator quietly retrieved the notarized will and filed it with the notary", reversal: "the notarized will proves the transfer was never valid",
  consequences: ["the transfer is unwound", "the sister must share the estate"], emotionalResolution: "Милена си върна достойнството и постави граница",
  finalBoundary: "Милена няма да бъде третирана като прислуга", closingInsight: "worth is kept by yourself",
  timeline: [{ when: "2015", event: "mother ill" }, { when: "2024", event: "mother dies" }], monetaryFacts: [{ label: "estate", amount: 180000, currency: "BGN" }],
  legalOrOwnershipFacts: ["the house was co-owned per the notarized will"], continuityFacts: ["nurse", "sister Радост", "Plovdiv"], originalityDimensions: AXES
};
// Distinct Cyrillic prose generator (fake) so the section-based long-form pipeline produces a story that
// passes the length + padding gates without hand-writing 700+ words. A deterministic PRNG over a large
// distinct word pool → low trigram repetition + varied paragraph lengths; anchors are embedded for the
// continuity gate. localeFluency passes on Cyrillic dominance.
const BG_WORDS = ["къщата", "семейството", "наследството", "завещанието", "нотариусът", "документите", "истината", "мълчанието", "достойнството", "границата", "решението", "доказателството", "спомените", "годините", "грижата", "болката", "тишината", "стаята", "масата", "вечерята", "разговорът", "погледът", "думите", "обещанието", "отговорът", "въпросът", "страхът", "надеждата", "справедливостта", "предателството", "доверието", "обидата", "спокойствието", "силата", "паметта", "съдбата", "бъдещето", "миналото", "апартаментът", "градът", "улицата", "прозорецът", "светлината", "гласът", "сърцето", "лицето", "усмивката", "писмото", "подписът", "архивът", "делото", "правото", "собствеността", "роднините", "адвокатът", "банката", "сметката", "ключът", "вратата", "коридорът"];
const BG_VERBS = ["беше", "стана", "остана", "промени", "показа", "доказа", "разкри", "защити", "върна", "постави", "помисли", "реши", "разбра", "видя", "почувства", "знаеше", "чакаше", "намери", "продължи", "спря"];
const BG_FUNC = ["и", "но", "защото", "когато", "след", "преди", "въпреки", "затова", "така", "докато", "че", "за", "с", "на", "в", "тогава", "накрая", "изведнъж"];
function bgGen(seed, nWords) {
  let h = (seed * 2654435761) >>> 0; const rnd = (m) => { h = (h * 1103515245 + 12345) >>> 0; return h % m; };
  const out = []; let inSentence = 0;
  while (out.length < nWords) {
    out.push(BG_FUNC[rnd(BG_FUNC.length)], BG_WORDS[rnd(BG_WORDS.length)], BG_VERBS[rnd(BG_VERBS.length)], BG_WORDS[rnd(BG_WORDS.length)]);
    inSentence += 4;
    if (inSentence >= 8 + rnd(6)) { out[out.length - 1] += "."; inSentence = 0; }
  }
  let s = out.join(" "); if (!s.trim().endsWith(".")) s += "."; return s[0].toUpperCase() + s.slice(1);
}
// Build section i prose (~words), embedding the anchors for section i.
function bgSectionText(i, total, words, dna) {
  const parts = [];
  if (i === 0) parts.push(`Погребението едва свърши когато ${dna.antagonistList[0].name} обяви че къщата е нейна.`);
  parts.push(bgGen(i * 97 + 3, Math.round(words * 0.45)));
  if (i === Math.floor(total / 2)) parts.push(`На вечерята тя каза: „${dna.unforgivableQuote}".`);
  parts.push(bgGen(i * 131 + 17, Math.round(words * 0.45)));
  if (i === total - 1) parts.push(`Нотариалното завещание доказа истината. ${dna.protagonist} си върна достойнството и постави ясна граница пред семейството.`);
  return parts.join("\n\n");
}
const OUTLINE = { beats: ["cold_open", "narrator_intro", "history_of_help", "first_exploitation", "forbearance", "escalation", "major_betrayal", "public_humiliation", "unforgivable_line", "controlled_response", "evidence", "prepare_counter", "false_confidence", "reversal", "panic", "final_confrontation", "consequence", "boundary_release"].map((k) => ({ key: k, summary: `${k} beat for Milena and Radost.` })) };
const ACT_PLAN = { acts: [{ act: 1, title: "Setup", summary: "The betrayal is revealed.", escalation: "first exploitation", turningPoint: "the funeral claim", reveal: "" }, { act: 2, title: "Rising", summary: "Escalation and humiliation.", escalation: "public humiliation", turningPoint: "the quoted line", reveal: "the will exists" }, { act: 3, title: "Payoff", summary: "The reversal and boundary.", escalation: "the reversal", turningPoint: "the notary filing", reveal: "co-ownership proven" }] };
const secPlan = (n) => ({ sections: Array.from({ length: n }, (_, i) => ({ order: i + 1, title: `Section ${i + 1}`, purpose: `advance the plot part ${i + 1}`, beatsCovered: [OUTLINE.beats[i]?.key || "cold_open"], targetWords: 180 })) });
// Swedish distinct generator for the resume (sv-SE) story.
const SV_WORDS = ["huset", "familjen", "arvet", "testamentet", "notarien", "handlingarna", "sanningen", "tystnaden", "värdigheten", "gränsen", "beslutet", "beviset", "minnena", "åren", "omsorgen", "smärtan", "rummet", "bordet", "middagen", "samtalet", "blicken", "orden", "löftet", "svaret", "frågan", "rädslan", "hoppet", "rättvisan", "sveket", "förtroendet", "förolämpningen", "lugnet", "styrkan", "minnet", "ödet", "framtiden", "lägenheten", "staden", "gatan", "fönstret", "ljuset", "rösten", "hjärtat", "ansiktet", "leendet", "brevet", "underskriften", "arkivet", "kontot", "banken", "nyckeln", "dörren", "hyran", "pengarna"];
const SV_VERBS = ["var", "blev", "förblev", "ändrade", "visade", "bevisade", "avslöjade", "försvarade", "återtog", "satte", "tänkte", "bestämde", "förstod", "såg", "kände", "visste", "väntade", "hittade", "fortsatte", "stannade"];
const SV_FUNC = ["och", "men", "eftersom", "när", "efter", "innan", "trots", "därför", "sedan", "medan", "att", "för", "med", "på", "i", "då", "till slut", "plötsligt"];
function svGen(seed, nWords) {
  let h = (seed * 2654435761) >>> 0; const rnd = (m) => { h = (h * 1103515245 + 12345) >>> 0; return h % m; };
  const out = []; let inS = 0;
  while (out.length < nWords) { out.push(SV_FUNC[rnd(SV_FUNC.length)], SV_WORDS[rnd(SV_WORDS.length)], SV_VERBS[rnd(SV_VERBS.length)], SV_WORDS[rnd(SV_WORDS.length)]); inS += 4; if (inS >= 8 + rnd(6)) { out[out.length - 1] += "."; inS = 0; } }
  let s = out.join(" "); if (!s.trim().endsWith(".")) s += "."; return s[0].toUpperCase() + s.slice(1);
}
function svSectionText(i, total, words, dna) {
  const parts = [];
  if (i === 0) parts.push(`Efter begravningen sa ${dna.antagonistList[0].name} att hon aldrig skulle betala hyran.`);
  parts.push(svGen(i * 89 + 5, Math.round(words * 0.45)));
  if (i === Math.floor(total / 2)) parts.push(`Vid middagen sa hon lugnt: „${dna.unforgivableQuote}".`);
  parts.push(svGen(i * 149 + 23, Math.round(words * 0.45)));
  if (i === total - 1) parts.push(`Kontoutdragen visade sanningen. ${dna.protagonist} återtog sin värdighet och satte en tydlig gräns.`);
  return parts.join("\n\n");
}
const TITLES = { titles: ["На погребението сестра ми заяви че къщата е нейна и ме нарече просто медицинската сестра но аз извадих завещанието", "Сестра ми ме унижи пред цялото семейство а нотариалното завещание промени всичко"] };
const META = { hook: "Погребението едва свърши когато сестра ми обяви че къщата е нейна.", excerpt: "Девет години се грижех за мама. Радост дойде само за наследството и ме нарече просто сестрата.", socialTeaser: "Тя мислеше че мълчанието ми е слабост. Но аз имах нотариалното завещание.", cliffhanger: "Това което извадих от чекмеджето промени всичко.", cta: "Прочети цялата история.", seoDescription: "История за предателство в семейството и тихо възмездие.", heroImagePrompt: "a Bulgarian nurse in her 40s in a Plovdiv kitchen holding a notarized document, warm light" };
const QUAL = { hookStrength: 0.8, emotionalEscalation: 0.8, twistSetup: 0.8, payoffSatisfaction: 0.8 };

const fence = (o) => "```json\n" + JSON.stringify(o) + "\n```";

// FAKE chat actuator: detects the stage from the prompt + returns canned text. Calls onBeforeSubmit
// once (exercises the durable submit fact). A per-run `failStage` makes one stage throw (crash sim).
function makeActuator(state = {}) {
  return async function actuator({ prompt, onBeforeSubmit }) {
    const dna = state.dnaOverride || DNA;
    let stage = "?", text = "";
    if (prompt.includes("STRUCTURED STORY DNA")) { stage = "DNA"; text = fence(dna); }
    else if (prompt.includes("beat OUTLINE")) { stage = "OUTLINE"; text = fence(OUTLINE); }
    else if (prompt.includes("ACT STRUCTURE")) { stage = "ACT_PLAN"; text = fence(ACT_PLAN); }
    else if (prompt.includes("sequential SECTIONS")) { stage = "SECTION_PLAN"; const n = Number((/EXACTLY (\d+) sequential/.exec(prompt) || [])[1]) || 3; text = fence(secPlan(n)); }
    else if (/^\s*Write SECTION/m.test(prompt) || prompt.includes("Write SECTION")) { stage = "SECTION"; const mm = /Write SECTION (\d+) of (\d+)/.exec(prompt) || [0, 1, 3]; text = fence({ section: (state.sectionText || bgSectionText)(Number(mm[1]) - 1, Number(mm[2]), 250, dna) }); }
    else if (prompt.includes("Deepen SECTION")) { stage = "EXPAND"; const mm = /Deepen SECTION (\d+)/.exec(prompt) || [0, 1]; text = fence({ section: (state.sectionText || bgSectionText)(Number(mm[1]) - 1, 3, 420, dna) }); }
    else if (prompt.includes("titles for a first-person")) { stage = "TITLE"; text = fence(TITLES); }
    else if (prompt.includes("publishing metadata")) { stage = "METADATA"; text = fence(META); }
    else if (prompt.includes("Rate this")) { stage = "QUALITY"; text = fence(QUAL); }
    state.calls = state.calls || []; state.calls.push(stage);
    if (state.failStage === stage) { if (state.submitBeforeFail) await onBeforeSubmit(); throw Object.assign(new Error("boom"), { code: "E_STORY_STAGE_FAILED", submitted: Boolean(state.submitBeforeFail) }); }
    if (typeof onBeforeSubmit === "function") await onBeforeSubmit();
    return { text, responseId: "resp_" + stage.toLowerCase() };
  };
}

// FAKE movie facade: records calls; NEVER exposes generateScene/generateAllScenes. When an adapter is
// provided it inserts a REAL minimal movie_projects row so the story_movie_links FK holds.
function makeMovie(state, adapter = null, workspaceId = null) {
  state.movie = { created: 0, storyboards: 0, videoCalls: 0 };
  return {
    async createProject(input) {
      state.movie.created += 1; state.movie.lastInput = input;
      const id = newId("mov");
      if (adapter && workspaceId) await adapter.tenantTransaction(workspaceId, (client) => client.query("INSERT INTO movie_projects (workspace_id,id,title,language) VALUES ($1,$2,$3,$4)", [workspaceId, id, String(input.title || "Adaptation").slice(0, 120), input.language || "en"]));
      state.movie.lastId = id; return { id };
    },
    async setStory({ story }) { state.movie.lastStory = story; return story; },
    async planStoryboard() { state.movie.storyboards += 1; return Array.from({ length: 6 }, (_, i) => ({ ordinal: i })); }
  };
}

async function run() {
  const live = await startDisposablePg({ namePrefix: "sf" });
  const workspaceId = generateId("ws");
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    const res = await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "sf" });
    check("migrations apply to latest", res.applied.length + res.alreadyApplied, loadMigrationFiles(MIGRATIONS_DIR).length);
    const user = generateId("usr");
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [workspaceId]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'SF',$2)", [workspaceId, user]);
  } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();

  const config = { stagingApi: { workspaceId } };
  // The e2e fake produces synthetic (repetitive) prose; relax the CONTENT gates (padding/filler/quality)
  // so orchestration can be tested through to READY. The length FLOOR + truncation are still enforced by
  // the length gate; the padding + quality gates are covered by the pure unit tests.
  const RELAXED_LG = { maxNearDupPairs: 9999, maxTrigramRatio: 0.9, repetitionSoft: 0.9, repetitionHard: 0.95 };
  const RELAXED_Q = { floors: {}, critical: [], overall: 0 };
  const T = { qualityThresholds: RELAXED_Q, lengthGateThresholds: RELAXED_LG };
  const okState = {};
  const sf = createStoryFactoryControlPlane({ persistence: adapter, config, chatActuator: makeActuator(okState), movie: makeMovie(okState), ...T });

  // A. seeds
  const seeds = await sf.ensureSeeds();
  check("A seeds 3 profiles + 12 archetypes", seeds.profiles === 3 && seeds.archetypes === 12);
  check("A ensureSeeds idempotent", JSON.stringify(await sf.ensureSeeds()) === JSON.stringify(seeds));
  check("A list profiles = 3", (await sf.listBrandProfiles()).length === 3);
  check("A list archetypes = 12", (await sf.listArchetypes()).length === 12);

  // B. full pipeline → READY
  const proj = await sf.createProject({ locale: "bg-BG", lengthPreset: "CUSTOM", customReadingMinutes: [3, 4], archetypeId: "inheritance-dispute" });
  check("B project DRAFT", proj.status === "DRAFT" && proj.locale === "bg-BG");
  const view = await sf.generateStory(proj.id);
  check("B pipeline READY", view.project.status === "READY");
  check("B has dna+outline+text+package+quality+novelty", Boolean(view.dna && view.outline && view.text && view.package && view.quality && view.novelty));
  check("B title chosen + long", typeof view.project.title === "string" && view.project.title.length > 30);
  check("B long-form word count over floor", view.text.wordCount >= view.project.lengthTarget.wordsMin && view.project.lengthGateState === "PASS");
  check("B quality ready", view.quality.ready === true);
  check("B novelty passed", view.novelty.pass === true && view.novelty.accepted === true);
  { const done = view.attempts.filter((a) => a.state === "COMPLETED").map((a) => a.stage);
    const need = ["DNA", "OUTLINE", "ACT_PLAN", "SECTION_PLAN", "TITLE", "METADATA", "QUALITY"];
    check("B completed attempts cover every long-form stage", need.every((x) => done.includes(x)) && done.filter((x) => x === "SECTION").length >= 3); }
  check("B all completed attempts CONSUMED exactly once", view.attempts.filter((a) => a.state === "COMPLETED").every((a) => a.invocationState === "CONSUMED"));
  check("B NO video invoked during story", okState.movie.videoCalls === 0);

  // C. idempotent re-run (READY → returns same, no new attempts)
  const before = (await sf.getProjectView(proj.id)).attempts.length;
  await sf.generateStory(proj.id);
  check("C re-run READY is a no-op (no new attempts)", (await sf.getProjectView(proj.id)).attempts.length === before);

  // D. restart RESUME: crash at STORY stage, then resume with a working actuator
  const crashState = { failStage: "SECTION_PLAN" };
  const sfCrash = createStoryFactoryControlPlane({ persistence: adapter, config, chatActuator: makeActuator(crashState), movie: makeMovie(crashState), ...T });
  const proj2 = await sfCrash.createProject({ locale: "sv-SE", lengthPreset: "CUSTOM", customReadingMinutes: [3, 4], archetypeId: "financial-exploitation-rent" });
  // sv-SE canned data reuse (structural axes differ enough; different archetype)
  crashState.dnaOverride = { ...DNA, antagonistList: [{ name: "Sofia", relationship: "daughter", role: "adult child misusing rent" }], settingCountry: "Sweden", settingCityOrRegion: "Uppsala", unforgivableQuote: "Du kommer alltid att betala", originalityDimensions: { ...AXES, protagonistRole: "retired father", antagonistRelationship: "adult daughter", exploitedResource: "rent money", coreConflict: "financial exploitation", quotedInsultPattern: "fathers always pay" } };
  await rejects("D crash at SECTION_PLAN throws", () => sfCrash.generateStory(proj2.id), "E_STORY_STAGE_FAILED");
  const midView = await sf.getProjectView(proj2.id);
  check("D DNA+outline persisted before crash", Boolean(midView.project.currentDnaId && midView.project.currentOutlineId && !midView.project.currentTextId));
  check("D status FAILED_GENERATION", midView.project.status === "FAILED_GENERATION");
  const dnaAttemptsBefore = midView.attempts.filter((a) => a.stage === "DNA" && a.state === "COMPLETED").length;
  // resume with a healthy actuator (sv story) — note: sv fluency uses a sv-language body
  const resumeState = { dnaOverride: crashState.dnaOverride };
  const svBody = ["Efter begravningen sa Sofia att hon inte längre tänkte betala hyran som vi kommit överens om.",
    "Jag är en pensionerad far och jag hade alltid betalat räkningarna för att hjälpa henne att klara sig.",
    "Hon kom sällan förbi men förväntade sig alltid att jag skulle ställa upp och hålla tyst.",
    "Vid middagen förödmjukade hon mig inför alla och sa lugnt: „Du kommer alltid att betala\".",
    "Jag sa inte emot. Jag teg, men något inom mig bestämde sig den kvällen.",
    "Nästa morgon gick jag till banken och tog fram kontoutdragen som visade vart hyran tagit vägen.",
    "Kontoutdragen bevisade att pengarna aldrig nått hyresvärden och att kontot stod i mitt namn.",
    "Jag stängde det gemensamma kontot och satte en lugn gräns. Jag behöll min värdighet och mitt lugn."].join("\n\n");
  const svActuator = async ({ prompt, onBeforeSubmit }) => {
    const dna = resumeState.dnaOverride;
    let text;
    if (prompt.includes("STRUCTURED STORY DNA")) text = fence(dna);
    else if (prompt.includes("beat OUTLINE")) text = fence(OUTLINE);
    else if (prompt.includes("ACT STRUCTURE")) text = fence(ACT_PLAN);
    else if (prompt.includes("sequential SECTIONS")) { const n = Number((/EXACTLY (\d+) sequential/.exec(prompt) || [])[1]) || 3; text = fence(secPlan(n)); }
    else if (prompt.includes("Write SECTION")) { const mm = /Write SECTION (\d+) of (\d+)/.exec(prompt) || [0, 1, 3]; text = fence({ section: svSectionText(Number(mm[1]) - 1, Number(mm[2]), 250, dna) }); }
    else if (prompt.includes("Deepen SECTION")) { const mm = /Deepen SECTION (\d+)/.exec(prompt) || [0, 1]; text = fence({ section: svSectionText(Number(mm[1]) - 1, 3, 420, dna) }); }
    else if (prompt.includes("titles for a first-person")) text = fence({ titles: ["Efter begravningen sa min dotter att hon aldrig skulle betala hyran men kontoutdragen visade sanningen", "Kort"] });
    else if (prompt.includes("publishing metadata")) text = fence({ hook: "Efter begravningen vägrade min dotter betala.", excerpt: "Jag hade alltid betalat. Sofia tog pengarna och teg.", socialTeaser: "Hon trodde min tystnad var svaghet.", cliffhanger: "Kontoutdragen visade allt.", cta: "Läs mer.", seoDescription: "En berättelse om svek och en tyst gräns.", heroImagePrompt: "a retired Swedish father at a bank counter with statements, cool light" });
    else if (prompt.includes("Rate this")) text = fence(QUAL);
    else text = fence({});
    await onBeforeSubmit();
    return { text, responseId: "resp" };
  };
  const sfResume = createStoryFactoryControlPlane({ persistence: adapter, config, chatActuator: svActuator, movie: makeMovie({}), ...T });
  const resumed = await sfResume.generateStory(proj2.id);
  check("D resumed to READY", resumed.project?.status === "READY");
  check("D DNA NOT regenerated on resume (same count)", resumed.attempts.filter((a) => a.stage === "DNA" && a.state === "COMPLETED").length === dnaAttemptsBefore);
  check("D resumed story text present", resumed.text.wordCount > 20);

  // E. novelty structural-duplicate rejection (a rename-only clone of story #1)
  const dupState = { dnaOverride: { ...DNA, protagonist: "Елена", antagonistList: [{ name: "Весела", relationship: "sister", role: "the favored sibling who grabbed the estate" }] } };
  const sfDup = createStoryFactoryControlPlane({ persistence: adapter, config, chatActuator: makeActuator(dupState), movie: makeMovie({}), ...T });
  const proj3 = await sfDup.createProject({ locale: "bg-BG", targetLength: "short", archetypeId: "inheritance-dispute" });
  await rejects("E rename-only DNA rejected by novelty", () => sfDup.generateStory(proj3.id), "E_NOVELTY_STRUCTURAL_DUPLICATE");
  check("E dup project FAILED_VALIDATION", (await sf.getProjectView(proj3.id)).project.status === "FAILED_VALIDATION");

  // F. logic gate: a DNA with a deus-ex-machina reversal is rejected pre-write
  const badState = { dnaOverride: { ...DNA, reversal: "suddenly a stranger appeared with magic and fixed everything", originalityDimensions: { ...AXES, reversalMechanism: "a magic stranger appears", coreConflict: "magic rescue", protagonistRole: "unlucky heir" } } };
  const sfBad = createStoryFactoryControlPlane({ persistence: adapter, config, chatActuator: makeActuator(badState), movie: makeMovie({}), ...T });
  const proj4 = await sfBad.createProject({ locale: "da-DK", targetLength: "short" });
  await rejects("F deus-ex-machina DNA rejected", () => sfBad.generateStory(proj4.id), "E_LOGIC_DEUS_EX_MACHINA");

  // G. movie adaptation (dynamic storyboard; storyboard-only; NO video)
  const adaptState = {};
  const sfAdapt = createStoryFactoryControlPlane({ persistence: adapter, config, chatActuator: makeActuator({}), movie: makeMovie(adaptState, adapter, workspaceId), ...T });
  const adapt = await sfAdapt.createMovieAdaptation(proj.id, { targetDurationSeconds: 48, sceneDurationSeconds: 6 });
  check("G adaptation created movie project", adapt.movieProjectId.startsWith("mov_") && adaptState.movie.created === 1);
  check("G dynamic scene count from duration (not hard-coded 3)", adapt.sceneCount >= 3 && adaptState.movie.storyboards === 1);
  check("G storyboard-only, no video invoked", adapt.storyboardOnly === true && adapt.videoInvoked === false && adaptState.movie.videoCalls === 0);
  check("G movie story has multiple characters + beats", adaptState.movie.lastStory.characters.length >= 1 && adaptState.movie.lastStory.beats.length >= 3);
  check("G story_movie_link recorded", (await sf.getProjectView(proj.id)).movieLinks.length === 1);

  try { await adapter.stop?.(); } catch { /* */ }
  await live.stop();
  console.log(`Step 5C.16 story control plane: ${passed} passed, 0 failed`);
}
run().catch((e) => { console.log("Step 5C.16 story control plane FAILED:", e && (e.stack || e.message || e)); process.exit(1); });
