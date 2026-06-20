-- 0004_gateway_core.sql
--
-- Sprint 7 — P1 S4. Adds the tables the gateway core wires up: channel-bound
-- topics, per-instance reminders, HITL tool approvals, cron last-run state, and
-- watchdog alert ledger.
--
-- Conservative scope: only what S4 modules actually consume. P1 S5 (subdomain
-- provisioning) and P1 S6 (cross-instance API) layer additional tables on top in
-- their own migrations.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS). Wrapped in BEGIN/COMMIT
-- by migrations/runner.ts.

PRAGMA foreign_keys = ON;

-- topics — per-instance topic registry. Channel-binding is part of the row so
-- the channels/router.ts can resolve a (channel_kind, channel_topic_id) pair
-- back to a topic without a separate join. project_id is nullable for
-- instance-level topics (e.g. the catch-all "general" topic used during
-- onboarding before any project exists).
CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,                           -- redundant within a per-project DB; kept for cross-instance audit + Zone A bookkeeping
    project_id TEXT,                                     -- nullable: instance-level topics
    channel_kind TEXT NOT NULL,                          -- 'telegram' | 'app_socket' | 'webhook' | 'cli'
    channel_topic_id TEXT NOT NULL,                      -- the channel's native topic id (telegram thread_id, socket id, webhook url path, …)
    privacy_mode TEXT NOT NULL DEFAULT 'regular' CHECK (privacy_mode IN ('regular', 'private')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

-- (channel_kind, channel_topic_id) is the routing key — must be unique so an
-- inbound event resolves to exactly one topic. No project_slug in the unique
-- index because the per-project DB already scopes the rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_channel_binding
    ON topics(channel_kind, channel_topic_id);
CREATE INDEX IF NOT EXISTS idx_topics_project_id ON topics(project_id);
CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);

-- reminders — instance-scoped reminder store. Replaces Nova's
-- gateway/reminders.json single-file store with a per-instance SQLite table.
-- Fire-time agent composes the message from the stored body at fire time;
-- this row is the persistent state.
CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    topic_id TEXT,                                       -- nullable: instance-level reminders without a topic
    fire_at REAL NOT NULL,                               -- unix seconds; UTC
    message TEXT NOT NULL,                               -- literal / smart-wrap / pattern-template body
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'cancelled')),
    created_at REAL NOT NULL,
    fired_at REAL,                                       -- nullable until fired
    cancelled_at REAL                                    -- nullable until cancelled
);

CREATE INDEX IF NOT EXISTS idx_reminders_fire_at ON reminders(fire_at);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
CREATE INDEX IF NOT EXISTS idx_reminders_topic_id ON reminders(topic_id);

-- tool_approvals — pending HITL approval requests. The approval module
-- writes a row here and returns its id; the channel adapter renders the
-- approval prompt and routes the user's reply back via approval/respond
-- which updates the row to approved/denied. Args are JSON-serialised so the
-- approval surface can render a deterministic preview.
CREATE TABLE IF NOT EXISTS tool_approvals (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    topic_id TEXT,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,                             -- JSON
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    requested_at REAL NOT NULL,
    decided_at REAL,                                     -- nullable until approved/denied/expired
    decided_by TEXT                                      -- user_id of decider; NULL for auto-expired
);

CREATE INDEX IF NOT EXISTS idx_tool_approvals_status ON tool_approvals(status);
CREATE INDEX IF NOT EXISTS idx_tool_approvals_requested_at ON tool_approvals(requested_at);

-- cron_state — last-run bookkeeping per (job_name, project_slug). One row per
-- declared cron job; PK is composite to keep the row count proportional to
-- the registered job set, not to the number of past runs (history goes to
-- structured logs).
CREATE TABLE IF NOT EXISTS cron_state (
    job_name TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    last_run_at REAL,                                    -- unix seconds; NULL on first install before first run
    last_run_status TEXT,                                -- 'ok' | 'error' | 'skipped' | NULL
    last_run_error TEXT,                                 -- stringified error if last_run_status='error'
    last_run_duration_ms INTEGER,                        -- elapsed ms for the most recent run
    PRIMARY KEY (job_name, project_slug)
);

CREATE INDEX IF NOT EXISTS idx_cron_state_last_run_at ON cron_state(last_run_at);

-- watchdog_alerts — structured ledger of fired watchdogs. Append-only;
-- resolved_at is set when the condition clears (or when a human acks). One
-- row per fire so a long-burning condition can be analyzed by frequency.
CREATE TABLE IF NOT EXISTS watchdog_alerts (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,                                  -- 'gateway_heartbeat' | 'stuck_agent' | 'crashed_agent' | 'overrun_cron' | 'db_lock_contention' | 'substrate_cooldown_saturation'
    project_slug TEXT NOT NULL,
    detected_at REAL NOT NULL,
    resolved_at REAL,
    payload_json TEXT NOT NULL                           -- JSON: kind-specific details (PID, agent_id, job_name, last_seen_at, etc.)
);

CREATE INDEX IF NOT EXISTS idx_watchdog_alerts_kind ON watchdog_alerts(kind);
CREATE INDEX IF NOT EXISTS idx_watchdog_alerts_detected_at ON watchdog_alerts(detected_at);
CREATE INDEX IF NOT EXISTS idx_watchdog_alerts_resolved_at ON watchdog_alerts(resolved_at);
