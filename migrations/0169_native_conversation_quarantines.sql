-- Permanent conversation denial accompanies exact workflow retirement. The
-- original transcript/registry remain history; no outcome is rewritten.
CREATE TABLE IF NOT EXISTS native_conversation_quarantines (
  session_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT UNIQUE NOT NULL,
  scope_key TEXT NOT NULL,
  authorization TEXT NOT NULL,
  CHECK (length(session_id) > 0),
  CHECK (length(authorization) > 0)
);

-- Exact logical turn references remain denied across future gateway epochs.
CREATE TABLE IF NOT EXISTS conversation_admission_retirements (
  operation_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  lease_token TEXT UNIQUE NOT NULL,
  producer TEXT NOT NULL,
  work_ref TEXT NOT NULL,
  PRIMARY KEY (scope_key, work_ref)
);
