## 2026-09-28 — Preserve the completed build after a settled review rate limit

This is the producer-side continuity slice of #1358. A required review seat can
settle with a rate-limit refusal after the standalone reviewer and all other
seats finish. The host previously retained its pending review reservation, so
ordinary cross-run retry refused the completed build at
`trident/build-mode-state.ts:124` and could repeat planning and building.

The panel now carries a host settlement observation only when every enabled
seat has exact run/head/round/provider/model provenance and either a valid
completed verdict or a rate-limit refusal (`trident/gates/review-panel.ts:99`).
It waits for every sibling and refuses this proof for active, unknown, missing,
malformed, deferred or wrong-scope observations. The rate-limit result still
blocks merge and never authorizes approval or synthesis.

After validating the completed standalone review envelope, verdict and unchanged
measurement, the driver clears only the pending reservation
(`trident/build-run.ts:761`). The existing completed checkpoint, round, previous
review baseline, strategy and iteration spend survive. Existing cross-run source
validation then carries the build into a new run whose reviews and publication
gates execute under its own identity.

The paired producer and consumer controls are in
`trident/gates/review-panel.test.ts:28` and `trident/build-run.test.ts:128`.
The production consuming regression at
`open/__tests__/project-build-e2e.test.ts:2508` drives a real headless transport
fixture through the rate-limit stop, normal host cleanup, board redispatch and
merge. It asserts the exact completed head is reviewed without another planner,
builder or fixer. Its transport-error sibling retains pending uncertainty.

Historical terminal runs with pending review state are not rewritten or newly
admitted by this change. Their recovery still requires original-request and
complete panel evidence reconciliation before an import can release pending
authority. This PR does not close #1358 or claim recovery of the live published
PR. No live database row, worker receipt, dispatch or PR merge was changed.

Verification: root and Trident TypeScript checks passed. Independent review ran
403 complete driver/panel tests and the three consuming rate-limit/transport
cases. Four executed semantic mutations went RED: omitting head provenance,
omitting round provenance, accepting malformed sibling results, and refusing
valid settlement. The candidate retains the repository's validated-envelope
completion contract; it does not claim operating-system process quiescence.
The added-content privacy preflight passed. The full-tree privacy scan reports
existing denylist findings and the linked worktree's metadata pointer; it is
not recorded as clean. Complete focused and coordinated full-gate results are
reported with the PR.
