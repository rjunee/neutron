-- 0085_tasks_llm_priority.sql
--
-- WAVE 3 PR-7 — LLM-primary task prioritization.
--
-- BACKGROUND: the canonical `tasks` table (0032) already carries a
-- deterministic `focus_score` (0037) computed by `tasks/focus-score.ts`
-- and re-converged by the 4-hourly `tasks.focus_score_recompute` cron.
-- That formula is a pure function of (priority, due_date, staleness) —
-- it has no notion of *what the work is*, so two equally-urgent tasks
-- tie on score and sort by recency.
--
-- WAVE 3 promotes prioritization to **LLM-primary**: a per-instance
-- pass (`tasks/prioritize-llm.ts`) hands the open backlog to an LLM
-- which returns an explicit ordering + a one-line rationale per task.
-- The deterministic focus-score becomes the **fallback** ranking used
-- only when no LLM credential is configured, the call errors, or it
-- times out. There is NO flag — LLM-primary is the default behaviour
-- and the deterministic path is a fallback, not a dual code path.
--
-- WHAT THIS ADDS (4 columns on `tasks`):
--
-- * `llm_rank INTEGER` — the 1-based rank assigned by the most recent
--   prioritize pass (1 = do this first). NULL on a row created since
--   the last pass; the `focus_score` order clause treats NULL llm_rank
--   as "rank last, fall back to focus_score" so a fresh task still
--   sorts sensibly until the next pass stamps it. Populated in BOTH the
--   LLM path (from the LLM ordering) and the deterministic fallback
--   (from focus_score DESC) so the render column is single-source.
--
-- * `llm_reason TEXT` — the LLM's one-line rationale for this task's
--   rank ("blocks the launch demo"). NULL in the deterministic fallback
--   (the focus-score formula has no natural-language rationale) and NULL
--   until the first LLM pass.
--
-- * `prioritized_by TEXT CHECK(prioritized_by IN ('llm','deterministic'))`
--   — which mechanism produced this row's current rank. Lets a reader
--   tell an LLM ranking apart from a fallback ranking (telemetry +
--   "ranked by AI" UI affordance) without inferring it from llm_reason
--   being NULL. NULL until the first prioritize pass.
--
-- * `prioritized_at TEXT` — ISO-8601 UTC of the pass that stamped the
--   row. NULL until the first pass. Used for staleness of the ranking
--   itself + cache-key reasoning in the prioritizer.
--
-- The `focus_score` column (0037) is RETAINED unchanged — it remains
-- the fallback ranking signal and the input the LLM prompt shows the
-- model. This migration only layers the LLM dimension on top.
--
-- Forward-only; no down-migration (Neutron OSS contract). Forward-only
-- ADD COLUMN is non-rewriting in SQLite and the new columns default
-- NULL, so existing rows are untouched and the next prioritize pass
-- populates them.

ALTER TABLE tasks ADD COLUMN llm_rank INTEGER;
ALTER TABLE tasks ADD COLUMN llm_reason TEXT;
ALTER TABLE tasks ADD COLUMN prioritized_by TEXT
    CHECK (prioritized_by IN ('llm', 'deterministic'));
ALTER TABLE tasks ADD COLUMN prioritized_at TEXT;  -- ISO-8601 UTC

-- The render order is `llm_rank ASC NULLS LAST, focus_score DESC ...`
-- over the open subset. The partial index keeps that ordering scan
-- cheap on the open backlog even when an instance accumulates thousands
-- of completed rows (mirrors `idx_tasks_project_focus_score`).
CREATE INDEX idx_tasks_project_llm_rank
    ON tasks (project_slug, llm_rank)
    WHERE status = 'open';
