-- 0042_drop_web_push_platform.sql
--
-- 2026-05-22 — Remove web push from the platform CHECK enum on
-- `device_push_tokens`. Per Sam + Atlas audit on PR #272: no customer
-- has asked for web push, the existing 'web' branch is dead code
-- (dispatcher filters out web tokens at fan-out time, the Expo client
-- can't even mint a web token, and the app's `isPushSupported()`
-- already returns false on web), and leaving the enum value in lets
-- the API surface accept a `'web'` registration that the dispatcher
-- silently discards. Drop the option from the schema so the
-- `/api/app/devices/register` path returns `invalid_platform` for
-- `'web'` instead of pretending to register a row no one will ever
-- send to.
--
-- A future, real web-push implementation (W3C Push API + VAPID +
-- service worker) is a fresh sprint and gets its own migration when
-- it lands. We deliberately do NOT carve a `'web-vapid'` placeholder
-- here — YAGNI; the enum will evolve when the actual implementation
-- ships.
--
-- SQLite cannot ALTER a CHECK constraint in place; mirrors the
-- `import_jobs` rename-recreate pattern from 0040. We:
--   a) ALTER TABLE device_push_tokens RENAME TO …__pre_0042
--   b) CREATE TABLE device_push_tokens with the trimmed CHECK enum
--   c) INSERT every row whose platform is currently 'ios' or 'android';
--      any 'web' row is DROPPED (no production traffic delivered to
--      such a row anyway — the dispatcher filtered them out).
--   d) DROP TABLE …__pre_0042
--   e) Recreate the two indexes.
--
-- Wrapping transaction comes from `applyMigrations` — a mid-file throw
-- rolls back atomically. Forward-only.

ALTER TABLE device_push_tokens RENAME TO device_push_tokens__pre_0042;

CREATE TABLE device_push_tokens (
    id              TEXT PRIMARY KEY NOT NULL,
    project_slug     TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    device_token    TEXT NOT NULL,
    platform        TEXT NOT NULL
                        CHECK (platform IN ('ios', 'android')),
    registered_at   TEXT NOT NULL,                              -- ISO-8601 UTC
    updated_at      TEXT NOT NULL                               -- ISO-8601 UTC
) STRICT;

-- Copy iOS + Android rows only. Drop any pre-existing 'web' rows —
-- the dispatcher's tokens.filter(t.platform !== 'web') already meant
-- they were never delivered to. We don't bother re-tagging them as
-- 'unsupported_platform' or similar; the row was never useful.
INSERT INTO device_push_tokens (
    id, project_slug, user_id, device_token, platform,
    registered_at, updated_at
)
SELECT
    id, project_slug, user_id, device_token, platform,
    registered_at, updated_at
FROM device_push_tokens__pre_0042
WHERE platform IN ('ios', 'android');

DROP TABLE device_push_tokens__pre_0042;

CREATE UNIQUE INDEX idx_device_push_tokens_project_token
    ON device_push_tokens (project_slug, device_token);

CREATE INDEX idx_device_push_tokens_project_user
    ON device_push_tokens (project_slug, user_id);
