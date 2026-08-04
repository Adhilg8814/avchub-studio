#!/usr/bin/env node
// Demo data: enough to see the pipeline work, entirely invented.
//
// Nothing here touches a real service. The provider is the mock, the story is three sentences written for
// this file, and the only external program used is the FFmpeg you installed. Running it twice is safe.
//
//   npm run demo:seed
//
// It writes to AVC_STUDIO_HOME (default: a sibling directory named <repo>-data), never into the repository.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultStudioHome } from "../../lib/paths.mjs";
import { createProviderRegistry } from "../../lib/providers/provider-registry.mjs";
import { createMockProvider } from "../../lib/providers/mock-provider.mjs";
import { actuationPlanFor, classifyGeneratedAsset, sourceGateDecision } from "../../lib/media/asset-policy.mjs";
import { resolveFfmpeg } from "../../lib/media/ffmpeg-locator.mjs";

const HOME = defaultStudioHome();
const DEMO = path.join(HOME, "demo");

const PROJECT = Object.freeze({
  id: "demo_project_0001",
  title: "The Lighthouse Keeper's Last Night",
  aspectRatio: "9:16",
  resolution: "720p",
  scenes: [
    { id: "scene_1", seconds: 6, prompt: "A lighthouse at dusk, waves breaking against black rock, the lamp turning." },
    { id: "scene_2", seconds: 6, prompt: "Inside the lamp room, an old keeper winding the mechanism by hand." },
    { id: "scene_3", seconds: 10, prompt: "Dawn. The lamp goes dark. A boat is already at the jetty, waiting." }
  ]
});

function say(step, detail) { console.log(`  ${String(step).padEnd(22)} ${detail}`); }

async function main() {
  console.log("AVC Studio — demo seed\n");

  try {
    const { ffmpeg } = await resolveFfmpeg();
    say("ffmpeg", ffmpeg);
  } catch (e) {
    console.error(`\n  FFmpeg is required for the demo: ${e.message}\n`);
    process.exit(1);
  }

  await mkdir(DEMO, { recursive: true });
  say("data directory", DEMO);

  const registry = createProviderRegistry();
  registry.register(createMockProvider({ outputDir: path.join(DEMO, "clips") }));
  say("providers", registry.ids().join(", "));

  const results = [];
  for (const scene of PROJECT.scenes) {
    // Planning refuses an impossible ask before anything is submitted — that refusal is free, and a scene
    // discovered to be unrenderable at assembly time is not.
    const plan = actuationPlanFor({
      aspectRatio: PROJECT.aspectRatio,
      resolution: PROJECT.resolution,
      durationSeconds: scene.seconds
    });
    const provider = registry.resolveFor("MOCK", plan);

    const { submissionId } = await provider.submit({ prompt: scene.prompt, plan });
    const polled = await provider.poll(submissionId);
    if (polled.state !== "SUCCEEDED") { say(scene.id, `provider did not finish: ${polled.state}`); continue; }
    const { filePath } = await provider.fetch(submissionId);

    // The file is measured, not trusted. Real providers accept a request and return something smaller.
    const decoded = await probe(filePath);
    const classification = classifyGeneratedAsset({ requested: plan, decoded });
    const gate = sourceGateDecision({ classification });

    results.push({ scene: scene.id, filePath, verdict: classification.verdict, allowed: gate.allow });
    say(scene.id, `${plan.duration} ${plan.aspectRatio} -> ${decoded.width}x${decoded.height} ${decoded.durationSeconds}s — ${classification.verdict}${gate.allow ? "" : " (REJECTED)"}`);
  }

  const manifest = { project: PROJECT, generatedWith: "MOCK", scenes: results };
  const manifestPath = path.join(DEMO, "demo-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`\n  ${results.filter((r) => r.allowed).length}/${PROJECT.scenes.length} scenes accepted`);
  console.log(`  manifest: ${manifestPath}`);
  console.log("\nNext: npm run control-plane:dev\n");
  await registry.dispose();
}

// ffprobe, read directly rather than through the movie pipeline so the demo has no database dependency.
async function probe(filePath) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { ffprobe } = await resolveFfmpeg();
  const { stdout } = await promisify(execFile)(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", filePath
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] || {};
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    durationSeconds: Number(parsed.format?.duration)
  };
}

main().catch((e) => { console.error(`\n  demo seed failed: ${e.message}\n`); process.exit(1); });
