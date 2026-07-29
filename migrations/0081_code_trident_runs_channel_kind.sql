-- 0081_code_trident_runs_channel_kind.sql
--
-- Trident async-delivery follow-up (#317) — persist the ORIGINATING channel
-- kind on each run so terminal result delivery routes back through the surface
-- the build came from, instead of hard-coding `'telegram'`.
--
-- Before this: `trident/delivery.ts` built the delivery topic with a single
-- static `channel_kind` (defaulted to `'telegram'`) applied to EVERY run. A
-- `/code` build dispatched from the app-WebSocket surface (`app_socket`) would
-- compose its `chat_id`/`thread_id` correctly but post the result to a Telegram
-- topic — a misroute. (Failure-safe: the tick loop's `on_terminal` try/catch
-- swallows a bad post, so a misroute never un-terminates a build; but the user
-- never sees the result on their surface.)
--
-- The run row already carries the routing context (`chat_id`/`thread_id`,
-- migration 0077); this adds the missing channel discriminator so the delivery
-- hook derives the channel PER RUN from the row rather than from one global
-- default. Existing rows + new Telegram-originated `/code` builds default to
-- `'telegram'` (the prior behaviour), so this is backward-compatible.
--
-- Values mirror `channels/types.ts` `ChannelKind`
-- (`'telegram' | 'app_socket' | 'webhook' | 'cli'`) — the same enum the
-- outbound `Topic.channel_kind` is keyed on, so the persisted value flows
-- straight into `topicForRun` without translation.
--
-- Forward-only; no down-migration (Neutron OSS contract).

ALTER TABLE code_trident_runs
    ADD COLUMN channel_kind TEXT NOT NULL DEFAULT 'telegram'
        CHECK (channel_kind IN ('telegram', 'app_socket', 'webhook', 'cli'));
