## Merge-approval cluster split

### What changed

Moved G104–G106 from `trident/orchestrator.ts` into `trident/merge-approval.ts`; `applyMergeApproval` is invoked from `trident/orchestrator.ts:2779`. The gate anchors are `trident/merge-approval.ts:37`, `:106`, and `:97` respectively. The inventory citations now name the moved implementation and covering tests in `docs/trident-gates-inventory.md:193`.

### Baseline and validation

Before and after the move, `bun test trident/orchestrator.test.ts trident/mutation-prover.test.ts trident/mutation-claim-artifact.test.ts trident/gates-inventory-citations.test.ts` reported 583 pass and 0 fail. `bunx tsc -p trident/tsconfig.json --noEmit` passed.

### Mutation proof

| Gate | New line | Refusal mutation | Covering test | Result |
| --- | --- | --- | --- | --- |
| G104 | `trident/merge-approval.ts:242` | Replaced the refusal condition with `false` | `trident/orchestrator.test.ts:4334` | 0 pass, 1 fail; restored and full suite green |
| G105 | `trident/merge-approval.ts:148` | Replaced `!proof.ok` with `false` | `trident/orchestrator.test.ts:1233` | 0 pass, 1 fail; restored and full suite green |
| G106 | `trident/merge-approval.ts:97` | Disabled committed-nomination fallback | `trident/orchestrator.test.ts:3584` | 0 pass, 1 fail; restored and full suite green |

### Source scanners and comments

Enumerated `orchestrator.ts` source readers with `rg -n "readFileSync\\(new URL\\('./orchestrator\\.ts'" trident .github scripts`; the positive hit is `trident/mutation-prover.test.ts:59`. Its `STAGE_REASON_CEILING` marker remains in `trident/orchestrator.ts`, so `grep -c 'STAGE_REASON_CEILING' trident/orchestrator.ts trident/merge-approval.ts` measured 2 and 1; its subject did not move and no change was needed. The prescribed removed-comment comparison was empty.

### Deliberately not changed

Did not wire or alter the build-host seam: `trident/build-host.ts:175-176` already reads the claim before its publication gate. Did not alter tests, refusal strings, check ordering, or prohibited paths.
