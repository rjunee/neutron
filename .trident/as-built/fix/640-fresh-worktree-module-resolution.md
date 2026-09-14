## Issue 640 — make fresh-worktree typecheck evidence trustworthy

### What changed

The typecheck entrypoint now resolves its own repository root, installs a missing
worktree-local bun dependency tree with the frozen lockfile, and verifies dependency
resolution before discovering or invoking any TypeScript project
(`scripts/ci/typecheck-all.sh:21-39`). The shared verifier now rejects a root
`node_modules` symbolic link as an invalid substitute for a local install
(`scripts/ci/verify-workspace-deps.ts:95-100`).

The regression constructs real linked git worktrees from a self-contained fixture
(`scripts/ci/typecheck-worktree.test.ts:33-71`). It separately proves that a fresh
worktree installs and typechecks, that a borrowed dependency link is refused before
`tsc`, and that an unsuccessful frozen install is refused before `tsc`
(`scripts/ci/typecheck-worktree.test.ts:74-101`).

### Historical trichotomy

Build agents performed the install themselves when their task material happened to
name it; this was load-bearing and not an invariant maintained by the build harness.
The Forge contract says the executor starts in a fresh isolated worktree and directs
it to run the selected tests, but contains no provisioning step
(`trident/inner-workflow.mjs:1723-1743`). This absence was checked with
`rg -n 'bun install|fresh isolated git worktree|Run the tests' trident/inner-workflow.mjs`:
the test instruction is the positive control at `trident/inner-workflow.mjs:1741`,
and the search returns no install command. The dispatch function selects either the
agent or CLI transport without adding setup (`trident/inner-workflow.mjs:2338-2359`).

Historical build material records the manual dependency: one resume plan says the
uninstalled worktree fails and a local install fixes it
(`.trident/plans/trident/a-codex-routed-build-cannot-transmi.md:5`), while another
directly tells its build to install first and records 47 passing tests afterward
(`.trident/plans/trident/a-fire-turn-settle-timeout-writes-t.md:67-71`). Thus neither
automatic external provisioning nor a consistently complete module graph explains
past runs: correctness depended on an agent noticing and performing an unstated setup
step, and runs that did not were capable of checking the wrong or incomplete graph.

### Decisions and maintained invariant

Provisioning lives in `typecheck-all.sh`, the entrypoint CI calls directly
(`.github/workflows/ci.yml:243-251`), rather than serialising typecheck with the test
suite. The invariant is maintained on every typecheck invocation by the install and
verification preflight before discovery (`scripts/ci/typecheck-all.sh:29-42`); it does
not depend on `tsc` remaining usable. Existing installs retain the cheap verification
path, while missing installs take the measured per-worktree install path.

The new refusals join the verifier's existing exit-code vocabulary: zero means
dependency resolution is usable and three means setup or verification was refused,
distinct from a test failure (`scripts/ci/verify-workspace-deps.ts:70-80`). A failed
TypeScript matrix remains exit one (`scripts/ci/typecheck-all.sh:69-74`).

### Mutation table

| Guard | Mutation (landed line printed before run) | Red result | Restored result |
|---|---|---|---|
| Missing local bun store provisions | Invert `! -d` at `scripts/ci/typecheck-all.sh:29` | Fresh-worktree test expected 0, received 3 | Green |
| Failed frozen install refuses | Remove `!` at `scripts/ci/typecheck-all.sh:31` | Expected install-refusal message was absent | Green |
| Failed verifier refuses | Remove `!` at `scripts/ci/typecheck-all.sh:36` | Symlink test expected 3, received 0 | Green |
| Root dependency link refuses | Invert `isSymbolicLink()` at `scripts/ci/verify-workspace-deps.ts:98` | Symlink test expected 3, received 0 | Green |

After all restorations,
`bun test scripts/ci/typecheck-worktree.test.ts scripts/ci/verify-workspace-deps.test.ts`
passed 17 tests with zero failures.

### Deliberately not changed

This change does not serialise typecheck against the suite and does not address the
separate contention problem. It does not add a feature flag or retain a borrowed-tree
fallback: a dependency symlink is refused. It does not alter `SPEC.md`, because the
product target and Decisions Log are unchanged.
