-- 0011_p2_onboarding_state.sql
--
-- P2 S2 — onboarding state machine + transcript metadata + persona drafts.
--
-- Per docs/plans/P2-onboarding.md § 2.8 (state machine: transcript + structured)
-- + § 2.6 (persona-gen 3 files + cringe-check + 3-regen cap) + § 6 S2.
--
-- Three tables, one per concern:
--
--   1. `onboarding_state` — one row per instance. Tracks where the interview
--      currently sits: `phase` (locked enum from § 2.8), opaque
--      `phase_state_json` scratch, timing, and rollup booleans for
--      persona_files_committed / wow_fired. The engine reads this row to
--      know "where am I"; mid-turn crashes leave the row at the prior phase
--      and the agent re-emits.
--
--   2. `onboarding_transcripts_meta` — pointer to the JSONL transcript file
--      on disk (`<owner_home>/persona/onboarding-transcript.jsonl`). The
--      transcript itself is append-only on disk for resilience, but a row
--      here gives the system metadata (path, line count, last-seen ts) for
--      observability + admin tools without scanning the file.
--
--   3. `persona_drafts` — full draft history with regen counts. Each compose()
--      call produces one row. The cringe-check loop (§ 2.6) walks
--      regen_attempts from 0 up to 3; once the row hits 3 attempts and
--      still flags, PersonaError{code:'cringe_cap_exceeded'} fires and the
--      row is marked manual-review.
--
-- Forward-only. STRICT typing. No FKs across to the registry or user tables;
-- the per-project DB is logically scoped to one project_slug already.

CREATE TABLE IF NOT EXISTS onboarding_state (
    project_slug TEXT PRIMARY KEY NOT NULL,
    phase TEXT NOT NULL,
    phase_state_json TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER NOT NULL,
    last_advanced_at INTEGER NOT NULL,
    completed_at INTEGER,
    import_job_id TEXT,
    persona_files_committed INTEGER NOT NULL DEFAULT 0
        CHECK (persona_files_committed IN (0, 1)),
    wow_fired INTEGER NOT NULL DEFAULT 0
        CHECK (wow_fired IN (0, 1))
) STRICT;

CREATE INDEX IF NOT EXISTS onboarding_state_phase
    ON onboarding_state (phase, last_advanced_at);

CREATE TABLE IF NOT EXISTS onboarding_transcripts_meta (
    project_slug TEXT PRIMARY KEY NOT NULL,
    file_path TEXT NOT NULL,
    line_count INTEGER NOT NULL DEFAULT 0,
    last_appended_at INTEGER,
    started_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS persona_drafts (
    draft_id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    soul_md TEXT NOT NULL,
    user_md TEXT NOT NULL,
    priority_map_md TEXT NOT NULL,
    cringe_flags_json TEXT NOT NULL DEFAULT '{}',
    regen_attempts_json TEXT NOT NULL DEFAULT '{"soul":0,"user":0,"priority_map":0}',
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'committed', 'manual_review', 'discarded')),
    created_at INTEGER NOT NULL,
    committed_at INTEGER,
    git_sha TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS persona_drafts_by_project
    ON persona_drafts (project_slug, created_at);
