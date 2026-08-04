# P0 Step 5C — Production Control Plane Architecture

**Status: design only.** This document specifies the future production Control Plane. It
does **not** implement anything, create migrations, deploy, enable
`WORKER_RUNTIME_BRIDGE`, or change `studio.example.com` / the legacy Studio. No code under
`lib/`, `ui-server.mjs`, WorkerRuntime, Scheduler, handlers, recovery, pairing, or the
WebSocket transport is modified. Only `docs/` files are created.

It builds directly on the shipped stack and the prior design docs:
[local-first-saas-architecture.md](local-first-saas-architecture.md) (service split,
source-of-truth matrix §A.4, DB sketch §H, job states §I, idempotency §J, affinity §K),
[protocol-v1.md](protocol-v1.md) (envelope, message types, `MESSAGE_ACK`, reconcile),
[worker-scheduler.md](worker-scheduler.md) + [-review.md](worker-scheduler-review.md)
(two-tier scheduling; the `expiresAt` open question C9), and
[recovery-contract.md](recovery-contract.md) (the enforced golden rule, `SUBMITTING`
barrier, submission evidence, resume contract, drain).

**Companion docs:** [control-plane-postgres-schema.md](control-plane-postgres-schema.md)
(the full schema + constraints + retention), [control-plane-deployment-plan.md](control-plane-deployment-plan.md)
(isolation, DR, feature flags, staging phases), [control-plane-review.md](control-plane-review.md)
(adversarial review + Go/No-Go).

**The one invariant everything below protects:**
> **At most one paid provider generation per `generationAttemptId`** — across Worker
> disconnects, Control-Plane restarts, duplicate messages, retries, reconciliation,
> Worker replacement, multiple Workers, database failures, delayed messages, and expired
> jobs. When the truth is uncertain, the design **fails safe** (no re-offer, manual
> reconciliation) — never fail-open into a second paid generation.

---

## 0. Consolidation status & correction traceability (Step 5C.0)

This document is a **consolidated implementation specification**: the accepted corrections
from the adversarial review have been **merged into the body sections below**, and the body
states the final rule directly. There is no correction overlay to reconcile — a reader does
**not** need this section to know the correct behavior. The table is a **non-normative
traceability index** only (correction id → where the rule now lives → the review finding it
came from). See [control-plane-review.md](control-plane-review.md) for the historical
findings and severities.

| Correction | Topic | Now specified in | Review finding |
|---|---|---|---|
| C1 | Inbound assigned-worker gate | §10.2 | F3 |
| C2 | Safe re-offer only if never delivered | §6.1, §6.2, §7 | F2 |
| C3 | Producing-Worker facts vs current affinity | §5, §10.3 | F4 |
| C4 | `possibly_submitted` disproof clear-path | §10.3 rule 3 | F19 |
| C5 | Reconnect reconcile barrier | §10.4 | F7 |
| C6 | Socket-aware, ordered outbox delivery | §1.4, §11.1, §12.1 | F5, F6 |
| C7 | Dedupe before skew; replay re-stamps `sentAt` | §11.2, §21 | F18, F25 |
| C8 | Idempotent `generation_ordinal` | §14 | F21 |
| C9 / D18 | DB-role model & ops enumeration | §1.4, §3.3.1 | F8 |
| C10 / D16 | Platform-operator identity | §4, §17.3 | F9 |
| C11 | Target-resource workspace derivation | §3.2 | F10 |
| C12 | Flag dependency lattice + kill switches + approval token | §24 | F14, F15, F30 |
| C13 | UI progress vs media-availability (two axes) | §25.1 | F16, F17, F20, F36 |
| C14 | Preview object-key derivation | §17.2 | F22 |
| C15 | Storage tier ⊕ liveness | §16 | F16, F27 |
| D17 | Outbox settlement modes | §12.1 | (settlement synchronization) |

---

## 1. Service boundaries

Six logical services. For the MVP they deploy as a **modular monolith** (§1.7): one
`control-plane` process containing modules 2–4, plus PostgreSQL (5) and the optional
preview store (6). Correctness never depends on which process/instance holds a Worker's
socket, because all coordination flows through the database (inbox/outbox, §11).

### 1.1 Studio Web Application (`studio-*`)
End-user UI: project editing, review/approval, user-facing progress, simple Worker
onboarding. It talks **only** to the Control Plane API over HTTPS. It must **not** manage
provider browsers or local files, hold Worker credentials, or open the Worker WSS.

### 1.2 Control Plane API (`control-*`, HTTPS)
Authentication integration, workspace authorization, project/episode/shot/prompt
metadata, review state, job creation, Worker **selection** (coarse routing), job/attempt
ownership, reconciliation actions, audit, and the **asset-metadata mirror**. It writes
business state + an **outbox** row in one transaction; it never touches a Worker socket
directly.

### 1.3 Worker Gateway (`worker-*`, WSS)
Terminates WSS, authenticates Workers (credential in `Authorization` header only),
derives connection identity (`workerId`/`workspaceId`), validates every envelope
(schema, direction, identity, skew, dedupe), runs heartbeat/idle timeouts, routes frames,
persists inbound to the **inbox**, drains the **outbox** to the socket, sends
`MESSAGE_ACK`, and applies backpressure. It holds **no authoritative state** — only the
live socket + advisory connection session (§18, §19).

### 1.4 Background Control Plane Processor (`control-worker`)
Transactional-outbox delivery + resend timers; offer/execution-deadline processing;
reconciliation timeouts; credential-rotation scheduling; retention/archival; audit
processing. Stateless; every unit of work is a claimed database row (`FOR UPDATE SKIP
LOCKED`), so N replicas are safe and a restart loses nothing. Its cross-workspace
enumeration queries (global outbox drain, offer/lease/deadline sweeps, inbox lookup before
the workspace is known) run under the dedicated `cp_ops_enumerator` role and only enumerate
due `(workspace_id, row_id)` pairs; each business-state transition is then applied through
`cp_tenant_app` with `app.current_workspace` set to that row's workspace (see §3.3). The
outbox claim is **socket-aware**: it selects only rows for workers whose `ACTIVE`
`worker_connection_sessions.gateway_instance = self`, and a claim that finds no local live
socket **releases** the row (`PENDING`, no `attempts++`) rather than sending/dead-lettering
it (see §11.1).

### 1.5 PostgreSQL
The authoritative cloud metadata store. Separate database, role, secrets, and volume
from AVCHub (§2, deployment plan). Source of truth for everything in the
[source-of-truth matrix](local-first-saas-architecture.md) **except** media bytes,
checksums, local paths, provider sessions, and the Worker submission journal (those are
Worker-authoritative; cloud mirrors metadata only).

### 1.6 Optional preview / object storage
Only for **explicitly** uploaded previews (thumbnail/waveform/proxy) or opt-in backups.
Disabled by default. Full media stays Worker-local (`LOCAL_ONLY`, §16). Never receives
provider secrets or absolute paths.

### 1.7 MVP boundary — modular monolith, not microservices

| | Chosen: modular monolith | Rejected: microservices from day 1 |
|---|---|---|
| Deployable units | one `control-plane` binary (API + Gateway + Processor as modules) + Postgres | 3–4 independently deployed services |
| Coupling | modules share the DB only; no in-process calls that cross the eventual seams | network hops + partial-failure surface before it is needed |
| Split later | a deployment change (run the Gateway module as its own process), **not** a redesign — modules already talk only through inbox/outbox | already split (no payoff yet, more ops) |
| Ops | one health check, one rollback, one log stream to start | N pipelines, N dashboards, distributed tracing required up front |

**Recommendation:** ship the monolith. The Gateway↔API↔Processor seams are drawn at the
**database** (outbox for cloud→worker, inbox for worker→cloud), so the future extraction
of the Gateway into its own horizontally-scaled process is additive. This is the safest
MVP boundary: real module isolation now, no premature distributed system. (Decision D1.)

---

## 2. Deployment isolation (summary)

Full detail in [control-plane-deployment-plan.md](control-plane-deployment-plan.md).
The production Control Plane is isolated from the existing AVCHub app on every axis:
separate process/service, environment config, **database + role + secrets + volume**,
logs, health checks, deployment + rollback, and WSS route. `studio.example.com` stays on
the **legacy flow** until `control_plane_enabled` is turned on for a specific workspace
(§24). Staging hostnames (design only, not provisioned here):
`studio-staging.example.com`, `control-staging.example.com`, `worker-staging.example.com`.

---

## 3. Tenancy model

```
User → Workspace Membership → Workspace → Project → Episode → Shot
     → Generation Request → Generation Attempt → Job → Asset Metadata
```

**Every tenant-owned row carries `workspace_id`** (denormalized down the whole tree, not
just derivable via joins) so a single indexed predicate scopes every query and RLS policy.
Only `users` and `workspaces` are workspace-agnostic.

### 3.1 Roles (per `workspace_members.role`)

| Role | Projects | Generate (spend quota) | Review/approve | Manage Workers/pairing | Members/billing |
|---|---|---|---|---|---|
| `OWNER` | full | ✅ | ✅ | ✅ | ✅ (+future billing owner) |
| `ADMIN` | full | ✅ | ✅ | ✅ | members (not billing) |
| `EDITOR` | create/edit | ✅ | ✅ | — | — |
| `REVIEWER` | read | — | ✅ (approve/select only) | — | — |
| `VIEWER` | read | — | — | — | — |
| *future* `BILLING_OWNER` | — | — | — | — | billing only |

Quota-spending actions (`GENERATE_*`) require `EDITOR+`. Approve/select require
`REVIEWER+`. Worker lifecycle requires `ADMIN+`.

### 3.2 Query scoping (never trust client IDs)

- The authenticated **session** yields `userId`. The effective `workspaceId` is **derived
  from the target resource** (e.g. `SELECT workspace_id FROM projects WHERE id=$projectId`),
  and the caller's role is then checked in **that workspace's** `workspace_members` row —
  **never** by picking the user's "most-privileged membership" (that would be a
  confused-deputy escalation for a multi-workspace user). A client-supplied ID is only ever
  validated *inside* an already workspace-scoped query.
- Every repository method takes `workspaceId` as its first argument and every SQL query
  includes `WHERE workspace_id = $ws`. There is no repository method that reads a
  tenant table without a workspace predicate (enforced by a lint/test rule at
  implementation time).
- A client-supplied `projectId`/`jobId` is only ever used **inside** an already-scoped
  query (`WHERE workspace_id = $ws AND id = $id`) — so an ID from another tenant returns
  "not found", never another tenant's row.
- On the Worker channel, `workspaceId`/`workerId` are **derived from the credential**,
  and any mismatching envelope field is rejected with `E_IDENTITY_MISMATCH` (protocol §10).

### 3.3 Row-Level Security — defense in depth, on from day one

**Recommendation:** service-level scoping (§3.2) is **primary and mandatory**; PostgreSQL
**RLS is added in the first production version as a second, independent fence** — not as
the only check.

| Option | Verdict | Trade-off |
|---|---|---|
| RLS only | ✗ | one missed `SET` = full exposure; app can't express role nuances |
| Service scoping only | ✗ (as sole layer) | one missed `WHERE` = cross-tenant leak; no backstop |
| **Service scoping + RLS (chosen)** | ✅ | RLS `USING (workspace_id = current_setting('app.current_workspace')::text)` with a **fail-closed default** (unset GUC → deny). Retrofitting RLS after data exists is riskier than enabling it now. The tenant app role is non-superuser and `NOBYPASSRLS` (RLS is not bypassed for business traffic). |

Set `app.current_workspace` per transaction from the server-resolved membership (never
from a header). (Decision D4.)

#### 3.3.1 Database roles & the ops-enumeration exception

Business API traffic never bypasses RLS. But some processor/gateway queries are inherently
**cross-workspace** (a global outbox drain, offer/lease/deadline sweeps, and an inbox lookup
that happens *before* the workspace is known). With fail-closed RLS a `NOBYPASSRLS` role
would see **zero rows** and delivery would silently stall. This is resolved with **separate
roles and connection pools**, not a table-scoped privilege:

| Role | RLS | Grants | Used for | Never |
|---|---|---|---|---|
| `cp_migrator` | owner/DDL | schema ownership | applies migrations only | not used by the running app |
| `cp_tenant_app` | **`NOBYPASSRLS`** | business tables | all business API transactions; `app.current_workspace` set per txn | cross-workspace scans |
| `cp_ops_enumerator` | **`BYPASSRLS`** | **only** `protocol_inbox`/`protocol_outbox`/`protocol_message_acks` + the offer/lease/deadline sweep columns | enumerate due `(workspace_id, row_id)` work | applying business-state transitions |
| `cp_readonly_observer` *(optional)* | `NOBYPASSRLS` | sanitized read views | metrics/health reads | writes; secret columns |

Flow: `cp_ops_enumerator` lists due `(workspace_id, row_id)` pairs, then **releases/closes
that connection**; each row is processed through `cp_tenant_app` in a transaction with
`app.current_workspace` set to that row's workspace and an explicit `workspace_id` predicate.

> **`BYPASSRLS` is a PostgreSQL *role attribute*, not a table-scoped privilege** — a
> `BYPASSRLS` role bypasses RLS on **every** table it can read. Containment comes from
> **minimal `GRANT`s** (the enumerator can touch only the protocol/sweep tables) and
> **separate connection pools** (enumeration is read-only and never applies business state),
> **not** from "BYPASSRLS scoped to selected tables" (no such thing exists). (Decision D4.)

---

## 4. Authentication & authorization

Four **separate** identity domains that never cross:

| Domain | Who | Credential | Where verified | Never |
|---|---|---|---|---|
| **A. Human user** | end users | session token / external-auth (OIDC) identity | Control Plane API (HTTPS) | never a Worker credential; never sent to a Worker |
| **B. Worker** | paired machines | `wcred_` (≥256-bit, HMAC-SHA256 verifier stored) | Worker Gateway (WSS `Authorization: Bearer`) | never a human session token; never in payload/URL/args/logs |
| **C. Internal service** | API↔Gateway↔Processor | short-lived mTLS / signed service token (or in-monolith: same process, no network identity needed) | between services | never a user or Worker credential |
| **D. Platform operator** | AVC platform staff | operator session, **MFA-gated**, distinct from any workspace role | Admin/internal API (§17.3) | never a workspace `ADMIN` role standing in for it; never provider secrets |

A workspace `ADMIN` (domain A, scoped to one workspace) is **not** a platform operator: it
may **read** its own workspace's flag state but cannot write non-tenant tables
(`feature_flags`, global `rate_limit_buckets`) or invoke `/admin/*` — those require domain D
(§17.3). Platform-operator actions are audited with `actor_type='ADMIN'`.

Rules (from protocol §2/§10 + Step 5B):
- **User session validation** → `userId`; **workspace membership lookup** → `(workspaceId,
  role)` set; role checks per §3.1.
- **Worker credential verification** is constant-time against the stored verifier
  (`HMAC-SHA256(credentialPepper, credential)`); expired/revoked/worker-revoked → generic
  401 (existence not revealed). Identity is then **derived** and bound to the connection.
- **Audit attribution**: every audit row records `actor_type ∈ {USER, WORKER, ADMIN,
  SYSTEM}` + `actor_id`, so a Worker action and a human action are never conflated.
- **Rotation/revocation** reuse the shipped two-phase rotation + `WORKER_REVOKED` flow
  (Step 5B): rotation over the authenticated rotate endpoint only; revoke → all
  credentials `REVOKED` → `WORKER_REVOKED` → socket closed → Worker deletes local
  credential. Human sessions have their own independent lifecycle (logout, disable-user).
- **Provider account credentials are NOT cloud secrets.** Provider/browser profiles,
  cookies, and tokens stay Worker-local; the cloud stores only `provider_accounts`
  metadata (`session_status`, `local_profile_ref` label — never a path/cookie/token).

---

## 5. Project affinity

MVP rule: **one project is assigned to one primary Worker at a time** (generalizes
`projects.home_worker_id` into an auditable, versioned assignment). See the
`project_worker_affinity` table (schema doc §Projects).

Columns: `projectId, workspaceId, workerId, assignedAt, assignedBy, status
(ACTIVE/RELEASING/RELEASED/IRRECOVERABLE), generation (int, optimistic-concurrency),
lastConfirmedAt, releasedAt, releaseReason`.

Rules:
- The cloud offers a project's jobs **only** to the `ACTIVE`-affinity Worker.
- Affinity **cannot silently change while a generation may be submitted.** A reassign is
  **blocked while the project has any attempt that is non-terminal, `possibly_submitted`,
  or in `TERMINAL_PENDING_ACK` whose terminal has not yet been delivered/acked** (§6) —
  every such attempt must first be reconciled/resolved. This guarantees a producing Worker
  can still deliver a genuine terminal for its attempt even after a migration begins (its
  submission/terminal facts remain authoritative for that attempt, §10.2).
- **Worker offline does NOT auto-reassign.** Jobs queue; assets show `WORKER_OFFLINE`.
  The affinity stays put — the media lives on that Worker.
- **Migration is explicit and reconciled** (never automatic): the old Worker must
  `RELEASE` (archive verified) or be declared `IRRECOVERABLE` by an operator; local media
  is **not assumed** to exist on the replacement Worker.

### 5.1 Future migration (design only, not implemented)
`ACTIVE → RELEASING` (freeze new jobs; drain running) → `CREATE_PROJECT_ARCHIVE` on the
source Worker → per-asset checksum verify → transfer (LAN/USB/NAS/opt-in cloud) →
`IMPORT_PROJECT_ARCHIVE` on the target → validate media → new affinity row
(`generation+1`, target Worker `ACTIVE`) → old row `RELEASED` → audit. If the source is
gone, an operator marks it `IRRECOVERABLE`; assets whose bytes never arrive become
`MISSING`/`MIGRATION_REQUIRED` (§16) — the cloud never fabricates media it does not have.

---

## 6. Generation-ownership golden rule (cross-tier)

> **A `generationAttemptId` may be owned for paid execution by at most one Worker at a
> time**, and the Control Plane must **never** offer that attempt to another Worker when
> its status *could* mean the provider already received the submission.

The cloud tracks a **coordination state** per attempt that is **not** a copy of the Worker
execution state. Four state spaces are kept separate:

| Space | Owner | Authoritative for | Examples |
|---|---|---|---|
| **Cloud coordination** | Control Plane | ownership/re-offer decisions | `OFFERED`, `POSSIBLY_SUBMITTED`, `COMPLETED` |
| **Worker execution** | WorkerRuntime | what the handler is doing | `RUNNING`, `NEEDS_MANUAL_ACTION` |
| **Provider submission** | Worker journal | whether quota was spent | `submissionState`, `submissionConfidence` (recovery-contract §4) |
| **User-facing** | Studio UI projection | what a human sees | Waiting, Generating, Ready (§25) |

### 6.1 Cloud coordination states (attempt ownership)

| State | Meaning | Paid submission possible? | Re-offer same attempt? |
|---|---|---|---|
| `CREATED` | attempt row exists, not offered | no | n/a (not yet offered) |
| `OFFER_PENDING` | outbox row written, not yet sent | no | — |
| `OFFERED` | `JOB_OFFER` sent, awaiting accept (offer lease) | no | **only if the offer was provably never delivered** (outbox row still `PENDING`, never `SENT`) |
| `ACCEPTED` | Worker accepted, not started | not yet — but silence ⇒ must reconcile | no (reconcile first) |
| `RUNNING` | Worker started, pre-submit | **possible imminently** | **no** |
| `SUBMITTING` | Worker crossed the submit barrier | **yes (maybe billed)** | **no** |
| `POSSIBLY_SUBMITTED` | Worker silent with unknown submission | **yes (assume billed)** | **no** |
| `SUBMITTED` | confirmed submitted | **yes (billed)** | **no** |
| `RECOVERING` | reconciliation/inspection in progress | depends — treated as possible | **no** |
| `RESULT_AVAILABLE` | provider result ready | yes | no (resume download) |
| `IMPORTED` | asset imported locally | yes | no (redeliver terminal) |
| `TERMINAL_PENDING_ACK` | terminal received, being applied durably | yes | no |
| `COMPLETED` | terminal success, settled | yes (already spent, once) | no |
| `FAILED` | terminal failure | maybe (see reason) | no (new attempt only) |
| `CANCELED` | canceled | maybe | no (new attempt only) |
| `MANUAL_ACTION_REQUIRED` | needs operator/provider verification | possible | no |
| `EXPIRED_PRE_SUBMIT` | expired and **provably** before submit | **no** | fail attempt; a retry is a **new** `generationAttemptId` |

### 6.2 The re-offer safety rule (the crux)

The set of coordination states from which the **same** `generationAttemptId` may be
re-offered/auto-progressed on the generation path is exactly:

- `CREATED` / `OFFER_PENDING` → not yet dispatched; dispatch normally.
- `OFFERED` **and the offer was provably never delivered** — its `protocol_outbox` row is
  still `PENDING` (never marked `SENT`, so the socket never carried it). Only then did the
  attempt provably never reach a Worker's execution, so re-offer is safe.
- `EXPIRED_PRE_SUBMIT` → the attempt is failed; the *user* may start a **new** attempt (new
  `generationAttemptId`).

**"Offer expired before `JOB_ACCEPTED` was recorded" is NOT sufficient.** A `JOB_ACCEPTED`
can be in flight or lost while the Worker is already executing/submitting; the absence of a
recorded accept does not prove no submission. Therefore any offer that was ever `SENT` but
is unaccepted at expiry goes to `RECOVERING`/reconcile — **never** auto-re-offer. And
applying a late `JOB_ACCEPTED` must, under the attempt row lock, **reject** the accept if the
offer has already been moved to `EXPIRED_PRE_SUBMIT` (so a re-offered-and-a-late-accept can
never create two live owners).

**Every other state is non-re-offerable.** Anything at or after `ACCEPTED` where we cannot
*prove* "no submission" collapses to `POSSIBLY_SUBMITTED` and goes to reconciliation, never
to a second offer of the same or a new attempt without human confirmation. A confirmed
`SUBMITTED`/downloaded/imported attempt is recovered (download/import/redeliver) — never
regenerated. This mirrors, at the cloud tier, `assertNoAutoRegenerate()` at the Worker
tier (recovery-contract §6). (Decision D6.)

---

## 7. Job offer ownership (durable lease)

Each offer/attempt has a durable ownership row (`job_offers`, schema doc §Jobs). Fields:
`jobId, generationAttemptId, workspaceId, projectId, assignedWorkerId, offerMessageId,
offerVersion, offeredAt, acceptedAt, offerExpiresAt, executionDeadlineAt, leaseExpiresAt,
lastWorkerEventAt, ownershipStatus, reconcileRequired, possiblySubmitted, terminalAt`.

**A lease expiry MUST NOT be read as "the paid generation did not happen."** The lease is
a *liveness* timer, not a *submission* fact. It is only ever safe to convert an expiry into
a re-offer when the record proves the Worker never got past accept:

| Situation | `possiblySubmitted` | Safe to re-offer same attempt? | Action on lease/timer expiry |
|---|---|---|---|
| Offer expired while outbox row still **`PENDING`** (never `SENT`) | false | **yes** | return to routing (`CREATED`), re-dispatch |
| Offer was **`SENT`** but unaccepted at expiry | unknown → **true** (fail-safe) | **no** | `RECOVERING`/reconcile — a lost `JOB_ACCEPTED` may mean the Worker is already executing |
| Accepted but **no** `JOB_STARTED`, Worker responsive | false (confirm via reconcile) | only after reconcile confirms not-started | request reconcile; if confirmed not-started → re-offerable |
| Accepted but Worker **silent** | unknown → **true** (fail-safe) | **no** | `POSSIBLY_SUBMITTED`; reconcile on reconnect |
| `JOB_STARTED` (RUNNING) | true | **no** | wait/reconcile |
| Entered `SUBMITTING` | true | **no** | `POSSIBLY_SUBMITTED`; inspect provider (if capable) else operator |
| Silent with unknown submission | **true** | **no** | `POSSIBLY_SUBMITTED` |
| Confirmed `SUBMITTED` | true | **no** | wait/download/import (recovery) |
| Safely terminal (settled) | — | **no** | done |

**Default to fail-safe.** Any uncertainty ⇒ `possiblySubmitted = true` ⇒ manual/reconcile,
never auto re-offer. (Decisions D7, D8.)

---

## 8. `expiresAt` ownership (two distinct concepts)

The Scheduler review's open question (C9) is resolved by splitting the single `expiresAt`
into **two** independently-owned deadlines:

| Concept | Column | Owner | Before/after accept | Meaning | On expiry |
|---|---|---|---|---|---|
| **Offer expiration** | `offer_expires_at` | Control Plane | before `ACCEPTED` | Worker did not accept the offer in time | job returns to routing / `EXPIRED_PRE_SUBMIT`; **safe** (no execution) |
| **Execution deadline** | `execution_deadline_at` | Control Plane (user/system intent) | after `ACCEPTED` | user/system no longer wants the operation to continue | **does NOT prove non-submission**; if `possiblySubmitted`, go to reconciliation/import, never auto-regenerate |

Rules:
- Offer expiration **before acceptance** may re-queue the job (offer lease, §7).
- After acceptance, **expiration is not proof the provider did not receive the submission.**
- A `SUBMITTING`/`SUBMITTED` job is **never** converted into a new generation automatically
  by a deadline; it is recovered.
- The **Worker** may report a *local* deadline status (its own drain/deadline handling,
  recovery-contract §8), but the **cloud owns the user-facing coordination result.**
- A paid operation that exceeds a deadline may still require recovery/import — the result
  may already exist and must not be abandoned or re-billed.

**Canonical naming (recommended):** `offer_expires_at` (pre-accept, cloud-owned,
re-offer-safe) and `execution_deadline_at` (post-accept, cloud-owned, **not**
submission-safe). The wire keeps a single `expiresAt` on `JOB_OFFER` for backward
compatibility; the cloud maps it to `offer_expires_at` and derives
`execution_deadline_at` from request/user intent. (Decision D8.)

---

## 9. Cloud ↔ Worker state mapping

Complete mapping across the four state spaces + the six per-mapping safety questions.
"Paid?" = paid submission may have happened. "Re-offer?" = cloud may offer this attempt to
a Worker. "Exec?" = a Worker may run generation. "recover()?" = a non-generating recovery
(wait/download/import/redeliver) is allowed. "Manual?" = needs operator. "User sees" per
§25.

| Worker runtime | Scheduler | Recovery classification | **Cloud coordination** | Paid? | Re-offer? | Exec? | recover()? | Manual? | User sees |
|---|---|---|---|---|---|---|---|---|---|
| — | QUEUED | — | `CREATED`/`OFFER_PENDING` | no | yes (dispatch) | yes | — | no | Waiting |
| — | QUEUED | — | `OFFERED` | no | **only if never delivered (outbox still `PENDING`)** | yes | — | no | Waiting |
| accepted | QUEUED | — | `ACCEPTED` | not yet | no (reconcile) | yes | — | no | Waiting |
| RUNNING (pre-submit) | RUNNING | PRE_SUBMIT | `RUNNING` | imminent | **no** | in progress | — | no | Generating |
| SUBMITTING | RUNNING | SUBMITTING_UNKNOWN | `SUBMITTING` | **yes** | **no** | no | no (inspect only) | maybe | Generating |
| submitted | RUNNING | SUBMITTED_WAITING | `SUBMITTED` | **yes** | **no** | no | wait | no | Generating |
| waiting provider | WAITING_PROVIDER | SUBMITTED_WAITING | `SUBMITTED` | yes | no | no | wait | no | Generating |
| result available | RUNNING | RESULT_AVAILABLE | `RESULT_AVAILABLE` | yes | no | no | download | no | Generating |
| downloaded | RUNNING | DOWNLOADED | `RESULT_AVAILABLE` | yes | no | no | import | no | Generating |
| imported | RUNNING | IMPORTED | `IMPORTED` | yes | no | no | redeliver | no | Generating→Ready |
| pending ACK | — | TERMINAL_PENDING_ACK | `TERMINAL_PENDING_ACK` | yes | no | no | redeliver | no | Generating |
| settled | — | SETTLED | `COMPLETED` | yes(once) | no | no | — | no | Ready |
| canceled before submit | CANCELED | PRE_SUBMIT→terminal | `CANCELED` | **no** | no (new attempt) | no | — | no | Failed/Canceled |
| canceled after submit request | CANCELED | SUBMITTING_UNKNOWN/…→terminal | `CANCELED` (`possiblySubmitted=true`) | **maybe** | no | no | import if result exists | maybe | Needs attention |
| manual action | NEEDS_MANUAL_ACTION | MANUAL_ACTION_REQUIRED | `MANUAL_ACTION_REQUIRED` | possible | no | no (until resolved) | after resolve | **yes** | Needs attention |
| corrupt journal | — | CORRUPT | `RECOVERING`→`MANUAL_ACTION_REQUIRED` | unknown→assume yes | **no** | no | no | **yes** | Needs attention |
| unknown | — | UNKNOWN | `POSSIBLY_SUBMITTED` | assume **yes** | **no** | no | no | **yes** | Needs attention |
| Worker offline | (n/a) | (last known) | unchanged (e.g. `SUBMITTED`) | per last known | **no** | no | on reconnect | no | Worker offline |
| expired offer (pre-accept) | — | — | `EXPIRED_PRE_SUBMIT` | **no** | re-offer as new attempt allowed | yes(new) | — | no | Waiting/Failed |
| execution deadline exceeded | (varies) | (varies) | keep prior; if `possiblySubmitted` → `POSSIBLY_SUBMITTED` else `EXPIRED_PRE_SUBMIT` | per prior | **no** if possibly-submitted | no | recovery if result exists | maybe | Needs attention/Failed |

**Reading rule:** wherever the Worker/provider space says "maybe billed", the cloud space
is pinned to a **non-re-offer, non-exec** state. The mapping is monotonic: uncertainty
always resolves toward the more conservative cloud state.

---

## 10. Reconciliation

Reconciliation runs after: Worker reconnect, Control-Plane restart, Worker restart,
Gateway restart, missed terminal ACK, duplicated terminal message, submitted-Worker going
offline, cloud-newer-than-Worker, Worker-journal-newer-than-cloud, identity mismatch, and
affinity mismatch.

### 10.1 Messages (all shipped in protocol v1)
- `STATE_RECONCILE_REQUEST` (cloud→worker): ask the Worker to report local state.
- `STATE_RECONCILE` (worker→cloud): full local snapshot — `activeJobs` (with
  `submittedToProvider`, `providerSubmissionId`), `terminalPendingAck` (with result +
  `importedAssetId`), `lastEventSequenceByJob`, `journalDigest`; batched ≤1 MB; each batch
  `MESSAGE_ACK`-ed.
- `JOB_RECOVERY_REPORT` (worker→cloud): a locally-finished result not yet acked; cloud
  applies terminal + upserts asset with `createdSecondGeneration:false`; `MESSAGE_ACK`.
- **Terminal replay** (worker→cloud): pending-ack terminals replayed with the **same
  `messageId`**; cloud dedupes via the inbox (§11) and replays the cached ACK.
- `MESSAGE_ACK`: the single acknowledgement mechanism (§12).

### 10.2 Inbound authorization gate (every worker→cloud job message)

Before any reconciliation/precedence logic, **every** inbound job-scoped message passes a
two-part identity gate — envelope identity alone is **not** sufficient:

1. **Envelope identity** — `workerId`/`workspaceId` on the frame must equal the identity
   **derived from the authenticated credential** (protocol §10); mismatch →
   `E_IDENTITY_MISMATCH` + audit, no state change.
2. **Assigned-worker binding** — inside the workspace-scoped lookup, the message's `jobId`
   must resolve to a job with `job.workspace_id = derivedWorkspace AND
   job.assigned_worker_id = derivedWorker` (the worker on that job's `job_offers` row).
   Otherwise → `E_IDENTITY_MISMATCH` + audit, **no** state change.

This gate is **independent of `project_worker_affinity_enabled`** and applies to terminal,
submission, progress, and reconcile messages. Without it, a validly-paired `wrk_A` could
apply a terminal/submission fact to `wrk_B`'s job in the same workspace.

### 10.3 Deterministic conflict-resolution precedence

> **Journal safety facts from the Worker MUST NEVER be overwritten by weaker cloud
> assumptions. For paid-generation safety, the more conservative state wins.**

When cloud state and the Worker report disagree, resolve **top-down**; the first matching
rule decides:

1. **Producing-Worker submission/terminal facts win — regardless of *current* affinity.**
   The relevant identity is the attempt's own `job_offers.assigned_worker_id`, **not** the
   project's current `ACTIVE`-affinity Worker. If the reporting Worker is the one that owns
   the attempt (per §10.2's assigned-worker binding) and reports `submittedToProvider=true`
   / a `providerSubmissionId` / a terminal result, the cloud **adopts** it **upgrade-only**
   — even if project affinity has since migrated to another Worker. The cloud may **never
   downgrade** a "submitted/terminal-with-result" attempt back to "not submitted" or
   re-offer it. (This is why affinity migration is blocked while any attempt is unresolved,
   §5 — so a producing Worker can always deliver its genuine terminal.)
2. **Affinity gate applies only to ownership-mutating / execution messages.** A message
   that would *take ownership* of, or *drive execution* for, a project's jobs is accepted
   only from the project's current `ACTIVE`-affinity Worker; a non-affinity Worker's such
   message → reject + audit. (Submission/terminal *facts* from the producing Worker are
   governed by rule 1, not this gate.)
3. **Conservative-wins for paid safety, with an explicit disproof clear-path.** If
   cloud=`not-submitted` and Worker=`submitted` → **submitted** wins. If cloud=`submitted`
   and Worker=`not-submitted` from a *stale/ambiguous* report → treat as
   **`POSSIBLY_SUBMITTED`** (do not clear the paid-risk), route to inspect/manual — never
   auto-regenerate. **Clear path:** a fail-safe `possibly_submitted=true` (set on brief
   silence, §7) **is cleared** only when an **authoritative full reconcile for that exact
   attempt** proves `submission_state=NOT_SUBMITTED`, `generation_ordinal=0`, and no
   submitted sibling (recovery-contract window A). This distinguishes a genuine disproof
   from a stale "not submitted" report and prevents every pre-submit blip pinning an
   attempt in manual forever.
4. **Media facts are Worker-authoritative.** checksum/size/availability/relativePath come
   from the Worker; the cloud mirror is read-only for these.
5. **Collaborative metadata is Cloud-authoritative (optimistic concurrency).** A stale
   Worker `baseRevision` never overwrites newer cloud project/prompt/review metadata; the
   cloud keeps its metadata and accepts only the Worker-owned media facts
   ([source-of-truth matrix](local-first-saas-architecture.md#a4)).
6. **Terminal is exactly-once.** A terminal already applied (inbox has the messageId) →
   replay the cached ACK, do not re-apply (§11); the `job_terminal_results` single-terminal
   uniqueness is the cross-path backstop (schema §Jobs).

**Precedence one-liner:** *the state that implies a paid generation might exist always
dominates the state that implies it does not.* (Decision D9.)

### 10.4 Reconcile barrier on (re)connect

On a Worker (re)connect the cloud **suspends** two things for that `workerId` until the
Worker's `STATE_RECONCILE` reaches its `isLast` batch and is acked: (a) outbox drain of
`JOB_OFFER`, and (b) any offer-expiry auto-re-offer. Each offer decision is tagged with the
Worker's current **reconcile epoch**, and an offer whose input predates an unapplied
reconcile is refused. This closes the window where a just-reconnected Worker's
`submitted=true` fact (which arrives in the `activeJobs` batch, *after* `terminalPendingAck`
per protocol §5.2) has not yet been applied while the sweep re-offers the same attempt.

---

## 11. Inbox / outbox (transactional messaging)

Replaces the in-memory `seen`/`acks`/outbox of `LocalControlPlane`/`InMemoryCloudStore`
with durable tables (`protocol_inbox`, `protocol_outbox`, `protocol_message_acks`,
`worker_connection_sessions` — schema doc §Protocol). Correctness survives process memory
loss because nothing important lives only in RAM.

### 11.1 Outbound (cloud → Worker)
1. **One transaction** creates the business state change **and** inserts a
   `protocol_outbox` row (`status=PENDING`, minted `messageId`, `workerId`, `type`,
   sanitized `payload`, `next_attempt_at=now`). Business commit and "intent to send" are
   atomic — a crash after commit still has the PENDING row.
2. The **Background Processor / Gateway** claims due PENDING rows
   (`SELECT … FOR UPDATE SKIP LOCKED`), **scoped to workers whose `ACTIVE`
   `worker_connection_sessions.gateway_instance = self`** so an instance never claims a row
   for a socket held by another instance. It then sends over the live socket and sets
   `status=SENT`, `sent_at`. A claim that finds **no local live socket releases the row**
   (leaves it `PENDING`, **no** `attempts++`) — it is never marked `SENT` or dead-lettered
   against an absent socket. "Sent" is **not** "acknowledged."
3. **Delivery is single-flight per `(worker_id, job_id)`**, ordered by `created_at`: the
   next message for a `(worker,job)` pair is not released until the prior row reaches its
   **settlement condition** (§12, `settlement_mode`), so a `JOB_CANCEL_REQUEST` or a
   re-offer can never overtake its `JOB_OFFER`. (Because `JOB_OFFER` settles on a *lifecycle
   response* — accept/reject/expiry — not on a generic `MESSAGE_ACK`, a cancel behind it is
   never wedged; §12.)
4. **Retries preserve `messageId`** (same row, `attempts++`, backoff `next_attempt_at`);
   the Worker dedupes by `messageId`. After max attempts unsettled → `status=DEAD`
   (dead-letter with a per-type operator runbook, deployment §DC6) — never an infinite loop.
5. The row settles per its `settlement_mode` (§12) — a `MESSAGE_ACK{ACCEPTED}`, a validated
   lifecycle response, or a confirmed send for advisory messages — setting `status=ACKED`,
   `acked_at`.

### 11.2 Inbound (Worker → cloud) — fixed receive order

Processing order is **dedupe-before-skew** (a replay reuses its `messageId` but re-stamps
`sentAt`, so checking skew first would wrongly drop a legitimately-late replayed terminal
and leave it forever unacked):

1. Parse + size/depth safety (reject oversized/deeply-nested/prototype-pollution payloads).
2. Extract `messageId` safely.
3. **Durable inbox/dedupe lookup** by `(worker_id, message_id)`. If present → **duplicate**:
   return the **cached** ACK (from `protocol_message_acks`), apply **no** business change.
4. Only for a *new* message: apply the `sentAt` ±120s skew check.
5. Identity/direction/schema validation, including the §10.2 assigned-worker gate.
6. **One transaction**: insert the inbox row (**UNIQUE(worker_id, message_id)**), apply the
   business transition, and record the ACK to send. A concurrent duplicate loses the unique
   race → falls back to the cached-ACK path (step 3).

**A terminal event is therefore processed exactly once**: the inbox insert and the business
apply commit together (a crash between them cannot double-apply), a redelivery replays the
cached ACK, and `job_terminal_results`'s single-terminal uniqueness (schema §Jobs) backstops
any cross-path re-application. `sentAt` is **not** a durable replay-security key — the
durable defense is the inbox key plus a dedupe **tombstone** retained beyond payload sweep
(schema §Protocol).

### 11.3 Table roles (detail in schema doc §Protocol + §23 retention)
- `protocol_inbox` — inbound dedupe; `UNIQUE(worker_id, message_id)`; references the ACK
  that was returned so duplicates replay it.
- `protocol_outbox` — outbound queue + resend state machine (`PENDING/SENT/ACKED/DEAD`).
- `protocol_message_acks` — the canonical ACK ledger (both directions) for replay + audit.
- `worker_connection_sessions` — advisory: which Gateway instance currently holds the
  socket, `session_id`, `resume_token_hash`, `last_seen_at`, `status`
  (`ACTIVE/SUPERSEDED/CLOSED`). Advisory only — never gates correctness (§19).

Dedupe key = `(worker_id, message_id)`. Payload storage is size-limited (≤256 KB / ≤1 MB
reconcile) and **redacted** to journal-safety rules (no secret/URL/absolute-path) before
persistence.

---

## 12. `MESSAGE_ACK` contract

`MESSAGE_ACK` remains the **only** explicit acknowledgement mechanism (protocol §5.1);
there are no `ack:true`/`*_ACK` side channels, and an ACK is never itself acked.

ACK persistence (in `protocol_message_acks`, surviving DB restart) covers: terminal job
events (`JOB_COMPLETED/FAILED/CANCELED`), `JOB_RECOVERY_REPORT`, `STATE_RECONCILE` (per
batch), `ASSET_METADATA_UPSERT`, and future credential-lifecycle events
(`WORKER_CREDENTIAL_ROTATE`).

Rules:
- An ACK references `ackedMessageId` (+ `ackedType`, `status`, `serverRevision`,
  `errorCode`).
- **Duplicate ACK is harmless** (idempotent; keyed on `ackedMessageId`).
- **`ACCEPTED` is the only status that clears a Worker's pending-ack** (and settles our
  outbox row).
- **`REJECTED` must not create an infinite resend loop** — the sender records the
  rejection to diagnostics and stops resending (matches shipped pending-ack semantics).
- **`VALIDATION_FAILED` is auditable**; the sender does not resend the identical payload
  (it would fail again) and never loses local media (Worker keeps the file, flags manual).
- **Cached ACK is replayed** for a duplicate inbound `messageId` (§11.2).
- **DB restart does not lose ACK dedupe** — the ledger + inbox are durable, unlike the old
  in-memory `acks` map.

### 12.1 Outbox settlement modes (do not conflate ACK, lifecycle response, and send)

An outbox row's `settlement_mode` (schema §Protocol) is the **single** field that says what
"settled" means for that message. `MESSAGE_ACK` is **not** the settlement for every message:

| Mode | Settled by | Use for |
|---|---|---|
| `MESSAGE_ACK` | `MESSAGE_ACK{status:"ACCEPTED", ackedMessageId}` | messages whose protocol contract requires an explicit `MESSAGE_ACK` |
| `LIFECYCLE_RESPONSE` | a validated, correlated protocol response of the expected type | messages answered by a lifecycle message, **not** a generic ACK |
| `SEND_ONLY` | a confirmed local socket write | **only** explicitly non-critical advisory messages |

`SEND_ONLY` is **forbidden** for paid-job ownership, cancellation, credential lifecycle,
terminal results, reconciliation, or any other correctness-critical message.

Settlement per Cloud → Worker type (verified against shipped `message-types.mjs`; only
`WORKER_CREDENTIAL_ROTATE` is in the shipped `ACK_REQUIRING_TYPES` for this direction):

| Cloud → Worker type | `settlement_mode` | Expected response / ACK | Resend rule | Ordering key | Timeout behavior | Dead-letter |
|---|---|---|---|---|---|---|
| `JOB_OFFER` | `LIFECYCLE_RESPONSE` | `JOB_ACCEPTED` **or** `JOB_REJECTED` | resend same `messageId` until a response or `offer_expires_at` | `(worker_id, job_id)` | on `offer_expires_at`: if still `PENDING` → `EXPIRED_PRE_SUBMIT`; if ever `SENT` → `RECOVERING` (§6.2) | `DEAD` → operator re-queue offer |
| `JOB_CANCEL_REQUEST` | `LIFECYCLE_RESPONSE` | `JOB_CANCELED` **or** an already-terminal correlated outcome | resend until cancel/terminal | `(worker_id, job_id)` | bounded; then mark `reconcile_required` | `DEAD` → operator reconcile |
| `STATE_RECONCILE_REQUEST` | `LIFECYCLE_RESPONSE` | complete `STATE_RECONCILE` batch sequence (`isLast` + per-batch acks) | resend until reconcile completes or reconnect | `(worker_id)` | until reconcile or reconnect | `DEAD` → operator re-issue |
| `SESSION_CHECK_REQUEST` | `LIFECYCLE_RESPONSE` | `PROVIDER_SESSION_STATUS` | few resends | `(worker_id)` | short; advisory | drop → diagnostic |
| `WORKER_CREDENTIAL_ROTATE` | `MESSAGE_ACK` | `MESSAGE_ACK{ACCEPTED}` (worker acks after storing) | resend same `messageId`, capped | `(worker_id)` | rotation grace window; **old credential stays valid** until promotion | `DEAD` → operator; old credential retained |
| `WORKER_REVOKED` | `LIFECYCLE_RESPONSE` (connection close) | connection observed closed | resend until disconnect | `(worker_id)` | short — **revocation is enforced server-side at revoke time** (all credentials `REVOKED`; auth then fails), so delivery is a best-effort local-cleanup courtesy, never the correctness mechanism | n/a — server-authoritative |
| `HELLO_ACK` | `SEND_ONLY` | — (it *is* the response to `WORKER_HELLO`) | none (re-handshake on reconnect) | `(worker_id)` | — | n/a |
| `PING` | `SEND_ONLY` | (`WORKER_HEARTBEAT`, advisory) | none | `(worker_id)` | — | n/a |
| `MESSAGE_ACK` | `SEND_ONLY` | — (never itself acked) | none (replayed for a duplicate inbound `messageId`) | — | — | n/a |

Consequences (must hold):
- `MESSAGE_ACK` remains the **only** explicit generic ACK message; `JOB_ACCEPTED`/
  `JOB_REJECTED` are **lifecycle responses**, not custom ACK message types.
- An outbox row does **not** have to receive a `MESSAGE_ACK` if its protocol-defined
  settlement is a lifecycle response.
- Per-`(worker_id, job_id)` single-flight (§11.1 step 3) waits for the prior row's **correct
  settlement condition**, not always `MESSAGE_ACK`.
- A `JOB_CANCEL_REQUEST` must **not** remain blocked forever behind a `JOB_OFFER` that never
  receives a generic ACK: `JOB_OFFER` settles on accept/reject/expiry (bounded by
  `offer_expires_at`), so the cancel behind it is always released in bounded time; a cancel
  of a still-`OFFERED` job may itself settle the pending offer.

---

## 13. PostgreSQL schema

See [control-plane-postgres-schema.md](control-plane-postgres-schema.md) for the full
per-table specification (purpose, PK/FK, workspace ownership, columns, unique constraints,
indexes, deletion, retention, sensitive fields, source of truth) and the type choices
(prefixed-ULID `TEXT`, `timestamptz`, `JSONB` only where justified, check constraints,
partial indexes, optimistic-concurrency `revision` columns). Summary in §30 of this file's
completion report.

---

## 14. Generation-attempt identity

`generation_attempts` is the **primary paid-generation identity** in the cloud (schema doc
§Jobs). It persists: `generationAttemptId, requestIdempotencyKey, parentAttemptId,
retryOfJobId, attemptIndex, generationOrdinal, providerId, providerAccountRef,
providerIdempotencyMode (NONE/NATIVE/DERIVED), providerIdempotencyKeyRef,
providerSubmissionId, submissionState, submissionConfidence, submittedAt,
assignedWorkerId, terminalState, createdAt, updatedAt`. **No provider secrets** — only a
`providerAccountRef` label and an idempotency-key *reference*.

**Identity model (canonical): one `generation_request` → one `generation_attempt` → one
`job`** for the first attempt. A retry or deliberate variant is a **new request** (new
`requestIdempotencyKey`) ⇒ **new attempt** ⇒ **new job**, with `parentAttemptId`/
`retryOfJobId` linking the lineage across requests. There is never more than one attempt per
request, so no identity is reused.

DB constraints (what SQL *can* enforce):
- `PRIMARY KEY (generation_attempt_id)` — no duplicated attempt identity.
- `UNIQUE (workspace_id, request_idempotency_key)` **on `generation_requests` only** (one
  click = one request) — dedupes double-submits within the request window. `jobs` and
  `generation_attempts` are keyed on `generation_attempt_id`; `jobs` does **not** carry a
  competing request-key unique (schema §Jobs / S4).
- **Live-offer uniqueness** is a **partial unique index** on `job_offers`:
  `UNIQUE (generation_attempt_id) WHERE ownership_status NOT IN ('EXPIRED_PRE_SUBMIT',
  'OFFER_REJECTED')` — it excludes **only** the provably-not-submitted outcomes, so a
  settled/paid attempt keeps its slot and can never gain a second live offer (schema §Jobs).
- `CHECK (generation_ordinal <= 1)` — the golden rule as a column constraint; a pure
  backstop that must never abort a normal transaction.
- A terminal attempt cannot reactivate, and cannot change terminal type once set: a
  `BEFORE UPDATE` trigger forbids `terminal_state IS NOT NULL → NULL` **and**
  `terminal_state → a different terminal`, and freezes the submission columns once terminal.

What SQL **cannot** enforce (must be transactional/application-level):
- **"At most one active paid owner across offer + accept + submit."** Ownership spans
  multiple rows (attempt + `job_offers`) and multiple messages over time; it is protected
  by (a) taking a **row lock** on the attempt (`SELECT … FOR UPDATE`) before any state
  transition, (b) transitioning `CREATED→OFFERED→ACCEPTED→…` only under that lock, and
  (c) the re-offer safety rule (§6.2) refusing to create a second offer while
  `possibly_submitted` or a non-terminal owner exists. This is a **transactional
  invariant**, not a constraint.
- **"Uncertain submission never re-offers."** This is a *decision* over the reconciliation
  precedence (§10), not a uniqueness constraint.
- **"generationOrdinal is booked at most once."** The increment is **idempotent**: it fires
  **only** on the `NOT_SUBMITTED → (SUBMITTING|SUBMITTED)` transition
  (`UPDATE … SET generation_ordinal=1, submission_state=… WHERE submission_state='NOT_SUBMITTED'`),
  so a replayed submitted-fact (reconcile after a second reconnect) is a **no-op** and never
  drives the counter to 2. The `CHECK(<=1)` is a backstop only — it must never be the reason
  a reconcile transaction aborts.

---

## 15. Idempotency

Five identities, never merged (protocol §J):

| Identity | Scope | Minted by | Stable across | New one required when |
|---|---|---|---|---|
| `requestIdempotencyKey` | one user action (a click) | web client, once per click | network retries of that click | a **new** user action (e.g. "generate another variant") |
| `generationAttemptId` | one paid generation identity | cloud, per accepted generate request | recovery/reconnect/restart of that attempt | a **retry** or a deliberate new variant |
| `jobId` | one execution of one attempt | cloud, per dispatch | duplicate offers of that job | a **new** attempt (retry ⇒ new job + new attempt) |
| `messageId` | one wire message | sender | resend/replay of that message | a **new** message |
| `providerSubmissionId` | one provider submission (one charge) | Worker, on real submit | recovery (never re-minted) | never re-minted for the same attempt |

### 15.1 API-level idempotency per action

| Action | Idempotency key used | Same key ⇒ | New key ⇒ |
|---|---|---|---|
| Generate click | `requestIdempotencyKey` (`UNIQUE(ws, key)`) | return existing job/attempt | new attempt |
| Retry (post-terminal, user-confirmed) | new `requestIdempotencyKey` + `retryOfJobId`/`parentAttemptId` | — | **new** `generationAttemptId` (paid) |
| Cancellation | `jobId` (+ optional client dedupe key) | idempotent cancel | — |
| Worker pairing | one-time `pairingCode` (consumed once) | rejected (already used) | new code |
| Credential rotation | `rotationId` | idempotent (returns same ROTATING credential state) | new rotation |
| Job offer creation | `generationAttemptId` (+ outbox `messageId`) | reuse existing offer | new offer only per §6.2 |
| Terminal result application | terminal `messageId` (inbox) | replay cached ACK | apply once |
| Asset metadata upsert | `(workspace, project, relative_path)` + `messageId` | upsert (idempotent) | new asset row |

### 15.2 Truth table — when does each ID stay vs change?

| Event | requestKey | attemptId | jobId | messageId | submissionId |
|---|---|---|---|---|---|
| Same click, network retry | same | same | same | **new** (resend uses same) | same/none |
| Duplicate `JOB_OFFER` delivery | same | same | same | same | same/none |
| Reconnect + reconcile | same | same | same | same (replay) | same |
| Worker restart mid-run | same | same | same | same | same |
| User "generate another variant" | **new** | **new** | **new** | **new** | **new** |
| User-confirmed retry after failure | **new** | **new** (`parentAttemptId`=old) | **new** | **new** | **new** |
| Provider actually submitted | same | same | same | (terminal) new | **new (once)** |

---

## 16. Asset metadata & local media

Cloud `assets` mirror (schema doc §Assets) may include: `assetId, workspaceId, projectId,
episodeId, shotId, producingWorkerId, relativePath (identity/reference), checksum,
sizeBytes, mimeType, duration (actualDurationSec), width, height, reviewStatus, selected,
approved, baseRevision, generationAttemptId, availability, previewRef, backupStatus`.

**The cloud MUST NOT store:** Worker absolute path, profile path, provider URL, cookie,
token, proxy, or local filesystem layout (enforced by the same `journal-safety`/redaction
rules that already reject these on the wire).

Availability is modelled as **two independent columns** — a storage **tier** and a
**liveness** — because they are orthogonal (a `BACKED_UP` asset whose Worker is offline is
still cloud-streamable). The UI availability is **computed from both** (§25.1); there is no
single combined enum. Names are reconciled with
[local-first §L](local-first-saas-architecture.md).

| `storage_tier` | Meaning |
|---|---|
| `LOCAL_ONLY` | full media only on the Worker (default) |
| `PREVIEW_AVAILABLE` | opt-in low-res preview mirrored to cloud |
| `BACKED_UP` | opt-in full backup exists in object storage |

| `liveness` | Meaning |
|---|---|
| `ONLINE` | producing Worker online, file present |
| `WORKER_OFFLINE` | producing Worker offline; local bytes temporarily unreachable (a preview/backup may still be viewable) |
| `MISSING` | Worker online but file gone (removable drive/deleted) |
| `CORRUPT` | checksum mismatch |
| `MIGRATION_REQUIRED` | affinity moved; bytes not yet on the new Worker |

Full-media upload is **optional and disabled by default** (`preview_sync_enabled`,
`CLOUD_BACKUP` tiers, §24). The default is `storage_tier=LOCAL_ONLY`: the cloud never claims
to hold bytes it does not have, and a `MISSING`/`WORKER_OFFLINE` asset is surfaced honestly
rather than silently regenerated.

---

## 17. API design

All APIs: authenticated (§4), workspace-authorized (§3), idempotent where they mutate
(§15), payload-limited, and returning **sanitized** errors (no secret/path/value echo).
Worker commands map **only** to allowlisted protocol messages — there is no arbitrary
remote-command surface.

### 17.1 End-user API (HTTPS, human session)
`GET/POST /projects`, `/projects/:id/episodes`, `/episodes/:id/shots`,
`/shots/:id/prompts`; `POST /generation-requests` (idempotency-key header → creates a
`generation_request` + first `generation_attempt`); `GET /attempts/:id`,
`GET /jobs/:id/status`; `POST /shots/:id/review` (approve/select, `REVIEWER+`);
`GET /workers`, `POST /pairing-codes` (`ADMIN+`); `GET/PUT /projects/:id/affinity`
(`ADMIN+`, guarded by §5). Retry is `POST /attempts/:id/retry` (new `requestIdempotencyKey`,
explicit quota confirmation → new paid attempt).

### 17.2 Worker API
`POST /worker/pair` (one-time code → credential, Step 5B); `POST /worker/credential/rotate`
(authenticated, `rotationId`); `GET /worker/credential/status`; **WSS**
`wss://<worker-gateway-host>/ws/worker` (all job lifecycle — environment-neutral host, see
protocol §1); `POST /worker/preview-upload` (opt-in). Every WSS-borne command from the cloud
is one of the `CLOUD_TO_WORKER` allowlisted types — never a shell/command/path.

**Preview upload — server-derived keys (C14).** `POST /worker/preview-upload` looks up the
asset, enforces `asset.workspace_id = derivedWorkspace AND asset.producing_worker_id =
derivedWorker`, and **derives** the object key server-side as
`{workspace_id}/{project_id}/{asset_id}/{kind}`. The presigned URL is **single-object,
method-limited (`PUT` only), content-length-capped, short-TTL**. A worker-supplied
`assetId`/`object_key` is validated inside the scoped lookup and **never** signed directly.

### 17.3 Admin/internal API (platform-operator only)
`GET /healthz`, `/readyz`, `/metrics`; `GET /admin/audit` (investigation, scoped);
`GET/PUT /admin/feature-flags`; `POST /admin/reconcile/:jobId` (operator-initiated
reconciliation — an *allowlisted* action, not a raw command); allowlisted dead-letter
recovery actions (deployment §DC6). **All `/admin/*` endpoints, and any write to a
non-tenant table (`feature_flags`, global `rate_limit_buckets`), require the platform-
operator identity (§4 domain D), MFA-gated and audited — a workspace `ADMIN` cannot invoke
them** (it may only read its own workspace's flag state). No endpoint accepts a free-form
command, path, or provider secret.

---

## 18. WSS Gateway

Production Worker WSS endpoint — environment-neutral `wss://<worker-gateway-host>/ws/worker`
(local/staging/production hosts in protocol §1; no hostname is provisioned here):

- **TLS termination** at the edge/reverse proxy; **reject non-TLS**. The proxy forwards the
  `Authorization` header (credential) to the Gateway; the proxy must **not** log it.
- **Connection limits** per workspace + global; **`maxPayload` = 2 MiB** (matches Step 5B
  hardening; reconcile batches ≤1 MB, normal ≤256 KB).
- **Timers:** heartbeat 20s; degraded 45s; offline 90s; **auth timeout** (drop if no valid
  credential quickly); **HELLO timeout** (drop if no `WORKER_HELLO` after connect);
  **idle timeout** (no frames + no heartbeat).
- **One active connection per Worker:** a new authenticated connection **supersedes** the
  old (old `worker_connection_sessions` row → `SUPERSEDED`, old socket terminated). This
  prevents two live sockets racing the same Worker's outbox.
- **Backpressure:** bounded per-connection send buffer; if a Worker cannot keep up, slow
  outbox draining (never drop durable messages — they stay `SENT`/`PENDING` in the DB).
- **Graceful shutdown / rolling deploy:** on `SIGTERM`, stop accepting new connections,
  send `WORKER_GOODBYE`-triggering close, let Workers reconnect to another instance; the
  outbox is untouched so no message is lost. Workers reconnect with backoff (1,2,5,10,30s
  + jitter) and reconcile.
- **Origin / proxy trust:** trust only the configured reverse proxy's forwarded headers;
  validate `Origin`/`Host` for the worker route. **IP metadata** is stored coarsely
  (audit) and never used as an auth factor; logs are redacted.

### 18.1 Sticky sessions — not required for correctness
A live WSS socket is inherently pinned to one Gateway instance for its lifetime (that is
TCP, not cookie-stickiness). **Correctness does not depend on it:** all durable work is in
the DB (inbox/outbox), and `worker_connection_sessions` is advisory. If the instance dies,
the Worker reconnects (to any instance), re-authenticates, and the new owner drains the
outbox and reconciles. So the load balancer needs only normal per-connection affinity
(keep a live TCP connection on its instance) — **no** sticky-by-user routing, **no**
shared in-memory session store. **Prefer the database-backed/outbox architecture over any
in-memory connection state for correctness.** (Decision D5.)

---

## 19. Control-Plane restarts

| Concern | Classification | Behavior on restart |
|---|---|---|
| Business state (users, workspaces, projects, jobs, attempts, offers, assets) | **durable (PG)** | reloaded from PG; unaffected |
| Inbox/outbox/message-acks | **durable (PG)** | pending outbox resent; inbox dedupe intact; no double terminal apply |
| Live WSS sockets | **connection-local** | dropped; Workers reconnect + reconcile |
| `worker_connection_sessions` (who holds the socket) | **advisory** | rebuilt as Workers reconnect; stale rows expire |
| In-flight send buffers | **advisory / reconstructable** | reconstructed from `protocol_outbox` (PENDING/SENT) |
| Scheduler placement hints, heartbeat freshness | **advisory** | recomputed from heartbeats/backpressure |

**Rule:** anything required to preserve the golden rule or exactly-once terminals is in
PostgreSQL; everything connection-local is reconstructable from the DB + Worker reconcile.
API, Gateway, and Processor may restart, PostgreSQL may briefly fail (requests 503/retry;
Workers buffer locally and reconcile), and a connection may move to another Gateway
instance — **correctness survives process memory loss** because no safety fact lives only
in RAM.

---

## 20. Failure & disaster recovery

Full detail in [control-plane-deployment-plan.md](control-plane-deployment-plan.md) §DR.
Summary of what can/cannot be recovered:

| Scenario | Recoverable? | Note |
|---|---|---|
| DB backup / PITR | ✅ | nightly base + WAL archiving; restore to a point in time |
| Migration rollback | ✅ | expand/contract migrations; every step reversible (deployment plan) |
| Corrupted outbox row | ✅ | row → `DEAD` (dead-letter) + operator diagnostic; never blocks others |
| Partial job transaction | ✅ | inbox/business/ack are one txn — either all or none |
| Lost/revoked Worker | ✅ metadata | credential revoked; re-pair = new `workerId`; **local media may be unreachable** |
| Lost credential pepper | ⚠️ | all verifiers invalid → **all Workers must re-pair**; pepper is a top-tier secret (deployment plan) |
| Credential compromise | ✅ | revoke → `WORKER_REVOKED` → Worker wipes local credential |
| Stale project affinity | ✅ | explicit reconciled migration (§5.1) |
| Permanently offline Worker with `LOCAL_ONLY` media | ❌ bytes | **cloud cannot recover bytes it never held** — this is the documented cost of media-local default; mitigated only by opt-in `PREVIEW_AVAILABLE`/`BACKED_UP` |
| Control-plane region/VPS outage | ✅ (with standby) | Workers keep local media + journal; on cloud return they reconcile; **no second generation** |

**Central honesty:** with `LOCAL_ONLY`, full media exists only on the Worker. The cloud can
always recover *coordination* and *metadata*, and never double-charges, but it **cannot**
resurrect bytes that were never uploaded. Opt-in preview/backup is the only mitigation.

---

## 21. Security

Threat model → defenses (layered; each threat is blocked by ≥1 named layer):

| Threat | Primary defense(s) |
|---|---|
| Cross-tenant access | workspace scoping (§3.2) + RLS (§3.3) + derived Worker identity |
| Forged Worker identity | credential verifier (HMAC), identity **derived** from credential, `E_IDENTITY_MISMATCH` on any mismatch |
| Stolen Worker credential | revoke → `WORKER_REVOKED`; credential never in payload/URL/args/logs; rotation |
| Replayed protocol message | **durable `messageId` dedupe (inbox key + tombstone)** is the correctness defense; the `sentAt` ±120s window is only a coarse freshness heuristic for *new* messages and is **not** a durable replay-security key (§11.2) |
| Job injection / arbitrary command | **allowlisted actions only**; input = ids + enums; Worker resolves paths |
| Path traversal | ids validated (`job_<ULID>`); relative-ref only; no absolute paths persisted |
| Provider-secret leakage | provider profiles/cookies/tokens **stay Worker-local**; cloud stores metadata labels only |
| Malicious / oversized / deeply-nested / prototype-pollution payload | strict schema, size limits (256 KB/1 MB), depth limit, `__proto__`/`constructor` rejection (shipped `journal-safety` rules) |
| Audit-log leakage | audit rows sanitized (no credential/cookie/token/URL/absolute path) |
| SQL injection | parameterized queries only; no string-built SQL |
| Privilege escalation / stale session | role checks per request against the **target resource's** workspace (§3.2); short session TTL; disable-user cascades; least-privilege DB roles — business traffic runs as `cp_tenant_app` (`NOBYPASSRLS`); only `cp_ops_enumerator` has `BYPASSRLS`, with grants limited to protocol/sweep tables and never applying business state (§3.3.1) |
| Compromised workspace-admin / operator account | platform-operator identity is separate from workspace `ADMIN` and MFA-gated (§4/§17.3); all admin actions audited; neither can read provider secrets (they are not in the cloud) |

Encrypted transport (WSS/HTTPS), credential hashing/HMAC with a peppered secret, secret
management (deployment plan), DB least privilege, rate limiting (pairing/rotation/API), and
safe structured logs round out the defenses.

---

## 22. Observability

**Metrics** (sanitized, no secrets/paths/URLs): connected Workers; Worker reconnect rate;
heartbeat lag; job-offer latency; queue-to-start time; running attempts;
**possibly-submitted attempts** (the safety gauge); reconciliation backlog; inbox/outbox
depth; outbox retry count; ACK latency; failed auth; identity mismatches; DB latency; asset
-metadata sync lag.

**Structured logs**: JSON, sanitized to `journal-safety` rules.

**Traces** connect `requestIdempotencyKey → generationAttemptId → jobId → messageId →
workerId` **without** secrets — the safety-critical causal chain is always reconstructable
from telemetry.

**Alerts** (deployment plan §Observability): `possibly_submitted` backlog rising; outbox
`DEAD` rows > 0; reconciliation backlog stalled; identity-mismatch spike; auth-failure
spike; DB latency/error budget; Worker mass-disconnect.

---

## 23. Retention

Full per-table retention in the schema doc §Retention. Governing rule:

> **Never delete a record required to prove paid-generation ownership while its attempt
> remains unresolved.** `generation_attempts`, `job_offers`, `protocol_inbox`/`outbox`
> rows, and terminal `job_events` for an attempt are retained until the attempt is
> **settled** (terminal + acked) and past a diagnostic window — mirroring the Worker
> journal's rule that `sweep()` never removes an in-flight/submitted record
> (recovery-contract §10).

Archive (cold) then delete: protocol inbox/outbox (after settle + window), ACK cache
(after settle), job events (after archive), audit (long retention, then archive),
Worker-status history (rolling window), pairing records (short), revoked credentials (kept
for audit), previews (per tier). Media is **never** auto-deleted by the cloud.

---

## 24. Feature flags & rollout (summary)

Flags (deployment plan §Flags): `control_plane_enabled`, `worker_execution_enabled`,
`project_worker_affinity_enabled`, `real_grok_worker_enabled`, `preview_sync_enabled`,
`scheduler_enabled`. Each supports **global off**, **workspace/user/project allowlists**, and
kill controls. **Default production behavior is legacy.** The consolidated flag rules:

- **Dependency lattice.** `real_grok_worker_enabled ⊂ worker_execution_enabled ⊂
  control_plane_enabled` (affinity/scheduler likewise). A flag whose prerequisite is off
  evaluates **off**, and an admin write enabling a flag with an unmet prerequisite is
  **rejected**.
- **Two kill levels.** A **global per-flag kill switch** *and* a **per-workspace/per-project
  kill list**, both evaluated **before** the allowlists — so one misbehaving tenant is
  stopped without collapsing the whole rollout.
- **Uncached paid path.** The flag/kill evaluation on the generate/offer (paid) decision is
  **uncached (TTL=0)**; only non-spending reads may cache briefly.
- **One-shot real-generation approval.** Phase 4's "one real Grok generation" is gated by a
  consumed **approval token** (`max_paid_generations` grant, decremented at the dispatch
  decision), **not** the boolean flag alone.
- **Rollback stops new dispatch only.** A flag-off/kill never halts in-flight
  `RUNNING`/`SUBMITTING` paid work; the **reconciliation path is never gated off by a flag**,
  and each phase's rollback includes an explicit **drain-and-reconcile** step (deployment
  §6/§7).

Rollout is phased 0→6 with per-phase rollback (deployment plan §Rollout).

---

## 25. UI simplicity contract

The backend is complex; the **normal-user UI stays simple.** Normal users see only:
Projects · Studio pipeline · AI Accounts · Export · simple progress · simple errors ·
"Add/Connect Worker" only when required. They **never** see (by default): protocol
messages, ACKs, scheduler internals, journal/lease/reconciliation/ownership internals,
capability matrices, or raw logs. Those live behind **Admin mode / Developer mode / Support
diagnostics**.

### 25.1 State projection (two independent axes)

The UI shows **two orthogonal things**, never one conflated status: a **progress status**
and a separate **media-availability badge**. "Worker offline" is a *badge*, never a progress
status, and it **never** suppresses `Ready` or an action the user must take.

**Axis 1 — progress status** (projected from cloud coordination §6):

| Progress status | Projected from |
|---|---|
| **Waiting** | `CREATED`, `OFFER_PENDING`, `OFFERED`, `ACCEPTED` |
| **Generating** | `RUNNING`, `SUBMITTING`, `SUBMITTED`, `RESULT_AVAILABLE`, `IMPORTED`, `TERMINAL_PENDING_ACK`; also transient Worker silence, shown as *"Generating (reconnecting)"* (debounced — see below) |
| **Action needed** *(user-resolvable, with a concrete instruction)* | `MANUAL_ACTION_REQUIRED` (e.g. "re-login your provider in the Worker window", "plug in the drive") |
| **We're checking** *(operator/system-owned, no user call-to-action)* | `POSSIBLY_SUBMITTED`, `RECOVERING`, corrupt/unknown |
| **Ready** | `COMPLETED` |
| **Failed** | `FAILED`, `EXPIRED_PRE_SUBMIT`; offers a **Retry** |
| **Canceled** | a clean user cancel (`CANCELED` with no paid-risk) |

**Axis 2 — media-availability badge** (computed from `storage_tier` ⊕ `liveness`, §16):
`online` · `worker-offline` · `missing` · `preview` · `backed-up`. A `backed-up`/`preview`
asset stays viewable even while its Worker shows `worker-offline`.

**Debounce.** A `possibly_submitted` set on *transient* Worker silence is shown as
"Generating (reconnecting)" (+ the offline badge), **not** "We're checking", until
reconciliation actually returns a manual outcome — so a network blip does not flap the
user's view. A clean cancel is "Canceled", never "Failed".

The projection is one-way and lossy by design: the UI shows intent, outcome, and where the
bytes are — not the ownership/lease/submission machinery that guarantees safety.

---

## 26. Staging implementation plan

Phased build (5C.1–5C.10) in [control-plane-deployment-plan.md](control-plane-deployment-plan.md)
§Staging, each with scope, dependencies, tests, rollback, acceptance criteria, and likely
files/services.

---

## 27. Decision log

| # | Decision | Chosen | Alternatives | Reason | Risks | Revisit trigger |
|---|---|---|---|---|---|---|
| D1 | Deployment model | **Modular monolith** (API+Gateway+Processor as modules, split-ready at the DB seam) | microservices from day 1; single tangled service | safest MVP; real isolation without distributed-systems tax; outbox seam makes the split additive | monolith could grow coupling if seams ignored | Gateway CPU/connection scaling forces a separate process |
| D2 | Database isolation | **Separate DB + role + secrets + volume** from AVCHub | shared DB, separate schema | failure/secret/backup/rollback isolation is a hard requirement | two DBs to operate | never share with AVCHub |
| D3 | ID storage | **Prefixed-ULID `TEXT`** (`job_<ULID>`) | `uuid`/`bytea` | zero wire↔DB translation; human-readable logs; prefix encodes type; matches shipped `ids.mjs` + local-first §H | 26+char TEXT keys (acceptable) | measured index bloat at very large scale |
| D4 | Row-Level Security | **Service scoping primary + RLS defense-in-depth, on from day 1** | RLS only; scoping only; RLS later | cheapest cross-tenant backstop; retrofitting RLS after data is riskier | GUC-not-set foot-gun (mitigated: fail-closed default) | RLS proves too costly under load |
| D5 | Worker connection ownership | **DB-backed outbox; one active socket; advisory session; no sticky sessions** | in-memory session store; sticky LB | correctness independent of which instance holds the socket; survives restart | outbox latency vs direct send (acceptable) | need sub-ms push at scale |
| D6 | Generation ownership | **Cloud coordination state distinct from Worker state; `POSSIBLY_SUBMITTED` fail-safe bucket** | mirror Worker states into cloud | prevents cross-tier double-ownership; conservative-wins | more states to maintain | — |
| D7 | Project affinity | **One project → one Worker; offline ≠ reassign; explicit reconciled migration** | auto-failover to another Worker | media is Worker-local; auto-failover would lose bytes / risk double media | manual migration friction | multi-worker-per-project (post-MVP) |
| D8 | `expiresAt` semantics | **Split `offer_expires_at` (pre-accept, re-offer-safe) vs `execution_deadline_at` (post-accept, not submission-safe)** | single `expiresAt` | expiry must never imply "not submitted" | two timers to reason about | — |
| D9 | Cross-tier precedence | **Conservative-wins; Worker journal authoritative for submission/media; cloud for collaborative metadata** | cloud-wins; last-writer-wins | the state implying a paid generation dominates | requires disciplined reconciliation code | — |
| D10 | Inbox/outbox | **Transactional inbox (dedupe+exactly-once) + outbox (resend, same messageId)** | direct send; at-least-once without dedupe | exactly-once terminals; restart-safe | extra tables/latency | — |
| D11 | ACK persistence | **`protocol_message_acks` durable ledger; ACCEPTED-only settles** | in-memory ack cache (shipped local dev) | survives DB restart; duplicate-ACK replay | storage/retention | — |
| D12 | Media locality | **`LOCAL_ONLY` default; preview/backup opt-in** | cloud-stores-all | privacy, cost, matches product; honest availability states | offline Worker ⇒ unreachable bytes (documented) | user opts into backup |
| D13 | Feature flags | **Multi-scope flags; legacy default; kill switch** | env-only toggle | safe staged rollout, instant rollback | flag sprawl | — |
| D14 | Staging hostnames | **`studio-/control-/worker-staging.example.com`** (design only) | reuse prod hostnames | isolation; no legacy impact | DNS/cert setup later | — |
| D15 | Secrets management | **Separate secret store; DB creds, credential pepper, service tokens; no provider secrets in cloud** | env files in repo | least privilege; provider secrets never leave Worker | secret-store ops | — |
| D16 | Identity domains | **Four separate domains incl. a platform-operator distinct from workspace `ADMIN`** (§4) | reuse workspace `ADMIN` for `/admin/*` | a tenant admin could flip global flags/kill switch | one more identity to manage | — |
| D17 | Outbox settlement | **`settlement_mode` per row: `MESSAGE_ACK` / `LIFECYCLE_RESPONSE` / `SEND_ONLY`** (§12.1) | "every message needs a `MESSAGE_ACK`" | a cancel must not wedge behind a `JOB_OFFER` that gets no generic ACK; `SEND_ONLY` banned for critical messages | per-type settlement table to maintain | — |
| D18 | DB role model | **`cp_migrator` / `cp_tenant_app` (`NOBYPASSRLS`) / `cp_ops_enumerator` (`BYPASSRLS`, minimal grants) / optional `cp_readonly_observer`** (§3.3.1) | one app role with "BYPASSRLS scoped to tables" (does not exist) | fail-closed RLS would stall cross-workspace ops; containment via grants + pools, not table-scoped bypass | more roles/pools | — |

---

*End of architecture. Schema → [control-plane-postgres-schema.md](control-plane-postgres-schema.md);
deployment/DR/rollout → [control-plane-deployment-plan.md](control-plane-deployment-plan.md);
review + Go/No-Go → [control-plane-review.md](control-plane-review.md).*
