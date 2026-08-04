// P0 Step 5C.2 — id minting for persisted rows. Reuses the shipped pure ULID generator
// (lib/protocol/ids.mjs). Supports DB-only prefixes (off_, evt_, aff_, cred_, …) that are not
// in the wire ID_PREFIXES set; the DB CHECK constraints validate the format either way.

import { generateUlid, validateId } from "../../../lib/protocol/ids.mjs";

// newId('attempt') -> 'attempt_01JQ...'. Any prefix; caller ensures it matches a table CHECK.
export function newId(prefix) {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(prefix)) throw new Error(`unsafe id prefix: ${prefix}`);
  return `${prefix}_${generateUlid()}`;
}

export { validateId };
