ALTER TABLE crabhelm_coordinator_claws
  ADD COLUMN IF NOT EXISTS removed_at BIGINT CHECK (removed_at >= 0);
