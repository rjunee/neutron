## Issue 629 — Ralph budget survives re-dispatch

### Reading and decision

The allowance bounds work on one card, not one run. The former row-owned counter was incremented at `trident/orchestrator.ts:4877-4927`, while dispatch could reconstruct it only through the movable run link at `trident/board-dispatch.ts:1260-1369`. That made re-dispatch identity, rather than card identity, determine whether the allowance survived.

Exhaustion joins `BoardBoundBuildRejectionCode` at `trident/board-dispatch.ts:430-463` as `ralph_budget_exhausted`. The gateway's existing default maps every rejection other than `backend_error` to HTTP 409 at `gateway/http/work-board-surface.ts:507-517`; the new value is also present in its exhaustive transport union at `gateway/http/work-board-surface.ts:91-128`.

### Built

Migration `migrations/0141_work_board_items_ralph_budget.sql:1-9` adds the card-owned round and optional cap. New cards start with no established cap, so dispatch applies the configured full allowance at `trident/board-dispatch.ts:1430-1508`. Terminal reconciliation passes the governed run's pair at `trident/board-reconcile.ts:122-129`, and the store writes a monotone `MAX` round and tightening `MIN` cap at `work-board/store.ts:1352-1359`. This observer is composed outside the build process and is the continuous maintainer whenever a bound run becomes terminal.

Dispatch reads the card snapshot independently of `linked_run_id` at `trident/board-dispatch.ts:1230-1240`. At the cap it returns the named refusal before run creation at `trident/board-dispatch.ts:933-947`, so exhaustion is distinguishable from completion.

### Tests and mutations

The acceptance cases are at `trident/board-dispatch.test.ts:111-157`; terminal persistence is at `trident/board-reconcile.test.ts:64-75`.

| Guard | Mutation | RED evidence | Restored GREEN evidence |
|---|---|---|---|
| Card snapshot carry, `trident/board-dispatch.ts:1234-1240` | inserted `false` into the snapshot-selection condition; printed landing line 1244 before the run | linkless `2/3` re-dispatch produced `0/20` | focused three-case dispatch run: 3 pass |
| Fresh-card configured cap, `trident/board-dispatch.ts:1434` | replaced configured fallback with `1`; printed landing line 1443 before the run | expected `0/3`, received `0/1` | focused three-case dispatch run: 3 pass |
| Exhaustion refusal, `trident/board-dispatch.ts:939` | inverted `>=` to `>`; printed the mutated predicate before the run | at-cap dispatch returned success | focused three-case dispatch run: 3 pass |
| Terminal card snapshot, `work-board/store.ts:1355-1359` | inserted `false` into the governed-write condition; printed landing line 1355 before the run | expected `2/3`, received `0/null` | focused reconcile run: 1 pass |

Final verification: `bun test migrations/snapshot.test.ts work-board/store.test.ts trident/board-reconcile.test.ts trident/board-dispatch.test.ts` passed 161 tests; `bunx tsc --noEmit` passed; ESLint passed on every touched TypeScript file.

### Review findings, and what the lane's own verification missed

The guard as built read `item.max_ralph_rounds ?? deps.max_ralph_rounds` — it fell
back to the DISPATCH CEILING for a card with no snapshot. A card with no snapshot
has spent nothing, so the fallback could never refuse a card that had genuinely
spent anything; what it could do is answer a question it had not been asked. Two
existing cases in `trident/retry-resumes-checkpoint.test.ts` caught it:

- a deliberate ceiling of `0` ("no iterations — the LOOP refuses the first one",
  `retry-resumes-checkpoint.test.ts:960`) made `0 >= 0` true, so every fresh card
  was refused as exhausted and no run was written at all;
- an INVALID ceiling (`-5`) made `0 >= -5` true, so a config fault that the store
  refuses BY NAME as `backend_error` came back as `ralph_budget_exhausted` —
  "I could not read the cap" wearing "the cap is spent" as a mask
  (`retry-resumes-checkpoint.test.ts:996`).

The guard now reads the card's own snapshot and nothing else
(`trident/board-dispatch.ts:951`); the cap it compares against has already been
validated on the way in (`max_ralph_rounds >= 1`, migration 0141). A new case pins
that no dispatch ceiling — `0`, `-5` or `NaN` — can make a snapshot-less card read
as exhausted (`trident/board-dispatch.test.ts:150`).

That defect was reachable because the lane's final verification ran
`migrations/snapshot.test.ts work-board/store.test.ts trident/board-reconcile.test.ts
trident/board-dispatch.test.ts` and not `trident/retry-resumes-checkpoint.test.ts`
— the suite whose whole subject is this budget.

The reconcile case was also renamed-in-fact rather than proved: it claimed the
write is "monotonic" while only writing onto a fresh card. It now asserts both
directions (a delayed observer must not walk the spend back, a later cap must not
widen the card's) plus a control that a genuine advance IS recorded, and a second
case pins that a NON-governed terminal run leaves the budget untouched
(`trident/board-reconcile.test.ts:64`).

Three pinned migration-ordinal lists were stale at 140 and are repinned to include
0141 after reading each and confirming it is the same construction
(`migrations/runner.test.ts:202`, `migrations/__tests__/live-ledger-125-repair.test.ts:93`,
`:177`). `BRANCH_ORDINAL` in `migrations/__tests__/ordinal-identity.test.ts` — a
fixture ordinal whose docblock requires it to sit ABOVE every real ordinal — had
been hand-pinned at 141 and collided with the new migration. It is now DERIVED from
the real tree, so the property its comment states is enforced rather than
re-asserted by hand each time a migration lands.

### Deliberately not changed

The per-run columns remain because the live loop and workflow cadence consume them at `trident/orchestrator.ts:4877-4950`; the card is the durable cross-run owner, while each active row is its execution snapshot. The older linked-row carry remains only for cards whose new snapshot is still null, avoiding a reset during migration. No product-spec decision changed.
