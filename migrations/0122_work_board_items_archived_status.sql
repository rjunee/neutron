-- 0122_work_board_items_archived_status.sql
--
-- Work Board card removal (#268) — a SHELVED lane. 0097 left `status` at
-- ('upcoming','in_progress','done','failed'), which meant the only lever for
-- taking a card OFF the active board without deleting it was `done`. On
-- 2026-08-14 the owner asked for four deprioritised email cards to come off the
-- board and the agent had to mark them `done` — four unshipped items now read
-- as shipped. An agent whose only way to obey is to misreport status produces a
-- board that cannot be trusted.
--
-- This adds a fifth lane, 'archived' (the owner-facing word is "Shelved"):
--   * DONE means SHIPPED. It stamps `completed_at`, it lands in the collapsed
--     Done history, and it counts as progress.
--   * ARCHIVED means PARKED. It NEVER stamps `completed_at`, it appears in no
--     completed list / Done count / Done render anywhere the board reports
--     progress, and it leaves the active lane (so it is out of `listActive`,
--     `listAllActive`, the per-turn prompt fragment, and the reorder lane).
--     Un-shelving re-appends it to the END of the active lane.
-- Unlike 'failed' (run-driven, terminal-reconcile-only), 'archived' IS
-- client-writable: it is the deprioritise lever, so both the agent tool and the
-- HTTP surface accept it — refused only while the card's bound run is LIVE.
--
-- SQLite cannot ALTER a CHECK constraint on a STRICT table, so the whole table
-- is rebuilt (CREATE new → INSERT SELECT → DROP → RENAME) with the widened
-- CHECK, and the two indexes from 0090 are recreated. 0105's `task_type` column
-- (added in place, ADD COLUMN with a non-null DEFAULT + CHECK being legal on a
-- STRICT table) is carried into the rebuilt definition unchanged. There are no
-- inbound foreign keys to work_board_items, but we still disable foreign_keys
-- for the rebuild for parity with the other table-rebuild migrations (0097,
-- 0053); the runner hoists this leading PRAGMA out of the transaction and
-- re-asserts foreign_keys=ON after commit.
--
-- Forward-only; no down-migration (Neutron OSS contract).

PRAGMA foreign_keys = OFF;

CREATE TABLE work_board_items_new (
    id              TEXT PRIMARY KEY NOT NULL,      -- ULID
    project_slug    TEXT NOT NULL,
    title           TEXT NOT NULL,                  -- ONE line (stripped + capped at the store)
    status          TEXT NOT NULL DEFAULT 'upcoming'
                        CHECK (status IN ('upcoming', 'in_progress', 'done', 'failed', 'archived')),
    sort_order      INTEGER NOT NULL,
    design_doc_ref  TEXT,
    inline_active   INTEGER NOT NULL DEFAULT 0
                        CHECK (inline_active IN (0, 1)),
    linked_run_id   TEXT,
    created_at      TEXT NOT NULL,                  -- ISO-8601 UTC
    updated_at      TEXT NOT NULL,                  -- ISO-8601 UTC
    completed_at    TEXT,                           -- ISO-8601 UTC; NULL until status='done' (NEVER stamped for 'archived')
    task_type       TEXT NOT NULL DEFAULT 'build'   -- 0105 — the ▶ routing discriminator
                        CHECK (task_type IN ('build', 'research'))
) STRICT;

INSERT INTO work_board_items_new
    SELECT id, project_slug, title, status, sort_order, design_doc_ref,
           inline_active, linked_run_id, created_at, updated_at, completed_at,
           task_type
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
