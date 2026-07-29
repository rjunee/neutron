-- 0043_onboarding_state_wow_pushed_at.sql
--
-- 2026-05-22 — push-deeplink-wow sprint. Add nullable `wow_pushed_at`
-- column to `onboarding_state` so the engine's wow-moment push trigger
-- can fire AT MOST ONCE per (project, user) onboarding row.
--
-- Per docs/plans/2026-05-22-push-deeplink-wow-trigger-brief.md § B and
-- the locked engineering-plan answer 2026-04-25 ("agent-initiated
-- messages reach the user via native push").
--
-- Semantics:
--   NULL  → push not yet attempted; engine fires on next entry into
--           `dispatchWowAndAdvance`.
--   value → push attempted at <ms-epoch>; engine SKIPS to honour the
--           1-shot idempotency contract. Mark-on-attempt (not on
--           success) so a Expo outage during the push doesn't cause
--           an infinite retry storm on crash-resume of `wow_fired`.
--
-- Migration mechanics:
--   SQLite STRICT tables don't allow `ADD COLUMN` with a non-NULL
--   constraint on a populated table, so we use the table-rebuild
--   dance — precedent at 0034_p2_onboarding_state_user_pk.sql:46-89.
--   Phase_state JSON + every existing column copies forward verbatim;
--   `wow_pushed_at` defaults to NULL for every pre-migration row
--   (matches "never attempted").
--
--   STRICT typing preserved. Composite PK `(project_slug, user_id)`
--   from 0034 preserved. Index `onboarding_state_phase` preserved.
--   Forward-only. Snapshot regen required.
--
-- Verification (post-migration, per-project DB):
--   SELECT
--     COUNT(*) AS total_rows,
--     SUM(CASE WHEN wow_pushed_at IS NULL THEN 1 ELSE 0 END)
--       AS not_pushed_rows,
--     SUM(CASE WHEN wow_pushed_at IS NOT NULL THEN 1 ELSE 0 END)
--       AS pushed_rows
--   FROM onboarding_state;
--
-- Rollback path: table-rebuild back to the 0034 shape. Dropping a
-- single nullable column has no data-loss risk (the column is the only
-- new state).

CREATE TABLE onboarding_state_new (
    project_slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    phase_state_json TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER NOT NULL,
    last_advanced_at INTEGER NOT NULL,
    completed_at INTEGER,
    import_job_id TEXT,
    persona_files_committed INTEGER NOT NULL DEFAULT 0
        CHECK (persona_files_committed IN (0, 1)),
    wow_fired INTEGER NOT NULL DEFAULT 0
        CHECK (wow_fired IN (0, 1)),
    attempt_id TEXT NOT NULL DEFAULT 'legacy-pre-S30',
    wow_pushed_at INTEGER,
    PRIMARY KEY (project_slug, user_id)
) STRICT;

INSERT INTO onboarding_state_new
    (project_slug, user_id, phase, phase_state_json, started_at,
     last_advanced_at, completed_at, import_job_id,
     persona_files_committed, wow_fired, attempt_id, wow_pushed_at)
SELECT
    project_slug,
    user_id,
    phase,
    phase_state_json,
    started_at,
    last_advanced_at,
    completed_at,
    import_job_id,
    persona_files_committed,
    wow_fired,
    attempt_id,
    NULL
FROM onboarding_state;

DROP TABLE onboarding_state;
ALTER TABLE onboarding_state_new RENAME TO onboarding_state;

CREATE INDEX IF NOT EXISTS onboarding_state_phase
    ON onboarding_state (phase, last_advanced_at);
