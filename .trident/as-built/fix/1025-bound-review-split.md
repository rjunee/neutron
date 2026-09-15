## 2026-09-15 — Split the bound-review cluster

### What changed

Moved G011's terminal review-verdict classifier from `trident/orchestrator.ts:937-990` at the pre-move baseline to `trident/bound-review.ts:42-95`, preserving the public re-export at `trident/orchestrator.ts:108-109`. Moved the review-only dispatch branch from `trident/orchestrator.ts:1912-2019` at baseline to `trident/bound-review.ts:112-231`; `launch` delegates before its build stamp at `trident/orchestrator.ts:1822-1841`. The inventory now cites the owning module at `docs/trident-gates-inventory.md:75`, `docs/trident-gates-inventory.md:83`, and `docs/trident-gates-inventory.md:268`.

No new outcome joined a taxonomy: the move retains the existing `AdvanceOutcome` vocabulary imported at `trident/bound-review.ts:12`, and the caller continues to consume that outcome at `trident/orchestrator.ts:1836`. G011 continues to classify unsupported rejection evidence as `REVIEW_NOT_RUN` at `trident/bound-review.ts:46-49` and `trident/bound-review.ts:94`; G019 returns the existing failed outcome at `trident/bound-review.ts:163-175`; G164 keeps the existing verdict demotion at `trident/bound-review.ts:198-201`.

### Gate evidence and mutations

Baseline before the move was 44 pass, 0 fail, and 1406 assertions from `trident/escalation-block.test.ts`, `trident/review-run.test.ts`, and `trident/gates-inventory-citations.test.ts`.

| Gate | Old line | New line | Covering test | Refusal mutation | Red | Restored |
| --- | --- | --- | --- | --- | --- | --- |
| G011 | `trident/orchestrator.ts:937-990` | `trident/bound-review.ts:42-95` | `trident/escalation-block.test.ts:314-319` | `:49` disabled the Argus-provenance refusal | 28 pass, 1 fail, 107 assertions | 29 pass, 0 fail, 107 assertions |
| G019 | `trident/orchestrator.ts:1912-1965` | `trident/bound-review.ts:122-175` | `trident/review-run.test.ts:492-521` | `:163` returned `null` on review failure, allowing build fallthrough | 13 pass, 1 fail, 108 assertions | 14 pass, 0 fail, 112 assertions |
| G164 | `trident/orchestrator.ts:1988-1991` | `trident/bound-review.ts:198-201` | `trident/review-run.test.ts:425-460` | `:199` disabled the findings-free rejection demotion | 13 pass, 1 fail, 112 assertions | 14 pass, 0 fail, 112 assertions |

Every mutation compiled before its test ran. G011's hostile shape is a rejection with no Argus checkpoint: it remains `REVIEW_NOT_RUN` at `trident/bound-review.ts:49`. G019's hostile shape is a failed review executor: it returns failed at `trident/bound-review.ts:163-175` before the build stamp at `trident/orchestrator.ts:1837-1841`. G164's hostile shape is `REQUEST_CHANGES` with no findings: it records `REVIEW_NOT_RUN` at `trident/bound-review.ts:198-201` while a real findings-bearing rejection remains unchanged in `trident/review-run.test.ts:462-490`.

### Source scanners and comments

Enumerated explicit source readers with an `rg -l -U` search pairing `readFileSync`, `Bun.file`, or `new URL` with `orchestrator.ts`, then inspected dynamic file-list readers. The readers whose subjects remain in the old module are: `trident/mutation-prover.test.ts:56-59` (`STAGE_REASON_CEILING`, counts 3/0), `trident/orchestrator.test.ts:1578-1589` (`resolveClaimedCommit`, 3/0), `gateway/__tests__/trident-phase-models-producer.test.ts:151-157` (ordinary workflow phase models, 1/0), `gateway/__tests__/trident-active-runs-wiring.test.ts:61-67` (ordinary workflow test strategy, 1/0), `trident/run-head-width.test.ts:9-18` (three selected recognizers, 3/0), `trident/diff-base-option-shaped.test.ts:869-899` and `trident/diff-base-option-shaped.test.ts:1110-1139` (two `gitRangeArgv` calls, 2/0), and the recursive owner-question scanner at `trident/owner-question-path.test.ts:35-90` (sanctioned boundary, 1/0). Counts are `trident/orchestrator.ts` / `trident/bound-review.ts`; each nonzero old-module count is the positive control. No scanner subject moved, so no source-reader assertion was widened or reduced. The six explicit scanner suites ran 848 pass, 0 fail, and 3652 assertions.

The prescribed removed-comment comparison found 65 distinct removed `//` lines and `comm -23` returned no output against the union of `trident/orchestrator.ts` and `trident/bound-review.ts`. No rationale line was lost.

### Merge-boundary audit

For G104, a claimed approval without the row's Argus checkpoint is failed and cannot merge; the attacker-shaped case is exercised at `trident/orchestrator.test.ts:4333-4350`. For G105, an approval with a failed or absent mutation proof is failed and cannot merge; the refusal and no-merge assertions are at `trident/orchestrator.test.ts:1229-1248`. For G106, the legacy orchestrator reads a committed nomination through `readCommittedMutationClaim` at `trident/orchestrator.ts:2578`, whose revision-pinned argv is tested at `trident/mutation-claim-artifact.test.ts:150-178`.

The newer build-host seam is wired, not absent: `trident/build-host.ts:195-198` invokes `options.mutation.readClaim(snapshot)`, and composition supplies it at `open/wiring/project-build.ts:136-140`, with a wiring test at `open/__tests__/project-build-wiring.test.ts:68-73`. That producer reads the build worker result rather than the reviewed commit. This is an existing G106 parity finding outside this move; changing it would require touching an explicitly excluded module and would not be a behavior-preserving split.

### Validation and deliberately unchanged work

After restoration, `bunx tsc -p trident/tsconfig.json --noEmit` passed. The required three suites returned the same 44 pass, 0 fail, and 1406 assertions as baseline. No test was edited.

Did not alter refusal strings, conditional order, review behavior, `SPEC.md`, previously extracted modules, build-host code, runtime code, or composition wiring. Did not address the G106 parity finding, clean up comments, rename types, or make adjacent improvements.
