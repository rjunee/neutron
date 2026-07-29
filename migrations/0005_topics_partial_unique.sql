-- 0005_topics_partial_unique.sql
--
-- Sprint 9 (P1 S6) — Codex r1 P1 finding fix: convert
-- `idx_topics_channel_binding` from a full unique index over
-- (channel_kind, channel_topic_id) to a PARTIAL unique index that ignores
-- archived rows.
--
-- Rationale: routing only consults active topics, so an archived row with
-- the same channel_topic_id as a freshly-restored topic must not block
-- the new INSERT. Per the reverse-promote flow (workspace → recipient),
-- the recipient's per-project DB still holds the original archived rows
-- from the prior solo→group promote; without this change the
-- workspace→solo handoff fails with a UNIQUE collision before the
-- workspace rows are archived.
--
-- Forward-only. NEVER edit prior migrations.
-- The migration runner wraps the body in BEGIN/COMMIT atomically.

DROP INDEX IF EXISTS idx_topics_channel_binding;

CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_channel_binding
    ON topics(channel_kind, channel_topic_id)
    WHERE status != 'archived';
