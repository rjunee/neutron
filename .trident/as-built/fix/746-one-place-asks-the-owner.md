## #746 — one place asks the owner

### What changed

Added a source-enumeration guard at `trident/owner-question-path.test.ts:19`. It runs one
`rg` invocation over production TypeScript in `trident/`, `gateway/`, `open/`, `runtime/`
and `agent-dispatch/`, excluding test files and test directories
(`trident/owner-question-path.test.ts:20-35`). The pattern is
`failedRun\([^\n]*\.question` (`trident/owner-question-path.test.ts:16`). Its one match is
the sanctioned bridge at `trident/orchestrator.ts:5364`, where a merge-conflict
escalation's question becomes the terminal run reason.

The same assertion supplies the positive control and the cardinality guard: it expects
the exact sanctioned source shape, so zero matches and more than one match both fail
(`trident/owner-question-path.test.ts:41-45`). This test is the continuous maintainer of
the invariant; CI reads production source directly and does not depend on the asking path
executing successfully.

### Evidence and decisions

The vocabulary was derived from the existing path rather than guessed. An ambiguous
merge carries its question in `TridentMergeConflictEscalation`
(`trident/merge.ts:147-157`). The orchestrator copies that question into
`failure_reason` (`trident/orchestrator.ts:5359-5367`). Terminal delivery resolves the
run's recorded topic, composes the terminal message, and sends it through the outbound
sink (`trident/delivery.ts:1333-1353`). That question-to-terminal-reason assignment is
therefore the asking boundary the guard enumerates.

The scope is the five directories required by the filed criterion, enumerated explicitly
in `SCOPES` (`trident/owner-question-path.test.ts:17`). The match count on the restored
tree is exactly one. The known sanctioned match is the control for the same invocation,
not a separate search.

No new error, verdict, state, or refusal was introduced, so no outcome vocabulary needed
extension. No product decision changed; the existing acceptance criterion remains at
`docs/spec-items/the-orchestrator-owns-the-build-loop.md:48-50`.

### Mutation table

| Guard | Mutation | Mutated line | Result | Restored result |
|---|---|---:|---|---|
| Exactly one asking boundary | Added a second `failedRun(doneRun, err.question, true)` bridge | `trident/orchestrator.ts:5363` | RED: received two matches | GREEN: one match |
| Sanctioned boundary exists | Replaced the sanctioned question with fixed non-question text | `trident/orchestrator.ts:5364` | RED: received zero matches | GREEN: one match |

### Validation

- `bun test trident/owner-question-path.test.ts trident/escalation-block.test.ts` — 30
  passed, 0 failed. The protected file was run unmodified.
- `bunx eslint trident/owner-question-path.test.ts` — passed.
- `bash scripts/ci/typecheck-all.sh` — all 51 TypeScript configurations passed.
- `bash scripts/ci/leak-gate.sh --tree .` — zero findings from the rules that ran;
  incomplete because the external PII denylist was unavailable in this build context.

### Deliberately not changed

`trident/escalation-block.test.ts` and `trident/inner-workflow.mjs` were not edited. The
runtime path was not moved or duplicated, and no feature flag or alternate route was
added. This slice establishes only the single-question-path criterion; it does not claim
the other acceptance boxes in `docs/spec-items/the-orchestrator-owns-the-build-loop.md`
are complete.
