## 2026-09-17 — Production bound-review bridge regression coverage

### Change and evidence

Added one test at `open/__tests__/open-trident-prod-boot-wiring.test.ts:211`. It boots the real Open composer with the existing simulated panel substrate, passes the composition into `buildCoreModules` at line 231, and replaces only the external host command runner at line 233. The module creates the real orchestrator and connects its step to the tick loop (`gateway/composition/build-core-modules.ts:829-832`). The test creates a persisted run with `bound_pr: 515` at line 242, drives tick/drain/tick at lines 246-248, and asserts the stored failure reason, done phase, APPROVE verdict, reviewed-head checkpoint and PR at lines 250-254.

The covered bridge is `gateway/composition/build-core-modules.ts:638` → `trident/orchestrator.ts:1830` → `trident/bound-review.ts:151`. The existing direct-executor test at `open/__tests__/open-trident-prod-boot-wiring.test.ts:203-208` remains intact.

### Decisions and limits

Used the exposed module lifecycle, tick loop and drain function instead of adding a production test seam. The tick loop stops before seeding the run; shutdown handles final cleanup (`open/__tests__/open-trident-prod-boot-wiring.test.ts:240-256`; `gateway/composition/build-core-modules.ts:914-918`). The fake host uses the existing output-file adapter after reading its implementation (`trident/testing/diff-output-host.ts:12-21`). The fake substrate writes panel results into its isolated database (`open/__tests__/open-trident-prod-boot-wiring.test.ts:106-127`); this tests production forwarding and result persistence, not real model review or remote GitHub execution.

The existing outcome vocabulary handles a missing firer as a failed bound review (`trident/review-run.ts:248-249`; `trident/bound-review.ts:164-175`) and successful review as done (`trident/bound-review.ts:203-218`). No new outcome, product decision or production invariant was introduced. Deliberately did not change production implementation, spec decisions, or existing tests. The regression test is the continuing check against dropping the forwarding line.

### Mutation evidence

Command for all three paired-file runs:

```sh
bun test trident/review-run.test.ts open/__tests__/open-trident-prod-boot-wiring.test.ts
```

Before writing the test, removed the forwarding line and reproduced the reported gap. Actual summary:

```text
21 pass
0 fail
316 expect() calls
Ran 21 tests across 2 files. [3.64s]
```

| Guard | Mutation | Red result | Restored result |
| --- | --- | --- | --- |
| Production panel forwarding, `gateway/composition/build-core-modules.ts:638` | Delete the conditional `fire_review_panel` spread | 21 pass, 1 fail; the new test receives the missing-firer failure reason | 22 pass, 0 fail |

Printed the mutated location with `nl -ba` before running:

```text
634 const fire_workflow = tridentWiring.fire_inner_workflow
635 const fire_review_panel = tridentWiring.fire_review_panel
636 const orchestratorOpts: Parameters<typeof buildTridentOrchestrator>[0] = {
637   fire_workflow,
638   db_path: input.db.path,
639   run_host: runHost,
```

Final mutation run, after fixing the test fixture's type error:

```text
error: expect(received).toBeNull()
Received: "bound PR #515 review-only execution failed: existing review panel firer was not wired"
21 pass
1 fail
317 expect() calls
Ran 22 tests across 2 files. [5.57s]
```

The assertion is at `open/__tests__/open-trident-prod-boot-wiring.test.ts:250`. The mutation typechecked with `bunx --no-install tsc -p open/tsconfig.json --noEmit` (exit 0, no output), so this is a wrong persisted answer rather than a compile failure or unrelated crash. Restored line 638 and printed it again. Actual restored output:

```text
22 pass
0 fail
321 expect() calls
Ran 22 tests across 2 files. [5.06s]
```

### Validation

`bash scripts/ci/lint.sh` passed (exit 0). `bash scripts/ci/typecheck-all.sh` passed (exit 0): `typecheck matrix: 51 tsconfig(s) checked`, `TYPECHECK MATRIX: ALL PASS`. The restored `bunx --no-install tsc -p open/tsconfig.json --noEmit` also passed (exit 0, no output). `git diff --cached --check` passed. Scope of code edits was enumerated with `git diff --numstat`: only the boot-wiring test changed, with 51 added lines. This record is staged under the task-requested `.trident/as-built/` location.

### Follow-up: bound panel launcher retention

The leak fix keeps the reviewed bridge and its test intact. The new test insertion shifts the bridge test from line 211 to line 264; earlier citations above describe that earlier revision. The leak originates in the warm factory's cwd map (`open/wiring/substrates.ts:551-555`, insertion at :593), while each bound panel carries a disposable cwd (`trident/review-run.ts:265-266`) removed after review (:569-572).

Selected the requested stable-repository alternative. Bound panels now supply the original repository as `launcher_repo_path` (`trident/review-run.ts:275`); the firer uses it for launcher cwd (`trident/inner-loop.ts:988`). Workflow arguments still derive `repoPath` from the disposable panel run (`trident/inner-loop.ts:617`). This uses the `build_substrate` factory arm in production (`open/composer.ts:1221`), with warm reuse per stable repository. Updated the interface's factory/singleton descriptions (`trident/inner-loop.ts:1017-1023`) and its missing-input error wording (:1050) to describe both supported shapes accurately.

Did not adopt ephemeral-at-settle: the launch prompt explicitly ends the turn while its workflow continues (`trident/inner-loop.ts:821-822`); the ephemeral driver disposes after that turn (`runtime/adapters/claude-code/persistent/pool.ts:950-957`), terminating the child (:368-372). Stable-root warm reuse preserves background execution without accumulating entries per recovery worktree. The invariant is maintained on every invocation by the typed input construction and cwd selection, before the cache sees the key; it requires neither successful panel execution nor a cleanup callback from the panel. This bounds entries by repositories, not total repositories over process lifetime.

The regression (`open/__tests__/open-trident-prod-boot-wiring.test.ts:211`) completes two distinct run ids through the real composition. It observes actual substrate factory options from structured panel prompts, asserts distinct disposable workflow paths and completed removal (:253-255), then requires both launcher cwds to equal the stable repository, one instance id, and warm lifetime (:258-261). It simulates model results and host commands; it does not launch a real model child. The existing warm-factory positive control remains intact (`open/__tests__/open-wiring-substrates.test.ts:427-446`). No new outcome is introduced: the existing fired/failed path remains at `trident/inner-loop.ts:999-1003` and bound-panel fire validation at `trident/review-run.ts:292-293`.

### Leak regression mutation table

Each mutation was printed with `nl -ba` before running:
`bun test open/__tests__/open-trident-prod-boot-wiring.test.ts --test-name-pattern 'two bound runs'`.

| Guard | Printed mutation | Red result | Restored result |
| --- | --- | --- | --- |
| Stable repository input | `trident/review-run.ts:275`: `launcher_repo_path: input.worktree_path` | 0 pass / 1 fail; :259 received two disposable paths instead of repository paths | 66 pass / 0 fail across requested three files |
| Launcher cwd consumes stable input | `trident/inner-loop.ts:988`: `const cwd = input.run.worktree ?? input.run.repo_path` | 0 pass / 1 fail; same wrong cwd answer at :259 | 66 pass / 0 fail across requested three files |

Both mutations reached both successful review outcomes and worktree-removal assertions before failing. Neither failed by crash, timeout, missing credentials or compilation. The restored run includes the unchanged warm-factory positive control. `bun test trident/inner-loop.test.ts` additionally passed 72 tests / 221 assertions.

Whole-tree `rg` over Markdown and TypeScript for `NOT the production shape|per-cwd factory, tests|warm singleton, production|Per-cwd factory` found only the updated comment at `trident/inner-loop.ts:1021`; that last phrase was the positive control. Scope was enumerated with `git diff --stat`: the boot-wiring test, composer comment, inner-loop input/cwd/documentation, review-run input, and this record. Deliberately did not change the existing bridge test, ordinary warm-factory behavior, workflow review arguments, spec decisions, or project-launch routing. The task's explicit `.trident/as-built/` destination overrides the standard record location for this lane.

### Follow-up validation

`bun install` succeeded (1357 installs checked, no changes), and `readlink -f node_modules/@neutronai/trident` resolved inside the build worktree. Requested combined run: `bun test trident/review-run.test.ts open/__tests__/open-trident-prod-boot-wiring.test.ts open/__tests__/open-wiring-substrates.test.ts` passed 66 tests / 570 assertions. The explicit warm-factory positive control additionally passed 1 test / 7 assertions. `bash scripts/ci/lint.sh` passed. `git diff --check` passed. The tree leak scan reported zero findings but INCOMPLETE: private `pii-denylist` and `pii-denylist-msg` rules could not run, so this is not a clean leak gate result.

`bash scripts/ci/typecheck-all.sh` passed with exit 0: 51 configurations checked, `TYPECHECK MATRIX: ALL PASS`. Staged whitespace and as-built single-heading checks passed. Added-line checks passed for the prohibited word and home/build-worktree path literals; these limited checks do not replace the incomplete private denylist scan.
