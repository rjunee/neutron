## 2026-09-27 — Authenticate original Claude native dispatch refusals

The project workspace requirement refuses uncertain work rather than treating
an idle-looking resumed conversation as child completion
(`docs/spec-items/project-herdr-workspaces.md:46–50`). Restart continuity
must preserve the exact recorded owner
(`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:25–34`).
Neither requirement authorizes clearing a historical native-child lease merely
because its build ended or its original parent disappeared.

New Claude native dispatches retain a signed, request-specific record of the
original admission scope, generation, token and producer. Before entering the
native actor, the producer records the concrete parent conversation, child
generation, PID and readable kernel birth identity (explicitly null when that
identity cannot be read). Native agent IDs come only from the acting turn's
unique, exact child-transcript binding; they are creation evidence, not an
assertion that the child completed.

The gateway generates an Ed25519 signing key in memory. Only the public-key
digest enters newly admitted native-child producer identities. The private key
is never persisted or passed to a worker. The original dispatch actor fsyncs
submission intent before invoking terminal submission. A terminal not-submitted
record is possible only before that boundary, and its signing state refuses
later submission. Lost acknowledgements, partial input and interrupted writes
retain uncertainty. Acquisition failures before entering any acting invocation
can now establish positive non-submission without inferring it from a run state.

Recovery verifies the signature against the public-key digest pinned in the
still-stored admission row, not authority supplied by a mutable worker file.
It compares the full request, scope, generation, token, producer and work
reference, then releases only that exact lease. The consuming runner returns an
explicit failed dispatch; it neither fabricates a result nor replays work.
Other tokens and generations for the same request remain held. Legacy unsigned
leases are unchanged and cannot be retroactively signed. The trust boundary is
the gateway's admission database and process memory; this does not claim
protection against compromise of either authority.

Focused mocked controls exercise original refusal, restarted verification,
submitted uncertainty, failed submission fsync, altered signatures, foreign
keys and requests, replay, exact-generation release, and General versus the
literal named project. Semantic mutants that skipped signature verification or
replaced exact-token release with broad work-reference release were both caught.
No live provider turn, live-service termination, canonical state rewrite, or historical
lease release was used to validate this change. This is not a complete native
task census, physical exit proof, cancellation acknowledgement, or deployed
recovery claim.

The focused dispatch/admission/consumer run passed 139 tests and 647 assertions
across seven files; the consuming Open wiring file passed 51 tests and 376
assertions. Root and Open TypeScript checks passed. The full shared-host gate and
served workflow proof remain the integration owner's responsibility; these
focused results do not substitute for either.
