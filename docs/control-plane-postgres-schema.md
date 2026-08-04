# P0 Step 5C — Control Plane PostgreSQL Schema (design)

**Status: design only.** No migrations, no DDL execution, no deployment. This specifies the
future production schema so implementation (Step 5C.2) has an approved target. It refines
and extends the sketch in [local-first-saas-architecture.md §H](local-first-saas-architecture.md)
and aligns with [control-plane-architecture.md](control-plane-architecture.md),
[protocol-v1.md](protocol-v1.md), and [recovery-contract.md](recovery-contract.md).

## 0. Consolidation status & correction traceability (Step 5C.0)

The accepted schema corrections have been **merged into the table definitions, constraints,
indexes, deletion rules, RLS/role notes, triggers, and the retention + constraint-summary
tables below**. The DDL below is self-sufficient — a reader does **not** need this section to
build the schema. This table is a **non-normative traceability index** only; see
[control-plane-review.md](control-plane-review.md) for the historical findings.

| Correction | Topic | Now specified in | Review finding |
|---|---|---|---|
| S1 | No cascade-delete of ownership rows (`RESTRICT` + `BEFORE DELETE` trigger) | Conventions (deletion); §Jobs; §Retention | F1 |
| S2 | `ownership_status` CHECK enum on both tables | `generation_attempts`, `job_offers` | F12 |
| S3 | One live offer per attempt (excludes only provably-not-submitted) | `job_offers`; constraint-summary | F11 |
| S4 | One request → one attempt → one job; request-key unique only on `generation_requests` | `generation_requests`, `generation_attempts`, `jobs` | F13 |
| S5 / D18 | Ops-table role model (`cp_ops_enumerator`, minimal grants, separate pool) | Conventions (RLS+roles); `protocol_outbox` | F8 |
| S6 | All id columns `TEXT COLLATE "C"` | Conventions (IDs) | F29 |
| S7 | Cross-column CHECKs on `generation_attempts` | `generation_attempts` | F26 |
| S8 | Navigable safety-gauge index covering confirmed risk | `generation_attempts` | F33 |
| S9 | Inbox/acks carry attempt/job ref + dedupe tombstone | `protocol_inbox`, `protocol_message_acks` | F24, F25 |
| S10 | Assets: partial-unique-on-live-path; attempt `RESTRICT`; workspace-safe lineage | `assets`, `generation_attempts` | F27, F23 |
| S11 / C15 | `storage_tier` + `liveness` (no combined enum) | `assets`, `asset_locality` | F16, F27 |
| S12 | `generation_requests` dedupe outlives resend horizon | `generation_requests`; §Retention | F28 |
| S13 | Terminal trigger freezes terminal + submission | `generation_attempts` | F32 |
| S14 | Normalized `feature_flag_targets` | `feature_flags` | F34 |
| S15 | Revision-increment trigger; supersede is one txn | Conventions; `worker_connection_sessions` | F35 |

---

## Conventions & type choices

- **IDs — prefixed-ULID `TEXT COLLATE "C"`** (`job_<26-char Crockford ULID>`), matching the
  shipped `lib/protocol/ids.mjs` and the wire. Every id column (PK **and** FK) is
  `TEXT COLLATE "C"` — deterministic, faster comparisons, preserves ULID time-order, and
  immune to the libc/ICU collation-change `REINDEX` hazard. `CHECK (id ~
  '^job_[0-9A-HJKMNP-TV-Z]{26}$')` per table (prefix + Crockford alphabet, no I/L/O/U).
  Rationale: zero wire↔DB translation, human-readable logs, type-encoding prefix. New
  prefixes introduced by this design:
  `req_` (request), `attempt_` (generation attempt — matches shipped `attempt` prefix),
  `submission_`, `mship_` (membership), `aff_` (affinity), `off_` (job offer), `evt_`
  (event), `ob_`/`ib_` (outbox/inbox), `ack_`, `sess_` (connection session), `flag_`,
  `idem_`, `rl_`, `cred_`, `pcode_`, `preview_`.
- **Timestamps — `timestamptz`** everywhere (UTC), default `now()`.
- **`JSONB`** only where the shape is genuinely open (message payloads, capabilities,
  job input/result snapshots, audit metadata) — never as a dumping ground for columns that
  deserve constraints/indexes.
- **Money/quota counters** — `integer`/`bigint`, never float.
- **Tenancy** — every business table carries `workspace_id TEXT NOT NULL REFERENCES
  workspaces(id)` (except `users`, `workspaces`, and global ops tables). FKs to
  `workspaces` default `ON DELETE RESTRICT`.
- **Optimistic concurrency** — mutable collaborative rows carry `revision INTEGER NOT NULL
  DEFAULT 0`; updates use `WHERE revision = $expected` and bump it (409 on mismatch). A
  `BEFORE UPDATE` trigger asserts `NEW.revision = OLD.revision + 1` so a writer that omits
  the guard cannot silently last-writer-win. (`project_worker_affinity` uses a `generation`
  column for the same purpose — an intentional distinct name to avoid clashing with the
  collaborative `revision`.)
- **Deletion of ownership rows — RESTRICT, never CASCADE.** `deleted_at TIMESTAMPTZ NULL`
  gives soft delete where history matters. **Ownership/paid-generation tables**
  (`generation_requests`, `generation_attempts`, `jobs`, `job_offers`,
  `job_terminal_results`, `assets`) are **`ON DELETE RESTRICT`** under `projects` — they are
  **never** `CASCADE`-deleted. A `BEFORE DELETE` trigger on `projects` raises if any
  descendant attempt has `terminal_state IS NULL OR possibly_submitted`. A hard project/
  workspace delete (incl. GDPR "delete workspace") is allowed only after every attempt is
  settled + past the retention window; otherwise attempts are **archived to a cold table**,
  never dropped (so paid-generation ownership proof is never destroyed — §Retention).
  Non-ownership children of a project (episodes, shots, prompts) may `CASCADE`.
- **RLS + database roles.** Every tenant table gets a policy `USING (workspace_id =
  current_setting('app.current_workspace', true))` with a **fail-closed** default (unset →
  no rows). Business traffic runs as `cp_tenant_app` (**`NOBYPASSRLS`**). Service scoping
  remains primary (arch §3.3). Cross-workspace ops enumeration (global outbox drain, offer/
  lease/deadline sweeps, inbox lookup before the workspace is known) runs under a **separate
  `cp_ops_enumerator` role** — see the role model in [architecture §3.3.1](control-plane-architecture.md).
  **`BYPASSRLS` is a role attribute, not a table-scoped privilege**; the enumerator is
  contained by **minimal `GRANT`s** (only the `protocol_*` and sweep tables/columns) and a
  **separate connection pool** that never applies business state — not by "BYPASSRLS scoped
  to tables" (no such thing). Migrations run as `cp_migrator`.
- **Partial indexes** for hot "open work" predicates (e.g. non-terminal jobs, pending
  outbox) to keep them small.

Each table below lists: **purpose · PK · FKs · workspace ownership · key columns · unique
constraints · indexes · deletion · retention · sensitive fields · source of truth.**

---

## Identity & tenancy

### `users`
- **Purpose** human accounts. **PK** `id` (`usr_`). **Workspace** none (global).
- **Columns** `email CITEXT NN`, `password_hash TEXT NULL` (argon2id; NULL if external
  auth), `external_auth_id TEXT NULL`, `status TEXT NN CHECK (status IN
  ('ACTIVE','DISABLED','PENDING')) DEFAULT 'PENDING'`, `email_verified_at`,
  `created_at/updated_at`, `disabled_at`.
- **Unique** `UQ(email)`, `UQ(external_auth_id)`. **Indexes** those uniques.
- **Deletion** soft (`status='DISABLED'`); hard delete restricted. **Retention** lifetime.
- **Sensitive** `password_hash`, `external_auth_id` (never logged). **SoT** Cloud.

### `workspaces`
- **Purpose** tenant boundary. **PK** `id` (`ws_`). **FK** `owner_user_id → users`.
- **Columns** `name NN`, `plan TEXT NN DEFAULT 'FREE'`, `created_at/updated_at`,
  `deleted_at`. **Index** `idx(owner_user_id)`. **Deletion** soft. **SoT** Cloud.

### `workspace_members`
- **Purpose** membership + role. **PK** `id` (`mship_`) (or composite
  `PK(workspace_id,user_id)`). **FKs** `workspace_id`, `user_id`.
- **Columns** `role TEXT NN CHECK (role IN
  ('OWNER','ADMIN','EDITOR','REVIEWER','VIEWER','BILLING_OWNER'))`, `created_at`.
- **Unique** `UQ(workspace_id, user_id)`. **Index** `idx(user_id)`. **SoT** Cloud.
- **Note** one `OWNER` per workspace enforced transactionally (not a simple constraint).

### `external_auth_identities` (optional, if OIDC)
- **Purpose** map an external IdP subject → `user_id`. **PK** `id`. **FK** `user_id`.
- **Columns** `provider TEXT NN`, `subject TEXT NN`, `created_at`.
- **Unique** `UQ(provider, subject)`. **Sensitive** `subject`. **SoT** external IdP (mirror).

### `user_sessions` (if not fully external)
- **Purpose** server-side session handles. **PK** `id` (`sess_`). **FK** `user_id`.
- **Columns** `token_hash TEXT NN` (never plaintext), `expires_at NN`, `created_at`,
  `revoked_at`, `ip_address INET`, `user_agent TEXT`.
- **Index** `idx(user_id)`, `idx(expires_at)`. **Retention** delete past expiry + window.
- **Sensitive** `token_hash`. **SoT** Cloud. (Never a Worker credential — arch §4.)

---

## Projects

### `projects`
- **Purpose** project root. **PK** `id` (`prj_`). **FKs** `workspace_id`,
  `created_by_user_id → users`, `home_worker_id → workers NULL` (mirror of active affinity).
- **Columns** `title NN`, `locale`, `market`, `status TEXT NN DEFAULT 'DRAFT'`,
  `storage_relative_root NN`, `revision INTEGER NN DEFAULT 0` (optimistic concurrency /
  `cloudRevision`), `created_at/updated_at`, `archived_at`.
- **Index** `idx(workspace_id, status)`, `idx(home_worker_id)`. **Deletion** soft.
- **SoT** Cloud (collaborative metadata); media bytes → Worker.

### `episodes`
- **PK** `id` (`ep_`). **FKs** `workspace_id`, `project_id`.
- **Columns** `episode_number INT NN`, `title`, `status NN`, `revision`, `created_at/updated_at`.
- **Unique** `UQ(project_id, episode_number)`. **Index** `idx(workspace_id)`.
- **Deletion** cascade under project. **SoT** Cloud.

### `shots`
- **PK** `id` (`sh_`). **FKs** `workspace_id`, `project_id`, `episode_id`.
- **Columns** `shot_number INT NN`, `image_prompt TEXT`, `video_prompt TEXT`,
  `selected_image_asset_id TEXT NULL`, `selected_video_asset_id TEXT NULL`, `status NN`,
  `revision`, `created_at/updated_at`.
- **Unique** `UQ(episode_id, shot_number)`. **Index** `idx(workspace_id, project_id)`.
- **Note** `selected_*` are weak refs (no cascade — preserve history). **SoT** Cloud
  (prompts/selection); asset facts → Worker.

### `prompts`
- **Purpose** normalized prompt history (if not inlined on shots). **PK** `id`. **FKs**
  `workspace_id`, `shot_id`.
- **Columns** `kind TEXT CHECK (kind IN ('IMAGE','VIDEO'))`, `text TEXT NN`, `revision`,
  `created_by_user_id`, `created_at`. **Index** `idx(shot_id, kind)`. **SoT** Cloud.

### `project_revisions`
- **Purpose** append-only revision log for optimistic concurrency + audit of collaborative
  edits. **PK** `id`. **FKs** `workspace_id`, `project_id`, `changed_by_user_id`.
- **Columns** `revision INT NN`, `summary`, `diff JSONB`, `created_at`.
- **Unique** `UQ(project_id, revision)`. **Deletion** append-only; archive old. **SoT** Cloud.

### `project_worker_affinity`  *(arch §5)*
- **Purpose** the one-project→one-Worker assignment (durable, versioned, auditable).
- **PK** `id` (`aff_`). **FKs** `workspace_id`, `project_id`, `worker_id`, `assigned_by →
  users`.
- **Columns** `assigned_at NN`, `status TEXT NN CHECK (status IN
  ('ACTIVE','RELEASING','RELEASED','IRRECOVERABLE')) DEFAULT 'ACTIVE'`, `generation INT NN
  DEFAULT 0` (optimistic concurrency for reassignment), `last_confirmed_at`, `released_at`,
  `release_reason`, `created_at`.
- **Unique** **partial** `UQ(project_id) WHERE status = 'ACTIVE'` — **at most one ACTIVE
  Worker per project** (a real SQL guarantee). Also `idx(worker_id, status)`.
- **Deletion** never hard-deleted (history); superseded rows go `RELEASED`.
- **SoT** Cloud (assignment); media locality → Worker.

---

## Workers

### `workers`
- **PK** `id` (`wrk_`). **FK** `workspace_id`.
- **Columns** `name NN`, `platform NN`, `os_version`, `architecture`, `worker_version`,
  `protocol_version INT NN`, `status TEXT NN CHECK (status IN
  ('ONLINE','OFFLINE','DEGRADED','REVOKED')) DEFAULT 'OFFLINE'`, `installation_id TEXT`
  (opaque, not a fingerprint, not an auth factor), `last_seen_at`, `paired_at`,
  `revoked_at`, `created_at/updated_at`.
- **Index** `idx(workspace_id, status)`. **Deletion** soft (`REVOKED` kept for audit).
- **SoT** Cloud (identity/status); storage/session facts → Worker.

### `worker_credentials`
- **Purpose** credential verifiers (Step 5B). **PK** `id` (`cred_`). **FK** `worker_id`.
- **Columns** `credential_hash TEXT NN` (HMAC-SHA256 w/ server pepper, or argon2id),
  `status TEXT NN CHECK (status IN ('PENDING','ACTIVE','ROTATING','REVOKED','EXPIRED'))`,
  `issued_at NN`, `expires_at NN`, `rotated_at`, `revoked_at`, `last_used_at`,
  `rotation_id TEXT NULL`.
- **Unique** partial `UQ(worker_id) WHERE status='ACTIVE'` (one active credential/worker).
  **Index** `idx(worker_id)`, `idx(expires_at)`.
- **Deletion** revoked kept for audit; expired swept after window.
- **Sensitive** `credential_hash` (never plaintext, never logged). **SoT** Cloud (verifier);
  plaintext credential → Worker only. **Pepper is NOT in this table** (secret store).

### `worker_capabilities`
- **Purpose** per-worker capability + provider-duration matrix (normalized from
  `WORKER_HELLO`). **PK** `id`. **FK** `worker_id`, `workspace_id`.
- **Columns** `capability TEXT NN` (e.g. `grok.video`), `provider_durations JSONB`,
  `updated_at`. **Unique** `UQ(worker_id, capability)`. **SoT** Worker (advertised), Cloud
  mirrors.

### `worker_storage_status`
- **Purpose** latest storage snapshot. **PK** `worker_id` (1:1) or `id`. **FK** `worker_id`.
- **Columns** `root_label TEXT`, `free_bytes BIGINT`, `total_bytes BIGINT`, `health TEXT`,
  `reported_at`. **SoT** Worker (mirror). **No absolute paths** — label only.

### `worker_connection_sessions`  *(arch §11/§18/§19 — advisory)*
- **Purpose** which Gateway instance currently holds the socket; resume-token binding.
- **PK** `id` (`sess_`). **FKs** `worker_id`, `workspace_id`.
- **Columns** `gateway_instance TEXT`, `session_id TEXT`, `resume_token_hash TEXT`
  (hash only), `status TEXT NN CHECK (status IN ('ACTIVE','SUPERSEDED','CLOSED'))`,
  `connected_at`, `last_seen_at`, `closed_at`.
- **Unique** partial `UQ(worker_id) WHERE status='ACTIVE'` (one active session/worker).
  **Index** `idx(worker_id, status)`, `idx(last_seen_at)`.
- **Supersede (S15)** is a **single transaction**: lock the worker's session rows,
  `UPDATE old → SUPERSEDED`, then `INSERT new ACTIVE` — otherwise the partial unique would
  *block* the new connection instead of superseding the old one.
- **Deletion** sweep `CLOSED/SUPERSEDED` past window. **Advisory only** — never gates
  correctness. **Sensitive** `resume_token_hash`. **SoT** Cloud (connection).

### `worker_status_history`
- **Purpose** append-only online/offline/degraded transitions. **PK** `id`. **FKs**
  `worker_id`, `workspace_id`. **Columns** `status`, `reason`, `at`. **Index**
  `idx(worker_id, at)`. **Retention** rolling window (e.g. 90 days) then archive.

### `pairing_codes`
- **Purpose** one-time pairing (Step 5B). **PK** `id` (`pcode_`). **FKs** `workspace_id`,
  `created_by_user_id`, `used_by_worker_id NULL`.
- **Columns** `code_hash TEXT NN` (HMAC w/ pairing pepper — **never** plaintext),
  `expires_at NN`, `used_at NULL`, `attempts INT NN DEFAULT 0`, `created_at`.
- **Index** `idx(workspace_id)`, `idx(expires_at)`. **Deletion** sweep expired.
- **Sensitive** `code_hash`. **SoT** Cloud.

---

## Jobs & attempts

### `generation_requests`
- **Purpose** the user-intent envelope (a click). **Canonical identity model: one
  `generation_request` → one `generation_attempt` → one `job`.** A retry/variant is a **new
  request** (new key) ⇒ a new attempt ⇒ a new job; lineage is linked by
  `parent_attempt_id`/`retry_of_job_id` across requests, **not** by multiple attempts under
  one request. **PK** `id` (`req_`). **FKs** `workspace_id`, `project_id`, `shot_id`,
  `created_by_user_id`.
- **Columns** `action TEXT NN` (allowlist), `request_idempotency_key TEXT NN`, `input_snapshot
  JSONB NN` (immutable business input at click time incl. `baseRevision`,`promptSnapshot`),
  `quota_risk BOOL NN DEFAULT false`, `created_at`.
- **Unique** `UQ(workspace_id, request_idempotency_key)` — **the sole request-dedupe key**
  (double-click/network-retry; arch §15). This is the **only** table carrying that unique
  (`jobs`/`generation_attempts` do not). It is enforced by **retention**, not permanence: the
  row is kept **at least the max client-retry/resend horizon and while its attempt is
  unresolved** (§Retention), and **an attempt is never spawned without an unexpired dedupe
  row** — so a delayed retransmit of one click can never mint a second paid attempt. It is
  **not** a permanent per-prompt unique (deliberate variants are allowed).
- **Index** `idx(workspace_id, created_at)`, `idx(shot_id)`. **SoT** Cloud.

### `generation_attempts`  *(arch §14 — the primary paid-generation identity)*
- **Purpose** one paid-generation identity. **PK** `id` (`attempt_`). **FKs**
  `workspace_id`, `generation_request_id → generation_requests`, `parent_attempt_id →
  generation_attempts NULL`, `retry_of_job_id → jobs NULL`, `assigned_worker_id → workers
  NULL`, `provider_account_ref` (label, not FK to secrets).
- **Columns** `request_idempotency_key TEXT NN`, `attempt_index INT NN DEFAULT 0`,
  `generation_ordinal INT NN DEFAULT 0 CHECK (generation_ordinal <= 1)`, `provider_id TEXT`,
  `provider_idempotency_mode TEXT CHECK (provider_idempotency_mode IN
  ('NONE','NATIVE','DERIVED')) DEFAULT 'NONE'`, `provider_idempotency_key_ref TEXT NULL`
  (**reference/label, never the raw key or a secret**), `provider_submission_id TEXT NULL`,
  `submission_state TEXT NN CHECK (submission_state IN
  ('NOT_SUBMITTED','SUBMITTING','SUBMITTED')) DEFAULT 'NOT_SUBMITTED'`,
  `submission_confidence TEXT NN CHECK (submission_confidence IN
  ('NONE','UNKNOWN','PRESUMED','CONFIRMED')) DEFAULT 'NONE'`, `ownership_status TEXT NN
  CHECK (ownership_status IN ('CREATED','OFFER_PENDING','OFFERED','ACCEPTED','RUNNING',
  'SUBMITTING','POSSIBLY_SUBMITTED','SUBMITTED','RECOVERING','RESULT_AVAILABLE','IMPORTED',
  'TERMINAL_PENDING_ACK','COMPLETED','FAILED','CANCELED','MANUAL_ACTION_REQUIRED',
  'EXPIRED_PRE_SUBMIT'))` (the 17 cloud coordination states, arch §6.1),
  `possibly_submitted BOOL NN DEFAULT false`, `submitted_at`, `terminal_state TEXT NULL`,
  `revision INT NN DEFAULT 0`, `created_at/updated_at`.
- **Unique** `UQ(id)` (PK). `request_idempotency_key` is carried for lineage but its unique
  lives **only** on `generation_requests` (S4). No permanent per-prompt unique (variants
  allowed).
- **Cross-column CHECKs** (defense-in-depth, so no illegal combo is storable):
  `CHECK (generation_ordinal = 0 OR submission_state IN ('SUBMITTING','SUBMITTED'))`,
  `CHECK (submission_state = 'NOT_SUBMITTED' OR possibly_submitted)` (so the paid-risk gauge
  is never false while a submission may exist), and
  `CHECK (terminal_state <> 'COMPLETED' OR submission_state = 'SUBMITTED')`.
- **Indexes** `idx(assigned_worker_id, ownership_status)`, `idx(generation_request_id)`,
  **partial** `idx(workspace_id) WHERE terminal_state IS NULL` (open attempts),
  **partial safety gauge** `idx(workspace_id) WHERE submission_state <> 'NOT_SUBMITTED' OR
  possibly_submitted` (navigable — keyed on `workspace_id`, not the constant flag; catches
  **both** uncertain and confirmed paid risk).
- **Constraints that SQL enforces:** duplicated attempt identity (PK); `generation_ordinal
  <= 1` (golden rule as a column check, a pure backstop); a `BEFORE UPDATE` trigger blocks
  **terminal→non-terminal** (`OLD.terminal_state IS NOT NULL AND NEW.terminal_state IS NULL`)
  **and terminal→a *different* terminal** (`… AND NEW.terminal_state <> OLD.terminal_state`),
  and **freezes** `submission_state`/`provider_submission_id` once terminal.
- **What SQL cannot enforce (transactional — arch §14):** "at most one active paid owner
  across offer+accept+submit" (spans `job_offers` + time) → protected by row-lock
  (`SELECT … FOR UPDATE`) on the attempt during every ownership transition + the re-offer
  safety rule (arch §6.2); "uncertain submission never re-offers" (a reconciliation
  decision, arch §10); **the `generation_ordinal` increment is idempotent** — booked only on
  the `NOT_SUBMITTED → (SUBMITTING|SUBMITTED)` transition (`UPDATE … SET generation_ordinal=1,
  submission_state=… WHERE submission_state='NOT_SUBMITTED'`), so a replayed submitted-fact
  is a no-op and never drives the counter to 2 (the `<=1` CHECK must never be the reason a
  reconcile transaction aborts).
- **Lineage is workspace-safe:** `parent_attempt_id` and `retry_of_job_id` must resolve to
  the **same `workspace_id`** as the row (composite FK / trigger `CHECK`); the retry/parent
  lookup is workspace-scoped (arch §3.2). No cross-tenant lineage.
- **Sensitive** none stored raw (only refs/labels). **SoT** submission facts → **Worker
  journal** (cloud mirrors, upgrade-only per arch §10); ownership/coordination → Cloud.

### `jobs`
- **Purpose** one execution of one attempt. **PK** `id` (`job_`). **FKs** `workspace_id`,
  `worker_id`, `project_id NULL`, `episode_id NULL`, `shot_id NULL`, `generation_attempt_id
  → generation_attempts NULL` (null for non-generation actions), `created_by_user_id`.
- **Columns** `type TEXT NN` (allowlist), `status TEXT NN` (job state machine:
  QUEUED/DISPATCHED/ACCEPTED/RUNNING/NEEDS_MANUAL_ACTION/SUCCEEDED/FAILED/CANCEL_REQUESTED/
  CANCELED/INTERRUPTED/EXPIRED), `request_idempotency_key TEXT NN`, `input JSONB NN`,
  `progress JSONB`, `result JSONB`, `error_code`, `error_message`, `quota_risk BOOL NN
  DEFAULT false`, `created_at`, `dispatched_at`, `accepted_at`, `started_at`, `finished_at`,
  `canceled_at`, `offer_expires_at`, `execution_deadline_at`.
- **Unique** none on `request_idempotency_key` — the request-dedupe unique lives **only** on
  `generation_requests` (S4); `jobs` is identified by its PK and its `generation_attempt_id`
  (one job per attempt). **Indexes** `idx(worker_id, status)`, `idx(workspace_id, created_at)`,
  `idx(generation_attempt_id)`, **partial** `idx(status) WHERE status NOT IN
  ('SUCCEEDED','FAILED','CANCELED','EXPIRED')` (open jobs).
- **Deletion** `ON DELETE RESTRICT` under project; retained until settled + window (arch §23).
  **SoT** Cloud (coordination history); execution truth → Worker journal.

### `job_offers`  *(arch §7 — durable lease)*
- **Purpose** the ownership/lease record for an offered job/attempt. **PK** `id` (`off_`).
  **FKs** `workspace_id`, `job_id`, `generation_attempt_id`, `assigned_worker_id`,
  `project_id`.
- **Columns** `offer_message_id TEXT NN`, `offer_version INT NN DEFAULT 1`, `offered_at NN`,
  `accepted_at NULL`, `offer_expires_at NN`, `execution_deadline_at NULL`,
  `lease_expires_at NN`, `last_worker_event_at`, `ownership_status TEXT NN CHECK
  (ownership_status IN (<the 17 arch §6.1 states> plus 'OFFER_REJECTED'))`,
  `reconcile_required BOOL NN DEFAULT false`, `possibly_submitted BOOL NN DEFAULT false`,
  `terminal_at NULL`, `created_at/updated_at`. (`OFFER_REJECTED` = the Worker declined the
  offer pre-execution.)
- **Unique** partial `UQ(generation_attempt_id) WHERE ownership_status NOT IN
  ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')` — **at most one live offer per attempt**. It
  excludes **only** the two provably-not-submitted outcomes, so a settled/paid attempt
  (`COMPLETED`/`SUBMITTED`/`FAILED`/`CANCELED`/…) **keeps its slot** and can **never gain a
  second live offer** — the DB backstops *sequential* re-offer-after-complete, not just
  concurrent double-offer. A user retry mints a **new** `generation_attempt_id`, so it never
  collides. The `CHECK` enum on `ownership_status` (above) means this case-sensitive
  predicate can never be fed a typo/out-of-enum value.
- **Indexes** `idx(assigned_worker_id, ownership_status)`, **partial** `idx(offer_expires_at)
  WHERE accepted_at IS NULL` (offer-timeout sweep), **partial** `idx(lease_expires_at) WHERE
  terminal_at IS NULL`. **Deletion** `RESTRICT` under project; retained until attempt settled.
  **SoT** Cloud.

### `job_events`
- **Purpose** append-only lifecycle/progress log. **PK** `id` (`evt_`). **FKs** `workspace_id`,
  `job_id`, `worker_id`.
- **Columns** `sequence INT NN`, `type TEXT NN`, `payload JSONB` (sanitized), `created_at`.
- **Unique** `UQ(job_id, sequence)` (gap/dup detection). **Index** `idx(job_id, sequence)`.
- **Deletion** archive after settle + window; append-only. **SoT** Cloud (mirror of Worker
  events).

### `job_recovery_reports`
- **Purpose** persisted `JOB_RECOVERY_REPORT`s (audit + idempotent apply). **PK** `id`.
  **FKs** `workspace_id`, `job_id`, `worker_id`.
- **Columns** `original_message_id TEXT NN`, `local_state TEXT`, `submitted_to_provider
  BOOL`, `result JSONB` (sanitized), `applied_at`, `created_second_generation BOOL NN
  DEFAULT false`, `created_at`.
- **Unique** `UQ(job_id, original_message_id)` (idempotent). **SoT** Worker (report), Cloud
  applies once.

### `job_terminal_results`
- **Purpose** the single authoritative terminal outcome per job (denormalized for fast
  read + exactly-once). **PK** `job_id` (1:1). **FKs** `workspace_id`, `job_id`.
- **Columns** `terminal_type TEXT NN CHECK (terminal_type IN
  ('JOB_COMPLETED','JOB_FAILED','JOB_CANCELED'))`, `terminal_message_id TEXT NN`,
  `result JSONB`, `error_code`, `applied_at NN`.
- **Unique** `UQ(job_id)` (**exactly one terminal per job**), `UQ(terminal_message_id)`.
  **SoT** Worker (result), Cloud stores once.

---

## Assets

### `assets`  *(arch §16)*
- **PK** `id` (`asset_`). **FKs** `workspace_id`, `project_id`, `episode_id NULL`, `shot_id
  NULL`, `producing_worker_id → workers`, `source_asset_id NULL`, `generation_attempt_id →
  generation_attempts NULL **ON DELETE RESTRICT`** (a live asset forbids hard-deleting its
  producing attempt — archive the attempt instead, so the asset→attempt lineage survives).
- **Columns** `provider`, `provider_account_ref` (label), `relative_path NN` (**never
  absolute**), `file_name NN`, `mime_type NN`, `size_bytes BIGINT`, `checksum NN`,
  `actual_duration_sec`, `width`, `height`,
  **`storage_tier TEXT NN CHECK (storage_tier IN ('LOCAL_ONLY','PREVIEW_AVAILABLE','BACKED_UP'))
  DEFAULT 'LOCAL_ONLY'`** and **`liveness TEXT NN CHECK (liveness IN
  ('ONLINE','WORKER_OFFLINE','MISSING','CORRUPT','MIGRATION_REQUIRED')) DEFAULT 'ONLINE'`**
  (two independent columns — no combined `availability` enum; the UI value is computed from
  both, arch §16/§25.1), `review_status TEXT NN DEFAULT 'PENDING'` (+`DURATION_MISMATCH`),
  `selected BOOL DEFAULT false`, `approved BOOL DEFAULT false`, `base_revision INT`,
  `prompt_snapshot TEXT`, `revision INT NN DEFAULT 0`, `created_at/updated_at`, `deleted_at`.
- **Unique** **partial** `UQ(workspace_id, project_id, relative_path) WHERE deleted_at IS
  NULL` — one *live* asset per path; a soft-deleted asset frees its path for re-import.
- **Indexes** `idx(workspace_id, project_id)`, `idx(shot_id)`, `idx(producing_worker_id,
  liveness)`, `idx(generation_attempt_id)`. **Deletion** soft; **cloud never auto-deletes
  media bytes** (it holds none by default). **Sensitive** none (no path/url/secret).
- **SoT** media facts (checksum/size/`storage_tier`/`liveness`/relative_path) → **Worker**
  (upgrade-only, arch §10); review/selection/approval → Cloud.

### `asset_variants`
- **Purpose** duration/quality/preview variants of one logical asset. **PK** `id`. **FKs**
  `workspace_id`, `asset_id`. **Columns** `kind`, `relative_path`, `checksum`, `size_bytes`,
  `meta JSONB`. **Unique** `UQ(asset_id, kind)`. **SoT** Worker facts.

### `asset_review_state`
- **Purpose** (if not inlined on `assets`) review workflow. **PK** `id`. **FKs**
  `workspace_id`, `asset_id`, `reviewed_by_user_id NULL`. **Columns** `review_status`,
  `selected`, `approved`, `reviewed_at`, `revision`. **SoT** Cloud.

### `asset_locality`
- **Purpose** where bytes/previews live over time (per worker). **PK** `id`. **FKs**
  `workspace_id`, `asset_id`, `worker_id`. **Columns** `storage_tier`, `liveness`,
  `checked_at`. **SoT** Worker (mirror).

### `asset_preview_refs`
- **Purpose** opt-in preview/backup object references. **PK** `id` (`preview_`). **FKs**
  `workspace_id`, `asset_id`. **Columns** `object_key TEXT` (**server-derived**, never
  worker-supplied), `kind TEXT` (thumbnail/waveform/proxy/backup), `size_bytes`, `expires_at`,
  `created_at`.
- **Object-key rule (arch §17.2 / C14):** the server verifies `asset.workspace_id =
  derivedWorkspace AND asset.producing_worker_id = derivedWorker`, then **derives** the key as
  `{workspace_id}/{project_id}/{asset_id}/{kind}`; presigned URLs are single-object,
  method-limited (`PUT` upload only), content-length-capped, short-TTL. A worker-supplied key
  is never signed. **Sensitive** `object_key` (scoped, not a public URL). **SoT** Cloud.

---

## Protocol (inbox / outbox / acks)  *(arch §11–§12)*

### `protocol_inbox`
- **Purpose** inbound dedupe + exactly-once. **PK** `id` (`ib_`). **FKs** `workspace_id`,
  `worker_id`, `job_id TEXT NULL`, `generation_attempt_id TEXT NULL`.
- **Columns** `message_id TEXT NN`, `type TEXT NN`, `received_at NN`, `processed_at`,
  `ack_id TEXT NULL → protocol_message_acks` (the ACK returned, for replay),
  `payload_digest TEXT` (checksum, not the full payload where large), `settled_at TEXT NULL`
  (propagated when the referenced attempt settles).
- **Unique** `UQ(worker_id, message_id)` — **the dedupe key** (arch §11.2). **Index**
  `idx(worker_id, received_at)`, `idx(generation_attempt_id)`.
- **Retention / tombstone (S9):** swept only after the **referenced attempt is resolved**
  and past the window (the `job_id`/`generation_attempt_id`/`settled_at` columns make this
  enforceable, not merely time-based). After payload sweep, a lightweight **tombstone**
  `(worker_id, message_id, acked_at)` is retained for the attempt-lifetime window, so a
  re-sent terminal with an old `messageId` still dedupes even after payload rows are gone
  (`job_terminal_results` is the additional cross-path backstop). `sentAt` is **not** a
  dedupe/security key. **SoT** Cloud.

### `protocol_outbox`
- **Purpose** outbound queue + resend state machine. **PK** `id` (`ob_`). **FKs**
  `workspace_id`, `worker_id`, `job_id NULL`.
- **Columns** `message_id TEXT NN`, `type TEXT NN`, `payload JSONB NN` (sanitized,
  size-limited), `status TEXT NN CHECK (status IN ('PENDING','SENT','ACKED','DEAD'))
  DEFAULT 'PENDING'`, **`settlement_mode TEXT NN CHECK (settlement_mode IN
  ('MESSAGE_ACK','LIFECYCLE_RESPONSE','SEND_ONLY'))`** (what "settled" means for this
  message — arch §12.1; `SEND_ONLY` is forbidden for correctness-critical messages),
  **`ordering_key TEXT`** (the `(worker_id[, job_id])` single-flight key), `attempts INT NN
  DEFAULT 0`, `max_attempts INT NN DEFAULT 5`, `next_attempt_at NN`, `created_at`, `sent_at`,
  `acked_at`.
- **Unique** `UQ(message_id)`. **Indexes** **partial** `idx(next_attempt_at) WHERE status =
  'PENDING'` (the send queue — small + hot), **partial** `idx(status) WHERE status='SENT'`
  (awaiting settlement), `idx(worker_id)`, `idx(ordering_key)`.
- **Claim (socket-aware, S5/C6):** `SELECT … WHERE status='PENDING' AND next_attempt_at<=now()
  AND worker_id IN (workers with an ACTIVE session on THIS gateway instance) FOR UPDATE SKIP
  LOCKED`, run under the `cp_ops_enumerator` role. A claimed row with **no local live socket
  is released** (stays `PENDING`, **no** `attempts++`), never marked `SENT`/`DEAD`. Delivery
  is **single-flight per `ordering_key`**, ordered by `created_at`; the next row for a key is
  released only when the prior reaches its `settlement_mode` condition.
- **Deletion** `ACKED`/`DEAD` swept after window; `DEAD` kept for diagnostics (per-type
  operator runbook, deployment §DC6). **SoT** Cloud. **Note** retries reuse the same
  `message_id` (Worker dedupes).

### `protocol_message_acks`
- **Purpose** canonical ACK ledger (both directions) for replay + audit. **PK** `id`
  (`ack_`). **FKs** `workspace_id`, `worker_id`, `job_id TEXT NULL`, `generation_attempt_id
  TEXT NULL`.
- **Columns** `direction TEXT NN CHECK (direction IN ('INBOUND','OUTBOUND'))`,
  `acked_message_id TEXT NN`, `acked_type TEXT NN CHECK (acked_type <> 'MESSAGE_ACK')`
  (never ack an ack), `status TEXT NN CHECK (status IN
  ('ACCEPTED','REJECTED','VALIDATION_FAILED'))`, `error_code TEXT NULL`, `server_revision
  INT NULL`, `settled_at TEXT NULL`, `created_at NN`.
- **Unique** `UQ(worker_id, acked_message_id, direction)` (idempotent — duplicate ACK
  harmless). **Index** `idx(worker_id, acked_message_id)`, `idx(generation_attempt_id)`.
- **Deletion (S9):** swept only after the referenced attempt resolves + window (the
  attempt/job ref makes this enforceable). Survives DB restart (arch §12). **SoT** Cloud.

---

## Security & operations

### `audit_events`
- **PK** `id`. **FK** `workspace_id NULL`. **Columns** `actor_type TEXT NN CHECK (actor_type
  IN ('USER','WORKER','ADMIN','SYSTEM'))`, `actor_id`, `action NN`, `target_type`,
  `target_id`, `metadata JSONB` (sanitized), `ip_address INET`, `user_agent`, `created_at NN`.
- **Index** `idx(workspace_id, created_at)`, `idx(action)`. **Append-only.** **Retention**
  long (e.g. 1 year) then archive. **Sensitive** none (redacted — no credential/cookie/
  token/url/absolute-path). **SoT** Cloud.

### `idempotency_keys`
- **Purpose** generic API idempotency (beyond the request key) — stores the first response
  for a mutating call so a retry returns it. **PK** `id` (`idem_`). **FK** `workspace_id`.
- **Columns** `scope TEXT NN`, `key TEXT NN`, `request_hash TEXT`, `response JSONB`,
  `status`, `created_at`, `expires_at`. **Unique** `UQ(workspace_id, scope, key)`.
  **Deletion** sweep past `expires_at`. **SoT** Cloud.

### `rate_limit_buckets`
- **Purpose** sliding-window counters (pairing/rotation/API). **PK** `id` (`rl_`). **FK**
  `workspace_id NULL`. **Columns** `bucket_key TEXT NN`, `window_start`, `count INT`,
  `updated_at`. **Unique** `UQ(bucket_key, window_start)`. **Deletion** sweep old windows.
  **SoT** Cloud (may be Redis in prod; PG table is the durable/fallback definition).

### `feature_flags`
- **Purpose** rollout control (arch §24). **PK** `id` (`flag_`). **Non-tenant table** —
  writes require the **platform-operator** identity (arch §4/§17.3), not a workspace `ADMIN`.
- **Columns** `name TEXT NN`, `global_enabled BOOL NN DEFAULT false`, `global_kill_switch
  BOOL NN DEFAULT false`, `requires_flag TEXT NULL` (prerequisite name — the dependency
  lattice), `updated_by`, `updated_at`. **Unique** `UQ(name)`. **SoT** Cloud.
- **Targets are normalized (S14), not JSONB:**

  ### `feature_flag_targets`
  - **Purpose** allowlist/kill-list membership, FK-validated + indexed for the per-request
    hot path. **PK** `id`. **FK** `flag_id → feature_flags`.
  - **Columns** `list_kind TEXT NN CHECK (list_kind IN ('ALLOW','KILL'))`, `scope TEXT NN
    CHECK (scope IN ('WORKSPACE','USER','PROJECT'))`, `target_id TEXT NN`.
  - **Unique** `UQ(flag_id, list_kind, scope, target_id)`. **Index** `idx(flag_id, list_kind,
    scope, target_id)`.
- **Evaluation order (arch §24 / deployment §6):** `global_kill_switch` → any matching `KILL`
  target → **prerequisite** (`requires_flag` off ⇒ this flag off) → `global_enabled` → any
  matching `ALLOW` target. The paid-path evaluation is **uncached (TTL=0)**.

---

## Retention summary *(arch §23)*

| Table | Retain while | Then |
|---|---|---|
| `generation_requests` | **≥ max client-retry/resend horizon AND attempt unresolved** (dedupe floor — S12; an attempt is never spawned without an unexpired dedupe row) | archive after settle + window |
| `generation_attempts` | attempt unresolved (non-terminal or `possibly_submitted`) | keep post-settle diagnostic window → **archive to a cold table** (never hard-dropped while referenced by a live asset) |
| `job_offers` | attempt unresolved | archive after settle |
| `jobs`, `job_events`, `job_terminal_results` | attempt unresolved | archive after settle + window |
| `protocol_inbox` / `outbox` | referenced message unsettled | sweep after settle + window (`DEAD` outbox kept for diagnostics) |
| `protocol_message_acks` | referenced message unsettled | sweep after settle + window |
| `worker_connection_sessions` | session active | sweep `CLOSED/SUPERSEDED` after window |
| `worker_status_history` | rolling window | archive |
| `pairing_codes` | before expiry | sweep expired |
| `worker_credentials` (revoked) | — | **kept for audit** |
| `assets`, `asset_*` | soft-deleted only; **bytes never auto-deleted** | — |
| `audit_events` | long | archive |
| `previews` (`asset_preview_refs`) | per tier / `expires_at` | delete object + row |

> **Hard rule (arch §23):** never delete a record required to prove paid-generation
> ownership while its attempt is unresolved — the DB mirror of the Worker journal's
> `sweep()`-never-removes-in-flight rule (recovery-contract §10).

---

## What is (and is not) a SQL constraint — quick reference

| Guarantee | Mechanism |
|---|---|
| One `ACTIVE` Worker per project | partial `UQ(project_worker_affinity project_id) WHERE status='ACTIVE'` |
| One live offer per attempt (incl. sequential re-offer after settle) | partial `UQ(job_offers generation_attempt_id) WHERE ownership_status NOT IN ('EXPIRED_PRE_SUBMIT','OFFER_REJECTED')` — excludes **only** provably-not-submitted outcomes |
| `ownership_status` values are valid (protects the partial unique) | column `CHECK` enum on `generation_attempts` **and** `job_offers` |
| One terminal per job | `UQ(job_terminal_results job_id)` |
| `generation_ordinal ≤ 1` (+ no illegal status combos) | column `CHECK`s (incl. cross-column: ordinal↔submission, possibly_submitted↔submission, terminal↔submission) |
| No duplicate inbound message | `UQ(protocol_inbox worker_id, message_id)` + tombstone beyond payload sweep |
| No terminal→non-terminal **or** terminal→different-terminal reactivation; submission frozen post-terminal | `BEFORE UPDATE` trigger |
| Ownership rows never cascade-deleted while an attempt is unresolved | `ON DELETE RESTRICT` + `BEFORE DELETE` trigger on `projects` |
| **At most one active paid owner across offer+accept+submit** | **transactional** (`SELECT … FOR UPDATE` on the attempt + re-offer rule) — *not* a single constraint |
| **Uncertain submission never re-offers** | **transactional/decision** (reconciliation precedence) — *not* a constraint |
| One active credential/session per Worker | partial uniques on `worker_credentials`/`worker_connection_sessions` |

*End of schema. Architecture → [control-plane-architecture.md](control-plane-architecture.md).*
