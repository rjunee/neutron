## Split the failure-salvage gates from the orchestrator

### What changed

Moved the worktree inspection and snapshot implementation into `trident/failure-salvage.ts`. The orchestrator now constructs that capture interface at `trident/orchestrator.ts:1611` and keeps its existing reconciliation order and failure strings. The inventory now points G128 and G129 at their new implementation locations at `docs/trident-gates-inventory.md:217` and `docs/trident-gates-inventory.md:218`.

`trident/orchestrator.ts` fell from 3,755 lines on `origin/main` to 3,424 lines. The new module is 343 lines. No behavior, refusal text, check ordering, or test fixture changed.

### Per-gate evidence

| Gate | Old location measured before move | New location | Existing coverage | Mutation result | Restored result |
|---|---|---|---|---|---|
| G128 | `trident/orchestrator.ts:1871`; ownership checks at `trident/orchestrator.ts:1885`, `trident/orchestrator.ts:1898`, `trident/orchestrator.ts:1899`, `trident/orchestrator.ts:1923` | `trident/failure-salvage.ts:268`; checks at `trident/failure-salvage.ts:282`, `trident/failure-salvage.ts:295`, `trident/failure-salvage.ts:296`, `trident/failure-salvage.ts:320` | `trident/stranded-salvage-realgit.test.ts:528`; `trident/stranded-salvage-realgit.test.ts:550` | Inverted the run-window check at `trident/failure-salvage.ts:316`; typecheck passed, suite RED: 9 pass / 11 fail | Suite GREEN: 20 pass / 0 fail / 128 assertions |
| G129 | `trident/orchestrator.ts:1726`; operation checks at `trident/orchestrator.ts:1767`, `trident/orchestrator.ts:1770`, `trident/orchestrator.ts:1773`, `trident/orchestrator.ts:1799`, `trident/orchestrator.ts:1812` | `trident/failure-salvage.ts:123`; checks at `trident/failure-salvage.ts:164`, `trident/failure-salvage.ts:167`, `trident/failure-salvage.ts:170`, `trident/failure-salvage.ts:196`, `trident/failure-salvage.ts:209` | `trident/stranded-salvage-realgit.test.ts:590`; `trident/stranded-salvage-realgit.test.ts:622` | Inverted ref-operation success at `trident/failure-salvage.ts:213`; typecheck passed, suite RED: 18 pass / 2 fail | Suite GREEN: 20 pass / 0 fail / 128 assertions |

The pre-move baseline was GREEN: 21 pass / 0 fail / 1,315 assertions across `trident/stranded-salvage-realgit.test.ts` and `trident/gates-inventory-citations.test.ts`. The same combined command after the move was GREEN with the same counts.

### Decisions and continuous enforcement

The extraction boundary is the complete worktree capture path: failed-operation shaping, snapshot measurement, durable-ref reconstruction, private-index snapshot creation, stash inspection, and attributable-worktree selection. The outer reconciliation stays in place so publication and failure-row composition remain in their original order. The continuous mechanisms are the real-git suite at `trident/stranded-salvage-realgit.test.ts:288` and inventory citation resolution at `trident/gates-inventory-citations.test.ts:8`; capture reads git state through the injected host runner and does not depend on the failed workflow remaining alive.

No new error, verdict, state, or refusal was introduced, so no existing outcome vocabulary required a new member or default classification.

### Source-scanner sweep

Enumeration used the same repository-wide expression for `readFileSync`, `Bun.file`, and `new URL` combined with `orchestrator.ts`. Its positive control found all three readers below; the equivalent expression for `failure-salvage.ts` found none.

| Scanner | Subject | Measured marker count, orchestrator → new module | Action |
|---|---|---:|---|
| `gateway/__tests__/trident-active-runs-wiring.test.ts:63` | workflow fire receives `test_strategy` | `listNonTerminal`: 3 → 0 | None; subject did not move. |
| `gateway/__tests__/trident-phase-models-producer.test.ts:153` | workflow fire receives phase models | `isTridentHarvestTerminal`: 2 → 0 | None; subject did not move. |
| `trident/mutation-prover.test.ts:59` | durable stage-reason ceiling | `STAGE_REASON_CEILING`: 3 → 0 | None; subject did not move. |

No hard-coded count, file list, or negative assertion covered a moved salvage marker.

### Comment preservation and validation

The prescribed removed-comment comparison enumerated 30 distinct `//` lines removed from `trident/orchestrator.ts`; `comm -23` against the combined current sources was empty. All moved rationale remains in `trident/failure-salvage.ts`, including the ownership argument at `trident/failure-salvage.ts:292` and durable-ref argument at `trident/failure-salvage.ts:214`.

Validated with:

- `bun test trident/stranded-salvage-realgit.test.ts trident/gates-inventory-citations.test.ts` — 21 pass / 0 fail / 1,315 assertions.
- `bunx tsc -p trident/tsconfig.json --noEmit` — green.
- `git diff --check` — green.

### Deliberately not changed

Did not rename, reorder, simplify, or clean up moved code or comments. Did not edit tests, product specification, publication code, launch preparation, inner-loop files, wiring, or persistent runtime adapters. The factory-body indentation remains mechanically moved rather than reformatted so this commit stays a reviewable relocation.
