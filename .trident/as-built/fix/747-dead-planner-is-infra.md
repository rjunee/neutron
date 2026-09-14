## Issue 747 — dead planners reach the infrastructure retry seam

### What changed

The pinned-member planner now attaches the existing `infra-only` block kind only when its dispatch returned no result (`trident/inner-workflow.mjs:7954-7964`). The ordinary Ralph planner and its continuation alternative attach the same kind only at their shared null-result guard (`trident/inner-workflow.mjs:8139-8147`). The existing terminal catch accepts only an exact `infra-only` kind and omits it from ordinary thrown errors (`trident/inner-workflow.mjs:9236-9268`).

The tests run the shipped workflow body through its `AsyncFunction` harness (`trident/__tests__/cross-model-dispatch.test.ts:287-292`). Each planner fixture can independently return null or reject (`trident/__tests__/cross-model-dispatch.test.ts:124-127`, `trident/__tests__/cross-model-dispatch.test.ts:228-230`), and four cases verify the two directions at both dispatch sites (`trident/__tests__/cross-model-dispatch.test.ts:616-661`). Each case also proves Forge was not dispatched, so a test cannot pass on a later build failure (`trident/__tests__/cross-model-dispatch.test.ts:626-630`, `trident/__tests__/cross-model-dispatch.test.ts:635-638`, `trident/__tests__/cross-model-dispatch.test.ts:645-649`, `trident/__tests__/cross-model-dispatch.test.ts:656-659`).

### Vocabulary and consumers

This adds no vocabulary. `infra-only` is already one of the exact values decoded by `parseInnerResult`; unknown values fail closed to null (`trident/inner-loop.ts:896-911`). The shared catch carries the value into the terminal result (`trident/inner-workflow.mjs:9236-9268`). `classifyInnerFailure` reads the combination of `infra-only` and a nonblank measured cause as `infrastructure`, while its default remains `genuine` (`trident/orchestrator.ts:1019-1036`). The run-level consumer schedules an automatic retry only for `infrastructure`, with a bounded exhausted-budget outcome (`trident/orchestrator.ts:5130-5177`). The reporting consumer describes a stamped result as a review that never ran and preserves the measured cause (`trident/orchestrator.ts:2286-2298`); `isInfraDeath` likewise treats the exact block kind as an infrastructure death (`trident/orchestrator.ts:2169-2174`).

Enumeration used `rg -n "returned null" trident/inner-workflow.mjs`: it found the two planner guards at lines 7961 and 8143-8144, plus the known build and fix-result controls at lines 8270 and 8825. Thus the search shape demonstrably found known occurrences while identifying the complete set of planner-null messages.

### Decisions

The stamp lives on the errors created by the null guards, not in the shared catch. That preserves the catch's existing fail-closed rule: a rejected planner promise is an ordinary workflow throw and remains unstamped (`trident/inner-workflow.mjs:9236-9268`). The two sites use the same existing producer shape as the null build guard, which attaches `infra-only` to the error at the point where the null result is measured (`trident/inner-workflow.mjs:8270-8271`).

The filed line references moved: the pinned-member throw is now at `trident/inner-workflow.mjs:7958-7964`, the Ralph guard at `trident/inner-workflow.mjs:8139-8147`, and the classifier default remains `trident/orchestrator.ts:1036`.

### Mutation evidence

| Guard | Mutation and printed landing line | Red result | Restored result |
|---|---|---|---|
| Pinned-member null result | Replaced the stamp with `{}` at `trident/inner-workflow.mjs:7963` | Null-member case failed at `trident/__tests__/cross-model-dispatch.test.ts:628`: expected `infra-only`, received absent | Focused file green, 67 pass |
| Ralph null result | Replaced the stamp with `{}` at `trident/inner-workflow.mjs:8146` | Null-Ralph case failed at `trident/__tests__/cross-model-dispatch.test.ts:647`: expected `infra-only`, received absent | Focused file green, 67 pass |
| Pinned-member ordinary rejection | Added unconditional rejection stamping at printed `trident/inner-workflow.mjs:7957-7960` | Ordinary-member case failed at `trident/__tests__/cross-model-dispatch.test.ts:637`: expected absent, received `infra-only` | Focused file green, 67 pass |
| Ralph ordinary rejection | Added unconditional rejection stamping at printed `trident/inner-workflow.mjs:8132-8135` | Ordinary-Ralph case failed at `trident/__tests__/cross-model-dispatch.test.ts:658`: expected absent, received `infra-only` | Focused file green, 67 pass |

### Verification

- `bun test trident/__tests__/cross-model-dispatch.test.ts` — 67 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh` — all 51 TypeScript configurations pass. The requested `bun run typecheck` alias is not defined in `package.json:54-63`; this is the CI typecheck command.
- `bash scripts/ci/lint.sh` — all repository lint gates pass.
- `git diff --check` — clean.

### Deliberately not changed

No classifier, parser, retry-budget, terminal-reporting, spec, or decision-log behavior changed. No new error value or parallel path was added. The two protected in-flight test files were not touched.
