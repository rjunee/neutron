-- 0108_work_board_heal_stale_inline_active.sql
--
-- Work Board ISSUES #386 — heal rows left in an IMPOSSIBLE state: a terminal
-- card ('done'/'failed') that still carries `inline_active = 1`.
--
-- WHY THIS MATTERS (hit live 2026-07-24, Ryan's `willow` project): the rail's
-- per-project pulsing activity indicator is driven by `inline_active`. A
-- terminal row with the flag still set therefore renders the project as
-- perpetually-working, and because nothing ever revisits a completed card, the
-- state CANNOT self-heal — it pulsed for DAYS off a single row:
--
--     status='done', inline_active=1, updated_at='2026-07-22T04:59:13'
--
-- A permanently-lying activity indicator is worse than no indicator: it trains
-- the owner to ignore the signal.
--
-- HOW THE BAD ROWS WERE BORN (two distinct holes, both now closed in code):
--   1. `update()` did not clear the marker on a transition into a terminal
--      lane. Fixed in 5909fe87 (2026-07-22 14:32 UTC) — but Ryan's row was last
--      written 2026-07-22 04:59 UTC, ~9.5h EARLIER, so the fix could never
--      retroactively repair it. Legacy rows from before that commit are exactly
--      what this migration exists to sweep up.
--   2. `setInlineActive()` set the marker with NO status guard at all, so the
--      broken state stayed reachable even AFTER (1) was fixed. Closed alongside
--      this migration by moving the terminal check into that statement's WHERE
--      clause (see `work-board/store.ts`).
--
-- Idempotent and safe to re-run: it only ever clears a flag on rows that are
-- already terminal, so it cannot affect live/upcoming work. On a healthy DB it
-- matches zero rows.
--
-- WHY NO CHECK CONSTRAINT (deliberate, not an oversight): the airtight form of
-- this invariant would be `CHECK (NOT (inline_active = 1 AND status IN
-- ('done','failed')))`. SQLite cannot add a CHECK to an existing column without
-- a full table rebuild (create-copy-drop-rename + recreating both indexes — the
-- 0097 CHECK-widen pattern). Every write path into `inline_active` is now
-- guarded in one place (`update()`'s terminal transition, `setInlineActive()`'s
-- WHERE guard, and `attachRun`/`detachRun`, which already cleared it), and the
-- store is the sole writer, so the rebuild's risk on live tenant data is not
-- justified for a cosmetic-indicator invariant. Revisit if a third write path
-- ever appears, or if this recurs despite the guards.

UPDATE work_board_items
   SET inline_active = 0
 WHERE inline_active = 1
   AND status IN ('done', 'failed');
