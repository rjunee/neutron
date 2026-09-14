## #746 — one place asks the owner

### What changed

Added a source-enumeration guard at `trident/owner-question-path.test.ts:82`. It scans
production TypeScript under `trident/`, `gateway/`, `open/`, `runtime/` and
`agent-dispatch/` — excluding test files, `__tests__/` and comment lines — and asserts
that the enumerated asking boundary appears exactly once, at `trident/orchestrator.ts:5364`,
where a merge-conflict escalation's question becomes the terminal run reason.

The scan is IN-PROCESS. The first draft spawned `rg`, which is not on a stock GitHub
runner and is not on this build host either: the guard errored with
`Executable not found in $PATH: "rg"` on every run, so the recorded "30 passed" for it
was not obtainable. The repository already documents this hazard and its remedy at
`cores/free/code-gen/src/tool-handlers.ts:413`. A guard that cannot run is not a guard,
and one that fails for an environment reason teaches people to ignore it.

### Evidence and decisions

The vocabulary was derived from the existing path, not guessed. An ambiguous merge
carries its question in `TridentMergeConflictEscalation` (`trident/merge.ts:154`), thrown
at `trident/merge.ts:3647`, `:3671` and `:3904`. The orchestrator copies that question
into `failure_reason` (`trident/orchestrator.ts:5364`). Terminal delivery resolves the
run's recorded topic and sends that reason to the chat the run came from
(`trident/delivery.ts:1333-1353`). That assignment is the asking boundary.

The arbiter's `owner-only` outcome (`trident/arbiter.ts:226`) is NOT a second boundary.
It returns to its caller, which falls back to the same escalation
(`trident/merge.ts:3904`) — the behaviour its own type documents at
`trident/arbiter.ts:60`. It is therefore correctly outside the enumeration, and the
instrument control below pins that it stays outside for a reason and not by accident.

THE PATTERN IS BROADER THAN THE LINE IT WAS WRITTEN FROM, and that is the whole
difference between an enumeration and a tautology. It matches a question reaching a
terminal-reason constructor or delivery seam (`failedRun` / `failure_reason` /
`terminate` / `deliver*` with a `question` argument) OR any identifier in the
owner-asking vocabulary the filed issue names (`askOwner`, `askTheOwner`, `ownerQuestion`,
`owner_question`, `questionForOwner`, `needsOwner`, `promptOwner`). The first draft's
`failedRun\([^\n]*\.question` could match only a call shaped exactly like the one line
already in the tree; a second path spelled any other way was invisible to it, which is
demonstrated in the mutation table below.

A second test asserts the pattern against nine plausible second-path spellings that it
must catch and seven near-misses it must not. Without it, a pattern that had silently
narrowed to the one existing line would still pass the cardinality assertion, for ever.

No new error, verdict, state or refusal was introduced, so no outcome vocabulary needed
extension. No product decision changed; the acceptance criterion remains at
`docs/spec-items/the-orchestrator-owns-the-build-loop.md:48-50`.

### Mutation table

Each patch was printed with its landed line and its diff before the run.

| Direction | Mutation | Landed line | Result | Restored |
|---|---|---|---|---|
| A second path, same vocabulary | second `failedRun(doneRun, err.question, true)` bridge inserted | `trident/orchestrator.ts:5364` (block from `:5362`) | RED — expected length 1, received 2 | GREEN |
| A second path, DIFFERENT spelling and file | `export function askOwner(run, q)` added | `trident/board-reconcile.ts:33` | RED — expected length 1, received 2 | GREEN |
| No path at all | sanctioned question replaced with fixed text | `trident/orchestrator.ts:5364` | RED — expected length 1, received 0 | GREEN |
| Instrument control | — | `trident/owner-question-path.test.ts:97` | the first draft's pattern returns `false` for the `askOwner` spelling above; the shipped pattern returns `true` | — |

### Validation

- `bun test trident/owner-question-path.test.ts` — 2 passed, 0 failed, 18 assertions.
- `bun test trident/escalation-block.test.ts` — 29 passed, 0 failed. The protected file is
  byte-identical to `origin/main` (blob `22dc228b`); it was read, never edited.
- `bash scripts/ci/lint.sh` — exit 0.
- `bash scripts/ci/leak-gate.sh --tree .` from a clean clone — zero findings from the rules
  that ran, INCOMPLETE because the Tier-1 PII denylist is not available outside CI. The
  armed run is the `purity` job on the pull request.

### Deliberately not changed

`trident/escalation-block.test.ts` and `trident/inner-workflow.mjs` were not edited. The
runtime path was not moved or duplicated, and no feature flag or alternate route was
added. Comment lines are excluded from the scan: prose cannot ask anyone anything. This
slice establishes only the single-question-path criterion; it does not claim the other
acceptance boxes in `docs/spec-items/the-orchestrator-owns-the-build-loop.md` are
complete.
