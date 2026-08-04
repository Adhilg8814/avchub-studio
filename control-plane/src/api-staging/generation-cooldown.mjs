// P0 Step 5C.30 — DURABLE PROVIDER SUBMISSION COOLDOWN (pacing) + UNCERTAIN REVIEW helpers.
//
// Pacing model. Grok Imagine refuses PRE-SUBMIT when generations are fired back to back, so every dispatch
// must first RESERVE a submission slot for the physical lane it will use: (provider, account, profile). The
// reservation is one atomic statement against provider_submission_slots:
//
//     eligible  -> the row's next_eligible_at is pushed forward by the cooldown and the caller may dispatch
//     not yet   -> nothing is written; the caller is told WHEN the lane frees up and defers the job
//
// Because the guard lives in the row (not in a timer), the wait is free and restart-safe: a deferred job holds
// NO worker lease, NO browser/profile lock, NO open transaction and NO invocation-guard slot, and after a
// process restart the lane still knows its next eligible time. Two workers racing for the same lane cannot
// both win — the UPDATE ... WHERE next_eligible_at <= now takes a row lock, so exactly one sees a row updated.
//
// Adaptive backoff. A REAL provider cooldown signal (a pre-submit refusal proven to have reached no provider)
// raises the lane's interval geometrically up to a cap and counts consecutive cooldowns; a successful submit
// resets it to the configured base. Small deterministic jitter avoids lock-step retries across lanes.

export const DEFAULT_PROVIDER_COOLDOWN_MS = 120_000;   // production default for Grok Imagine video
export const MAX_PROVIDER_COOLDOWN_MS = 900_000;       // hard cap (15 min) — a lane can never hang forever
export const MAX_COOLDOWN_DEFERRALS = 12;              // then the job fails pre-submit honestly, no busy loop

// Provider signals that are PROVABLY pre-submit and transient -> pace and retry later.
const COOLDOWN_CODES = new Set(["E_GROK_IMAGINE_PRE_SUBMIT", "E_GROK_IMAGINE_SUBMIT_DISABLED", "E_PROVIDER_RATE_LIMITED", "E_PROVIDER_MANUAL_TUNNEL_LEASE_FAILED"]);
// Signals that must NEVER be auto-retried (identity/authorization/policy/possibly-submitted).
const NEVER_RETRY_CODES = new Set([
  "E_GENERATION_REAUTH_REQUIRED", "E_GENERATION_AUTHORIZATION_FAILED", "E_GENERATION_ACCOUNT_UNRESOLVED",
  "E_PROVIDER_ACCOUNT_SUSPENDED", "E_PROVIDER_POLICY_VIOLATION", "E_PROVIDER_PERMISSION_DENIED",
  "E_GENERATION_SUBMIT_UNCERTAIN", "E_CUSTOMER_SUSPENDED", "E_CUSTOMER_EXPIRED", "E_GENERATION_EXECUTION_PAUSED"
]);

// Classify a failed run. Retry-as-cooldown ONLY when the evidence says nothing reached the provider:
// no invocation consumed, not submitted, no provider submission id. Anything uncertain is terminal by design.
export function classifyRunFailure({ code = null, invocationConsumed = false, submitted = false, providerSubmissionId = null, possiblySubmitted = false } = {}) {
  if (invocationConsumed || submitted || providerSubmissionId || possiblySubmitted) return { kind: "TERMINAL", reason: "POSSIBLY_SUBMITTED" };
  if (code && NEVER_RETRY_CODES.has(code)) return { kind: "TERMINAL", reason: "NON_RETRYABLE" };
  if (code && COOLDOWN_CODES.has(code)) return { kind: "COOLDOWN", reason: code };
  return { kind: "TERMINAL", reason: "UNCLASSIFIED" };
}

export function normalizeCooldownMs(value, fallback = DEFAULT_PROVIDER_COOLDOWN_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;              // fail-safe: never a negative/NaN interval
  return Math.min(Math.round(n), MAX_PROVIDER_COOLDOWN_MS);
}

// Deterministic small jitter (0..10% of the interval) derived from the lane key — avoids a thundering herd
// without needing a random source (which would break replayable tests).
export function jitterFor(key, ms) {
  if (!ms) return 0;
  let h = 0;
  for (let i = 0; i < String(key).length; i += 1) h = (h * 31 + String(key).charCodeAt(i)) >>> 0;
  return Math.floor((h % 1000) / 1000 * Math.min(ms * 0.1, 10_000));
}

export const slotKeyOf = ({ provider, accountRef, profileRef }) => `${provider}|${accountRef}|${profileRef || "-"}`;

// ---------------------------------------------------------------- durable slot operations
// All take an OPEN client so the caller can compose them into its own transaction.

// Atomically reserve the lane. Returns { granted, nextEligibleAt, cooldownMs, slotKey }.
// The single UPDATE ... WHERE next_eligible_at <= now is the concurrency primitive: only one racing caller
// can observe a row change, so a lane can never hand out two simultaneous submissions.
export async function reserveSlot(client, { provider, accountRef, profileRef = "-", nowMs, baseCooldownMs = DEFAULT_PROVIDER_COOLDOWN_MS, newId }) {
  const now = new Date(nowMs).toISOString();
  const key = slotKeyOf({ provider, accountRef, profileRef });
  // ensure the lane exists (first use is immediately eligible)
  await client.query(
    `INSERT INTO provider_submission_slots (id, provider, account_ref, profile_ref, next_eligible_at, cooldown_ms)
     VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0), $6)
     ON CONFLICT (provider, account_ref, profile_ref) DO NOTHING`,
    [newId("pslot"), provider, accountRef, profileRef, nowMs, normalizeCooldownMs(baseCooldownMs)]
  );
  const upd = await client.query(
    `UPDATE provider_submission_slots
        SET next_eligible_at = to_timestamp($4/1000.0) + (cooldown_ms || ' milliseconds')::interval,
            last_reserved_at = to_timestamp($4/1000.0),
            reservation_count = reservation_count + 1
      WHERE provider=$1 AND account_ref=$2 AND profile_ref=$3
        AND next_eligible_at <= to_timestamp($4/1000.0)
      RETURNING next_eligible_at, cooldown_ms`,
    [provider, accountRef, profileRef, nowMs]
  );
  if (upd.rows.length === 1) {
    return { granted: true, slotKey: key, nextEligibleAt: upd.rows[0].next_eligible_at, cooldownMs: upd.rows[0].cooldown_ms };
  }
  const cur = await client.query(
    "SELECT next_eligible_at, cooldown_ms FROM provider_submission_slots WHERE provider=$1 AND account_ref=$2 AND profile_ref=$3",
    [provider, accountRef, profileRef]
  );
  const row = cur.rows[0] || null;
  return { granted: false, slotKey: key, nextEligibleAt: row ? row.next_eligible_at : new Date(nowMs), cooldownMs: row ? row.cooldown_ms : normalizeCooldownMs(baseCooldownMs) };
}

// Record what happened on a lane after a dispatch: SUBMITTED resets the interval to base; COOLDOWN raises it
// geometrically (capped) and pushes the next eligible time out so the next job waits the longer interval.
export async function noteSlotOutcome(client, { provider, accountRef, profileRef = "-", outcome, nowMs, baseCooldownMs = DEFAULT_PROVIDER_COOLDOWN_MS }) {
  const base = normalizeCooldownMs(baseCooldownMs);
  if (outcome === "SUBMITTED") {
    const r = await client.query(
      `UPDATE provider_submission_slots SET cooldown_ms=$4, consecutive_cooldowns=0, last_outcome='SUBMITTED'
        WHERE provider=$1 AND account_ref=$2 AND profile_ref=$3 RETURNING cooldown_ms, next_eligible_at`,
      [provider, accountRef, profileRef, base]
    );
    return r.rows[0] || null;
  }
  if (outcome === "COOLDOWN") {
    const r = await client.query(
      `UPDATE provider_submission_slots
          SET consecutive_cooldowns = consecutive_cooldowns + 1,
              cooldown_ms = LEAST($5, GREATEST(cooldown_ms, $4) * 2),
              next_eligible_at = GREATEST(next_eligible_at, to_timestamp($6/1000.0) + (LEAST($5, GREATEST(cooldown_ms, $4) * 2) || ' milliseconds')::interval),
              last_outcome='COOLDOWN'
        WHERE provider=$1 AND account_ref=$2 AND profile_ref=$3
        RETURNING cooldown_ms, next_eligible_at, consecutive_cooldowns`,
      [provider, accountRef, profileRef, base, MAX_PROVIDER_COOLDOWN_MS, nowMs]
    );
    return r.rows[0] || null;
  }
  const r = await client.query(
    `UPDATE provider_submission_slots SET last_outcome=$4 WHERE provider=$1 AND account_ref=$2 AND profile_ref=$3 RETURNING cooldown_ms, next_eligible_at`,
    [provider, accountRef, profileRef, outcome === "FAILED" ? "FAILED" : "RESET"]
  );
  return r.rows[0] || null;
}

export async function listSlots(client) {
  const r = await client.query(
    `SELECT provider, account_ref, profile_ref, next_eligible_at, cooldown_ms, consecutive_cooldowns, reservation_count, last_outcome
       FROM provider_submission_slots ORDER BY next_eligible_at`);
  return r.rows.map((x) => ({
    provider: x.provider, accountRef: x.account_ref, profileRef: x.profile_ref,
    nextEligibleAt: x.next_eligible_at, cooldownMs: x.cooldown_ms,
    consecutiveCooldowns: x.consecutive_cooldowns, reservationCount: Number(x.reservation_count), lastOutcome: x.last_outcome
  }));
}
