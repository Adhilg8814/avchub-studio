// P0 Step 5C.17 — ElevenLabs account store (owner JSON, file-backed), provider-free. Real fs in a temp dir.
import { createElevenLabsAccountStore } from "../lib/movie/elevenlabs-account-store.mjs";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log("FAIL", n); } };
const throwsAsync = async (n, fn, code) => { try { await fn(); failed++; console.log("FAIL(no throw)", n); } catch (e) { if (!code || e.code === code) passed++; else { failed++; console.log("FAIL(code)", n, "got", e.code); } } };

async function run() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "el-store-"));
  const storePath = path.join(dir, "accounts.json");
  let clock = 1000;
  const store = createElevenLabsAccountStore({ storePath, now: () => clock });

  // A. create + view (no secret leak)
  const a = await store.create({ label: "Owner Main", profileDir: "C:\\AVCStudio\\data\\elevenlabs\\profile-1" });
  check("A id shape el_", /^el_[0-9a-f]{20}$/.test(a.id));
  check("A starts unauthenticated + enabled + hasProfile, no raw path", a.authenticated === false && a.disabled === false && a.hasProfile === true && !("profileDir" in a));
  check("A appears in list", (await store.list()).length === 1);

  // B. duplicate profile dir rejected; bad path rejected
  await throwsAsync("B duplicate profile dir", () => store.create({ label: "dup", profileDir: "C:\\AVCStudio\\data\\elevenlabs\\profile-1" }), "E_ELEVENLABS_PROFILE_IN_USE");
  await throwsAsync("B non-absolute profile dir", () => store.create({ label: "x", profileDir: "relative/path" }), "E_ELEVENLABS_PROFILE_DIR");

  // C. authenticate (only via this call), auth-check timestamp advances
  clock = 2000;
  const a2 = await store.setAuthenticated(a.id, true);
  check("C authenticated set + lastAuthCheckAt stamped", a2.authenticated === true && a2.lastAuthCheckAt === 2000);
  check("C can revoke", (await store.setAuthenticated(a.id, false)).authenticated === false);
  await store.setAuthenticated(a.id, true);

  // D. voice map validated + cleaned (drops entries without voiceName)
  const a3 = await store.setVoiceMap(a.id, { "bg-BG": { voiceName: "Charlotte" }, "sv-SE": { nope: 1 }, "da-DK": { voiceName: "Mads", model: "eleven_multilingual_v2" } });
  check("D voice map keeps valid, drops invalid", a3.voiceMap && a3.voiceMap["bg-BG"].voiceName === "Charlotte" && a3.voiceMap["da-DK"].model === "eleven_multilingual_v2" && !a3.voiceMap["sv-SE"]);

  // E. usage accounting accumulates
  clock = 3000;
  await store.markUsed(a.id, { chars: 1200 });
  clock = 3500;
  const a4 = await store.markUsed(a.id, { chars: 800 });
  check("E usage accumulates + lastUsedAt advances", a4.charsUsed === 2000 && a4.lastUsedAt === 3500);

  // E2. voice catalog (dynamic enumeration) + voiceIdentity migration
  clock = 4000;
  const a5 = await store.setVoiceCatalog(a.id, [
    { displayName: "Charlotte", voiceIdentity: "e336504eb956419d8f09e26bd514f906", avatar: "https://x/y.png", selectable: true },
    { displayName: "Adam", voiceIdentity: "1b0aef06ad1848988df4847a8d377baf" },
    { displayName: "NoAvatar" } // no id → kept, identity null
  ]);
  check("E2 catalog persisted + timestamped", Array.isArray(a5.voiceCatalog) && a5.voiceCatalog.length === 3 && a5.voiceCatalogAt === 4000);
  check("E2 catalog carries stable identity + avatar", a5.voiceCatalog[0].voiceIdentity === "e336504eb956419d8f09e26bd514f906" && a5.voiceCatalog[0].avatar.startsWith("https://"));
  const a6 = await store.setVoiceMap(a.id, { "bg-BG": { voiceName: "Charlotte", voiceIdentity: "e336504eb956419d8f09e26bd514f906" }, "sv-SE": { voiceName: "Sarah" } });
  check("E2 voiceMap keeps voiceIdentity when given", a6.voiceMap["bg-BG"].voiceIdentity === "e336504eb956419d8f09e26bd514f906" && !a6.voiceMap["sv-SE"].voiceIdentity);
  const a7 = await store.setVoiceMap(a.id, { "bg-BG": { voiceName: "X", voiceIdentity: "bad id with spaces!!" } });
  check("E2 invalid voiceIdentity dropped", a7.voiceMap["bg-BG"].voiceName === "X" && !a7.voiceMap["bg-BG"].voiceIdentity);
  await store.setVoiceMap(a.id, { "bg-BG": { voiceName: "Charlotte" }, "sv-SE": { voiceName: "Sarah" }, "da-DK": { voiceName: "Charlotte" } });

  // F. disable
  check("F disable", (await store.setDisabled(a.id, true)).disabled === true);
  await store.setDisabled(a.id, false);

  // G. resolveInternal exposes the raw profile dir (daemon-facing only)
  const raw = await store.resolveInternal(a.id);
  check("G resolveInternal has profileDir", raw.profileDir.includes("profile-1"));

  // H. invalid id + not found
  await throwsAsync("H bad id", () => store.setAuthenticated("nope", true), "E_ELEVENLABS_ACCOUNT_NOT_FOUND");
  await throwsAsync("H missing", () => store.resolveInternal("el_00000000000000000000"), "E_ELEVENLABS_ACCOUNT_NOT_FOUND");

  // I. corrupt file -> resilient empty, not a crash
  await writeFile(storePath, "{ this is not json", "utf8");
  check("I corrupt file -> empty list", (await store.list()).length === 0);

  // J. persistence across store instances (a fresh create after corruption overwrites cleanly)
  const b = await store.create({ label: "Second", profileDir: path.join(dir, "profile-2") });
  const store2 = createElevenLabsAccountStore({ storePath, now: () => clock });
  check("J second instance reads the same file", (await store2.list()).some((x) => x.id === b.id));

  // K. remove
  await store.remove(b.id);
  check("K removed", !(await store.list()).some((x) => x.id === b.id));

  console.log(`Step 5C.17 elevenlabs store: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.log("FATAL", e); process.exit(1); });
