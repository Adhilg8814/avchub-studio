// One LLM client for the whole pipeline. Replaces two copy-pasted 70-line
// request loops (OpenAI / Anthropic) that differed only in body/headers, and
// fixes the failure modes that silently degraded stories:
// - truncated responses are now DETECTED (stop_reason / incomplete status)
//   and reported to the caller instead of accepted as complete text;
// - 429 handling honors Retry-After and adds jitter;
// - the hidden example-provider 3000-token cap is surfaced with a loud warning;
// - OpenAI keys are no longer run through Claude-specific normalization.

import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";

import { resolveFromRoot } from "./paths.mjs";

const DEFAULT_SYSTEM_TEXT =
  "You write original long-form fictional stories. Follow the requested language, length, and structure exactly.";

export function normalizeProvider(provider) {
  const normalized = String(provider || "openai").trim().toLowerCase();
  if (["openai", "gpt", "chatgpt"].includes(normalized)) return "openai";
  if (["anthropic", "claude", "llm-proxy"].includes(normalized)) return "anthropic";
  throw new Error(`Unsupported AI provider: ${provider}. Use "openai" or "anthropic".`);
}

export function defaultModelForProvider(provider) {
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_MODEL
      || process.env.CLAUDE_MODEL
      || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      || "claude-sonnet-5";
  }
  return process.env.OPENAI_MODEL || "gpt-4.1-mini";
}

// ---------------------------------------------------------------- credentials

async function readKeyFile(filePath, normalize) {
  try {
    const raw = await readFile(resolveFromRoot(filePath), "utf8");
    return normalize(raw);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function normalizeOpenAiCredential(rawValue) {
  return String(rawValue || "").trim();
}

// llm-proxy installers sometimes hand out URLs with ?key=..., bare tokens, or
// hex strings — normalize those shapes for the Anthropic-compatible path only.
export function normalizeClaudeCredential(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";

  const keyMatch = raw.match(/[?&]key=([^"'\s&]+)/i);
  if (keyMatch) return keyMatch[1].trim();

  const bareMatch = raw.match(/\bsk-[A-Za-z0-9_-]{20,}\b/);
  if (bareMatch) return bareMatch[0].trim();

  if (/^[A-Fa-f0-9]{40,}$/.test(raw)) return `sk-${raw}`;

  return raw;
}

export async function ensureApiKey(provider, config, args) {
  if (provider === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return;

    const apiKeyFile = args["anthropic-api-key-file"]
      || args["claude-api-key-file"]
      || args["api-key-file"]
      || config.anthropicApiKeyFile
      || config.claudeApiKeyFile
      || "claude_api.txt";
    const authTokenFile = args["anthropic-auth-token-file"]
      || args["claude-auth-token-file"]
      || config.anthropicAuthTokenFile
      || config.claudeAuthTokenFile
      || "";

    const baseUrl = args["anthropic-base-url"]
      || config.anthropicBaseUrl
      || config.claudeBaseUrl
      || process.env.ANTHROPIC_BASE_URL
      || "";
    const usesProxy = Boolean(baseUrl) && !isDefaultAnthropicBaseUrl(baseUrl);

    // Only treat the token file as a Bearer token when a proxy base URL is in
    // play. The old logic set ANTHROPIC_AUTH_TOKEN whenever claude_api.txt
    // was non-empty, which forced `Authorization: Bearer` and broke real
    // api.anthropic.com keys (it requires x-api-key).
    if (usesProxy && authTokenFile) {
      const authToken = await readKeyFile(authTokenFile, normalizeClaudeCredential);
      if (authToken) {
        process.env.ANTHROPIC_AUTH_TOKEN = authToken;
        return;
      }
    }

    const apiKey = await readKeyFile(apiKeyFile, normalizeClaudeCredential);
    if (apiKey) {
      if (usesProxy) {
        process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
      } else {
        process.env.ANTHROPIC_API_KEY = apiKey;
      }
    }
    return;
  }

  if (process.env.OPENAI_API_KEY) return;

  const apiKeyFile = args["openai-api-key-file"]
    || args["api-key-file"]
    || config.openaiApiKeyFile
    || config.apiKeyFile
    || "api.txt";
  const apiKey = await readKeyFile(apiKeyFile, normalizeOpenAiCredential);
  if (apiKey) process.env.OPENAI_API_KEY = apiKey;
}

// ------------------------------------------------------------------ base URLs

export function normalizeAnthropicBaseUrl(baseUrl) {
  return String(baseUrl || "https://api.anthropic.com").trim().replace(/\/+$/, "");
}

function anthropicMessagesUrl(baseUrl) {
  const normalized = normalizeAnthropicBaseUrl(baseUrl);
  if (normalized.endsWith("/v1/messages")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

export function isDefaultAnthropicBaseUrl(baseUrl) {
  return normalizeAnthropicBaseUrl(baseUrl).toLowerCase() === "https://api.anthropic.com";
}

// The hard output cap of the endpoint in use. Infinity = no known cap.
//
// Some Anthropic-compatible proxies silently truncate above a limit the API itself does not have, which looks
// like the model stopping mid-sentence rather than like an error. There is no way to detect that from the
// response, so the operator declares it: LLM_MAX_OUTPUT_TOKENS applies to any non-default Anthropic base URL.
// The official endpoint is never capped — a wrong guess there would shorten every generation for no reason.
export function providerMaxTokensCap({ provider, anthropicBaseUrl, env = process.env }) {
  if (provider !== "anthropic") return Infinity;
  if (isDefaultAnthropicBaseUrl(anthropicBaseUrl)) return Infinity;
  const declared = Number(env.LLM_MAX_OUTPUT_TOKENS);
  return Number.isFinite(declared) && declared > 0 ? declared : Infinity;
}

// ---------------------------------------------------------------- retry logic

function isRetriable(error) {
  if (error.retryable) return true;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (!error.status) return false;
  return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
}

// Proxies occasionally return 200 with empty content — worth another attempt.
function emptyOutputError(providerLabel) {
  const error = new Error(`${providerLabel} response did not contain output text.`);
  error.retryable = true;
  return error;
}

function retryAfterMsFromResponse(response) {
  const header = response?.headers?.get?.("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 120000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 120000);
  return 0;
}

async function withRetry(label, retries, performRequest) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await performRequest();
    } catch (error) {
      if (attempt > retries || !isRetriable(error)) throw error;
      const backoff = Math.min(30000, 1500 * 2 ** (attempt - 1));
      const jitter = 0.8 + Math.random() * 0.4;
      const delayMs = Math.max(Math.round(backoff * jitter), error.retryAfterMs || 0);
      console.warn(`${label} request failed, retrying in ${delayMs}ms (${attempt}/${retries}): ${error.message}`);
      await sleep(delayMs);
    }
  }
}

// ------------------------------------------------------------------- generate

// Returns { text, truncated }. `truncated` is true when the provider stopped
// on its output-token limit — callers must handle it (continue/trim), never
// treat the text as a complete story.
// options.logLabel (e.g. the story basename) prefixes retry warnings so that
// parallel jobs produce attributable log lines.
export async function generateText(options) {
  if (options.provider === "anthropic") return generateWithAnthropic(options);
  return generateWithOpenAI(options);
}

function retryLabel(provider, logLabel) {
  return logLabel ? `[${logLabel}] ${provider}` : provider;
}

async function generateWithOpenAI({
  prompt,
  model,
  temperature,
  maxOutputTokens,
  retries,
  requestTimeoutMs,
  jsonMode = false,
  logLabel = "",
  systemText = DEFAULT_SYSTEM_TEXT
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Put the key in api.txt, set OPENAI_API_KEY, or use --dry-run.");
  }

  return withRetry(retryLabel("OpenAI", logLabel), retries, async () => {
    const body = {
      model,
      temperature,
      max_output_tokens: maxOutputTokens,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemText }] },
        { role: "user", content: [{ type: "input_text", text: prompt }] }
      ]
    };
    if (jsonMode) {
      body.text = { format: { type: "json_object" } };
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data?.error?.message || response.statusText;
      const error = new Error(`OpenAI request failed (${response.status}): ${detail}`);
      error.status = response.status;
      error.retryAfterMs = retryAfterMsFromResponse(response);
      throw error;
    }

    const text = extractOpenAiOutputText(data);
    if (!text) throw emptyOutputError("OpenAI");
    const truncated = data?.status === "incomplete"
      && data?.incomplete_details?.reason === "max_output_tokens";
    return { text, truncated };
  });
}

const warnedCaps = new Set();

async function generateWithAnthropic({
  prompt,
  model,
  temperature,
  maxOutputTokens,
  retries,
  requestTimeoutMs,
  anthropicBaseUrl = "https://api.anthropic.com",
  logLabel = "",
  systemText = DEFAULT_SYSTEM_TEXT
}) {
  const apiKey = normalizeClaudeCredential(process.env.ANTHROPIC_API_KEY);
  const authToken = normalizeClaudeCredential(process.env.ANTHROPIC_AUTH_TOKEN);
  if (!apiKey && !authToken) {
    throw new Error(
      "Missing Claude credentials. Put the key/token in claude_api.txt, set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, or use --dry-run."
    );
  }

  const baseUrl = normalizeAnthropicBaseUrl(anthropicBaseUrl);
  const messagesUrl = anthropicMessagesUrl(baseUrl);
  const headers = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  };
  if (authToken || !isDefaultAnthropicBaseUrl(baseUrl)) {
    headers.Authorization = `Bearer ${authToken || apiKey}`;
  } else {
    headers["x-api-key"] = apiKey;
  }

  const cap = providerMaxTokensCap({ provider: "anthropic", model, anthropicBaseUrl: baseUrl });
  const effectiveMaxTokens = Math.min(Number(maxOutputTokens || 4096), cap);
  if (effectiveMaxTokens < Number(maxOutputTokens || 4096)) {
    const capKey = `${model}|${baseUrl}`;
    if (!warnedCaps.has(capKey)) {
      warnedCaps.add(capKey);
      console.warn(
        `WARNING: ${model} via ${baseUrl} caps output at ${cap} tokens per request `
        + `(you asked for ${maxOutputTokens}). Long stories are generated in sections to work within this limit.`
      );
    }
  }

  return withRetry(retryLabel("Anthropic", logLabel), retries, async () => {
    const response = await fetch(messagesUrl, {
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers,
      body: JSON.stringify({
        model,
        max_tokens: effectiveMaxTokens,
        temperature,
        system: systemText,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data?.error?.message || response.statusText || "(empty response)";
      const authHint = response.status === 401 && !isDefaultAnthropicBaseUrl(baseUrl)
        ? ` The proxy at ${baseUrl} rejected the token. Refresh the token in claude_api.txt.`
        : "";
      const error = new Error(`Anthropic request failed (${response.status}): ${detail}.${authHint}`);
      error.status = response.status;
      error.retryAfterMs = retryAfterMsFromResponse(response);
      throw error;
    }

    const text = extractAnthropicOutputText(data);
    if (!text) throw emptyOutputError("Anthropic");
    return { text, truncated: data?.stop_reason === "max_tokens" };
  });
}

// ------------------------------------------------------------------ extractors

function extractOpenAiOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;

  const chunks = [];
  for (const item of data?.output || []) {
    if (item?.type && item.type !== "message") continue; // skip reasoning items
    for (const content of item?.content || []) {
      if (content?.type && content.type !== "output_text" && content.type !== "text") continue;
      if (typeof content.text === "string") chunks.push(content.text);
      else if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function extractAnthropicOutputText(data) {
  const chunks = [];
  for (const content of data?.content || []) {
    if (content?.type && content.type !== "text") continue;
    if (typeof content.text === "string") chunks.push(content.text);
  }
  return chunks.join("\n").trim();
}
