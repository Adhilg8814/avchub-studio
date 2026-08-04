// Robust extraction of a JSON seed array from LLM output.
//
// The real-world failure this must survive (see the recovered fixture from
// output/seed-generation-raw-error.txt): the model opened a quotation with a
// Bulgarian low quote „ (U+201E) but closed it with a bare ASCII " inside a
// JSON string, terminating the string early. The old parser had no repair for
// that and a single bad batch aborted the whole run.

import { stripBom } from "./text.mjs";

export function extractSeedArray(text) {
  const raw = stripBom(String(text ?? "")).trim();

  // Prefer fenced content anywhere in the reply ("Here is the JSON:\n```json").
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const base = (fence ? fence[1] : raw)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  const sliced = sliceJsonPayload(base);
  const candidates = [base];
  if (sliced && sliced !== base) candidates.push(sliced);
  candidates.push(repairUnescapedQuotes(sliced || base));
  // Legacy repair for over-escaped quotes (\" where " was meant).
  candidates.push(
    (sliced || base)
      .replace(/(:\s*)\\+"/g, '$1"')
      .replace(/\\+"\s*([,}\]])/g, '"$1')
  );

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.seeds)) return parsed.seeds;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Could not parse generated seeds as JSON.");
}

// Slice from the first opening bracket to the last matching closing bracket,
// preferring whichever payload starts first (array vs object-with-seeds).
function sliceJsonPayload(text) {
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");

  const hasArray = arrayStart !== -1 && arrayEnd > arrayStart;
  const hasObject = objectStart !== -1 && objectEnd > objectStart;
  if (hasArray && (!hasObject || arrayStart < objectStart)) {
    return text.slice(arrayStart, arrayEnd + 1);
  }
  if (hasObject) {
    return text.slice(objectStart, objectEnd + 1);
  }
  return "";
}

// Escape stray double quotes inside JSON strings. Heuristic: inside a string,
// a '"' only legitimately closes the string when the next non-whitespace
// character is one of , : } ] or end-of-input. Anything else (e.g. a letter,
// as in `„помага" на баба`) is an unescaped interior quote.
export function repairUnescapedQuotes(text) {
  const source = String(text);
  let out = "";
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }

    if (char === "\\") {
      out += char;
      index += 1;
      if (index < source.length) out += source[index];
      continue;
    }

    if (char === '"') {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1;
      const next = source[lookahead];
      if (next === undefined || next === "," || next === ":" || next === "}" || next === "]") {
        inString = false;
        out += char;
      } else {
        out += '\\"';
      }
      continue;
    }

    out += char;
  }

  return out;
}
