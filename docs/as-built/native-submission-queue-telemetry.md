## 2026-09-27 — Record native REPL submission-slot queue wait as its own stage interval

This is the queue-observation slice of #1295. The native Claude acting turn now
records how long it waited for the parent REPL submission slot, separately from
execution, and persists that interval against the existing run, step and
dispatch attempt identity.

What is measured:

- `native-submission-queue` covers the parent REPL submission-slot wait inside
  `session.acquireTurn`. It is not native child execution. The acting turn
  (`runtime/workers/claude-acting-turn.ts`) emits `stage-started` right before
  the acquisition call, with no intervening `await`, because the slot is claimed
  synchronously. It emits exactly one `stage-ended` when acquisition settles, with
  outcome `acquired`, `acquired-late` (the slot arrived after the original
  deadline) or `rejected`.
- `native-child-census-wait` covers the later wait for sibling admission proofs.
  It is only recorded when a native workspace is bound. It opens after the queue
  interval has closed, and it ends as `known`, `expired` or `interrupted`. It is
  never folded into the queue interval.
- If the outer deadline wins while the turn is still queued, nothing ends the
  interval. That open interval is the explicit unknown: no zero and no duration
  is invented. If the acquisition settles later, it closes the interval once as
  `acquired-late`, and the existing expiry checks still stop it from submitting.
  A measured zero, where the controlled clock does not advance, is recorded as
  zero.

Persistence reuses the existing advisory event path.
`AttemptAccounting.recordStageObservation` (`trident/attempt-accounting.ts`)
writes `build-stage-started` / `build-stage-ended` rows. Their meta carries
`{ run_id, step_id, attempt_id: 'dispatch', stage, started_at[, ended_at, outcome] }`,
the same shape the build timeline already parses. The production binding is in
`nativeChildTurn` (`open/wiring/project-build.ts`) and hands each observation
to `fireAndForget`. Nothing in the acting path awaits the sink. The observer is
wrapped at its call site, so a throwing or unavailable sink cannot change the
submission count, the original deadline, result validation, lease release or
retry behaviour. This deliberately differs from `onNativeDispatchEvidence`,
which fails closed. The overall attempt timestamps are unchanged: the queue
interval nests inside the attempt's `started_at`/`ended_at`, and the two are
never summed. No ledger, table, migration, flag, deadline or scheduling path was
added.

Known non-goal: `trident/build-timeline.ts` keys intervals by
`[stage, started_at]`. Two seats queued in the same millisecond therefore render
ambiguously in the timeline, although their durable rows stay distinct by
`step_id`.

Validation was first run on the original published candidate based on
`5c1578115` (the PR #1346 head). It was re-run on the refreshed candidate based
on `71f4aa84`, which is the same change reconciled onto refreshed main after
#1356 with an unchanged production diff. It was run again on this head, which
is a merge of that refreshed candidate and the published head, again with an
unchanged production diff. The only merge conflict was this record. The results
below were measured on this head; where the two earlier accounts differ, each is
kept and attributed to its head.

- Focused suites: 178 passed, 0 failed across 7 files, on all three heads. The
  files were the native dispatch evidence tests, the acting-turn tests, the
  native child workspace tests, the attempt accounting tests, the build timeline
  tests, the gates-inventory citations test and the native-child lease wiring
  test. The baseline for the first four files was 151 passed (measured on
  `5c1578115`, and again on `71f4aa84`).
  - The held-slot case uses a barrier and a controlled clock. It records the open
    interval while the slot is held and then `ended_at - started_at = 40`, closed
    before `submission-started`.
  - The other cases cover immediate zero, cancellation while queued, late
    acquisition, rejected acquisition and a throwing observer.
  - The census cases cover a census held open after the queue closed, and census
    expiry refusing with zero submissions.
- Consuming `open/__tests__/project-build-e2e.test.ts` cases went through
  `prepareProjectBuild`: 6 passed, 0 failed on this head, as on both earlier
  heads. The same filter without this change was 3 passed (on `5c1578115` and on
  `71f4aa84`).
  - A held first acquisition persists one started and one ended row for the plan
    step while the slot is held, nested inside the plan attempt, with the run
    merged.
  - A hung `acquireTurn` leaves exactly one started row and no ending.
  - A late acquisition after a 1.5s wall ends its interval once as
    `acquired-late` with zero submissions and released leases.
  - A sink that throws on queue rows still merges with one plan dispatch,
    released leases, a completed plan attempt and no queue rows.
- Root and leaf TypeScript checks: `scripts/ci/typecheck-all.sh` passed 51 of 51
  projects, including the root and `trident/tsconfig.json`, on all three heads.
  On this head the runner's `bunx` was provided as an alias of `bun`.
- Leak gate on this head's tree: no finding names any of the changed files. The
  local denylist baseline still reports findings under `app/` only, as on the
  earlier heads.
- Mutations, each performed on the acting turn, observed failing on an
  assertion, then reverted:
  1. Dropping the queue `stage-ended`. On this head it failed 6 focused cases
     (held slot, immediate zero, cancellation while queued with a late settle,
     census ordering, census expiry, and late acquisition after a not-submitted
     receipt) and the e2e held-slot and late-acquisition cases. The acting-turn
     suite stayed green as a control. Both earlier heads recorded the same
     focused and e2e failures.
  2. Moving the queue ending after the census wait (mislabelling it). On this
     head it failed the census-ordering case, the cancellation-while-queued
     late-settle case, the late-acquisition-after-a-not-submitted-receipt case
     and the e2e late-acquisition case. The published head's record lists the
     census-ordering and late-settle cases; the refreshed head's record lists
     the census-ordering case.
  3. Removing every pre-submission expiry check after acquisition (the new
     `if (late)` return, the post-census check and the post-boundary-capture
     check) permitted a late submission. On this head it failed 6 focused cases:
     late mutex acquisition, cancellation fencing a queued turn, expiry during
     boundary capture, census expiry, late acquisition after a not-submitted
     receipt and cancellation while queued. The e2e late-acquisition case stayed
     green, as the refreshed head's record says, because the wiring layer
     refuses the late turn on its own. The published head's record says that
     e2e case also failed; that was not reproduced on the refreshed head or on
     this head.
  4. Letting an observer failure escape failed the throwing-observer case, on
     all three heads.
  5. The opposite direction, refusing every acquired turn, failed the held-slot,
     immediate-slot and throwing-observer controls in the focused suites (95
     focused cases failed on this head) and the e2e held-slot, failing-sink,
     within-wall plan-turn and full-build accounting cases. Their legitimate
     sibling must still submit once.
- Removing only the new `if (late)` return is behaviour-neutral: on this head
  all 178 focused and 6 e2e cases stayed green. The existing post-census and
  post-boundary-capture expiry checks still refuse a late submission, so that
  line is not the load-bearing guard. The refreshed head's record also found
  that removing the first two checks together left every case green, for the
  same reason.

Not delivered: the #1295 queue-budget policy, historical lease recovery and the
issue as a whole. The host's full suite, review, mutation proof, leak preflight
and pinned merge remain the authority for this change.
