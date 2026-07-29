-- 0001_code_tasks_settings_transcripts_audit.sql — Code-Gen Core S1
-- per-project sidecar schema.
--
-- Per docs/plans/code-gen-core-tier1-brief.md § 6.2. Tables:
--   code_tasks — one row per dispatched code-gen task.
--   code_settings — singleton per-project; HOLDS THE AUTO-MERGE GATE.
--   code_subagent_transcripts — one row per Forge / Argus / judge fire.
--   code_merge_audit — one row per successful PR merge.
--   code_gen_meta — schema version + project_id mismatch guard.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere) so a
-- re-run is a no-op.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS code_tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  request_json    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  runner_kind     TEXT NOT NULL DEFAULT 'runtime' CHECK (runner_kind IN ('runtime', 'in_memory', 'skeleton')),
  branch          TEXT,
  pr_number       INTEGER,
  worktree        TEXT,
  summary         TEXT,
  error_code      TEXT,
  error_message   TEXT,
  subagent_run_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_tasks_project_status_updated
  ON code_tasks(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS code_settings (
  project_id          TEXT PRIMARY KEY,
  automerge_enabled   INTEGER NOT NULL DEFAULT 0,
  default_branch      TEXT NOT NULL DEFAULT 'main',
  repo_slug           TEXT,
  gh_owner            TEXT,
  max_argus_rounds    INTEGER NOT NULL DEFAULT 8,
  subagent_timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS code_subagent_transcripts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT,
  role            TEXT NOT NULL CHECK (role IN ('forge', 'argus', 'forge_fix', 'judge', 'breaks_analysis')),
  round           INTEGER NOT NULL DEFAULT 1,
  prompt_hash     TEXT NOT NULL,
  response_excerpt TEXT,
  model           TEXT NOT NULL,
  fired_at        INTEGER NOT NULL,
  completed_at    INTEGER,
  outcome         TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled', 'timed_out')),
  subagent_run_id TEXT,
  FOREIGN KEY (task_id) REFERENCES code_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transcripts_task
  ON code_subagent_transcripts(task_id, fired_at DESC);

CREATE TABLE IF NOT EXISTS code_merge_audit (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT,
  pr_number           INTEGER NOT NULL,
  merge_strategy      TEXT NOT NULL DEFAULT 'squash',
  merged_at           INTEGER NOT NULL,
  who_confirmed       TEXT NOT NULL CHECK (who_confirmed IN ('user_confirm_token', 'automerge_gate', 'mcp_tool_confirm')),
  gh_response_excerpt TEXT,
  FOREIGN KEY (task_id) REFERENCES code_tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_audit_merged_at
  ON code_merge_audit(merged_at DESC);

CREATE TABLE IF NOT EXISTS code_gen_meta (
  schema_version  INTEGER NOT NULL,
  project_id      TEXT NOT NULL,
  initialised_at  INTEGER NOT NULL
);
