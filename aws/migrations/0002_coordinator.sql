CREATE TABLE IF NOT EXISTS crabhelm_coordinator_claws (
  claw_id TEXT PRIMARY KEY CHECK (char_length(claw_id) BETWEEN 1 AND 200),
  reset_generation BIGINT NOT NULL DEFAULT 0 CHECK (reset_generation >= 0)
);

CREATE TABLE IF NOT EXISTS crabhelm_coordinator_grants (
  claw_id TEXT NOT NULL CHECK (char_length(claw_id) BETWEEN 1 AND 200),
  invocation_id TEXT NOT NULL CHECK (char_length(invocation_id) BETWEEN 1 AND 500),
  jti TEXT NOT NULL CHECK (char_length(jti) BETWEEN 1 AND 500),
  arguments_digest TEXT NOT NULL CHECK (arguments_digest ~ '^[0-9a-f]{64}$'),
  expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
  consumed_at BIGINT CHECK (consumed_at >= 0),
  PRIMARY KEY (claw_id, invocation_id),
  UNIQUE (claw_id, jti)
);

CREATE TABLE IF NOT EXISTS crabhelm_coordinator_runs (
  claw_id TEXT NOT NULL CHECK (char_length(claw_id) BETWEEN 1 AND 200),
  invocation_id TEXT NOT NULL CHECK (char_length(invocation_id) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at BIGINT NOT NULL CHECK (started_at >= 0),
  completed_at BIGINT CHECK (completed_at >= 0),
  error TEXT,
  PRIMARY KEY (claw_id, invocation_id)
);

CREATE TABLE IF NOT EXISTS crabhelm_coordinator_runtime_refreshes (
  claw_id TEXT NOT NULL CHECK (char_length(claw_id) BETWEEN 1 AND 200),
  jti TEXT NOT NULL CHECK (char_length(jti) BETWEEN 1 AND 500),
  expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
  consumed_at BIGINT CHECK (consumed_at >= 0),
  response_envelope TEXT,
  PRIMARY KEY (claw_id, jti)
);

CREATE TABLE IF NOT EXISTS crabhelm_coordinator_runtime_tickets (
  claw_id TEXT NOT NULL CHECK (char_length(claw_id) BETWEEN 1 AND 200),
  jti TEXT NOT NULL CHECK (char_length(jti) BETWEEN 1 AND 500),
  expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
  consumed_at BIGINT CHECK (consumed_at >= 0),
  PRIMARY KEY (claw_id, jti)
);

CREATE TABLE IF NOT EXISTS crabhelm_coordinator_turn_jobs (
  claw_id TEXT NOT NULL CHECK (char_length(claw_id) BETWEEN 1 AND 200),
  id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  event_id TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 500),
  requester_id TEXT NOT NULL CHECK (char_length(requester_id) BETWEEN 1 AND 500),
  persona_id TEXT NOT NULL CHECK (char_length(persona_id) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('pending', 'offered', 'running', 'completed', 'failed')),
  turn_token TEXT NOT NULL,
  payload_envelope TEXT,
  source_json JSONB NOT NULL,
  runtime_id TEXT CHECK (runtime_id IS NULL OR char_length(runtime_id) BETWEEN 1 AND 500),
  response_envelope TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'none'
    CHECK (delivery_status IN ('none', 'pending', 'delivering', 'delivered', 'failed')),
  delivery_owner TEXT,
  delivery_claimed_at BIGINT CHECK (delivery_claimed_at >= 0),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  claimed_at BIGINT CHECK (claimed_at >= 0),
  completed_at BIGINT CHECK (completed_at >= 0),
  expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
  error TEXT,
  PRIMARY KEY (claw_id, id),
  UNIQUE (claw_id, event_id)
);

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_grants_expiry_idx
  ON crabhelm_coordinator_grants (expires_at, claw_id);

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_refreshes_expiry_idx
  ON crabhelm_coordinator_runtime_refreshes (expires_at, claw_id);

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_tickets_expiry_idx
  ON crabhelm_coordinator_runtime_tickets (expires_at, claw_id);

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_runs_retention_idx
  ON crabhelm_coordinator_runs (completed_at, claw_id)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_jobs_pending_idx
  ON crabhelm_coordinator_turn_jobs (claw_id, created_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_jobs_offered_idx
  ON crabhelm_coordinator_turn_jobs (claw_id, claimed_at)
  WHERE status = 'offered';

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_jobs_running_idx
  ON crabhelm_coordinator_turn_jobs (claw_id, claimed_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_jobs_delivery_idx
  ON crabhelm_coordinator_turn_jobs (claw_id, delivery_status, completed_at, id)
  WHERE delivery_status IN ('pending', 'delivering');

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_jobs_retention_idx
  ON crabhelm_coordinator_turn_jobs (completed_at, claw_id)
  WHERE completed_at IS NOT NULL AND delivery_status IN ('delivered', 'failed');
