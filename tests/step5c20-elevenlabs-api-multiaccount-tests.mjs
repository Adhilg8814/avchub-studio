// P0 Step 5C.20 — ElevenLabs API multi-account credential registry (DPAPI, fake runner), provider-free.
// Proves: each el_ account owns an ISOLATED encrypted key; account A's key is NEVER usable for B; the
// account id is validated; listConfigured/isConfigured only report accounts that actually have a key; the
// stored metadata carries the accountId; on-disk ciphertext never contains the plaintext key. NO network,
// NO real key, NO real DPAPI spawn.
import { createElevenLabsApiCredentialRegistry } from "../lib/movie/elevenlabs-api-key-store.mjs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log("FAIL", n); } };
const throwsSync = (n, fn, code) => { try { fn(); failed++; console.log("FAIL(no throw)", n); } catch (e) { if (!code || e.code === code) passed++; else { failed++; console.log("FAIL(code)", n, "got", e.code); } } };

// fake DPAPI runner (base64 round-trip stands in for ProtectedData) — never spawns PowerShell
const fakeRunner = async (mode, secret) => mode === "protect" ? Buffer.from(String(secret), "utf8").toString("base64") : Buffer.from(String(secret), "base64").toString("utf8");

const A = "el_06ba09f2ddf6f2836010";
const B = "el_1111222233334444aaaa";
const KEY_A = "sk_account_A_key_1234567890ABCDEF";
const KEY_B = "sk_account_B_key_ZZZZ0987654321wxyz";

async function run() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "el-reg-"));
  const registry = createElevenLabsApiCredentialRegistry({ baseDir, runner: fakeRunner });

  // ---- A. invalid account id rejected (never builds a store path) ----
  throwsSync("A invalid account id rejected", () => registry.store("not_an_el_id"), "API_KEY_INVALID");
  check("A nothing configured initially", (await registry.listConfigured()).length === 0);
  check("A isConfigured(A) false initially", (await registry.isConfigured(A)) === false);

  // ---- B. per-account isolation: save A, then A is configured but B is not ----
  await registry.store(A).save({ apiKey: KEY_A, accountId: A, name: "AVC Studio TTS", permissions: ["text_to_speech"] });
  check("B A configured after save", (await registry.isConfigured(A)) === true);
  check("B B still NOT configured", (await registry.isConfigured(B)) === false);
  check("B A key round-trips server-side", (await registry.store(A).getKey()) === KEY_A);
  check("B B getKey is null (no cross-account leak)", (await registry.store(B).getKey()) === null);
  const metaA = await registry.store(A).metadata();
  check("B A metadata carries accountId + maskedHint (no key)", metaA.accountId === A && metaA.maskedHint === "sk_a…DEF" && !JSON.stringify(metaA).includes(KEY_A));

  // ---- C. second account is fully independent; keys never cross ----
  await registry.store(B).save({ apiKey: KEY_B, accountId: B, name: "AVC Studio TTS B", permissions: ["text_to_speech"] });
  check("C B key round-trips its OWN key", (await registry.store(B).getKey()) === KEY_B);
  check("C A key unchanged by B save", (await registry.store(A).getKey()) === KEY_A);
  check("C A key !== B key (isolated ciphertext)", (await registry.store(A).getKey()) !== (await registry.store(B).getKey()));

  // ---- D. listConfigured enumerates both, masked metadata only ----
  const listed = await registry.listConfigured();
  check("D listConfigured returns both accounts", listed.length === 2 && listed.map((x) => x.accountId).sort().join(",") === [A, B].sort().join(","));
  check("D listConfigured never leaks a key", !JSON.stringify(listed).includes(KEY_A) && !JSON.stringify(listed).includes(KEY_B));

  // ---- E. on-disk isolation: each account dir holds only its own ciphertext, no plaintext ----
  const dirs = (await readdir(baseDir)).filter((d) => d.startsWith("el_"));
  check("E one directory per account", dirs.length === 2 && dirs.includes(A) && dirs.includes(B));
  for (const [acc, key] of [[A, KEY_A], [B, KEY_B]]) {
    const files = await readdir(path.join(baseDir, acc));
    const disk = await readFile(path.join(baseDir, acc, files.find((f) => f.endsWith(".json"))), "utf8");
    check(`E ${acc} on-disk file has NO plaintext key`, !disk.includes(key) && disk.includes("ciphertext"));
  }

  // ---- F. remove is per-account (does not affect the other) ----
  await registry.store(A).remove();
  check("F A removed -> not configured", (await registry.isConfigured(A)) === false);
  check("F B still configured after A removed", (await registry.isConfigured(B)) === true);
  check("F listConfigured now only B", (await registry.listConfigured()).map((x) => x.accountId).join(",") === B);

  console.log(`Step 5C.20 elevenlabs api multi-account: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.log("FATAL", e); process.exit(1); });
