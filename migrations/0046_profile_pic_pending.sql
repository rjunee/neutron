-- 0046_profile_pic_pending.sql
--
-- Profile-pic durable pending-call store — process-restart resume.
--
-- Per SPEC.md § Phases→Steps cross-cutting:
--   "Profile-pic process-restart resume — Gemini calls finish in 15-30 s;
--    not blocking M2."
--
-- The `profile_pic_jobs` table (migration 0014) tracks the higher-level
-- user-visible job state (queued → generating → ready / fallback /
-- user_uploaded / failed). That table is what the engine + UI poll for
-- "do we have candidates yet?"
--
-- `profile_pic_pending` is finer-grained: one row per individual Gemini
-- API call attempt. The pipeline writes a row at the START of each
-- `gemini.generate(...)` invocation and updates it on completion. The
-- row's `status` is independent of `profile_pic_jobs.status`:
--
--   - 'pending'   — call dispatched; in-process promise still racing
--   - 'completed' — call returned bytes; result_path points at the first
--                   candidate PNG on disk
--   - 'failed'    — call threw or completion path errored
--   - 'expired'   — process restarted mid-call; the resume-on-boot hook
--                   transitioned this row from 'pending' to 'expired'.
--                   The user can retry (and the boot hook auto-fires
--                   one retry, gated by `auto_retry_attempted`).
--
-- Resume-on-boot heuristics (see `onboarding/profile-pic/pending-call-store.ts`):
--
--   started_at < 60 s ago                                → keep 'pending'
--   60 s ≤ started_at  AND auto_retry_attempted = 0      → mark 'expired'
--   started_at age irrelevant AND auto_retry_attempted=1 → mark 'failed'
--
-- The `auto_retry_attempted` column is the "auto-retry once" gate from
-- the brief: first time we observe a stale pending row we mark it
-- 'expired' (still recoverable) and bump this to 1. The boot hook
-- triggers one auto-retry. On a subsequent restart, if that retry was
-- ALSO interrupted (auto_retry_attempted=1 + still pending) we flip to
-- 'failed' — the user has to re-trigger from the picker.
--
-- The brief lists project_slug / user_id / request_id (PK) / prompt /
-- started_at / completed_at NULL / result_path NULL / status. The
-- `auto_retry_attempted` column is an addition required to make the
-- expired-vs-failed test split sensible per the brief's test scenarios
-- (Part D).
--
-- `user_id` is nullable so the pipeline (which doesn't carry a user_id
-- on its public surface) can write rows even when the engine hook
-- hasn't plumbed one through.
--
-- `archetype_hint` is nullable. Persisting the (free-form) hint on the
-- row lets the resume-on-boot auto-retry preserve the user's actual
-- archetype across the restart — without it, `pipeline.start` falls
-- through to `FALLBACK_DEFAULT_SLUG` and the retried portrait set is
-- detached from the persona the user chose. The pipeline normalises
-- the hint at consumption time, so a column-level CHECK is
-- intentionally absent (mirrors `profile_pic_jobs.archetype_hint`).
--
-- Forward-only. STRICT typing. No FKs across (per-project scope).

CREATE TABLE IF NOT EXISTS profile_pic_pending (
    request_id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    user_id TEXT,
    prompt TEXT NOT NULL,
    archetype_hint TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    result_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
    auto_retry_attempted INTEGER NOT NULL DEFAULT 0
        CHECK (auto_retry_attempted IN (0, 1))
) STRICT;

CREATE INDEX IF NOT EXISTS profile_pic_pending_project_user_started
    ON profile_pic_pending (project_slug, user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS profile_pic_pending_status_started
    ON profile_pic_pending (status, started_at);
