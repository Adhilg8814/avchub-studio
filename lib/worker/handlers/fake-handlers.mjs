// AVC Studio P0 Step 4A — deterministic FAKE job handlers (PURE).
//
// PURE MODULE. Proves the Worker Runtime pipeline end-to-end WITHOUT any real
// provider. These handlers do NOT: launch a browser, launch Python, touch Grok /
// ChatGPT / ElevenLabs / CapCut, open a network socket, or read/write the
// filesystem. They only simulate: progress (0→25→50→75→100), an optional delay,
// a terminal result, and DETERMINISTIC fake metadata derived from the input.
//
// The only imports are the pure protocol/handler layer + generateId (crypto).
// Explicitly NOT imported: lib/grok-video.mjs, any provider-session code, any *.py.

import { generateId } from "../../protocol/ids.mjs";
import { PROTOCOL_ERRORS, protocolError } from "../../protocol/errors.mjs";
import { defineHandler } from "./job-handler.mjs";

// ---- deterministic hashing (no randomness → stable fake metadata) ----
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function hashHex(str, len = 32) {
  let out = "";
  let seed = str;
  while (out.length < len) { out += fnv1a32(seed).toString(16).padStart(8, "0"); seed = `${out}:${str}`; }
  return out.slice(0, len);
}
// Last 10 chars of a prefixed ULID → filename-safe, deterministic path segment.
function short(id) { const b = String(id ?? "").split("_")[1] ?? "unknown"; return b.slice(-10).toLowerCase(); }

// ---- deterministic fake metadata (pure functions of input) ----
export function fakeVideoMetadata(input = {}) {
  const key = `${input.promptSnapshot ?? ""}|${input.shotId ?? ""}|${input.requestedDurationSec ?? 10}`;
  return {
    checksum: `sha256:${hashHex(key, 32)}`,
    sizeBytes: 1_000_000 + (fnv1a32(`v:${key}`) % 4_000_000),
    durationSec: input.requestedDurationSec ?? 10,
    width: 1080, height: 1920, mimeType: "video/mp4",
    relativePath: `episodes/${short(input.episodeId)}/videos/${short(input.shotId)}_fake.mp4`
  };
}
export function fakeImageMetadata(input = {}) {
  const key = `${input.promptSnapshot ?? ""}|${input.shotId ?? ""}`;
  return {
    checksum: `sha256:${hashHex(key, 32)}`,
    sizeBytes: 200_000 + (fnv1a32(`i:${key}`) % 1_500_000),
    width: 1024, height: 1024, mimeType: "image/png",
    relativePath: `episodes/${short(input.episodeId)}/images/${short(input.shotId)}_fake.png`
  };
}
export function fakeExportMetadata(input = {}) {
  const key = `${input.projectId ?? ""}|${(input.locales ?? []).join(",")}`;
  return {
    checksum: `sha256:${hashHex(key, 32)}`,
    sizeBytes: 5_000_000 + (fnv1a32(`x:${key}`) % 20_000_000),
    mimeType: "application/zip",
    relativePath: `exports/${short(input.projectId)}/package_fake.zip`,
    locales: input.locales ?? ["en-US"]
  };
}

// ---- step runner (cooperative-cancel + injectable pause + forced failure) ----
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Emit one progress step. Returns "aborted" if the job was canceled, else "ok".
// Throws if options.failAtStep === i (drives the execute-throw error path in tests).
async function step(ctx, i, ev, options) {
  if (ctx.signal?.aborted) return "aborted";
  if (typeof options.onStep === "function") await options.onStep(i, ctx); // test injection point
  if (ctx.signal?.aborted) return "aborted";
  if (options.failAtStep === i) {
    throw options.failError ?? new Error(`fake handler forced failure at step ${i}`);
  }
  ctx.onProgress({ phase: ev.phase, percent: ev.percent, label: ev.label ?? ev.phase });
  if (options.stepDelayMs > 0) await sleep(options.stepDelayMs, ctx.signal);
  else await Promise.resolve(); // yield so the progress event flushes in order
  return "ok";
}

function maybeRejectValidation(options, action) {
  return () => {
    if (options.rejectValidation) {
      throw protocolError(PROTOCOL_ERRORS.E_INVALID_JOB_INPUT,
        typeof options.rejectValidation === "string" ? options.rejectValidation : "fake handler rejected input", { action });
    }
  };
}

const GEN_STEPS = [
  { phase: "VALIDATING", percent: 0 },
  { phase: "SUBMITTING_PROMPT", percent: 25 },
  { phase: "WAITING_FOR_RESULT", percent: 50 },
  { phase: "DOWNLOADING", percent: 75 },
  { phase: "IMPORTING", percent: 100 }
];

// GENERATE_GROK_VIDEO — simulates a paid provider submission + import.
export function makeFakeGrokVideoHandler(options = {}) {
  return defineHandler({
    action: "GENERATE_GROK_VIDEO",
    capability: "grok.video",
    validate: maybeRejectValidation(options, "GENERATE_GROK_VIDEO"),
    recover: (record) => ({ action: "GENERATE_GROK_VIDEO", submitted: record?.submittedToProvider === true, canReuseExistingResult: Boolean(record?.localResultRef) }),
    async execute(input, ctx) {
      if (await step(ctx, 0, GEN_STEPS[0], options) === "aborted") return { aborted: true };
      const providerSubmissionId = generateId("submission");
      ctx.markSubmittedToProvider(providerSubmissionId); // simulate paid submission (persisted)
      if (await step(ctx, 1, GEN_STEPS[1], options) === "aborted") return { aborted: true };
      if (await step(ctx, 2, GEN_STEPS[2], options) === "aborted") return { aborted: true };
      if (await step(ctx, 3, GEN_STEPS[3], options) === "aborted") return { aborted: true };
      const meta = fakeVideoMetadata(input);
      const assetId = generateId("asset");
      ctx.markLocalResult(meta.relativePath, assetId, meta);
      if (await step(ctx, 4, GEN_STEPS[4], options) === "aborted") return { aborted: true };
      return { result: {
        asset: { assetId, kind: "video", provider: "FAKE", reviewStatus: "PENDING", selected: false, approved: false, ...meta },
        duration: { requestedDurationSec: meta.durationSec, confirmedUiDurationSec: meta.durationSec, actualDurationSec: meta.durationSec, durationMismatch: false },
        providerSubmissionId
      } };
    }
  });
}

// GENERATE_CHATGPT_IMAGE — simulates a paid image generation + import.
export function makeFakeChatgptImageHandler(options = {}) {
  return defineHandler({
    action: "GENERATE_CHATGPT_IMAGE",
    capability: "chatgpt.image",
    validate: maybeRejectValidation(options, "GENERATE_CHATGPT_IMAGE"),
    recover: (record) => ({ action: "GENERATE_CHATGPT_IMAGE", submitted: record?.submittedToProvider === true, canReuseExistingResult: Boolean(record?.localResultRef) }),
    async execute(input, ctx) {
      if (await step(ctx, 0, GEN_STEPS[0], options) === "aborted") return { aborted: true };
      const providerSubmissionId = generateId("submission");
      ctx.markSubmittedToProvider(providerSubmissionId);
      if (await step(ctx, 1, GEN_STEPS[1], options) === "aborted") return { aborted: true };
      if (await step(ctx, 2, GEN_STEPS[2], options) === "aborted") return { aborted: true };
      if (await step(ctx, 3, GEN_STEPS[3], options) === "aborted") return { aborted: true };
      const meta = fakeImageMetadata(input);
      const assetId = generateId("asset");
      ctx.markLocalResult(meta.relativePath, assetId, meta);
      if (await step(ctx, 4, GEN_STEPS[4], options) === "aborted") return { aborted: true };
      return { result: {
        asset: { assetId, kind: "image", provider: "FAKE", reviewStatus: "PENDING", selected: false, approved: false, ...meta },
        providerSubmissionId
      } };
    }
  });
}

const EXPORT_STEPS = [
  { phase: "VALIDATING", percent: 0 },
  { phase: "COLLECTING", percent: 25 },
  { phase: "RENDERING", percent: 50 },
  { phase: "PACKAGING", percent: 75 },
  { phase: "FINALIZING", percent: 100 }
];

// EXPORT_PROJECT — NO quota, NO provider submission. Produces a package descriptor.
export function makeFakeExportHandler(options = {}) {
  return defineHandler({
    action: "EXPORT_PROJECT",
    capability: "export.capcut",
    validate: maybeRejectValidation(options, "EXPORT_PROJECT"),
    recover: () => ({ action: "EXPORT_PROJECT", submitted: false, canReuseExistingResult: false }),
    async execute(input, ctx) {
      for (let i = 0; i < EXPORT_STEPS.length; i += 1) {
        if (await step(ctx, i, EXPORT_STEPS[i], options) === "aborted") return { aborted: true };
      }
      const meta = fakeExportMetadata(input);
      return { result: { package: meta } };
    }
  });
}

// Convenience: build the default fake-handler set and register them.
export function fakeHandlerSet(options = {}) {
  return {
    GENERATE_GROK_VIDEO: makeFakeGrokVideoHandler(options.grokVideo),
    GENERATE_CHATGPT_IMAGE: makeFakeChatgptImageHandler(options.chatgptImage),
    EXPORT_PROJECT: makeFakeExportHandler(options.exportProject)
  };
}

export function registerFakeHandlers(registry, options = {}) {
  const set = fakeHandlerSet(options);
  for (const [action, handler] of Object.entries(set)) {
    registry.register(action, handler, { replace: options.replace === true });
  }
  return registry;
}
