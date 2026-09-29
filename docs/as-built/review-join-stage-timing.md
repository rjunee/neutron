## 2026-09-29 — Measure the admitted review producer join

The project host previously timed `reviewGate`, which consumes the completed
review observation after `work('review')` has already joined the standalone
reviewer, panel seats, and synthesis. That boundary could report a negligible
`review-and-synthesis` interval for substantial producer work (baseline
`ce606cb30b1c02a6116709883e44b94b4e4ee17c`,
`trident/project-build-host.ts:213`, `trident/build-run.ts:1132`). This repair
implements the attributable wall-time requirement in
`docs/spec-items/trident-build-efficiency.md:100` without changing the phase
usage storage contract in `docs/spec-items/trident-phase-accounting.md:11`.

The driver now offers the admitted producer join to the existing accounting
interval through a host observation callback (`trident/build-run.ts:229`,
`:704`, `:727`). Preparation, artifact validation, and the pending checkpoint
precede that boundary (`:688`). Both independent producers still settle before
an error propagates, and recovery reconciles the original worker before panel
observation (`:707`, `:717`). The project host binds the single interval to
`AttemptAccounting.interval`, retaining run, task, measured head, round, and
original step identity (`trident/project-build-host.ts:213`). Subsequent CI and
verdict consumption are outside this interval. Recovery observes its current
reconciliation interval; it does not reconstruct unobserved time before restart.

The consuming test uses producer barriers and a controlled clock through the
real project composition (`open/__tests__/project-build-e2e.test.ts:2411`). It
proves the stage starts before every producer, synthesis follows both seats,
and the stage remains open until either a delayed standalone reviewer or delayed
synthesis finishes. A thrown standalone result retains the failure and closes
the interval. The observed wall interval is exactly 70 scripted milliseconds,
while overlapping attempt durations sum to more than 70 (`:2503`). Four refused
admission controls dispatch no reviewers and create no review interval
(`:5200`). The existing original-reservation recovery tests now assert timing
identity and settlement (`trident/build-run.test.ts:1388`); a failing stage sink
cannot replace the result or error or invoke the operation twice
(`trident/project-build-host.test.ts:102`).

Validation on this change over the baseline above, after restoring all mutants:

- `bun test trident/build-run.test.ts trident/project-build-host.test.ts`:
  exit 0, 464 passed, 2,326 assertions.
- `bun test open/__tests__/project-build-e2e.test.ts --test-name-pattern 'review stage measures the admitted producer join wall interval|unavailable admission prevents every review producer|attempt accounting consumes a full build'`:
  exit 0, 8 passed, 145 assertions. This is a consuming subset, not a whole-file
  or repository-suite receipt.
- `bun node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` and
  `bun node_modules/typescript/bin/tsc --noEmit -p trident/tsconfig.json`:
  both exit 0.
- Three temporary, valid-code mutations each exited 1 with one failed consuming
  test: restore the obsolete final-verdict timer; move timing outside artifact
  admission; refuse every timed operation. The restored controls above pass.

Validation invocation census: one frozen, script-free dependency install; one
workspace dependency verification and one explicit workspace/TypeScript
resolution control, all exit 0. Three focused-test invocations exited 0
(463, then 464, then 464 passed). Five positive consuming invocations included
one namespace sandbox refusal (exit 3), one fixture-selector failure (exit 1,
4 passed / 3 failed), and three passes (7, 8, 8 passed). The fixture correction
distinguished standalone requests from panel requests by the existing verdict
schema. Three additional consuming invocations were the expected mutation
failures. Root and Trident typechecks each ran twice and passed. Required process
isolation was retained for the consuming tests. Full combined validation,
independent review, publication, and served-runtime verification belong to the
integrating change; this record does not claim them.
