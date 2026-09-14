## Issue 609 — reopened cards keep their priority

### What changed

Creation remains the append operation at `work-board/store.ts:704-757`. Reopening is no longer routed through that policy: `restoreActivePosition` reads active siblings in their existing order, inserts the completed card at its stored ordinal, and compacts the active ranks transactionally at `work-board/store.ts:671-701`.

Manual status reopening invokes that restoration at `work-board/store.ts:1054-1074`; run binding invokes the same rule at `work-board/store.ts:1286-1306`. The owner-visible ordering rule is therefore: a positive integer `sort_order` is the previous ordinal, clamped only when the lane became shorter; an invalid or non-positive legacy value is unknown and is placed first at `work-board/store.ts:689-691`. Unknown does not degrade to append.

The helper preserves every active sibling's relative order while assigning the unique contiguous ranks `1..N` at `work-board/store.ts:681-700`. The transaction itself continuously maintains that invariant, so it does not depend on the caller remaining healthy after the write begins; both callers already enter a database transaction at `work-board/store.ts:937` and `work-board/store.ts:1286`.

### Decisions

I kept unshelving's established append behavior separate at `work-board/store.ts:1064-1074`; the issue concerns completed-card reopening, and broadening it would change a distinct product rule. No new error, verdict, state, or refusal was introduced, so there is no outcome vocabulary to extend or default behavior to classify.

The complete set of reopen/append prose in the scoped TypeScript tree was enumerated with `rg -n "re-appends? (it|the item)|Append a new item at the END|un-shelving re-appends" work-board trident --glob '*.ts'`. Its positive control found creation at `work-board/store.ts:704`; the only remaining re-append hit is the intentionally unchanged unshelving test at `work-board/store.test.ts:662`. Thus the removed completed-card append claim has no remaining hit under that search.

No product decision changed, so neither `SPEC.md` nor a spec item changed. I did not modify `trident/board-reconcile.ts` or `open/composer.ts`; the changed-file set was enumerated with `git status --short` before staging.

### Tests and mutation table

The manual path tests prior-position collision repair, unique ranks, sibling order, a middle-card round trip, and unknown-position front placement at `work-board/store.test.ts:84-125`. The run-binding path tests the same collision-sensitive restoration at `work-board/store.test.ts:1212-1225`.

| Guard | Mutation and landed line | Red proof | Restored proof |
|---|---|---|---|
| Manual reopen calls restoration | Replaced the call at `work-board/store.ts:1063` with a no-op comment | `bun test work-board/store.test.ts --test-name-pattern 'restores its prior position'`: 1 failed; duplicate ranks were `[1,1,2]` | Focused two-file run green |
| `attachRun` calls restoration | Replaced the call at `work-board/store.ts:1301` with a no-op comment | `bun test work-board/store.test.ts --test-name-pattern 'attachRun re-opening'`: 1 failed; duplicate ranks were `[1,1,2]` | Focused two-file run green |
| Unknown prior position goes first | Changed fallback at `work-board/store.ts:691` from `0` to `ids.length` | `bun test work-board/store.test.ts --test-name-pattern 'unknown prior position'`: 1 failed; card moved from first to last | Focused two-file run green |

Final local verification: `bun test work-board/store.test.ts trident/escalation-block.test.ts` passed 107 tests. The protected escalation test remained unmodified and its no-reorder assertions are at `trident/escalation-block.test.ts:537-577`. `bash scripts/ci/typecheck-all.sh` passed all 51 configurations; `bash scripts/ci/lint.sh` passed all gates; `git diff --check` passed.

### Deliberately not done

I did not change archived-card placement, board reconciliation, composition, migrations, status vocabulary, or any client surface. The existing numeric column is retained across completion by the genuine-completion branch at `work-board/store.ts:1048-1054`, and transactional rank compaction resolves active-lane collisions without a schema change.
