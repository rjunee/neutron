-- 0034_p2_onboarding_state_user_pk.sql
--
-- ISSUES #2 — per-user onboarding isolation. Re-key onboarding_state on
-- (project_slug, user_id) so a second user on the same instance gets a
-- fresh onboarding journey instead of inheriting the first user's
-- state.
--
-- Per the instance-isolation onboarding-state brief §§ 3-4.
--
-- Backfill source for the new `user_id` column:
--   1. JSON_EXTRACT(phase_state_json, '$.user_id') — engine.start has
--      been writing user_id into phase_state.user_id since the
--      LLM-prompts sprint (engine.ts:1602). Every row written by
--      production engine.start carries it.
--   2. Legacy sentinel string for rows where the extraction returns
--      NULL (pre-LLM-prompts test data or hand-seeded rows —
--      should be empty on production, defensive).
--
-- Migration mechanics:
--   - SQLite does not support ALTER TABLE DROP CONSTRAINT / ALTER
--     PRIMARY KEY, so we use the table-rebuild dance — precedent at
--     instance-provisioning migrations/0004_internal_handle_and_url_slug.sql
--     lines 50-82. The migration runner wraps the body in implicit
--     BEGIN / COMMIT so the rebuild is atomic w.r.t. concurrent reads.
--   - No FKs cross to the registry's instance table (same convention
--     as migration 0011 — the per-project DB is logically scoped to one
--     project_slug already). The composite PK provides uniqueness on
--     its own.
--   - Forward-only. STRICT typing preserved. Snapshot regen required.
--
-- Verification (post-migration, per-project DB):
--   SELECT
--     COUNT(*) AS total_rows,
--     COUNT(CASE WHEN user_id = the legacy backfill sentinel
--                THEN 1 END) AS sentinel_rows,
--     COUNT(DISTINCT (project_slug || char(0) || user_id)) AS distinct_keys
--   FROM onboarding_state;
--
-- Rollback path (non-trivial):
--   This migration drops the single-column PK; reversing it on a
--   project DB with > 1 row per project_slug would lose data. The
--   accepted recovery path is a from-snapshot restore of the
--   pre-migration project DB. The vault-backup cron snapshots project
--   DBs daily; pre-merge snapshot recommended per the brief § 5.1.

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
    PRIMARY KEY (project_slug, user_id)
) STRICT;

INSERT INTO onboarding_state_new
    (project_slug, user_id, phase, phase_state_json, started_at,
     last_advanced_at, completed_at, import_job_id,
     persona_files_committed, wow_fired, attempt_id)
SELECT
    project_slug,
    COALESCE(
        JSON_EXTRACT(phase_state_json, '$.user_id'),
        'legacy:pre-project-isolation'
    ) AS user_id,
    phase,
    phase_state_json,
    started_at,
    last_advanced_at,
    completed_at,
    import_job_id,
    persona_files_committed,
    wow_fired,
    attempt_id
FROM onboarding_state;

DROP TABLE onboarding_state;
ALTER TABLE onboarding_state_new RENAME TO onboarding_state;

CREATE INDEX IF NOT EXISTS onboarding_state_phase
    ON onboarding_state (phase, last_advanced_at);
