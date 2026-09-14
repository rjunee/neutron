## 2026-09-14 — Inventory the existing Trident gates before replacing the loop

### Change and evidence

Added `docs/trident-gates-inventory.md`: 165 preservation entries, 18 unresolved test pins, and 156 conservatively classified silent-loss risks (`docs/trident-gates-inventory.md:3`). Each row names the requirement, enforcement source, existing test or NO TEST, and consequence of losing the boundary. The search ledger records actual counts and positive controls (`docs/trident-gates-inventory.md:13`); the independent terminal-vocabulary cross-check maps all 16 values (`docs/trident-gates-inventory.md:269`). The gate-preservation criterion is `docs/spec-items/the-orchestrator-owns-the-build-loop.md:56`; no acceptance checkbox is claimed complete.

### Decisions

Used grep vocabulary, control-flow, and prompt/shell indexes before reading matched neighborhoods, then cross-checked test declarations and outcome vocabularies. Marked partial happy-path pins as NO TEST rather than presenting them as refusal coverage. Included prompt requirements, advisory preflight, and an uncertain helper-only classifier, explicitly distinguishing them from hard refusal gates. Delegated proof, merge, cleanup, and board checks are represented at their call boundary and selected subgates; the document states the transitive and lexical limits (`docs/trident-gates-inventory.md:290`).

The implemented review cap is recorded as it exists, not replaced by a different policy (`trident/inner-workflow.mjs:8734`). Pre-existing suite evidence and red PR CI are distinct: the former can be advisory (`trident/inner-workflow.mjs:6449`), while the latter still holds rejection (`trident/inner-workflow.mjs:7537`).

The lane brief expressly requires this staging location, overriding the repository's usual direct permanent-shard location. This is the single as-built record for this documentation change.

### Validation and mutation table

| Guard changed | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| None — documentation-only inventory | Not applicable; no guard or test modified | Not run | Not applicable |

`bun run typecheck` reported that the script does not exist. The documented replacement, `bash scripts/ci/typecheck-all.sh`, passed all 51 configurations. `bash scripts/ci/lint.sh` passed. The focused command `bun test trident/review-round-cap.test.ts trident/inner-loop.test.ts trident/__tests__/escalation-gate.test.ts` passed 125 tests with 434 assertions and zero failures. These tests were unchanged; the full suite was not run. Existing pins in the inventory are not presented as newly mutation-certified coverage.

`bash scripts/ci/leak-gate.sh --tree .` exited 3: zero findings from the rules that ran, but the private denylist rules could not run. This is an incomplete purity check, not a clean pass; the publication lane must supply that private input. Citation targets, row counts, Markdown table shape, and whitespace were checked locally.

### Deliberately not done

No loop rewrite, move, deletion, feature flag, new runtime gate, new test, spec decision, acceptance-checkbox change, push, PR creation, or merge. This slice supplies the reviewable inventory for the later replacement lane. It does not claim the umbrella issue is complete.
