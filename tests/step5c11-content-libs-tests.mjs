// P0 Step 5C.11 — pure content libraries: TextGenerationProvider (prompt/parse/local), subtitle
// helpers (build/parse), the publishing package builder (REAL zip verified by expanding it with an
// independent tool), and the PublisherProvider guards. Provider-free; no network, no quota.
import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildStoryPrompt, parseStoryResponse, createLocalTextProvider, createGrokChatTextProvider, storyPromptHash } from "../lib/movie/text-provider.mjs";
import { buildSrt, parseSrtCues } from "../lib/movie/subtitles.mjs";
import { buildZipBuffer, crc32, buildPublishingPackage } from "../lib/movie/package-builder.mjs";
import { createPackagePublisherProvider, createFacebookPublisherProvider } from "../lib/movie/publisher-provider.mjs";

let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }
async function rejects(name, fn, frag) { try { await fn(); assert.fail(name + " expected reject"); } catch (e) { if (e instanceof assert.AssertionError && /expected reject/.test(e.message)) throw e; check(name, `${e.code || ""} ${e.message || ""}`.includes(frag), true); } }

const dir = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".contentlibs-"));
try {
  // ---- text provider: prompt builder ----
  const prompt = buildStoryPrompt({ idea: "a lighthouse keeper and a lost ship", genre: "drama", tone: "hopeful", visualStyle: "misty film", language: "en", beatCount: 4 });
  check("P1 prompt carries the idea", prompt.includes("lighthouse keeper"), true);
  check("P1 prompt pins the JSON contract", prompt.includes('"beats"') && prompt.includes("fenced json"), true);
  check("P1 prompt hash deterministic", storyPromptHash(prompt), storyPromptHash(prompt));
  await rejects("P1 secret-looking idea rejected", async () => buildStoryPrompt({ idea: "use my password hunter2 https://x.test" }), "E_STORY_UNSAFE_TEXT");

  // ---- text provider: response parser ----
  const goodStory = { title: "The Keeper", synopsis: "A keeper saves a ship.", styleBible: "misty film", characters: [{ name: "Anna", description: "keeper in a wool coat" }], beats: [{ heading: "Dawn", narration: "Anna climbs.", visual: "spiral stairs" }, { heading: "Storm", narration: "The ship appears.", visual: "stormy sea" }, { heading: "Light", narration: "The beam cuts fog.", visual: "beam of light" }] };
  const parsed = parseStoryResponse("Here you go!\n```json\n" + JSON.stringify(goodStory) + "\n```\nEnjoy.");
  check("P2 fenced JSON parsed + validated", [parsed.title, parsed.beats.length, parsed.characters[0].name], ["The Keeper", 3, "Anna"]);
  const parsedBare = parseStoryResponse("prefix " + JSON.stringify(goodStory) + " suffix");
  check("P2 bare JSON object parsed", parsedBare.title, "The Keeper");
  await rejects("P2 empty response rejected", async () => parseStoryResponse("   "), "E_TEXT_RESPONSE_EMPTY");
  await rejects("P2 prose-only response rejected", async () => parseStoryResponse("I cannot write that."), "E_TEXT_RESPONSE_FORMAT");
  await rejects("P2 unsafe story rejected", async () => parseStoryResponse('```json\n{"title":"x https://evil.test","synopsis":"","beats":[]}\n```'), "E_TEXT_RESPONSE_");

  // ---- LOCAL provider ----
  const local = createLocalTextProvider();
  check("P3 LOCAL provider available", local.available(), true);
  const localOut = await local.generateStory({ mode: "IDEA", idea: "a quiet robot learns to paint", targetDurationSeconds: 18 });
  check("P3 LOCAL story validated with beats", localOut.story.beats.length >= 3, true);

  // ---- GROK_CHAT provider shell (fake actuator; single invocation; onBeforeSubmit ordering) ----
  const calls = [];
  const chat = createGrokChatTextProvider({
    actuator: async ({ prompt: pr, onBeforeSubmit }) => {
      calls.push("invoke");
      await onBeforeSubmit();
      calls.push("submitted");
      return { text: "```json\n" + JSON.stringify(goodStory) + "\n```", responseId: "conv-abc123" };
    }
  });
  check("P4 GROK_CHAT available with actuator", chat.available(), true);
  let beforeSubmitSeen = 0;
  const chatOut = await chat.generateStory({ idea: "a lighthouse story", beatCount: 3 }, { onBeforeSubmit: async () => { beforeSubmitSeen += 1; } });
  check("P4 one invocation, submit fact before response", calls, ["invoke", "submitted"]);
  check("P4 caller onBeforeSubmit ran exactly once", beforeSubmitSeen, 1);
  check("P4 response correlated + validated", [chatOut.story.title, chatOut.providerResultRef], ["The Keeper", "conv-abc123"]);
  check("P4 unavailable without actuator", createGrokChatTextProvider({}).available(), false);

  // ---- subtitles ----
  const srt = buildSrt([{ durationSeconds: 4, narration: "First line." }, { durationSeconds: 6, narration: "Second line." }]);
  const cues = parseSrtCues(srt);
  check("S1 buildSrt/parseSrtCues roundtrip", [cues.length, cues[0].start, cues[1].end > cues[1].start], [2, 0, true]);
  await rejects("S1 invalid SRT rejected", async () => parseSrtCues("not a subtitle"), "E_SRT_INVALID");
  await rejects("S1 reversed timing rejected", async () => parseSrtCues("1\n00:00:05,000 --> 00:00:01,000\nbad\n"), "E_SRT_INVALID");

  // ---- zip builder: real zip, verified by PowerShell Expand-Archive (independent implementation) ----
  const zbuf = buildZipBuffer([
    { name: "caption.txt", data: Buffer.from("hello zip", "utf8") },
    { name: "nested/data.bin", data: Buffer.from([0, 1, 2, 250, 251, 252]) }
  ]);
  check("Z1 zip has local header signature", zbuf.readUInt32LE(0), 0x04034b50);
  check("Z1 crc32 known vector ('123456789')", crc32(Buffer.from("123456789", "ascii")).toString(16), "cbf43926");
  const zipPath = path.join(dir, "test.zip"); writeFileSync(zipPath, zbuf);
  const outDir = path.join(dir, "unzipped"); mkdirSync(outDir, { recursive: true });
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`], { windowsHide: true });
  check("Z1 Expand-Archive accepts the zip", ps.status, 0);
  check("Z1 extracted text matches", readFileSync(path.join(outDir, "caption.txt"), "utf8"), "hello zip");
  check("Z1 extracted binary matches", [...readFileSync(path.join(outDir, "nested", "data.bin"))], [0, 1, 2, 250, 251, 252]);
  await rejects("Z1 unsafe entry name rejected", async () => buildZipBuffer([{ name: "../evil", data: Buffer.from("x") }]), "E_PACKAGE_ENTRY_NAME");

  // ---- publishing package ----
  const finalPath = path.join(dir, "final.mp4"); writeFileSync(finalPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(500, 7)]));
  const srtPath = path.join(dir, "final.srt"); writeFileSync(srtPath, srt, "utf8");
  const pkg = await buildPublishingPackage({
    packageDir: path.join(dir, "package"), finalPath, srtPath, thumbnailPath: null,
    caption: "A short film about light.", title: "The Keeper",
    project: { id: "mov_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    scenes: [{ ordinal: 0, heading: "Dawn", state: "COMPLETED", generationJobId: "job_01ARZ3NDEKTSV4RRFFQ69G5FAW", generationAttemptId: "attempt_01ARZ3NDEKTSV4RRFFQ69G5FAX", resultId: "res1", durationSeconds: 4 }],
    render: { id: "rnd_x", version: 1, renderHash: "sha256:abc", finalMedia: { durationSeconds: 4, width: 720, height: 1280 } },
    now: () => new Date(0)
  });
  check("K1 package zip built", pkg.zipSizeBytes > 500 && existsSync(pkg.zipPath), true);
  check("K1 package files complete", pkg.files, ["final.mp4", "caption.txt", "metadata.json", "subtitles.srt"]);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package", "metadata.json"), "utf8"));
  check("K1 manifest carries redacted correlation", [manifest.projectId, manifest.scenes[0].generationJobId, manifest.render.version, manifest.video.sha256.length], ["mov_01ARZ3NDEKTSV4RRFFQ69G5FAV", "job_01ARZ3NDEKTSV4RRFFQ69G5FAW", 1, 64]);
  check("K1 manifest has no absolute paths", /[A-Za-z]:\\/.test(JSON.stringify(manifest)), false);
  await rejects("K1 missing video rejected", async () => buildPublishingPackage({ packageDir: path.join(dir, "p2"), finalPath: path.join(dir, "missing.mp4") }), "E_PACKAGE_NO_VIDEO");

  // ---- publisher providers ----
  const pkgPub = createPackagePublisherProvider({ buildPackage: async () => ({ packageRef: "movies/x/renders/v1/package/package.zip" }) });
  let submitFacts = 0;
  const pubOut = await pkgPub.publish({ projectId: "mov_x", onBeforeSubmit: async () => { submitFacts += 1; } });
  check("F1 PACKAGE publisher publishes with submit fact", [pubOut.postRef, submitFacts], ["movies/x/renders/v1/package/package.zip", 1]);
  const fbNone = createFacebookPublisherProvider({});
  check("F2 FB unavailable without actuator", fbNone.available(), false);
  await rejects("F2 FB publish refused without account", async () => fbNone.publish({ packageDir: "x", audience: "DRAFT" }), "E_PUBLISH_FB_UNAVAILABLE");
  const fbCalls = [];
  const fb = createFacebookPublisherProvider({ actuator: async ({ audience, onBeforeSubmit }) => { fbCalls.push(audience); await onBeforeSubmit?.(); return { postRef: "draft:abc123" }; } });
  check("F3 FB available with actuator", fb.available(), true);
  await rejects("F3 PUBLIC audience refused", async () => fb.publish({ packageDir: "x", audience: "PUBLIC" }), "E_PUBLISH_PUBLIC_FORBIDDEN");
  await rejects("F3 unknown audience refused", async () => fb.publish({ packageDir: "x", audience: "FRIENDS" }), "E_PUBLISH_AUDIENCE");
  const draftOut = await fb.publish({ packageDir: "x", audience: "DRAFT", caption: "hi" });
  check("F3 DRAFT publish returns redacted postRef", [draftOut.postRef, fbCalls], ["draft:abc123", ["DRAFT"]]);
  const fbUncertain = createFacebookPublisherProvider({ actuator: async () => ({}) });
  await rejects("F3 unverifiable outcome is UNCERTAIN (no retry)", async () => fbUncertain.publish({ packageDir: "x", audience: "ONLY_ME" }), "E_PUBLISH_UNCERTAIN");

  console.log(`Step 5C.11 content libs: ${passed} passed, 0 failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
