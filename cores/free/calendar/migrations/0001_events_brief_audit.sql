-- Calendar Core S1 (2026-05-20) — per-project events cache + pre-meeting-brief audit log.
--
-- Lives at `<OWNER_HOME>/Projects/<project_id>/calendar/calendar.db`,
-- one DB per project. Google Calendar v3 is the source of truth; this
-- cache is a fast-render store for the launcher tile + the scheduler's
-- tick walk + the durable audit log of every pre-meeting-brief fire.
--
-- Forward-compat columns for the future S2 sync-token incremental
-- fetcher (`syncToken` column on `calendar_meta`, `etag` column on
-- `events_cache`); not used in v1 reads but written so a later mirror
-- migration doesn't have to rewrite rows.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;

CREATE TABLE events_cache (
  -- Composite key — Google addresses events as (calendar_id, event_id);
  -- keying solely on event_id would collapse identical ids on different
  -- calendars (mirrors backend.ts inMemoryCalendarClient's row key).
  calendar_id    TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  start_iso      TEXT NOT NULL,
  end_iso        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'confirmed',  -- 'confirmed' | 'cancelled'
  description    TEXT,
  attendees_json TEXT,                                -- JSON array of email strings
  html_link      TEXT,
  -- Extended-property echo — denormalised so the launcher tile + the
  -- per-project filter SQL doesn't have to round-trip through Google
  -- for every render. v1 only stores `neutron_project_id`; the column
  -- is generic for forward-compat.
  project_id     TEXT,
  -- Per-row etag (Google v3 returns this on events.list; saved here
  -- for a future incremental-sync migration that consumes it as a
  -- conditional-GET header on event-by-event refresh).
  etag           TEXT,
  cached_at      INTEGER NOT NULL,
  PRIMARY KEY (calendar_id, event_id)
);

CREATE INDEX events_cache_project_start
  ON events_cache(project_id, start_iso)
  WHERE status != 'cancelled';

CREATE INDEX events_cache_start
  ON events_cache(start_iso)
  WHERE status != 'cancelled';

CREATE TABLE pre_meeting_brief_audit (
  -- One row per fire. The launcher's "pre-meeting briefs" tab
  -- (P5.x) reads this; ops use it to investigate "why didn't I get a
  -- brief for the 10am" complaints.
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id          TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  fired_at             INTEGER NOT NULL,
  model                TEXT NOT NULL,
  outcome              TEXT NOT NULL,                  -- 'ok' | 'llm_error' | 'no_post_target'
  prompt_hash          TEXT NOT NULL,                  -- sha256 of the rendered Haiku prompt
  response_excerpt     TEXT,                            -- first 240 chars of the composed brief
  chat_message_id      TEXT                             -- channel-side message id on the project chat surface (nullable on dry-run)
);

CREATE INDEX pre_meeting_brief_audit_event
  ON pre_meeting_brief_audit(calendar_id, event_id, fired_at DESC);

CREATE INDEX pre_meeting_brief_audit_fired
  ON pre_meeting_brief_audit(fired_at DESC);

CREATE TABLE calendar_meta (
  -- Single-row table. Defence-in-depth against a sidecar copied
  -- between projects — the resolver throws CalendarSidecarMismatchError
  -- when `project_id` doesn't match the directory the file lives under.
  -- The `singleton` PK forces upsert-replace semantics on metadata
  -- changes.
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version  INTEGER NOT NULL,
  project_id      TEXT NOT NULL,
  initialised_at  INTEGER NOT NULL,
  -- Reserved for S2 syncToken-driven incremental fetcher. NULL in v1.
  sync_token      TEXT
);
