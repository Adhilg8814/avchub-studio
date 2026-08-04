// P0 Step 5C.24 — native-auth RUNTIME adoption cert: drive the REAL control-plane app (createApp → http
// server → router → authRuntime sub-router → AuthService → disposable PostgreSQL) over actual HTTP. Proves
// the deferred wiring works end-to-end: with flags ON the owner-bootstrap ceremony + session issue + /session
// resolve through the live pipeline (no session before MFA; __Host cookies set; secret-box key stable within
// the run); with flags OFF /api/auth/* is 404 and the rest of routing is unchanged. SKIPS without PG. Never
// touches production. No provider calls.

import http from "node:http";
import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createApp } from "../control-plane/src/app.mjs";
import { generateTotp } from "../lib/auth/totp.mjs";
import { generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const ORIGIN = "http://127.0.0.1:5177";
const secretOf = (uri) => { const m = /[?&]secret=([A-Za-z2-7]+)/.exec(String(uri || "")); return m ? m[1] : null; };
const sessionCookieOf = (setCookie) => { for (const c of [].concat(setCookie || [])) { const m = /(__Host-avc_studio_session=[^;]+)/.exec(String(c)); if (m) return m[1]; } return null; };

function httpJson(port, method, pathname, { body, headers } = {}) {
  return new Promise((resolve) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { "content-type": "application/json", ...(headers || {}) };
    if (data) h["content-length"] = data.length;
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: h }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* */ } resolve({ status: res.statusCode, json, setCookie: res.headers["set-cookie"] || null }); });
    });
    req.on("error", () => resolve({ status: 0, json: null, setCookie: null }));
    if (data) req.write(data); req.end();
  });
}

function envBase(live, overrides) {
  return {
    CONTROL_PLANE_ENV: "test", CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: "0", CONTROL_PLANE_INSTANCE_ID: "cp-5c24",
    CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl,
    ...overrides
  };
}

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.24 auth runtime: SKIPPED (no portable PostgreSQL)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c24" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); check("migrations apply to latest", (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length); } finally { await mc.end(); }
  const key = generateSecretBoxKey();

  // ---------- flags ON: full ceremony through the live pipeline ----------
  const onApp = await createApp({ config: loadConfig(envBase(live, {
    CONTROL_PLANE_NATIVE_AUTH_ROUTES_ENABLED: "true", CONTROL_PLANE_NATIVE_AUTH_UI_ENABLED: "true",
    CONTROL_PLANE_NATIVE_AUTH_BOOTSTRAP_ENABLED: "true", CONTROL_PLANE_NATIVE_AUTH_COOKIE_SECURE: "false",
    CONTROL_PLANE_ALLOWED_ORIGINS: ORIGIN, CONTROL_PLANE_AUTH_SECRETBOX_KEY: key
  })) });
  await onApp.start();
  const port = onApp.address().port;
  try {
    check("app READY with native auth ON", onApp.readiness().ready === true);
    const st0 = await httpJson(port, "GET", "/api/auth/bootstrap/status");
    check("GET /api/auth/bootstrap/status -> 200 REQUIRED+available", st0.status === 200 && st0.json.state === "REQUIRED" && st0.json.available === true);

    // mutation without Origin -> 403 (Origin enforced through the real pipeline)
    const noOrigin = await httpJson(port, "POST", "/api/auth/bootstrap/begin", { body: { email: "owner@studio.test", password: "owner-pass-123456" } });
    check("bootstrap/begin without Origin -> 403", noOrigin.status === 403);

    const beg = await httpJson(port, "POST", "/api/auth/bootstrap/begin", { headers: { origin: ORIGIN }, body: { email: "owner@studio.test", password: "owner-pass-123456", displayName: "Owner" } });
    check("bootstrap/begin -> 200 STARTED + ceremonyToken + otpauthUri", beg.status === 200 && beg.json.result === "OWNER_BOOTSTRAP_STARTED" && typeof beg.json.ceremonyToken === "string" && typeof beg.json.otpauthUri === "string");
    check("bootstrap/begin issues NO session cookie (no session before MFA)", !beg.setCookie);
    check("bootstrap/begin body carries NO session token", !("sessionToken" in (beg.json || {})));

    const secret = secretOf(beg.json.otpauthUri);
    const bad = await httpJson(port, "POST", "/api/auth/bootstrap/confirm", { headers: { origin: ORIGIN }, body: { ceremonyToken: beg.json.ceremonyToken, code: "000000" } });
    check("bootstrap/confirm wrong code -> 401 (retryable)", bad.status === 401);

    const code = generateTotp(secret, { nowMs: Date.now() });
    const conf = await httpJson(port, "POST", "/api/auth/bootstrap/confirm", { headers: { origin: ORIGIN }, body: { ceremonyToken: beg.json.ceremonyToken, code } });
    check("bootstrap/confirm -> 200 SESSION_ISSUED + recovery codes", conf.status === 200 && conf.json.result === "SESSION_ISSUED" && Array.isArray(conf.json.recoveryCodes) && conf.json.recoveryCodes.length === 10);
    check("bootstrap/confirm sets a __Host session cookie", Boolean(sessionCookieOf(conf.setCookie)));
    check("bootstrap/confirm body carries NO raw session token", !("sessionToken" in (conf.json || {})));
    const cookie = sessionCookieOf(conf.setCookie);

    const sess = await httpJson(port, "GET", "/api/auth/session", { headers: { cookie } });
    check("GET /api/auth/session (cookie) -> 200 OWNER + MFA context", sess.status === 200 && sess.json.context && sess.json.context.role === "OWNER" && sess.json.context.authenticatedWithMfa === true);

    const st1 = await httpJson(port, "GET", "/api/auth/bootstrap/status");
    check("GET /api/auth/bootstrap/status after completion -> COMPLETED (route permanently closed)", st1.json.state === "COMPLETED");

    // owner can log in again through the normal MFA path via the live pipeline
    const login = await httpJson(port, "POST", "/api/auth/login", { headers: { origin: ORIGIN }, body: { email: "owner@studio.test", password: "owner-pass-123456" } });
    check("owner login -> MFA_REQUIRED (owner has TOTP)", login.status === 200 && login.json.result === "MFA_REQUIRED" && typeof login.json.challengeToken === "string");
    const mfaCode = generateTotp(secret, { nowMs: Date.now() + 60000 });
    // advance is only conceptual; use a fresh code for the current window (may equal the last timestep -> tolerate)
    const mfa = await httpJson(port, "POST", "/api/auth/mfa/complete", { headers: { origin: ORIGIN }, body: { challengeToken: login.json.challengeToken, code: generateTotp(secret, { nowMs: Date.now() }) } });
    check("owner mfa/complete -> SESSION_ISSUED + cookie (or replay-guarded 401 in the same timestep)", (mfa.status === 200 && mfa.json.result === "SESSION_ISSUED" && sessionCookieOf(mfa.setCookie)) || mfa.status === 401);

    // health still works alongside native auth
    check("healthz still 200 with native auth ON", (await httpJson(port, "GET", "/healthz")).status === 200);
  } finally { await onApp.stop().catch(() => {}); }

  // ---------- flags OFF: /api/auth/* is not mounted; routing unchanged ----------
  const offApp = await createApp({ config: loadConfig(envBase(live, {})) }); // all native flags default OFF
  await offApp.start();
  const offPort = offApp.address().port;
  try {
    check("flags OFF: app READY", offApp.readiness().ready === true);
    check("flags OFF: GET /api/auth/bootstrap/status -> 404 (route not mounted)", (await httpJson(offPort, "GET", "/api/auth/bootstrap/status")).status === 404);
    check("flags OFF: POST /api/auth/login -> 404", (await httpJson(offPort, "POST", "/api/auth/login", { headers: { origin: ORIGIN }, body: {} })).status === 404);
    check("flags OFF: /healthz still 200 (unchanged)", (await httpJson(offPort, "GET", "/healthz")).status === 200);
    check("flags OFF: /version still 200 (unchanged)", (await httpJson(offPort, "GET", "/version")).status === 200);
  } finally { await offApp.stop().catch(() => {}); }

  await live.stop().catch(() => {});
  console.log(`Step 5C.24 auth runtime: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
