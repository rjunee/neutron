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
