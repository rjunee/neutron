## 2026-09-19 — Provision Bun workspace dependencies before project workers

A dispatched build reached the terminal publication suite with no worktree-local
Bun store. The existing workspace verifier refused before discovering tests; its
exit 3 correctly prevented merge. Preparation had created and verified the Git
worktree without preparing its ignored dependencies.

`open/wiring/project-build.ts:257` now prepares dependencies before constructing
workers, including when recovering an existing worktree. The helper recognizes
Bun workspaces using the package manifest and Bun lockfile or package-manager
declaration. Other repositories retain their existing setup behavior. It runs
`bun install --frozen-lockfile --ignore-scripts` in the assigned worktree with a
ten-minute command budget and an append-only run-owned `dependencies.log`
(`open/wiring/project-build-dependencies.ts:17`). Failed or timed-out installation,
an absent/empty install, and a shared root `node_modules` symlink refuse preparation.

For repositories carrying the workspace verifier contract, preparation executes
the host-owned verifier against the worktree, never the branch-owned script
(`open/wiring/project-build-dependencies.ts:56`). Lifecycle scripts are suppressed
at this new host preparation boundary. This may leave script-generated artifacts
for the project's build workflow; it never turns their absence into a passing
suite. The existing host-observed full-suite receipt remains the merge authority.

This implements the gate-preservation requirement in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265`,
`docs/spec-items/the-orchestrator-owns-the-build-loop.md:56`, and G063 in
`docs/trident-gates-inventory.md:137`. It does not establish the spec item's live
unattended-MERGED acceptance criterion; the end-to-end evidence here is offline.

`open/__tests__/project-build-e2e.test.ts:739` adds a real local tarball dependency,
a committed Bun lockfile, package-local import, and the real workspace verifier
to the prepare → worker → publication → merge fixture. Fresh preparation and
recovery reach MERGED. Complementary cases cover failed installation even after
files were installed, zero-but-empty installation, an empty Bun store, timeout
receipts, an actually killed hung child, shared symlinks, lifecycle suppression,
and the host-owned verifier with an executable branch-script positive control.
Removing dependencies after preparation leaves the PR open and the base unchanged.
Dependency-free non-Bun fixtures prove only that setup is correctly a no-op.

Semantic mutation evidence: removing the preparation call fails the real import
case while all four no-op controls pass; removing the package-manager/lockfile
selection fails the npm and unmarked-workspace controls while the Bun positive
passes; ignoring failure/timeout receipts fails both installed-but-unsuccessful
controls while the successful-install case passes. Each mutation was restored.

Verification: both root and Trident `tsc --noEmit` projects passed; focused
`bun test` passed 142 tests (zero failures) over `open/__tests__/project-build-e2e.test.ts`,
`open/__tests__/project-build-wiring.test.ts`,
`scripts/ci/verify-workspace-deps.test.ts`, and
`trident/gates/review-suite.test.ts`. The existing REPL wiring case requires local
loopback access. A targeted privacy scan of the four changed files plus the
required license control was silent. The complete repository suite and a live
deployment were not run for this isolated change.
