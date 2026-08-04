-- P0 Step 5C.2 — 0011 indexes. Navigable partial indexes keyed on workspace_id / worker_id /
-- status / timestamps (never a bare low-cardinality boolean). Unique indexes for the core
-- invariants live in their own migrations (0003/0004/0005/0006).

SET search_path = public;

-- membership authorization (target-resource → role lookup)
CREATE INDEX ix_workspace_members_user ON workspace_members (user_id);
CREATE INDEX ix_workspace_members_ws ON workspace_members (workspace_id, user_id);

-- project hierarchy
CREATE INDEX ix_projects_ws_status ON projects (workspace_id, status);
CREATE INDEX ix_projects_home_worker ON projects (home_worker_id) WHERE home_worker_id IS NOT NULL;
CREATE INDEX ix_episodes_ws ON episodes (workspace_id, project_id);
CREATE INDEX ix_shots_ws_project ON shots (workspace_id, project_id);
CREATE INDEX ix_prompts_shot_kind ON prompts (shot_id, kind);

-- active project affinity
CREATE INDEX ix_affinity_worker_status ON project_worker_affinity (worker_id, status);

-- worker credentials / status
CREATE INDEX ix_worker_credentials_worker ON worker_credentials (worker_id);
CREATE INDEX ix_worker_credentials_expires ON worker_credentials (expires_at);
CREATE INDEX ix_workers_ws_status ON workers (workspace_id, status);
CREATE INDEX ix_worker_sessions_worker_status ON worker_connection_sessions (worker_id, status);
CREATE INDEX ix_worker_sessions_last_seen ON worker_connection_sessions (last_seen_at);
CREATE INDEX ix_worker_status_history_worker_at ON worker_status_history (worker_id, at);
CREATE INDEX ix_pairing_codes_ws ON pairing_codes (workspace_id);
CREATE INDEX ix_pairing_codes_expires ON pairing_codes (expires_at);

-- generation requests / attempts
CREATE INDEX ix_generation_requests_ws_created ON generation_requests (workspace_id, created_at);
CREATE INDEX ix_generation_requests_shot ON generation_requests (shot_id) WHERE shot_id IS NOT NULL;
CREATE INDEX ix_attempts_worker_ownership ON generation_attempts (assigned_worker_id, ownership_status);
CREATE INDEX ix_attempts_request ON generation_attempts (generation_request_id);
-- unresolved (open) attempts — navigable, keyed on workspace_id
CREATE INDEX ix_attempts_open ON generation_attempts (workspace_id) WHERE terminal_state IS NULL;
-- possibly-submitted / provider-submitted safety gauge (uncertain OR confirmed paid risk)
CREATE INDEX ix_attempts_paid_risk ON generation_attempts (workspace_id)
  WHERE submission_state <> 'NOT_SUBMITTED' OR possibly_submitted;

-- jobs
CREATE INDEX ix_jobs_worker_status ON jobs (worker_id, status);
CREATE INDEX ix_jobs_ws_created ON jobs (workspace_id, created_at);
CREATE INDEX ix_jobs_attempt ON jobs (generation_attempt_id) WHERE generation_attempt_id IS NOT NULL;
CREATE INDEX ix_jobs_open ON jobs (workspace_id) WHERE status NOT IN ('SUCCEEDED','FAILED','CANCELED','EXPIRED');

-- job offers (live offers, offer-timeout sweep, lease sweep)
CREATE INDEX ix_offers_worker_ownership ON job_offers (assigned_worker_id, ownership_status);
CREATE INDEX ix_offers_offer_expiry ON job_offers (offer_expires_at) WHERE accepted_at IS NULL;
CREATE INDEX ix_offers_lease_expiry ON job_offers (lease_expires_at) WHERE terminal_at IS NULL;

-- protocol: due outbox, inbox dedupe, ACK replay, reconciliation backlog
CREATE INDEX ix_outbox_due ON protocol_outbox (next_attempt_at) WHERE delivery_state = 'PENDING';
CREATE INDEX ix_outbox_sent ON protocol_outbox (worker_id) WHERE delivery_state = 'SENT';
CREATE INDEX ix_outbox_ordering ON protocol_outbox (ordering_key, created_at) WHERE delivery_state IN ('PENDING','SENT');
CREATE INDEX ix_inbox_worker_received ON protocol_inbox (worker_id, received_at);
CREATE INDEX ix_inbox_attempt ON protocol_inbox (generation_attempt_id) WHERE generation_attempt_id IS NOT NULL;
CREATE INDEX ix_acks_worker_msg ON protocol_message_acks (worker_id, acked_message_id);
CREATE INDEX ix_acks_attempt ON protocol_message_acks (generation_attempt_id) WHERE generation_attempt_id IS NOT NULL;

-- assets (live path lookup already unique; producing worker + liveness)
CREATE INDEX ix_assets_ws_project ON assets (workspace_id, project_id);
CREATE INDEX ix_assets_shot ON assets (shot_id) WHERE shot_id IS NOT NULL;
CREATE INDEX ix_assets_worker_liveness ON assets (producing_worker_id, liveness);
CREATE INDEX ix_assets_attempt ON assets (generation_attempt_id) WHERE generation_attempt_id IS NOT NULL;

-- retention sweeps
CREATE INDEX ix_inbox_settled ON protocol_inbox (settled_at) WHERE settled_at IS NOT NULL;
CREATE INDEX ix_audit_ws_created ON audit_events (workspace_id, created_at);
CREATE INDEX ix_audit_action ON audit_events (action);

-- feature-flag target lookup (per-request hot path) + approval-grant consumption
CREATE INDEX ix_flag_targets_lookup ON feature_flag_targets (flag_id, list_kind, scope, target_id);
CREATE INDEX ix_approval_grants_open ON paid_generation_approval_grants (workspace_id)
  WHERE consumed_count < max_paid_generations;
