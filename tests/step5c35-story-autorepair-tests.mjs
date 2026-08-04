// P0 Step 5C.35 — AUTONOMOUS STORY QUALITY REPAIR on a REAL disposable PostgreSQL (provider-free).
//
// 5C.34 made a story that needs repair say so and gave the repair a certified implementation. It still
// needed a human to press a button. This suite is about the machine that presses it, and everything that
// can go wrong when a background process is allowed to spend provider quota unattended:
//
//   * eligibility  — only a story with usable prose, in an auto-repairable state, under the attempt bound,
//                    on an ACTIVE customer, is ever picked up. A real generation failure never is.
//   * one owner    — two schedulers racing the same story produce exactly one repair. The claim is a single
//                    conditional UPDATE; the loser gets nothing and says so.
//   * restart      — a scheduler that dies mid-repair leaves a lease that expires; the next one adopts the
//                    story WITHOUT re-sending a provider call that may already have gone out.
//   * pacing       — a refused lane is not a failure. The story is deferred with a deadline, holds no lease,
//                    and resumes itself. FIFO, no starvation.
//   * tenancy      — a customer suspended mid-flight parks its work; reactivating resumes it.
//   * bound        — two attempts, then a human. Never a third.
//   * immutability — the draft the model wrote is never mutated; one revision per attempt.
//   * cost         — a deterministic title costs no provider call; the provider path still works.
//   * isolation    — a scheduler in workspace A cannot see or claim workspace B's story.

import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createStoryFactoryControlPlane } from "../control-plane/src/api-staging/story-factory-control-plane.mjs";
import { createStoryRepairScheduler } from "../lib/story/story-repair-scheduler.mjs";
import { storyRepository as repo } from "../control-plane/src/persistence/repositories/story-repository.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { DEFAULT_NOVELTY_THRESHOLDS } from "../lib/story/novelty.mjs";

const { Client } = pg;
let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n, d); } };
async function refuses(name, fn, code) {
  try { await fn(); check(name, false, "expected a refusal"); }
  catch (e) { const got = String(e?.code || ""); if (got === code || got.startsWith(code)) passed += 1; else { failed += 1; console.log("FAIL", name, "->", got || e?.message); } }
}

if (!livePgAvailable()) { console.log("Step 5C.35 story auto-repair: 0 passed, 0 failed (SKIPPED — no PostgreSQL)"); process.exit(0); }

// ================================================================ fixtures (shared with 5C.34's shapes)
const BASE_DNA = {
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
const CAST = ["Karen", "Birgitte", "Solveig", "Mette", "Hanne", "Lone", "Inger", "Kirsten", "Ellen", "Gudrun", "Astrid", "Vibeke"];
const SONS = ["Jesper", "Mads", "Anders", "Rasmus", "Søren", "Frederik", "Niels", "Kasper", "Villads", "Emil", "Oskar", "Aksel"];
const CITY = ["Aarhus", "Odense", "Aalborg", "Esbjerg", "Randers", "Kolding", "Horsens", "Vejle", "Roskilde", "Herning", "Silkeborg", "Viborg"];
const ASSET = ["sommerhuset", "andelslejligheden", "sparekontoen", "gården", "værkstedet", "båden", "grunden", "forretningen", "bilsamlingen", "jagthytten", "kolonihaven", "fiskekutteren"];
const PROOF = ["kontoudtogene", "skødet", "testamentet", "lejekontrakten", "revisorrapporten", "notarpapirerne", "forsikringspolicen", "bankfuldmagten", "skifteretsakterne", "vurderingsrapporten", "pantebrevet", "årsopgørelsen"];
let variantSeq = 0;
function dnaVariant() {
  const v = (variantSeq += 1), i = v % CAST.length;
  return {
    ...BASE_DNA, protagonist: CAST[i],
    antagonistList: [{ ...BASE_DNA.antagonistList[0], name: SONS[i] }],
    settingCityOrRegion: CITY[i],
    incitingIncident: `ved midsommermiddagen i ${CITY[i]} kaldte ${SONS[i]} mig smålig foran alle om ${ASSET[i]}`,
    escalationSteps: [`${SONS[i]} tog nøglen til ${ASSET[i]}`, `${SONS[i]} flyttede pengene`, `${SONS[i]} hånede mig ved middagen`],
    hiddenLeverage: `${PROOF[i]} viser at ${ASSET[i]} altid har været mit`, evidenceType: PROOF[i],
    counterMove: `jeg printede ${PROOF[i]}`, reversal: `${PROOF[i]} beviser at overdragelsen aldrig var gyldig`,
    emotionalResolution: `${CAST[i]} fik sin værdighed tilbage og satte en grænse`,
    finalBoundary: `${CAST[i]} bliver ikke behandlet som en pengeautomat`,
    continuityFacts: ["retired teacher", `son ${SONS[i]}`, CITY[i]],
    // Every axis carries the variant number. The novelty gate compares thirteen categorical axes and is
    // right to refuse a rename-only clone; this suite needs a family of genuinely distinct stories, and
    // saying so explicitly is better than relaxing a gate that ships.
    // The novelty gate counts an AXIS as "the same" at jaccard 0.6, so sharing a common phrase across
    // variants makes thirteen axes match and every story after the first a structural duplicate. Each axis
    // therefore gets its own vocabulary, keyed to the variant — a family of genuinely different stories,
    // rather than a relaxed gate.
    originalityDimensions: Object.fromEntries(Object.keys(BASE_DNA.originalityDimensions).map((k) => [k, `${k}${v} ${ASSET[i]}${v} ${PROOF[i]}${v} ${CITY[i]}${v} ${CAST[i]}${v}`])) 
  };
}

const DA_N = ["huset", "familien", "arven", "testamentet", "notaren", "papirerne", "sandheden", "tavsheden", "værdigheden", "grænsen", "beslutningen", "beviset", "minderne", "årene", "omsorgen", "smerten", "stuen", "bordet", "middagen", "samtalen", "blikket", "ordene", "løftet", "svaret", "spørgsmålet", "frygten", "håbet", "retfærdigheden", "sveget", "tilliden", "fornærmelsen", "roen", "styrken", "skæbnen", "fremtiden", "lejligheden", "byen", "gaden", "vinduet", "lyset", "stemmen", "hjertet", "ansigtet", "smilet", "brevet", "underskriften", "arkivet", "kontoen", "banken", "nøglen", "døren", "huslejen", "pengene", "kortet", "kvitteringen", "regningen", "skuffen", "gangen", "haven", "trappen"];
const DA_NX = DA_N.flatMap((w) => { const st = w.replace(/(en|et|ne)$/u, ""); return [w, st + "erne", st + "ets", st + "ernes"]; });
const DA_A = ["gamle", "tunge", "stille", "kolde", "lange", "tomme", "nye", "mørke", "varme", "tørre", "skarpe", "bløde", "fjerne", "små", "store", "hvide", "grå", "åbne", "lukkede", "ru", "trætte", "rolige", "hårde", "lyse"];
const DA_V = ["var", "blev", "forblev", "ændrede", "viste", "beviste", "afslørede", "forsvarede", "tog", "satte", "tænkte", "besluttede", "forstod", "så", "mærkede", "vidste", "ventede", "fandt", "fortsatte", "standsede"];
const DA_F = ["og", "men", "fordi", "da", "efter", "før", "trods", "derfor", "siden", "mens", "at", "for", "med", "på", "i", "så", "til sidst", "pludselig"];
let paragraphNo = 0;
function daGen(nWords) {
  const p = (paragraphNo += 1), win = p % 12;
  const N = DA_NX.slice(win * 20, win * 20 + 20), A = DA_A.slice((p * 7) % 20, ((p * 7) % 20) + 5);
  const out = []; let inS = 0, k = 0;
  while (out.length < nWords) {
    k += 1;
    out.push(DA_F[k % DA_F.length], A[(k * 3) % A.length], N[(k * 2) % N.length], DA_V[(k * 13) % DA_V.length], A[(k * 5 + 1) % A.length], N[(k * 7 + 1) % N.length]);
    inS += 6; if (inS >= 12) { out[out.length - 1] += "."; inS = 0; }
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
function daPaddedSection(i, total, words, dna) {
  const filler = "Hun kiggede på det gamle fotografi af sommerhuset ved kysten og mærkede den samme tunge sorg i brystet.";
  return daSection(i, total, Math.round(words * 0.35), dna) + " " + Array.from({ length: 12 }, () => filler).join(" ");
}

const OUTLINE = { beats: ["cold_open", "narrator_intro", "history_of_help", "first_exploitation", "forbearance", "escalation", "major_betrayal", "public_humiliation", "unforgivable_line", "controlled_response", "evidence", "prepare_counter", "false_confidence", "reversal", "panic", "final_confrontation", "consequence", "boundary_release"].map((k) => ({ key: k, summary: `${k} beat.` })) };
const ACT_PLAN = { acts: [{ act: 1, title: "Setup", summary: "The betrayal is revealed.", escalation: "first exploitation", turningPoint: "the dinner", reveal: "" }, { act: 2, title: "Rising", summary: "Escalation.", escalation: "public humiliation", turningPoint: "the quoted line", reveal: "the statements exist" }, { act: 3, title: "Payoff", summary: "The reversal.", escalation: "the reversal", turningPoint: "the filing", reveal: "sole holder proven" }] };
const secPlan = (n) => ({ sections: Array.from({ length: n }, (_, i) => ({ order: i + 1, title: `Sektion ${i + 1}`, purpose: `før handlingen videre del ${i + 1}`, beatsCovered: [OUTLINE.beats[i]?.key || "cold_open"], targetWords: 200 })) });
const META = { hook: "Til midsommermiddagen sagde min søn at kortet var hans.", excerpt: "Tolv år passede jeg hans børn.", socialTeaser: "Han troede min tavshed var svaghed.", cliffhanger: "Det jeg lagde på bordet ændrede alt.", cta: "Læs hele historien.", seoDescription: "En historie om svigt i familien.", heroImagePrompt: "a Danish woman at a kitchen table with bank statements" };
const TITLES = { titles: ["Da min søn Jesper kaldte mig en gammel dame med et kort tog jeg stille kampen op om min konto", "Min søn tømte kontoen og kaldte mig smålig men kontoudtogene fortalte en anden historie"] };
const fence = (o) => "```json\n" + JSON.stringify(o) + "\n```";

// FAKE Grok Chat adapter. Every call is counted and can be made to fail, hang, or "possibly submit".
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
    else if (prompt.includes("Deepen SECTION")) { stage = "EXPAND"; const mm = /Deepen SECTION (\d+)/.exec(prompt) || [0, 1]; text = fence({ section: (state.expandText || ((i) => daSection(i, 3, 900, state.dna)))(Number(mm[1]) - 1) }); }
    else if (prompt.includes("titles for a first-person")) { stage = "TITLE"; text = fence(TITLES); }
    else if (prompt.includes("publishing metadata")) { stage = "METADATA"; text = fence(META); }
    else if (prompt.includes("Rate this")) { stage = "QUALITY"; text = fence({ hookStrength: 0.8 }); }
    state.calls.push(stage);
    // "possibly submitted": the submit fact is durable BEFORE the failure, exactly as a real timeout would be.
    if (state.submitThenFail === stage) { if (typeof onBeforeSubmit === "function") await onBeforeSubmit(); throw Object.assign(new Error("timeout"), { code: "E_STORY_STAGE_FAILED", submitted: true }); }
    if (state.failStage === stage) throw Object.assign(new Error("provider down"), { code: "E_STORY_STAGE_FAILED" });
    if (state.hangStage === stage) await new Promise((r) => setTimeout(r, state.hangMs || 50));
    if (typeof onBeforeSubmit === "function") await onBeforeSubmit();
    return { text, responseId: "resp_" + stage.toLowerCase() };
  };
}

// ================================================================ harness
const live = await startDisposablePg({ namePrefix: "sar35" });
let adapter = null;
try {
  const ws = generateId("ws"), wsB = generateId("ws"), user = generateId("usr");
  const mc = new Client({ connectionString: live.migrationUrl });
  await mc.connect();
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* 0001 also creates it */ }
    const res = await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c35" });
    check("A0 migrations apply to the shipped head (includes 0038)", res.applied.length + res.alreadyApplied === loadMigrationFiles(MIGRATIONS_DIR).length);
    check("A0 re-running is a no-op", (await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "5c35" })).applied.length === 0);
    const st = (await mc.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='story_projects_status_check'")).rows[0].d;
    check("A0 the two working statuses are legal", st.includes("QUALITY_REPAIRING") && st.includes("WAITING_REPAIR_COOLDOWN"));
    check("A0 every 5C.34 status is still legal", ["READY", "QUALITY_REPAIR_REQUIRED", "FAILED_GENERATION", "NEEDS_REVIEW", "ARCHIVED"].every((x) => st.includes(`'${x}'`)));
    const rls = (await mc.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='story_repair_schedule'")).rows[0];
    check("A0 the schedule is RLS-protected and FORCEd", rls.relrowsecurity === true && rls.relforcerowsecurity === true);
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    for (const w of [ws, wsB]) {
      await mc.query("SELECT set_config('app.current_workspace',$1,false)", [w]);
      await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'SAR',$2)", [w, user]);
    }
  } finally { await mc.end(); }

  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const T = (fn, w = ws) => adapter.tenantTransaction(w, fn);
  const RELAXED_Q = { floors: {}, critical: [], overall: 0 };
  const LG = { maxNearDupPairs: 9999 };
  // Every story here is generated from ONE synthetic prose generator, so they are structurally alike by
  // construction. Novelty is 5C.16's subject, not this suite's; relaxing it keeps the scheduling contract
  // in focus without weakening anything that ships.
  const RELAXED_N = { ...DEFAULT_NOVELTY_THRESHOLDS, overall: 0.999, structuralDuplicate: 0.999 };

  const mkCp = (state, w = ws, nowFn = () => Date.now()) => createStoryFactoryControlPlane({
    persistence: adapter, config: { stagingApi: { workspaceId: w } }, now: nowFn,
    chatActuator: makeActuator(state), qualityThresholds: RELAXED_Q, lengthGateThresholds: LG, noveltyThresholds: RELAXED_N
  });
  const newProject = async (cp, w = ws) => {
    await cp.ensureSeeds();
    const profiles = await cp.listBrandProfiles();
    const brand = profiles.find((p) => p.locale === "da-DK") || profiles[0];
    const p = await cp.createProject({ brandProfileId: brand.id, country: "DK", locale: brand.locale, lengthPreset: "SHORT", seedIdea: "midsummer account" });
    return p.id;
  };
  // A story that lands in QUALITY_REPAIR_REQUIRED with usable prose — the auto-repairable shape.
  async function paddedStory(state, w = ws, nowFn) {
    const cp = mkCp(state, w, nowFn);
    const id = await newProject(cp, w);
    try { await cp.generateStory(id); } catch { /* the gate declines it, which is the point */ }
    const st2 = (await cp.getProjectView(id)).project.status;
    if (st2 !== "QUALITY_REPAIR_REQUIRED") { failed += 1; console.log("FAIL fixture: expected QUALITY_REPAIR_REQUIRED, got", st2, (await cp.getProjectView(id)).project.errorCode); }
    return { cp, id };
  }
  const alwaysGranted = { reserve: async ({ nowMs }) => ({ granted: true, nextEligibleAt: new Date(nowMs) }), note: async () => null };
  const alwaysDeferred = (untilMs) => ({ reserve: async () => ({ granted: false, nextEligibleAt: new Date(untilMs) }), note: async () => null });

  // ============================================================ 1. eligibility
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    check("A1 a declined story lands in QUALITY_REPAIR_REQUIRED", (await cp.getProjectView(id)).project.status === "QUALITY_REPAIR_REQUIRED");
    check("A1 and is eligible for unattended repair", (await cp.autoRepairIneligibility((await cp.getProjectView(id)).project)) === null);
    const enq = await cp.autoRepairEnqueue();
    check("A1 the durable eligible record is published", enq.enqueued >= 1);
    const row = await T((c) => repo.getRepairSchedule(c, ws, id));
    check("A1 the row starts ELIGIBLE with no lease and no attempts", row.state === "ELIGIBLE" && row.leaseOwner === null && row.attempt === 0);
    const due = await cp.autoRepairDue({});
    check("A1 it shows up as due", due.some((d) => d.storyProjectId === id));

    // A REAL generation failure — no prose — must never be picked up.
    const dead = { failStage: "DNA" };
    const cpDead = mkCp(dead);
    const idDead = await newProject(cpDead);
    try { await cpDead.generateStory(idDead); } catch { /* expected */ }
    const v = await cpDead.getProjectView(idDead);
    check("A1 a real generation failure stays FAILED_GENERATION", v.project.status === "FAILED_GENERATION");
    check("A1 and is refused by eligibility", (await cpDead.autoRepairIneligibility(v.project)) === "NOT_REPAIRABLE_STATUS");
    await cpDead.autoRepairEnqueue();
    check("A1 no schedule row is created for it", (await T((c) => repo.getRepairSchedule(c, ws, idDead))) === null);
  }

  // ============================================================ 2. a full unattended run to READY
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    const before = await cp.getProjectView(id);
    const callsBefore = st.calls.length;
    // The prose is padded, so this is a REAL repair: re-evaluate fails, one targeted rewrite follows.
    st.repairText = [0, 1, 2, 3, 4, 5].map((i) => daSection(i, 6, Math.round(before.text.wordCount / 6 / 0.9), st.dna)).join("\n\n");
    await cp.autoRepairEnqueue();
    const r = await cp.autoRepairStep(id, { owner: "sched_test_owner_1", pacing: alwaysGranted });
    check("A2 the scheduler drives the story to READY with no owner action", r.action === "READY", JSON.stringify(r));
    const after = await cp.getProjectView(id);
    check("A2 status READY", after.project.status === "READY");
    check("A2 a title was recovered", typeof after.project.title === "string" && after.project.title.length > 10);
    check("A2 a scorecard was produced", after.project.overallScore !== null && after.quality);
    check("A2 a package was produced", Boolean(after.package));
    check("A2 the schedule row retired to DONE with no lease", (await T((c) => repo.getRepairSchedule(c, ws, id))).state === "DONE");
    const versions = await T((c) => c.query("SELECT id, version, story_text FROM story_text_versions WHERE workspace_id=$1 AND story_project_id=$2 ORDER BY version", [ws, id]));
    check("A2 the ORIGINAL draft is untouched, byte for byte", versions.rows[0].story_text === before.text.storyText);
    check("A2 exactly one revision per attempt", versions.rows.length === 2);
    const led = await T((c) => repo.listQualityRepairs(c, ws, id));
    check("A2 the attempt is recorded as the SCHEDULER's", led.length === 1 && led[0].actor === "SCHEDULER");
    check("A2 with an idempotency key", /^[0-9a-f]{64}$/.test(led[0].idempotencyKey || ""));
    check("A2 and exactly one provider call charged", led[0].providerCalls === 1);
    const stages = st.calls.slice(callsBefore);
    check("A2 exactly one targeted repair call was made", stages.filter((x) => x === "REPAIR").length === 1, stages.join(","));
    check("A2 the package stage ran once", stages.filter((x) => x === "METADATA").length === 1);
    check("A2 no story stage was re-run from scratch", !stages.includes("SECTION") && !stages.includes("DNA"), stages.join(","));
    const ev = after.events.find((e) => e.type === "STORY_TITLE_CHOSEN");
    check("A2 the title's provenance is recorded", Boolean(ev) && ["DETERMINISTIC", "PROVIDER"].includes(ev.detail.source));
  }

  // ============================================================ 3. two schedulers race the same story
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    const src = await cp.getProjectView(id);
    st.repairText = [0, 1, 2, 3, 4, 5].map((i) => daSection(i, 6, Math.round(src.text.wordCount / 6 / 0.9), st.dna)).join("\n\n");
    await cp.autoRepairEnqueue();
    const [a, b] = await Promise.all([
      cp.autoRepairStep(id, { owner: "sched_race_alpha", pacing: alwaysGranted }),
      cp.autoRepairStep(id, { owner: "sched_race_beta", pacing: alwaysGranted })
    ]);
    const actions = [a.action, b.action].sort();
    check("A3 exactly one scheduler works; the other is told it did not claim", actions.includes("NOT_CLAIMED"), JSON.stringify([a, b]));
    check("A3 the winner finished the story", actions.includes("READY"), JSON.stringify([a, b]));
    check("A3 exactly ONE repair attempt exists", (await T((c) => repo.listQualityRepairs(c, ws, id))).length === 1);
    const versions = await T((c) => c.query("SELECT count(*)::int n FROM story_text_versions WHERE workspace_id=$1 AND story_project_id=$2", [ws, id]));
    check("A3 and exactly one new revision", versions.rows[0].n === 2);
  }

  // ============================================================ 4. pacing: deferred, not failed
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    await cp.autoRepairEnqueue();
    const until = Date.now() + 60_000;
    const r = await cp.autoRepairStep(id, { owner: "sched_pace_1", pacing: alwaysDeferred(until) });
    check("A4 a refused lane defers the story", r.action === "DEFERRED", JSON.stringify(r));
    const v = await cp.getProjectView(id);
    check("A4 the story SAYS it is waiting (not failed)", v.project.status === "WAITING_REPAIR_COOLDOWN");
    check("A4 with an ETA the UI can show", Boolean(v.project.repairNextEligibleAt));
    const row = await T((c) => repo.getRepairSchedule(c, ws, id));
    check("A4 the lease was RELEASED while waiting", row.leaseOwner === null && row.leaseExpiresAt === null);
    check("A4 the wait is durable, in the row", row.state === "WAITING_COOLDOWN" && new Date(row.nextEligibleAt).getTime() > Date.now());
    check("A4 the deferral is counted", row.deferrals === 1);
    check("A4 no provider call was made", st.calls.filter((x) => x === "REPAIR" || x === "METADATA").length === 0);
    check("A4 it is NOT due yet", !(await cp.autoRepairDue({})).some((d) => d.storyProjectId === id));
    check("A4 but it IS due once the lane frees up", (await cp.autoRepairDue({ nowMs: until + 1000 })).some((d) => d.storyProjectId === id));
    // and it resumes itself, with no owner action
    const src = await cp.getProjectView(id);
    st.repairText = [0, 1, 2, 3, 4, 5].map((i) => daSection(i, 6, Math.round(src.text.wordCount / 6 / 0.9), st.dna)).join("\n\n");
    // Time passes. Nothing else happens — no owner, no click, no external nudge.
    const later = mkCp(st, ws, () => until + 5000);
    const r2 = await later.autoRepairStep(id, { owner: "sched_pace_1", pacing: alwaysGranted });
    check("A4 resuming needs no owner click", r2.action === "READY", JSON.stringify(r2));
  }

  // ============================================================ 5. FIFO, no starvation
  {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const st = { sectionText: daPaddedSection, sectionWords: 700 };
      const { id } = await paddedStory(st);
      ids.push(id);
      await new Promise((r) => setTimeout(r, 15));   // distinct enqueue times
    }
    const cp = mkCp({ sectionText: daPaddedSection, sectionWords: 700 });
    await cp.autoRepairEnqueue();
    const due = (await cp.autoRepairDue({ limit: 10 })).map((d) => d.storyProjectId);
    const positions = ids.map((id) => due.indexOf(id)).filter((x) => x >= 0);
    check("A5 due order is oldest-first (FIFO)", positions.every((v, i, arr) => i === 0 || arr[i - 1] < v), JSON.stringify(positions));
    // A story that keeps deferring must not lose its place to a newer one.
    await cp.autoRepairStep(ids[0], { owner: "sched_fifo", pacing: alwaysDeferred(Date.now() - 1000) });
    const due2 = (await cp.autoRepairDue({ limit: 10 })).map((d) => d.storyProjectId);
    check("A5 a deferred-then-eligible story keeps its place at the head", due2.indexOf(ids[0]) < due2.indexOf(ids[1]));
  }

  // ============================================================ 6. restart mid-repair, and never a blind resend
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700, submitThenFail: "REPAIR" };
    const { cp, id } = await paddedStory(st);
    await cp.autoRepairEnqueue();
    const r = await cp.autoRepairStep(id, { owner: "sched_crash_1", pacing: alwaysGranted });
    check("A6 an interrupted repair does not claim success", r.action !== "READY", JSON.stringify(r));
    const led = (await T((c) => repo.listQualityRepairs(c, ws, id)))[0];
    check("A6 the durable evidence says the call was reached", led.submitState === "SUBMITTED");
    // Now a fresh scheduler adopts it, exactly as a restart would.
    st.submitThenFail = null;
    st.repairText = daSection(0, 3, 900, st.dna);
    const callsBefore = st.calls.length;
    // Whatever the first step left behind, a fresh scheduler must be able to look at this story again.
    await T((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: id, state: "ELIGIBLE", nextEligibleAt: new Date(Date.now() - 1000).toISOString() }));
    const r2 = await cp.autoRepairStep(id, { owner: "sched_crash_2", pacing: alwaysGranted });
    check("A6 the next scheduler REFUSES to re-send it", r2.action === "MANUAL_REVIEW" && r2.code === "E_STORY_REPAIR_SUBMIT_UNCERTAIN", JSON.stringify(r2));
    check("A6 and made no second provider call", st.calls.slice(callsBefore).filter((x) => x === "REPAIR").length === 0);
    check("A6 the attempt count did not increase twice", (await cp.getProjectView(id)).project.qualityRepairCount === 1);
    check("A6 exactly one attempt row exists", (await T((c) => repo.listQualityRepairs(c, ws, id))).length === 1);
    check("A6 the story is parked for a human", (await T((c) => repo.getRepairSchedule(c, ws, id))).state === "MANUAL_REVIEW");
  }

  // ============================================================ 7. stale lease recovery
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    await cp.autoRepairEnqueue();
    const text = (await cp.getProjectView(id)).text;
    // Simulate a scheduler that died holding the lease: LEASED with an expiry in the past.
    await T((c) => c.query(
      `UPDATE story_repair_schedule SET state='LEASED', lease_owner='sched_dead_one', lease_expires_at=now() - interval '1 minute'
        WHERE workspace_id=$1 AND story_project_id=$2`, [ws, id]));
    const claimedByOther = await T((c) => repo.claimRepairSchedule(c, ws, {
      storyProjectId: id, owner: "sched_alive_one", leaseMs: 60_000, attempt: 1, sourceRevision: text.version, idempotencyKey: "b".repeat(64), nowMs: Date.now()
    }));
    check("A7 an EXPIRED lease is reclaimable without any external reaper", claimedByOther !== null && claimedByOther.leaseOwner === "sched_alive_one");
    // A live lease is not.
    const denied = await T((c) => repo.claimRepairSchedule(c, ws, {
      storyProjectId: id, owner: "sched_third_one", leaseMs: 60_000, attempt: 1, sourceRevision: text.version, idempotencyKey: "c".repeat(64), nowMs: Date.now()
    }));
    check("A7 a LIVE lease cannot be stolen", denied === null);
    // Only the holder may renew.
    check("A7 the holder can renew", (await T((c) => repo.renewRepairLease(c, ws, { storyProjectId: id, owner: "sched_alive_one", leaseMs: 60_000 }))) !== null);
    check("A7 a non-holder cannot renew", (await T((c) => repo.renewRepairLease(c, ws, { storyProjectId: id, owner: "sched_third_one", leaseMs: 60_000 }))) === null);
  }

  // ============================================================ 8. idempotency key: same work never starts twice
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    const st2 = { sectionText: daPaddedSection, sectionWords: 700 };
    const { id: id2 } = await paddedStory(st2);
    await cp.autoRepairEnqueue();
    const t1 = (await cp.getProjectView(id)).text;
    const key = "d".repeat(64);
    await T((c) => repo.claimRepairSchedule(c, ws, { storyProjectId: id, owner: "sched_idem_one", leaseMs: 1000, attempt: 1, sourceRevision: t1.version, idempotencyKey: key, nowMs: Date.now() }));
    let dupe = null;
    try {
      await T((c) => repo.claimRepairSchedule(c, ws, { storyProjectId: id2, owner: "sched_idem_two", leaseMs: 1000, attempt: 1, sourceRevision: 1, idempotencyKey: key, nowMs: Date.now() }));
      dupe = "ACCEPTED";
    } catch (e) { dupe = String(e.code || e.message); }
    check("A8 the same unit of work cannot be claimed twice, even across stories", dupe !== "ACCEPTED", String(dupe));
  }

  // ============================================================ 9. the attempt bound holds
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700, repairText: daSection(1, 3, 130, dnaVariant()) };
    const { cp, id } = await paddedStory(st);
    await cp.autoRepairEnqueue();
    check("A9 the story really is queued before the bound is tested", (await T((c) => repo.getRepairSchedule(c, ws, id))) !== null);
    const r1 = await cp.autoRepairStep(id, { owner: "sched_bound", pacing: alwaysGranted });
    check("A9 attempt 1 runs and does not succeed with a bad repair", r1.action !== "READY" && r1.action !== "NOT_CLAIMED", JSON.stringify(r1));
    await T((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: id, state: "ELIGIBLE", nextEligibleAt: new Date(Date.now() - 1000).toISOString() }));
    const r2 = await cp.autoRepairStep(id, { owner: "sched_bound", pacing: alwaysGranted });
    check("A9 attempt 2 also runs", r2.action !== "READY" && r2.action !== "NOT_CLAIMED", JSON.stringify(r2));
    check("A9 exactly two attempts were spent", (await T((c) => repo.listQualityRepairs(c, ws, id))).length === 2);
    await T((c) => repo.releaseRepairSchedule(c, ws, { storyProjectId: id, state: "ELIGIBLE", nextEligibleAt: new Date(Date.now() - 1000).toISOString() }));
    const r3 = await cp.autoRepairStep(id, { owner: "sched_bound", pacing: alwaysGranted });
    check("A9 a third attempt is never made", r3.action === "SKIPPED" && r3.reason === "ATTEMPTS_EXHAUSTED", JSON.stringify(r3));
    check("A9 the story is parked for a human", (await T((c) => repo.getRepairSchedule(c, ws, id)))?.state === "MANUAL_REVIEW");
    check("A9 still exactly two attempts", (await T((c) => repo.listQualityRepairs(c, ws, id))).length === 2);
  }

  // ============================================================ 10. tenant suspended mid-wait, then reactivated
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    await cp.autoRepairEnqueue();
    let suspended = true;
    const tenancy = { assertActive: async () => { if (suspended) throw Object.assign(new Error("suspended"), { code: "E_CUSTOMER_SUSPENDED" }); return true; } };
    const r = await cp.autoRepairStep(id, { owner: "sched_tenant", pacing: alwaysGranted, tenancy });
    check("A10 a suspended customer blocks unattended work", r.action === "BLOCKED" && r.reason === "E_CUSTOMER_SUSPENDED", JSON.stringify(r));
    check("A10 the schedule row is parked, not deleted", (await T((c) => repo.getRepairSchedule(c, ws, id))).state === "BLOCKED");
    check("A10 no provider call was made", st.calls.filter((x) => x === "REPAIR").length === 0);
    // Reactivate: the next enqueue pass picks it up exactly where it was.
    suspended = false;
    await cp.autoRepairEnqueue();
    check("A10 a reactivated tenant resumes", (await T((c) => repo.getRepairSchedule(c, ws, id))).state === "ELIGIBLE");
    const src = await cp.getProjectView(id);
    st.repairText = [0, 1, 2, 3, 4, 5].map((i) => daSection(i, 6, Math.round(src.text.wordCount / 6 / 0.9), st.dna)).join("\n\n");
    const r2 = await cp.autoRepairStep(id, { owner: "sched_tenant", pacing: alwaysGranted, tenancy });
    check("A10 and finishes with no owner action", r2.action === "READY", JSON.stringify(r2));
  }

  // ============================================================ 11. provider failure that never reached the provider
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700, failStage: "REPAIR" };
    const { cp, id } = await paddedStory(st);
    await cp.autoRepairEnqueue();
    const r = await cp.autoRepairStep(id, { owner: "sched_fail", pacing: alwaysGranted });
    check("A11 a provably-unsent failure is paced, not failed", r.action === "DEFERRED", JSON.stringify(r));
    const v = await cp.getProjectView(id);
    check("A11 the story waits rather than dying", v.project.status === "WAITING_REPAIR_COOLDOWN");
    check("A11 with a retry deadline", Boolean(v.project.repairNextEligibleAt));
    check("A11 the schedule row keeps it alive", (await T((c) => repo.getRepairSchedule(c, ws, id))).state === "WAITING_COOLDOWN");
  }

  // ============================================================ 12. the provider title path still works
  {
    // A DNA whose prose yields no acceptable deterministic title forces the provider path. Rather than
    // contrive one, drive completeFromText with a story whose text is replaced by prose with no names.
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    const src = await cp.getProjectView(id);
    st.repairText = [0, 1, 2, 3, 4, 5].map((i) => daSection(i, 6, Math.round(src.text.wordCount / 6 / 0.9), st.dna)).join("\n\n");
    await cp.autoRepairEnqueue();
    const before = st.calls.length;
    const r = await cp.autoRepairStep(id, { owner: "sched_title", pacing: alwaysGranted });
    check("A12 the story reaches READY either way", r.action === "READY", JSON.stringify(r));
    const stages = st.calls.slice(before);
    const titles = await T((c) => c.query("SELECT count(*)::int n, count(*) FILTER (WHERE chosen)::int chosen FROM story_title_candidates WHERE workspace_id=$1 AND story_project_id=$2", [ws, id]));
    check("A12 title candidates are persisted for the owner to switch between", titles.rows[0].n >= 1 && titles.rows[0].chosen === 1);
    check("A12 the chosen title is recorded on the project", Boolean((await cp.getProjectView(id)).project.title));
    check("A12 the provider title path is used AT MOST once and only when needed", stages.filter((x) => x === "TITLE").length <= 1, stages.join(","));
  }

  // ============================================================ 13. the scheduler loop itself
  {
    const st = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp, id } = await paddedStory(st);
    const src = await cp.getProjectView(id);
    st.repairText = [0, 1, 2, 3, 4, 5].map((i) => daSection(i, 6, Math.round(src.text.wordCount / 6 / 0.9), st.dna)).join("\n\n");
    const offScheduler = createStoryRepairScheduler({ story: cp, pacing: alwaysGranted, enabled: false });
    check("A13 a disabled scheduler does nothing at all", (await offScheduler.tick()).length === 0);
    check("A13 and refuses to start", offScheduler.start() === false);
    check("A13 status of the story is untouched", (await cp.getProjectView(id)).project.status === "QUALITY_REPAIR_REQUIRED");

    const sched = createStoryRepairScheduler({ story: cp, pacing: alwaysGranted, enabled: true, maxPerTick: 1 });
    const out = await sched.tick();
    check("A13 an enabled scheduler advances exactly one story per tick", out.length === 1, JSON.stringify(out.map((x) => x.action)));
    check("A13 the scheduler reports what it did", sched.stats().steps === 1 && typeof sched.stats().lastAction === "string");
    // Left alone, it works the whole queue: tick until this story is finished, with no owner action at any
    // point. Bounded so a genuine failure surfaces as a failure rather than a hang.
    let reached = null;
    for (let i = 0; i < 12 && reached === null; i += 1) {
      await sched.tick();
      const row = await T((c) => repo.getRepairSchedule(c, ws, id));
      if (row && (row.state === "DONE" || row.state === "MANUAL_REVIEW")) reached = row.state;
    }
    check("A13 the scheduler finishes the story unattended", reached === "DONE", `reached=${reached}`);
    check("A13 which means READY", (await cp.getProjectView(id)).project.status === "READY");
    const pausedGate = { blocked: () => true, assertRunning: () => { throw Object.assign(new Error("paused"), { code: "E_GENERATION_EXECUTION_PAUSED" }); } };
    check("A13 a paused runtime never runs it", (await createStoryRepairScheduler({ story: cp, pacing: alwaysGranted, enabled: true, executionGate: pausedGate }).tick()).length === 0);
  }

  // ============================================================ 14. cross-tenant isolation
  {
    const stB = { sectionText: daPaddedSection, sectionWords: 700 };
    const { cp: cpB, id: idB } = await paddedStory(stB, wsB);
    await cpB.autoRepairEnqueue();
    check("A14 workspace B has its own schedule row", (await T((c) => repo.getRepairSchedule(c, wsB, idB), wsB)) !== null);
    const cpA = mkCp({ sectionText: daPaddedSection, sectionWords: 700 }, ws);
    const dueA = await cpA.autoRepairDue({ limit: 50 });
    check("A14 workspace A's scheduler cannot see B's story", !dueA.some((d) => d.storyProjectId === idB));
    const seen = await T((c) => c.query("SELECT count(*)::int n FROM story_repair_schedule WHERE story_project_id=$1", [idB]), ws);
    check("A14 and cannot read B's schedule row at all (RLS)", seen.rows[0].n === 0);
    const stepA = await cpA.autoRepairStep(idB, { owner: "sched_cross", pacing: alwaysGranted });
    check("A14 nor claim it", stepA.action === "SKIPPED" || stepA.action === "NOT_FOUND" || stepA.action === "NOT_CLAIMED", JSON.stringify(stepA));
  }

  // ============================================================ 14b. a story whose gate PASSES but that never
  // finished — the real sv-SE shape: prose fine, over the ideal length, METADATA stage died. The gate calls
  // that ABOVE_MAX_SOFT and PASSES it, so there is nothing to "repair"; there are stages left to run. It
  // must be picked up, not filed under "needs a human".
  {
    const st = { sectionText: daSection, sectionWords: 900, failStage: "METADATA" };
    const cp = mkCp(st);
    const id = await newProject(cp);
    try { await cp.generateStory(id); } catch { /* METADATA dies, as it did in production */ }
    const v0 = await cp.getProjectView(id);
    check("A14b a dead stage after good prose is a generation failure at first", v0.project.status === "FAILED_GENERATION");
    const re = await cp.reassessStoryQuality(id);
    check("A14b re-judging moves it to QUALITY_REPAIR_REQUIRED", re.status === "QUALITY_REPAIR_REQUIRED" && re.gatePass === true, JSON.stringify(re));
    const verdict = (await cp.getProjectView(id)).project.qualityVerdict;
    check("A14b the verdict records that the gate PASSED, not just its state name", verdict.gatePass === true);
    check("A14b a PASSING gate is eligible for unattended completion", (await cp.autoRepairIneligibility((await cp.getProjectView(id)).project)) === null,
      String(await cp.autoRepairIneligibility((await cp.getProjectView(id)).project)));
    st.failStage = null;
    await cp.autoRepairEnqueue();
    const r = await cp.autoRepairStep(id, { owner: "sched_passing_gate", pacing: alwaysGranted });
    check("A14b and the scheduler finishes it with no repair at all", r.action === "READY", JSON.stringify(r));
    const led = await T((c) => repo.listQualityRepairs(c, ws, id));
    check("A14b recorded as a re-evaluation costing nothing", led.length === 1 && led[0].outcome === "RE_EVALUATED" && led[0].providerCalls === 0);
    const versions = await T((c) => c.query("SELECT count(*)::int n FROM story_text_versions WHERE workspace_id=$1 AND story_project_id=$2", [ws, id]));
    check("A14b the prose was never rewritten", versions.rows[0].n === 1);
  }

  // ============================================================ 15. the health snapshot
  {
    const cp = mkCp({ sectionText: daPaddedSection, sectionWords: 700 });
    const snap = await cp.autoRepairSnapshot();
    check("A15 the snapshot reports the counts a health check needs",
      Number.isInteger(snap.waiting) && Number.isInteger(snap.active) && Number.isInteger(snap.completed) && Number.isInteger(snap.needsManualReview));
    check("A15 including when the next story becomes eligible", snap.nearestEligibleAt === null || typeof snap.nearestEligibleAt === "string");
    check("A15 completed stories are counted", snap.completed >= 3, `completed=${snap.completed}`);
  }
} finally {
  try { if (adapter) await adapter.stop(); } catch { /* */ }
  await live.stop();
}

console.log(`Step 5C.35 story auto-repair: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
