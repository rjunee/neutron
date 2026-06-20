-- 0014_p2_profile_pic.sql
--
-- P2 S4 — profile-pic generation pipeline state.
--
-- Per docs/plans/P2-onboarding.md § 2.7 (locked 2026-04-29). Two tables,
-- one per concern:
--
--   1. `profile_pic_jobs` — one row per profile-pic generation attempt
--      (typically Gemini Imagen 4, Nano Banana Pro variant). Tracks the
--      job status across the async lifecycle:
--          queued → generating → ready | fallback | user_uploaded
--      `fallback_used` flips to 1 when the 12-PNG archetype-keyed
--      gallery served instead of generated portraits (Gemini outage,
--      failure budget exhausted, or user tapped [B]).
--
--   2. `profile_pic_candidates` — one row per generated PNG (or fallback
--      gallery PNG selected). The user's pick gets `picked_at` populated;
--      the canonical copy lands at <owner_home>/persona/profile-pic.png.
--
-- Forward-only. STRICT typing. No FKs across (per-project scope).

CREATE TABLE IF NOT EXISTS profile_pic_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued',
            'generating',
            'ready',
            'fallback',
            'user_uploaded',
            'failed'
        )),
    archetype_hint TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    fallback_used INTEGER NOT NULL DEFAULT 0
        CHECK (fallback_used IN (0, 1)),
    failure_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS profile_pic_jobs_project_status
    ON profile_pic_jobs (project_slug, status);

CREATE TABLE IF NOT EXISTS profile_pic_candidates (
    id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL,
    path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'gemini'
        CHECK (source IN ('gemini', 'fallback', 'upload')),
    created_at INTEGER NOT NULL,
    picked_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS profile_pic_candidates_job
    ON profile_pic_candidates (job_id);
