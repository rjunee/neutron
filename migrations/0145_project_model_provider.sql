-- A NULL model_provider means the project has made no choice and follows the
-- instance default. A non-NULL value is an explicit project override.
ALTER TABLE projects
    ADD COLUMN model_provider TEXT
        CHECK (model_provider IS NULL OR model_provider IN ('anthropic', 'openai', 'openai-codex-cli'));
