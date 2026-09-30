CREATE TABLE IF NOT EXISTS claude_mcp_handler_generations (
  generation_key TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  covered INTEGER NOT NULL CHECK (covered IN (0, 1))
);
CREATE TABLE IF NOT EXISTS claude_mcp_handler_calls (
  generation_key TEXT NOT NULL REFERENCES claude_mcp_handler_generations(generation_key),
  invocation_id TEXT NOT NULL,
  binding TEXT NOT NULL,
  outcome TEXT,
  PRIMARY KEY (generation_key, invocation_id)
);
