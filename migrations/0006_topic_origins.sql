-- 0006_topic_origins.sql
--
-- Sprint 9 (P1 S6) — Argus r1 IMPORTANT (I1) fix: when a solo project is
-- promoted to a workspace, the workspace topic gets a synthetic
-- `(channel_kind='workspace_internal', channel_topic_id=<UUID>)` binding
-- so two members' projects with the same original channel_topic_id can
-- coexist (see 0005). The original native binding is captured here so
-- reverse-promote can RESTORE it on the recipient side rather than
-- creating a brand-new synthetic binding (which loses the recipient's
-- conversation-history channel anchor).
--
-- Schema lives in EVERY per-project DB (user + workspace) but is only
-- written by workspace instances — promote.ts inserts a row per
-- workspace-topic into the workspace DB at solo→group time.
-- reverse-promote.ts reads the row when the recipient slug matches
-- `origin_user_instance_slug` and re-uses the original binding on the
-- recipient's side. When recipient ≠ origin (a non-owner inheriting),
-- the read falls through to the existing synthetic shape — that
-- recipient has no native binding to preserve.
--
-- Forward-only. Idempotent.

CREATE TABLE IF NOT EXISTS topic_origins (
    -- The workspace-side topic id (the new UUID minted by promote.ts).
    workspace_topic_id TEXT PRIMARY KEY NOT NULL,
    -- Slug of the user instance that originally owned the solo topic.
    origin_user_instance_slug TEXT NOT NULL,
    -- Topic id within the origin user instance DB.
    origin_topic_id TEXT NOT NULL,
    -- The original native channel binding on the solo side; what the
    -- recipient is restored to when they reverse-promote AND match the
    -- origin slug.
    origin_channel_kind TEXT NOT NULL,
    origin_channel_topic_id TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topic_origins_origin_instance
    ON topic_origins(origin_user_instance_slug);
