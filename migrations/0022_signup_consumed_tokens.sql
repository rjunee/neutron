-- 0022_signup_consumed_tokens.sql
--
-- Sprint 30 — durable replay window for start-token JTIs. Replaces the
-- per-process `InMemoryConsumedTokens` that resets on every gateway
-- restart (Sprint 19 known WARN: a process bounce within the 15-min
-- start-token TTL allowed a second consume of the same JTI).
--
-- Per-instance SQLite store. The table is keyed on the JWT `jti` claim;
-- atomic INSERT-with-ON-CONFLICT-DO-NOTHING is the claim primitive
-- (returns true when the caller is the first claimant, false when a
-- prior INSERT already landed). `expires_at_ms` is persisted so a
-- background pruner can drop rows whose TTL has elapsed (4w default
-- per spec — the start-token TTL is 15 min, so 4w gives plenty of
-- headroom for forensic auditing of replay rejections).
--
-- Why no auto-prune trigger:
--   - SQLite triggers fire on row-write; we want time-based pruning,
--     not write-time. The existing cron infra owns the periodic
--     pruner (signup/consumed-tokens-sqlite.ts:pruneExpired runs on
--     the same cadence as the watchdog tick).
--
-- Forward-only.

CREATE TABLE IF NOT EXISTS signup_consumed_start_tokens (
    jti TEXT PRIMARY KEY NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    claimed_at_ms INTEGER NOT NULL
) STRICT;

-- Index on expires_at_ms so the pruner's
-- `DELETE WHERE expires_at_ms < ?` is fast even when the table
-- accumulates a 4-week sliding window of rows.
CREATE INDEX IF NOT EXISTS signup_consumed_start_tokens_expires
    ON signup_consumed_start_tokens (expires_at_ms);
