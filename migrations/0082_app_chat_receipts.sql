-- 0082_app_chat_receipts.sql
--
-- Track B Phase 4 (delivery + read receipts) — per-(message, device)
-- acknowledgement state for the `app_socket` (Expo / web) WebSocket surface.
--
-- BACKGROUND: 0079 added the durable per-topic message log (monotonic `seq`,
-- gap-free resume, multi-device fan-out). Messages flowed sent → delivered
-- (server-acked, `seq` stamped) but there was no notion of WHICH devices
-- received a message, nor whether it had been READ. A single account can have
-- several live devices (laptop + phone, both on the synthetic `app:<user_id>`
-- topic); to render a Telegram-grade delivery ladder (✓ sent → ✓✓ delivered →
-- ✓✓ read) the server has to track receipts per device per message.
--
-- WHAT THIS ADDS: one row per (topic_id, message_id, device_id). The gateway
-- records a `delivered` receipt for every device connected at message
-- fan-out time, the agent loop records a `read` receipt the moment it picks up
-- an inbound user message, and a client reports `read` when a message scrolls
-- into view. The aggregate (delivered_by[] / read_by[]) is stamped inline on
-- the message envelope and re-fanned as a `receipt_update` frame; the client's
-- chat-core engine set-unions it onto the local row so the ladder advances.
--
-- Column rationale:
--
-- * (topic_id, message_id, device_id) PRIMARY KEY — one receipt row per device
--   per message. The composite PK makes recording idempotent: re-reporting a
--   receipt UPSERTs the same row rather than appending duplicates.
--
-- * seq — the underlying message's per-topic `seq`, copied here so a resume can
--   replay receipts with `WHERE topic_id = ? AND seq > ?` (the same cursor the
--   message replay uses). Resolved from `app_chat_messages` on record so it is
--   always the message's true seq, never a client-asserted value. 0 when the
--   message isn't found (defensive; such a receipt simply won't replay).
--
-- * delivered_at / read_at — unix-ms timestamps, NULL until that state is
--   reached. `read` implies `delivered`, so recording a read also backfills
--   delivered_at when it was NULL. Timestamps are monotonic (COALESCE keeps the
--   first), so a re-report can never regress a receipt.
--
-- The `(topic_id, seq)` index backs the resume-replay range scan.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE IF NOT EXISTS app_chat_receipts (
    topic_id     TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    seq          INTEGER NOT NULL DEFAULT 0,
    delivered_at INTEGER,
    read_at      INTEGER,
    PRIMARY KEY (topic_id, message_id, device_id)
) STRICT;

-- Resume replay: fetch every receipt newer than a client's cursor in seq order.
CREATE INDEX IF NOT EXISTS idx_app_chat_receipts_topic_seq
    ON app_chat_receipts (topic_id, seq);
