-- 0120_trident_slug_unique_only_live.sql
--
-- You cannot retry a build with the same instructions.
--
-- THE DEFECT (owner-hit 2026-08-11, ISSUES #530). `slugifyTask` derives a run's
-- slug from the task's FIRST 35 CHARACTERS, and `idx_code_trident_runs_slug` made
-- `(project_slug, slug)` unique across EVERY row — with no phase predicate. So any
-- task whose opening words match a prior run's could not be dispatched at all,
-- INCLUDING a run that was cancelled or failed.
--
-- That makes "retry the thing that just broke, unchanged" structurally impossible,
-- which is the single most common thing an owner does after a failure. The owner hit
-- it retrying the Email Core build; the workaround was to reword the opening line,
-- which is why two dead rows carry near-identical slugs
-- (`type-plan-title-email-core-p1-pipel`, `type-plan-title-p1-email-pipeline-s`).
-- The dispatch failed with `UNIQUE constraint failed: code_trident_runs.project_slug,
-- code_trident_runs.slug`.
--
-- THE INTENT WAS RIGHT, THE SCOPE WAS WRONG. The original index's own comment in
-- 0077 says "slug idempotency lookup", and that is worth keeping: two LIVE runs of
-- the same task on the same project should still collide, so a double-dispatch is
-- refused rather than racing itself. A run that has already finished, failed or been
-- stopped cannot be raced with, so it has no business holding the name forever.
--
-- So the index becomes PARTIAL, on exactly the predicate this table already uses
-- for the same distinction — `idx_code_trident_runs_active` (also in 0077) is
-- `WHERE phase NOT IN ('done', 'failed', 'stopped')`. Reusing that literal rather
-- than inventing a second spelling of "terminal" matters: two definitions of
-- terminal in one table is how they drift apart.
--
-- NOT the alternative of salting the slug per run id. A slug is a DISPLAY name —
-- human-legible, used in state-file paths and in the board — and salting it would
-- make every one of those surfaces uglier to solve a problem that a predicate
-- solves exactly. It would also silently permit two concurrent runs of the same
-- task, which the idempotency intent above deliberately forbids.
--
-- SQLite rewrites the index rather than the table, so this is cheap and reversible:
-- restoring the old behaviour is the same two statements without the WHERE clause.

DROP INDEX IF EXISTS idx_code_trident_runs_slug;

CREATE UNIQUE INDEX idx_code_trident_runs_slug
    ON code_trident_runs (project_slug, slug)
    WHERE phase NOT IN ('done', 'failed', 'stopped');
