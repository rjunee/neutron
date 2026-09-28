## 2026-09-28 — Explicit named Codex account selection in General Admin

The manual switch exposed only plain rotation, which cannot select a destination
with a stored cooldown. General Admin now also offers an explicit named-account
selector using the existing authenticated global rotation route with `{ to }`.
The incumbent is excluded, no target is preselected, and choosing a destination
does not write until the operator clicks the switch action. Stored cooling or
quarantine requires a confirmation naming the destination. The UI states that
this releases stored cooling, does not add provider quota or attest availability,
and changes global selection rather than only review runs.
The plain next-account availability check also respects indefinite unauthorized
quarantine, matching the existing server eligibility predicate.

The action shares the existing connect/disconnect mutation boundary, response
ordering, confirming metadata read and refusal reporting. Server custody checks,
General handoff admission/viability checks and project grant policy are unchanged.
There is no automatic rotation, credential import, direct database write or live
account experiment in this change. Acceptance remains in
`docs/spec-items/codex-operator-custody.md`; work state is issue #1378.

Verification: focused client, component and consuming `ProjectShell` tests cover
both selection directions, cooldown/quarantine confirmation acceptance and
cancellation, bearer-scoped request bodies, refusal refresh, mutation exclusion
in both directions, and reachability in both layouts but not named projects.
Root and web TypeScript checks pass. Replacing the named request body with `{}`
caused seven focused failures, including both consuming layouts and both account
directions. Disabling the named action for stored cooling caused nine component
failures; both mutations were reverted. These are synthetic DOM/API checks, not
a provider capacity probe or a visual browser/deployment claim.
