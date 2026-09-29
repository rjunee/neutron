-- A continuation spends one opportunity on the original durable child lease.
-- Rows survive lease release so a lost acknowledgement cannot authorize replay.
CREATE TABLE IF NOT EXISTS claude_native_continuations (
  lease_token TEXT PRIMARY KEY,
  preparation TEXT NOT NULL
);
