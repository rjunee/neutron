-- 0119_usage_pool_samples.sql
--
-- Remember the usage readings we already take and throw away.
--
-- BACKGROUND. `open/credential-usage-monitor.ts` probes the active credential every
-- 60 seconds, caches ONE reading in memory, and ages it out after five minutes. So the
-- product measures utilisation continuously and remembers nothing: the meter can say
-- "72% of the 5-hour window" and cannot say whether that is climbing fast or flat, how
-- much was left an hour ago, or when it last hit the ceiling.
--
-- That gap is the whole reason a usage dashboard needs a migration before it needs a
-- chart. "Which pool can take this build?" is a question about a TREND, and a single
-- instantaneous number cannot answer it.
--
-- WHY THIS TABLE IS DELIBERATELY DUMB. One row per (timestamp, pool): the fractions
-- upstream reported and the reset timestamps it gave us. No derived columns — pace,
-- projected-exhaustion and time-to-reset are all computed at read time from this
-- series, because a stored derivative is a second source of truth that goes stale the
-- moment the formula improves.
--
-- `account_label` IS NULLABLE AND USUALLY NULL, and that is honest rather than
-- provisional. When several accounts are rotated, the swap happens OUTSIDE this
-- process — a credential file is replaced underneath a running child — so the instance
-- genuinely cannot name the account behind a reading. The column exists so that IF the
-- rotator ever writes a label down, the history gains the dimension without a
-- migration; until then every row says NULL and the UI says "active credential" rather
-- than guessing. An inferred account name presented as a measurement would be worse
-- than no account name at all.
--
-- RETENTION is 30 days, pruned by the collector's own tick rather than a separate job:
-- a schedule that can fall out of step with its writer is a schedule that eventually
-- either grows forever or deletes something in use.
--
-- PRIMARY KEY (ts, pool) makes a double-write in the same millisecond idempotent
-- instead of a duplicate. The poll interval is 60s so this never fires in practice —
-- it is here so that a future faster tick, or two boots overlapping by a moment, cannot
-- corrupt the series.

CREATE TABLE IF NOT EXISTS usage_pool_samples (
    ts               INTEGER NOT NULL,
    pool             TEXT    NOT NULL,
    account_label    TEXT,
    session          REAL,
    weekly           REAL,
    session_reset_at INTEGER,
    weekly_reset_at  INTEGER,
    PRIMARY KEY (ts, pool)
) STRICT;

-- The only read pattern: one pool's recent history, newest last.
CREATE INDEX IF NOT EXISTS idx_usage_pool_samples_pool_ts
    ON usage_pool_samples (pool, ts);
