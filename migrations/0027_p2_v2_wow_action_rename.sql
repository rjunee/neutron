-- 0027_p2_v2_wow_action_rename.sql
--
-- P2 v2 S9 — replace action 06 in wow_events.action_id CHECK constraint:
-- drop '06-dharma-reframe-reminder', add '06-interest-check-in'.
--
-- Per docs/plans/P2-onboarding-v2.md § 5.1. The v1 dharma-reframe action
-- was Sam-specific (contemplative-keyword match); v2 generalizes to
-- "surface a non-work interest, periodically check in."
--
-- SQLite CHECK constraints are immutable, so the only safe change is a
-- table rebuild. We:
--   1. Build wow_events_new with the new CHECK list.
--   2. Copy every row, rewriting any '06-dharma-reframe-reminder' rows
--      to '06-interest-check-in' (so any in-flight instance telemetry from
--      v1 stays consistent under the new action_id).
--   3. Swap tables + re-create both indexes.
--
-- Forward-only. STRICT typing preserved.

CREATE TABLE wow_events_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    action_id TEXT NOT NULL
        CHECK (action_id IN (
            '01-first-week-brief',
            '02-lifestyle-reminders',
            '03-project-shells',
            '04-overdue-task',
            '05-followup-email-draft',
            '06-interest-check-in',
            '07-overnight-pass'
        )),
    fired_at INTEGER NOT NULL,
    success INTEGER NOT NULL DEFAULT 0
        CHECK (success IN (0, 1)),
    success_reason TEXT,
    engagement TEXT
        CHECK (engagement IS NULL OR engagement IN (
            'read', 'scrolled', 'idle',
            'kept', 'tweaked', 'skipped',
            'will_handle', 'snoozed', 'dropped',
            'opened', 'sent', 'discarded'
        )),
    redacted_payload_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

INSERT INTO wow_events_new
    (id, project_slug, action_id, fired_at, success, success_reason, engagement, redacted_payload_json)
SELECT id,
       project_slug,
       CASE action_id
            WHEN '06-dharma-reframe-reminder' THEN '06-interest-check-in'
            ELSE action_id
       END,
       fired_at,
       success,
       success_reason,
       engagement,
       redacted_payload_json
  FROM wow_events;

DROP TABLE wow_events;
ALTER TABLE wow_events_new RENAME TO wow_events;

CREATE INDEX IF NOT EXISTS wow_events_project_action
    ON wow_events (project_slug, action_id);
CREATE INDEX IF NOT EXISTS wow_events_fired_at
    ON wow_events (fired_at);
