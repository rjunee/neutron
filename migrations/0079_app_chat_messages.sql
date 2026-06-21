-- 0079_app_chat_messages.sql
--
-- Chat-sync foundation (web↔mobile Telegram-parity, Phase 1) — the durable
-- per-topic message log that backs gap-free reconnect and multi-device
-- consistency on the `app_socket` (Expo / web) WebSocket surface.
--
-- BACKGROUND: until this migration the app-ws surface
-- (`gateway/http/app-ws-surface.ts` + `channels/adapters/app-ws/`) emitted
-- user/agent messages in-memory only — a `user_message` echo and an
-- `agent_message` were fanned out to live sockets and then forgotten. A
-- reconnect re-hydrated from the cursor-paginated `button_prompts` history
-- API, which never carried the free-text chat turns, so any message sent
-- while a socket was down was lost. There was also no monotonic ordering
-- key, so a second device on the same account could not be told "give me
-- everything after seq N".
--
-- WHAT THIS ADDS: an append-only message log keyed by a monotonic, per-topic
-- `seq`. Every persisted user/agent message gets the next `seq` for its
-- `topic_id`; the value is stamped on the outbound WS envelope and a client
-- replays the gap with `{ type:'resume', after_seq:N }` →
-- `WHERE topic_id = ? AND seq > ? ORDER BY seq`. This is the server half of
-- the hand-rolled append-only sync engine (see `@neutron/chat-core`): the
-- doc's "server-assigned monotonic seq + per-client cursor + idempotent
-- send-queue keyed by client_msg_id" shape.
--
-- Column rationale:
--
-- * `topic_id` — the synthetic `app:<user_id>` channel topic. `seq` is
--   monotonic WITHIN a topic, not globally, so two projects/users never
--   contend on a single counter.
--
-- * `seq` — monotonic per-topic sequence assigned on persist. The
--   `(topic_id, seq)` PRIMARY KEY both enforces uniqueness and is the
--   replay/ordering index (the resume query is a prefix scan on it). `seq`
--   is assigned as `COALESCE(MAX(seq),0)+1` inside the writing transaction
--   so concurrent appends on one connection (serialized by the ProjectDb
--   mutex) can't collide.
--
-- * `message_id` — server-assigned id echoed to the client so an optimistic
--   bubble reconciles. UNIQUE so a replay can't double-apply.
--
-- * `role` — 'user' | 'agent'. The surface persists the user echo on inbound
--   and the agent reply on outbound.
--
-- * `client_msg_id` — the client idempotency key. The partial UNIQUE index
--   `(topic_id, client_msg_id)` makes a re-sent user message (offline queue
--   flush, double-tap, HTTP-fallback + WS race) collapse to the existing row
--   instead of appending a duplicate. NULL for agent messages and for
--   clients that don't supply one.
--
-- * `project_id` — the P5.2 project the message belongs to; round-tripped so
--   a replayed message lands in the right transcript.
--
-- * `attachments_json` — JSON array of attachment URLs (or NULL). Mirrors the
--   wire envelope's `attachments` field so a replay reconstructs it.
--
-- * `created_at` — unix-ms emit time, used as the wire `ts` on replay.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE IF NOT EXISTS app_chat_messages (
    topic_id         TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    message_id       TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('user', 'agent')),
    body             TEXT NOT NULL,
    client_msg_id    TEXT,
    project_id       TEXT,
    attachments_json TEXT,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (topic_id, seq)
) STRICT;

-- Reconcile / replay-dedup: message_id is globally unique across topics.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_chat_messages_message_id
    ON app_chat_messages (message_id);

-- Idempotent send: a re-sent user message with the same client_msg_id
-- collapses to the existing row rather than appending a duplicate seq.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_chat_messages_client_msg
    ON app_chat_messages (topic_id, client_msg_id)
    WHERE client_msg_id IS NOT NULL;
