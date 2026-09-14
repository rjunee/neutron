-- 0142_work_board_zero_ralph_cap.sql
--
-- ZERO IS A CAP, NOT AN ABSENT ONE — resolving the disagreement #728 names.
--
-- Two rules disagreed about `max_ralph_rounds = 0`. The RUN STORE deliberately
-- permits it and says what it means: "0 is allowed and means 'no iterations'"
-- (`TridentInvalidRalphCapError` in `trident/store.ts`), and only an ABSENT cap
-- receives `DEFAULT_MAX_RALPH_ROUNDS` — a present `0` is written through. Migration
-- 0141's CHECK on the CARD said `max_ralph_rounds IS NULL OR >= 1`.
--
-- The disagreement is resolved in the STORE's favour: the cap is a number the owner
-- chose, and "cap this card at nothing" is a coherent thing to ask for, which the
-- dispatch gate already refuses correctly (`0 >= 0` → `ralph_budget_exhausted`).
-- The CHECK is the rule that changes. The alternative — refusing 0 at the store
-- boundary — would contradict an explicit, tested contract in order to preserve a
-- constraint written later and by accident.
--
-- WHY IT MATTERED EVEN THOUGH NOTHING SUPPLIES 0 TODAY. The failing write is the
-- terminal reconcile: `detachRun` persists the run's budget onto the card INSIDE its
-- own transaction, so the disagreement would have surfaced as SQLITE_CONSTRAINT_CHECK
-- at terminal time, in a transaction, on the path that exists to record that a build
-- ENDED. Latent, and in the worst possible place.
--
-- SQLite cannot ALTER a CHECK on a STRICT table, so the whole table is rebuilt
-- (CREATE new → INSERT SELECT → DROP → RENAME) with the widened CHECK, the two
-- indexes from 0090 recreated, and every column carried through unchanged — the same
-- shape as 0140, 0130 and 0097. A rebuild DROPS the old table, so a column omitted
-- from the SELECT is DELETED DATA, not a lint error; `migrations/expected-schema.txt`
-- is what catches that.
--
-- There are no inbound foreign keys to work_board_items, but foreign_keys is still
-- disabled for the rebuild for parity with the other table-rebuild migrations; the
-- runner hoists this leading PRAGMA out of the transaction and re-asserts
-- foreign_keys=ON after commit.
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
    blockers           TEXT,                        -- 0139 — JSON array of sibling card ids the dispatch chokepoint gates on
    ralph_round        INTEGER NOT NULL DEFAULT 0
                           CHECK (ralph_round >= 0),
    max_ralph_rounds   INTEGER
                           CHECK (max_ralph_rounds IS NULL OR max_ralph_rounds >= 0)
) STRICT;

INSERT INTO work_board_items_new
    SELECT id, project_slug, title, status, sort_order, design_doc_ref,
           inline_active, linked_run_id, created_at, updated_at, completed_at,
           task_type, blocked_by, declared_surfaces, pr, pr_url, blockers,
           ralph_round, max_ralph_rounds
      FROM work_board_items;

DROP TABLE work_board_items;

ALTER TABLE work_board_items_new RENAME TO work_board_items;

CREATE INDEX idx_work_board_items_list
    ON work_board_items (project_slug, status, sort_order);

CREATE INDEX idx_work_board_items_linked_run
    ON work_board_items (linked_run_id)
    WHERE linked_run_id IS NOT NULL;
