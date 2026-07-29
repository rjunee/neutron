-- 0105_work_board_items_task_type.sql
--
-- Work Board #379 — a card is trackable work, NOT necessarily a Trident BUILD.
-- Ryan-locked 2026-07-20 ("Work Board: 'trackable work' ≠ 'a Trident build
-- run'"): any substantial/multi-step work — research, analysis, deep work, OR a
-- build — leaves a card, and the ▶/play button must route BY TASK TYPE
-- (research/analysis → Atlas via agent-dispatch; build → Trident). Before this
-- column every ▶ stamped a Trident build on everything.
--
-- `task_type` is the routing discriminator:
--   * 'build'    — the ▶ dispatches an autonomous Forge→Argus→merge Trident run
--                  (the pre-existing behaviour; the DEFAULT so every legacy row
--                  and every un-annotated create keeps working unchanged).
--   * 'research' — the ▶ dispatches an Atlas research/analysis agent
--                  (agent-dispatch), whose result is delivered back to the chat
--                  and which marks the card terminal on completion.
--
-- ADD COLUMN with a non-null DEFAULT + CHECK is allowed on a STRICT table (no
-- table rebuild needed — unlike 0097's CHECK-widen), so every existing row is
-- backfilled to 'build' in place.
--
-- Forward-only; no down-migration (Neutron OSS contract).

ALTER TABLE work_board_items
    ADD COLUMN task_type TEXT NOT NULL DEFAULT 'build'
        CHECK (task_type IN ('build', 'research'));
