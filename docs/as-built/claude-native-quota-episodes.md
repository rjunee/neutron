## 2026-09-30 — Reconcile repeated native Claude quota episodes on one child

The previous prototype spent one continuation opportunity per child lease, so a
later genuine quota on that same child could never continue. The claim key is
now `(lease_token, authenticated_episode_id)`; each claim remains immutable and
spent after restart, cancellation or lease release. This supersedes the
one-per-lease limitation recorded in `native-quota-relay-integration.md` without
editing that historical record. `gateway/project-admission-store.ts:58` retains
the original admission fence and atomic claim; migration 0166 and its schema
snapshot describe the unmerged prototype directly.

The initial episode derives from the original lease and signed dispatch digest.
A successor requires the exact native `SendMessage` invocation and linked
successful result naming the original child. The runtime commits the claim,
registers its immutable pending HostMessage, then submits parent input. Broker
promotion is a separate signed operation and cannot follow terminal input
acknowledgement alone. The protocol binds the complete message, original request,
parent scope, child, lease and original deadline. Budget and fence digests are
correlation echoes, never independent authority. The host-selected deadline is
signed before dispatch (`open/wiring/project-build.ts:596`); absent or expired
original budgets refuse new input while preserving original-result harvesting.

Passive result recovery runs alongside pending-intent reconciliation
(`open/wiring/project-build.ts:769`), so a native HTTP request quarantined pending
verification does not deadlock the original result. Repeated authenticated
quotas reuse that recovery path, original request and child. Work cancellation
uses a separately bounded signed control to tombstone the newest immutable
intent without refunding its claim or revoking unrelated parent work
(`runtime/workers/claude-native-continuation.ts:63`).

Waiting remains durable after terminal acknowledgement. Verified promotion or a
validated original result clears it, and episode-bound events cannot clear a
newer wait on the same child. Producer recovery restores its authenticated
native-step/child state (`open/wiring/project-build.ts:691`). The consuming
held-acknowledgement control proves the wait remains until the linked native
result is available; the repeated-quota control reaches the existing merge gates
with two permanent claims, two same-ID continuations and one original child.
The host review scope supplies its enclosing checkpoint directly
(`trident/project-build-host.ts:215`); the dispatch receipt signs that parent step
before native dispatch. The held synthesis consumer reconstructs the store,
proves the signed relationship, observes the projected wait while the native
result is withheld, and checks it clears immediately on verified promotion before
the build reaches its terminal phase.

Validation: the focused runtime continuation, capacity client, dispatch receipt,
admission, schema snapshot and review-host suites pass 177 tests. Consuming controls cover
same-ID continuation, repeated all-full waits, quarantined acknowledgement,
foreign launch and host evidence, lost acknowledgements, original-result
precedence, cancellation and restart before the first claim with missing or
expired signed budget. Type-correct allow-all and deny-all launch-authority
mutations both pass root and Open typechecking and fail the corresponding
consuming refusal and repeated-quota success controls; the production validator
was restored afterward.

This record covers local public-runtime fixtures and protocol consumers. The
full named consuming file, integrated host relay and served renewable-account
acceptance remain separate integration checks. The consuming nested-step check
uses the authenticated parent relationship and the separately recorded projection
correction. No provider traffic, production mutation or publication was
performed by these tests.
