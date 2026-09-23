## 2026-09-23 — Bind standalone review recovery to the measured revision

The standalone review step used run, task and round as its durable identity.
Recovery can retain a round while the measured branch head moves, so the worker
could return that round's earlier result instead of reviewing the new revision.
The driver now includes the measured head in both the worker step identity and
the pending checkpoint reservation. Reconciliation on the same head retains the
same identity. Review budgets and the existing approval, provenance and merge
checks retain their previous behavior.

This implements the standalone portion of
`docs/spec-items/trident-build-efficiency.md:154-166`, tracked by #1196. It does
not claim durable panel or synthesis receipt recovery, or deployed performance
acceptance; those remain separate integration work.

Verification: `trident/build-run.test.ts` passes all 211 tests. The paired review
recovery cases model completed work followed by a missing CI observation, then
host reconciliation and driver restart. An unchanged head buys no second review;
a moved head buys exactly one, with the same review round and a matching durable
reservation. Removing the head suffix fails the moved-head case because the old
result cannot authorize the new revision. Giving each request a fresh random
suffix fails the unchanged-head case because it buys a duplicate review. Both
mutations execute valid code, and both restored cases pass. Root and Trident
TypeScript checks pass.
