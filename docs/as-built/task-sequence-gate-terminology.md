## 2026-09-23 — Current terminology in Trident gate descriptions

The planner-selected execution strategy changed current build terminology to
`single` and `task_sequence` (SPEC.md Decisions Log 2026-09-23), but two gate
descriptions in the Trident inventory still called current task-sequence behavior
Ralph. G025 now names task-sequence builds, and G079 names task-sequence
continuation and the current `max_task_iterations` limit.

Only those two descriptions changed. The inventory's gate IDs, historical source
and test anchors, compatibility map, and recorded checkpoint strings remain
unaltered so the original evidence stays traceable. The enforcement code is
unchanged.

Verification: the spec-items index test passed (38 tests), the root and Trident
TypeScript checks passed, and `git diff --check` passed. A local full-tree leak
scan reported 456 findings: 455 inherited findings recorded by the preceding
planner-selected strategy change, plus one from this linked worktree's `.git`
pointer, which contains the sandbox path. No finding names either changed
documentation file. The PR's purity gate remains the authoritative
check for the published tree and commit message.
