## 2026-09-23 — Join standalone review and panel observations concurrently

The authority is `docs/spec-items/trident-build-efficiency.md:117-138`:
“Launch every independently admissible verdict producer, including standalone
review and panel seats, without waiting for another producer's verdict.” The
same criterion requires the consuming barrier to include standalone review and
panel seats, preserve both vetoes, and prevent dispatch when admission is
unavailable. `docs/trident-gates-inventory.md:131-136` preserves G057–G062:
required observations, bounded deferred retries, usable synthesis, severity
handling, and removal of model-supplied reserved markers.

The outer driver previously waited for standalone review before entering the
panel gate. Concurrent panel reads alone could not remove that barrier.
`trident/gates/review-panel.ts:75` now observes and validates the panel separately
from `decideReviewPanel` at line 118. The decision combines the standalone
verdict with every validated panel verdict and synthesis exactly once. Its
observation is tied to run, snapshot and round. The existing project source's
keyed promises retain one dispatch per seat/synthesis observation; composition
does not ask any producer to run again.

`trident/build-host.ts:221-223` supplies the required observation and decision
seams. `trident/build-run.ts:404-426` starts standalone review and panel
observation together only after materializing and checking the review artifact;
readiness, suite and CI admission already precede that call. Both producers are
drained even when one rejects. The existing measured revision check and the
post-review CI assessment run after the join, before final gate composition.
No model verdict replaces host readiness or authorizes a different revision.

Verification uses `trident/build-run.test.ts`, `trident/build-host.test.ts`,
`trident/project-build-host.test.ts`, `trident/project-review-source.test.ts`,
`trident/gates/review-panel.test.ts`, `trident/gates/local-merge.test.ts`,
`trident/production-host-effects.test.ts`, and explicitly
`open/__tests__/project-build-e2e.test.ts`. The consuming fixture uses the real
session ownership queue and transcript-bound children; only model execution is
held at a barrier. All three independent producers must start before release.
Controls cover standalone and synthesis vetoes, missing seats, unavailable
readiness/CI/artifacts, sibling draining, changed revision/CI, and one synthesis.

Semantic mutations were killed for serializing the standalone producer,
bypassing artifact refusal, returning before a live sibling drains, bypassing
observation identity, refusing the matching observation, dropping standalone's
veto, dropping synthesis's veto, and bypassing the missing-observation-host
refusal. Each mutation failed a behavioral assertion
or barrier rather than parsing; restored focused tests passed. Serialization was
also mutated in the consuming barrier itself, which failed with only standalone
review having reached the barrier. Consuming veto controls assert the unresolved
verdict reason as well as refusal: a fallback checkpoint refusal cannot hide a
dropped synthesis veto. The over-refusal controls include an equal PR
whose object keys appear in a different order.

After rebasing onto canonical main `b6d2410e7`, the focused eight-file suite
passed 485 tests, including missing-observation-host refusal and its valid-host
control. Both TypeScript projects and scoped ESLint passed. The
full consuming E2E suite passed 132 tests, including all seven new
barrier/admission cases. The same barrier failed on the old session lock, naming
only the standalone producer. An earlier local integration with the exact
session concurrency prerequisite also passed; its temporary merge was removed,
and publication history contains only this change above canonical main.
This measures local composition, not deployed latency.

Exact base/head archive leak scans each reported the same 455 inherited
findings; their normalized output differed only in the number of candidate
files. The changed-file export with a known-present `LICENSE` control and the
commit/PR text scans were silent. The full-tree baseline remains red; the
denylist and gate were not weakened.

This implements one part of the efficiency specification. It does not establish
deployed performance, complete usage accounting or cutover acceptance, and does
not close the P0 efficiency issue.
