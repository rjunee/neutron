-- 0003_p7_2_s3_escalation_consumption.sql — per-project escalate-to-chat
-- consumption tracking (P7.2 S3).
--
-- Per docs/plans/2026-05-23-003-feat-p7-2-s3-inline-comments-ui-watcher-escalate-plan.md
-- Part C ("Escalate-to-chat event + chat-surface seed").
--
-- Background: S3 adds the `escalate_to_chat` event kind (already
-- reserved in the S1 vocabulary at anchor-materialiser.ts:40). When a
-- chat turn fires, the `EscalationContextLoader` reads pending
-- (unconsumed) `escalate_to_chat` events from `doc_comment_events`,
-- splices their thread context into the system prompt, and marks them
-- consumed so subsequent turns don't re-splice the same context.
--
-- Consumption tracking lives in a SIDE-TABLE rather than as a column
-- on `doc_comment_events` because:
--   (1) `doc_comment_events` is strictly append-only — adding a
--       mutable `consumed_at` column on event rows breaks that invariant
--       and forces every downstream tool to reason about "is this row
--       still settled?". A side-table preserves the event log as the
--       immutable source of truth.
--   (2) The alternative — an `escalation_consumed` event kind — would
--       still need a new schema entry AND would change the materialiser
--       contract (every read fold would need to filter consumed-by
--       events on top of the existing kind fold). The side-table is
--       smaller, faster, and lives outside the materialiser entirely.
--
-- Forward-only. Idempotent (CREATE ... IF NOT EXISTS everywhere) so a
-- re-run is a no-op.

CREATE TABLE IF NOT EXISTS escalate_consumption_state (
    -- The `event_id` of an `escalate_to_chat` row in
    -- `doc_comment_events`. Not a FOREIGN KEY: a future cleanup pass
    -- might vacuum old events out of the log without rewriting the
    -- consumption table, and SQLite's FK enforcement would block that.
    -- An entry without a backing event is harmless (LEFT JOIN against
    -- the events table simply drops the orphan row from the result
    -- set the next time the loader runs).
    event_id              TEXT PRIMARY KEY NOT NULL,

    -- ms-epoch when the loader marked this event consumed. Used by an
    -- eventual cleanup pass to drop rows older than N days.
    consumed_at           INTEGER NOT NULL
);

-- Cleanup-pass index: support `DELETE FROM escalate_consumption_state
-- WHERE consumed_at < ?` without a table scan.
CREATE INDEX IF NOT EXISTS idx_escalate_consumption_consumed_at
    ON escalate_consumption_state(consumed_at);
