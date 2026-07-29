-- 0019_p2_sean_ellis_prompt_link.sql
--
-- P2 S6 — Codex r4 P1 fix (2026-05-03).
--
-- Two production-flow gaps surfaced by Codex r4:
--
--   1. The Sean Ellis handler emits a button prompt but did NOT persist
--      the resulting prompt_id alongside the open `sean_ellis_responses`
--      row. Real channel callbacks (Telegram callback_query / app-socket)
--      only carry the prompt_id; without a stored mapping there is no
--      way to recover which row to update when the user taps. ADD
--      `prompt_id` + an index so the channel router can resolve.
--
--   2. The [B] (somewhat_disappointed) tap is followed asynchronously
--      by a freeform message. The collector previously finalized the
--      row on the tap alone, setting `responded_at` and closing the
--      door for the freeform to attach. ADD `pending_response_kind`
--      so the collector can record the tap WITHOUT finalizing — when
--      the freeform arrives, the row finalizes with the pending kind.
--
-- Forward-only. Adds two NULLable columns + an index. STRICT-table
-- ALTER ADD COLUMN is supported in SQLite; the CHECK constraint on the
-- existing `response_kind` column is preserved verbatim. No backfill
-- required: existing rows have NULL prompt_id (legacy behavior — the
-- spec'd "we never had a prompt_id" path) and NULL
-- pending_response_kind.

ALTER TABLE sean_ellis_responses ADD COLUMN prompt_id TEXT;
ALTER TABLE sean_ellis_responses ADD COLUMN pending_response_kind TEXT;

CREATE INDEX IF NOT EXISTS sean_ellis_responses_prompt_id
    ON sean_ellis_responses (prompt_id)
    WHERE prompt_id IS NOT NULL;
