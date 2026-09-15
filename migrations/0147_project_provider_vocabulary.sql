-- Rebuild the projects table because SQLite cannot replace an existing column CHECK.
-- The legacy Codex CLI spelling is translated while the canonical vocabulary adds pi.
PRAGMA foreign_keys = OFF;

CREATE TABLE projects_provider_vocabulary (
    id                   TEXT PRIMARY KEY NOT NULL,
    name                 TEXT NOT NULL,
    description          TEXT,
    persona              TEXT,
    privacy_mode         TEXT NOT NULL DEFAULT 'private'
                             CHECK (privacy_mode IN ('private', 'workspace', 'public')),
    billing_mode         TEXT NOT NULL DEFAULT 'personal'
                             CHECK (billing_mode IN ('personal', 'group_per_seat', 'group_shared')),
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    deleted_at           TEXT,
    context_archived_at  TEXT,
    topic_id             TEXT,
    agent_engagement_mode TEXT NOT NULL DEFAULT 'all_messages'
                             CHECK (agent_engagement_mode IN ('tag_gated', 'all_messages')),
    emoji                TEXT,
    last_activity_at     TEXT,
    archived_at          TEXT,
    model_provider       TEXT
                             CHECK (model_provider IS NULL OR model_provider IN ('anthropic', 'openai', 'openai-codex', 'pi'))
) STRICT;

INSERT INTO projects_provider_vocabulary (
    id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at,
    deleted_at, context_archived_at, topic_id, agent_engagement_mode, emoji,
    last_activity_at, archived_at, model_provider
)
SELECT
    id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at,
    deleted_at, context_archived_at, topic_id, agent_engagement_mode, emoji,
    last_activity_at, archived_at,
    CASE model_provider WHEN 'openai-codex-cli' THEN 'openai-codex' ELSE model_provider END
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_provider_vocabulary RENAME TO projects;
