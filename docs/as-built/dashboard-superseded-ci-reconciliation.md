## 2026-10-06 — Reconcile observed superseded CI checks

Replacing a PR head previously removed an unfinished check from collection:
readiness sampling queried only the current commit. Its recorded missing end
could therefore keep extending after the provider had cancelled the old check.
The collector now reads latest observations from the existing journal and
reconciles only already observed unfinished superseded GitHub check identities
(`scripts/build-timeline-sources.ts:354`, `:622`). It does not enumerate past
heads or infer a completion from PR lifecycle or another check's outcome.

Each refresh attempts at most 20 historical checks within 15 seconds, oldest
observation first. Both successful and unsuccessful attempts append new snapshots
under the existing journal mutex; persisting attempt clocks makes the finite
queue fair across restarts without another tracking store
(`scripts/build-timeline-sources.ts:365`, `:566`). A missing/failed/foreign response
keeps the prior start and unknown end. Exact provider ID, head, repository URL,
explicit completed status, conclusion and valid start/end clocks are required
for closure (`scripts/build-timeline-sources.ts:377`). Closed checks leave the
historical queue; historical sampling does not modify current-head readiness.
Earlier journal events and the existing immutable phase ownership remain intact.

Validation: 57 catalogue, recorder, authenticated server and timeline consuming
tests passed, with 685 assertions. Tests cover actual cancelled completion after
a push, still-running/missing/foreign/error evidence, persisted retry fairness,
lookup count/deadline bounds, terminal retirement, unchanged journal history,
unknown usage and stable authenticated API duration across later reads. Removing
the provider head guard made the foreign-head refusal assertion fail; denying
valid historical completion made the recorded completion assertion fail. Both
mutants were restored before the passing consuming run. Root and Trident
TypeScript checks and scoped ESLint passed.

Dependencies were copied into a worktree-local install from an existing tree
with the identical lockfile and unchanged package manifests. The dependency
verifier passed with 30/32 resolution probes and two SDK resolution notes;
this was not a new frozen installation. The required shared-host gate, final CI,
independent review and served operational proof remain integration/release
requirements. No publication, deployment or runtime write occurred in this change.
