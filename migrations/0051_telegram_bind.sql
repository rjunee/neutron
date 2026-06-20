-- 0051_telegram_bind.sql
--
-- ISSUES #65: bot-side /start bind_<token> handler (2026-05-29).
--
-- Two tables share the same migration so a single sprint shipping the bind
-- consumer keeps the schema additions atomic:
--
--   1. telegram_bind_tokens — side-channel index from random_id → user_id
--      written at MINT time by signup/telegram-bind-token.ts:buildMintTelegramBindToken.
--      The bot-side handler at signup/telegram-bind-handler.ts:buildTelegramBindHandler
--      reads it back to recover user_id for HMAC verification. The HMAC secret is
--      `NEUTRON_TELEGRAM_BIND_SECRET` — verifies (project_slug, looked_up_user_id,
--      random_id, exp).
--
--      Why a side-channel index + HMAC (not encode user_id in the token)?
--      Production user_id is a 36-char UUID (identity/users.ts:randomUUID); even
--      alone it blows past Telegram's 58-char start-payload ceiling. The HMAC is
--      defense-in-depth: a dumped index doesn't enable token forgery without the
--      shared secret. The minter's own header doc anticipates this choice
--      (signup/telegram-bind-token.ts:51-57).
--
--   2. telegram_bindings — verified (chat_id → user_id) bindings written AFTER
--      the bot-side handler validates the token. Subsequent inbound Telegram
--      messages from chat_id can be attributed to user_id via
--      TelegramBindingsStore.lookupChatId. For MVP we ship the binding row + the
--      lookup seam; engine integration of inbound routing through this map is
--      explicitly deferred to a follow-up sprint.
--
-- Both tables PK on the lookup column (random_id / chat_id) since reads are
-- point-lookups, not range scans. Expiry sweepers are out of scope for MVP — the
-- random_id PK + bounded mint volume keep the table tiny (one row per [B] tap,
-- max ~hundreds per instance lifetime). A TTL sweep can land later if mint volume
-- warrants it.
--
-- Forward-only. `IF NOT EXISTS` so re-applying against a fixture DB that already
-- has the table is a no-op (mirrors the pattern in 0050_instance_metadata.sql).

CREATE TABLE IF NOT EXISTS telegram_bind_tokens (
  random_id        TEXT NOT NULL PRIMARY KEY,
  user_id          TEXT NOT NULL,
  expires_at_ms    INTEGER NOT NULL,
  created_at_ms    INTEGER NOT NULL,
  -- NULL until the bot-side handler atomically claims the token via
  -- UPDATE ... WHERE consumed_at_ms IS NULL. The single-statement claim is
  -- the concurrency primitive — two concurrent taps on the same deeplink
  -- contend on this column and exactly one wins.
  consumed_at_ms   INTEGER
);

CREATE INDEX IF NOT EXISTS telegram_bind_tokens_expires
    ON telegram_bind_tokens (expires_at_ms);

CREATE TABLE IF NOT EXISTS telegram_bindings (
  chat_id            TEXT NOT NULL PRIMARY KEY,
  user_id            TEXT NOT NULL,
  bound_at_ms        INTEGER NOT NULL,
  -- The random_id segment of the bind token that produced this row. Informal
  -- audit trail; not a FK because consumed bind-tokens may be GC'd by a future
  -- TTL sweeper while their resulting bindings persist.
  source_random_id   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_bindings_user_id
    ON telegram_bindings (user_id);
