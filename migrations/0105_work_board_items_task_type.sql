-- 0105_work_board_items_task_type.sql
--
-- Work Board (#379, WAVE 3.5) — a per-card TASK TYPE so a ▶ (play) / job
-- dispatch routes BY WHAT THE WORK IS, not by assuming every card is a Trident
-- build. 0090 modelled a card as build-only work; the SPEC decision
-- (2026-07-20 "Work Board: 'trackable work' ≠ 'a Trident build run'") makes a
-- card trackable work of EITHER kind:
--
--   * 'build'    — code work; the ▶ button dispatches the autonomous
--                  Forge→Argus→merge Trident loop (the pre-existing behaviour,
--                  hence the DEFAULT so every legacy row stays a build).
--   * 'research' — investigation / analysis / writing; the ▶ button dispatches
--                  the background ATLAS specialist via agent-dispatch instead.
--
-- Migration mechanics: `work_board_items` is a STRICT table (0090/0097). A
-- STRICT table accepts a plain forward-only `ALTER TABLE ... ADD COLUMN` for a
-- NOT NULL column WITH a constant default (mirrors 0088/0093), and a column-level
-- CHECK is permitted on ADD COLUMN. No table rebuild is needed (we are widening
-- with a new column, not altering an existing column's CHECK the way 0097 did).
--
-- Forward-only; no down-migration (Neutron OSS contract).
--
-- SNAPSHOT REGEN REQUIRED: this ADD COLUMN changes the `work_board_items` table
-- shape, so `migrations/expected-schema.txt` MUST be regenerated
-- (`bun run migrations/regen-snapshot.ts`) and committed alongside this file or
-- `migrations/snapshot.test.ts` fails with schema drift.

ALTER TABLE work_board_items
    ADD COLUMN task_type TEXT NOT NULL DEFAULT 'build'
        CHECK (task_type IN ('build', 'research'));
