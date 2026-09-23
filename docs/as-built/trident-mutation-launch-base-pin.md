## 2026-09-23 — Bind publication mutation scope to the launch base

The project host supplied the configured branch name to the mutation prover even
though it already held the run's authoritative launch SHA. A stale local base
therefore expanded the three-dot changed-file range to include production files
that upstream had changed before the run began. A documentation/test change could
then be refused for not nominating a production mutation.

`trident/build-host.ts:180` now resolves the mutation range through the existing
`diffBaseRef` owner using the launch SHA and a lazy `refResolves` fallback. Only
the mutation invocation receives that resolved operand. Publication readiness
still receives the configured branch name (`trident/build-host.ts:186`), retaining
its origin-base and session-trailer checks. The existing mutation refusal,
nomination repair, head binding, and exemptions remain in their existing owners.
This repairs G105/G141 scope under the gate-preservation requirement in
`docs/spec-items/trident-build-efficiency.md`; it does not complete that item's
live efficiency acceptance.

The consuming regression at `open/__tests__/project-build-e2e.test.ts:1010` uses a
real repository and bare origin, lands upstream production code, pins the run to
that commit, and leaves local `main` behind. The docs/test-only sibling reaches
merge. Changing the production file after the pin still refuses publication
without a nomination. Both cases independently inspect the Git ranges: the old
local-base range includes the upstream production file, and the launch range
contains exactly this build's files. `trident/build-host.test.ts:189` also checks
the exact pinned range and that a valid pin never probes mutable base refs.

Semantic mutations were executed through that consuming E2E pair. Restoring the
raw branch operand makes the docs/test sibling fail with the false production
target refusal while the real production sibling stays green. Bypassing the
proof refusal makes the production sibling fail because it merges without proof,
while the exempt sibling stays green. Restoring the implementation returns both
to green; neither mutation relies on a parse error.

Validation: all 207 tests in `open/__tests__/project-build-e2e.test.ts` and 195
focused tests across the build host, project host, diff-base and
publication-readiness suites passed. The full E2E run needed local Unix-socket
access for the existing broker fixtures. Root and Trident TypeScript checks,
repository lint, and `git diff --check` passed. The changed-file leak scan was
silent. The full-tree local scan reported 455 PII matches reproduced on an archive
of the unchanged base `843741e7`, plus the worktree metadata pointer; this is not
a clean full-tree verdict. No gate or denylist was changed.
