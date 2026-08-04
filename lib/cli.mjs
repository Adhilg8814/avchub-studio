// Single argument parser for every script in the pipeline.
// Supports: --flag value | --flag=value | bare --flag (=> true).
// Rejects unknown flags and stray positional arguments so typos fail loudly
// instead of silently running with defaults.
export function parseArgs(argv, knownFlags = null) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}". Flags must start with -- (e.g. --config config.json).`);
    }

    let key = arg.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        value = true;
      } else {
        value = next;
        index += 1;
      }
    }

    if (knownFlags && !knownFlags.includes(key)) {
      throw new Error(`Unknown flag --${key}. Known flags: ${knownFlags.map((flag) => `--${flag}`).join(", ")}`);
    }
    parsed[key] = value;
  }
  return parsed;
}

// Numeric option that treats 0 as a valid value (the old `Number(x || d)`
// pattern silently replaced 0 with the default).
export function numberOption(value, fallback) {
  if (value === undefined || value === null || value === "" || value === true || value === false) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// Positive integer with fallback (used for counts like --generate-seeds 20).
export function positiveIntOption(value, fallback) {
  const number = numberOption(value, fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
