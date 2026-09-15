## 2026-09-15 — Review suite evidence as a separate host step

### Delivered scope

This bounded increment addresses **G063, G064 and G065 at the host observation boundary**, preserving the retained claim policy. It does not complete the review cutover. Suite acquisition/classification precedes panel dispatch (`trident/build-run.ts:331`), its findings enter panel preparation (`trident/build-run.ts:333`), and suite blockers override panel approval (`trident/build-run.ts:340`). Re-measurement remains immediately before dispatch, after suite acquisition (`trident/build-run.ts:334`).

Read the first increment and every conflict detail section in the audit worktree copy. Read each of the fifteen assigned inventory rows before choosing this slice. Read the retained suite policy at `trident/inner-workflow.mjs:4694`, the configured-round boundary at `trident/inner-loop.ts:612`, and the retained panel entry at `trident/review-run.ts:244`. The exemplar requires the panel to run even when suite proof is missing (`trident/inner-workflow-assembly.test.ts:1144`); this implementation preserves that property for a readable suite record (`trident/build-run.ts:337`).

### Per-gate evidence

| Gate | Property | New implementation | Retained certification, green | New direct certification |
| --- | --- | --- | --- | --- |
| G063 | Supplied strategy plus unproven suite requires repairs; only host-dispatched subset deferral is excused | `trident/gates/review-suite.ts:38`, `trident/gates/review-suite.ts:43`, `trident/gates/review-suite.ts:49` | `trident/inner-workflow-assembly.test.ts:1130`, `trident/inner-workflow-assembly.test.ts:1213`, `trident/inner-workflow-assembly.test.ts:1247` | `trident/gates/review-suite.test.ts:12` |
| G064 | testsPassed=true plus any explicit non-passed outcome is contradictory, including subset deferral | `trident/gates/review-suite.ts:41` | `trident/inner-workflow-assembly.test.ts:1342` | `trident/gates/review-suite.test.ts:30` |
| G065 | Empty or whitespace-only pre-existing-red evidence blocks; nonempty comparison transcription is advisory and cannot waive panel rejection | `trident/gates/review-suite.ts:46`, `trident/gates/review-suite.ts:47`, `trident/gates/review-suite.ts:58` | `trident/inner-workflow-assembly.test.ts:1273`, `trident/inner-workflow-assembly.test.ts:1283`, `trident/inner-workflow-assembly.test.ts:1294`, `trident/inner-workflow-assembly.test.ts:1332` | `trident/gates/review-suite.test.ts:39` |

Inventory certification line numbers have drifted; the complete cited assembly test file was executed without edits. The current relevant tests were read and are pinned above. This is certification of the new normalized boundary plus preservation of current retained tests, not a claim that the retained test invokes the new driver.

### Decisions and outcome vocabulary

- Separate source acquisition, suite classification, panel evaluation and suite override. `ReviewSuiteSource` reads host configuration, dispatched scope and a recorded build/fix claim for the requested revision (`trident/gates/review-suite.ts:11`). The host composes this source with its run ID (`trident/build-host.ts:120`); the driver supplies its own round (`trident/build-run.ts:331`). The review worker cannot pick the strategy or subset scope through its trailer.
- Preserve the existing claim standard: testsPassed=true without an explicit outcome remains accepted, and a known absent strategy is inert (`trident/gates/review-suite.ts:38`, `trident/gates/review-suite.ts:42`). A missing observation source is different from a known absent strategy and returns unknown (`trident/gates/review-suite.ts:32`). Malformed configuration, mismatched record identity and malformed report fields also remain unknown (`trident/gates/review-suite.ts:36`, `trident/gates/review-suite.ts:37`, `trident/gates/review-suite.ts:40`).
- Evidence transcription remains an untrusted build claim, as in the retained implementation (`trident/inner-workflow.mjs:4754`). The classifier labels it for verification (`trident/gates/review-suite.ts:47`), and the driver passes it into the panel's preparation context (`trident/build-run.ts:333`). This does not independently prove that tests ran or that the base has the same failure.
- The assessment vocabulary is known findings or unknown (`trident/gates/review-suite.ts:8`). Composition joins existing ReviewDecision outcomes: blockers turn approve into fix, augment existing fix/re-plan findings and counts, and cannot override blocked/unknown panel results (`trident/gates/review-suite.ts:55`, `trident/gates/review-suite.ts:59`). The driver's existing default maps blocked to the orchestrator and unknown to a nonterminal outcome (`trident/build-run.ts:149`, `trident/build-run.ts:150`, `trident/build-run.ts:341`). No new terminal cause is introduced.
- Continuous enforcement occurs at every fresh panel entry, including after fixes: the host reads the record again before that panel (`trident/build-run.ts:322`, `trident/build-run.ts:331`). A source that throws or reports missing facts cannot authorize approval (`trident/gates/review-suite.ts:35`, `trident/gates/review-suite.ts:50`). A hung source cannot advance this awaited transition; this increment adds no source timeout or outer watchdog.
- Existing fixture changes supply the new explicit empty assessment (`trident/build-run.test.ts:35`, `trident/gates/local-merge.test.ts:55`) or known absent strategy (`trident/build-host.test.ts:35`). No existing assertion was relaxed. Driver coverage checks that a suite failure still buys a panel, enters the fix brief, and is read again next round (`trident/build-run.test.ts:721`).

### Deliberately unfinished

The source is an integration contract (`trident/gates/review-suite.ts:23`), not production checkpoint/configuration acquisition. Durable persistence and migration of previously approved checkpoints are not delivered; the existing approved-resume shortcut still skips fresh review (`trident/build-run.ts:211`). This slice covers new panel decisions, not retrospective certification of old approvals. Ralph continuation and wave handoffs remain outside its fresh-panel boundary.

The remaining assigned IDs, enumerated by subtracting G063/G064/G065 from the fifteen IDs in the task brief, are **G023, G036, G042, G055, G056, G070, G071, G075, G077, G101, G102 and G124**. In particular, the severity-independent repeat stop is not claimed repaired. The earlier increment's eight gates remain its own delivery. No product decision or acceptance criterion was changed.

Read `docs/process/work-tracking.md` before work and its record rules again before writing. Used the task's branch-specific staged shard destination, leaving the first increment's record intact. This avoids rewriting another increment's evidence despite the brief's final reference to its older shard path.

### Mutation evidence

Each mutation was applied alone. The printer emitted the actual changed line before compiling with `bunx tsc --noEmit -p trident/tsconfig.json`. Every recorded RED is an assertion failure from a compiling mutation, followed by the same targeted test GREEN after restoration. The suite-policy fixtures include real changed report fields and affirmative approval controls.

| Guard | Mutation and printed landing | Targeted test | Compiles | Mutated | Restored |
| --- | --- | --- | --- | --- | --- |
| G063-unproven | `trident/gates/review-suite.ts:49` — `return known()` | `trident/gates/review-suite.test.ts` / `G063` | yes | RED | GREEN |
| G063-deferral | `trident/gates/review-suite.ts:43` — `report?.suiteOutcome === 'deferred'` | `trident/gates/review-suite.test.ts` / `G063` | yes | RED | GREEN |
| G064 | `trident/gates/review-suite.ts:41` — `return known()` | `trident/gates/review-suite.test.ts` / `G064` | yes | RED | GREEN |
| G065 | `trident/gates/review-suite.ts:46` — `if (!evidence) return known()` | `trident/gates/review-suite.test.ts` / `G065` | yes | RED | GREEN |
| source | `trident/gates/review-suite.ts:32` — `return known()` | `trident/gates/review-suite.test.ts` / `suite observation` | yes | RED | GREEN |
| identity | `trident/gates/review-suite.ts:36` — `return known()` | `trident/gates/review-suite.test.ts` / `suite observation` | yes | RED | GREEN |
| config | `trident/gates/review-suite.ts:37` — `return known()` | `trident/gates/review-suite.test.ts` / `suite observation` | yes | RED | GREEN |
| malformed | `trident/gates/review-suite.ts:40` — `return known()` | `trident/gates/review-suite.test.ts` / `suite observation` | yes | RED | GREEN |
| exception | `trident/gates/review-suite.ts:50` — `return known()` | `trident/gates/review-suite.test.ts` / `suite observation` | yes | RED | GREEN |
| observed-unknown | `trident/gates/review-suite.ts:35` — `if (value.kind === 'unknown') return known()` | `trident/gates/review-suite.test.ts` / `suite observation` | yes | RED | GREEN |
| panel-stop | `trident/gates/review-suite.ts:55` — `if (panel.kind === 'blocked' \|\| panel.kind === 'unknown') return { kind: 'approve' }` | `trident/gates/review-suite.test.ts` / `suite composition` | yes | RED | GREEN |
| suite-unknown | `trident/gates/review-suite.ts:56` — `if (suite.kind === 'unknown') return { kind: 'approve' }` | `trident/gates/review-suite.test.ts` / `suite composition` | yes | RED | GREEN |
| override | `trident/build-run.ts:340` — `const decision = panel` | `trident/build-run.test.ts` / `suite step` | yes | RED | GREEN |
| driver-source | `trident/build-run.ts:330` — `if (!deps.reviewSuite) return { kind: 'merged', snapshot }` | `trident/build-run.test.ts` / `suite missing` | yes | RED | GREEN |
| driver-unknown | `trident/build-run.ts:332` — `if (suite.kind === 'unknown') return { kind: 'merged', snapshot }` | `trident/build-run.test.ts` / `suite missing` | yes | RED | GREEN |
| brief | `trident/build-run.ts:333` — `findings = [...findings]` | `trident/build-run.test.ts` / `suite advisory` | yes | RED | GREEN |
| host-wiring | `trident/build-host.ts:120` — `Promise.resolve({ kind: 'known', findings: [] })` | `trident/build-host.test.ts` / `host composes suite` | yes | RED | GREEN |
| strategy-exemption | `trident/gates/review-suite.ts:38` — `if (value.strategy.length >= 0) return known()` | `trident/gates/review-suite.test.ts` / `G063` | yes | RED | GREEN |
| pass-exemption | `trident/gates/review-suite.ts:42` — `if (Boolean(report)) return known()` | `trident/gates/review-suite.test.ts` / `G063` | yes | RED | GREEN |
| advisory-filter | `trident/gates/review-suite.ts:57` — `suite.findings.filter(f => f.advisory)` | `trident/gates/review-suite.test.ts` / `G063` | yes | RED | GREEN |
| empty-blockers | `trident/gates/review-suite.ts:58` — `if (blockers.length >= 0) return panel` | `trident/gates/review-suite.test.ts` / `G063` | yes | RED | GREEN |
| approval-override | `trident/gates/review-suite.ts:59` — `if (panel.kind === 'approve') return panel` | `trident/gates/review-suite.test.ts` / `G063` | yes | RED | GREEN |
| combine | `trident/gates/review-suite.ts:60` — `return panel` | `trident/gates/review-suite.test.ts` / `suite composition` | yes | RED | GREEN |

23 mutations completed. An initial extra strategy-exemption mutation using `if (true)` made downstream narrowing fail compilation; it was discarded, restored, and replaced with the compiling `value.strategy.length >= 0` mutation above. The compiler failure is not counted as RED. No assertion was weakened.

### Validation and delivery

- `bun test trident/build-run.test.ts trident/build-host.test.ts trident/gates/ trident/inner-workflow-assembly.test.ts`: **261 pass, zero fail, 1162 assertions, eleven files**. Includes all touched tests and the retained certification file for each addressed gate. No whole-suite sweep.
- `bunx tsc --noEmit -p trident/tsconfig.json`: passed for all 23 recorded mutations and once more after final restoration. `bash scripts/ci/typecheck-all.sh`: **50 passed of 51**, including trident; `app/tsconfig.json` failed with TS2688, missing type definition `@types`. This matches the first increment's documented matrix failure. The repository-wide typecheck is not green.
- `bash scripts/ci/lint.sh`: passed.
- `bash scripts/ci/leak-gate.sh --tree .`: **INCOMPLETE**, zero findings from executed rules; `pii-denylist` and `pii-denylist-msg` unavailable. The scan covered two existing message lines and does not certify this subsequent commit message.
- `git diff --check`: passed. Local restricted-text check passed across eight changed files, enumerated by `git diff --name-only` plus `git ls-files --others --exclude-standard`. The record has exactly one top-level `## ` heading.
- Protected-scope control: `git diff --name-only -- trident/build-run.ts trident/inner-loop.ts trident/review-run.ts trident/inner-workflow.mjs gateway open` printed only `trident/build-run.ts`. This checks the current diff, not a fetched remote ref. No network access, push, PR creation or merge was attempted.
- Delivery is a local commit on `rebuild/review-structure-2`, with this branch-specific shard staged alongside the code and tests. The orchestrator owns subsequent review and publication.
