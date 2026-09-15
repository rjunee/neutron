## Review re-plan admission and failure boundaries

### Delivered scope

This bounded increment addresses **G075 and G077**, not the full review cutover. Re-plan admission now checks the remaining host round budget before dispatch (`trident/build-run.ts:363`). Re-plan completion validates a nonempty execution spec before another build (`trident/build-run.ts:285`). Thrown and terminally failed planners route to orchestration with a design-gap reason (`trident/build-run.ts:250`, `trident/build-run.ts:281`).

Read both prior increment records, the audit copy in the audit build worktree, all 23 conflict detail sections, and the twelve assigned inventory rows. The audit's G075/G077 conflicts correspond to `docs/trident-gates-inventory.md:154` and `docs/trident-gates-inventory.md:156`. Read the retained implementation before adapting its policy: failed re-plan classification at `trident/inner-workflow.mjs:6613`, last-round escalation at `trident/inner-workflow.mjs:6808`, configured rounds at `trident/inner-loop.ts:612`, and retained panel invocation at `trident/review-run.ts:244`. Read the second increment's suite classifier as the local exemplar (`trident/gates/review-suite.ts:32`).

### Gate certification

| Gate | Property at the rebuilt boundary | Implementation | Retained certification, green | Direct certification, green |
| --- | --- | --- | --- | --- |
| G075 | Unusable replacement output and a thrown or terminally failed re-planner stop before rebuilding | `trident/build-run.ts:250`, `trident/build-run.ts:281`, `trident/build-run.ts:285` | `trident/inner-workflow-gates.test.ts:199`; also `trident/__tests__/escalation-e2e.test.ts:364` | `trident/build-run.test.ts:619`, `trident/build-run.test.ts:629`, `trident/build-run.test.ts:640`; valid replacement control at `trident/build-run.test.ts:653` |
| G077 | A last-round design gap stops before spending a replacement planner or builder, retaining the stated missing design | `trident/build-run.ts:363` | `trident/__tests__/escalation-e2e.test.ts:408`, `trident/__tests__/escalation-e2e.test.ts:435` | `trident/build-run.test.ts:674`, with round four as the positive control and round five as the refusal |

The inventory's G075 test line has drifted; the relevant current body begins at `trident/inner-workflow-gates.test.ts:199`. Both complete retained certification files ran unchanged. Those tests certify the retained implementation; the new driver tests independently certify this extraction boundary.

### Decisions and outcome vocabulary

- Join the existing `BuildRunOutcome` vocabulary rather than introducing a new terminal cause. `blocked` explicitly names the orchestrator recipient (`trident/build-run.ts:116`, `trident/build-run.ts:149`); re-plan failure and unreachable-budget reasons use that outcome. The reason strings contain the retained design-gap trigger names (`trident/inner-workflow.mjs:6627`, `trident/inner-workflow.mjs:6814`). This does not claim a new durable storage mapping or typed escalation payload.
- Keep unknown worker status and unreadable host measurement nonterminal, with the exact worker step identity (`trident/build-run.ts:254`, `trident/build-run.ts:261`, `trident/build-run.ts:282`). Corroboration failures retain `built-head-unverified` (`trident/build-run.ts:263`). A planner exception is caught around the runner invocation only (`trident/build-run.ts:247`); a host observation exception still reaches the existing unknown conversion (`trident/build-run.ts:433`).
- During implementation, the observation test exposed an overly broad catch around the complete work step. It produced blocked instead of unknown. Narrowing the catch fixed that assertion without relaxing it (`trident/build-run.test.ts:662`). The mutation table below reintroduces that defect and proves the distinction.
- The host continues to own the round and spent re-plan count. Admission checks the current five-round cap before incrementing the allowance or invoking the planner (`trident/build-run.ts:363`, `trident/build-run.ts:364`, `trident/build-run.ts:370`). This slice does not change where the cap value is configured.
- Re-plan output validation applies to PR mode as well as the existing mode-specific plan checks (`trident/build-run.ts:285`, `trident/build-run.ts:288`). The replacement's nonempty execution spec reaches the builder preparation context (`trident/build-run.ts:269`, `trident/build-run.ts:245`, `trident/build-run.test.ts:653`). This is a shape/availability check, not proof of plan correctness.
- Enforcement runs in the host at each re-plan transition; refusal does not depend on a failed planner declaring that it failed (`trident/build-run.ts:250`, `trident/build-run.ts:285`). A hung runner cannot advance the awaited transition (`trident/build-run.ts:248`); this increment adds no watchdog, timeout, or durable crash recovery.
- Existing fixtures now supply usable re-plan payloads. Round six has a valid fake result specifically so removing the cap can actually reach the wrong merged outcome, rather than stopping on an unavailable fixture (`trident/build-run.test.ts:12`). Existing assertions were retained.

### Mutation evidence

Each of the seven final mutations was applied alone, its actual changed line printed, compiled with `bunx tsc --noEmit -p trident/tsconfig.json`, and produced a test assertion failure. The same targeted test then passed after restoring the source. The table enumerates every final mutation from the execution log; the line numbers refer to the restored implementation unless the cell explicitly gives the mutated replacement.

All tests below are in `trident/build-run.test.ts`.

| Guard | Mutation and printed landing | Test-name filter | Compiles | Mutated | Restored |
| --- | --- | --- | --- | --- | --- |
| G075 observation distinction | `trident/build-run.ts:277`: append `.catch(() => ({ stop: replanFailed('planner threw') }))` to the work call | `G075 unreadable` | yes | RED: blocked instead of unknown | GREEN |
| G075 planner exception | `trident/build-run.ts:250`: remove planner-specific catch return | `G075 thrown` | yes | RED: unknown instead of design-gap block | GREEN |
| G075 terminal failure | `trident/build-run.ts:281`: remove terminal failure conversion | `G075 terminal` | yes | RED: generic failed instead of design-gap block | GREEN |
| G075 unusable payload | `trident/build-run.ts:285`: replace the complete validation condition with `false` | `G075 unusable` | yes | RED: invalid payload reaches merged | GREEN |
| G075 valid payload control | `trident/build-run.ts:285`: replace the validation condition with `replanning` | `G075 revised` | yes | RED: valid replacement blocked | GREEN |
| G077 cap | `trident/build-run.ts:363`: remove the complete cap statement | `G077` | yes | RED: last-round replacement reaches merged | GREEN |
| G077 spare-round control | `trident/build-run.ts:363`: change the cap comparison from five to four | `G077` | yes | RED: spare-round replacement blocked | GREEN |

An initial cap mutation kept the return under `if (false)`. TypeScript discarded the discriminated-union narrowing in unreachable code, so that attempt failed compilation and is **not** counted as RED evidence. The final mutation removed the whole statement, compiled, and reached the wrong outcome. Earlier checks on the broad-catch implementation were superseded by the complete seven-mutation run on the corrected implementation.

### Validation

- `bun test trident/build-run.test.ts trident/build-host.test.ts trident/gates/`: **200 pass, 0 fail, 809 assertions**, ten files.
- `bun test trident/inner-workflow-gates.test.ts trident/__tests__/escalation-e2e.test.ts`: **44 pass, 0 fail, 265 assertions**, two retained certification files.
- The targeted G075/G077 cases passed after the final implementation change: eleven tests, 43 assertions. Every final mutation compiled and every restored targeted test passed. No whole-suite sweep was run.
- `bash scripts/ci/typecheck-all.sh`: **all 51 configurations passed**, including trident. `bash scripts/ci/lint.sh`: exit 0.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, **INCOMPLETE**. Executed rules found zero findings, but `pii-denylist` and `pii-denylist-msg` could not run. The scan counted four pre-existing commit-message lines; it does not certify the subsequent commit message. A local restricted-text check passed for the three changed files.
- `git diff --check`: green. Changed files were enumerated with `git diff --name-only` and `git ls-files --others --exclude-standard`. The protected-scope control `git diff --name-only -- trident/build-run.ts trident/inner-loop.ts trident/review-run.ts trident/inner-workflow.mjs gateway open` printed only `trident/build-run.ts`. The shard has exactly one `## ` heading.

### Deliberately unfinished

Remaining assigned IDs, enumerated by subtracting G075 and G077 from the twelve IDs in this task brief: **G023, G036, G042, G055, G056, G070, G071, G101, G102 and G124**. In particular, severity-independent repeat detection and ordinary no-progress arithmetic remain for a later increment. This change does not claim the requested full panel structure, production acquisition, durable escalation persistence, configurable round limits, or retrospective certification of approved resumes.

No product decision or acceptance criterion changed. Read `docs/process/work-tracking.md` before implementation and its record rules again before writing. Used the task's branch-specific staged record destination, leaving the previous increments' evidence intact. Delivery is a local commit on `rebuild/review-structure-3`; the orchestrator owns review and publication.
