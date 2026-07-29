-- 0007_reverse_promotions.sql
--
-- Sprint 9 (P1 S6) — Codex r2 P2 fix-up: reverse-promote retry safety.
--
-- `reverse-promote.ts` writes recipient topics in step 1 + archives
-- workspace topics in step 2. If step 2 fails after step 1 commits, a
-- retry would re-read the still-active workspace topics + INSERT a
-- second set of recipient rows, duplicating the project on the
-- recipient side. This per-instance table is the recipient-side
-- idempotency record: source workspace_topic_id ⇒ the local topic id
-- that step 1 committed. On retry, reverse-promote consults this table
-- and reuses the prior mapping instead of minting a fresh one.
--
-- Schema lives on EVERY per-project DB but is only written to by user-
-- instance DBs that receive a reverse-promote. Workspace DBs land it
-- empty.
--
-- Forward-only. Idempotent.

CREATE TABLE IF NOT EXISTS reverse_promotions (
    -- Primary key — the WORKSPACE-side topic id that this recipient
    -- topic was migrated from. Lookup key on retry.
    source_workspace_topic_id TEXT PRIMARY KEY NOT NULL,
    -- Slug of the source workspace instance the topic came from.
    source_workspace_instance_slug TEXT NOT NULL,
    -- The recipient's local topic id minted by step 1. Reused on retry.
    recipient_topic_id TEXT NOT NULL,
    -- The recipient's local project_id minted by step 1. Reused on
    -- retry so a second call does NOT generate a fresh project id.
    recipient_project_id TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reverse_promotions_recipient_project
    ON reverse_promotions(recipient_project_id);
