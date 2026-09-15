-- Mutable instance default; NULL inherits the application default.
ALTER TABLE instance_metadata ADD COLUMN model_provider TEXT
  CHECK (model_provider IS NULL OR model_provider IN ('anthropic', 'openai', 'openai-codex', 'pi'));
ALTER TABLE instance_metadata ADD COLUMN model_provider_initialized INTEGER NOT NULL DEFAULT 0;
