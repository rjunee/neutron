-- Calendar Core S1 — Argus r2 IMPORTANT #2 (2026-05-21).
--
-- Add `start_ms` (epoch milliseconds) to `events_cache` so the
-- listEvents query window filter compares events as INSTANTS rather
-- than as ISO strings.
--
-- Why: Google Calendar v3 returns `start.dateTime` in the calendar's
-- own offset form (e.g. `2026-06-01T09:00:00-07:00` = instant
-- 16:00Z), while the query-side window converts ms→ISO via
-- `new Date().toISOString()` (Z-form: `2026-06-01T15:00:00.000Z`).
-- Lexicographic comparison of those two shapes is WRONG:
--   `'2026-06-01T09:00:00-07:00' < '2026-06-01T15:00:00.000Z'`
-- evaluates true, so the in-window event is dropped. Silently masks
-- events for every non-UTC instance.
--
-- Fix: store a numeric `start_ms` on upsert and compare numerically.
-- SQLite's `strftime('%s', ...)` parses ISO-8601 with ±HH:MM offsets
-- correctly, so the backfill of existing rows uses it directly; the
-- runtime upsert path (in src/cache.ts) computes `Date.parse(start)`
-- for full ms precision.

ALTER TABLE events_cache ADD COLUMN start_ms INTEGER;

UPDATE events_cache
  SET start_ms = CASE
    -- All-day rows store `YYYY-MM-DD` with no time component; coerce
    -- to UTC midnight of that local date for the compare. Mirrors the
    -- backend.ts `isAllDayDate` path which treats date-only timestamps
    -- as `T00:00:00Z` for window filtering.
    WHEN start_iso LIKE '____-__-__' THEN
      CAST(strftime('%s', start_iso || 'T00:00:00Z') AS INTEGER) * 1000
    ELSE
      CAST(strftime('%s', start_iso) AS INTEGER) * 1000
  END
  WHERE start_ms IS NULL;

CREATE INDEX events_cache_start_ms
  ON events_cache(start_ms)
  WHERE status != 'cancelled';
