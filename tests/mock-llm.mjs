// Fetch stub for offline integration tests. Activate with:
//   node --import ./tests/mock-llm.mjs generate-stories.mjs ...
// Scenario picked via env MOCK_SCENARIO: happy | seed-retry | fail-one | fail-all
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scenario = process.env.MOCK_SCENARIO || "happy";
const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

let seedCalls = 0;

function sectionText(words = 200) {
  return Array.from({ length: words }, (_, i) => `дума${i}`).join(" ");
}

function openAiPayload(text) {
  return {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }]
  };
}

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body || "{}");
  const isSeedCall = Boolean(body.text?.format) || JSON.stringify(body).includes("story seeds");

  if (isSeedCall) {
    seedCalls += 1;
    if (scenario === "seed-retry" && seedCalls === 1) {
      // First batch: the real malformed production response.
      const broken = readFileSync(path.join(fixturesDir, "fixtures", "broken-seed-response-unfixable.txt"), "utf8");
      return new Response(JSON.stringify(openAiPayload(broken)), { status: 200 });
    }
    const seeds = {
      seeds: [
        {
          slug: "mock-seed-one",
          openingQuote: "Защо скри това от мен?",
          premise: "Una premise dostatochno dylga za test edno.",
          twist: "Twist edno.",
          forbidden: "None."
        },
        {
          slug: "mock-seed-two",
          openingQuote: "Чия е тази снимка?",
          premise: "Una premise dostatochno dylga za test dve.",
          twist: "Twist dve.",
          forbidden: "None."
        }
      ]
    };
    return new Response(JSON.stringify(openAiPayload(JSON.stringify(seeds))), { status: 200 });
  }

  // The rendered story prompt contains the seed premise (not the slug), so
  // match the failing seed by its distinctive premise text.
  const promptText = JSON.stringify(body);
  if ((scenario === "fail-one" && promptText.includes("istoriya dve")) || scenario === "fail-all") {
    return new Response(JSON.stringify({ error: { message: "mock server error" } }), { status: 500 });
  }

  return new Response(JSON.stringify(openAiPayload(sectionText())), { status: 200 });
};
