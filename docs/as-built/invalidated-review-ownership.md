## 2026-10-09 — Release completed review ownership while retaining verdict invalidation

Passive native-child reconciliation rejected an invalidated panel receipt before
reading its authenticated original terminal result. That kept the old child in
the durable census and could block a later planner. Review invalidation governs
verdict acceptance; the ordinary runner already discharges validated child
ownership independently (`open/wiring/project-build.ts:886`).

The canonical review-artifact check now retains the original receipt identity,
request hash and request bytes without treating `input-changed` as a completion
veto (`open/wiring/claude-native-dispatch-reconcile.ts:100`). Signed dispatch,
canonical attempt and lease, artifact paths, armed reservation, and completed or
blocked result validation remain required before exact-token release. The
review source still rejects the invalidated verdict
(`trident/project-review-source.ts:155`). No result or review receipt is rewritten.

The consuming regression creates a real pending review-source request, invalidates
its receipt, and supplies its original completed result. A planner's measured
linked-worktree census refuses host operations before reconciliation and permits
its brief operation afterward, while the same verdict remains unusable and
unrelated ownership survives. Run, attempt, request, receipt, reservation and
result remain unchanged
(`open/wiring/__tests__/claude-native-dispatch-boot.test.ts:163`). Actual Open
composition also consumes invalidated review and synthesis results at startup
and on a later recovery tick with zero native turns (same file, line 327).

Focused verification: the native-dispatch boot suite passed 126 tests with 236
assertions; the review-source suite passed 63 tests with 408 assertions. Root
and Trident TypeScript checks passed. Four isolated must-fail mutations were
rejected: restoring the invalidation veto, bypassing request-hash comparison,
bypassing terminal payload validation, and removing review-source invalidation
refusal. All mutated sources were restored afterward. Combined validation at
`164112fef451829fcb78002b0f15714dd30d1df0` completed all 51 typechecks and all
1,801 discovered test files: 28,069 passed, 24 skipped and the existing #1457
subprocess setup case failed. The frozen input identity remained unchanged and
the full local gate remains FAIL. See
[salvage branch ownership](salvage-branch-ownership-1009.md) for the exact receipt.
Final publication review, exact-head CI and live deployment acceptance remain
delivery work; this slice does not establish unattended build completion.

The five-file ownership slice's corpus and commit-message leak checks passed. The full local
tree scan reported 452 findings, including worktree metadata, so it is not
recorded as a passing publication gate; delivery must resolve or independently
classify those findings.
