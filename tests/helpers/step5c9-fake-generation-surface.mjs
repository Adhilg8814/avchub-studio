// P0 Step 5C.9C2 — provider-free fake read-only generation surface.
//
// Sanitized, GENERIC semantic structure only. It is NOT copied from live Grok:
// it represents the contract (roles + accessible names + enabled state) so the
// read-only inspector can be exercised without any browser, provider, or DOM.
// It exposes ONLY read methods — there is no way to type, click, or submit.

function toRegExp(namePattern) {
  try { return new RegExp(namePattern, "iu"); } catch { return /$^/u; }
}

export function createFakeGenerationSurface({ url = "https://grok.example/generate", nodes = [] } = {}) {
  const calls = [];
  function matches(role, namePattern) {
    const re = toRegExp(namePattern);
    return nodes.filter((n) => n.role === role && typeof n.name === "string" && re.test(n.name));
  }
  return Object.freeze({
    calls,
    url() { calls.push({ method: "url" }); return url; },
    async countByRole(role, namePattern) {
      calls.push({ method: "countByRole", role });
      return matches(role, namePattern).length;
    },
    async stateByRole(role, namePattern) {
      calls.push({ method: "stateByRole", role });
      const found = matches(role, namePattern);
      if (found.length === 0) return "ABSENT";
      return found[0].enabled === false ? "DISABLED" : "ENABLED";
    },
    async optionNamesByRole(role, namePattern) {
      calls.push({ method: "optionNamesByRole", role });
      return matches(role, namePattern).map((n) => n.name);
    }
  });
}

// A generic, sanitized signal map for tests. These are authored semantic patterns
// for the CONTRACT, not observed live Grok facts.
export const SAMPLE_SIGNAL_MAP = Object.freeze({
  promptInput: { role: "textbox", namePattern: "prompt" },
  videoModeControl: { role: "tab", namePattern: "video" },
  submitControl: { role: "button", namePattern: "generate|create" },
  durationOptions: { role: "radio", namePattern: "second" },
  aspectOptions: { role: "radio", namePattern: ":" },
  progressIndicator: { role: "progressbar", namePattern: "generat" },
  completedResult: { role: "region", namePattern: "result" },
  outputMedia: { role: "button", namePattern: "download|save" },
  challenge: { role: "heading", namePattern: "verify|challenge|captcha" },
  rateLimit: { role: "alert", namePattern: "rate limit|too many|quota" },
  providerError: { role: "alert", namePattern: "error|failed|wrong" }
});

export function readyVideoSurfaceNodes({ submitEnabled = false, extra = [] } = {}) {
  return [
    { role: "textbox", name: "Prompt", enabled: true },
    { role: "tab", name: "Video", enabled: true },
    { role: "button", name: "Generate", enabled: submitEnabled },
    { role: "radio", name: "6 seconds" },
    { role: "radio", name: "10 seconds" },
    { role: "radio", name: "15 seconds" },
    { role: "radio", name: "16:9" },
    { role: "radio", name: "9:16" },
    ...extra
  ];
}
