## 2026-10-06 — Reconcile observed superseded CI checks

Replacing a PR head previously removed an unfinished check from collection:
readiness sampling queried only the current commit. Its recorded missing end
could therefore keep extending after the provider had cancelled the old check.
The collector now reads latest observations from the existing journal and
reconciles only already observed unfinished superseded GitHub check identities
(`scripts/build-timeline-sources.ts:396`, `:677`). It does not enumerate past
heads or infer a completion from PR lifecycle or another check's outcome.

Each refresh attempts at most 20 historical checks within 15 seconds, oldest
eligible attempt first. The existing catalogue persists validated retry metadata
for known unfinished identities, independently of provider observation clocks.
Missing/failed/foreign evidence backs off from one minute to a one-hour maximum;
pending checks wait one minute. Neither failed nor unchanged polling appends phase
events. Actual changed timing appends under the existing journal mutex, while
unresolved evidence keeps its prior start and unknown end. Retry metadata retires
when completion is observed; no unresolved phase evidence is deleted.
Exact provider ID, head, repository URL,
explicit completed status, conclusion and valid start/end clocks are required
for closure. GitHub repository check URLs and Actions run/job URLs are accepted,
with case-insensitive repository identity and matching stored evidence URLs.
Malformed durable retry entries cannot postpone polling
(`scripts/build-timeline-sources.ts:258`, `:269`, `:408`). Closed checks leave the
historical queue; historical sampling does not modify current-head readiness.
Earlier journal events and the existing immutable phase ownership remain intact.

Validation: 62 catalogue, recorder, authenticated server, timeline and HTML tests
passed in two focused invocations, with 2,181 assertions. Tests cover actual
cancelled completion after a push, valid check/Actions URL forms and repository
case, still-running/missing/foreign/error evidence, persisted retry fairness,
malformed retry metadata, lookup count/deadline bounds, terminal retirement,
unchanged journal history, unknown usage and stable authenticated API duration.
A simulated day of unavailable checks made 29 attempts with byte-identical phase
history and unchanged provider clocks, then accepted later exact completion.
Rejecting genuine check URLs, removing the provider head guard and emitting
provider observations for failed polls each made their permanent regression fail;
all three mutations were restored before the passing consuming runs. Root and
Trident TypeScript checks and scoped ESLint passed.

Dependencies were copied into a worktree-local install from an existing tree
with the identical lockfile and unchanged package manifests. The dependency
verifier passed with 30/32 resolution probes and two SDK resolution notes;
this was not a new frozen installation. The required shared-host gate, final CI,
independent review and served operational proof remain integration/release
requirements. No publication, deployment or runtime write occurred in this change.
