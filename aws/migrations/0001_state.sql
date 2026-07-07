CREATE TABLE IF NOT EXISTS crabhelm_state_entries (
  namespace TEXT NOT NULL CHECK (
    char_length(namespace) BETWEEN 1 AND 64
    AND namespace ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
  ),
  "key" TEXT NOT NULL CHECK (char_length("key") BETWEEN 1 AND 500),
  value_json JSONB NOT NULL,
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (namespace, "key")
);

CREATE INDEX IF NOT EXISTS crabhelm_state_entries_namespace_created_idx
  ON crabhelm_state_entries (namespace, created_at, "key");
