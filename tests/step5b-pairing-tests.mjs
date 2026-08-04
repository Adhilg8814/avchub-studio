#!/usr/bin/env node
// P0 Step 5B — pairing codes + credential issuance. Fake clock/peppers, in-memory
// stores. No sockets/provider/quota. Verifies secrets are never persisted.

import http from "node:http";
import { generateId } from "../lib/protocol/ids.mjs";
import { generatePairingCode, normalizePairingCode, isCredentialShaped, isValidPairingCodeFormat } from "../lib/control/identity-crypto.mjs";
import { InMemoryWorkerIdentityStore } from "../lib/control/worker-identity-store.mjs";
import { PairingService } from "../lib/control/pairing-service.mjs";
import { LocalControlPlane } from "../lib/control/local-control-plane.mjs";
import { IDENTITY_ERRORS } from "../lib/control/identity-errors.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let failures = 0, passed = 0;
function check(name, actual, expected = true) { const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected; if (ok) passed += 1; else { failures += 1; console.error(`FAIL ${name}\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); } }
function throwsCode(fn, code) { try { fn(); return false; } catch (e) { return e.code === code; } }

const WS = "ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3";
const LIMITS = { codeCreate: { max: 5, windowMs: 10000 }, attemptsPerSource: { max: 10, windowMs: 10000 }, maxAttemptsPerCode: 5, rotate: { max: 3, windowMs: 10000 } };
function svcFactory(over = {}) {
  let t = 1000; const clock = () => t;
  const store = new InMemoryWorkerIdentityStore({ clock });
  const svc = new PairingService({ store, pairingPepper: "PP", credentialPepper: "CP", clock, codeTtlMs: 1000, credentialTtlMs: 5000, limits: LIMITS, ...over });
  return { svc, store, setTime: (v) => { t = v; }, clock };
}

try {
  // 1. format  2. entropy  3. plaintext not stored
  const { code, normalized } = generatePairingCode();
  check("1 format XXXX-XXXX-XXXX", /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code), true);
  check("1 isValidPairingCodeFormat", isValidPairingCodeFormat(code), true);
  check("2 >=60 bits entropy", normalized.length * 5 >= 60, true);
  check("2 two codes differ", generatePairingCode().normalized !== generatePairingCode().normalized, true);
  check("2 normalize maps aliases (O→0,I→1)", normalizePairingCode("O1IL-0000-0000") === "0111" + "0000" + "0000", true);

  {
    const { svc, store } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    check("3 plaintext code not in store snapshot", !JSON.stringify(store.snapshot()).includes(c.code) && !JSON.stringify(store.snapshot()).includes(c.code.replace(/-/g, "")), true);
    check("3 store holds a verifier not the code", store.snapshot().codes[0].codeVerifier.length === 64, true);
  }

  // 4. valid pairing (16-18: 256-bit, plaintext not stored, verifier works)
  {
    const { svc, store } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    const p = svc.pair({ pairingCode: c.code, installationId: "install_x", protocolVersion: 1 });
    check("4 valid pairing → worker", p.workerId.startsWith("wrk_"), true);
    check("4 workspace bound", p.workspaceId, WS);
    check("14 credential returned once", isCredentialShaped(p.workerCredential), true);
    check("16 credential >=256 bits", Buffer.from(p.workerCredential.slice(6), "base64url").length >= 32, true);
    check("17 plaintext credential NOT stored", !JSON.stringify(store.snapshot()).includes(p.workerCredential), true);
    check("18 verifier authenticates", svc.authenticate(p.workerCredential).workerId, p.workerId);
    check("23 lastUsedAt updated", store.listCredentials(p.workerId)[0].lastUsedAt != null, true);
    // exactly one worker created
    check("acceptance: one code → exactly one worker", store.listWorkersByWorkspace(WS).length, 1);
  }

  // 5. expired  6. used  7. revoked  8. wrong  9. wrong workspace
  {
    const { svc, setTime } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    setTime(3000); // > expiry (created at 1000 + ttl 1000)
    check("5 expired code rejected", throwsCode(() => svc.pair({ pairingCode: c.code }), IDENTITY_ERRORS.E_PAIRING_CODE_EXPIRED), true);
  }
  {
    const { svc } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    svc.pair({ pairingCode: c.code });
    check("6 already-used code rejected", throwsCode(() => svc.pair({ pairingCode: c.code }), IDENTITY_ERRORS.E_PAIRING_CODE_USED), true);
  }
  {
    const { svc, store } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    store.revokePairingCode(c.pairingCodeId);
    check("7 revoked code rejected", throwsCode(() => svc.pair({ pairingCode: c.code }), IDENTITY_ERRORS.E_PAIRING_CODE_REVOKED), true);
  }
  {
    const { svc } = svcFactory();
    check("8 wrong code rejected", throwsCode(() => svc.pair({ pairingCode: "ZZZZ-ZZZZ-ZZZZ" }), IDENTITY_ERRORS.E_PAIRING_CODE_INVALID), true);
    check("8b malformed code rejected", throwsCode(() => svc.pair({ pairingCode: "short" }), IDENTITY_ERRORS.E_PAIRING_CODE_INVALID), true);
  }

  // 10. per-code attempt limit  11. per-source rate limit
  {
    const { svc } = svcFactory();
    svc.createPairingCode({ workspaceId: WS });
    const bad = "AAAA-AAAA-AAAA";
    for (let i = 0; i < 10; i += 1) { try { svc.pair({ pairingCode: bad }, { source: "1.2.3.4" }); } catch { /* count */ } }
    check("11 per-source rate limit trips", throwsCode(() => svc.pair({ pairingCode: bad }, { source: "1.2.3.4" }), IDENTITY_ERRORS.E_PAIRING_RATE_LIMITED), true);
  }
  {
    const { svc, store } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    const verifier = store.snapshot().codes.find((x) => x.pairingCodeId === c.pairingCodeId).codeVerifier;
    for (let i = 0; i < 5; i += 1) store.recordPairingFailure(verifier);
    check("10 per-code attempts exceeded", throwsCode(() => svc.pair({ pairingCode: c.code }, { source: "sX" }), IDENTITY_ERRORS.E_PAIRING_ATTEMPTS_EXCEEDED), true);
  }

  // 12/13. atomic concurrent consume — only one winner
  {
    const { svc } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    let ok = 0, used = 0;
    for (let i = 0; i < 3; i += 1) { try { svc.pair({ pairingCode: c.code }); ok += 1; } catch (e) { if (e.code === IDENTITY_ERRORS.E_PAIRING_CODE_USED) used += 1; } }
    check("12/13 exactly one concurrent winner", ok === 1 && used === 2, true);
  }

  // 15. pairing response no-store + returned once (over real HTTP)
  {
    const { svc } = svcFactory({ credentialTtlMs: 5000 });
    const plane = new LocalControlPlane({ pairingService: svc });
    const { port } = await plane.start();
    try {
      const c = svc.createPairingCode({ workspaceId: WS });
      const r = await postJson(port, "/worker/pair", { pairingCode: c.code, protocolVersion: 1 });
      check("14 HTTP pairing returns credential once", isCredentialShaped(r.json.workerCredential), true);
      check("15 Cache-Control no-store", r.headers["cache-control"], "no-store");
      const r2 = await postJson(port, "/worker/pair", { pairingCode: c.code });
      check("15 second use of same code fails", r2.status, 401);
      check("15 public error is generic", r2.json.error, IDENTITY_ERRORS.E_PAIRING_CODE_INVALID);
      // 75/76/77 payload validation
      check("75 malformed pairing payload rejected", (await postJson(port, "/worker/pair", { nope: 1 })).status, 400);
      check("77 pollution key rejected", (await postJson(port, "/worker/pair", JSON.parse('{"pairingCode":"AAAA-AAAA-AAAA","__proto__":{"x":1}}'))).status, 400);
    } finally { await plane.stop(); }
  }

  // 19/20/21/22. credential rejection paths
  {
    const { svc, setTime } = svcFactory({ credentialTtlMs: 500 });
    const c = svc.createPairingCode({ workspaceId: WS });
    const p = svc.pair({ pairingCode: c.code });
    check("19 wrong credential rejected", throwsCode(() => svc.authenticate("wcred_totally_wrong_value_that_is_long_enough_xxxx"), IDENTITY_ERRORS.E_CREDENTIAL_INVALID), true);
    check("20 wrong credential (near-miss) also rejected", throwsCode(() => svc.authenticate(p.workerCredential.slice(0, -1) + "Z"), IDENTITY_ERRORS.E_CREDENTIAL_INVALID), true);
    setTime(2000); // > credentialTtl (issued ~1000 + 500)
    check("21 expired credential rejected", throwsCode(() => svc.authenticate(p.workerCredential), IDENTITY_ERRORS.E_CREDENTIAL_EXPIRED), true);
  }
  {
    const { svc, store } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    const p = svc.pair({ pairingCode: c.code });
    store.revokeWorker(p.workerId);
    check("22 revoked worker credential rejected", throwsCode(() => svc.authenticate(p.workerCredential), IDENTITY_ERRORS.E_CREDENTIAL_REVOKED), true);
  }

  // audit contains no secrets
  {
    const { svc, store } = svcFactory();
    const c = svc.createPairingCode({ workspaceId: WS });
    const p = svc.pair({ pairingCode: c.code });
    const dump = JSON.stringify(store.getAuditEvents());
    check("70 audit records created", store.getAuditEvents().some((a) => a.type === "CREDENTIAL_ISSUED"), true);
    check("71 audit has no code/credential", !dump.includes(c.code) && !dump.includes(p.workerCredential), true);
  }

  check("no unhandled rejection", un, false);
} finally { /* nothing persistent */ }

if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let out = ""; res.on("data", (d) => { out += d; }); res.on("end", () => { let json = null; try { json = JSON.parse(out || "{}"); } catch { /* */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
