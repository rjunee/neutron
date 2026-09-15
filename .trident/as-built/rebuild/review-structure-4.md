## Review structure increment four — live review arithmetic

### Delivered boundary

This increment implements the live-loop portions of **G070 and G071**, with a separate arithmetic step between the recorded panel decision and approval. The driver captures host evidence, combines non-advisory suite findings, checks arithmetic, and only then permits approval (`trident/build-run.ts:358`, `trident/build-run.ts:364`, `trident/build-run.ts:370`, `trident/build-run.ts:372`). This is a bounded increment, not completion of the ten remaining audit gates or durable resume continuity.

Read the first increment record, all 23 conflict sections in the audit build worktree, and all ten assigned inventory rows. The gate audit was read from the other build worktree because the requested record was unavailable in this checkout. The kept exemplars were inspected before copying their conventions: retained panel invocation (`trident/review-run.ts:244`), host round configuration (`trident/inner-loop.ts:612`), suite classification (`trident/gates/review-suite.ts:30`), and the kept escalation ledger (`trident/inner-workflow.mjs:6471`).

| Gate | Property delivered | Current implementation | Kept certification, green | New direct certification |
| --- | --- | --- | --- | --- |
| G070 | A finding that survives dispatched work stops the next live review, before severity can approve; includes the case where every panel finding is minor | `trident/gates/review-progress.ts:16`, `trident/build-run.ts:370` | `trident/__tests__/escalation-gate.test.ts:407`, `trident/__tests__/escalation-gate.test.ts:544` | `trident/build-run.test.ts:843`, `trident/gates/review-progress.test.ts:11` |
| G071 | Nondecreasing blocker/major counts across two live code rounds stop without requiring a spent re-plan | `trident/gates/review-progress.ts:20` | `trident/__tests__/escalation-gate.test.ts:466` | `trident/build-run.test.ts:862`, `trident/build-run.test.ts:870` |

The existing certification file ran without edits. Its kept eligibility test deliberately excludes minor findings (`trident/__tests__/escalation-gate.test.ts:669`). The task explicitly requires severity independence in the new driver; the all-minor test establishes that stronger property independently. It first forces a fix with a suite blocker, verifies the minor identity reaches that fix brief, then observes the same minor identity after the suite is resolved (`trident/build-run.test.ts:845`, `trident/build-run.test.ts:850`). A minor-only first review does not create a fix by itself: severity still permits the panel to approve (`trident/gates/review-panel.ts:97`, `trident/gates/review-panel.ts:104`). Nits are excluded and have a direct successful-control test (`trident/gates/review-panel.ts:87`, `trident/build-run.test.ts:893`).

### Decisions and vocabulary

- The panel exports decoded recorded identities and host-computed counts through a callback; the worker does not supply its history or counts. The configured host forwards the callback (`trident/build-host.ts:121`), and the driver copies its values (`trident/build-run.ts:359`). Host forwarding is directly asserted (`trident/build-host.test.ts:303`). The identities use the existing named-field function (`trident/gates/escalation.ts:25`).
- Preserve the panel's existing blocker counting convention, including occurrences across seats and synthesis (`trident/gates/review-panel.ts:85`, `trident/gates/review-panel.ts:86`). Deduplicate identity matching, independently of those counts (`trident/gates/review-panel.ts:88`). Missing identities and invalid counts return unknown (`trident/gates/review-progress.ts:11`).
- History advances only when a repair or replacement build will follow, before the next live panel (`trident/build-run.ts:373`). Brief every recorded non-nit identity alongside the required repairs so repetition is about work the fixer was actually given (`trident/build-run.ts:378`, `trident/build-run.ts:386`). Non-advisory suite blockers join the arithmetic; advisory suite evidence does not (`trident/build-run.ts:364`, `trident/build-run.test.ts:884`).
- The new step joins **GateResult**, whose vocabulary is allow, blocked, and unknown (`trident/build-run.ts:31`). Repetition and no-progress produce blocked with an arbitration reason (`trident/gates/review-progress.ts:17`, `trident/gates/review-progress.ts:21`). The existing conversion routes blocked to the orchestrator and preserves unknown; it does not default those outcomes to approval (`trident/build-run.ts:150`, `trident/build-run.ts:153`). This change does not certify durable board classification of those reasons.
- Continuous enforcement lives in the driver at every newly completed live panel, before approval and before another fix (`trident/build-run.ts:370`). It requires host observations and does not depend on the reviewer declaring repetition or escalation. Missing callback evidence cannot approve (`trident/build-run.test.ts:877`). Host process crash recovery is not established by this in-memory history.
- Replace the live loop's round-three repeat and post-re-plan-only count checks; retain its five-round ceiling (`trident/build-run.ts:385`). The ceiling test now uses decreasing distinct counts so it reaches the ceiling instead of stopping at the newly enforced count gate (`trident/build-run.test.ts:144`). Assertions were updated for the intended earlier stop, not relaxed to accept multiple outcomes. Synthetic host fixtures now supply the required observation, while their existing success assertions remain (`trident/build-host.test.ts:511`, `trident/gates/local-merge.test.ts:56`).

### Deliberately unfinished

**Resume remains partial.** The existing pre-fix resume branch still delays its own repeat refusal until round three and uses its prior persisted count conventions (`trident/build-run.ts:332`, `trident/build-run.ts:333`). This increment seeds the next live comparison from the resumed fix's briefed identities and their count (`trident/build-run.ts:336`), with a repeat test (`trident/build-run.test.ts:901`). That is not new acquisition of historical panel severities, and does not certify G071 count equivalence for resumed historical findings. The other resume paths and cross-process history reconstruction need their own work. G070/G071 must not be marked fully complete across resume modes from this record.

Remaining assigned IDs, enumerated by subtracting the two addressed live boundaries from the task's explicit ten-ID set: **G023, G036, G042, G055, G056, G101, G102, G124**. G070/G071 additionally retain the resume limitations above. No new remote collector, persistence protocol, post-panel CI base comparison, materialized artifact, or crash outcome was implemented. The spec item's existing repeat/no-progress requirements remain the target (`docs/spec-items/the-review-loop-must-stop-and-re-plan.md:33`); no product decision was changed.

Whole-tree content search with positive controls:

```sh
rg -n --hidden -g '!node_modules/**' -g '!.git/**' 'round three repeats stop|Review requires orchestrator arbitration: repeated finding|recurring NIT or MINOR' .
```

The search found the new refusal at `trident/gates/review-progress.ts:17`, the retained resume guard at `trident/build-run.ts:332`, and the kept eligibility comment at `trident/__tests__/escalation-gate.test.ts:669`. The kept comment remains because it describes the protected implementation. Historical mutation descriptions in `.trident/as-built/rebuild/driver.md:55` and `.trident/as-built/rebuild/driver-modes.md:62` remain immutable historical evidence.

### Mutation table

Each mutation below was applied alone. Its actual changed line was printed, `bunx tsc --noEmit -p trident/tsconfig.json` passed, the named test failed on an assertion, and the restored test passed. The last four include stricter mutations that check successful controls against false stops, plus resume-history coverage. No mutation relied on a syntax error, missing fixture field, skipped assertion, or a compile failure.

| Guard | Actual mutation landing | Test file / filter | Compile | Mutated | Restored |
| --- | --- | --- | --- | --- | --- |
| missing-evidence | `trident/gates/review-progress.ts:12` — `return { kind: 'allow' }` | `trident/build-run.test.ts` / `progress missing` | GREEN | RED | GREEN |
| integer-count | `trident/gates/review-progress.ts:11` — `if (!current \|\| current.blockingCount < 0 \|\| current.findings.some(id => !id.trim())) {` | `trident/gates/review-progress.test.ts` / `progress unreadable` | GREEN | RED | GREEN |
| negative-count | `trident/gates/review-progress.ts:11` — `if (!current \|\| !Number.isSafeInteger(current.blockingCount) \|\| current.findings.some(id => !id.trim())) {` | `trident/gates/review-progress.test.ts` / `progress unreadable` | GREEN | RED | GREEN |
| identity | `trident/gates/review-progress.ts:11` — `if (!current \|\| !Number.isSafeInteger(current.blockingCount) \|\| current.blockingCount < 0 \|\| false) {` | `trident/gates/review-progress.test.ts` / `progress unreadable` | GREEN | RED | GREEN |
| G070 | `trident/gates/review-progress.ts:16` — `if (false) {` | `trident/build-run.test.ts` / `G070 all-minor` | GREEN | RED | GREEN |
| G071 | `trident/gates/review-progress.ts:20` — `if (false) {` | `trident/build-run.test.ts` / `G071 distinct` | GREEN | RED | GREEN |
| advisory-count | `trident/gates/review-progress.ts:20` — `if (current.blockingCount >= previous.blockingCount) {` | `trident/gates/review-progress.test.ts` / `G071 compares` | GREEN | RED | GREEN |
| driver-stop | `trident/build-run.ts:371` — `if (false) return progress!` | `trident/build-run.test.ts` / `G070 all-minor` | GREEN | RED | GREEN |
| history | `trident/build-run.ts:373` — `previousReview = undefined` | `trident/build-run.test.ts` / `G070 all-minor` | GREEN | RED | GREEN |
| severity-independence | `trident/gates/review-panel.ts:87` — `const actionable = verdicts.flatMap(v => v.findings).filter(f => f.severity === 'major' \|\| f.severity === 'blocker').map(findingIdentity)` | `trident/build-run.test.ts` / `G070 all-minor` | GREEN | RED | GREEN |
| host-count | `trident/gates/review-panel.ts:88` — `recordProgress?.({ findings: [...new Set(actionable)], blockingCount: 0 })` | `trident/build-run.test.ts` / `G071 distinct` | GREEN | RED | GREEN |
| host-forwarding | `trident/build-host.ts:121` — `reviewGate: (payload, snapshot, round, replansUsed, recordProgress) => reviewPanel(options.review, payload, snapshot, round, options.mutation.run.id, replansUsed),` | `trident/build-host.test.ts` / `host admission and review reach` | GREEN | RED | GREEN |
| fix-brief | `trident/build-run.ts:386` — `findings = decision.findings` | `trident/build-run.test.ts` / `G070 all-minor` | GREEN | RED | GREEN |
| suite-history | `trident/build-run.ts:364` — `const suiteBlockers = suite.findings.filter(() => false)` | `trident/build-run.test.ts` / `G070 suite blocker` | GREEN | RED | GREEN |
| repeat-positive-control | `trident/gates/review-progress.ts:16` — `if (current.findings.length > 0) {` | `trident/build-run.test.ts` / `G070 resolved minor` | GREEN | RED | GREEN |
| count-positive-control | `trident/gates/review-progress.ts:20` — `if (previous.blockingCount > 0 && current.blockingCount <= previous.blockingCount) {` | `trident/build-run.test.ts` / `G071 decreasing` | GREEN | RED | GREEN |
| nit-exclusion | `trident/gates/review-panel.ts:87` — `const actionable = verdicts.flatMap(v => v.findings).filter(() => true).map(findingIdentity)` | `trident/build-run.test.ts` / `G070 repeated nits` | GREEN | RED | GREEN |
| resume-history | `trident/build-run.ts:336` — `previousReview = undefined` | `trident/build-run.test.ts` / `G070 resumed fix` | GREEN | RED | GREEN |

### Final validation and delivery

- `bun test trident/build-run.test.ts trident/build-host.test.ts trident/gates/ trident/__tests__/escalation-gate.test.ts`: **255 pass, 0 fail, 1044 assertions**, 12 files. This includes every touched test and the kept certification for both addressed gates. No full-suite sweep was run.
- All 18 mutation compiles passed `bunx tsc --noEmit -p trident/tsconfig.json`; the final repository check `bash scripts/ci/typecheck-all.sh` reported **51 configurations checked, ALL PASS**.
- `bash scripts/ci/lint.sh`: exit 0.
- `bash scripts/ci/leak-gate.sh --tree .`: **INCOMPLETE**, zero findings from executed rules. `pii-denylist` and `pii-denylist-msg` could not run. Its six scanned commit-message lines precede this commit, so it does not certify this commit message. The changed-file restricted-text check passed on all nine files, and the chosen commit message was separately checked.
- `git diff --check`: green. The record has exactly one top-level `## ` heading. Changed files were enumerated using `git diff --name-only` and `git ls-files --others --exclude-standard`.
- The scope control `git diff --name-only -- trident/build-run.ts trident/inner-loop.ts trident/review-run.ts trident/inner-workflow.mjs gateway open` printed only `trident/build-run.ts`. The positive control establishes that the command can see this change; the protected implementations and directories have no diff in this change.
- Read `docs/process/work-tracking.md` before implementation and its as-built section before writing this record. Used the task's branch-specific destination, preserving earlier increments' records. Delivery is a local commit on `rebuild/review-structure-4`; the orchestrator owns review, push, and PR creation.
