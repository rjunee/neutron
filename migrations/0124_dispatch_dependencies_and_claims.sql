-- 0124_dispatch_dependencies_and_claims.sql
--
-- DEPENDENCY-AWARE DISPATCH — "trident never fans out onto an unmet dependency
-- or a file another in-flight build already owns".
--
-- MEASURED on 2026-08-16: the owner wants 5 concurrent builds tonight, scaling to
-- 10 on an 8-core box. Concurrency is unsafe today for one specific reason — two
-- builds that touch the SAME file both build, both reach publish, and the loser
-- pays a full rebuild. PR #289 (test-execution strategy) and PR #306 (as-built
-- enforcement) both edit `trident/inner-workflow.mjs`; the ONLY thing that
-- prevented that collision was a human noticing and hand-serialising the two
-- lanes. That does not scale to 10 lanes, and the owner explicitly does not want
-- to hand-serialise.
--
-- This migration lands the three columns/tables the dispatch chokepoint
-- (`trident/board-dispatch.ts`) needs to make the decision itself:
--
--  1. `work_board_items.blockers` — the card's DECLARED dependencies (compact
--     JSON array of sibling card ids; NULL = none). The chokepoint refuses to
--     start a card while any declared blocker card exists with `status != 'done'`.
--
--  2. `code_trident_runs.claimed_paths` — the set of repo-relative paths the
--     dispatch derived (from the card's task text + its plan doc) at CREATE time,
--     as compact JSON. WRITE-ONCE at insert: nothing updates it, ever.
--
--     RELEASE IS BY LIVENESS QUERY, NOT BY AN EXPLICIT CLEAR. Readers consider
--     ONLY rows whose `phase NOT IN ('done','failed','stopped')`
--     (`TridentRunStore.listNonTerminalByRepo`), so a run going terminal — by
--     harvest, by `/code stop`, by crash-reap, by anything — releases its claim BY
--     DEFINITION. There is deliberately NO release write anywhere in the codebase,
--     which is what makes "a crashed run cannot strand a claim / a stuck claim
--     cannot wedge the queue forever" structurally true rather than merely tested.
--     A legacy row (NULL) claims nothing.
--
--  3. `code_trident_dispatch_holds` — the QUEUE. A dispatch blocked by (1) or (2)
--     is HELD, not rejected: it writes ZERO `code_trident_runs` state (preserving
--     the chokepoint's existing "a rejected dispatch leaves no state" invariant)
--     and upserts exactly one row here, keyed `(project_slug, board_item_id)`. A
--     trident terminal observer (`buildDispatchHoldSweep`, composed AFTER the
--     board reconcile so a blocker card's `status='done'` is already written)
--     re-runs each held card back through the SAME chokepoint, so every gate
--     re-evaluates and a still-held card just refreshes its row. `payload` carries
--     the originating chat/thread/channel + round caps so the auto-fired build
--     reports back to the place the human dispatched it from.
--
-- STRICT-table-safe: two nullable ADD COLUMNs (no literal default needed). Note
-- ALTER TABLE ADD COLUMN is not idempotent in SQLite — that is the house practice
-- 0122/0123 already ship (the runner records applied versions in `_migrations`, so
-- a migration never re-applies). Forward-only; no down-migration (Neutron OSS
-- contract).

ALTER TABLE work_board_items
    ADD COLUMN blockers TEXT;

ALTER TABLE code_trident_runs
    ADD COLUMN claimed_paths TEXT;

CREATE TABLE IF NOT EXISTS code_trident_dispatch_holds (
    id                TEXT PRIMARY KEY,
    project_slug      TEXT NOT NULL,
    board_item_id     TEXT NOT NULL,
    task              TEXT NOT NULL,
    payload           TEXT,
    claimed_paths     TEXT,
    hold_kind         TEXT NOT NULL CHECK (hold_kind IN ('blocker', 'path')),
    hold_reason       TEXT NOT NULL,
    held_on_run_id    TEXT,
    held_on_blocker_id TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

-- ONE hold per card: the upsert conflict target, and the reason a card that is
-- re-dispatched (and re-held) refreshes its hold instead of queueing twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trident_dispatch_holds_item
    ON code_trident_dispatch_holds (project_slug, board_item_id);
