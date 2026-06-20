-- 0001_initial_schema.sql
--
-- Lift baseline: Hermes hermes_state.py:30-110 (sessions + messages + FTS5 + WAL pragma).
-- Source: internal design notes
--
-- Neutron additions (per docs/plans/P0-system-user-data-separation.md § 1.4):
--   project_slug, project_id, core_id, substrate_instance_id,
--   channel_binding_kind, channel_binding_address, privacy_mode.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere).

-- foreign_keys is per-connection (not persisted across opens), so the runner ALSO sets it on
-- every fresh connection in migrations/runner.ts. Re-asserting here keeps the schema
-- self-describing — running this file directly via the sqlite CLI also enables FK enforcement.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,                        -- TEXT PRIMARY KEY is implicitly nullable on rowid tables; pin it for defense-in-depth

    -- Hermes baseline:
    source TEXT NOT NULL,                                -- 'cli' | 'telegram' | 'discord' | 'app-mobile' | 'app-web' | 'webhook'
    user_id TEXT,                                        -- the human speaker; NULL for cron-spawned sessions
    model TEXT,
    model_config TEXT,                                   -- JSON
    system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    billing_provider TEXT,
    billing_base_url TEXT,
    billing_mode TEXT,                                   -- 'creator_pays' | 'workspace_owned' | 'private_substrate'
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    pricing_version TEXT,
    title TEXT,
    api_call_count INTEGER NOT NULL DEFAULT 0,

    -- Neutron additions:
    project_slug TEXT NOT NULL,                          -- redundant within a per-project DB; enables project verification on every read
    project_id TEXT,                                     -- project scope; NULL for instance-level sessions
    core_id TEXT,                                        -- which Core spawned this session; NULL for direct user sessions
    substrate_instance_id TEXT,                          -- which CC sub / H100 node / OpenAI account served the call (per § B.P1 substrate-adapter spec)
    channel_binding_kind TEXT,                           -- 'telegram_thread' | 'app_socket' | 'webhook' | 'cron_isolated'
    channel_binding_address TEXT,                        -- thread_id / socket_id / webhook_url / cron_job_id
    privacy_mode TEXT NOT NULL DEFAULT 'regular' CHECK (privacy_mode IN ('regular', 'private')),

    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_slug ON sessions(project_slug);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_core_id ON sessions(core_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_billing_mode ON sessions(billing_mode);
CREATE INDEX IF NOT EXISTS idx_sessions_privacy_mode ON sessions(privacy_mode);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,                                     -- JSON
    tool_name TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_content TEXT,
    reasoning_details TEXT,
    codex_reasoning_items TEXT,                          -- JSON, GPT-5.5 adapter parity per § A.2.1
    codex_message_items TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

-- FTS5 mirror of messages.content for full-text search.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
