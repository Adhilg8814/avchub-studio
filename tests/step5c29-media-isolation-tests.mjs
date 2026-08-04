// P0 Step 5C.29 Phase 9 — media / store / background isolation on REAL disposable PostgreSQL. Provider-free.
// Proves: a media capability token issued for tenant A's job NEVER resolves for tenant B (workspace-scoped,
// RLS); cross-tenant media/artifact lookup returns null (no leak); generation job rows partition per workspace;
// workspace audit (security events) is RLS-scoped so a tenant reads only its own. Store path namespacing is
// enforced in the runtime factory (dedicated `<ownerRoot>\tenants\<wsId>` subtree per tenant; owner grandfathered).
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createGenerationControlPlane } from "../control-plane/src/api-staging/generation-control-plane.mjs";
import { createMovieControlPlane } from "../control-plane/src/api-staging/movie-control-plane.mjs";
import { createMovieAssembler } from "../lib/movie/movie-assembler.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const fakeGen = (cp) => ({ enqueue: (...a) => cp.enqueue(...a), ensureBootstrap: () => cp.ensureBootstrap(), getJob: () => null, mediaFor: () => null });

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.29 media isolation: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c29mi" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const tx = (fn) => adapter.transaction(fn);
  const T = (ws, fn) => adapter.tenantTransaction(ws, fn);

  const owner = newId("usr"), wsA = newId("ws"), wsB = newId("ws");
  await tx(async (c) => {
    await c.query("INSERT INTO users (id,email) VALUES ($1,$2)", [owner, `o-${owner}@t.test`]);
    for (const ws of [wsA, wsB]) { await c.query("SELECT set_config('app.current_workspace',$1,false)", [ws]); await c.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'WS',$2)", [ws, owner]); }
  });

  const genA = createGenerationControlPlane({ persistence: adapter, config: { stagingApi: { workspaceId: wsA } } });
  const genB = createGenerationControlPlane({ persistence: adapter, config: { stagingApi: { workspaceId: wsB } } });
  const assembler = createMovieAssembler();
  const movieA = createMovieControlPlane({ persistence: adapter, config: { stagingApi: { workspaceId: wsA } }, generation: fakeGen(genA), assembler, ownerMediaRoot: `${process.env.TEMP || "/tmp"}/prwA` });
  const movieB = createMovieControlPlane({ persistence: adapter, config: { stagingApi: { workspaceId: wsB } }, generation: fakeGen(genB), assembler, ownerMediaRoot: `${process.env.TEMP || "/tmp"}/prwB` });

  // ---- 1. media capability token is workspace-scoped ----
  await genA.enqueue({ prompt: "tenant A scene one", aspectRatio: "9:16", durationSeconds: 2 });
  const jobA = await T(wsA, async (c) => (await c.query("SELECT id FROM generation_jobs LIMIT 1")).rows[0].id);
  const capA = (await genA.issueMediaCapability({ jobId: jobA })).token;
  check("M1 A issues a media capability for its own job", typeof capA === "string" && capA.length > 10);
  check("M2 A resolves its own capability -> its job", (await genA.resolveMediaCapability(capA)) === jobA);
  check("M3 B resolves A's capability -> null (workspace-scoped, cross-tenant fails closed)", (await genB.resolveMediaCapability(capA)) === null);

  // ---- 2. media / artifact lookup is workspace-scoped (cross-tenant -> null) ----
  const pA = await movieA.createProject({ title: "A Movie", inputMode: "IDEA", idea: "aaa" });
  const pB = await movieB.createProject({ title: "B Movie", inputMode: "IDEA", idea: "bbb" });
  check("M4 A cannot read B's project (getProjectView -> null)", (await movieA.getProjectView(pB.id)) === null);
  check("M5 B cannot read A's project", (await movieB.getProjectView(pA.id)) === null);
  check("M6 A reads ONLY its own project", (await movieA.getProjectView(pA.id))?.project?.id === pA.id);
  check("M7 A final-media for B's movie -> null (cross-tenant media ownership preserved)", (await movieA.finalMediaFor(pB.id)) === null);
  check("M8 A project list contains none of B's projects", (await movieA.listProjects()).every((p) => p.id !== pB.id));

  // ---- 3. generation job rows partition per workspace ----
  await genB.enqueue({ prompt: "tenant B scene one", aspectRatio: "9:16", durationSeconds: 2 });
  await genB.enqueue({ prompt: "tenant B scene two", aspectRatio: "9:16", durationSeconds: 2 });
  const [jA, jB] = await Promise.all([
    T(wsA, async (c) => Number((await c.query("SELECT count(*)::int n FROM generation_jobs")).rows[0].n)),
    T(wsB, async (c) => Number((await c.query("SELECT count(*)::int n FROM generation_jobs")).rows[0].n))
  ]);
  check("M9 generation jobs partition by workspace (A=1, B=2)", jA === 1 && jB === 2);

  // ---- 4. workspace audit trail (movie_project_events, workspace-RLS) is tenant-scoped ----
  // createProject appended one PROJECT_CREATED event per workspace; each workspace sees ONLY its own (if the
  // table were not RLS-scoped each side would see BOTH events). This is the per-workspace audit isolation.
  const [aeA, aeB] = await Promise.all([
    T(wsA, async (c) => Number((await c.query("SELECT count(*)::int n FROM movie_project_events")).rows[0].n)),
    T(wsB, async (c) => Number((await c.query("SELECT count(*)::int n FROM movie_project_events")).rows[0].n))
  ]);
  check("M10 workspace audit log (movie_project_events) is RLS-scoped (each sees only its own)", aeA === 1 && aeB === 1);

  await adapter.stop().catch(() => {});
  await live.stop?.().catch?.(() => {});
}

main().then(() => {
  console.log(`\nStep 5C.29 media isolation: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch((e) => { console.error("FATAL", e && e.stack || e); process.exit(1); });
