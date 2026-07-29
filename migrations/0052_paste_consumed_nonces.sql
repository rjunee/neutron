-- 0052_paste_consumed_nonces.sql
--
-- ISSUES #76 (2026-06-02, Argus r2 BLOCKER fix) — single-use guard for
-- the legacy Max paste-token callback (`identity/oauth/max-handoff.ts`).
--
-- Why a SEPARATE table from `signup_consumed_start_tokens` (migration
-- 0022):
--   The web onboarding flow reuses ONE start_token JWT for BOTH the
--   `/oauth/max/start` paste gate AND, on the next hop, the chat
--   session (the embedded `?token=`/`?start=` JWT). `chat-bridge`
--   (gateway/http/chat-bridge.ts:1024, wired at gateway/index.ts:2306)
--   atomically claims that start_token's `jti` against
--   `signup_consumed_start_tokens` AFTER `engine.start` to make the chat
--   bootstrap single-use. If the paste callback also claimed the SAME
--   jti against the SAME table, it would burn the jti BEFORE the user
--   reaches chat → chat-bridge sees an already-claimed jti → returns
--   false → socket closes 4001 → onboarding strands (Argus r2 BLOCKER,
--   cross-model confirmed by Codex/GPT-5).
--
--   The fix: the paste callback claims a paste-flow nonce DERIVED from
--   the start_token jti (`paste:<jti>`) in THIS table, which chat-bridge
--   never touches. The two single-use guards no longer contend. The
--   nonce is deterministic per start_token (so a replay of the same
--   leaked paste_url collides → 409) and cryptographically bound to the
--   signed JWT (so it can't be forged or refreshed).
--
-- Same row shape + atomic INSERT-ON-CONFLICT-DO-NOTHING claim primitive
-- as 0022; `SqliteConsumedTokens` is reused with `table` set to this
-- table. `expires_at_ms` is the start_token's `exp` so the existing
-- `pruneExpired` cron drops stale rows (4w retention default).
--
-- Forward-only.

CREATE TABLE IF NOT EXISTS paste_consumed_nonces (
    jti TEXT PRIMARY KEY NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    claimed_at_ms INTEGER NOT NULL
) STRICT;

-- Index on expires_at_ms so the pruner's
-- `DELETE WHERE expires_at_ms < ?` stays fast across a 4-week sliding
-- window of rows.
CREATE INDEX IF NOT EXISTS paste_consumed_nonces_expires
    ON paste_consumed_nonces (expires_at_ms);
