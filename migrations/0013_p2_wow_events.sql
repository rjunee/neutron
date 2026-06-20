-- 0013_p2_wow_events.sql
--
-- P2 S4 — wow-moment dispatcher telemetry storage.
--
-- Per docs/plans/P2-onboarding.md § 2.5 (locked 2026-04-29; per-action
-- specs locked 2026-04-30). Each fired action records one row with the
-- attempt outcome + (eventually) the user's engagement.
--
-- Storage model:
--
--   - `wow_events` — append-only row per (instance, action_id, fired_at).
--     `success` records whether the action ran cleanly; `success_reason`
--     carries a short tag (e.g. 'substrate_error', 'scope_missing',
--     'no_trigger') so analytics can attribute non-fires.
--     `engagement` fills in later when the user taps the follow-up
--     button-prompt — null until that callback lands.
--     `redacted_payload_json` carries action-specific telemetry context
--     (counts, hashes, never raw user data — recipient_hash for action 5,
--     reminder_phrase_hash for action 6, redacted task_title for action 4).
--
-- Forward-only. STRICT typing.

CREATE TABLE IF NOT EXISTS wow_events (
    id TEXT PRIMARY KEY NOT NULL,
    project_slug TEXT NOT NULL,
    action_id TEXT NOT NULL
        CHECK (action_id IN (
            '01-first-week-brief',
            '02-lifestyle-reminders',
            '03-project-shells',
            '04-overdue-task',
            '05-followup-email-draft',
            '06-dharma-reframe-reminder',
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

CREATE INDEX IF NOT EXISTS wow_events_project_action
    ON wow_events (project_slug, action_id);

CREATE INDEX IF NOT EXISTS wow_events_fired_at
    ON wow_events (fired_at);
