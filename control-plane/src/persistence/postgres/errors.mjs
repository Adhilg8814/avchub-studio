// P0 Step 5C.2 — map raw PostgreSQL errors → stable DomainError. PURE (no pg import). The
// mapping keys on SQLSTATE + the constraint name our schema uses, so a caller/test never sees
// a raw constraint string in a public body — only a stable domain code.

import { DomainError, DOMAIN_ERRORS } from "../domain-errors.mjs";

// PostgreSQL SQLSTATEs we care about.
const SS = {
  UNIQUE: "23505",
  FK: "23503",
  CHECK: "23514",
  NOT_NULL: "23502",
  SERIALIZATION: "40001",
  DEADLOCK: "40P01",
  CONNECTION: "08006",
  CANNOT_CONNECT: "08001",
  QUERY_CANCELED: "57014"      // statement_timeout
};

// Our schema constraint names → domain codes (unique + check + custom SQLSTATE triggers).
const CONSTRAINT_MAP = {
  generation_requests_idem_uq: DOMAIN_ERRORS.E_IDEMPOTENCY_CONFLICT,
  job_offers_one_live_uq: DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED,
  jobs_one_per_attempt_uq: DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED,
  affinity_one_active_uq: DOMAIN_ERRORS.E_AFFINITY_CONFLICT,
  job_terminal_results_pkey: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  job_terminal_results_msg_uq: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  worker_credentials_one_active_uq: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  worker_sessions_one_active_uq: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  attempt_ordinal_requires_submit: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  attempt_paidrisk_gauge: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  attempt_completed_requires_submitted: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  cp_revision_increment: DOMAIN_ERRORS.E_REVISION_CONFLICT,
  cp_attempt_terminal_immutable: DOMAIN_ERRORS.E_ATTEMPT_TERMINAL,
  cp_attempt_submission_frozen: DOMAIN_ERRORS.E_ATTEMPT_TERMINAL,
  cp_attempt_submission_monotonic: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  cp_project_unresolved_attempts: DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED,
  approval_grant_not_over_consumed: DOMAIN_ERRORS.E_PAID_APPROVAL_REQUIRED
};

// Custom SQLSTATEs raised by our plpgsql triggers.
const CUSTOM_SQLSTATE = {
  CP001: DOMAIN_ERRORS.E_REVISION_CONFLICT,
  CP002: DOMAIN_ERRORS.E_ATTEMPT_TERMINAL,
  CP003: DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION,
  CP004: DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED
};

// Public-safe generic messages per domain code (no values / SQL echoed).
const SAFE_MESSAGE = {
  [DOMAIN_ERRORS.E_IDEMPOTENCY_CONFLICT]: "Duplicate request",
  [DOMAIN_ERRORS.E_ATTEMPT_ALREADY_OWNED]: "Attempt already owned",
  [DOMAIN_ERRORS.E_AFFINITY_CONFLICT]: "Affinity conflict",
  [DOMAIN_ERRORS.E_REVISION_CONFLICT]: "Concurrent modification",
  [DOMAIN_ERRORS.E_ATTEMPT_TERMINAL]: "Attempt already terminal",
  [DOMAIN_ERRORS.E_RECONCILIATION_REQUIRED]: "Reconciliation required",
  [DOMAIN_ERRORS.E_PAID_APPROVAL_REQUIRED]: "Paid approval required",
  [DOMAIN_ERRORS.E_SERIALIZATION]: "Serialization failure, retry",
  [DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION]: "Invalid state transition",
  [DOMAIN_ERRORS.E_WORKSPACE_MISMATCH]: "Workspace mismatch"
};

// mapPgError(err): DomainError. Never leaks SQL/values.
export function mapPgError(err) {
  // Preserve already-typed auth-layer errors (they carry their own stable AUTH_* code + generic-safe
  // message). Without this the transaction() wrapper would flatten every repository authError to a
  // generic E_INVALID_STATE_TRANSITION. No pg error ever sets this flag, so existing mapping is unchanged.
  if (err && err.authError === true) return err;
  const sqlstate = err && err.code ? String(err.code) : null;
  const constraint = err && err.constraint ? String(err.constraint) : null;

  let code = null;
  if (sqlstate && CUSTOM_SQLSTATE[sqlstate]) code = CUSTOM_SQLSTATE[sqlstate];
  else if (constraint && CONSTRAINT_MAP[constraint]) code = CONSTRAINT_MAP[constraint];
  else if (sqlstate === SS.SERIALIZATION || sqlstate === SS.DEADLOCK) code = DOMAIN_ERRORS.E_SERIALIZATION;
  else if (sqlstate === SS.FK) code = DOMAIN_ERRORS.E_WORKSPACE_MISMATCH;
  else if (sqlstate === SS.UNIQUE) code = DOMAIN_ERRORS.E_IDEMPOTENCY_CONFLICT;
  else if (sqlstate === SS.CHECK || sqlstate === SS.NOT_NULL) code = DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION;
  else if (sqlstate === SS.CONNECTION || sqlstate === SS.CANNOT_CONNECT) code = DOMAIN_ERRORS.E_DB_UNAVAILABLE;
  else code = DOMAIN_ERRORS.E_INVALID_STATE_TRANSITION;

  return new DomainError(code, SAFE_MESSAGE[code] || code, { sqlstate, constraint, cause: err });
}

export function isRetryableSqlState(sqlstate) {
  return sqlstate === SS.SERIALIZATION || sqlstate === SS.DEADLOCK;
}

export { SS as PG_SQLSTATES };
