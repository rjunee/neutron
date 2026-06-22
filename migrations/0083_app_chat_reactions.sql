-- 0083_app_chat_reactions.sql
--
-- Track B Phase 4 (message reactions) — per-(message, device, emoji) emoji
-- reaction state for the `app_socket` (Expo / web) WebSocket surface.
--
-- BACKGROUND: 0079 added the durable per-topic message log and 0082 added
-- per-(message, device) receipts. Reactions are the SAME shape — per-message
-- metadata synced over chat-core — but with one structural difference: a
-- reaction can be REMOVED, whereas a receipt only ever advances. Receipts could
-- therefore be a monotonic set-union on the client; reactions cannot. So the
-- server is authoritative: it persists each reaction, bumps a monotonic
-- per-message `rev` on every add/remove, and re-fans the FULL current aggregate
-- as a `reaction_update`; the client REPLACES its set with the highest-`rev`
-- aggregate (last-writer-wins), which is what lets a removal actually clear a
-- reaction.
--
-- WHAT THIS ADDS: one row per (topic_id, message_id, device_id, emoji). A user
-- adding 👍 inserts a row with active = 1; removing it flips active = 0 (a
-- TOMBSTONE, not a DELETE) so `MAX(rev)` stays monotonic across removes. The
-- adapter records the change (attributing device_id to the socket — a client
-- can't forge another device's reaction), then fans the aggregate of the active
-- rows. Resume replays reaction state with `WHERE topic_id = ? AND seq > ?`.
--
-- Column rationale:
--
-- * (topic_id, message_id, device_id, emoji) PRIMARY KEY — one row per emoji per
--   device per message. The composite PK makes recording idempotent: re-adding
--   or toggling a reaction UPSERTs the same row rather than appending duplicates.
--
-- * seq — the underlying message's per-topic `seq`, copied here so a resume can
--   replay reactions with the same cursor the message replay uses. Resolved from
--   `app_chat_messages` on record so it is always the message's true seq, never
--   a client-asserted value. 0 when the message isn't found (defensive).
--
-- * active — 1 for a live reaction, 0 for a removed one (tombstone). The
--   aggregate is the set of active rows; tombstones survive only to keep `rev`
--   monotonic and to let a re-add reuse the row.
--
-- * rev — monotonic per-message reaction revision, bumped to MAX(rev)+1 on every
--   change. The client keeps whichever fanned aggregate carries the highest
--   `rev` and ignores a stale lower one, so applying updates is idempotent +
--   order-independent even though the reaction set itself isn't monotonic.
--
-- * updated_at — unix-ms time of the last change to this row (telemetry / future
--   tie-breaks); not load-bearing for ordering (that's `rev`).
--
-- The `(topic_id, seq)` index backs the resume-replay range scan.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE IF NOT EXISTS app_chat_reactions (
    topic_id   TEXT NOT NULL,
    message_id TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    seq        INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1,
    rev        INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (topic_id, message_id, device_id, emoji)
) STRICT;

-- Resume replay: fetch every reaction newer than a client's cursor in seq order.
CREATE INDEX IF NOT EXISTS idx_app_chat_reactions_topic_seq
    ON app_chat_reactions (topic_id, seq);
