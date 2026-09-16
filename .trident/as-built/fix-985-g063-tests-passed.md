## G063 uses a host-observed suite exit receipt

### What changed

G063 no longer accepts the build worker's `testsPassed` assertion as proof. The project composition extracts the configured full-suite command and runs it in the build worktree through the host runner (`open/wiring/project-build.ts:32-43`, `open/wiring/project-build.ts:202-206`). The resulting integer exit code is the verdict-bearing field; worker-written outcome and evidence remain diagnostic inputs only (`trident/gates/review-suite.ts:21-22`, `trident/gates/review-suite.ts:41-50`).

The existing assessment vocabulary now carries the three states without collapsing them: exit zero is `known` with no findings, a nonzero exit is `known` with the existing `FULL SUITE NOT PROVEN` blocker, and a missing, timed-out, or unreadable receipt is `unknown` (`trident/gates/review-suite.ts:9-11`, `trident/gates/review-suite.ts:41-50`). The inventory records that G064's worker-claim contradiction check is superseded by the host receipt (`docs/trident-gates-inventory.md:137-138`).

This defect is inherited, not an orchestrator-rebuild regression. Git blame against `origin/main` identifies `f99d6d49` as the commit that introduced the original boolean checks; `c9f40c93` later relocated that implementation. Before the change, the current unsafe acceptance was at `trident/gates/review-suite.ts:43`, the worker checkpoint copied its assertion at `open/wiring/project-build.ts:191-194`, and the observation source promoted that checkpoint at `trident/project-observation-sources.ts:75-78`.

### Decisions

The host reruns the exact full-suite command embedded in the configured strategy after it finds a valid checkpoint for the reviewed head (`open/wiring/project-build.ts:193-206`). If the strategy has no executable command, the receipt is absent and G063 returns `unknown`; it does not invent a failure (`open/wiring/project-build.ts:202-203`, `trident/gates/review-suite.ts:41`). A timeout also omits the exit receipt, keeping "could not find out" separate from a completed nonzero result (`open/wiring/project-build.ts:206`, `open/__tests__/project-build-wiring.test.ts:100-103`).

The checkpoint remains necessary for revision identity, but it does not maintain the pass invariant. The continuous maintainer is the host runner invocation at every suite assessment; it executes independently of the worker's asserted boolean (`open/wiring/project-build.ts:193-206`).

### Mutation table

| Guard | Compiling mutation and landed line | RED | Restored GREEN |
|---|---|---|---|
| Exit zero alone passes | Invert `=== 0` to `!== 0` at `trident/gates/review-suite.ts:43` | `trident/gates/review-suite.test.ts`: 5 fail, 1 pass | Targeted matrix: 273 pass, 0 fail |
| Host exit, not worker assertion, supplies the receipt | Replace `observed.exit_code` with `claim.testsPassed ? 0 : 1` at the then-current `open/wiring/project-build.ts:190` | `open/__tests__/project-build-wiring.test.ts`: 1 fail, 13 pass | Targeted matrix: 273 pass, 0 fail |
| Timeout is unknown, not failed | Replace the timeout branch with unconditional exit recording at the then-current `open/wiring/project-build.ts:190` | `open/__tests__/project-build-wiring.test.ts`: 1 fail, 13 pass | Targeted matrix: 273 pass, 0 fail |

The three direct input states are pinned at `trident/gates/review-suite.test.ts:30-39`: exit 0 produces approval, exit 1 produces a fix with `FULL SUITE NOT PROVEN`, and no usable exit produces `unknown`.

### Verification

- `bun test trident/gates/review-suite.test.ts open/__tests__/project-build-wiring.test.ts trident/project-build-host.test.ts trident/build-host.test.ts trident/build-run.test.ts` — 273 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh` — 51 project configs pass.
- `bash scripts/ci/lint.sh` — all lint gates pass.
- `bun run typecheck` could not be verified because `package.json` declares no such script; the repository-documented typecheck matrix above was used instead (`CONTRIBUTING.md:79`, `package.json:57-62`).

### Deliberately not done

The worker trailer contract still carries `testsPassed` for compatibility with consumers outside this proof path; it is no longer read by G063 or its project checkpoint wiring. The complete proof-path search was `rg -n "testsPassed|hostExitCode" trident/gates/review-suite.ts open/wiring/project-build.ts`: its positive control found `hostExitCode` at gate lines 22, 41, and 43 and wiring line 206, and it found no `testsPassed` hit.

No full test sweep was run, as the lane brief forbids it. No spec decision changed: this implements the filed post-cutover correction and updates the current gate inventory.

### Could not verify

No external dispatch was run, so real project-specific full-suite commands and their wall-clock behavior were not exercised. Networked CI was unavailable by design. The targeted host-runner tests verify command extraction, pass, nonzero, unavailable-command, and timeout boundaries at `open/__tests__/project-build-wiring.test.ts:51-103`.
