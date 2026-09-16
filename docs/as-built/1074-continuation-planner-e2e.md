## 2026-09-16 — Issue 1074 continuation planner end-to-end coverage

### What changed

The offline project-build harness now records the planner route and the task delivered to each build turn at `open/__tests__/project-build-e2e.test.ts:193-196`. Its continuation worker deliberately supplies an invented plan, task and count at `open/__tests__/project-build-e2e.test.ts:292-307`, so the host must replace those claims with the committed plan. For the two-task fixture, the build worker commits each completed checklist line at `open/__tests__/project-build-e2e.test.ts:319-337`, and the seeded plan contains both tasks at `open/__tests__/project-build-e2e.test.ts:502-503`.

The new case runs task zero to the existing `continued` outcome, constructs a fresh composed host over the saved checkpoint, resumes at task one, and asserts both the `full` → `next` planner transition and selection of T2 at `open/__tests__/project-build-e2e.test.ts:866-888`. This reaches the production continuation selection at `trident/build-run.ts:288-304`; the driver then replaces planner claims with the independently measured committed task at `trident/build-run.ts:433-450`.

The harness limitation list now identifies `ralph-task-built` as covered at `open/__tests__/project-build-e2e.test.ts:1212-1214`. A whole-file search for `continuation planner and|ralph-task-built` found the positive control `ralph-task-built` at line 1213 and no stale `continuation planner and` claim.

### Decisions

The case uses the real two-process resume shape rather than calling `probePlan` directly: the first driver invocation preserves the branch and mode checkpoint, while the second goes through `prepareProjectBuild` and `createProjectBuildHost` at `open/__tests__/project-build-e2e.test.ts:871-880`. The fake worker remains literal at the result boundary: envelope fields are still derived only from the brief at `open/__tests__/project-build-e2e.test.ts:252-270`; the added fixture behavior merely performs the plan and build work named by the dispatch.

No new outcome was introduced. The resumed run reaches the existing publication refusal at `open/__tests__/project-build-e2e.test.ts:881`; the assertion is deliberately on the earlier planner route and task handoff at `open/__tests__/project-build-e2e.test.ts:880-887`.

No product decision changed, so `SPEC.md` and the Decisions Log were not edited.

### Mutation table

| Guard | Mutation | Red proof | Restored proof |
|---|---|---|---|
| Eligible clean Ralph handoff selects the continuation planner, `trident/build-run.ts:302` | Replaced `planner = 'next'` with `planner = 'full'`; `nl` printed the mutation at line 302 before execution | The new case failed: expected `['full', 'next']`, received `['full', 'full']` | Restored `planner = 'next'`; the targeted case passed with 6 assertions |

Prior-lane validation (historical, not rerun in this documentation fix): `bun test trident/build-run.test.ts open/__tests__/project-build-e2e.test.ts` passed 214 tests with 0 failures and 875 assertions. `bash scripts/ci/typecheck-all.sh` passed all 51 configurations. `bash scripts/ci/lint.sh` passed every reported gate. `git diff --check` passed. The public-tree leak gate reported zero findings from every rule it could run, but its private denylist was unavailable and it therefore returned INCOMPLETE rather than clean.

### Line-number corrections

The staged fix brief contains only a pointer back to the task. The review citations remain correct: `CONTRIBUTING.md:132-141`, `docs/as-built/README.md:15-20,27-31`, and `scripts/ci/as-built-write-guard.sh:152,245-270`. The reviewed SHA was a248d66e; this lane started at 8ca13b61. In the carried record, test citations moved: 289-301 → 292-307 (also corrected the worker description); 313-330 → 319-337; 496-497 → 502-503; 860-882 → 866-888; 1206-1209 → 1212-1214; positive control 1207 → 1213; 863-875 → 871-880; 875-881 → 880-887; 1181-1195 → 1190-1201. Other retained code citations were read and remain valid.

### Deliberately not done and not verified

No production behavior changed; the existing selection and authoritative task replacement remain at `trident/build-run.ts:288-304` and `trident/build-run.ts:433-450`. The full repository test launcher was not run because the lane explicitly forbids it; the prior lane ran only the two named files. The unavailable private denylist could not be verified locally. Real model interpretation, real session startup, the real leak scanner, and real GitHub remain outside this harness as enumerated at `open/__tests__/project-build-e2e.test.ts:1190-1201`.

### Review fix: governed record placement

Moved the existing record from `.trident/as-built/fix/1074-auto202715.md` into this single shard and added the required dated heading. The specific review task supersedes the lane's generic staging instruction. `docs/as-built/README.md:27-31` requires direct publication here; the guard reads this directory at `scripts/ci/as-built-write-guard.sh:152`, validates added shard names at line 265, and rejects malformed headings at line 288. Its existing outcome vocabulary is exit 0 for accepted records, 1 for violations, and 2 for an indeterminate check (`scripts/ci/as-built-write-guard.sh:31-33`). No new guard or outcome is introduced. The governed-attributes check invokes the guard at `scripts/ci/check-governed-repo-attributes.ts:100`; the guard maintains format and immutability independently of the author; it does not enforce that every change has a record.

Reproduction on the original branch returned guard exit 0/OK with no governed record in the scoped diff. The same diff scoped to `.trident/as-built/` found the added record, serving as a positive control. A whole-tree search for the old heading and “relaying the committed plan” found only the carried record, which is corrected here. Local `origin/main` was inspected, without fetching, as required by the offline lane.

### Review-fix verification

| Property | Mutation / negative control | Red proof | Restored proof |
|---|---|---|---|
| Governed registry membership | Inspect original HEAD 8ca13b61 instead of the staged tree | Exact shard path absent; test path present as positive control | Staged tree contains both paths |
| Dated heading, existing guard at `scripts/ci/as-built-write-guard.sh:288` | Temporary index replaces this shard's line 1 with the original undated heading; printed the stored blob's line 1 | Real guard returned exit 1 and the malformed-heading message | Real guard returned exit 0/OK before and after mutation |

The proposed-tree checks used `git write-tree` and unreferenced `git commit-tree` objects with the existing HEAD as parent; branch history was not rewritten. The malformed record reached the actual guard through explicit base/head SHAs. No new test or guard was added. `bun test open/__tests__/project-build-e2e.test.ts` passed 31 tests, 0 failures, 202 assertions. `bun test scripts/ci/as-built-write-guard.test.ts` passed 17 tests, 0 failures, 40 assertions. `bash scripts/ci/typecheck-all.sh` passed all 51 configurations. `bash scripts/ci/lint.sh` passed (exit 0). `git diff --check` passed. The leak gate returned INCOMPLETE (exit 3): zero findings from executed rules, but the file and message denylist rules could not run. This is not a clean leak-gate result.

### Review-fix limits

This fix changes only the record's location and content. Production code, tests, the guard, and product decisions are deliberately unchanged. The full test suite and remote CI were not run. Historical mutation and validation results above are retained as prior-lane evidence, not claimed as new executions. No network operations, push, PR creation, or merge were attempted.
