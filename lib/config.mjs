// Single source of truth for config loading, defaults, preset resolution and
// validation. Previously defaults lived in four places (script fallbacks, the
// config files, WPF ApplyDefaults, WPF LoadConfig) and generate-stories even
// defaulted to a DIFFERENT config file (config.example.json) than every other
// script (config.ui.json).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { resolveFromRoot, fromRoot } from "./paths.mjs";
import { stripBom } from "./text.mjs";
import { numberOption } from "./cli.mjs";

export const CONFIG_CANDIDATES = ["config.json", "config.ui.json"];

export const DEFAULTS = {
  provider: "openai",
  outputDir: "output",
  language: "English",
  storiesPerSeed: 1,
  minWords: 1900,
  maxWords: 2600,
  temperature: 0.9,
  maxOutputTokens: 12000,
  retries: 3,
  requestTimeoutMs: 180000,
  sectionedGeneration: true,
  sectionRetries: 2,
  expandAttempts: 3,
  concurrency: 2,
  seedGeneration: {
    count: 10,
    batchSize: 10,
    maxOutputTokens: 6000,
    temperature: 0.4,
    outputFile: "generated-seeds.json",
    theme:
      "Family secrets, marriage conflict, betrayal, inheritance, hidden documents, security cameras, hospitals, banks, and old promises.",
    avoid:
      "Do not use supernatural plots, graphic violence, explicit sex, real public figures, or copied article premises."
  },
  publishing: {
    siteDir: "site",
    siteTitle: "Untold Stories",
    siteBaseUrl: "",
    facebookCta: "Read the full story here:",
    facebookHashtags: ""
  }
};

// Load a config file. Explicit path (from --config) must exist — a typo'd
// path used to silently fall back to {} in one script and crash with a raw
// ENOENT in another. Without --config, try config.json then config.ui.json.
export async function loadConfig(argPath) {
  const tried = [];

  if (argPath && argPath !== true) {
    const direct = path.resolve(String(argPath));
    const rooted = resolveFromRoot(String(argPath));
    const found = existsSync(direct) ? direct : existsSync(rooted) ? rooted : null;
    if (!found) {
      throw new Error(`Config file not found: ${argPath} (looked at ${direct}${direct === rooted ? "" : ` and ${rooted}`})`);
    }
    return { config: await readJson(found), configPath: found };
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const candidatePath = resolveFromRoot(candidate);
    tried.push(candidatePath);
    if (existsSync(candidatePath)) {
      return { config: await readJson(candidatePath), configPath: candidatePath };
    }
  }

  throw new Error(`No config file found. Tried: ${tried.join(", ")}. Pass --config <file> or create config.json.`);
}

export async function readJson(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`File not found: ${filePath}`);
    throw error;
  }
  try {
    return JSON.parse(stripBom(raw));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

// Resolve countryPreset/genrePreset ids against presets.content.json at
// runtime. Explicit config values always win; presets only fill gaps. This
// makes presets.content.json the single source of truth instead of a snapshot
// the WPF denormalizes into config.ui.json.
export async function applyPresets(config) {
  // The example file is the fallback, not a second source of truth: an installation that has written its own
  // presets.content.json keeps using it, and a fresh clone still resolves presets instead of silently
  // returning the config unchanged — which looks identical to "this preset does not exist".
  const presetsPath = [fromRoot("presets.content.json"), fromRoot("presets.content.example.json")]
    .find((p) => existsSync(p));
  if (!presetsPath) return config;

  let presets;
  try {
    presets = await readJson(presetsPath);
  } catch (error) {
    console.warn(`WARNING: could not read presets.content.json (${error.message}); continuing without presets.`);
    return config;
  }

  const merged = { ...config };
  const country = (presets.countries || []).find((entry) => entry.id === config.countryPreset);
  if (country) {
    merged.countryName = config.countryName || country.labelEn || country.id;
    merged.language = config.language || country.language;
    merged.publishing = {
      siteTitle: country.siteTitle,
      facebookCta: country.facebookCta,
      facebookHashtags: country.facebookHashtags,
      ...(config.publishing || {})
    };
    if (!merged.facebookPageUrl && Array.isArray(country.facebookPages) && country.facebookPages.length) {
      merged.facebookPageUrl = country.facebookPages[0];
    }
  }

  const genre = (presets.genres || []).find((entry) => entry.id === config.genrePreset);
  if (genre) {
    merged.genreName = config.genreName || genre.labelEn || genre.id;
    merged.globalStyle = config.globalStyle || genre.globalStyle;
    if (config.minWords === undefined) merged.minWords = genre.minWords;
    if (config.maxWords === undefined) merged.maxWords = genre.maxWords;
    merged.seedGeneration = {
      theme: genre.theme,
      avoid: genre.avoid,
      ...(config.seedGeneration || {})
    };
  }

  return merged;
}

// Normalize the story-generation settings with one canonical default set.
// numberOption treats 0 as a valid value (the old `Number(x || d)` didn't).
export function normalizeStorySettings(config, args) {
  const settings = {
    outputDir: resolveFromRoot(config.outputDir ?? DEFAULTS.outputDir),
    language: config.language || DEFAULTS.language,
    storiesPerSeed: numberOption(config.storiesPerSeed, DEFAULTS.storiesPerSeed),
    minWords: numberOption(config.minWords, DEFAULTS.minWords),
    maxWords: numberOption(config.maxWords, DEFAULTS.maxWords),
    temperature: numberOption(config.temperature, DEFAULTS.temperature),
    maxOutputTokens: numberOption(config.maxOutputTokens, DEFAULTS.maxOutputTokens),
    retries: numberOption(args.retries ?? config.retries, DEFAULTS.retries),
    requestTimeoutMs: numberOption(args.timeout ?? config.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    sectionedGeneration: config.sectionedGeneration ?? DEFAULTS.sectionedGeneration,
    sectionRetries: numberOption(config.sectionRetries, DEFAULTS.sectionRetries),
    expandAttempts: numberOption(config.expandAttempts, DEFAULTS.expandAttempts),
    concurrency: Math.max(1, Math.min(8, numberOption(args.concurrency ?? config.concurrency, DEFAULTS.concurrency)))
  };
  return settings;
}

export function validateStorySettings(settings) {
  const errors = [];
  const warnings = [];

  if (settings.minWords > settings.maxWords) {
    errors.push(`minWords (${settings.minWords}) is greater than maxWords (${settings.maxWords}).`);
  }
  if (settings.temperature < 0 || settings.temperature > 2) {
    errors.push(`temperature (${settings.temperature}) must be between 0 and 2.`);
  }
  if (settings.storiesPerSeed < 1 || settings.storiesPerSeed > 20) {
    warnings.push(`storiesPerSeed (${settings.storiesPerSeed}) looks unusual.`);
  }
  return { errors, warnings };
}
