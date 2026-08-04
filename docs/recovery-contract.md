# P0 Step 5.7a — Recovery Contract

**Status: implemented.** This document is the authoritative specification of how the
local Worker recovers in-flight generation jobs across crashes, restarts, timeouts, and
reconnects **without ever spending a second paid generation for the same request**. It is
the prerequisite that makes the golden rule provable *before* the Scheduler / Control
Plane / multi-tenant cloud is built (P0 Step 5C+).

It supersedes the ad-hoc recovery notes in `docs/worker-scheduler-review.md` §C1–C13 by
turning those review corrections into enforced code + tests.

Scope note: this step does **not** implement the Scheduler, Control Plane, PostgreSQL, or
multi-tenancy; it does not modify production `ui-server` behavior; it does not enable
Worker mode; and no automated test executes a provider or consumes quota. Every
"submission" in the code and tests is a journal write.

---

## 1. The golden rule (invariant)

> **Exactly one paid generation may ever be booked to a `generationAttemptId`.**
> No crash, restart, replay, reconnect, duplicate offer, or recovery path may produce a
> second one. A second paid generation only ever comes from a *new* job carrying a
> *new* `generationAttemptId` — i.e. a user-confirmed retry.

This is enforced structurally, in three independent layers, so no single bug can break it:

1. **State machine** (`lib/worker/recovery-states.mjs`) — a record can only move forward.
   It can never regress from a submitted/post-submit state to a pre-submit state, and
   `SUBMITTING` is never re-enterable.
2. **Generation ordinal** (`recovery-journal.mjs`) — `generationOrdinal` counts paid
   generations for a record and is capped at 1. Entering `SUBMITTING` requires it to
   still be 0; a second attempt throws `E_DUPLICATE_GENERATION_ATTEMPT`.
3. **Sibling guard** (`recovery-journal.mjs`) — before any record for a
   `generationAttemptId` submits, the journal scans all sibling records of that attempt;
   if any already submitted, the new submit is refused.

And recovery code can never *choose* to regenerate: `planRecovery()` has no "execute"
action, and `assertNoAutoRegenerate()` throws for every state except `PRE_SUBMIT`.

---

## 2. Local recovery state machine

`lib/worker/recovery-states.mjs` is the single authoritative definition. Each journal
record has a `localState`:

```
CREATED → RUNNING → SUBMITTING → SUBMITTED → DOWNLOADING → IMPORTED → <terminal>
              │          │            │            │            │
              └──────────┴────────────┴────────────┴────────────┴─→ NEEDS_MANUAL_ACTION ─┐
                                                                                          │
      (operator resolves → resume forward from where it paused) ←─────────────────────────┘

<terminal> = SUCCEEDED | FAILED | CANCELED   (absorbing — no exits)
```

### Legal transitions (authoritative table)

| From | Legal `to` |
|------|-----------|
| `CREATED` | `RUNNING`, `SUBMITTING`, `SUBMITTED`, `NEEDS_MANUAL_ACTION`, `SUCCEEDED`, `FAILED`, `CANCELED` |
| `RUNNING` | `SUBMITTING`, `SUBMITTED`, `NEEDS_MANUAL_ACTION`, `SUCCEEDED`, `FAILED`, `CANCELED` |
| `SUBMITTING` | `SUBMITTED`, `NEEDS_MANUAL_ACTION`, `FAILED`, `CANCELED` |
| `SUBMITTED` | `DOWNLOADING`, `IMPORTED`, `NEEDS_MANUAL_ACTION`, `SUCCEEDED`, `FAILED`, `CANCELED` |
| `DOWNLOADING` | `IMPORTED`, `NEEDS_MANUAL_ACTION`, `SUCCEEDED`, `FAILED`, `CANCELED` |
| `IMPORTED` | `NEEDS_MANUAL_ACTION`, `SUCCEEDED`, `FAILED`, `CANCELED` |
| `NEEDS_MANUAL_ACTION` | `RUNNING`, `SUBMITTING`, `SUBMITTED`, `DOWNLOADING`, `IMPORTED`, `SUCCEEDED`, `FAILED`, `CANCELED` |
| `SUCCEEDED` / `FAILED` / `CANCELED` | *(none — absorbing)* |

Notes:
- `CREATED → SUBMITTING/SUBMITTED` and `RUNNING → SUBMITTED` exist for the **one-step
  legacy path** (Step 4A fakes / simple handlers that submit without a distinct
  `markRunning`/`markSubmitting`). The generation-ordinal guard still books exactly one
  generation on that path.
- A self-transition (`from === to`) is an idempotent no-op **except** `SUBMITTING →
  SUBMITTING`, which is a re-submit and is **illegal**.
- Illegal transitions throw `E_ILLEGAL_RECOVERY_TRANSITION` and leave the record
  untouched.

### Why `SUBMITTING` exists (the crash-window closer, review item C3)

`SUBMITTING` is persisted **before** the provider is asked to generate. Without it, a
crash between "sent the request" and "persisted submittedToProvider=true" would recover
to a `RUNNING` record that looks safe to retry — and a retry would double-charge.

With it, that crash recovers to a `SUBMITTING` record with `submissionConfidence:
UNKNOWN` and `generationOrdinal: 1`. Recovery classifies this as `SUBMITTING_UNKNOWN`
("maybe billed") and never auto-retries.

---

## 3. Generation attempt identity

Persisted on every record (`recovery-journal.mjs` `create()`):

| Field | Meaning |
|-------|---------|
| `generationAttemptId` | The identity that at-most-one paid generation is booked to. |
| `parentAttemptId` | The attempt this one is a retry of (chain of user-confirmed retries). |
| `requestIdempotencyKey` | Dedupes duplicate *offers* of the same request. |
| `retryOfJobId` | The prior job this attempt replaces. |
| `attemptIndex` | 0 for the first attempt of a request; increments per retry. |
| `generationOrdinal` | Paid generations booked to **this record** (0 or 1; never >1). |

Rules:
- A **jobId** executes at most once (duplicate offers are idempotent — see §7).
- A **generationAttemptId** generates at most once (the golden rule).
- A **retry** is a *new* job with a *new* `generationAttemptId` and `parentAttemptId`
  pointing at the previous attempt — never a re-run of the same record.

Queries: `journal.hasSubmittedAttempt(attemptId, {excludeJobId})` and
`journal.listByAttempt(attemptId)` expose the attempt ledger for external proofs.

---

## 4. Provider submission evidence

Persisted by `markSubmitting()` / `markSubmitted()`:

| Field | Meaning |
|-------|---------|
| `submissionState` | `NOT_SUBMITTED` → `SUBMITTING` → `SUBMITTED`. |
| `submissionConfidence` | `NONE` → `UNKNOWN` (in the submit window) → `PRESUMED` / `CONFIRMED`. |
| `providerSubmissionId` | Provider-side acceptance id (`submission_<ULID>`) when known. |
| `submissionEvidence` | Small sanitized provenance note (scalars only; URLs/secrets stripped). |
| `providerIdempotencyKey` | Opaque provider token used for idempotent submit / lookup. |
| `idempotencySupport` | `NONE` / `NATIVE` / `DERIVED` — how (if at all) the provider dedupes. |
| `submittingAt` / `submittedAt` | Timestamps of the two submission phases. |

**Idempotency levels** (`IDEMPOTENCY_SUPPORT`):
- `NONE` — no idempotency; a re-submit could double-charge. A crashed submit must be
  **inspected by a human**, never auto-resubmitted. *(Grok is NONE.)*
- `NATIVE` — the provider dedupes on our key; a re-submit collapses to the original
  generation. Submission lookup is implied.
- `DERIVED` — no native key, but the submission is discoverable via a derived lookup
  (client tag / title) *before* re-submitting.

Sanitization: `submissionEvidence` and `providerIdempotencyKey` are defensively filtered
(`_safeSubmissionEvidence` / `_safeIdempotencyKey`) so `markSubmitted` can **never fail on
evidence** — a URL, absolute path, or dangerous key is dropped, never stored, and never
aborts the quota-safety commit.

---

## 5. Extended recovery classification + decision matrix

`classifyRecoveryContract(record)` (`recovery-classifier.mjs`) maps a record to a
fine-grained contract state. `planRecovery(record, capabilities?)` returns the plan:

| Contract state | Meaning | Action | safeToRetry | needsOperator | canResume | inspectProvider |
|---|---|---|---|---|---|---|
| `PRE_SUBMIT` | no provider call started | `RETRY_SAFE` | ✅ | | ✅ | |
| `SUBMITTING_UNKNOWN` | submit in flight; maybe billed | `INSPECT_PROVIDER` | ❌ | ✅ | ✅ | ✅ |
| `SUBMITTED_WAITING` | provider generating | `WAIT_FOR_PROVIDER` | ❌ | | ✅ | |
| `RESULT_AVAILABLE` | result ready to collect | `RESUME_DOWNLOAD` | ❌ | | ✅ | |
| `DOWNLOADED` | local ref, not imported | `RESUME_IMPORT` | ❌ | | ✅ | |
| `IMPORTED` | asset made, terminal pending | `REDELIVER_TERMINAL` | ❌ | | ✅ | |
| `TERMINAL_PENDING_ACK` | outcome owed to cloud | `REDELIVER_TERMINAL` | ❌ | | ✅ | |
| `MANUAL_ACTION_REQUIRED` | provider verification etc. | `ESCALATE_OPERATOR` | ❌ | ✅ | ✅ | |
| `SETTLED` | done + acknowledged | `NONE` | ❌ | | | |
| `CORRUPT` | unreadable record | `ESCALATE_OPERATOR` | ❌ | ✅ | | |
| `UNKNOWN` | inconsistent record | `ESCALATE_OPERATOR` | ❌ | ✅ | | |

**Only `PRE_SUBMIT` is ever `safeToRetry`.** There is deliberately **no** action that
regenerates a submitted attempt.

**Capability degradation:** if a plan would `INSPECT_PROVIDER` but the provider's
capabilities report `supportsSubmissionLookup !== true`, `planRecovery()` downgrades to
`ESCALATE_OPERATOR` with `degradedNoLookup: true`. We never pretend to verify a submit the
provider cannot tell us about — so a Grok `SUBMITTING_UNKNOWN` record always goes to the
operator.

---

## 6. Resume contract

`recover()` semantics (as encoded by `planRecovery` + `assertNoAutoRegenerate`):

- **`recover()` never calls `execute()` once `submittedToProvider === true`** (or once
  `SUBMITTING` has been entered). This is asserted: `assertNoAutoRegenerate(record)`
  throws `E_DUPLICATE_GENERATION_ATTEMPT` for every state except `PRE_SUBMIT`.
- Recovery may: **inspect** the provider (only if capable), **wait** for the provider,
  **resume the download**, **resume the import**, **re-deliver** the terminal to the
  cloud, or **escalate** to the operator.
- Recovery may **never** regenerate automatically. A new generation requires a new
  `generationAttemptId` (a user-confirmed retry), which is a new record — outside the
  recovery path entirely.

---

## 7. Provider recovery capabilities

`lib/worker/recovery-capabilities.mjs`. Conservative-by-default flags a provider adapter
opts into:

| Flag | Question it answers |
|------|---------------------|
| `supportsIdempotencyKey` | Can a key make a duplicate submit collapse to one generation? |
| `supportsSubmissionLookup` | Can we ask "did my crashed submit land?" without generating? |
| `supportsResume` | Can we re-attach to an in-flight generation after restart? |
| `supportsDownloadResume` | Can an interrupted download be continued safely? |
| `supportsImportResume` | Can an interrupted import be re-run idempotently? |
| `idempotencySupport` | `NONE` / `NATIVE` / `DERIVED`. |

`resolveRecoveryCapabilities(declared)` merges a declaration over all-false defaults;
malformed/non-boolean values can only ever *remove* capability, never fabricate one.
`GROK_RECOVERY_CAPABILITIES` is the safest profile: everything off, `idempotencySupport:
NONE` — a crashed Grok submit is always operator-escalated.

---

## 8. Drain vs stop

`worker-runtime.mjs`:

| | Accepts new offers | In-flight jobs | Use |
|---|---|---|---|
| `stop()` | ❌ (rejects `E_WORKER_UNAVAILABLE`) | **canceled** (INTERRUPTED/CANCELED) | shutdown-now / disconnect |
| `drain()` | ❌ (rejects `E_WORKER_UNAVAILABLE`) | **finish + persist** normally | graceful shutdown |

`drain()` sets `isRunning()=false`, `isDraining()=true`, unsubscribes from new offers, but
leaves active jobs running. The caller waits on `hasActiveJobs()` before finally calling
`stop()`. This distinction exists precisely so a graceful shutdown does not interrupt a
job that has **already spent quota**; that job runs to completion, persists, and is
acknowledged, and is fully recoverable after restart if the process dies mid-flight. A
new offer arriving during drain/stop is rejected with `E_WORKER_UNAVAILABLE` so the cloud
can re-route it.

---

## 9. Crash windows

Every crash point and its recovery, for a paid-generation action:

| # | Crash window | Persisted state at recovery | Contract state | Recovery |
|---|---|---|---|---|
| A | Before submit (running, not yet asked provider) | `RUNNING`, ordinal 0 | `PRE_SUBMIT` | **Safe to retry** — no quota spent. |
| B | During submit (asked provider, no confirmation) | `SUBMITTING`, ordinal 1, confidence `UNKNOWN` | `SUBMITTING_UNKNOWN` | **Inspect provider** (if capable) else **operator**. Never auto-retry. |
| C | After submit, before persisting confirmation | `SUBMITTING`, ordinal 1 | `SUBMITTING_UNKNOWN` | Same as B — the barrier already booked the generation. |
| D | After confirmation persisted, before result | `SUBMITTED`, confidence `CONFIRMED` | `SUBMITTED_WAITING` | **Wait / re-attach** for the existing result. |
| E | After result available, before download | `SUBMITTED` + `resultAvailable` | `RESULT_AVAILABLE` | **Resume download**. |
| F | After download, before import | `DOWNLOADING`/local ref set | `DOWNLOADED` | **Resume import**. |
| G | After import, before terminal emit | `IMPORTED` | `IMPORTED` | **Re-deliver terminal**. |
| H | After terminal, before ACK | terminal + `ackPending` | `TERMINAL_PENDING_ACK` | **Re-deliver terminal** (same messageId; cloud dedupes). |
| I | After ACK | terminal + `acknowledged` | `SETTLED` | Nothing to do. |

The critical windows are **B/C**: the `SUBMITTING` barrier converts an
otherwise-invisible "maybe billed" state into an explicit one, so recovery treats it as
billed and never retries.

---

## 10. Journal authority

The recovery journal is the **single source of truth** for recovery safety:

- The on-disk record — not any in-memory snapshot or cloud state — decides whether a job
  may generate. Snapshots are advisory; recovery rebuilds decisions from the journal by
  re-reading it (`RecoveryJournal` over the same root re-reads every record).
- Writes are atomic (temp-file + rename): a crash mid-write leaves either the old
  complete record or nothing — never a half-written one.
- Corrupt records are quarantined (moved aside, never deleted) and classify as `CORRUPT`
  → operator.
- Retention (`sweep`) only ever removes `SETTLED` (acknowledged-terminal) records after
  their retention window. It **never** removes an in-flight or submitted record, so the
  quota-safety evidence for a live attempt is never swept out from under it. (A settled
  attempt is complete; any future retry mints a new `generationAttemptId` anyway.)

---

## 11. Enforcement summary (where each rule lives)

| Rule | Enforced in | Error |
|------|-------------|-------|
| Forward-only transitions | `recovery-states.mjs` `assertRecoveryTransition` | `E_ILLEGAL_RECOVERY_TRANSITION` |
| One generation per record | `recovery-journal.mjs` `markSubmitting` (ordinal guard) | `E_DUPLICATE_GENERATION_ATTEMPT` |
| One generation per attempt (siblings) | `recovery-journal.mjs` `_findSubmittedSibling` | `E_DUPLICATE_GENERATION_ATTEMPT` |
| No auto-regenerate in recovery | `recovery-classifier.mjs` `assertNoAutoRegenerate` | `E_DUPLICATE_GENERATION_ATTEMPT` |
| Never inspect a provider that can't look up | `recovery-classifier.mjs` `planRecovery` degrade | *(plan → operator)* |
| No new work while draining/stopped | `worker-runtime.mjs` `_onJobOffer` guard | `E_WORKER_UNAVAILABLE` |
| Evidence never leaks / never aborts commit | `recovery-journal.mjs` sanitizers | *(dropped, no throw)* |

---

## 12. Tests

- `tests/recovery-contract-tests.mjs` (107) — regression: state-machine table, attempt
  identity, sibling golden rule, submit-crash, timeout→later, download/import/ack
  progression, PRE_SUBMIT-only retry, duplicate replay/recover, manual resume, restart,
  corruption, illegal transitions, provider capability, evidence sanitization, sweep
  retention.
- `tests/recovery-property-tests.mjs` (13) — properties: (P1) no legal transition
  regresses past submission; (P2) `safeToRetry ⇔ PRE_SUBMIT` for every state; (P3) a
  3000-sequence fuzz with an adversarial recover-and-retry op proves **at most one paid
  generation per attempt** always holds; (P4) crash-at-every-step never leaks
  `RETRY_SAFE` after the submit barrier.
- `tests/recovery-drain-tests.mjs` (21) — drain lets an in-flight job finish and persist
  while refusing new offers; stop cancels; both retain the quota-safety flag.

All three run in `npm run test-all` and `npm run test-step5.7a`. Every test uses throwaway
temp directories; none starts ui-server / a browser / Python / a provider / a real
socket, reads credentials, touches production media, or consumes quota.
