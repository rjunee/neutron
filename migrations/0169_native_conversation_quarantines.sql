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
