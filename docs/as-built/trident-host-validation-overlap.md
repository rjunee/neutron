## 2026-09-28 — Overlap host suite execution with review readiness

This is a scheduling slice of #1196. The authority remains
`docs/spec-items/trident-build-efficiency.md:117-124`: independently admissible
work may overlap, while readiness and CI admission still precede paid review.
`docs/trident-gates-inventory.md:129`, `:134`, and `:139` require known
configuration and settled checks, including the deliberate admission of settled
red for review. G063–G065 at `:148-150` retain host suite evidence and failure
comparison requirements. This change does not alter CI workflows or close the
broader efficiency acceptance.

The driver at `trident/build-run.ts:1087` starts the existing readiness observer
and suite observer together after candidate publication. Both settle before any
return, exception propagation, or paid dispatch. Readiness retains precedence
over a suite refusal or exception. The later CI assessment, measured revision
check, review dispatch and post-review veto composition remain at
`trident/build-run.ts:1104-1128`.

Draining matters because `trident/project-build-host.ts:220-234` cleans up after
the driver returns. A fail-fast join could otherwise remove the worktree while
the suite still runs. Suite cancellation still uses the supplied signal and the
durable run row (`open/wiring/project-build.ts:345-354`), including cancellation
racing a zero exit (`trident/host-suite.ts:138-152`). The existing suite receipt
owner still invalidates before acquisition and atomically records completion
(`trident/project-suite-receipt.ts:122-155`). Overlap creates neither another
suite executor nor another recovery receipt.

Driver barriers at `trident/build-run.test.ts:2121` cover either completion
order, unknown observations, thrown observers, and readiness precedence when
both fail. Consuming barriers at
`open/__tests__/project-build-e2e.test.ts:4736` exercise real host composition,
suite receipt acquisition, cleanup and model transport. They require both host
checks to start before release, hold all review producers until admission, allow
green to merge with one suite invocation through publication, admit red to
review while retaining its veto, and refuse a changed suite input identity.

Focused validation on the change based on
`dcc92efcabdd85c7abf21cee481bcc9eeec4aad4`:

- `bun test trident/build-run.test.ts trident/gates/review-readiness.test.ts
  trident/gates/review-suite.test.ts trident/gates/review-ci.test.ts
  trident/project-suite-receipt.test.ts`: 462 passed, zero failed.
- `bun test open/__tests__/project-build-e2e.test.ts --test-name-pattern
  'consuming host admission overlaps|unavailable admission prevents|all-producer
  barrier|codegen_cancel stops the actual host suite|prepared host suite receipt
  survives reconstruction and handles (none|head|missing|corrupt|subset)
  inputs|same-round cached nonzero'`: 22 passed, zero failed, 398 filtered out.
  This includes the actual descendant-cancellation control, review vetoes,
  unchanged receipt reuse and changed/missing/corrupt/subset receipt refusal.
- Both `bunx --no-install tsc -p tsconfig.json --noEmit` and
  `bunx --no-install tsc -p trident/tsconfig.json --noEmit` passed.

Six temporary semantic mutations were rejected by those consuming barriers:
serializing host starts, returning before the sibling drains on an exception,
dispatching paid review before admission, dropping readiness refusal, treating
unknown suite evidence as known, and overblocking known proof. The last mutant
failed both the legitimate green and admissible-red controls. Failures were
behavioral assertions or the start barrier, never parsing errors. Restoring the
implementation passed the focused checks above.

Full consuming E2E, the canonical shared-host gate, independent review, exact-head
CI and deployed acceptance remain unverified for this candidate. Publication is
deferred until the active cutover acceptance allows a safe window. These focused
results are not a full-suite receipt. Supplied historical timestamps bound a
possible saving at zero to 10 minutes 5.016 seconds, assuming immediate suite
eligibility and unchanged runtime at the upper bound; no deployed saving has
been measured. Waiting for both owners may delay a readiness refusal until the
already-started suite finishes. Existing cancellation and suite wall bounds
remain the owners of interruption.
