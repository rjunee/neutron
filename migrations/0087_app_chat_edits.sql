-- 0087_app_chat_edits.sql
--
-- Track B Phase 4 (message edit/delete) — per-message edit state for the
-- `app_socket` (Expo / web) WebSocket surface.
--
-- BACKGROUND: 0079 added the durable per-topic message log (append-only), 0082
-- added per-(message, device) receipts, and 0083 added per-(message, device,
-- emoji) reactions. Edit/delete is the SAME shape as reactions — per-message
-- metadata synced over chat-core with a monotonic last-writer-wins `rev` — but
-- with one structural difference: an edit/delete is AUTHOR-ONLY. Reactions
-- attribute to a device and ANY device may react to ANY message; an edit/delete
-- may only be applied by the message's author. The message log stays
-- append-only and immutable: an edit is an OVERLAY here, never an in-place
-- mutation of `app_chat_messages`. The server persists the latest edit, bumps a
-- monotonic per-message `rev`, and re-fans the current state as an `edit_update`;
-- the client REPLACES its body with the highest-`rev` aggregate (last-writer-wins,
-- chat-core `pickEditState`), which is what lets a delete tombstone the bubble.
--
-- AUTHORSHIP: because an app-chat topic is a single user's DM (`app:<user_id>`),
-- every human socket on the topic belongs to that user, so authorship reduces to
-- the message ROLE: a human device may mutate `user` messages, and the agent may
-- mutate `agent` messages (agent-native parity). The adapter resolves the
-- message's role from `app_chat_messages` and rejects a cross-role mutation
-- before any row is written here — so no `author_device_id` column is needed.
--
-- WHAT THIS ADDS: one row per (topic_id, message_id) holding the latest edit
-- state. An `edit` UPSERTs the new body + bumps `rev`; a `delete` clears `body`
-- to '' and sets `deleted = 1` (a TOMBSTONE: the message keeps its `seq` slot so
-- every device converges). Resume replays edit state with
-- `WHERE topic_id = ? AND seq > ?`.
--
-- Column rationale:
--
-- * (topic_id, message_id) PRIMARY KEY — one row per message. The composite PK
--   makes recording idempotent: a re-edit UPSERTs the same row.
--
-- * seq — the underlying message's per-topic `seq`, copied here so a resume can
--   replay edits with the same cursor the message replay uses. Resolved from
--   `app_chat_messages` on record so it is always the message's true seq. 0 when
--   the message isn't found (defensive — such an edit is rejected anyway).
--
-- * rev — monotonic per-message edit revision, bumped to MAX(rev)+1 on every
--   edit/delete. The client keeps whichever fanned aggregate carries the highest
--   `rev` and ignores a stale lower one, so applying updates is idempotent +
--   order-independent.
--
-- * body — the message's current body after the edit ('' for a delete tombstone).
--
-- * deleted — 1 once the message is tombstoned, else 0.
--
-- * edited_at — unix-ms time of the last edit/delete (drives the "edited" marker).
--
-- * editor_device_id — who last edited (the socket device id, or 'agent' for an
--   agent-issued edit); telemetry / audit, not load-bearing for ordering.
--
-- The `(topic_id, seq)` index backs the resume-replay range scan.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE IF NOT EXISTS app_chat_edits (
    topic_id         TEXT NOT NULL,
    message_id       TEXT NOT NULL,
    seq              INTEGER NOT NULL DEFAULT 0,
    rev              INTEGER NOT NULL DEFAULT 0,
    body             TEXT NOT NULL DEFAULT '',
    deleted          INTEGER NOT NULL DEFAULT 0,
    edited_at        INTEGER NOT NULL DEFAULT 0,
    editor_device_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (topic_id, message_id)
) STRICT;

-- Resume replay: fetch every edited message newer than a client's cursor in seq order.
CREATE INDEX IF NOT EXISTS idx_app_chat_edits_topic_seq
    ON app_chat_edits (topic_id, seq);
