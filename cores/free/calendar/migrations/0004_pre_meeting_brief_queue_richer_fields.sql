-- Calendar Core S1 — ISSUE #29 (2026-05-23) — pre-meeting-brief rehydration richer fields.
--
-- `pre-meeting-brief-scheduler.ts:buildEventFromQueueRow` rehydrates pending
-- durable rows on `start()` BEFORE the cache walk completes. If the rehydrated
-- timer fires before the cache walk populates the matching key, the fire
-- callback receives a stub `CalendarEventRow` with empty title / no attendees /
-- no meeting link — the brief LLM call composes a brief with degraded content.
--
-- Fix (option (a) from ISSUE #29): persist `title`, `attendees_json`, and
-- `meeting_link` in the queue row so rehydrate has full content without
-- depending on the cache walk winning the race.
--
-- All three columns are nullable: pre-existing pending rows from before this
-- migration read as NULL and fall through to the existing empty-stub behaviour
-- (Codex r1 P2 cache-walk refresh mitigation continues to cover that path).

ALTER TABLE pre_meeting_brief_queue ADD COLUMN title TEXT;
ALTER TABLE pre_meeting_brief_queue ADD COLUMN attendees_json TEXT;
ALTER TABLE pre_meeting_brief_queue ADD COLUMN meeting_link TEXT;
