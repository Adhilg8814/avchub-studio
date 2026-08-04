// One slug implementation for the whole pipeline (was copied 3x in JS and 2x
// in Python with different length limits, and dropped all Cyrillic which made
// every Bulgarian title collapse to "story").

const CYRILLIC_MAP = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s",
  т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht",
  ъ: "a", ь: "", ю: "yu", я: "ya", ы: "y", э: "e", ё: "e", і: "i", ї: "yi",
  є: "ye", ґ: "g"
};

export const SLUG_MAX_LENGTH = 80;

export function transliterate(value) {
  return String(value)
    .toLowerCase()
    .split("")
    .map((char) => (Object.hasOwn(CYRILLIC_MAP, char) ? CYRILLIC_MAP[char] : char))
    .join("");
}

export function safeSlug(value, maxLength = SLUG_MAX_LENGTH) {
  const slug = transliterate(String(value))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks (Vietnamese, Swedish, ...)
    .replace(/[đð]/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "story";
}

// Slug for a generated story file: strip the numeric prefix from the basename
// ("001-locked-drawer-v1" -> "locked-drawer-v1"). File basenames are already
// ASCII, so this is the stable join key across every artifact.
export function slugFromStoryFile(filePath) {
  const base = String(filePath).replace(/\\/g, "/").split("/").pop() || "";
  const withoutExt = base.replace(/\.[^.]+$/, "");
  return safeSlug(withoutExt.replace(/^\d+-/, ""));
}
