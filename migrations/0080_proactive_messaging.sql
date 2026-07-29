-- 0080_proactive_messaging.sql
--
-- Proactive messaging — the durable bookkeeping for the daily morning brief
-- and the idle-topic nudge sweep (gap-audit P0-5, WAVE 2 Track A).
--
-- Closes the "Neutron only speaks when spoken to" gap. Two proactive paths
-- are added on top of the existing cron registry + P6 nudge ranker:
--
--   1. The morning brief composes a real daily brief (calendar + focus queue
--      + entity deltas + project STATUS) and POSTS it on a schedule, fires
--      regardless of overnight activity. `proactive_brief_log` is the
--      once-per-local-day idempotency guard: the morning-brief handler ticks
--      frequently but posts at most one brief per owner-local day, so a
--      gateway restart cannot double-post.
--
--   2. The idle-topic nudge sweep periodically picks, per IDLE project-topic,
--      the single highest-leverage next action (reusing the P6 ranker's
--      `current_focus_pick` row) and POSTS a concise nudge — behind a strict
--      quality gate. `proactive_topic_state` is the per-topic dedupe ledger:
--      it remembers the last task we nudged about + when, so the sweep never
--      re-nudges the same idle topic about the same task, and never nudges a
--      topic the user has not gone idle on again since the last nudge.
--
-- Both tables are runtime truth, instance-scoped, written only by the
-- proactive cron handlers. Forward-only; no down-migration (Neutron OSS
-- contract, matches 0078).

-- One row per owner-local day a morning brief was posted. PK on `day` makes
-- the "already posted today" guard a single-row EXISTS check (mirrors the
-- nudge engine's same-day short-circuit on `current_focus_pick`).
CREATE TABLE proactive_brief_log (
    -- Owner-local YYYY-MM-DD the brief was posted for (resolved from
    -- `instance_metadata.timezone`, default America/Los_Angeles when unset).
    day        TEXT PRIMARY KEY NOT NULL,
    -- ISO-8601 UTC instant the brief was actually delivered.
    posted_at  TEXT NOT NULL,
    -- The topic the brief landed in (channel_topic_id), recorded for audit.
    topic_id   TEXT
) STRICT;

-- Per-topic idle-nudge dedupe ledger. One row per topic we have ever nudged.
CREATE TABLE proactive_topic_state (
    -- The channel topic id (`<chat_id>[:<thread_id>]` for Telegram) the
    -- nudge was posted to. PK so the upsert is a single-row write.
    topic_id            TEXT PRIMARY KEY NOT NULL,
    project_slug        TEXT NOT NULL,
    -- ISO-8601 UTC instant of the most recent idle-nudge post.
    last_nudged_at      TEXT,
    -- The `current_focus_pick.task_id` the last nudge was about. The sweep
    -- skips re-nudging while this matches today's pick (no churn on the same
    -- recommendation).
    last_nudged_task_id TEXT,
    -- The topic's last-activity instant (epoch ms, as TEXT) observed at the
    -- time of the last nudge. The sweep only re-nudges once the topic has
    -- seen fresh activity AND gone idle again past this watermark — so an
    -- idle topic the user never returns to is nudged at most once per pick.
    last_activity_at_ms TEXT,
    -- ISO-8601 UTC, stamped on every write.
    updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_proactive_topic_state_project
    ON proactive_topic_state (project_slug);
