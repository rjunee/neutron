---
title: Rebalance the full app co-residency CI check onto shard 4
group: trident
status: open
priority: P2
cutover: false
---

# Rebalance the app co-residency check

Work state: GitHub issue #1397. This is a scheduling follow-up to the completed
host-suite audit #1298; it changes no test or runner coverage rule.

## Measured reason

On PRs #1394 and #1396, shard 1 took 11m17s and 12m20s while shard 4 took
4m06s and 4m26s. The full app co-residency step took 76.68s and 84.05s on
shard 1 before its normal slice. Moving that unchanged step to shard 4 is a
bounded way to reduce the critical path without adding another runner. The
rough 77–84 second saving is an estimate until exact-head CI measures it.

The larger shard-1 cost is the third general chunk, where
`open/__tests__/project-build-e2e.test.ts` contributed 244.6s and 251.5s of
reported case durations in the same two runs. Its test behavior and assignment
are outside this change.

## Acceptance

- [ ] The matrix still has shards 1, 2, 3 and 4 and exactly one matrix member
      runs the unchanged `bun test --isolate app/__tests__/ --max-concurrency=4`
      step, before that member's normal `scripts/run-tests.sh` slice. That member
      is shard 4. A missing app step, duplicate step, condition naming a shard
      outside the matrix, or condition sending it back to shard 1 fails the
      workflow guard. Verify: `bun test scripts/ci/ci-workflow.test.ts` and
      temporary condition mutations in both directions.
- [ ] All four ordinary shard slices and the required aggregate `test` check
      still execute, with each runner's discovered and assigned file counts
      accounted for. All exact-head CI checks pass. Report observed app-step,
      shard and aggregate durations against the two baseline runs without
      claiming a paired speedup where workload or contention differs.
