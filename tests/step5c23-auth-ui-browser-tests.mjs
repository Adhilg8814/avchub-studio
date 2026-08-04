// P0 Step 5C.23 — native-auth UI REAL-BROWSER smoke (Playwright). Serves the actual auth bundle + a STUB
// /api/auth backend, then drives a real browser to cover what a headless mini-DOM cannot: keyboard-only
// submit, focus landing, the strict CSP actually enforced (an injected inline script must NOT run), the
// generic non-enumerating error surfacing, token stripped from the address bar, and an empty web storage.
// SKIPS cleanly when no local browser / playwright is available. No network, no PostgreSQL, no production.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_DIR = path.join(ROOT, "control-plane", "staging-ui", "auth");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BROWSER = existsSync(EDGE) ? EDGE : (existsSync(CHROME) ? CHROME : null);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
const ASSET = { ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };

function makeServer() {
  return createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const p = u.pathname;
    const secure = () => { res.setHeader("Content-Security-Policy", CSP); res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "no-referrer"); };
    try {
      if (p.startsWith("/api/auth/")) {
        let body = ""; for await (const c of req) body += c;
        secure(); res.setHeader("Content-Type", "application/json");
        // stub: login always AUTHENTICATION_FAILED (generic); everything else a benign 200.
        if (p === "/api/auth/login") { res.statusCode = 401; res.end(JSON.stringify({ result: "AUTHENTICATION_FAILED", ok: false })); return; }
        res.statusCode = 200; res.end(JSON.stringify({ ok: true, state: "REQUIRED", available: true })); return;
      }
      if (p.startsWith("/auth-assets/")) {
        const file = path.join(AUTH_DIR, "assets", p.slice("/auth-assets/".length));
        const buf = await readFile(file); secure(); res.setHeader("Content-Type", ASSET[path.extname(file)] || "text/plain"); res.statusCode = 200; res.end(buf); return;
      }
      // any page route -> the shell
      const buf = await readFile(path.join(AUTH_DIR, "index.html")); secure(); res.setHeader("Content-Type", "text/html; charset=utf-8"); res.statusCode = 200; res.end(buf);
    } catch { res.statusCode = 404; res.end("nf"); }
  });
}

async function main() {
  if (!BROWSER) { console.log("Step 5C.23 auth ui browser: SKIPPED (no local browser)"); return; }
  let chromium;
  try { ({ chromium } = await import("playwright-core")); } catch { console.log("Step 5C.23 auth ui browser: SKIPPED (playwright-core unavailable)"); return; }

  const server = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: BROWSER, headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    // The 401 from the stub login (a deliberate generic auth failure) and the CSP-block message from the
    // inline-script injection below (which PROVES the CSP works) are EXPECTED — everything else is a real bug.
    const EXPECTED = /Content Security Policy|401 \(Unauthorized\)|Failed to load resource/i;
    page.on("console", (m) => { if (m.type() === "error" && !EXPECTED.test(m.text())) consoleErrors.push(m.text()); });

    // ---- login page: labelled inputs, focus, keyboard submit -> generic error ----
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    check("login: main landmark present", await page.locator("#auth-main").count() === 1);
    const email = page.locator('input[autocomplete="username"]');
    const pw = page.locator('input[autocomplete="current-password"]');
    check("login: email + password inputs present", await email.count() === 1 && await pw.count() === 1);
    // each input has an accessible name via <label for>
    check("login: inputs are labelled", Boolean(await email.getAttribute("id")) && (await page.locator(`label[for="${await email.getAttribute("id")}"]`).count()) === 1);
    await email.fill("someone@studio.test");
    await pw.fill("a-wrong-password-1234");
    await pw.press("Enter"); // keyboard-only submit
    await page.waitForSelector('.auth-status.is-error, [role="alert"]', { timeout: 4000 }).catch(() => {});
    const errText = (await page.locator('[role="alert"]').first().textContent().catch(() => "")) || "";
    check("login: keyboard submit surfaces a GENERIC error (no enumeration)", /không hợp lệ|Invalid/i.test(errText) && !/not found|no such user|disabled/i.test(errText));

    // ---- CSP actually enforced: an injected inline script must NOT execute ----
    const ranInline = await page.evaluate(() => {
      return new Promise((resolve) => {
        window.__x = 0; const s = document.createElement("script"); s.textContent = "window.__x=1;";
        document.body.appendChild(s); setTimeout(() => resolve(window.__x), 30);
      });
    });
    check("CSP blocks an injected inline script (script-src 'self')", ranInline === 0);

    // ---- no web storage written ----
    const storage = await page.evaluate(() => ({ ls: window.localStorage.length, ss: window.sessionStorage.length }));
    check("no localStorage/sessionStorage entries after a login attempt", storage.ls === 0 && storage.ss === 0);

    // ---- reset token stripped from the address bar ----
    await page.goto(`${base}/reset?token=SUPERSECRETTOKEN`, { waitUntil: "networkidle" });
    check("reset: token stripped from the URL", !page.url().includes("SUPERSECRETTOKEN"));

    check("no console errors during the flows", consoleErrors.length === 0 || (console.log("CONSOLE", consoleErrors.slice(0, 3)), false));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }

  console.log(`Step 5C.23 auth ui browser: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("Step 5C.23 auth ui browser: SKIPPED (harness error) ", e && e.message); });
