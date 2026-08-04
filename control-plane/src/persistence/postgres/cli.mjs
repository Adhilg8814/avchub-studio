#!/usr/bin/env node
// P0 Step 5C.2 — database CLI (command-only). Normal service startup NEVER runs migrations;
// only this CLI does, using the MIGRATION url (CONTROL_PLANE_DB_MIGRATION_URL) which is NOT in
// the running service's config. Output is sanitized — no URL/password/SQL ever printed.

import { pathToFileURL } from "node:url";
import { status, migrate, validate, MIGRATIONS_DIR } from "./migrations.mjs";
import { safeConnDescriptor } from "./pools.mjs";
import { assertSafeTestDb } from "./test-db-safety.mjs";

async function pgClient(url) {
  let pg;
  try { pg = (await import("pg")).default ?? (await import("pg")); }
  catch { throw new Error("PostgreSQL driver (pg) is not installed"); }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.query.bind(client); // noop to keep tree-shakers away
  await client.connect();
  await client.query("SET timezone='UTC'; SET search_path=public; SET lock_timeout='5s'; SET statement_timeout='60s'");
  return client;
}

function requireMigrationUrl() {
  const url = process.env.CONTROL_PLANE_DB_MIGRATION_URL;
  if (!url) { console.error(JSON.stringify({ ok: false, error: "MIGRATION_URL_NOT_SET", hint: "set CONTROL_PLANE_DB_MIGRATION_URL (command-only)" })); process.exit(2); }
  return url;
}

async function cmdStatus() {
  const url = requireMigrationUrl();
  const c = await pgClient(url);
  try {
    const s = await status(c, MIGRATIONS_DIR);
    console.log(JSON.stringify({ ok: true, target: safeConnDescriptor(url), state: s.state, current: s.current, latest: s.latest, pending: s.pending, appliedCount: s.appliedCount, fileCount: s.fileCount }, null, 2));
    return 0;
  } finally { await c.end(); }
}

async function cmdValidate() {
  const url = requireMigrationUrl();
  const c = await pgClient(url);
  try {
    const s = await validate(c, MIGRATIONS_DIR);
    console.log(JSON.stringify({ ok: true, state: s.state, current: s.current, latest: s.latest }, null, 2));
    return 0;
  } catch (e) { console.error(JSON.stringify({ ok: false, error: e.code || "E_VALIDATE_FAILED" })); return 1; }
  finally { await c.end(); }
}

async function cmdMigrate() {
  const url = requireMigrationUrl();
  const c = await pgClient(url);
  try {
    const appVersion = process.env.CONTROL_PLANE_COMMIT_SHA || process.env.CONTROL_PLANE_VERSION || null;
    const r = await migrate(c, { dir: MIGRATIONS_DIR, appVersion });
    console.log(JSON.stringify({ ok: true, target: safeConnDescriptor(url), applied: r.applied.map((a) => a.version), totalFiles: r.totalFiles }, null, 2));
    return 0;
  } catch (e) { console.error(JSON.stringify({ ok: false, error: e.code || "E_MIGRATE_FAILED", version: e.version ?? null, sqlstate: e.sqlstate ?? null })); return 1; }
  finally { await c.end(); }
}

async function cmdResetTest() {
  const url = process.env.CONTROL_PLANE_TEST_DB_URL || null;
  const allow = process.env.CONTROL_PLANE_DB_ALLOW_DESTRUCTIVE_TESTS === "true";
  try { assertSafeTestDb({ url, allowDestructive: allow }); }
  catch (e) { console.error(JSON.stringify({ ok: false, error: "E_UNSAFE_TEST_DB", reasons: e.reasons || [] })); return 1; }
  const c = await pgClient(url);
  try {
    // Disposable TEST database only (guard above). Drop + recreate the schema.
    await c.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    console.log(JSON.stringify({ ok: true, reset: safeConnDescriptor(url).database }));
    return 0;
  } catch (e) { console.error(JSON.stringify({ ok: false, error: "E_RESET_FAILED" })); return 1; }
  finally { await c.end(); }
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "status") return await cmdStatus();
    if (cmd === "validate") return await cmdValidate();
    if (cmd === "migrate") return await cmdMigrate();
    if (cmd === "reset-test") return await cmdResetTest();
    console.error(JSON.stringify({ ok: false, error: "UNKNOWN_COMMAND", commands: ["status", "validate", "migrate", "reset-test"] }));
    return 2;
  } catch (e) {
    // Never leak the connection string / SQL.
    console.error(JSON.stringify({ ok: false, error: "E_DB_CLI_FAILED", reason: String(e.code || e.message || "").slice(0, 80) }));
    return 1;
  }
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) main().then((code) => process.exit(code));

export { cmdStatus, cmdMigrate, cmdValidate, cmdResetTest };
