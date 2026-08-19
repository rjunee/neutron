-- 0132_work_board_items_dependencies.sql
--
-- Dependency-aware dispatch — the stacked-branch problem is a scheduling
-- problem, not a git problem. Cards need to record both the same-board cards
-- that must land first and the paths/globs they expect to touch so later
-- dispatch gates can serialize real dependencies and file contention while
-- every build continues to start from main.
--
-- `blocked_by` is a JSON array of same-board card ids; NULL means no blockers.
-- `declared_surfaces` is a JSON array of path/glob strings; NULL means
-- UNDECLARED. A later gate treats undeclared as touching everything — this
-- migration and the store only record that distinction.
--
-- ADD COLUMN of a nullable TEXT is allowed on a STRICT table (no table rebuild
-- needed). JSON shape and dependency-graph integrity are validated atomically
-- at the store layer.
--
-- Forward-only; no down-migration (Neutron OSS contract).

ALTER TABLE work_board_items ADD COLUMN blocked_by TEXT;
ALTER TABLE work_board_items ADD COLUMN declared_surfaces TEXT;
