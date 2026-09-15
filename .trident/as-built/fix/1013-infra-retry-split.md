## 2026-09-15 — Split the infrastructure-retry cluster

### What changed

Moved G080–G082 into `trident/infrastructure-retry.ts`: the retry schedule is at
`:5-12`, the measured failure classifier is at `:34-64`, and the durable budget,
backoff, and atomic-claim branch is at `:89-139`. `trident/orchestrator.ts:1-13`
imports the implementation and preserves the former exports; its harvest path
delegates at `:2675-2679`. The inventory points to the new owning lines at
`docs/trident-gates-inventory.md:159-161`.

The dispatch order and refusal strings are preserved in the moved branch. The
only test addition is the lost-claim fixture at `trident/infra-retry.test.ts:307-319`;
it supplies a null atomic claim and proves the already-fired workflow count stays
one. Existing coverage is otherwise unchanged.

### Measurements

Baseline before the move: `bun test trident/infra-retry.test.ts trident/store.test.ts
trident/gates-inventory-citations.test.ts` reported 163 pass, 0 fail, and 1691
expectations. After the move and G082 fixture: 164 pass, 0 fail, and 1694
expectations. `bunx tsc -p trident/tsconfig.json --noEmit` passed.

| Gate | Old line | New line | Covering test | Mutation result |
| --- | --- | --- | --- | --- |
| G080 | `trident/orchestrator.ts:943-957` | `trident/infrastructure-retry.ts:46-64` | `trident/infra-retry.test.ts:111-122` | `:49` APPROVE→infrastructure: 0 pass, 1 fail; restored: green |
| G081 | `trident/orchestrator.ts:2727-2755` | `trident/infrastructure-retry.ts:92-120` | `trident/infra-retry.test.ts:207-235` | `:93` `>=`→`>`: 0 pass, 1 fail; restored: green |
| G082 | `trident/orchestrator.ts:2749-2751` | `trident/infrastructure-retry.ts:114-116` | `trident/infra-retry.test.ts:307-319` | `:116` lost-claim outcome→null: 0 pass, 1 fail; restored: green |

### Source scanners and comments

Enumerated source scanners with `rg -l -U` for `readFileSync`, `Bun.file`, or
`new URL` paired with `orchestrator.ts`, then inspected dynamic file-list readers.
No scanner's subject moved: phase-model marker counts are 1/0 in
`gateway/__tests__/trident-phase-models-producer.test.ts:151-158`; test-strategy
counts are 1/0 in `gateway/__tests__/trident-active-runs-wiring.test.ts:61-68`;
stage-reason ceiling counts are 1/0 in `trident/mutation-prover.test.ts:56-59`;
claim-resolution marker counts are 3/0 in `trident/orchestrator.test.ts:1585-1589`;
head-width recognizer marker counts are 1/0 in `trident/run-head-width.test.ts:14-18`;
and the diff-base source lists continue to inspect only their listed git-range
call sites at `trident/diff-base-option-shaped.test.ts:1119-1139`. The paired
counts are `trident/orchestrator.ts` / `trident/infrastructure-retry.ts`; each
positive old-file count establishes that the scanner still has its subject.

The prescribed comment comparison was empty: seven unique removed `//` lines
were all present in the union of `trident/orchestrator.ts` and
`trident/infrastructure-retry.ts`.

### Deliberately not changed

Did not change retry behavior, refusal text, conditional order, adjacent
publication retry handling, or any out-of-scope module. No product or `SPEC.md`
decision changed.
