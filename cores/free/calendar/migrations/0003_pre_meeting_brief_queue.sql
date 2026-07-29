-- Calendar Core S1 — ISSUE #16 (2026-05-22) — durable pre-meeting-brief queue.
--
-- The in-process timer wheel in `pre-meeting-brief-scheduler.ts` loses
-- every pending fire on gateway restart: `start()` re-walks the cache,
-- but the silent-drop branch at `pre-meeting-brief-scheduler.ts:172`
-- (`if (fireAt <= t) continue`) drops any event whose lead window has
-- already passed. Result: a brief scheduled for 8:50 AM with a 10-min
-- lead time + a 9:00 AM meeting that misses its fire window because
-- the gateway was restarted at 8:55 AM — NO BRIEF EVER FIRES.
--
-- Fix: introduce a SQLite-backed durable queue keyed on
-- (calendar_id, event_id). The scheduler reads `pending` rows on boot
-- AND on every cache walk; on fire the row flips to `fired`; if the
-- meeting has already started by boot-time, the row flips to
-- `skipped` with a reason (so the bug doesn't recur silently — ops
-- can see why a brief didn't fire by reading the queue).

CREATE TABLE pre_meeting_brief_queue (
  calendar_id          TEXT    NOT NULL,
  event_id             TEXT    NOT NULL,
  project_id           TEXT    NOT NULL,
  meeting_start_ms     INTEGER NOT NULL,
  lead_time_ms         INTEGER NOT NULL,
  fire_at_ms           INTEGER NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','fired','skipped')),
  skip_reason          TEXT,
  enqueued_at_ms       INTEGER NOT NULL,
  fired_at_ms          INTEGER,
  PRIMARY KEY (calendar_id, event_id)
);

CREATE INDEX pre_meeting_brief_queue_status_fire_at
  ON pre_meeting_brief_queue (status, fire_at_ms);
