## 2026-09-26 — Reconcile exact bounded Codex work without redispatch

The existing owner-work marker contained only a thread and binding revision.
Consequently a restarted host could not distinguish a completed native dispatch
whose retained result was now readable from ambiguous delivery. The binding
guard refused both before the worker's existing no-dispatch recovery consumer.

`open/wiring/codex-owner-binding.ts` now snapshots the original guarded bounded
request (including run and step), credential identity and complete owner binding before dispatch,
then records the acknowledged native turn and broker epoch. Recovery requires
the identical request, credential, owner generation and epoch, an idle broker
without unresolved delivery, complete paginated native turn items, an exactly
completed latest parent and paired native child activity. Only then does the
guard call the existing worker `recover`, never `run`. The worker still owns its
ARMED reservation and result-schema validation. A completed or blocked result
releases only the byte-identical marker after authority is checked again.
Failure, unknown results, cancellation and changed evidence leave it intact.

The native request is recorded separately: production result transport projects
the host result path into the project's native staging directory. The binding
checks this is either the identical request or its exact run/step staging-path
projection; it never substitutes that projection for original recovery identity.
The existing transport still validates the original manifest and staging inode
before copying a schema-validated child result to the host destination. Review
caught the initial non-transport fixture missing this distinction; the recovery
fixtures now all use the actual project runner with production transport enabled.

Boot attachment reports a retryable work-reconciliation refusal for the new
marker. That permits the authoritative workflow consumer to retry without
admitting a chat turn; cached attachments also retain the marker fence. Legacy
markers, missing native acknowledgements, restricted review/synthesis work,
unresolved broker state and different owner generations remain fenced. No
terminal database row is used as evidence that native work completed.

This is the same-generation slice of
[`a-gateway-restart-keeps-the-project-repls`](../spec-items/a-gateway-restart-keeps-the-project-repls.md),
not full-machine workflow-continuation acceptance. Exact native-owner
replacement and unresolved broker-journal adjudication remain dependencies in
`runtime/adapters/codex-cli/persistent/project-owner-crash-recovery.ts`; its
sealed-generation and unresolved-delivery checks are unchanged. A remote PR
creation whose response was never durably recorded remains the separate gap
described in
[`salvage-publication-provenance`](../spec-items/salvage-publication-provenance.md).
No replacement framework or journal was added.

Validation used the consuming project runner and mocked native owner, with no
provider turns, live publication or physical restart. The binding and crash
recovery files passed 110 tests (1,388 assertions); the 23 new focused recovery
cases passed 331 assertions. They cover positive repeated no-dispatch recovery,
request and owner mismatch, incomplete or foreign native history, pending child
activity, invalid result, marker replacement, epoch change, broker uncertainty
and cancellation. Disabling the recovery branch made the positive consumer
fail; removing full binding equality made the generation-negative control
incorrectly complete. Both mutations were restored and the focused set passed.
Transport-specific mutations also fail: retaining the native request instead of
original guard authority violates the positive identity assertion, and removing
projection validation incorrectly completes the foreign-path negative. A valid
result in a substituted staging inode remains unconsumed with its fence intact.
Root and Trident TypeScript checks passed. These checks do not establish
physical gateway, helper or full-machine restart continuity.
