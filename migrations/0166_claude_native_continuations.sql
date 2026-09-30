-- Each authenticated quota episode spends one opportunity on its original lease.
-- Rows survive lease release so a lost acknowledgement cannot authorize replay.
CREATE TABLE IF NOT EXISTS claude_native_continuations (
  lease_token TEXT NOT NULL,
  authenticated_episode_id TEXT NOT NULL,
  preparation TEXT NOT NULL,
  PRIMARY KEY (lease_token, authenticated_episode_id)
);
