-- Prepared recovery is a scope admission gate until its exact lease has a
-- verified physical termination. Evidence and deletion commit atomically.
CREATE TABLE IF NOT EXISTS native_host_terminations (
  operation_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  lease_token TEXT NOT NULL UNIQUE,
  preparation TEXT NOT NULL,
  termination TEXT,
  CHECK (length(operation_id) > 0),
  CHECK (length(lease_token) > 0)
);
CREATE INDEX IF NOT EXISTS native_host_terminations_pending
  ON native_host_terminations(scope_key) WHERE termination IS NULL;
