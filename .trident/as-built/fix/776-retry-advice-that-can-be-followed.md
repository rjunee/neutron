## 2026-09-14 — merge refusal advice follows the measured remedy

### What changed

`interpretFailure` now names two outcomes that previously inherited generic merge-mechanics copy. `merge-base-held` preserves the base-drift gate's authored, measurement-specific remedy (`trident/delivery.ts:1183`), while `merge-worktree-preserved` tells the owner to inspect, rescue, and clear preserved work before dispatching again (`trident/delivery.ts:1226`). Both join the existing `FailureClass` vocabulary (`trident/delivery.ts:97`). The terminal composer has special rendering only for deferral, escalation, and publication; both new values therefore retain the ordinary failed-delivery rendering by default (`trident/delivery.ts:1356`).

The preserved-work outcome covers both refusal writers reached through merge cleanup: refusing to replace the run's deterministic merge worktree (`trident/merge.ts:1724`) and refusing to remove lingering worktrees on the branch (`trident/merge.ts:1793`). Both derive or inspect the same paths on every attempt and explicitly require a human to rescue and clear them first (`trident/merge.ts:1727`, `trident/merge.ts:1798`).

The base-hold outcome keeps false and unknown apart by preserving the writer's own remedy. A missing ref can be fetched on another build and says to re-run (`trident/merge.ts:1389`); when both refs resolve but no common ancestor is found, the writer says another run reaches the same point and prescribes a manual look (`trident/merge.ts:1404`). Observed base movement likewise remains retryable so the diff can be reviewed against the current base (`trident/merge.ts:1418`).

The existing measured-size distinction is unchanged: measured oversize remains `merge-too-large` (`trident/delivery.ts:1163`), while a diff that could not be measured is wrapped as mechanics because a git read actually failed (`trident/orchestrator.ts:5358`). Generic merge mechanics still discard raw stderr and recommend retry (`trident/delivery.ts:1250`).

### Enumeration and decisions

The refusal writers were enumerated from the `cleanupAfterMerge` implementations and their orchestrator catch, then their persisted reasons were exercised through `interpretFailure`. The symbol search used `TridentBaseDriftHold` as its positive control and found its five throw sites (`trident/merge.ts:1887`, `trident/merge.ts:1904`, `trident/merge.ts:1971`, `trident/merge.ts:2016`, `trident/merge.ts:2166`) plus the orchestrator consumer (`trident/orchestrator.ts:5339`). The same search found the two preserved-work phrases at `trident/merge.ts:1727` and `trident/merge.ts:1796`, and the unreadable-diff control at `trident/merge.ts:219`.

The two worktree messages share one class because they establish the same fact and demand the same prerequisite; separate copy would let their remedies drift. Base holds use one class but retain the authored sentence because the measurement inside that family decides whether another build is useful. Prefixes are anchored so branch names, paths, and quoted diagnostics cannot manufacture either class (`trident/delivery.ts:1190`, `trident/delivery.ts:1234`).

### Tests and mutations

The delivery tests exercise both preserved-work writers, the retryable and non-retryable base-hold measurements, the unreadable-diff control, and a genuine raw git failure (`trident/delivery.test.ts:321`, `trident/delivery.test.ts:335`, `trident/delivery.test.ts:360`, `trident/delivery.test.ts:382`, `trident/delivery.test.ts:675`).

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| deterministic merge-worktree prefix (`trident/delivery.ts:1235`) | prefixed matcher with `MUTATED` | focused test received `merge-mechanics` instead of `merge-worktree-preserved` | focused four-case matrix passed |
| lingering branch-worktree prefix (`trident/delivery.ts:1236`) | prefixed matcher with `MUTATED` | focused test received `merge-mechanics` instead of `merge-worktree-preserved` | focused four-case matrix passed |
| base-hold prefix (`trident/delivery.ts:1190`) | prefixed matcher with `MUTATED` | retryable fixture received `unknown`; unrelated-history fixture received `merge-mechanics` | full touched test file passed, 75 tests |

Final local gates: `bun test trident/delivery.test.ts` passed 75 tests; `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript configurations; `bash scripts/ci/lint.sh` passed every reported lint guard.

### Deliberately not done

No merge behavior or refusal writer changed; `trident/merge.ts` remains untouched. No feature flag or parallel delivery path was added. The generic mechanics copy remains the fallback for actual git failures and unreadable diff measurements, and the existing measured oversize arm remains unchanged.
