-- 0050_instance_metadata.sql
--
-- 2026-05-28 — close ISSUES #40. Restore the `instance_metadata` table that the
-- P6.1 nudge engine + current-focus surface have been *documenting* (see
-- migrations/0045_p6_1_nudge_staleness.sql line 21) but never reading. With no
-- row, both consumers silently fell back to the hardcoded
-- `DEFAULT_TENANT_TIMEZONE = 'America/Los_Angeles'` — every non-LA owner
-- fired their daily nudge on the wrong wall-clock day, and the hero card
-- (`GET /api/app/focus/current`) returned 404 / yesterday's pick after
-- midnight in their actual zone.
--
-- The table is a per-project singleton: one row per `instance_slug`, holding the
-- handful of mutable instance-level facts (timezone is the first). Future fields
-- (e.g. preferred locale, theme, week-start) land here as additive columns;
-- the table name is intentionally `instance_metadata` so the column adds read
-- like configuration, not new subsystems.
--
-- The DROPPED platform-level metadata table mentioned in
-- migrations/0002_workspace_members.sql:9 was the Sprint-1
-- registry-side table (cross-instance FK on `sessions.project_slug`). This is its
-- per-project-DB equivalent and serves a different purpose: holding the
-- mutable per-project config the per-project gateway reads.
--
-- Forward-only. `IF NOT EXISTS` so re-applying against a fixture DB that
-- already has the table is a no-op.

CREATE TABLE IF NOT EXISTS instance_metadata (
  instance_slug TEXT NOT NULL PRIMARY KEY,
  -- IANA timezone identifier (e.g. 'America/Los_Angeles', 'America/New_York',
  -- 'Asia/Singapore'). NULL → consumers fall back to
  -- `DEFAULT_TENANT_TIMEZONE`. Validated by `Intl.DateTimeFormat` at read
  -- time; an unknown identifier throws and the cron tick / surface request
  -- fails closed (which is preferable to silently picking the wrong day).
  timezone TEXT
);
