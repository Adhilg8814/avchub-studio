// Canonical title/excerpt/metadata helpers. These were previously duplicated
// with drifting constants (title 120 vs 140, excerpt 210 vs 320), which made
// the "same" story carry different titles across artifacts.

export const TITLE_MAX = 120;
export const EXCERPT_MAX = 210;

const QUOTE_CHARS = /[“”„‟«»‹›"]/g; // “ ” „ ‟ « » ‹ › "

export function stripBom(text) {
  return String(text).replace(/^﻿/, "");
}

export function stripMetadata(markdown) {
  return stripBom(String(markdown)).replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}

// Parse the `<!-- key: value -->` header block generate-stories writes.
export function parseMetadata(markdown) {
  const match = stripBom(String(markdown)).match(/^\s*<!--([\s\S]*?)-->/);
  const metadata = {};
  if (!match) return metadata;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^\s*([A-Za-z][\w-]*):\s*(.*)$/);
    if (pair) metadata[pair[1]] = pair[2].trim();
  }
  return metadata;
}

// First sentence of the body. Handles terminal punctuation followed by a
// closing quote (`?“`), which the old splitter missed — that bug malformed
// every Bulgarian title. Falls back to the whole first line.
export function makeTitle(body, fallback = "Story") {
  const firstLine = String(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || String(fallback || "Story");
  const sentence = firstLine.split(/(?<=[.!?…。！？]["“”„«»']?)\s+/u)[0] || firstLine;
  const cleaned = sentence.replace(QUOTE_CHARS, "").replace(/\s+/g, " ").trim();
  return truncateAtWord(cleaned, TITLE_MAX) || String(fallback || "Story");
}

export function makeExcerpt(body, max = EXCERPT_MAX) {
  const flat = String(body).replace(/\s+/g, " ").trim();
  return truncateAtWord(flat, max);
}

// Cut on a word boundary and add an ellipsis — only when actually truncating
// (the old version always deleted the final word, even for short bodies).
export function truncateAtWord(text, max) {
  const value = String(text);
  if (value.length <= max) return value;
  const slice = value.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s,;:]+$/, "")}…`;
}

export function countWords(text) {
  const matches = String(text).trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const HTML_LANG_MAP = {
  bulgarian: "bg",
  swedish: "sv",
  danish: "da",
  english: "en",
  hungarian: "hu",
  vietnamese: "vi",
  german: "de",
  french: "fr",
  spanish: "es",
  italian: "it",
  polish: "pl",
  romanian: "ro",
  czech: "cs",
  norwegian: "no",
  dutch: "nl",
  portuguese: "pt"
};

export function languageToHtmlLang(language) {
  return HTML_LANG_MAP[String(language || "").trim().toLowerCase()] || "en";
}

// Words mixing Cyrillic and Latin letters — a common cheap-model glitch
// ("слunce", "naturalни") that native readers spot instantly. Used as a
// quality gate to retry glitched sections and reject glitched seeds.
export function mixedScriptWords(text) {
  const words = String(text).match(/\S+/g) || [];
  return words.filter((word) => /[Ѐ-ӿ]/.test(word) && /[A-Za-z]/.test(word));
}

const CYRILLIC_LANGUAGES = new Set([
  "bulgarian", "russian", "ukrainian", "serbian", "macedonian", "belarusian"
]);

export function usesCyrillicScript(language) {
  return CYRILLIC_LANGUAGES.has(String(language || "").trim().toLowerCase());
}

const WORDS_LABEL = {
  bg: "думи",
  vi: "từ",
  sv: "ord",
  da: "ord",
  hu: "szó",
  en: "words"
};

export function wordsLabel(htmlLang) {
  return WORDS_LABEL[htmlLang] || WORDS_LABEL.en;
}
