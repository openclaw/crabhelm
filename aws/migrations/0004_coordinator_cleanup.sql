UPDATE crabhelm_coordinator_turn_jobs
SET turn_token = '[encrypted]'
WHERE turn_token <> '[encrypted]';

ALTER TABLE crabhelm_coordinator_turn_jobs
  ADD CONSTRAINT crabhelm_coordinator_turn_jobs_encrypted_token_check
  CHECK (turn_token = '[encrypted]');

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_runs_running_idx
  ON crabhelm_coordinator_runs (started_at, claw_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS crabhelm_coordinator_jobs_expiry_idx
  ON crabhelm_coordinator_turn_jobs (claw_id, expires_at, id)
  WHERE status IN ('pending', 'offered');
