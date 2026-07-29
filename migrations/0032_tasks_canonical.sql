-- 0032_tasks_canonical.sql
--
-- P6.0 — canonical per-project task DB substrate.
--
-- Per docs/engineering-plan.md § B.P6 the task system overhaul promotes
-- tasks to a single source of truth: STATUS.md / SAM-ACTIONS.md
-- become auto-generated read-only projections, agents + UI + CLI +
-- reminders all write through one schema, and project-scoped tasks
-- are primary.
--
-- This sprint (P6.0) lands ONLY the substrate base: the table, indexes,
-- and a TaskStore wrapper in `tasks/`. STATUS.md projection, nudge
-- engine, staleness engine, task-styles UI, overnight-work integration,
-- and migrating the Tier 1 `cores/free/tasks` Core to point at this
-- canonical store are all explicit follow-up sprints.
--
-- Co-existence with `cores/free/tasks`: the Tier 1 Tasks Core ships its
-- own in-memory `TaskStore` today and writes to a sidecar SQLite
-- (`<dataDir>/cores/tasks_core.db`). That Core lives in a different
-- data namespace (its sidecar DB) from this canonical table — they do
-- not conflict. A follow-up P6 sprint migrates the Core's adapter to
-- target this table; until then both coexist without runtime overlap.
--
-- Schema decisions (locked in the sprint brief):
--
-- * `project_slug NOT NULL` — even though the table lives in the
--   per-project DB, we mirror the redundant-but-defensive pattern used
--   by `sessions`, `topics`, etc. so a cross-instance audit / Zone A
--   inspector can verify rows.
--
-- * `project_id NOT NULL DEFAULT ''` — project-scoped tasks are primary
--   per locked answer #2. An empty string is the canonical "no project"
--   sentinel (mirrors the launcher's "global" tab). NOT NULL keeps the
--   project-scoping index dense and write paths simple — every reader
--   filters by project_id without a NULL branch.
--
-- * `status` enum is the minimal viable set: 'open' | 'done' |
--   'cancelled'. The engineering plan mentions an 'archived' /
--   'snoozed' future state — those land in a later migration when the
--   staleness engine + snooze UX ship.
--
-- * `priority` is a nullable INTEGER 0-3 (0 = none, 3 = highest). The
--   nudge engine ranks across the instance; the integer slot is a
--   storage primitive, not a UX surface yet.
--
-- * `due_date` is a TEXT ISO-8601 string (sortable lexicographically,
--   reminder-integration-friendly). Nullable for tasks without a
--   deadline.
--
-- * `owner_persona` and `source` are nullable TEXT — owner_persona
--   tracks which persona (SOUL/USER) created the task; source records
--   the entry point (`agent`, `chat`, `app`, `cli`, `reminder`,
--   `overnight`). Both are non-canonical metadata, but cheap to land
--   now because § B.P6 names them explicitly.
--
-- * `created_at` / `updated_at` / `completed_at` are TEXT ISO-8601
--   strings — matches the `cores/free/tasks` Core's TaskRow shape so a
--   later adapter swap doesn't need a value translation layer. The
--   store stamps these on every write; SQLite's STRICT mode enforces
--   the TEXT type.
--
-- Indexes match the two read paths we expect today:
--   * project tab + status filter → `(project_slug, project_id, status)`
--   * cross-project "due soon" rollup → `(project_slug, due_date)`
--
-- Forward-only.

CREATE TABLE tasks (
    id              TEXT PRIMARY KEY NOT NULL,
    project_slug     TEXT NOT NULL,
    project_id      TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'done', 'cancelled')),
    priority        INTEGER
                        CHECK (priority IS NULL OR (priority >= 0 AND priority <= 3)),
    due_date        TEXT,                                       -- ISO-8601; nullable
    owner_persona   TEXT,
    source          TEXT,                                       -- 'agent' | 'chat' | 'app' | 'cli' | 'reminder' | 'overnight' | ...
    created_at      TEXT NOT NULL,                              -- ISO-8601 UTC
    updated_at      TEXT NOT NULL,                              -- ISO-8601 UTC
    completed_at    TEXT                                        -- ISO-8601 UTC; NULL until status='done'
) STRICT;

CREATE INDEX idx_tasks_project_slug_project_status
    ON tasks (project_slug, project_id, status);

CREATE INDEX idx_tasks_project_due_date
    ON tasks (project_slug, due_date)
    WHERE due_date IS NOT NULL;
