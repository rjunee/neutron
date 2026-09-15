## Review structure increment five — build transitions and CI decisions

### Delivered scope and enumeration

This bounded increment addresses **G023, G036, G042, G055 and G056** at the normalized host boundary. Branch disagreement, confirmed merge, lost fix work, CI failure comparison and CI deferral have separate functions and direct tests (`trident/gates/build-transition.ts:4`, `trident/gates/build-transition.ts:13`, `trident/gates/build-transition.ts:21`, `trident/gates/review-ci.ts:18`, `trident/gates/review-ci.ts:42`). It does not finish the review cutover.

Read the four prior records in order and read each assigned inventory row and audit conflict section. Enumerated the audit copy's 23 `#### G` headings in the audit build worktree, then subtracted G035/G043/G044/G047/G049/G052/G053/G054, G063/G064/G065, G075/G077 and G070/G071. The resulting eight IDs exactly match this task: G023, G036, G042, G055, G056, G101, G102, G124. The prior subtraction at `.trident/as-built/rebuild/review-structure.md:39` is confirmed. This is enumeration of that audit copy, not a fetched remote or a claim that every gate is fully integrated in production.

### Per-gate evidence

Properties below quote the inventory's own words. Current certification files ran unchanged; they exercise the retained implementation. Direct tests exercise this change independently.

| Gate | Inventory property | New step and driver boundary | Current retained certification | Direct certification |
| --- | --- | --- | --- | --- |
| G023 | A reported builder branch must agree with the deterministic assigned branch. | `trident/gates/build-transition.ts:4`, `trident/build-run.ts:275`; host assignment at `trident/build-host.ts:79` | `trident/inner-workflow-gates.test.ts:142`, `trident/inner-workflow-gates.test.ts:149` | `trident/gates/build-transition.test.ts:8`, `trident/build-run.test.ts:923` |
| G036 | A confirmed merged PR terminates before re-fire or lost-round handling. | `trident/gates/build-transition.ts:13`, `trident/build-run.ts:185`, `trident/build-run.ts:272` | `trident/orchestrator.test.ts:3873`, `trident/orchestrator.test.ts:3911` | `trident/gates/build-transition.test.ts:15`, `trident/build-run.test.ts:939`, `trident/build-run.test.ts:952` |
| G042 | An unchanged or unreadable post-fix head stops the loop as round-lost after checking for an actual merge. | `trident/gates/build-transition.ts:21`, `trident/build-run.ts:278` | `trident/round-landed.test.ts:76`, `trident/round-landed.test.ts:87`, `trident/round-landed.test.ts:168` | `trident/gates/build-transition.test.ts:27`, `trident/build-run.test.ts:967`, `trident/build-run.test.ts:976` |
| G055 | New red CI findings force rejection, while the same failing check measured on the base becomes advisory. | `trident/gates/review-ci.ts:18`, `trident/gates/review-ci.ts:47`, `trident/build-run.ts:383` | `trident/__tests__/ci-gate.test.ts:37`; historical pin gap below | `trident/gates/review-ci.test.ts:9`, `trident/build-run.test.ts:985`, `trident/build-run.test.ts:996` |
| G056 | Pending or unreadable CI joins the deferred-peer gate rather than granting approval. | `trident/gates/review-ci.ts:42`, `trident/build-run.ts:368`, `trident/build-run.ts:377` | `trident/__tests__/ci-gate.test.ts:31`, `trident/__tests__/ci-gate.test.ts:43`; historical pin gap below | `trident/gates/review-ci.test.ts:27`, `trident/build-run.test.ts:1004` |

The inventory's G023/G036 pins drifted; the current assertions are cited above. **G055/G056 historical certification is not established:** the inventory cites lines 246/256/290/311, beyond the current 49-line CI certification file. Its aggregate readiness tests pass unchanged, but do not establish historical base-comparison or deferred-peer equivalence. New direct tests and compiling wrong-answer mutations establish the delivered boundary.

### Decisions, vocabulary and continuous enforcement

- G023 preserves the retained distinction between an absent report and a disagreement (`trident/inner-workflow.mjs:1817`). The host supplies the deterministic run branch; missing assignment is unknown, disagreement is blocked, and head/diff/PR corroboration remains an independent subsequent check (`trident/build-host.ts:79`, `trident/gates/build-transition.ts:5`, `trident/build-run.ts:279`). This compares the payload claim to the assignment; it does not independently discover a checkout's branch name.
- G036 accepts a host-observed merged PR even if the branch has disappeared or the worker trailer is stale. At initial observation it precedes fresh-PR refusal and pending-resume handling; after completed work it precedes trailer and lost-round checks (`trident/build-run.ts:185`, `trident/build-run.ts:272`). A known prior PR number must match, and the merged PR must carry a full commit identity (`trident/gates/build-transition.ts:15`). PR confirmation does not terminate local-mode work (`trident/build-run.ts:185`). Retained ordering was read before implementing it (`trident/inner-workflow.mjs:3216`).
- G042 compares full normalized before/after commit IDs on both fresh-loop and resumed fixes (`trident/gates/build-transition.ts:23`, `trident/build-run.ts:278`, `trident/build-run.test.ts:976`). A readable measurement with a missing branch head is round-lost. An unreadable whole measurement remains unknown because it cannot establish whether the PR merged (`trident/build-run.ts:269`). No worker can declare its own progress.
- G055 compares failing check names only against host evidence at the configured full base ID; unknown, wrong-base, pending and malformed base evidence excuses no failure (`trident/gates/review-ci.ts:31`). Blank names and the unnamed sentinel cannot earn exemptions (`trident/gates/review-ci.ts:32`). New red becomes a fix even when the panel approves. Base-only red holds without consuming a fix; an independent panel repair still proceeds (`trident/gates/review-ci.ts:48`, `trident/gates/review-ci.test.ts:47`). This preserves the kept hold at `trident/inner-workflow.mjs:5588`, not merely its advisory label.
- G056 is a separate status-deferral step, with unavailable observations retaining unknown (`trident/gates/review-ci.ts:22`, `trident/gates/review-ci.ts:42`). CI is acquired for the review brief and re-measured after the review worker before the host accepts a decision (`trident/build-run.ts:367`, `trident/build-run.ts:376`). CI blockers join host repeat/count arithmetic (`trident/build-run.ts:385`). The ordinary review-readiness budget and host round/re-plan accounting remain the existing owners; the new source has no worker-supplied budget fields (`trident/gates/review-ci.ts:4`).
- These steps join existing `GateResult`, `ReviewDecision` and `BuildRunOutcome` vocabularies (`trident/build-run.ts:33`, `trident/build-run.ts:119`). Branch refusal and advisory-only CI use blocked, whose default recipient is the orchestrator; deferred CI uses nonterminal unknown (`trident/build-run.ts:154`, `trident/build-run.ts:155`). Lost work uses the existing `round-lost-work` cause, whose existing sentence says the work never reached the branch (`trident/terminal-cause.ts:113`, `trident/terminal-cause.ts:224`). A confirmed merge returns the existing merged outcome, without another merge effect (`trident/build-run.ts:272`). This does not add or certify durable board classification for the advisory reason string.
- Continuous enforcement is in the driver on each completed build/fix transition and each fresh review decision (`trident/build-run.ts:268`, `trident/build-run.ts:376`). It depends on host measurements, not on the worker admitting a failure. A missing or throwing CI source cannot authorize progress (`trident/gates/review-ci.ts:19`, `trident/gates/review-ci.ts:38`). A source that never returns cannot advance this awaited transition; this change does not deliver an independent CI-source timeout or host-crash recovery.

### Fixture changes and bounded remainder

Existing driver fixtures now actually move the measured head when their fake fixer completes, and update future recorded trailers to that revision (`trident/build-run.test.ts:17`). Existing assertions were preserved. No-op fixtures explicitly disable that simulated commit, so G042 tests can distinguish a landed fix from an unchanged head (`trident/build-run.test.ts:968`). An initial resumed-fix test supplied no actionable finding and therefore never reached the fixer; the fixture was corrected to include a real finding, without relaxing its failure assertion (`trident/build-run.test.ts:977`).

Remaining assigned gates, enumerated by subtracting the five delivered IDs from the verified eight-ID set: **G101, G102, G124**. G101 needs an explicit pre-review publication/open-PR step; G102 needs successful physical artifact materialization beyond the existing full-head/nonempty-string check (`trident/build-run.ts:359`); G124 needs definite-failure persistence and an independent outer recovery contract. The catch still returns unknown (`trident/build-run.ts:460`). These are deliberate bounded deferrals, not completed gates.

Production PR/CI collectors, retrospective certification of approved resumes, durable escalation history and crash recovery were deliberately not implemented. The CI source is a normalized host integration contract (`trident/gates/review-ci.ts:12`). Approved resumes still bypass fresh panel steps (`trident/build-run.ts:219`). G070/G071 retain the prior record's resume limitations (`.trident/as-built/rebuild/review-structure-4.md:29`). No product decision or spec acceptance criterion changed. Read the work-tracking rules before implementation and again before writing this record; used the task's explicitly prescribed branch-specific shard destination.

The merge-first ordering also preserves pending worker identity when its initial measurement is unreadable (`trident/build-run.ts:179`, `trident/build-run.ts:180`). The regression first returned plan/null and went green after capturing the pending identity before the probe (`trident/build-run.test.ts:1029`).

### Mutation evidence


All 52 mutations below compiled, produced an assertion failure with the named test, and passed the same test after restoration. The first 41 compiled with `bunx tsc --noEmit -p trident/tsconfig.json`; supplemental checks used the same configuration with incremental metadata outside the repository. Final repository typechecking runs on restored sources. Each replacement was applied alone.

The initial refresh mutation (`const ci = ciBefore`) failed compilation because control-flow narrowing made the later unknown arm unreachable. It is excluded. Its replacement retains the declared observation union through `Promise.resolve`, compiles and returns the wrong stale result. The null-PR mutation was rerun because its first printer showed the preceding declaration; the rerun printed the actual inserted refusal-bypass line 15 before compiling and observing RED, then restored GREEN.

| Guard | Printed landing and mutation | Test file / filter | Compile | Mutated | Restored |
| --- | --- | --- | --- | --- | --- |
| G023 assignment | `trident/gates/build-transition.ts:5` — `return { kind: 'allow' }` | `trident/gates/build-transition.test.ts` / `G023` | GREEN | RED | GREEN |
| G023 disagreement | `trident/gates/build-transition.ts:8` — `if (false)` | `trident/build-run.test.ts` / `G023 driver checks` | GREEN | RED | GREEN |
| G023 matching control | `trident/gates/build-transition.ts:8` — `if (reported)` | `trident/gates/build-transition.test.ts` / `G023` | GREEN | RED | GREEN |
| G036 state | `trident/gates/build-transition.ts:15` — `true` | `trident/gates/build-transition.test.ts` / `G036` | GREEN | RED | GREEN |
| G036 number integer | `trident/gates/build-transition.ts:15` — `true` | `trident/gates/build-transition.test.ts` / `G036` | GREEN | RED | GREEN |
| G036 number positive | `trident/gates/build-transition.ts:15` — `true` | `trident/gates/build-transition.test.ts` / `G036` | GREEN | RED | GREEN |
| G036 full PR head | `trident/gates/build-transition.ts:16` — `true` | `trident/gates/build-transition.test.ts` / `G036` | GREEN | RED | GREEN |
| G036 matching identity | `trident/gates/build-transition.ts:17` — `true` | `trident/gates/build-transition.test.ts` / `G036` | GREEN | RED | GREEN |
| G042 readable before | `trident/gates/build-transition.ts:23` — `oid(after)` | `trident/gates/build-transition.test.ts` / `G042` | GREEN | RED | GREEN |
| G042 readable after | `trident/gates/build-transition.ts:23` — `oid(before)` | `trident/gates/build-transition.test.ts` / `G042` | GREEN | RED | GREEN |
| G042 movement | `trident/gates/build-transition.ts:23` — `true` | `trident/build-run.test.ts` / `G042 driver stops lost fix` | GREEN | RED | GREEN |
| G042 normalization | `trident/gates/build-transition.ts:23` — `before !== after` | `trident/gates/build-transition.test.ts` / `G042` | GREEN | RED | GREEN |
| G042 moved control | `trident/gates/build-transition.ts:23` — `false` | `trident/gates/build-transition.test.ts` / `G042` | GREEN | RED | GREEN |
| G023 driver refusal | `trident/build-run.ts:276` — `if (false) return { stop: branch! }` | `trident/build-run.test.ts` / `G023 driver` | GREEN | RED | GREEN |
| G036 initial ordering | `trident/build-run.ts:185` — `remove statement` | `trident/build-run.test.ts` / `G036 initial` | GREEN | RED | GREEN |
| G036 worker ordering | `trident/build-run.ts:272` — `remove statement` | `trident/build-run.test.ts` / `G036 merge during` | GREEN | RED | GREEN |
| G042 driver | `trident/build-run.ts:278` — `if (false)` | `trident/build-run.test.ts` / `G042` | GREEN | RED | GREEN |
| G023 host assignment | `trident/build-host.ts:79` — `assignedBranch: 'wrong'` | `trident/build-host.test.ts` / `G023 host` | GREEN | RED | GREEN |
| G055 source | `trident/gates/review-ci.ts:19` — `return { kind: 'known', findings: [] }` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G056 observation | `trident/gates/review-ci.ts:22` — `if (value.kind === 'unknown') return { kind: 'known', findings: [] }` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G055 head | `trident/gates/review-ci.ts:23` — `return { kind: 'known', findings: [] }` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G056 deferred dispatch | `trident/gates/review-ci.ts:26` — `if (deferred) return { kind: 'known', findings: [] }` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G055 malformed names | `trident/gates/review-ci.ts:27` — `return { kind: 'known', findings: [] }` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G055 red empty | `trident/gates/review-ci.ts:29` — `return { kind: 'known', findings: [] }` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G055 status | `trident/gates/review-ci.ts:28` — `if (value.status)` | `trident/gates/review-ci.test.ts` / `G055 new red` | GREEN | RED | GREEN |
| G055 base pin shape | `trident/gates/review-ci.ts:31` — `true` | `trident/gates/review-ci.test.ts` / `G055 base` | GREEN | RED | GREEN |
| G055 base identity | `trident/gates/review-ci.ts:31` — `true` | `trident/gates/review-ci.test.ts` / `G055 base` | GREEN | RED | GREEN |
| G055 base red | `trident/gates/review-ci.ts:31` — `true` | `trident/gates/review-ci.test.ts` / `G055 base` | GREEN | RED | GREEN |
| G055 base unnamed | `trident/gates/review-ci.ts:32` — `true` | `trident/gates/review-ci.test.ts` / `G055 base` | GREEN | RED | GREEN |
| G055 base blank | `trident/gates/review-ci.ts:32` — `true` | `trident/gates/review-ci.test.ts` / `G055 base` | GREEN | RED | GREEN |
| G055 advisory match | `trident/gates/review-ci.ts:36` — `advisory: true` | `trident/gates/review-ci.test.ts` / `G055 new red` | GREEN | RED | GREEN |
| G055 matching control | `trident/gates/review-ci.ts:36` — `advisory: false` | `trident/gates/review-ci.test.ts` / `G055 new red` | GREEN | RED | GREEN |
| G056 exception | `trident/gates/review-ci.ts:38` — `return { kind: 'known', findings: [] }` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G056 status predicate | `trident/gates/review-ci.ts:43` — `Boolean(status)` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G055 forced repair | `trident/gates/review-ci.ts:48` — `const decision = panel` | `trident/gates/review-ci.test.ts` / `G055 new red` | GREEN | RED | GREEN |
| G055 advisory hold | `trident/gates/review-ci.ts:49` — `if (false)` | `trident/gates/review-ci.test.ts` / `G055 new red` | GREEN | RED | GREEN |
| G055 host wiring | `trident/build-host.ts:123` — `Promise.resolve({ kind: 'known', findings: [] })` | `trident/build-host.test.ts` / `G055 G056 host` | GREEN | RED | GREEN |
| G055 driver composition | `trident/build-run.ts:383` — `const decision = suiteDecision` | `trident/build-run.test.ts` / `G055 driver` | GREEN | RED | GREEN |
| G056 driver missing | `trident/build-run.ts:366` — `if (!deps.reviewCi) return { kind: 'merged', snapshot }` | `trident/build-run.test.ts` / `G056 missing` | GREEN | RED | GREEN |
| G056 driver initial | `trident/build-run.ts:368` — `if (ciBefore.kind === 'unknown') return { kind: 'merged', snapshot }` | `trident/build-run.test.ts` / `G056 missing` | GREEN | RED | GREEN |
| G056 driver final | `trident/build-run.ts:377` — `if (ci.kind === 'unknown') return { kind: 'merged', snapshot }` | `trident/build-run.test.ts` / `G056 missing` | GREEN | RED | GREEN |
| G036 null PR | `trident/gates/build-transition.ts:15` — `if (pr === null) return true` | `trident/gates/build-transition.test.ts` / `G036` | GREEN | RED | GREEN |
| G036 local isolation | `trident/build-run.ts:185` — `if (confirmedMerged(snapshot))` | `trident/build-run.test.ts` / `G036 local` | GREEN | RED | GREEN |
| G023 payload extraction | `trident/build-run.ts:274` — `const payload = undefined` | `trident/build-run.test.ts` / `G023 driver checks` | GREEN | RED | GREEN |
| G055 base array | `trident/gates/review-ci.ts:31` — `remove statement` | `trident/gates/review-ci.test.ts` / `G055 base` | GREEN | RED | GREEN |
| G055 base entry type | `trident/gates/review-ci.ts:32` — `name.trim()` | `trident/gates/review-ci.test.ts` / `G055 malformed base` | GREEN | RED | GREEN |
| G055 base absence | `trident/gates/review-ci.ts:30` — `const base = value.base ?? { head: baseHead, status: 'red', failing: value.failing }` | `trident/gates/review-ci.test.ts` / `G055 base` | GREEN | RED | GREEN |
| G055 driver arithmetic | `trident/build-run.ts:385` — `suite.findings.filter` | `trident/build-run.test.ts` / `G055 CI blockers` | GREEN | RED | GREEN |
| G056 green control | `trident/gates/review-ci.ts:43` — `false` | `trident/gates/review-ci.test.ts` / `G056 unknown` | GREEN | RED | GREEN |
| G056 refresh | `trident/build-run.ts:376` — `const ci = await Promise.resolve(ciBefore as SuiteAssessment)` | `trident/build-run.test.ts` / `G056 missing` | GREEN | RED | GREEN |
| G036 pending phase | `trident/build-run.ts:179` — `phase = phase` | `trident/build-run.test.ts` / `G036 merge probe uncertainty` | GREEN | RED | GREEN |
| G036 pending identity | `trident/build-run.ts:180` — `step_id = step_id` | `trident/build-run.test.ts` / `G036 merge probe uncertainty` | GREEN | RED | GREEN |

### Search controls

`git diff --name-only -- trident/build-run.ts trident/inner-loop.ts trident/review-run.ts trident/inner-workflow.mjs gateway open` printed only `trident/build-run.ts`. That is a positive control over the local diff, not a claim about a fetched remote. Protected implementations and directories have no diff in this change.

A content search across `trident`, `docs` and `.trident/as-built/rebuild`, including hidden files and excluding dependencies and git metadata, used `post-panel CI|CI is read later|Review CI deferred peer|Reported builder branch disagrees`. It found the new implementation controls (`trident/gates/review-ci.ts:43`, `trident/gates/build-transition.ts:8`) and prior incomplete-scope descriptions (`.trident/as-built/rebuild/review-structure.md:37`, `.trident/as-built/rebuild/review-structure-4.md:29`). Those earlier records stay because they are immutable descriptions of their increments, not current implementation claims.

### Final validation

- `bun test trident/build-run.test.ts trident/build-host.test.ts trident/gates/`: **238 pass, 0 fail, 971 assertions**, thirteen files, on restored sources.
- `bun test trident/inner-workflow-gates.test.ts trident/orchestrator.test.ts trident/round-landed.test.ts trident/__tests__/ci-gate.test.ts`: **345 pass, 0 fail, 1644 assertions**, four unchanged retained certification files. No whole-suite sweep or harness-launching test script was run.
- `bash scripts/ci/typecheck-all.sh`: **51 configurations checked, ALL PASS**. `bash scripts/ci/lint.sh`: exit 0.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, **INCOMPLETE**. Zero findings from executed rules; `pii-denylist` and `pii-denylist-msg` unavailable. The scan covered 177 existing message lines and does not certify the subsequent commit message. Local restricted-text checks passed for all ten changed files and the chosen commit message.
- Changed files enumerated by `git diff --name-only` plus `git ls-files --others --exclude-standard`. `git diff --check` passed. The shard has exactly one `## ` heading. Scope controls are above.
- Delivery is a local commit on `rebuild/review-structure-5`, with this record staged alongside the implementation and tests. The orchestrator owns review and publication. No push, PR creation or merge was attempted.
