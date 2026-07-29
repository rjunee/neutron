-- 0033_device_push_tokens.sql
--
-- P5.6 — per-instance push-notification device-token store.
--
-- Per SPEC.md § Phases→Steps (P5.6: "native push via
-- Expo Push (APNs + FCM); Telegram remains a peer channel") and
-- docs/engineering-plan.md § B.P5 ("Push notifications — agent-initiated
-- messages reach the user via native push, not just Telegram").
--
-- The Expo client (managed workflow) calls `getExpoPushTokenAsync()` to
-- mint an opaque push token (typically `ExponentPushToken[xxxxx]` for
-- managed apps; raw FCM/APNs tokens for bare workflow). The client POSTs
-- that token + a platform tag to `/api/app/devices/register` after
-- login; the gateway persists the row here. When a reminder fires, the
-- tick-loop's `onFired` hook reads tokens for the row's instance and POSTs
-- them as a single Expo Push API batch.
--
-- Schema decisions:
--
-- * `project_slug NOT NULL` — mirrors the redundant-but-defensive pattern
--   used by `sessions`, `topics`, `tasks`. The project DB is per-instance by
--   construction, but the explicit column lets a Zone-A cross-instance
--   inspector verify rows and makes the query joins straightforward.
--
-- * `user_id NOT NULL` — an instance may have multiple users in the future
--   (workspace instances); push tokens belong to a single user/device pair.
--   For solo instances this is the owner's stable id (the JWT `sub`).
--
-- * `device_token` is the OPAQUE bytestring Expo / FCM / APNs hands back
--   — TEXT to keep the schema portable across platforms. We do not parse
--   or validate the inner format; the Expo Push API does that on send.
--
-- * `platform` is a CHECK-enumerated TEXT of `'ios' | 'android' | 'web'`
--   at the original 0033 cut; migration `0042_drop_web_push_platform.sql`
--   (2026-05-22) trims 'web' from the enum and rewrites the table. The
--   original list is preserved here as a historical record — the live
--   schema after 0042 only accepts ios + android. A future real web-
--   push implementation (W3C Push API + VAPID + service worker) will
--   re-add the enum value via its own migration.
--
-- * `(project_slug, device_token)` is UNIQUE — re-registering the SAME
--   device token (typical: app foreground re-fetches the token and POSTs
--   it again) should be an idempotent upsert, not a duplicate row. The
--   register handler uses `INSERT ... ON CONFLICT DO UPDATE` against
--   this index to swap the `user_id` / `updated_at` if the device
--   changed hands (e.g. user signed out and a different user signed in
--   on the same phone). Without this, a sign-out/sign-in dance would
--   leave stale rows pointing to the wrong user_id and push fan-out
--   would deliver to the wrong inbox.
--
-- * `idx_device_push_tokens_user` is the read index for fan-out:
--   "give me every device this user has registered." The reminder-fired
--   hook fans out per-instance (every device, the reminder is instance-
--   scoped today), but a per-user variant lands here so the future
--   per-user routing (workspace instances, M3 group projects) is a
--   one-line query change.
--
-- * `registered_at` + `updated_at` are TEXT ISO-8601 (mirrors `tasks`
--   row shape — `0032_tasks_canonical.sql`). The store stamps both on
--   register; only `updated_at` changes on conflict-update.
--
-- Forward-only. No backfill: pre-P5.6 instances simply have an empty
-- table, and the reminder push hook no-ops on empty token lists per
-- the brief's "Hook is additive — gracefully no-ops if no tokens
-- registered" rule.

CREATE TABLE device_push_tokens (
    id              TEXT PRIMARY KEY NOT NULL,
    project_slug     TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    device_token    TEXT NOT NULL,
    platform        TEXT NOT NULL
                        CHECK (platform IN ('ios', 'android', 'web')),
    registered_at   TEXT NOT NULL,                              -- ISO-8601 UTC
    updated_at      TEXT NOT NULL                               -- ISO-8601 UTC
) STRICT;

CREATE UNIQUE INDEX idx_device_push_tokens_project_token
    ON device_push_tokens (project_slug, device_token);

CREATE INDEX idx_device_push_tokens_project_user
    ON device_push_tokens (project_slug, user_id);
