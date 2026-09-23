## 2026-09-23 — Explicit project workspace ownership and terminal placement

The Herdr host placed new tabs into a single inherited workspace and supplied
pane labels without tab labels. This change adds the explicit project-placement
library and host seam for the owner-directed workspace design in
`docs/spec-items/project-herdr-workspaces.md` (issue #1226).

The manager keys instance/project scope independently of display name and cwd;
General is distinct from a project whose id is `general`, and displays as
`Neutron General`. A private, locked, atomically replaced and synced journal
reserves creation before the external mutation. Live workspace metadata must
corroborate the saved random ownership marker. That marker is correlation within
the server's existing trust boundary, not an authentication secret. Unknown or
interrupted creation remains pending rather than creating a duplicate.

New chat tabs are named `Chat` and moved first. Background-first work provisions
an inert Chat placeholder without starting a model. Its launch uses a cleared
environment; replacement verifies the exact post-exec argv and exclusive tab.
Every subsequent worker verifies Chat placement, repairs positively absent Chat,
and restores its first position. Unknown observations and changed identities
refuse mutation. Descriptive worker titles become both pane and tab labels.
A definite initial worker refusal retires only the verified placeholder pane.
The manager never closes a whole workspace or replaces a whole tab: a foreign
split can arrive after any contents/identity sample. Real Chat starts in a fresh
tab before the placeholder pane is retired. The initial workspace shell is also
retired by its exact newly-created pane handle. Failed post-spawn setup closes the unreturned child where possible and
retains uncertain ownership evidence.

Measured locally: targeted manager/host tests and existing Herdr protocol,
adoption, and both-host conformance tests pass; both root and Trident TypeScript
checks pass. A real placeholder process was launched with a synthetic credential
in its inherited environment: the positive control received it, while the
placeholder environment did not. Eighteen semantic mutations were rejected by
tests, covering removed and over-applied identity, exclusive-tab, positive-absence,
lock, repair, and revision guards, plus absent and over-applied environment
clearing. Aggregate cleanup was subsequently removed after review exposed its
check/use race. Deterministic tests now add a foreign split after the final
identity sample and verify both successful placeholder retirement and preservation
of that split. The original code was restored after each mutation.
Four additional semantic mutants broadened each retirement to a workspace/tab
close or suppressed its pane close; all failed the corresponding destructive or
positive retirement controls, and were reverted before final verification.

An isolated named Herdr server also passed live probes of workspace metadata
reuse, real tab names/order, placeholder replacement after manager recreation,
inherited-environment clearing with a positive control, and failed-allocation
handling. Its original early-arrival test did not cover a pane arriving after the
last identity sample; the deterministic late-arrival tests cover that gap. The first
probe exposed a protocol constraint absent from the JSON schema: `layout.apply`
refuses simultaneous `tab_id` and `workspace_id`. Both the implementation and
test server now enforce mutually exclusive targets. The disposable test session
was stopped and removed; production panes were never used by these probes.

The corrected live probe also injects an actual split after the identity response
and before the manager continues; the foreign pane survives both failed-worker
cleanup and real-Chat activation. Closing the final exact pane was observed to
remove the empty workspace atomically on the server. The manager itself never
issues `workspace.close`; its stale mapping is revalidated on the next wake.

Delivery boundary: this is the workspace ownership/placement library slice.
Production conversation/build composition does not yet supply project placement;
existing unscoped callers retain their host placement. Automatic sleep, worker
leases, pending-operation reconciliation, and transcript-preserving retirement
remain subsequent work. No deployed workspace lifecycle or cutover acceptance is
claimed here, and #1226 remains open. The full local leak scan reports existing
tree/denylist matches; it is not recorded as clean.
