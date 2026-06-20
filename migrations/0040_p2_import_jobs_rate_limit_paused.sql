-- 0040_p2_import_jobs_rate_limit_paused.sql
--
-- 2026-05-22 — Sprint: import resilience (v0.1.78).
-- Per docs/plans/2026-05-22-002-fix-import-resilience-plan.md.
--
-- Two concurrent changes to the `import_jobs.status` CHECK constraint:
--
--   1. DROP 'budget-exceeded' — the budget-cap enforcement subsystem was
--      killed entirely (Sam, 2026-05-22): Max-OAuth owners don't pay
--      marginal $-cost, so the prior "we hit a $2/$3.50 cap, asking the
--      user Continue/Stop/Skip" UX is misleading at best and a hard fail
--      at worst. The status value is gone; the `dollars_spent` column
--      stays for telemetry.
--
--   2. ADD 'rate_limit_cooling_off' and 'rate_limit_paused' — the runner's
--      new 429-backoff path persists these between Pass-1 / Pass-2 retry
--      attempts so the engine's import-running poll can render a "Claude
--      rate limit cooling off, resuming shortly" bubble (cooling_off) and
--      a quieter "still waiting on rate limit" bubble (paused, after the
--      backoff window exhausts). The job stays recoverable from
--      `rate_limit_paused` — the per-chunk dedup table preserves all
--      Pass-1 work, and a future runner.start re-uses every cached chunk
--      at $0.
--
-- SQLite cannot ALTER a CHECK constraint in place; the only path is
-- table-rename + recreate. We:
--   a) ALTER TABLE import_jobs RENAME TO import_jobs__old
--   b) CREATE TABLE import_jobs with the new CHECK
--   c) INSERT INTO import_jobs SELECT * FROM import_jobs__old, mapping
--      any legacy `budget-exceeded` row to `failed` with a stable
--      error_code so the engine's failed-sub_step path picks it up on
--      the next poll (no in-flight instance should be in this state by the
--      time this migration runs, but defensive: failed > orphaned).
--   d) DROP TABLE import_jobs__old
--   e) Recreate the two indexes (`import_jobs_project_status`,
--      `import_jobs_started_at`).
--
-- The wrapping transaction comes from `applyMigrations` — a mid-file
-- throw rolls back the rename + new-table + index work atomically.
-- Forward-only; no down-migration (Neutron OSS contract).

ALTER TABLE import_jobs RENAME TO import_jobs__pre_0040;

CREATE TABLE import_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    source TEXT NOT NULL
        CHECK (source IN (
            'chatgpt-zip',
            'claude-zip',
            'gmail-oauth',
            'calendar-oauth',
            'drive-oauth',
            'notion-oauth',
            'slack-oauth'
        )),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued',
            'pass1-running',
            'pass2-running',
            'rate_limit_cooling_off',
            'rate_limit_paused',
            'completed',
            'failed',
            'cancelled'
        )),
    dollars_spent REAL NOT NULL DEFAULT 0,
    pass1_chunks_done INTEGER NOT NULL DEFAULT 0,
    pass1_chunks_total INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error_code TEXT,
    error_message TEXT,
    chunks_total_known INTEGER NOT NULL DEFAULT 0
        CHECK (chunks_total_known IN (0, 1))
) STRICT;

-- Copy every row, mapping budget-exceeded → failed for defense (see
-- preamble — no live instance should be in this state, but a defensive
-- map keeps the migration safe to apply on a back-restored DB).
INSERT INTO import_jobs (
    job_id, project_slug, source, status, dollars_spent,
    pass1_chunks_done, pass1_chunks_total, started_at, completed_at,
    error_code, error_message, chunks_total_known
)
SELECT
    job_id,
    project_slug,
    source,
    CASE status WHEN 'budget-exceeded' THEN 'failed' ELSE status END,
    dollars_spent,
    pass1_chunks_done,
    pass1_chunks_total,
    started_at,
    completed_at,
    CASE status
        WHEN 'budget-exceeded' THEN COALESCE(error_code, 'budget_subsystem_removed')
        ELSE error_code
    END,
    CASE status
        WHEN 'budget-exceeded' THEN
            COALESCE(
                error_message,
                'Legacy budget-exceeded status migrated to failed by 0040; '
                || 'the budget-cap subsystem was removed 2026-05-22.'
            )
        ELSE error_message
    END,
    chunks_total_known
FROM import_jobs__pre_0040;

DROP TABLE import_jobs__pre_0040;

CREATE INDEX IF NOT EXISTS import_jobs_project_status
    ON import_jobs (project_slug, status);

CREATE INDEX IF NOT EXISTS import_jobs_started_at
    ON import_jobs (started_at);
