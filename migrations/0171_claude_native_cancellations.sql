-- Host-owned cancellation intent survives acknowledgement loss and lease release.
CREATE TABLE IF NOT EXISTS claude_native_cancellations (
  lease_token TEXT PRIMARY KEY NOT NULL,
  scope_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  producer TEXT NOT NULL,
  work_ref TEXT NOT NULL,
  preparation TEXT NOT NULL,
  acknowledgement TEXT
);
CREATE INDEX IF NOT EXISTS idx_claude_native_cancellation_work
  ON claude_native_cancellations(scope_key, work_ref);
