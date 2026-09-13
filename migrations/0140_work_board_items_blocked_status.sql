-- 0140_work_board_items_blocked_status.sql
--
-- STOP AND ESCALATE — a BLOCKED lane, so "nobody can build this yet" stops
-- reading as "this build broke".
--
-- A trident run that stops because its PLAN cannot succeed — a reviewer proved
-- the design was wrong, the card needs work that lives outside it, or the same
-- finding survived a fix round — has had exactly one terminal lane to land in:
-- 'failed' (0097, run-driven, written only by the terminal reconcile). So the
-- card that most needs the owner to SEQUENCE something ahead of it looked
-- identical to a card whose build crashed, and the two earn opposite responses.
-- Worse is the alternative the reconcile would otherwise take: leaving the card
-- in 'upcoming', where it sits at the top of the active lane LOOKING STARTABLE
-- and the next dispatch picks it up again to re-learn the same block.
--
-- This adds a sixth lane, 'blocked':
--   * FAILED means the build BROKE. Retry is the action.
--   * BLOCKED means the build STOPPED ON PURPOSE and reported why. A decision or
--     a dependency is the action; retrying first changes nothing.
-- Like 'failed' and UNLIKE 'archived', it is RUN-DRIVEN and NOT client-writable:
-- neither the agent tool (`work-board/agent-tool.ts` STATUS_VALUES) nor the HTTP
-- surface (`gateway/http/work-board-surface.ts`) accepts it, because the RUN
-- REPORTS and the ORCHESTRATOR DECIDES — a build that could put cards into a
-- lane of its own choosing is a build re-prioritising the owner's queue.
-- It is an ACTIVE lane (not done/archived): the card stays in `listActive`, keeps
-- its `sort_order`, and never stamps `completed_at` — it is unfinished work that
-- is waiting, not work that ended.
--
-- SQLite cannot ALTER a CHECK constraint on a STRICT table, so the whole table is
-- rebuilt (CREATE new → INSERT SELECT → DROP → RENAME) with the widened CHECK and
-- the two indexes from 0090 recreated — the same shape as 0097 and 0130. The
-- columns added in place since 0130 (0132's `blocked_by`/`declared_surfaces`,
-- 0133's `pr`/`pr_url`, 0139's `blockers`) are carried into the rebuilt definition
-- unchanged. A rebuild DROPS the old table, so a column omitted from the SELECT is
-- DELETED DATA, not a lint error — `migrations/expected-schema.txt` is what catches
-- it, and it caught exactly that for `blockers` while this migration was written.
--
-- NOTE ON TWO SIMILAR NAMES, because they are NOT the same thing and a reader
-- will meet both (three, in fact): `blocked_by` (0132) and `blockers` (0139) are
-- DEPENDENCY EDGES — JSON arrays of same-board card ids a dispatch gate reads
-- BEFORE a build starts. `status = 'blocked'` is a LANE — where a card lands AFTER
-- a build stopped and said it could not proceed. A card can be in any of them
-- without the others.
--
-- There are no inbound foreign keys to work_board_items, but foreign_keys is
-- still disabled for the rebuild for parity with the other table-rebuild
-- migrations (0130, 0097, 0053); the runner hoists this leading PRAGMA out of the
-- transaction and re-asserts foreign_keys=ON after commit.
--
-- Forward-only; no down-migration (Neutron OSS contract).

PRAGMA foreign_keys = OFF;

CREATE TABLE work_board_items_new (
    id                 TEXT PRIMARY KEY NOT NULL,   -- ULID
    project_slug       TEXT NOT NULL,
    title              TEXT NOT NULL,               -- ONE line (stripped + capped at the store)
    status             TEXT NOT NULL DEFAULT 'upcoming'
                           CHECK (status IN ('upcoming', 'in_progress', 'done', 'failed', 'archived', 'blocked')),
    sort_order         INTEGER NOT NULL,
    design_doc_ref     TEXT,
    inline_active      INTEGER NOT NULL DEFAULT 0
                           CHECK (inline_active IN (0, 1)),
    linked_run_id      TEXT,
    created_at         TEXT NOT NULL,               -- ISO-8601 UTC
    updated_at         TEXT NOT NULL,               -- ISO-8601 UTC
    completed_at       TEXT,                        -- ISO-8601 UTC; NULL until status='done' (NEVER stamped for 'archived' or 'blocked')
    task_type          TEXT NOT NULL DEFAULT 'build'  -- 0105 — the ▶ routing discriminator
                           CHECK (task_type IN ('build', 'research')),
    blocked_by         TEXT,                        -- 0132 — JSON array of same-board card ids
    declared_surfaces  TEXT,                        -- 0132 — JSON array of path/glob strings
    pr                 INTEGER,                     -- 0133 — durable PR provenance
    pr_url             TEXT,                        -- 0133 — composed PR link
    blockers           TEXT                         -- 0139 — JSON array of sibling card ids the dispatch chokepoint gates on
) STRICT;

INSERT INTO work_board_items_new
    SELECT id, project_slug, title, status, sort_order, design_doc_ref,
           inline_active, linked_run_id, created_at, updated_at, completed_at,
           task_type, blocked_by, declared_surfaces, pr, pr_url, blockers
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
