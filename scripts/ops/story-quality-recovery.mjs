// P0 Step 5C.34 — recover quality-failed stories in the live database, through the CERTIFIED path.
//
// This is an owner-operated CLI on the host, the same shape as movie-real-cert.mjs: it builds the REAL
// story control plane against the production database and calls the same methods the Studio button calls.
// It never writes SQL by hand, never invents a status, and never creates a second project.
//
// Modes:
//   list                    read-only: every project that is not READY, with what the corrected detector
//                           now says about it. Zero provider calls.
//   reassess <id|--all>     re-judge the existing draft and record the accurate status + verdict.
//                           ZERO provider calls — no actuator is constructed, so this cannot spend quota.
//   show <id>               read-only detail.
//
// Finishing a re-judged story (title + package) needs the Grok Chat actuator, which belongs to the RUNNING
// runtime — one browser launcher, one provider lease. That step is deliberately not done here: it is the
// "Sửa chất lượng" button in Studio, which drives the same repairStoryQuality() through the runtime that
// already owns the lease.
import { readFileSync } from "node:fs";
import { createPostgresAdapter } from "../../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../../control-plane/src/config/config.mjs";
import { createStoryFactoryControlPlane } from "../../control-plane/src/api-staging/story-factory-control-plane.mjs";
import { storyRepository as repo } from "../../control-plane/src/persistence/repositories/story-repository.mjs";
import { defaultStudioHome } from "../../lib/paths.mjs";

const OWNER = defaultStudioHome();
const WS = "ws_00000000000000000000000000";
const DB = "facebook5c8_b3r";

function urls() {
  const m = JSON.parse(readFileSync(`${OWNER}/b3-local-runtime/runtime/session-manifest.json`, "utf8"));
  const s = JSON.parse(readFileSync(`${OWNER}/b3-local-runtime/secrets/runtime-secrets.json`, "utf8"));
  const u = (user, pw) => `postgresql://${user}:${encodeURIComponent(pw)}@127.0.0.1:${m.ports.postgresql}/${DB}`;  // scan-secrets:allow DSN assembled from environment, no literal password
  return { app: u("cp_tenant_app", s.tenant), ops: u("cp_ops_enumerator", s.ops) };
}

async function open() {
  const { app, ops } = urls();
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: app, CONTROL_PLANE_DB_OPS_URL: ops }), {});
  await adapter.start();
  // No chatActuator and no chatConversationFactory: this process CANNOT reach a provider, by construction.
  const story = createStoryFactoryControlPlane({ persistence: adapter, config: { stagingApi: { workspaceId: WS } } });
  return { adapter, story };
}

const line = (p, extra = "") => `${p.id}  ${String(p.locale).padEnd(6)} ${String(p.status).padEnd(24)} ${String(p.errorCode || "-").padEnd(34)} ${String(p.wordCount ?? "-").padStart(5)}w  ${p.title ? JSON.stringify(p.title).slice(0, 60) : "(no title)"}${extra}`;

const [cmd, arg] = process.argv.slice(2);
const { adapter, story } = await open();
try {
  if (cmd === "list") {
    const all = await adapter.tenantTransaction(WS, (c) => repo.listProjects(c, WS, { limit: 200 }));
    for (const p of all) if (p.status !== "READY") console.log(line(p));
    console.log(`\n${all.length} projects, ${all.filter((p) => p.status === "READY").length} READY`);
  } else if (cmd === "show") {
    const v = await story.getProjectView(arg);
    const p = v.project;
    console.log(line(p));
    console.log("  text:", v.text ? `v${v.text.version} ${v.text.wordCount}w` : "(none)",
      " package:", v.package ? "yes" : "no", " quality:", v.quality ? v.quality.overallScore : "-",
      " repairs:", p.qualityRepairCount);
    if (p.qualityVerdict) console.log("  verdict:", JSON.stringify({ gate: p.qualityVerdict.gateState, band: p.qualityVerdict.repetition?.band, score: p.qualityVerdict.repetition?.score, why: p.qualityVerdict.repetition?.explanation?.slice(0, 160) }, null, 2));
  } else if (cmd === "reassess") {
    const ids = arg === "--all"
      ? (await adapter.tenantTransaction(WS, (c) => repo.listProjects(c, WS, { limit: 200 }))).filter((p) => p.status !== "READY" && p.status !== "ARCHIVED").map((p) => p.id)
      : [arg];
    for (const id of ids) {
      const r = await story.reassessStoryQuality(id);
      console.log(`${id}  ${r.changed ? `${r.from} -> ${r.status}` : `unchanged (${r.status}${r.reason ? ", " + r.reason : ""})`}  gate=${r.gate || "-"} band=${r.band || "-"} score=${r.score ?? "-"} providerCalls=0`);
    }
  } else {
    console.log("usage: story-quality-recovery.mjs list | show <id> | reassess <id|--all>");
  }
} finally { await adapter.stop(); }
