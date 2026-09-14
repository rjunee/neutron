## 2026-09-14 — board budget survives reconciliation and zero means no iterations

### What changed

The real-store coverage now dispatches a governed run, advances it to its cap, passes that exact stored run through terminal reconciliation, clears the terminal link by re-queuing the card, and proves the next dispatch is refused without creating another run (`trident/board-reconcile.test.ts:254-293`). This closes the untested join between the existing reconcile budget case (`trident/board-reconcile.test.ts:64-95`) and dispatch refusal case (`trident/board-dispatch.test.ts:164-174`).

Zero is a real cap meaning “no iterations.” Migration 0142 rebuilds `work_board_items` with a non-negative cap constraint and preserves every existing column and index (`migrations/0142_work_board_zero_ralph_cap.sql:5-50`). The migrated-store case proves a terminal reconcile persists `0` (`trident/board-reconcile.test.ts:97-108`), and the generated schema pins the resulting constraint (`migrations/expected-schema.txt:1584-1591`). This follows the run-store vocabulary: present non-negative safe integers are caps, while only absent input receives the default (`trident/store.ts:759-766`). The database CHECK continuously maintains the non-negative invariant independently of the reconciling process.

`detachRun`'s status on the `/code` board binder is established by NAMING ITS CALLER,
not by removing it. The lane first removed the member from `open/composer.ts:2116` on
the strength of `rg '\.detachRun\('` finding no caller. That search could not have
found this one: the gate is a TYPEOF PROBE, not a call —
`trident/code-command.ts:305` reads
`typeof ctx.work_board.detachRun === 'function' ? buildBoardReconcileObserver(...) : null`,
and `open/composer.ts:2220` hands `tridentCodeBoardBinder` in as `work_board`. Because
`TridentBoardBinder.detachRun` is OPTIONAL (`trident/board-dispatch.ts:290`), dropping
it is not a type error either. The effect would have been silent: `/code stop` would
stop reconciling the bound card — exactly the §F6a (r6) behaviour pinned at
`trident/code-command.test.ts:336`, which stays GREEN through the removal because it
supplies its own stub that HAS the member. The declaration is restored, and the gap
that let it look dead is closed by a composition-boundary pin at
`open/__tests__/open-board-terminate-wiring.test.ts:171` — the file whose own docblock
says the unit suites all inject fakes and therefore never exercise this wiring. The
positive control inside that pin is `attachRun:`, found by the same slice.

### Decisions

The store contract wins: zero means no iterations, not “unset.” Changing that boundary would contradict the explicit validation and defaulting behavior at `trident/store.ts:759-766`; the forward migration instead removes the stricter database disagreement. No new error, verdict, state, or refusal was introduced: re-dispatch joins the existing `ralph_budget_exhausted` outcome at `trident/board-dispatch.ts:952-959`, whose typed dispatch result is returned to the caller without creating a run.

### Mutation evidence

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Zero-cap CHECK | Changed `>= 0` to the old `>= 1` at `migrations/0142_work_board_zero_ralph_cap.sql:31` | Zero-cap reconcile failed with `SQLITE_CONSTRAINT_CHECK` | `bun test trident/board-reconcile.test.ts migrations/snapshot.test.ts` — 14 pass |
| Dispatch→reconcile seam | Changed the value handed to reconciliation at `trident/board-reconcile.test.ts:277` to `{ ...terminal, ralph_round: 0 }` | New cross-seam case failed: stored round was 0, expected 2 | New case green; existing reconcile half and dispatch half also green |

The contrast is the finding: under the seam mutation, `bun test trident/board-reconcile.test.ts -t 'terminal reconciliation advances'` and `bun test trident/board-dispatch.test.ts -t 'a card at its cap is refused'` both passed while the new composed case failed.

### Adding a migration is a whole-tree change (found by CI, fixed here)

The build lane never ran `migrations/`. Adding 0142 broke three suites, and only the
first was a bookkeeping update:

* `migrations/runner.test.ts:203` asserts `result.applied` against an EXHAUSTIVE
  hardcoded ordinal list. `142` added. The list is a whole-tree value, like the
  spec-items count — but it is the SAFE version of that hazard: two branches adding
  different ordinals edit the same line region, so git conflicts rather than producing
  a silently wrong union. Recorded in the file rather than changed.
* `migrations/__tests__/live-ledger-125-repair.test.ts:93,:177` — same, two lists.
* `migrations/__tests__/live-ledger-122-reapply.test.ts` — NOT bookkeeping. Its seed
  modelled a live database in which 0133 was skipped by excluding ordinal 0133 and,
  as a HOLE, ordinal 0140 (the rebuild that depends on 0133's columns). Keeping
  everything after that hole built a ledger no live database can have: 0141's
  `ALTER TABLE … ADD ralph_round` landed on the pre-0140 table, the act then replayed
  0140, whose column list predates 0141 and therefore DROPPED both Ralph columns, and
  0141 was already recorded so nothing put them back. Nothing needed those columns
  until 0142, which rebuilds from a list that includes them and died on
  `no such column: ralph_round`. The FIXTURE was wrong, not the migration: a live
  database is a PREFIX of the ledger, never the ledger with a hole in it. The single
  ordinal is now a boundary (`FIRST_PR_DEPENDENT_REBUILD = 140`) and the seed stops
  there, so every later migration runs in the act in real order and no future ordinal
  needs adding here. 0142 itself is unchanged — with the real repairs, 0133 is
  reapplied first and 0142 rebuilds correctly (`reapply lands the missing columns`).

208 migration tests pass; 401 across every touched suite.

### Verification and deliberate limits

`bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript configurations. `bash scripts/ci/lint.sh` passed every gate. The final focused run passed `trident/board-reconcile.test.ts`, `trident/board-dispatch.test.ts`, and `migrations/snapshot.test.ts`. The Open terminate wiring suite was also attempted by the build lane, but its harness
failed before the subject because `Bun.serve({ port: 0 })` raised `EADDRINUSE`. It was
run at review time and passes (3 tests), including the new binder pin.

Review-lane mutation, run against PRODUCTION code rather than against the test's own
fixture, because a mutation of the fixture proves only that the fixture is read:

| Mutated site | Mutation | New composed case | `board-reconcile.test.ts:64` half | `board-dispatch.test.ts:164` half |
|---|---|---|---|---|
| `work-board/store.ts:1066` (the re-queue that clears the terminal link) | also `push('ralph_round', 0)` | RED | GREEN | GREEN |
| `work-board/store.ts:1066` | also `push('max_ralph_rounds', null)` | RED | GREEN | GREEN |
| `migrations/0142…sql:31` | `>= 0` restored to `>= 1` | zero-cap case RED with `SQLITE_CONSTRAINT_CHECK` | — | — |
| `open/composer.ts:2116` | remove the `detachRun` member | binder pin RED | `code-command.test.ts` 26/26 GREEN | — |
| `trident/board-dispatch.ts:1456` (`effectiveMaxRalphRounds`, the DISPATCH side of the seam) | replaced with a constant `99` | RED | GREEN | GREEN |

The first two rows are the contrast the finding requires: a break in the SEAM — the
card's budget surviving the re-queue that drops the link, the PR number and the PR URL —
is invisible to both halves and visible only to the composed case.

`trident/board-dispatch.ts` carries one COMMENT-ONLY correction and no behaviour
change: its budget gate documented the cap as "a value the store has already validated
on the way in (`max_ralph_rounds >= 1`, migration 0141)", which this change makes
false. The sentence now names 0142 and its `>= 0`, and records that both `??` on that
line are nullish rather than truthy on purpose — a `||` there would read a zero cap as
ABSENT and admit the card the owner capped at nothing, which is the shape of the
already-shipped `item.max_ralph_rounds ?? deps.max_ralph_rounds` defect the surrounding
comment describes. Grepped for the same pattern across the budget path
(`ralph_round *||`, `max_ralph_rounds *||`, truthiness tests on the cap), positive-
controlled against the `??` sites that do exist: no `||` or truthiness test on either
field anywhere in the tree. No feature flag or parallel runtime path was added. `SPEC.md` and the spec item were not changed because the product decision was already explicit in the run-store contract (`trident/store.ts:167-184`); this change aligns persistence and test coverage with it.
