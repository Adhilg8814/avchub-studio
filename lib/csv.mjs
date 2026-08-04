// One CSV implementation for the whole pipeline (was duplicated 3x with a
// quoting-rule drift: generate-stories didn't quote \r, which its own
// consumers would then split as a row terminator).

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  const source = String(text);
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

// Parse a CSV that has a header row into objects keyed by header name.
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { header: [], records: [] };
  const [header, ...rest] = rows;
  const records = rest.map((row) => {
    const record = {};
    header.forEach((column, index) => {
      record[column] = row[index] ?? "";
    });
    return record;
  });
  return { header, records };
}

// guardFormulas neutralizes spreadsheet formula injection (leading = + - @)
// by prefixing a single quote. Enable it ONLY for CSVs meant to be opened in
// Excel/Sheets by a human (facebook-posts.csv) — never for machine-consumed
// files like index.csv or image-prompts.csv, where the prefix would corrupt
// the data.
export function toCsv(rows, { guardFormulas = false } = {}) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          let text = String(value ?? "");
          if (guardFormulas && /^[=+@-]/.test(text) && !/^-?\d+([.,]\d+)?$/.test(text)) {
            text = `'${text}`;
          }
          return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        })
        .join(",")
    )
    .join("\n") + "\n";
}

// A cell that must stay on one line (index.csv is read line-by-line by the
// WPF viewer, so embedded newlines would break it).
export function singleLineCell(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}
