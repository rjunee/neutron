## Review structure — bounded artifact and readiness slice

### Delivered scope

This change addresses eight audit gates at the normalized host observation boundary: G035, G043, G044, G047, G049, G052, G053 and G054. The driver now checks review artifacts, awaits readiness, re-measures the subject, and only then dispatches the panel (`trident/build-run.ts:324`, `trident/build-run.ts:326`, `trident/build-run.ts:328`, `trident/build-run.ts:331`). Host composition supplies the readiness observer independently of worker output (`trident/build-host.ts:35`, `trident/build-host.ts:115`). This is a partial delivery, not completion of the review cutover.

Read the audit from the audit lane's worktree copy after the requested local branch name did not resolve. Enumerated its 23 `#### G` conflict sections; eight are addressed here and fifteen are listed below. Also read the kept implementations: readiness classification and admission at `trident/inner-workflow.mjs:3836`, `trident/inner-workflow.mjs:3948`, `trident/inner-workflow.mjs:3968`, `trident/inner-workflow.mjs:3982`; configured rounds at `trident/inner-loop.ts:612`; retained panel invocation at `trident/review-run.ts:244`. These files were not edited.

### Gate evidence and certification

All cited current certification files passed without edits. **Historical CI certification gap:** the inventory pins for G044/G047/G049/G052/G053/G054 are beyond the current 49-line CI certification file. Its current tests exercise aggregate CI classification (`trident/__tests__/ci-gate.test.ts:13`, `trident/__tests__/ci-gate.test.ts:43`). Running that file green preserves its current certification, but cannot recreate deleted historical assertions. The new tests below directly certify the new readiness boundary and were mutation-checked. No claim of historical test equivalence is made.

| Gate | Property at the new boundary | Implementation | Current certification file, green | New direct evidence |
| --- | --- | --- | --- | --- |
| G035 | Full measured branch OID and nonempty diff bytes before fresh review | `trident/build-run.ts:324` | `trident/inner-workflow-built-head.test.ts:229` | `trident/build-run.test.ts:677`, independently empty head and diff |
| G043 | A fix erasing the diff cannot buy another panel | `trident/build-run.ts:324` | `trident/inner-workflow-built-head.test.ts:314` | `trident/build-run.test.ts:687`, new head with empty diff |
| G044 | Unknown required configuration remains unknown despite green rows | `trident/gates/review-readiness.ts:33` | `trident/__tests__/ci-gate.test.ts:43`, historical gap above | `trident/gates/review-readiness.test.ts:15` |
| G047 | Measured mergeability is required; conflicts stop, pending waits | `trident/gates/review-readiness.ts:34` | `trident/__tests__/ci-gate.test.ts:13`, historical gap above | `trident/gates/review-readiness.test.ts:19` |
| G049 | Every named requirement has a non-skipped row and all its participating rows settle | `trident/gates/review-readiness.ts:45` | `trident/__tests__/ci-gate.test.ts:31`, historical gap above | `trident/gates/review-readiness.test.ts:24` |
| G052 | Without named requirements, at least one row ran and all participating rows settled | `trident/gates/review-readiness.ts:49` | `trident/__tests__/ci-gate.test.ts:25`, historical gap above | `trident/gates/review-readiness.test.ts:31` |
| G053 | Host owns the 900000-ms elapsed deadline and 30000-ms cadence; exhaustion defers before dispatch | `trident/gates/review-readiness.ts:25`, `trident/gates/review-readiness.ts:75`, `trident/gates/review-readiness.ts:94` | `trident/__tests__/ci-gate.test.ts:31`, historical gap above | `trident/gates/review-readiness.test.ts:36`, `trident/gates/review-readiness.test.ts:67` |
| G054 | Settled pass and failure enter review; unreadable facts and conflicts cannot enter | `trident/gates/review-readiness.ts:91`, `trident/build-run.ts:327` | `trident/__tests__/ci-gate.test.ts:37`, historical gap above | `trident/gates/review-readiness.test.ts:46`, `trident/build-run.test.ts:698` |

### Decisions and outcome vocabulary

- Keep readiness acquisition separate from classification. `ReviewReadinessSource.observe` supplies complete normalized configuration and rows for the requested head, or unknown (`trident/gates/review-readiness.ts:20`). The worker has no readiness budget, round, or re-plan input to set through this interface. Missing host wiring stops as unknown (`trident/build-run.ts:325`, `trident/gates/review-readiness.ts:71`).
- Re-use the existing `GateResult` vocabulary. Readiness `passed` and `failed` mean permission to spend review, not permission to merge (`trident/gates/review-readiness.ts:91`). Pending exhaustion and missing facts become `unknown`; conflicts become `blocked` (`trident/gates/review-readiness.ts:34`, `trident/gates/review-readiness.ts:96`). The driver maps these through its existing gate conversion: blocked goes to the orchestrator and unknown preserves uncertainty (`trident/build-run.ts:147`, `trident/build-run.ts:150`). Readiness begins with a null worker step ID (`trident/build-run.ts:322`), because no panel has started.
- Bound the actual elapsed interval, including observation time. The kept loop derives 31 attempts from 30 waits (`trident/inner-workflow.mjs:3379`); this host stops at the deadline rather than starting an extra probe after exhaustion (`trident/gates/review-readiness.ts:88`, `trident/gates/review-readiness.ts:90`). An independent timer and cancellation race return even when the observer ignores cancellation (`trident/gates/review-readiness.ts:79`, `trident/gates/review-readiness.test.ts:67`). Continuous enforcement therefore does not depend on the failing observer returning.
- Re-measure after readiness before dispatch, since a waiting interval can outlive its subject (`trident/build-run.ts:328`). The invariant is maintained at every paid review entry, including after fixes and re-plans (`trident/build-run.ts:320`).
- Local mode uses the existing local readiness measurement, preserving the kept local panel's lack of a circular PR dependency (`trident/build-host.ts:115`, `trident/review-run.ts:239`). This introduces no feature flag or selectable replacement implementation.
- Existing test fixtures gained the required readiness observation. Exact measurement counts increased by one per panel (`trident/build-run.test.ts:52`, `trident/build-run.test.ts:627`). Two injected head changes moved one read later to continue exercising their original boundaries; their refusal assertions were retained (`trident/build-run.test.ts:156`, `trident/build-run.test.ts:608`). No assertion was weakened or skipped.

### Deliberately unfinished

The observation source is an integration requirement, not a newly implemented remote collector (`trident/build-host.ts:35`). This change does not certify raw PR parsing, complete protection/ruleset acquisition, app-bound producers, base comparisons, configuration grace/reclassification, physical diff-file materialization, or production wiring. Unknown acquisition must be reported as unknown through the source contract (`trident/gates/review-readiness.ts:20`). Configuration faults that cannot be established are unknown, not inferred from an absent check. G045/G046/G048/G050/G051 need their own acquisition work and certification.

The panel and severity calculation remain composed in `reviewPanel` (`trident/gates/review-panel.ts:85`), and the old repeat/count behavior remains in the driver (`trident/build-run.ts:349`, `trident/build-run.ts:352`). They are not claimed repaired. Suite evidence, post-panel CI, and repeat findings still need separate review steps.

Remaining conflict IDs, obtained by subtracting the eight delivered IDs from the audit's 23 conflict sections: **G023, G036, G042, G055, G056, G063, G064, G065, G070, G071, G075, G077, G101, G102, G124**. This includes audit conflicts outside the review-centered group. No inference is made about the audit's CANNOT TELL rows. The spec's product decisions were not changed. No protected implementation, gateway, or open files were edited; no push, PR creation, or merge was performed.

### Mutation evidence

Each mutation below was applied alone, compiled with `bunx tsc --noEmit -p trident/tsconfig.json`, produced an assertion failure with the named targeted test, and passed the same test after restoration. The fixture reached the mutated boundary; failures were wrong outcomes, not compilation failures. Mutation landing lines were printed. The initial printer selected an earlier matching substring for two artifact mutations; those mutations were repeated with the changed-line offset, printing the actual line 324.

| Guard | Applied mutation and landing line | Targeted test filter | Compiles | Mutated | Restored |
| --- | --- | --- | --- | --- | --- |
| G035-head | `trident/build-run.ts:324` — `if (!snapshot.diff.trim()) return unknown('Review requires a full branch head and nonempty diff artifact')` | `trident/build-run.test.ts` / `G035 fresh review refuses missing head` | yes | RED | GREEN |
| G035-diff | `trident/build-run.ts:324` — `if (!fullOid(snapshot.head)) return unknown('Review requires a full branch head and nonempty diff artifact')` | `trident/build-run.test.ts` / `G035 fresh review refuses missing diff` | yes | RED | GREEN |
| G043 | `trident/build-run.ts:324` — `if (!fullOid(snapshot.head)) return unknown('Review requires a full branch head and nonempty diff artifact')` | `trident/build-run.test.ts` / `G043` | yes | RED | GREEN |
| G044 | `trident/gates/review-readiness.ts:33` — `if (observation.configuration.kind === 'unknown') return { kind: 'passed', failed: [] }` | `trident/gates/review-readiness.test.ts` / `G044` | yes | RED | GREEN |
| G047-conflict | `trident/gates/review-readiness.ts:34` — `if (observation.mergeability === 'conflicting') return { kind: 'passed', failed: [] }` | `trident/gates/review-readiness.test.ts` / `G047` | yes | RED | GREEN |
| G047-pending | `trident/gates/review-readiness.ts:35` — `if (observation.mergeability !== 'mergeable') return { kind: 'passed', failed: [] }` | `trident/gates/review-readiness.test.ts` / `G047` | yes | RED | GREEN |
| G049 | `trident/gates/review-readiness.ts:47` — `if (matching.length === 0 \|\| matching.some(row => row.state === 'running')) return { kind: 'passed', failed: [] }` | `trident/gates/review-readiness.test.ts` / `G049` | yes | RED | GREEN |
| G052 | `trident/gates/review-readiness.ts:49` — `if (required.length === 0 && (ran.length === 0 \|\| ran.some(row => row.state === 'running'))) return { kind: 'passed', failed: [] }` | `trident/gates/review-readiness.test.ts` / `G052` | yes | RED | GREEN |
| G053-budget | `trident/gates/review-readiness.ts:25` — `export const REVIEW_READINESS_BUDGET_MS = 1800000` | `trident/gates/review-readiness.test.ts` / `G053 readiness spends` | yes | RED | GREEN |
| G053-cadence | `trident/gates/review-readiness.ts:26` — `export const REVIEW_READINESS_RETRY_MS = 15000` | `trident/gates/review-readiness.test.ts` / `G053 readiness spends` | yes | RED | GREEN |
| G053-deadline | `trident/gates/review-readiness.ts:90` — `if (false) break` | `trident/gates/review-readiness.test.ts` / `readiness cannot outlive` | yes | RED | GREEN |
| G053-watchdog | `trident/gates/review-readiness.ts:79` — `timer = setTimeout(() => { resolve({ kind: 'allow' }); controller.abort() }, REVIEW_READINESS_BUDGET_MS)` | `trident/gates/review-readiness.test.ts` / `G053 watchdog` | yes | RED | GREEN |
| G054 | `trident/gates/review-readiness.ts:92` — `if (readiness.kind === 'unknown' \|\| readiness.kind === 'blocked') return { kind: 'allow' }` | `trident/gates/review-readiness.test.ts` / `G054` | yes | RED | GREEN |
| source | `trident/gates/review-readiness.ts:71` — `if (!source) return { kind: 'allow' }` | `trident/gates/review-readiness.test.ts` / `readiness cannot outlive` | yes | RED | GREEN |
| head-pin | `trident/gates/review-readiness.ts:32` — `if (observation.kind !== 'known' \|\| observation.head !== snapshot.head) return { kind: 'passed', failed: [] }` | `trident/gates/review-readiness.test.ts` / `readiness cannot outlive` | yes | RED | GREEN |
| malformed | `trident/gates/review-readiness.ts:42` — `return { kind: 'passed', failed: [] }` | `trident/gates/review-readiness.test.ts` / `readiness cannot outlive` | yes | RED | GREEN |
| dispatch | `trident/build-run.ts:327` — `if (false) return readiness!` | `trident/build-run.test.ts` / `readiness runs before` | yes | RED | GREEN |
| remeasure | `trident/build-run.ts:330` — `if (false) return blocked('Revision changed during review readiness')` | `trident/build-run.test.ts` / `readiness cannot dispatch` | yes | RED | GREEN |
| resolved-tag | `trident/gates/review-readiness.ts:36` — `if (observation.configuration.kind !== 'resolved') return { kind: 'passed', failed: [] }` | `trident/gates/review-readiness.test.ts` / `malformed configuration tags` | yes | RED | GREEN |
| missing-driver-source | `trident/build-run.ts:325` — `if (!deps.reviewReadiness) return { kind: 'merged', snapshot }` | `trident/build-run.test.ts` / `readiness runs before` | yes | RED | GREEN |
| cancelled-observation | `trident/gates/review-readiness.ts:82` — `controller.signal.addEventListener('abort', () => resolve({ kind: 'allow' }), { once: true })` | `trident/gates/review-readiness.test.ts` / `readiness cannot outlive` | yes | RED | GREEN |
| observer-exception | `trident/gates/review-readiness.ts:99` — `return { kind: 'allow' }` | `trident/gates/review-readiness.test.ts` / `readiness cannot outlive` | yes | RED | GREEN |
| unreadable-remeasurement | `trident/build-run.ts:329` — `if (readyRevision.kind === 'unknown') return { kind: 'merged', snapshot }` | `trident/build-run.test.ts` / `unreadable host measurement 4` | yes | RED | GREEN |

23 distinct mutations are recorded. The first three were repeated to correct the printed landing-line evidence. Each targeted test also ran green after its own restoration.

### Final validation and delivery

- `bun test trident/build-run.test.ts trident/build-host.test.ts trident/gates/ trident/inner-workflow-built-head.test.ts trident/__tests__/ci-gate.test.ts`: **223 pass, 0 fail, 836 assertions**, eleven test files. This includes every touched test and the current certification file cited by each addressed gate. No whole-suite sweep was run.
- `bunx tsc --noEmit -p trident/tsconfig.json`: green, including every mutation compile. The final `bash scripts/ci/typecheck-all.sh` checked 51 configurations: 50 passed, including trident; `app/tsconfig.json` failed with TS2688, missing the `@types` definition. The repository-wide matrix is therefore **not green**; this change does not repair that dependency failure.
- `bash scripts/ci/lint.sh`: exit 0.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, **INCOMPLETE**. Executed rules found zero findings; `pii-denylist` and `pii-denylist-msg` could not run. The scan saw zero commit-message lines, so it does not certify the subsequent commit message. A local restricted-text check passed across all eight changed files.
- `git diff --check`: green. The record has exactly one `## ` heading. Changed files were enumerated with `git diff --name-only` plus `git ls-files --others --exclude-standard`. The protected-scope control `git diff --name-only -- trident/build-run.ts trident/inner-loop.ts trident/review-run.ts trident/inner-workflow.mjs gateway open` printed only `trident/build-run.ts`.
- Read `docs/process/work-tracking.md` before implementation and its as-built section before writing this record. Used the task's explicit staged-record destination rather than creating a duplicate record. Delivery is a local commit on `rebuild/review-structure`; the orchestrator owns review, push and PR creation.
