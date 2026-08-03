-- 0112_project_launcher_entries.sql
--
-- Per-project persistence for the Apps launcher — the grid of installed Cores'
-- tiles behind `GET /api/app/projects/<id>/launcher`.
--
-- WHY THIS EXISTS. The launcher surface shipped with exactly one store
-- implementation, `InMemoryProjectLauncherStore`, and the production composer
-- never constructed it at all, so every launcher route 404'd in every install
-- (ISSUES #447). Mounting the surface against the in-memory store would have
-- traded a 404 for something worse: a rename or a drag-reorder that silently
-- forgets itself on the next gateway restart. A 404 is at least honest. This
-- table is what makes the mount truthful.
--
-- WHAT IS STORED — CUSTOMISATION, NOT THE CATALOGUE. The set of tiles is
-- DERIVED from the live bundled-Cores registry at read time
-- (`deriveLauncherSeedFromBundledCores`), never from this table. What persists
-- here is only what the OWNER changed: the order they dragged tiles into, the
-- names they renamed, and the tiles they removed from this project's grid.
--
-- That split is deliberate. If the catalogue itself were persisted, a Core
-- installed after a project's first write would never appear in that project's
-- launcher — the row set would have frozen the day it was materialised. Reading
-- the catalogue live and overlaying stored customisation means new Cores show
-- up, and the owner's arrangement survives.
--
-- READS MUST NOT WRITE (ISSUES #412). Rows are materialised on the first
-- MUTATION for a project, never on a read. The sibling settings store learned
-- this the hard way on 2026-07-28: it seeded on GET, which quietly turned
-- `GET /api/app/projects/<any id>/settings` into a project-CREATION endpoint,
-- and one stray mobile tap manufactured a permanent phantom project in the
-- owner's instance. A launcher read is far more frequent than a settings read,
-- so the same mistake here would be correspondingly worse.
--
-- `uninstalled` is a per-project TILE removal, not a Core uninstall. It hides
-- the tile from THIS project's grid and deliberately does not touch any Core
-- installation record — the surface's contract calls this out, and cross-project
-- uninstall is a separate concern.
--
-- Keyed by (project_slug, project_id, slug) to match the store interface, whose
-- every method takes the project_slug/project_id pair.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE IF NOT EXISTS project_launcher_entries (
  project_slug   TEXT    NOT NULL,
  project_id     TEXT    NOT NULL,
  slug           TEXT    NOT NULL,
  -- NULL = no rename; the tile shows the Core's own label from the registry.
  display_name   TEXT,
  -- Position within the project's grid, 0-based and contiguous after any
  -- mutation. Rows materialised together are numbered in catalogue order.
  reorder_index  INTEGER NOT NULL,
  -- 1 = the owner removed this tile from THIS project's grid.
  uninstalled    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_slug, project_id, slug)
) STRICT;

-- The only read pattern is "every row for one project, in grid order".
CREATE INDEX IF NOT EXISTS idx_project_launcher_entries_project
  ON project_launcher_entries (project_slug, project_id, reorder_index);
