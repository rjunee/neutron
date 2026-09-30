## 2026-09-30 — Preserve nested native review identity in quota projection

The board compared every native child's actual request step directly to the
host checkpoint's pending step. Panel review and synthesis construct a separate
request step (`trident/project-review-source.ts:273`), so the durable wait could
exist while the card showed no quota notice. This extends the earlier
[quota projection record](work-board-claude-quota-wait.md) without changing it.

The projection matches an explicit authenticated binding's `parentStepId` to
the pending host step, then matches quota state to that binding's actual
`stepId` and `childId` (`trident/run-progress.ts:139`). The producer must retain
the parent from its original signed dispatch; the projection never derives
nesting from punctuation, prefixes or the currently observed checkpoint.
Unmapped historical nested children remain hidden. A present malformed parent
cannot fall back to a direct-step match. The store retains three run-indexed
latest-row queries, returning at most three rows (`trident/store.ts:1444`).
Replacement binding, matching resume/end, settlement and terminal precedence
remain in force. This change does not alter dispatch, budgets, leases or claims.

Focused validation covers real nested request-shaped identities, known and
unknown reset times, foreign host and child steps, changed checkpoints,
replacement binding, database reopen, and unrelated ledger noise
(`trident/run-progress.test.ts:45`, `trident/quota-wait-projection.test.ts:21`).
Returning null for every wait caused both accepting controls to fail; removing
the enclosing-step comparison caused the unmapped-child refusing control to
fail. Both mutations were reverted. The focused two-file suite passed 47 tests
with 158 assertions. `bun test gateway/http/work-board-surface.test.ts -t quota`
passed its HTTP/push durable-state test with seven assertions.
`bunx tsc -p tsconfig.json --noEmit` and
`bunx tsc -p trident/tsconfig.json --noEmit` both passed. These checks used the
isolated projection diff over base `48d4afb9f`; the producer's actual
held-synthesis consuming test and the complete suite require the integrated
producer/projection revision.
