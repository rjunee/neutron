-- P6.1 nudge engine + staleness engine substrate (2026-05-23).
--
-- Spec: docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md
--
-- Adds:
--   1. `current_focus_pick` — per-project per-day LLM nudge pick. PK
--      (project_slug, day) so a same-day cron re-run is a no-op via an
--      existence check (the engine reads EXISTS first; only invokes the
--      LLM if no row exists for today). `top_3_task_ids` records the
--      top-3 of the day's slate so the staleness engine can bump
--      `tasks.top3_skip_count` for unpicked-but-top-3 tasks on the next
--      day's tick.
--   2. Three staleness columns on `tasks` so the staleness engine can
--      demote tasks that appear in the top-3 of N consecutive days
--      without ever being picked or resolved. All three default safely
--      so existing rows remain untouched.

CREATE TABLE current_focus_pick (
  project_slug      TEXT NOT NULL,
  -- YYYY-MM-DD in the owner's local timezone (resolved from
  -- `instance_metadata.timezone` at engine invocation; default
  -- America/Los_Angeles when unset).
  day              TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  llm_rationale    TEXT NOT NULL,
  -- JSON array, e.g. '["t1","t2","t3"]'. Server-generated (never
  -- user-supplied) so no injection risk. May contain fewer than 3 ids
  -- when the slate has <3 open tasks; the staleness engine handles
  -- short arrays gracefully.
  top_3_task_ids   TEXT NOT NULL,
  -- ISO-8601 UTC.
  created_at       TEXT NOT NULL,
  -- Model id used for the pick (e.g. `claude-haiku-4-5`). Recorded so
  -- a future re-run can detect model drift.
  llm_model        TEXT NOT NULL,
  -- Anthropic request id (`x-request-id` header) when available;
  -- otherwise NULL. Useful for tracing back to Anthropic-side logs.
  llm_request_id   TEXT,
  PRIMARY KEY (project_slug, day)
);

CREATE INDEX idx_current_focus_pick_project_created
  ON current_focus_pick(project_slug, created_at DESC);

ALTER TABLE tasks ADD COLUMN top3_skip_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN staleness_demoted_at TEXT;
ALTER TABLE tasks ADD COLUMN staleness_demotion_count INTEGER NOT NULL DEFAULT 0;
