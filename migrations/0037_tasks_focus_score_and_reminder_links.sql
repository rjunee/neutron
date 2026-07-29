-- 0037_tasks_focus_score_and_reminder_links.sql
--
-- P6 (task system overhaul, post-P6.0 substrate).
--
-- Adds two facets to the canonical task system:
--
--   1. Deterministic `focus_score` per open task — populated synchronously
--      on every mutation that affects (priority, due_date), and re-
--      converged every 4 hours by the `tasks.focus_score_recompute` cron
--      so staleness + overdue components stay current as wall-clock
--      time advances.
--
--   2. Reminder ↔ task auto-link table — every task created/updated with
--      a `due_date` synchronously creates a paired reminder
--      (`reminders.source = '@neutron/tasks'`) and a `task_reminder_links`
--      row binding the two. Task complete/cancel/delete cascades the
--      cancellation to the linked reminder; ON DELETE CASCADE on both
--      FK sides keeps the link table in lock-step with hard-deletes.
--
-- Forward-only. No data backfill — existing rows pick up a null
-- focus_score until the next mutation or the next cron tick, both of
-- which are graceful (the HTTP surface treats null as "sort below any
-- scored row, then by due_date / created_at" — matches the P6.0
-- behaviour).
--
-- Why a join table instead of a `reminder_id` column on `tasks`:
--   - A task can have its reminder cycle through multiple physical rows
--     over its lifetime (due-date re-opens after completion, snooze
--     migrations once Reminders gains a true snooze, etc.). The join
--     table normalizes both directions without forcing a re-write of
--     `tasks` on every reminder swap.
--   - ON DELETE CASCADE from BOTH sides means a hard-delete of either
--     row cleans up the link automatically. The store layer's cancel
--     path still flips `reminders.status='cancelled'` (the audit-trail
--     row stays) before any delete, so the FK CASCADE only fires when
--     the row is genuinely gone.

ALTER TABLE tasks ADD COLUMN focus_score REAL;
ALTER TABLE tasks ADD COLUMN focus_score_updated_at TEXT;  -- ISO-8601 UTC

-- Open tasks sort by focus_score DESC inside the per-instance Focus
-- aggregator + the optional `?order=focus_score` opt-in on the
-- project tasks surface. The partial index keeps the open subset
-- cheap even when an instance accumulates thousands of completed rows.
CREATE INDEX idx_tasks_project_focus_score
    ON tasks (project_slug, focus_score DESC)
    WHERE status = 'open';

CREATE TABLE task_reminder_links (
    task_id          TEXT NOT NULL,
    reminder_id      TEXT NOT NULL,
    project_slug      TEXT NOT NULL,
    created_at       TEXT NOT NULL,                          -- ISO-8601 UTC
    PRIMARY KEY (task_id, reminder_id),
    FOREIGN KEY (task_id)     REFERENCES tasks (id) ON DELETE CASCADE,
    FOREIGN KEY (reminder_id) REFERENCES reminders (id) ON DELETE CASCADE
) STRICT;

-- Read indexes:
--   - `idx_task_reminder_links_reminder` so an inbound reminder-fire
--     event can ask "which task does this reminder belong to?" in O(1).
--   - `idx_task_reminder_links_project_task` so a task-cancel sweep can
--     find every linked reminder for a single task without scanning
--     the whole table (project_slug + task_id is the natural query).
CREATE INDEX idx_task_reminder_links_reminder
    ON task_reminder_links (reminder_id);

CREATE INDEX idx_task_reminder_links_project_task
    ON task_reminder_links (project_slug, task_id);
