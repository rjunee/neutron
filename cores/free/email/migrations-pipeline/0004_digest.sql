CREATE TABLE IF NOT EXISTS briefs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  local_day     TEXT NOT NULL,
  period        TEXT NOT NULL CHECK (period IN ('morning', 'afternoon')),
  generated_at  INTEGER NOT NULL,
  email_count   INTEGER NOT NULL,
  delivered_at INTEGER,
  data          TEXT NOT NULL,
  UNIQUE (local_day, period)
);

CREATE INDEX IF NOT EXISTS idx_emails_unbriefed
  ON emails (brief_id, received_at)
  WHERE brief_id IS NULL AND handling <> 'preexisting';
