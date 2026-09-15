## 2026-09-15 — Restore G030 branch-brief byte cap

### What changed

`trident/gates/result-contract.ts:51` restores the 4,096-byte budget and
`trident/gates/result-contract.ts:178` ports the historical whole-code-point
UTF-8 clamp, including its truncation marker. `trident/build-run.ts:372` applies
that clamp to every planner payload before the payload is assigned to
`previousPayload`, so `trident/build-run.ts:283` can only prepare the builder
with bounded branch-brief data.

### Pre-rebuild comparison

The prior implementation used the same byte-width loop and marker at
`trident/inner-workflow.mjs:2094`; the historical budget is declared at
`trident/inner-workflow.mjs:1971`. Before this change, the rebuilt contract had
only the optional field at `trident/gates/result-contract.ts:48` and its schema
entry at `trident/gates/result-contract.ts:165`, while the driver assigned the
raw result payload at `trident/build-run.ts:371`.

### Decisions

The clamp deliberately changes only string `branchBrief` values; other plan
fields and null briefs pass through unchanged at `trident/gates/result-contract.ts:201`.
Delimiter neutralisation was not reintroduced: the builder context is passed as
the `previous` value at `trident/build-run.ts:283`, and the production context
writer serializes that context as JSON at `trident/production-host-effects.ts:440`
rather than interpolating a raw branch-brief fence. The restored cap therefore
covers G030's remaining context-size boundary without creating a second
delimiter-handling path.

### Tests and mutation evidence

`trident/gates/result-contract.test.ts:27` supplies a brief whose UTF-16 length
is within the budget while its UTF-8 byte width is 4,097. It asserts the capped
result is exactly 4,096 bytes, retains no surrogate fragment, and contains the
historical marker. `trident/build-run.test.ts:305` asserts the builder receives
that bounded value. `trident/gates-inventory-citations.test.ts:8` checks the
updated G030 citations.

| Guard | Mutation | Result |
| --- | --- | --- |
| `trident/gates/result-contract.ts:183` | Changed `bytes <= BRANCH_BRIEF_MAX_BYTES` to `bytes > BRANCH_BRIEF_MAX_BYTES` | `bun test trident/gates/result-contract.test.ts` red: expected 4,096 bytes, received 4,097. |
| Restored `trident/gates/result-contract.ts:183` | Original comparison restored | Focused tests green: 188 passing, 0 failing. |

### Deliberately not changed

No delimiter rewriting was added, no other schema field was capped, and no
orchestrator, open, or runtime file was modified. No `SPEC.md` decision changed.
