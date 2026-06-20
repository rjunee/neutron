-- 0002_drop_automerge_column.sql — code-gen-core S2.
--
-- Auto-merge default ON. The per-project automerge_enabled gate is
-- removed. Forward-only.
--
-- SQLite does not reliably support `ALTER TABLE ... DROP COLUMN` across
-- the bun:sqlite versions we target (the safe-everywhere path is the
-- recreate-table-and-copy pattern), so this migration:
--   (a) builds `code_settings_new` without the `automerge_enabled`
--       column, copies the kept columns over, drops the old table, and
--       renames the new table into place;
--   (b) recreates `code_merge_audit` to widen the `who_confirmed` CHECK
--       constraint to include the new `'autonomous'` attribution.
--
-- The migration runner (`migrations/runner.ts:applyMigrations`) wraps
-- the body of this file in a single `BEGIN ... COMMIT` and tracks the
-- applied version in `_migrations`, so re-runs are no-ops by version
-- bookkeeping — this SQL itself does NOT carry its own BEGIN/COMMIT
-- (nested transactions are not supported by SQLite).
--
-- Per docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md
-- § "Phase 3 — Auto-merge default ON; drop the gate (Part E)".

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------
-- code_settings: drop the automerge_enabled column.
-- ---------------------------------------------------------------

CREATE TABLE code_settings_new (
  project_id          TEXT PRIMARY KEY,
  default_branch      TEXT NOT NULL DEFAULT 'main',
  repo_slug           TEXT,
  gh_owner            TEXT,
  max_argus_rounds    INTEGER NOT NULL DEFAULT 8,
  subagent_timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  updated_at          INTEGER NOT NULL
);

INSERT INTO code_settings_new (project_id, default_branch, repo_slug,
  gh_owner, max_argus_rounds, subagent_timeout_ms, updated_at)
  SELECT project_id, default_branch, repo_slug, gh_owner,
         max_argus_rounds, subagent_timeout_ms, updated_at
  FROM code_settings;

DROP TABLE code_settings;
ALTER TABLE code_settings_new RENAME TO code_settings;

-- ---------------------------------------------------------------
-- code_merge_audit: widen who_confirmed CHECK to include 'autonomous'.
--
-- The S1 attribution values ('user_confirm_token', 'automerge_gate',
-- 'mcp_tool_confirm') stay in the enum as historical values — the
-- migration is forward-compatible with rows from before S2. New rows
-- post-S2 always use 'autonomous'.
-- ---------------------------------------------------------------

CREATE TABLE code_merge_audit_new (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT,
  pr_number           INTEGER NOT NULL,
  merge_strategy      TEXT NOT NULL DEFAULT 'squash',
  merged_at           INTEGER NOT NULL,
  who_confirmed       TEXT NOT NULL CHECK (who_confirmed IN
    ('user_confirm_token', 'automerge_gate', 'mcp_tool_confirm', 'autonomous')),
  gh_response_excerpt TEXT,
  FOREIGN KEY (task_id) REFERENCES code_tasks(id) ON DELETE SET NULL
);

INSERT INTO code_merge_audit_new (id, task_id, pr_number, merge_strategy,
  merged_at, who_confirmed, gh_response_excerpt)
  SELECT id, task_id, pr_number, merge_strategy, merged_at,
         who_confirmed, gh_response_excerpt
  FROM code_merge_audit;

DROP TABLE code_merge_audit;
ALTER TABLE code_merge_audit_new RENAME TO code_merge_audit;

CREATE INDEX IF NOT EXISTS idx_merge_audit_merged_at
  ON code_merge_audit(merged_at DESC);
