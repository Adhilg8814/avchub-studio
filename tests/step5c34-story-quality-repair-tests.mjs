// P0 Step 5C.34 — STORY QUALITY REPAIR on a REAL disposable PostgreSQL (provider-free).
//
// The defect, stated exactly: a story whose prose was finished — 2932 Danish words, six sections, every
// stage COMPLETED — was recorded as FAILED_GENERATION, the status that means the model produced nothing.
// It had produced everything. A quality gate had declined it, and a catch handler that guessed at the
// meaning of error CODES relabelled the verdict on its way out.
//
// What this suite pins:
//   * semantics   — output + failed quality gate => QUALITY_REPAIR_REQUIRED; NO output => FAILED_GENERATION.
//                   The distinction is drawn from whether prose exists, never from a regex over codes.
//   * cost        — re-evaluating an existing draft with the corrected detector spends ZERO provider calls
//                   and is recorded as RE_EVALUATED, so an audit can tell a re-judgement from a rewrite.
//   * bounds      — at most two repair attempts, enforced by a UNIQUE(project, attempt) row, not a counter
//                   that a crash could lose.
//   * concurrency — two callers racing a repair produce exactly one repair.
//   * immutability— the draft the model wrote is never mutated; a repair writes a NEW version and the
//                   ledger records which version it came from.
//   * no clones   — a repair never creates a second story project.
//   * guardrails  — a "repair" that translates the story, drops a character, halves the length or breaks
//                   continuity is REFUSED and the original stays current.
//   * restart     — the whole thing is idempotent: re-running a completed repair changes nothing.

import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createStoryFactoryControlPlane } from "../control-plane/src/api-staging/story-factory-control-plane.mjs";
import { storyRepository as repo } from "../control-plane/src/persistence/repositories/story-repository.mjs";
import { generateId } from "../lib/protocol/ids.mjs";

const { Client } = pg;
let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
async function refuses(name, fn, code) {
  try { await fn(); check(name, false); }
  catch (e) { const got = String(e?.code || ""); if (got === code || got.startsWith(code)) passed += 1; else { failed += 1; console.log("FAIL", name, "->", got || e?.message); } }
}

if (!livePgAvailable()) { console.log("Step 5C.34 story quality repair: 0 passed, 0 failed (SKIPPED — no PostgreSQL)"); process.exit(0); }

// ================================================================ fixtures
const DNA = {
  protagonist: "Karen", protagonistAgeRange: "60s", protagonistOccupation: "retired teacher",
  protagonistCoreNeed: "respect", protagonistFlaw: "keeps the peace",
  antagonistList: [{ name: "Jesper", relationship: "son", role: "the son who took the account" }],
  settingCountry: "Denmark", settingCityOrRegion: "Aarhus", socialContext: "a Danish family",
  incitingIncident: "at the midsummer dinner Jesper called me petty in front of everyone",
  historyOfSacrifice: "twelve years of childcare",
  escalationSteps: ["Jesper took the card", "Jesper moved the money", "Jesper mocked me at dinner"],
  publicHumiliation: "Jesper humiliated me at the midsummer dinner",
  unforgivableQuote: "Du er bare en gammel dame med et kort",
  hiddenLeverage: "the account statements name me as the only holder",
  evidenceType: "bank statements", counterMove: "I printed the statements",
  reversal: "the statements prove the account was always mine",
  consequences: ["the transfers are reversed"], emotionalResolution: "Karen fik sin værdighed tilbage og satte en grænse",
  finalBoundary: "Karen bliver ikke behandlet som en pengeautomat", closingInsight: "worth is kept by yourself",
  timeline: [{ when: "2012", event: "childcare begins" }, { when: "2025", event: "the dinner" }],
  monetaryFacts: [{ label: "account", amount: 240000, currency: "DKK" }],
  legalOrOwnershipFacts: ["the account is in Karen's name"], continuityFacts: ["teacher", "son Jesper", "Aarhus"],
  originalityDimensions: { protagonistRole: "retired teacher grandmother", antagonistRelationship: "son", settingType: "danish family home", incitingIncident: "account emptied before midsummer", coreConflict: "savings taken by the son", publicHumiliation: "belittled at the midsummer dinner", quotedInsultPattern: "just an old lady with a card", exploitedResource: "the savings account", evidenceType: "bank statements", hiddenLeverage: "sole account holder", reversalMechanism: "produce the statements", consequence: "transfers reversed", emotionalResolution: "dignity restored boundary set" }
};

// Deterministic Danish-looking prose with genuinely LOW repetition.
//
// A random draw from a small word pool is not "varied" — it repeats trigrams and produces near-duplicate
// paragraphs, which is exactly what a padding detector is built to notice. So the vocabulary is expanded
// morphologically to 240 nouns and every paragraph is given a DISJOINT twenty-noun window: paragraphs
// share function words and verbs, as Danish requires, and almost nothing else.
//
// Worth noting what this fixture measures at: the historical repeated-trigram ratio calls it 0.083 —
// comfortably over the old 0.05 threshold, i.e. the old gate would have condemned it — while the
// language-aware score is 0.008. It is the defect in miniature.
const DA_N = ["huset", "familien", "arven", "testamentet", "notaren", "papirerne", "sandheden", "tavsheden", "værdigheden", "grænsen", "beslutningen", "beviset", "minderne", "årene", "omsorgen", "smerten", "stuen", "bordet", "middagen", "samtalen", "blikket", "ordene", "løftet", "svaret", "spørgsmålet", "frygten", "håbet", "retfærdigheden", "sveget", "tilliden", "fornærmelsen", "roen", "styrken", "skæbnen", "fremtiden", "lejligheden", "byen", "gaden", "vinduet", "lyset", "stemmen", "hjertet", "ansigtet", "smilet", "brevet", "underskriften", "arkivet", "kontoen", "banken", "nøglen", "døren", "huslejen", "pengene", "kortet", "kvitteringen", "regningen", "skuffen", "gangen", "haven", "trappen"];
const DA_NX = DA_N.flatMap((w) => { const st = w.replace(/(en|et|ne)$/u, ""); return [w, st + "erne", st + "ets", st + "ernes"]; });
const DA_A = ["gamle", "tunge", "stille", "kolde", "lange", "tomme", "nye", "mørke", "varme", "tørre", "skarpe", "bløde", "fjerne", "små", "store", "hvide", "grå", "åbne", "lukkede", "ru", "trætte", "rolige", "hårde", "lyse"];
const DA_V = ["var", "blev", "forblev", "ændrede", "viste", "beviste", "afslørede", "forsvarede", "tog", "satte", "tænkte", "besluttede", "forstod", "så", "mærkede", "vidste", "ventede", "fandt", "fortsatte", "standsede"];
const DA_F = ["og", "men", "fordi", "da", "efter", "før", "trods", "derfor", "siden", "mens", "at", "for", "med", "på", "i", "så", "til sidst", "pludselig"];
let paragraphNo = 0;
function daGen(nWords) {
  const p = (paragraphNo += 1);
  const win = p % 12;
  const N = DA_NX.slice(win * 20, win * 20 + 20);
  const A = DA_A.slice((p * 7) % 20, ((p * 7) % 20) + 5);
  const out = []; let inS = 0, k = 0;
  while (out.length < nWords) {
    k += 1;
    out.push(DA_F[k % DA_F.length], A[(k * 3) % A.length], N[(k * 2) % N.length], DA_V[(k * 13) % DA_V.length], A[(k * 5 + 1) % A.length], N[(k * 7 + 1) % N.length]);
    inS += 6;
    if (inS >= 12) { out[out.length - 1] += "."; inS = 0; }
  }
  let s = out.join(" "); if (!s.trim().endsWith(".")) s += ".";
  return s[0].toUpperCase() + s.slice(1);
}
function daSection(i, total, words, dna) {
  const parts = [];
  if (i === 0) parts.push(`Til midsommermiddagen sagde ${dna.antagonistList[0].name} at kortet var hans.`);
  parts.push(daGen(Math.round(words * 0.45)));
  if (i === Math.floor(total / 2)) parts.push(`Ved bordet sagde han roligt: „${dna.unforgivableQuote}".`);
  parts.push(daGen(Math.round(words * 0.45)));
  if (i === total - 1) parts.push(`Kontoudtogene viste sandheden. ${dna.protagonist} fik sin værdighed tilbage og satte en klar grænse over for familien.`);
  return parts.join("\n\n");
}
// The same story, but PADDED: one content sentence repeated to inflate the count. This is what the gate
// must still refuse, in the same language that produced the false positive.
function daPaddedSection(i, total, words, dna) {
  const filler = "Hun kiggede på det gamle fotografi af sommerhuset ved kysten og mærkede den samme tunge sorg i brystet.";
  const base = daSection(i, total, Math.round(words * 0.35), dna);
  return base + " " + Array.from({ length: 12 }, () => filler).join(" ");
}

const OUTLINE = { beats: ["cold_open", "narrator_intro", "history_of_help", "first_exploitation", "forbearance", "escalation", "major_betrayal", "public_humiliation", "unforgivable_line", "controlled_response", "evidence", "prepare_counter", "false_confidence", "reversal", "panic", "final_confrontation", "consequence", "boundary_release"].map((k) => ({ key: k, summary: `${k} beat for Karen and Jesper.` })) };
const ACT_PLAN = { acts: [{ act: 1, title: "Setup", summary: "The betrayal is revealed.", escalation: "first exploitation", turningPoint: "the dinner", reveal: "" }, { act: 2, title: "Rising", summary: "Escalation.", escalation: "public humiliation", turningPoint: "the quoted line", reveal: "the statements exist" }, { act: 3, title: "Payoff", summary: "The reversal.", escalation: "the reversal", turningPoint: "the filing", reveal: "sole holder proven" }] };
const secPlan = (n) => ({ sections: Array.from({ length: n }, (_, i) => ({ order: i + 1, title: `Sektion ${i + 1}`, purpose: `før handlingen videre del ${i + 1}`, beatsCovered: [OUTLINE.beats[i]?.key || "cold_open"], targetWords: 200 })) });
const TITLES = { titles: ["Da min søn Jesper kaldte mig en gammel dame med et kort tog jeg stille kampen op om min konto", "Min søn tømte kontoen og kaldte mig smålig men kontoudtogene fortalte en anden historie"] };
const META = { hook: "Til midsommermiddagen sagde min søn at kortet var hans.", excerpt: "Tolv år passede jeg hans børn. Så tog han kontoen og kaldte mig en gammel dame.", socialTeaser: "Han troede min tavshed var svaghed. Men jeg havde kontoudtogene.", cliffhanger: "Det jeg lagde på bordet ændrede alt.", cta: "Læs hele historien.", seoDescription: "En historie om svigt i familien og stille oprejsning.", heroImagePrompt: "a Danish woman in her 60s at a kitchen table holding bank statements, warm light" };
const fence = (o) => "```json\n" + JSON.stringify(o) + "\n```";

// Every project needs a STRUCTURALLY DISTINCT story: the novelty gate is real and refuses a second story
// built on the same thirteen originality axes. Varying the names alone is not enough — the axes are what
// it compares — so each variant shifts the cast, the city, the asset and the evidence together.
const CAST = ["Karen", "Birgitte", "Solveig", "Mette", "Hanne", "Lone", "Inger", "Kirsten", "Ellen", "Gudrun"];
const SONS = ["Jesper", "Mads", "Anders", "Rasmus", "Søren", "Frederik", "Niels", "Kasper", "Villads", "Emil"];
const CITY = ["Aarhus", "Odense", "Aalborg", "Esbjerg", "Randers", "Kolding", "Horsens", "Vejle", "Roskilde", "Herning"];
const ASSET = ["sommerhuset", "andelslejligheden", "sparekontoen", "gården", "værkstedet", "båden", "grunden", "forretningen", "bilsamlingen", "jagthytten"];
const PROOF = ["kontoudtogene", "skødet", "testamentet", "lejekontrakten", "revisorrapporten", "sms-korrespondancen", "notarpapirerne", "forsikringspolicen", "bankfuldmagten", "skifteretsakterne"];
const ROLE = ["retired teacher", "retired nurse", "retired midwife", "retired librarian", "retired baker", "retired seamstress", "retired postmistress", "retired bookkeeper", "retired florist", "retired weaver"];
let variantSeq = 0;
function dnaVariant() {
  const v = variantSeq += 1;
  const i = v % CAST.length;
  return {
    ...DNA,
    protagonist: CAST[i], protagonistOccupation: ROLE[i],
    antagonistList: [{ ...DNA.antagonistList[0], name: SONS[i] }],
    settingCityOrRegion: CITY[i],
    incitingIncident: `ved midsommermiddagen i ${CITY[i]} kaldte ${SONS[i]} mig smålig foran alle om ${ASSET[i]}`,
    escalationSteps: [`${SONS[i]} tog nøglen til ${ASSET[i]}`, `${SONS[i]} flyttede pengene`, `${SONS[i]} hånede mig ved middagen`],
    hiddenLeverage: `${PROOF[i]} viser at ${ASSET[i]} altid har været mit`,
    evidenceType: PROOF[i],
    counterMove: `jeg printede ${PROOF[i]}`,
    reversal: `${PROOF[i]} beviser at overdragelsen aldrig var gyldig`,
    emotionalResolution: `${CAST[i]} fik sin værdighed tilbage og satte en grænse`,
    finalBoundary: `${CAST[i]} bliver ikke behandlet som en pengeautomat`,
    continuityFacts: [ROLE[i], `son ${SONS[i]}`, CITY[i]],
    originalityDimensions: {
      ...DNA.originalityDimensions,
      protagonistRole: `${ROLE[i]} grandmother v${v}`,
      settingType: `danish family home in ${CITY[i]}`,
      incitingIncident: `${ASSET[i]} taken before midsummer v${v}`,
      coreConflict: `${ASSET[i]} taken by the son v${v}`,
      exploitedResource: ASSET[i], evidenceType: PROOF[i],
      hiddenLeverage: `sole owner of ${ASSET[i]}`, reversalMechanism: `produce ${PROOF[i]}`
    }
  };
}

// FAKE Grok Chat actuator. `state.sectionText` chooses clean or padded prose; `state.repairText` is what a
// repair returns; every call is counted so "zero provider calls" can be ASSERTED, not assumed.
function makeActuator(state = {}) {
  state.calls = [];
  state.dna = state.dna || dnaVariant();
  return async function actuator({ prompt, onBeforeSubmit }) {
    let stage = "?", text = "";
    if (prompt.includes("STRUCTURED STORY DNA")) { stage = "DNA"; text = fence(state.dna); }
    else if (prompt.includes("beat OUTLINE")) { stage = "OUTLINE"; text = fence(OUTLINE); }
    else if (prompt.includes("ACT STRUCTURE")) { stage = "ACT_PLAN"; text = fence(ACT_PLAN); }
    else if (prompt.includes("sequential SECTIONS")) { stage = "SECTION_PLAN"; const n = Number((/EXACTLY (\d+) sequential/.exec(prompt) || [])[1]) || 3; text = fence(secPlan(n)); }
    else if (prompt.includes("It is GOOD. Do not rewrite it")) { stage = "REPAIR"; text = fence({ story: state.repairText || "" }); }
    else if (prompt.includes("Write SECTION")) { stage = "SECTION"; const mm = /Write SECTION (\d+) of (\d+)/.exec(prompt) || [0, 1, 3]; text = fence({ section: (state.sectionText || daSection)(Number(mm[1]) - 1, Number(mm[2]), state.sectionWords || 320, state.dna) }); }
    else if (prompt.includes("Deepen SECTION")) { stage = "EXPAND"; const mm = /Deepen SECTION (\d+)/.exec(prompt) || [0, 1]; text = fence({ section: (state.expandText || ((i) => daSection(i, 3, 560, state.dna)))(Number(mm[1]) - 1) }); }
    else if (prompt.includes("titles for a first-person")) { stage = "TITLE"; text = fence(TITLES); }
    else if (prompt.includes("publishing metadata")) { stage = "METADATA"; text = fence(META); }
    else if (prompt.includes("Rate this")) { stage = "QUALITY"; text = fence({ hookStrength: 0.8, emotionalEscalation: 0.8, twistSetup: 0.8, payoffSatisfaction: 0.8 }); }
    state.calls.push(stage);
    if (state.failStage === stage) throw Object.assign(new Error("provider down"), { code: "E_STORY_STAGE_FAILED" });
    if (typeof onBeforeSubmit === "function") await onBeforeSubmit();
    return { text, responseId: "resp_" + stage.toLowerCase() };
  };
}

// ================================================================ harness
const live = await startDisposablePg({ namePrefix: "sq34" });
let adapter = null;
try {
  const ws = generateId("ws"), user = generateId("usr");
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
    const res = await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c34" });
    check("R0 migrations apply to the shipped head (includes 0037)", res.applied.length + res.alreadyApplied === loadMigrationFiles(MIGRATIONS_DIR).length);
    // The migration must be re-runnable: production applies it while the old runtime is still serving.
    const again = await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c34" });
    check("R0 re-running the migration set is a no-op (idempotent)", again.applied.length === 0);
    const cols = await mc.query("SELECT column_name FROM information_schema.columns WHERE table_name='story_projects' AND column_name IN ('quality_repair_count','quality_verdict')");
    check("R0 the project carries a repair counter and a durable verdict", cols.rowCount === 2);
    const st = await mc.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='story_projects_status_check'");
    check("R0 QUALITY_REPAIR_REQUIRED is a legal status", st.rows[0].d.includes("QUALITY_REPAIR_REQUIRED"));
    check("R0 every previously legal status is still legal", ["READY", "FAILED_GENERATION", "FAILED_VALIDATION", "NEEDS_REVIEW", "ARCHIVED", "DRAFT", "WRITING"].every((x) => st.rows[0].d.includes(`'${x}'`)));
    const rls = await mc.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='story_quality_repairs'");
    check("R0 the repair ledger is RLS-protected and FORCEd", rls.rows[0].relrowsecurity === true && rls.rows[0].relforcerowsecurity === true);
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'SQ',$2)", [ws, user]);
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const T = (fn) => adapter.tenantTransaction(ws, fn);
  const config = { stagingApi: { workspaceId: ws } };
  // Only the scorecard is relaxed (the fake prose is synthetic, so its narrative dimensions mean nothing)
  // and the PARAGRAPH-duplication gate, which is a separate structural check that a deterministic word-pool
  // generator trips by construction. The REPETITION band under test keeps its shipped values.
  const RELAXED_Q = { floors: {}, critical: [], overall: 0 };
  const LG = { maxNearDupPairs: 9999 };

  const mkCp = (state) => createStoryFactoryControlPlane({
    persistence: adapter, config, chatActuator: makeActuator(state), qualityThresholds: RELAXED_Q, lengthGateThresholds: LG
  });

  const newProject = async (cp) => {
    await cp.ensureSeeds();
    const profiles = await cp.listBrandProfiles();
    const brand = profiles.find((p) => p.locale === "da-DK") || profiles[0];
    const p = await cp.createProject({ brandProfileId: brand.id, country: "DK", locale: brand.locale, lengthPreset: "SHORT", seedIdea: "midsummer account" });
    return p.id;
  };

  // ============================================================ 1. semantics: padded output is NOT a generation failure
  const padded = { sectionText: daPaddedSection, sectionWords: 700 };
  const cpPad = mkCp(padded);
  const idPad = await newProject(cpPad);
  await refuses("R1 a padded draft fails the quality gate", () => cpPad.generateStory(idPad), "E_STORY_PADDED_REPETITION");
  let vPad = await cpPad.getProjectView(idPad);
  check("R1 the project is QUALITY_REPAIR_REQUIRED, NOT FAILED_GENERATION", vPad.project.status === "QUALITY_REPAIR_REQUIRED");
  check("R1 the prose the model wrote is on disk", Boolean(vPad.text && vPad.text.storyText && vPad.text.wordCount > 200));
  check("R1 the verdict is durable and explains itself", Boolean(vPad.project.qualityVerdict && vPad.project.qualityVerdict.repetition && vPad.project.qualityVerdict.repetition.explanation));
  check("R1 the verdict names the repeated spans with offsets", (vPad.project.qualityVerdict.repetition.spans || []).length > 0
    && vPad.project.qualityVerdict.repetition.spans[0].offsets.length > 0);
  check("R1 the verdict says it is repairable", vPad.project.qualityVerdict.repairable === true);
  check("R1 an event records the decision", vPad.events.some((e) => e.type === "STORY_QUALITY_REPAIR_REQUIRED"));

  // ============================================================ 2. a REAL provider failure is still a generation failure
  const dead = { failStage: "DNA" };
  const cpDead = mkCp(dead);
  const idDead = await newProject(cpDead);
  await refuses("R2 a provider failure propagates", () => cpDead.generateStory(idDead), "E_STORY_STAGE_FAILED");
  const vDead = await cpDead.getProjectView(idDead);
  check("R2 no output => FAILED_GENERATION (the label keeps its meaning)", vDead.project.status === "FAILED_GENERATION");
  check("R2 there is genuinely nothing to repair", !vDead.project.currentTextId);
  await refuses("R2 repairing a project with no output is refused", () => cpDead.repairStoryQuality(idDead), "E_STORY_NO_OUTPUT_TO_REPAIR");

  // ============================================================ 3. repair attempt 1 = re-evaluation, ZERO provider calls
  // A clean draft that a MIS-CALIBRATED gate rejected: generate with a deliberately paranoid threshold, then
  // repair under the shipped one. This is exactly the production case — the prose never needed touching.
  const clean = { sectionText: daSection, sectionWords: 320 };
  const cpParanoid = createStoryFactoryControlPlane({
    persistence: adapter, config, chatActuator: makeActuator(clean), qualityThresholds: RELAXED_Q,
    lengthGateThresholds: { ...LG, repetitionSoft: 0.0001, repetitionHard: 0.0002 }   // rejects any repetition at all
  });
  const idClean = await newProject(cpParanoid);
  await refuses("R3 the paranoid gate rejects a clean draft", () => cpParanoid.generateStory(idClean), "E_STORY_PADDED_REPETITION");
  check("R3 which lands as QUALITY_REPAIR_REQUIRED", (await cpParanoid.getProjectView(idClean)).project.status === "QUALITY_REPAIR_REQUIRED");

  const reeval = { sectionText: daSection, sectionWords: 320 };
  const cpNormal = mkCp(reeval);
  const callsBefore = reeval.calls.length;
  const vFixed = await cpNormal.repairStoryQuality(idClean);
  check("R3 the repair drives the story to READY", vFixed.project.status === "READY");
  check("R3 the missing title was restored", typeof vFixed.project.title === "string" && vFixed.project.title.length > 10);
  const repairs = await T((c) => repo.listQualityRepairs(c, ws, idClean));
  check("R3 exactly one repair attempt was recorded", repairs.length === 1 && repairs[0].attempt === 1);
  check("R3 recorded as RE_EVALUATED (a re-judgement, not a rewrite)", repairs[0].outcome === "RE_EVALUATED");
  check("R3 with ZERO provider calls charged to the repair", repairs[0].providerCalls === 0);
  check("R3 the repair points at the version it judged", repairs[0].sourceTextId === repairs[0].resultTextId);
  const titleMetaOnly = reeval.calls.slice(callsBefore);
  check("R3 the only provider calls were the stages that had never run (title, metadata)",
    titleMetaOnly.every((s) => s === "TITLE" || s === "METADATA") && titleMetaOnly.includes("TITLE") && titleMetaOnly.includes("METADATA"));
  check("R3 the prose was never re-generated", !titleMetaOnly.includes("SECTION") && !titleMetaOnly.includes("REPAIR"));

  // ============================================================ 4. the draft is immutable; no duplicate project
  const versions = await T((c) => c.query("SELECT id, version, story_text FROM story_text_versions WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY version", [ws, idClean]));
  check("R4 the original draft is still version 1, unmodified", versions.rows.length >= 1 && versions.rows[0].version === 1);
  check("R4 a re-evaluation did not write a new version at all", versions.rows.length === 1);
  const projects = await cpNormal.listProjects();
  check("R4 no duplicate story project was created", projects.filter((p) => p.id === idClean).length === 1);

  // ============================================================ 5. idempotency + restart safety
  const again2 = await cpNormal.repairStoryQuality(idClean);
  check("R5 repairing a READY story is a no-op that returns the view", again2.project.status === "READY");
  check("R5 and does not consume a second attempt", (await T((c) => repo.listQualityRepairs(c, ws, idClean))).length === 1);

  // ============================================================ 6. concurrency: two callers, one repair
  const cpA = mkCp({ sectionText: daPaddedSection, sectionWords: 700 });
  const idRace = await newProject(cpA);
  await refuses("R6 a padded draft for the race", () => cpA.generateStory(idRace), "E_STORY_PADDED_REPETITION");
  // Both racers share the project; each is given a real but rejectable repair so the race is decided by the
  // attempt claim, never by one of them happening to fail earlier.
  const SHORT_REPAIR = daSection(0, 3, 120, dnaVariant());
  const stB = { sectionText: daPaddedSection, sectionWords: 700, repairText: SHORT_REPAIR };
  const stC = { sectionText: daPaddedSection, sectionWords: 700, repairText: SHORT_REPAIR };
  const cpB = mkCp(stB);
  const cpC = mkCp(stC);
  const results = await Promise.allSettled([cpB.repairStoryQuality(idRace), cpC.repairStoryQuality(idRace)]);
  const inProgress = results.filter((r) => r.status === "rejected" && r.reason?.code === "E_STORY_REPAIR_IN_PROGRESS").length;
  const other = results.filter((r) => r.status === "rejected" && r.reason?.code !== "E_STORY_REPAIR_IN_PROGRESS").length;
  check("R6 exactly one caller wins the attempt; the other is told it is already running", inProgress === 1 || (inProgress === 0 && other === 2));
  const raceRepairs = await T((c) => repo.listQualityRepairs(c, ws, idRace));
  check("R6 only ONE repair row exists for attempt 1 (the unique constraint is the primitive)",
    raceRepairs.filter((r) => r.attempt === 1).length === 1);

  // ============================================================ 7. guardrails: a drifting "repair" is refused
  const badRepairs = [
    ["translated into another language", (src) => "I stayed at the table after the others had gone. " + "There was something in the quiet that kept me from standing up. ".repeat(Math.ceil(src.split(/\s+/u).length / 13)), "E_REPAIR_LOCALE_DRIFT"],
    ["shortened to remove the repetition", (src) => src.slice(0, Math.floor(src.length * 0.4)), "E_REPAIR"],
    ["dropped a character", (src, dna) => src.split(dna.antagonistList[0].name).join("manden").split(dna.protagonist).join("kvinden"), "E_REPAIR_LOST_CHARACTER"]
  ];
  for (const [label, makeText, code] of badRepairs) {
    // Each bad repair gets its own project so the attempt bound is not the thing being measured.
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const cp = mkCp(st);
    const id = await newProject(cp);
    await refuses(`R7 setup (${label})`, () => cp.generateStory(id), "E_STORY_PADDED_REPETITION");
    const src = (await cp.getProjectView(id)).text.storyText;
    st.repairText = makeText(src, st.dna);
    await refuses(`R7 a repair that ${label} is REFUSED`, () => cp.repairStoryQuality(id), code);
    const v = await cp.getProjectView(id);
    const rows = await T((c) => c.query("SELECT id, version FROM story_text_versions WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY version", [ws, id]));
    check(`R7 the refused draft is kept for audit (${label})`, rows.rows.length === 2);
    check(`R7 but the ORIGINAL is still current (${label})`, v.project.currentTextId === rows.rows[0].id);
    check(`R7 and the ledger records why (${label})`, (await T((c) => repo.listQualityRepairs(c, ws, id)))[0].outcome === "STILL_FAILING");
  }

  // ============================================================ 8. a GOOD repair lands, and the bound holds
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const cp = mkCp(st);
    const id = await newProject(cp);
    await refuses("R8 setup: a padded draft", () => cp.generateStory(id), "E_STORY_PADDED_REPETITION");
    // An HONEST repair: the same story, the same cast, the same length band — with the filler rewritten.
    const src = await cp.getProjectView(id);
    st.repairText = [0, 1, 2, 3, 4, 5].map((i) => daSection(i, 6, Math.round(src.text.wordCount / 6 / 0.9), st.dna)).join("\n\n");
    const before = await cp.getProjectView(id);
    const after = await cp.repairStoryQuality(id);
    check("R8 a valid repair drives the story to READY", after.project.status === "READY");
    check("R8 the repaired text became current", after.project.currentTextId !== before.project.currentTextId);
    const rows = await T((c) => c.query("SELECT id, version, story_text FROM story_text_versions WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY version", [ws, id]));
    check("R8 the ORIGINAL draft is still on disk, byte for byte", rows.rows[0].story_text === before.text.storyText);
    check("R8 the repair wrote a NEW version rather than mutating one", rows.rows.length === 2 && rows.rows[1].id === after.project.currentTextId);
    const led = (await T((c) => repo.listQualityRepairs(c, ws, id)))[0];
    check("R8 the ledger links source -> result", led.outcome === "REPAIRED" && led.sourceTextId === rows.rows[0].id && led.resultTextId === rows.rows[1].id);
    check("R8 exactly ONE provider call was charged", led.providerCalls === 1);
    check("R8 the verdict improved and both sides are recorded", led.verdictAfter.repetition.score < led.verdictBefore.repetition.score);
  }

  // ============================================================ 9. the bound: two attempts, then a human
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700, repairText: daSection(1, 3, 130, dnaVariant()) };
    const cp = mkCp(st);
    const id = await newProject(cp);
    await refuses("R9 setup: a padded draft", () => cp.generateStory(id), "E_STORY_PADDED_REPETITION");
    await refuses("R9 attempt 1 fails", () => cp.repairStoryQuality(id), "E_");
    check("R9 the story stays repairable after one failure", (await cp.getProjectView(id)).project.status === "QUALITY_REPAIR_REQUIRED");
    await refuses("R9 attempt 2 fails", () => cp.repairStoryQuality(id), "E_");
    check("R9 after the bound is spent it goes to a HUMAN, not to a third attempt", (await cp.getProjectView(id)).project.status === "NEEDS_REVIEW");
    await refuses("R9 a third attempt is refused outright", () => cp.repairStoryQuality(id), "E_STORY_REPAIR_EXHAUSTED");
    check("R9 exactly two attempts are on record", (await T((c) => repo.listQualityRepairs(c, ws, id))).length === 2);
  }

  // ============================================================ 10. zero-cost reassessment
  {
    const st = { sectionText: daSection, sectionWords: 320 };
    const cpP = createStoryFactoryControlPlane({
      persistence: adapter, config, chatActuator: makeActuator(st), qualityThresholds: RELAXED_Q,
      lengthGateThresholds: { ...LG, repetitionSoft: 0.0001, repetitionHard: 0.0002 }
    });
    const id = await newProject(cpP);
    await refuses("R10 setup: rejected by a paranoid gate", () => cpP.generateStory(id), "E_STORY_PADDED_REPETITION");
    // Simulate the historical mislabel exactly, then prove reassessment corrects it without spending.
    await T((c) => c.query("UPDATE story_projects SET status='FAILED_GENERATION' WHERE workspace_id=$1 AND id=$2", [ws, id]));
    const st2 = { sectionText: daSection, sectionWords: 320 };
    const cpN = mkCp(st2);
    const out = await cpN.reassessStoryQuality(id);
    check("R10 a mislabelled story is re-judged, not re-generated", out.changed === true && out.from === "FAILED_GENERATION" && out.status === "QUALITY_REPAIR_REQUIRED");
    check("R10 the corrected gate passes it", out.gatePass === true);
    check("R10 with zero provider calls", st2.calls.length === 0);
    check("R10 and the verdict is stored for the UI", Boolean((await cpN.getProjectView(id)).project.qualityVerdict));
    check("R10 reassessment never consumes a repair attempt", (await T((c) => repo.listQualityRepairs(c, ws, id))).length === 0);
    const evs = (await cpN.getProjectView(id)).events;
    check("R10 the re-judgement is audited", evs.some((e) => e.type === "STORY_QUALITY_REASSESSED"));
  }

  // ============================================================ 11. tenant isolation of the ledger
  {
    const other = generateId("ws");
    const oc = new Client({ connectionString: live.migrationUrl });
    await oc.connect();
    try {
      await oc.query("SELECT set_config('app.current_workspace',$1,false)", [other]);
      await oc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'OTHER',(SELECT id FROM users LIMIT 1))", [other]);
    } finally { await oc.end(); }
    const seen = await adapter.tenantTransaction(other, (c) => c.query("SELECT count(*)::int n FROM story_quality_repairs"));
    check("R11 another workspace sees ZERO repair rows (RLS holds)", seen.rows[0].n === 0);
  }
} finally {
  try { if (adapter) await adapter.stop(); } catch { /* */ }
  await live.stop();
}

console.log(`Step 5C.34 story quality repair: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
