## 2026-09-14 — Pin six inner-workflow gates before replacement (#745)

### Change and evidence

Added `trident/inner-workflow-gates.test.ts`, executing the complete production
workflow with mocked runtime seats (`:26`, `:64`). The source is read from disk
(`:6`); assertions observe terminal results, checkpoint dispatches and builder
briefs. The test does not execute shell commands or persist an actual database.
The exemplar was read at `trident/inner-workflow-built-head.test.ts:35` and `:81`:
its runtime body reaches the real publish handoff, rather than reconstructing a
predicate. Production `trident/inner-workflow.mjs` is unchanged.

G022 was investigated and mutation-checked first. Finished trailer evidence
collects a result (`trident/inner-workflow.mjs:2373`) and hands off publication
(`:8417`). A recorded exit without a trailer throws a measured failure (`:2383`),
including exit zero; unknown evidence exhausts two probes (`:2395`) and returns
`awaiting-trailer` with `infra-only` (`:9256`). Tests at
`trident/inner-workflow-gates.test.ts:81` distinguish those consequences. Exits
0, 1 and 137 are covered. Failed and unknown both use `workflow-threw` (`:9254`),
but their checkpoint/block-kind fields differ; the tested result does not collapse
the three states.

Other pins, enumerated from the issue's six-row table:

| Gate | Production site | Consequence test |
| --- | --- | --- |
| G021 | `trident/inner-workflow.mjs:2333` | `trident/inner-workflow-gates.test.ts:116`: missing wrapper prevents builder dispatch; supplied wrapper permits handoff. |
| G023 | `trident/inner-workflow.mjs:2413` | `trident/inner-workflow-gates.test.ts:129`: wrong branch prevents handoff despite a valid commit. |
| G024 | `trident/inner-workflow.mjs:7958`, `:7964` | `trident/inner-workflow-gates.test.ts:144`: missing plan, checked task and absent task refuse Forge; the valid control selects the pinned line. |
| G034 | `trident/inner-workflow.mjs:8387` | `trident/inner-workflow-gates.test.ts:169`: abbreviated claim plus absent measured head cannot return built; full OID control returns built without review/publication. |
| G075 | `trident/inner-workflow.mjs:8816` | `trident/inner-workflow-gates.test.ts:179`: null, empty-spec and thrown planner replies escalate; a usable revised spec reaches the fix builder. |

G034 uses PR mode to avoid the earlier unreadable-head stop (`:8323`), so its
fixture actually reaches the member OID guard. G075's `ok: true` means workflow
completion (`:9118`); refusal travels as `REQUEST_CHANGES`, `design-gap` and a
structured escalation (`:9121`, `:9163`, `:9173`). Initial test assumptions of
`ok: false`, an escalation `action` field, and `publish-pending` were corrected
against these production reads; no product requirement was relaxed. Member and
re-plan tests use the direct executor route so their brief assertions inspect
plain text; G021/G022/G023 use the CLI route.

### Mutation evidence

Each mutation was applied to an isolated copy of the production source next to
an unchanged copy of the test. The runner required exactly one matching needle,
printed the actual numbered mutated line and unified diff BEFORE running
`bun test ./inner-workflow-gates.test.ts`, and required nonzero exit. The production
file in the build worktree was never edited. All failures were assertions on
consequences, not parsing failures. After restoring the source, all 18 cases
passed (119 assertions). G022 was independently checked with its first six cases
before any of the other gates were added.

| Guard / exact source line | Mutation | RED cases | Restored |
| --- | --- | ---: | --- |
| G021 `:2333` | `if (codexBuildSh === null)` → `if (false)` | 1 | 18 GREEN |
| G022 `:2366` | trailer-probe loop condition → `while (false)` | 5 | 18 GREEN |
| G022 `:2382` | recorded-exit arm condition → `false` | 3 | 18 GREEN |
| G022 `:2395` | probe-bound condition → `false` | 1 | 18 GREEN |
| G022 `:2397` | connected-status condition → `false` | 1 | 18 GREEN |
| G023 `:2413` | branch-disagreement condition → `false` | 1 | 18 GREEN |
| G024 `:7958` | null-plan condition → `false` | 1 | 18 GREEN |
| G024 `:7964` | absent-pinned-line condition → `false` | 2 | 18 GREEN |
| G034 `:8394` | empty full-OID condition → `false` | 1 | 18 GREEN |
| G075 `:8823` | failure-stop condition → `false` | 3 | 18 GREEN |
| G075 `:8816` | thrown-reason condition → `false` | 1 | 18 GREEN |
| G075 `:8818` | null-reason condition → `false` | 1 | 18 GREEN |
| G075 `:8820` | empty-spec condition → `false` | 1 | 18 GREEN |

Source lines in this table are as they stand on the rebased branch (`origin/main`
with #624/#738 applied), which is where the runs above were made. They are seven
lines below the enforcement references in the inventory table, which are kept on
that document's own declared baseline.

Review replay (independent, same tree): the three pairwise MERGES of G022's
terminal outcomes each go red, which is the property the row claims. Rethrowing
`awaitingTrailerError()` in place of `exitedError(cls.exitCode)` (`:2383`) reds
the three recorded-exit cases; flipping `err.awaitingTrailer` to `false`
(`:2361`) reds the unknown-wait case with exactly `expected "awaiting-trailer",
received "inner-error"` — the false/unknown collapse itself; disabling the
collect arm (`:2373`) reds the finished case. Restored: 18 GREEN.

The unknown-probe fixture has an independent six-call emergency ceiling
(`trident/inner-workflow-gates.test.ts:36`): removing the production bound yields
the wrong terminal cause and fails, rather than hanging the test process.

### Inventory discrepancies and decisions

Updated the six inventory rows and their missing-pin rollup. The enforcement
line references are NOT moved: this document declares its baseline as
`f7320fc76eb3e1d0775dabd56cf957da632904e5` in its own header, and every original
reference is correct there (7944 `if (!plan) {`, 7950 `if (pinnedLine === null)
{`, 8249 the null-Forge throw, 8371 `if (memberMode) {`, 8802 `if (rePlanFailure
!== '') {`). Re-measuring four rows against a later checkout would leave 161 rows
on one baseline and 4 on another, and would go stale again at the next merge that
touches the file — as it did here, since #624/#738 inserted seven lines above
8260. G075 already has relevant execution coverage at
`trident/__tests__/escalation-e2e.test.ts:364`; this focused table adds an
explicit per-guard mutation certification.

G031 IS certified, by a pin that landed after this inventory's baseline.
`trident/__tests__/cross-model-dispatch.test.ts:765` (added by #624/#738) drives
the workflow body with a null build agent and asserts the terminal class;
replacing the guard with `if (false)` turns it red. `trident/infra-retry.test.ts`
does not certify it — `:125` injects an outer failure result and the whole file
stays green under that same mutation — so the inventory row names the pin that
does and records why the other does not. No seventh pin was added here. The
rollup now counts 11 unverified rows, enumerated from the table.

No production outcome, guard, invariant or product decision was added. Existing
refusal and escalation vocabularies above remain unchanged; these tests maintain
their regression coverage independently of a builder or planner succeeding.
No spec decision changed. Did not replace the loop, fix production gates, run
the whole test suite, access the network, push, open a PR or merge. The requested
`.trident/as-built/` staging location takes precedence over the repository's
normal `docs/as-built/` location for this lane.

### Validation

- `bun test trident/inner-workflow-gates.test.ts`: 18 passed, 0 failed.
- Thirteen isolated mutations: each RED; source restored: 18 GREEN.
- `bun run typecheck` is unavailable (no such package script); repository
  `scripts/ci/typecheck-all.sh` used instead.
- `bash scripts/ci/typecheck-all.sh`: exit 0, all discovered configs passed.
- `bash scripts/ci/lint.sh`: exit 0.
- `git diff --check`: passed; production workflow byte-identical to HEAD.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE, zero findings
  from executed rules. Private denylist and message-denylist rules could not run;
  the orchestrator must complete those checks before publication.
