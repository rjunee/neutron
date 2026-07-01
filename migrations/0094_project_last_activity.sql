-- 0094_project_last_activity.sql
--
-- Per-project LAST-ACTIVITY sort key for the redesigned project rail
-- (rail-redesign sprint).
--
-- The rail sorts projects by most-recent activity so a project with new
-- messages POPS TO THE TOP (Telegram-style). This column is the sort key,
-- stamped at project create/materialize time (= created_at) and bumped to
-- "now" every time a message lands on the project's chat topic (the live-agent
-- reply / opening fan in `open/composer.ts` calls a best-effort
-- `touchProjectActivity`, which then re-emits `projects_changed` so connected
-- rails reorder live).
--
-- Nullable so legacy rows (created before this migration) read back NULL; the
-- serve-time ORDER BY uses `COALESCE(last_activity_at, updated_at)` so a legacy
-- row falls back to its updated_at timestamp rather than sinking to the bottom.
--
-- Migration mechanics: same as 0093 — a nullable `TEXT` column added to the
-- STRICT `projects` table via a plain forward-only `ALTER TABLE ... ADD
-- COLUMN`. ISO-8601 UTC string, matching the rest of the projects timestamps
-- (`created_at` / `updated_at` / `deleted_at`).
--
-- SNAPSHOT REGEN REQUIRED: this ADD COLUMN changes the `projects` table shape,
-- so `migrations/expected-schema.txt` MUST be regenerated
-- (`bun run migrations/regen-snapshot.ts`) and committed alongside this file or
-- `migrations/snapshot.test.ts` fails with schema drift.

ALTER TABLE projects
    ADD COLUMN last_activity_at TEXT;
