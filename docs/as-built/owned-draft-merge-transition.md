## 2026-09-21 — Ready the owned draft before the pinned merge

The host merge effect previously called `gh pr merge` directly, which cannot
merge a draft. The governing acceptance remains a dispatched card reaching
MERGED without human intervention
(`docs/spec-items/the-orchestrator-owns-the-build-loop.md:64`). This change adds
the missing transition within the existing driver ordering: independent review,
host suite, publication proof and merge gates precede the effect
(`trident/build-run.ts:651`, `trident/build-run.ts:678`).

The effect requires the bound run's `pr` and creation-receipt `published_pr` to
identify the exact observed PR. Branch, base, repository, state and reviewed head
remain checked. Only that owned draft is marked ready; an already-ready PR skips
the ready command. The host rereads ownership and PR state after the transition,
refreshes drift and CI, then remeasures immediately before issuing the existing
`--match-head-commit` merge (`trident/production-host-effects.ts:436`). Unknown
draft state, changed pins and incomplete checks refuse the merge. A final exact
MERGED witness can resolve even a timed-out merge response; an uncertain write
is never retried blindly (`trident/production-host-effects.ts:488`). Command
diagnostics use bounded reason categories and exit status rather than relaying
remote output.

The direct host suite exercises owned and foreign drafts, changes during ready,
unreadable draft state, incomplete CI, sanitized diagnostics and timeout witnesses.
The consuming Open harness makes its fake GitHub reject draft merges and runs the
real driver to MERGED after ready. Its review, suite and CI failure controls leave
the draft untouched (`open/__tests__/project-build-e2e.test.ts:1537`).

Measured checks: `bun test trident/production-host-effects.test.ts` passed 103
tests; both `tsc --noEmit -p tsconfig.json` and
`tsc --noEmit -p trident/tsconfig.json` passed. The full
`open/__tests__/project-build-e2e.test.ts` passed 108 tests with local socket
access enabled; a sandboxed attempt passed 99 and failed nine on socket-listen
EPERM. The four draft cases also passed after tightening the negative controls
to require an actual open draft.

Four semantic mutations proved both directions. Removing publication provenance
failed both foreign-draft tests while owned controls passed; rejecting every
provenance failed the two owned controls while foreign refusals passed. Skipping
ready failed the owned-draft success while already-ready and foreign controls
passed; always readying failed the already-ready no-write assertion while the
owned draft passed. Each mutant exited red through assertions. Restoring the
exact source bytes restored all four selected controls to green.

The ready API has no expected-head precondition, so a concurrent head change can
occur during ready; subsequent observations refuse its merge. The remote base
also has no atomic merge precondition, and the existing persisted base-risk event
remains. These offline tests do not establish the live acceptance criterion, and
this change does not mark that criterion complete.
