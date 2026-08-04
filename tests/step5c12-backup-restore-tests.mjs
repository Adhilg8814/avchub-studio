// P0 Step 5C.12 — backup/restore certification (provider-free). Fast section: manifest+SHA-256,
// atomic destination (interrupted backup leaves NO final dir), tamper detection, restore guards
// (non-empty target, production guard, interrupted-restore marker), retention policy. Drill
// section (SKIPs without the portable PostgreSQL binaries): builds a REAL disposable cluster with
// the FULL migration set + fixture movie/scene/render rows + matching media files, cold-stops it,
// backs it up, restores into a disposable dir, STARTS the restored cluster copy, and verifies
// migrations / project rows / scene correlation / render metadata / media hashes end-to-end.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createBackup, verifyBackup, restoreBackup, restoreWasInterrupted, runRestoreDrill, hashFile } from "../lib/ops/backup-restore.mjs";
import { livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { newId } from "../control-plane/src/persistence/ids.mjs";

const { Client } = pg;
let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }
async function rejects(name, fn, frag) { try { await fn(); assert.fail(name + " expected reject"); } catch (e) { if (e instanceof assert.AssertionError && /expected reject/.test(e.message)) throw e; check(name, `${e.code || ""} ${e.message || ""}`.includes(frag), true); } }

const root = mkdtempSync(path.join(os.tmpdir(), "cp5c12-backup-"));
const owner = path.join(root, "owner");
const backups = path.join(root, "backups");

function seedOwner() {
  rmSync(owner, { recursive: true, force: true });
  const put = (rel, content) => { const abs = path.join(owner, rel.split("/").join(path.sep)); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, content); };
  put("b3-local-runtime/postgres-data/PG_VERSION", "16\n");
  put("b3-local-runtime/postgres-data/base/1/152", Buffer.alloc(4096, 7));
  put("generated-media/jobs/job_X/generated.mp4", Buffer.alloc(2048, 3));
  put("generated-media/jobs/job_X/result.json", JSON.stringify({ ok: true }));
  put("generated-media/movies/mov_X/renders/v1/final.mp4", Buffer.alloc(4096, 5));
  put("generation-jobs/job_X.json", JSON.stringify({ jobId: "job_X" }));
  put("c9c3-generation-guards/tombstone.json", JSON.stringify({ state: "CONSUMED" }));
  put("b3-local-runtime/secrets/marker.bin", Buffer.alloc(64, 9)); // excluded by default
  put("b3-local-runtime/runtime/runtime-status.json", JSON.stringify({ state: "STOPPED" }));
}

try {
  // ---------------- fast section (no PG) ----------------
  seedOwner();
  const b1 = await createBackup({ ownerRoot: owner, backupDir: backups, now: () => new Date("2026-07-18T01:00:00Z").getTime() });
  check("B1 backup created with manifest", existsSync(path.join(b1.path, "MANIFEST.json")), true);
  check("B1 secrets EXCLUDED by default", b1.files, 7);
  const manifest = JSON.parse(readFileSync(path.join(b1.path, "MANIFEST.json"), "utf8"));
  check("B1 manifest carries sha256 for every file", manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), true);
  check("B1 manifest has no absolute owner path", JSON.stringify(manifest).includes(owner.replace(/\\/g, "\\\\")), false);
  check("B1 verify passes", (await verifyBackup({ backupPath: b1.path })).ok, true);

  const b2 = await createBackup({ ownerRoot: owner, backupDir: backups, includeSecrets: true, now: () => new Date("2026-07-18T02:00:00Z").getTime() });
  check("B1 includeSecrets opt-in adds the secrets file", b2.files, 8);

  // Runtime running → backup refused.
  writeFileSync(path.join(owner, "b3-local-runtime", "runtime", "runtime-status.json"), JSON.stringify({ state: "WAITING_FOR_USER_UI_INPUT" }));
  await rejects("B2 running runtime refuses backup", () => createBackup({ ownerRoot: owner, backupDir: backups }), "E_BACKUP_RUNTIME_RUNNING");
  writeFileSync(path.join(owner, "b3-local-runtime", "runtime", "runtime-status.json"), JSON.stringify({ state: "STOPPED" }));

  // Interrupted backup (disk-full simulation): injected copy failure → NO final dir appears.
  let copies = 0;
  const failingCopy = (src, dest) => { copies += 1; if (copies === 4) throw Object.assign(new Error("no space"), { code: "ENOSPC" }); copyFileSync(src, dest); };
  const before = readdirSync(backups).filter((d) => d.startsWith("backup-")).length;
  await rejects("B3 interrupted backup fails cleanly (ENOSPC)", () => createBackup({ ownerRoot: owner, backupDir: backups, copyFile: failingCopy, now: () => new Date("2026-07-18T03:00:00Z").getTime() }), "ENOSPC");
  check("B3 no final dir + no temp left behind", [readdirSync(backups).filter((d) => d.startsWith("backup-")).length, readdirSync(backups).filter((d) => d.startsWith(".tmp-")).length], [before, 0]);

  // Tamper detection.
  const victim = manifest.files.find((f) => f.path.endsWith("final.mp4"));
  writeFileSync(path.join(b1.path, victim.path.split("/").join(path.sep)), Buffer.alloc(4096, 6));
  const bad = await verifyBackup({ backupPath: b1.path });
  check("B4 tampered backup detected", [bad.ok, bad.mismatched], [false, [victim.path]]);
  copyFileSync(path.join(owner, "generated-media", "movies", "mov_X", "renders", "v1", "final.mp4"), path.join(b1.path, victim.path.split("/").join(path.sep)));
  check("B4 repaired backup verifies again", (await verifyBackup({ backupPath: b1.path })).ok, true);

  // Restore guards.
  const target = path.join(root, "restore-target");
  const r1 = await restoreBackup({ backupPath: b1.path, targetOwnerRoot: target, productionOwnerRoot: owner });
  check("R1 restore into empty target", [r1.restored, existsSync(path.join(target, "generated-media", "jobs", "job_X", "generated.mp4"))], [7, true]);
  check("R1 no interrupted marker after success", restoreWasInterrupted(target), false);
  await rejects("R2 non-empty target requires explicit confirm", () => restoreBackup({ backupPath: b1.path, targetOwnerRoot: target, productionOwnerRoot: owner }), "E_RESTORE_TARGET_NOT_EMPTY");
  check("R2 explicit confirm overwrites", (await restoreBackup({ backupPath: b1.path, targetOwnerRoot: target, productionOwnerRoot: owner, confirmNonEmpty: true })).restored, 7);
  await rejects("R3 production owner root needs --confirm-production", () => restoreBackup({ backupPath: b1.path, targetOwnerRoot: owner, productionOwnerRoot: owner, confirmNonEmpty: true }), "E_RESTORE_PRODUCTION_GUARD");
  // Interrupted restore leaves a detectable marker.
  const target2 = path.join(root, "restore-target2");
  let rcopies = 0;
  await rejects("R4 interrupted restore fails cleanly", () => restoreBackup({
    backupPath: b1.path, targetOwnerRoot: target2, productionOwnerRoot: owner,
    copyFile: (s, d) => { rcopies += 1; if (rcopies === 3) throw Object.assign(new Error("no space"), { code: "ENOSPC" }); copyFileSync(s, d); }
  }), "ENOSPC");
  check("R4 interrupted restore is detectable (marker present)", restoreWasInterrupted(target2), true);

  // Retention: newest N kept, only valid backup dirs touched.
  writeFileSync(path.join(backups, "unrelated.txt"), "keep me");
  const b3 = await createBackup({ ownerRoot: owner, backupDir: backups, retentionCount: 2, now: () => new Date("2026-07-18T04:00:00Z").getTime() });
  const names = readdirSync(backups).filter((d) => d.startsWith("backup-")).sort();
  check("R5 retention keeps newest 2", names.length, 2);
  check("R5 retention reported + unrelated files untouched", [b3.deletedByRetention.length, existsSync(path.join(backups, "unrelated.txt"))], [1, true]);

  // ---------------- drill section (real portable PostgreSQL) ----------------
  if (!livePgAvailable()) {
    console.log(`Step 5C.12 backup/restore: ${passed} passed, 0 failed (drill SKIPPED — no portable PostgreSQL)`);
    process.exit(0);
  }
  const BIN = process.env.PGBIN || path.join(process.env.AVC_STUDIO_HOME || os.tmpdir(), "postgres", "bin");
  const drillOwner = path.join(path.resolve(BIN, "..", "..", ".disposable-test-pg"), `cp5c12-owner-${Date.now()}`);
  const dataDir = path.join(drillOwner, "b3-local-runtime", "postgres-data");
  mkdirSync(dataDir, { recursive: true });
  const run = (exe, args, detach = false) => new Promise((resolve, reject) => {
    const child = spawn(path.join(BIN, exe), args, { windowsHide: true, stdio: detach ? "ignore" : "pipe" });
    let out = "", errT = "", done = false;
    const fin = (fn, a) => { if (!done) { done = true; clearTimeout(tm); fn(a); } };
    const tm = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } fin(reject, new Error(`${exe} timeout`)); }, 60_000);
    if (child.stdout) child.stdout.on("data", (d) => { out += d; });
    if (child.stderr) child.stderr.on("data", (d) => { errT += d; });
    child.on("error", (e) => fin(reject, e));
    child.on("close", (c) => (c === 0 ? fin(resolve, out) : fin(reject, new Error(`${exe} exited ${c}: ${errT || out}`))));
  });
  const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  const connectRetry = async (url) => { let last; for (let i = 0; i < 40; i += 1) { const c = new Client({ connectionString: url }); try { await c.connect(); return c; } catch (e) { last = e; try { await c.end(); } catch { /* */ } await new Promise((r) => setTimeout(r, 250)); } } throw last; };

  await run("initdb.exe", ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-sync"]);
  const port = await freePort();
  await run("pg_ctl.exe", ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", path.join(drillOwner, "pg.log"), "start"], true);
  const admin = await connectRetry(`postgres://postgres@127.0.0.1:${port}/postgres`);
  await admin.query("CREATE ROLE cp_migrator LOGIN NOBYPASSRLS"); await admin.query("CREATE ROLE cp_tenant_app LOGIN NOBYPASSRLS");
  await admin.query("CREATE ROLE cp_ops_enumerator LOGIN BYPASSRLS"); await admin.query("CREATE ROLE cp_readonly_observer LOGIN NOBYPASSRLS");
  await admin.query("CREATE DATABASE cp5c12_drill OWNER cp_migrator");
  await admin.end();
  const db = await connectRetry(`postgres://postgres@127.0.0.1:${port}/cp5c12_drill`);
  try { await db.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
  await db.query("GRANT USAGE, CREATE ON SCHEMA public TO cp_migrator");
  const mig = await connectRetry(`postgres://cp_migrator@127.0.0.1:${port}/cp5c12_drill`);
  const applied = await mrun(mig, { dir: MIGRATIONS_DIR, appVersion: "drill" });
  check("D0 drill cluster has the full migration set", applied.applied.length + applied.alreadyApplied, loadMigrationFiles(MIGRATIONS_DIR).length);
  await mig.end();

  // Fixture: one COMPLETED project + correlated scene + COMPLETED render whose media hash matches.
  const ws = generateId("ws"), usr = generateId("usr"), mov = newId("mov"), msc = newId("msc"), rnd = newId("rnd");
  const mediaRel = `movies/${mov}/renders/v1/final.mp4`;
  const mediaAbs = path.join(drillOwner, "generated-media", mediaRel.split("/").join(path.sep));
  mkdirSync(path.dirname(mediaAbs), { recursive: true });
  writeFileSync(mediaAbs, Buffer.alloc(6000, 8));
  const mediaSha = await hashFile(mediaAbs);
  await db.query("INSERT INTO users (id,email) VALUES ($1,$2)", [usr, `d-${usr}@t.test`]);
  await db.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'DRILL',$2)", [ws, usr]);
  await db.query("INSERT INTO movie_projects (workspace_id,id,title,status,final_media) VALUES ($1,$2,'Drill Movie','COMPLETED',$3)", [ws, mov, JSON.stringify({ relativePath: mediaRel, sizeBytes: 6000 })]);
  await db.query("INSERT INTO movie_scenes (workspace_id,id,movie_project_id,ordinal,video_prompt,state,generation_job_id,generation_attempt_id,result_id) VALUES ($1,$2,$3,0,'p','COMPLETED','job_01ARZ3NDEKTSV4RRFFQ69G5FAV','attempt_01ARZ3NDEKTSV4RRFFQ69G5FAV','res-1')", [ws, msc, mov]);
  await db.query("INSERT INTO movie_renders (workspace_id,id,movie_project_id,version,render_hash,state,final_media) VALUES ($1,$2,$3,1,'sha256:x','COMPLETED',$4)", [ws, rnd, mov, JSON.stringify({ relativePath: mediaRel, sizeBytes: 6000, sha256: mediaSha })]);
  await db.end();
  await run("pg_ctl.exe", ["-D", dataDir, "-m", "fast", "stop"], true);
  writeFileSync(path.join(drillOwner, "b3-local-runtime", "runtime", "..", "..", "drill-note.txt").replace(/\\[^\\]+$/, "\\drill-note.txt"), "");
  mkdirSync(path.join(drillOwner, "b3-local-runtime", "runtime"), { recursive: true });
  writeFileSync(path.join(drillOwner, "b3-local-runtime", "runtime", "runtime-status.json"), JSON.stringify({ state: "STOPPED" }));

  // Cold backup of the REAL cluster + media, then restore + drill on the restored copy.
  const drillBackups = path.join(drillOwner, "backups");
  const bd = await createBackup({ ownerRoot: drillOwner, backupDir: drillBackups, now: () => Date.now() });
  check("D1 real-cluster backup verifies", (await verifyBackup({ backupPath: bd.path })).ok, true);
  const restored = path.join(drillOwner, "restored");
  await restoreBackup({ backupPath: bd.path, targetOwnerRoot: restored, productionOwnerRoot: drillOwner });
  const report = await runRestoreDrill({ restoredOwnerRoot: restored, pgBinDir: BIN.split("/").join(path.sep), dbName: "cp5c12_drill" });
  check("D2 drill: restored cluster starts + migrations complete", report.checks.migrations, loadMigrationFiles(MIGRATIONS_DIR).length);
  check("D2 drill: project rows present", report.checks.movieProjects, 1);
  check("D2 drill: scene correlation intact", [report.checks.completedScenesWithCorrelation, report.checks.completedScenesMissingCorrelation], [1, 0]);
  check("D2 drill: render media hash-verified against the DB", [report.checks.completedRenders, report.checks.renderMediaVerified, report.checks.renderMediaBad], [1, 1, 0]);
  check("D2 drill overall OK", report.ok, true);
  rmSync(drillOwner, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

  console.log(`Step 5C.12 backup/restore: ${passed} passed, 0 failed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
