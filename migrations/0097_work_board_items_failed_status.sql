-- 0097_work_board_items_failed_status.sql
--
-- Work Board build-lifecycle (#340) — a FAILED lane for a bound trident run
-- that reached a terminal FAILURE. 0090 constrained `status` to
-- ('upcoming','in_progress','done'), so a failed run had nowhere to land: the
-- terminal reconcile (`WorkBoardStore.detachRun`) reverted the item to
-- 'upcoming' AND cleared `linked_run_id`, which showed the item as a grey,
-- never-started card and lost the failure entirely (the run's `failure_reason`,
-- the red dot, the retry affordance).
--
-- This adds a fourth lane, 'failed'. On a failed run the reconcile now sets
-- status='failed' and KEEPS `linked_run_id` set, so the client derives a red
-- dot + "Failed" tag + the run's `failure_reason` one-liner from the still-bound
-- run's `run_progress` (`trident/run-progress.ts` already yields
-- step_label='failed'), and the ▶/↻ retry re-dispatches against the same card.
-- A 'failed' item stays OUT of the collapsed done-history (it is `status != done`,
-- so it lists in the active lane, re-actionable).
--
-- SQLite cannot ALTER a CHECK constraint on a STRICT table, so the whole table is
-- rebuilt (CREATE new → INSERT SELECT → DROP → RENAME) with the widened CHECK, and
-- the two indexes from 0090 are recreated. There are no inbound foreign keys to
-- work_board_items, but we still disable foreign_keys for the rebuild for parity
-- with the other table-rebuild migrations (0053); the runner hoists this leading
-- PRAGMA out of the transaction and re-asserts foreign_keys=ON after commit.
--
-- Forward-only; no down-migration (Neutron OSS contract).

PRAGMA foreign_keys = OFF;

CREATE TABLE work_board_items_new (
    id              TEXT PRIMARY KEY NOT NULL,      -- ULID
    project_slug    TEXT NOT NULL,
    title           TEXT NOT NULL,                  -- ONE line (stripped + capped at the store)
    status          TEXT NOT NULL DEFAULT 'upcoming'
                        CHECK (status IN ('upcoming', 'in_progress', 'done', 'failed')),
    sort_order      INTEGER NOT NULL,
    design_doc_ref  TEXT,
    inline_active   INTEGER NOT NULL DEFAULT 0
                        CHECK (inline_active IN (0, 1)),
    linked_run_id   TEXT,
    created_at      TEXT NOT NULL,                  -- ISO-8601 UTC
    updated_at      TEXT NOT NULL,                  -- ISO-8601 UTC
    completed_at    TEXT                            -- ISO-8601 UTC; NULL until status='done'
) STRICT;

INSERT INTO work_board_items_new
    SELECT id, project_slug, title, status, sort_order, design_doc_ref,
           inline_active, linked_run_id, created_at, updated_at, completed_at
      FROM work_board_items;

DROP TABLE work_board_items;

ALTER TABLE work_board_items_new RENAME TO work_board_items;

-- The list path scans one project's board ordered by lane + position.
CREATE INDEX idx_work_board_items_list
    ON work_board_items (project_slug, status, sort_order);

-- The Phase-2 harvest/reconcile path correlates a terminal trident run back
-- to its board item; a partial index keeps that lookup flat-cost.
CREATE INDEX idx_work_board_items_linked_run
    ON work_board_items (linked_run_id)
    WHERE linked_run_id IS NOT NULL;
