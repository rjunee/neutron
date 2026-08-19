-- 0121_usage_pool_samples_account_grain.sql
--
-- The gauge series grows two dimensions it always needed: WHICH ACCOUNT a reading
-- belongs to, at key grain, and HOW LONG the window it describes actually is.
--
-- ── WHY THE ACCOUNT MOVES INTO THE KEY ───────────────────────────────────────
-- 0119 keyed the series `(ts, pool)`, which is exactly right for one account per
-- pool and silently wrong for two: two accounts of the same pool measured in the
-- same millisecond collapse into ONE row, and the `ON CONFLICT DO UPDATE` that
-- makes a double-write idempotent then overwrites the first account's standing
-- with the second's. The row that survives carries the second account's numbers,
-- and nothing anywhere can tell.
--
-- That matters now because the dashboard answers a per-account question: "how much
-- weekly capacity does account X have left" has to be answerable WITHOUT a live
-- probe of X, which means the store must retain both windows for every account it
-- has ever seen — not just for whichever one was measured most recently. A key
-- that cannot hold two accounts cannot hold that answer.
--
-- ── WHY `account_label` IS NOT NULL WITH AN EMPTY-STRING SENTINEL ────────────
-- A nullable column in a PRIMARY KEY is not a key: SQLite compares NULL to NULL as
-- "not equal", so every unlabelled row would be distinct and the idempotency the
-- key exists for would quietly stop working on exactly the ordinary case (the
-- credential is swapped from outside this process, so most readings are
-- unlabelled). The empty string is the "nothing can name this account" value and
-- it is mapped back to NULL by `persistence/usage-samples-store.ts` at the
-- boundary, so no reader ever sees it and no surface can mistake it for a name.
-- An empty string is not a guess; it is the absence of one, spelled in a way a
-- key can compare.
--
-- ── WHY THE WINDOW LENGTHS ARE COLUMNS AND NOT CONSTANTS ────────────────────
-- Pace is `fraction consumed ÷ fraction of the window elapsed`, so it needs the
-- window's LENGTH. That length was hardcoded 5h/7d, which is true of Anthropic and
-- not true in general: Codex changed regime (300 → 10,080 minutes, observed
-- 2026-07-12), so a series that straddles the change cannot be summarised with one
-- constant without producing confident wrong numbers on one side of it. The length
-- therefore travels WITH the sample that used it, and a reading whose provider did
-- not report a length stores NULL and falls back to that pool's documented default
-- — never to another pool's.
--
-- Nullable, because most rows genuinely do not carry one: the Anthropic probe reads
-- utilisation and reset headers and no length, and its 5h/7d regime is the default.
--
-- SQLite cannot widen a PRIMARY KEY in place, so this is the standard table-rebuild
-- dance (same shape as 0008). The runner wraps the body in BEGIN/COMMIT, so it is
-- atomic; existing rows carry across with their label coalesced to the sentinel and
-- their window lengths left NULL, which is exactly what they were measured with.

CREATE TABLE usage_pool_samples_new (
    ts                INTEGER NOT NULL,
    pool              TEXT    NOT NULL,
    -- '' means "nothing can name the account", never a name. See the note above.
    account_label     TEXT    NOT NULL DEFAULT '',
    session           REAL,
    weekly            REAL,
    session_reset_at  INTEGER,
    weekly_reset_at   INTEGER,
    -- The length of the window each fraction describes, as the provider reported
    -- it. NULL = not reported; the reader falls back to the pool's default.
    session_window_ms INTEGER,
    weekly_window_ms  INTEGER,
    PRIMARY KEY (ts, pool, account_label)
) STRICT;

INSERT INTO usage_pool_samples_new (
    ts, pool, account_label, session, weekly, session_reset_at, weekly_reset_at
)
SELECT
    ts, pool, COALESCE(account_label, ''), session, weekly, session_reset_at, weekly_reset_at
FROM usage_pool_samples;

DROP TABLE usage_pool_samples;

ALTER TABLE usage_pool_samples_new RENAME TO usage_pool_samples;

-- Recreate the read index 0119 declared; the old one went with the old table.
-- The read pattern gains a second shape — the newest row per account of one pool —
-- which this same index serves, because the account is filtered from a small
-- per-pool slice rather than scanned across pools.
CREATE INDEX IF NOT EXISTS idx_usage_pool_samples_pool_ts
    ON usage_pool_samples (pool, ts);
