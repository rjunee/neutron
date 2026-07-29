-- 0090_work_board_items.sql
--
-- Work Board (Phase 1a) — the per-project live work-tracking board that
-- doubles as the orchestrator's EXTERNAL memory.
--
-- The chat orchestrator juggles several features at once and its context
-- window rots; the Work Board moves that state ON DISK so the conversation
-- becomes a thin, disposable query layer. One row == one thing the owner
-- (or the agent) is working on / about to work on / has finished. The board
-- is injected into every orchestrator turn (re-grounding) and shown as a
-- first-class per-project tab (Phase 1b).
--
-- Column rationale:
--
-- * `id` — opaque ULID primary key (sortable, mirrors the `notes` /
--   `comments` stores). The board orders by `sort_order`, not by `id`.
--
-- * `project_slug` — instance scoping (the board is keyed by the
--   server-derived instance slug, never a client/agent-supplied value),
--   mirroring `code_trident_runs.project_slug`.
--
-- * `title` — the ONE-line item text (newline-stripped + length-capped at
--   the store layer before it ever reaches here).
--
-- * `status` — the lane: 'upcoming' (backlog) | 'in_progress' (active) |
--   'done' (completed, stays forever in the collapsed history).
--
-- * `sort_order` — a SIMPLE INTEGER with gap-renumber on reorder (NOT a
--   fractional REAL — the deepen simplicity cut). Append-at-end is
--   MAX(sort_order)+1; both the append read-compute-write and the reorder
--   renumber are wrapped in `db.transaction()` at the store layer because a
--   bare `.get()` read bypasses the write mutex (race under N-parallel).
--
-- * `design_doc_ref` — optional pointer (URL or in-app docs deep-link) to
--   the full design doc for a one-line item. Scheme allow-listed at WRITE
--   time (https + the in-app docs scheme only; javascript:/data:/file:
--   rejected).
--
-- * `inline_active` — a lightweight 0/1 marker that inline (in-topic) work
--   is live on this item (Ryan's distinct inline-icon requirement). Heavier
--   sub-agent activity is DERIVED via a join on `linked_run_id` →
--   `code_trident_runs` (Phase 2), NOT stored here — so there is no
--   duplicated `subagent_status` to reconcile.
--
-- * `linked_run_id` — the `code_trident_runs.id` bound to this item when a
--   trident run is working it (Phase 2 binds it; Phase 1a just lands the
--   column + its partial index so the harvest/reconcile path needs no
--   schema change).
--
-- * `created_at` / `updated_at` / `completed_at` — ISO-8601 UTC TEXT
--   timestamps (match the 0077 / 0032 convention, NOT epoch INTEGER).
--   `completed_at` is stamped when status->done and nulled on any re-open
--   OFF done.
--
-- Indexes:
--   * the list path → (project_slug, status, sort_order).
--   * the harvest/reconcile path → partial (linked_run_id) WHERE bound.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE work_board_items (
    id              TEXT PRIMARY KEY NOT NULL,      -- ULID
    project_slug    TEXT NOT NULL,
    title           TEXT NOT NULL,                  -- ONE line (stripped + capped at the store)
    status          TEXT NOT NULL DEFAULT 'upcoming'
                        CHECK (status IN ('upcoming', 'in_progress', 'done')),
    sort_order      INTEGER NOT NULL,
    design_doc_ref  TEXT,
    inline_active   INTEGER NOT NULL DEFAULT 0
                        CHECK (inline_active IN (0, 1)),
    linked_run_id   TEXT,
    created_at      TEXT NOT NULL,                  -- ISO-8601 UTC
    updated_at      TEXT NOT NULL,                  -- ISO-8601 UTC
    completed_at    TEXT                            -- ISO-8601 UTC; NULL until status='done'
) STRICT;

-- The list path scans one project's board ordered by lane + position.
CREATE INDEX idx_work_board_items_list
    ON work_board_items (project_slug, status, sort_order);

-- The Phase-2 harvest/reconcile path correlates a terminal trident run back
-- to its board item; a partial index keeps that lookup flat-cost as the
-- (mostly NULL) column fills in only for in-flight items.
CREATE INDEX idx_work_board_items_linked_run
    ON work_board_items (linked_run_id)
    WHERE linked_run_id IS NOT NULL;
