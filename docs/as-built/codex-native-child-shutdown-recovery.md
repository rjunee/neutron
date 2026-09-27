## 2026-09-26 — Release a surviving helper after its native owner exits

The recovery acceptance at
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:30` requires the
recorded native conversation to resume without a synthetic turn. A native
app-server or TUI exit previously closed the bootstrap but left its helper
listener alive. The opener then found a live helper descriptor and failed its
attachment, without reaching independently proven crash recovery.

The bootstrap now publishes unexpected shutdown only after both child exit
observations settle. The helper closes its retained registry/listener and exits
itself. Planned retirement keeps its completed-receipt ordering, and explicit
disposal does not select the crash lifecycle. These observations are not process
death authority: the opener still requires the existing independent boot/birth
proof, sealed generation, competing-owner census and exclusive successor claim.

The opener also handles helper exit between descriptor reads, pane inspection
and attachment. An observed child exit with incomplete shutdown is retryable;
unknown child liveness and an independent crash-guard refusal never permit a
successor. Receipt creation rechecks the exact pre-attachment authority. No
provider turn, process signal, work-marker clearing or workflow lease change was
added. Previously running helper versions do not gain the new lifecycle
notification retroactively; legacy incomplete process evidence remains refused.

Thirty-eight focused tests pass with 236 assertions. The actual bootstrap is
exercised with a mocked native transport, broker, listener and terminal host;
native-first and terminal-first failures wait for both exit observations before
helper shutdown. Removing the production shutdown notification made both cases
fail within their bounded deadline; restoring it restored green. Pure controls
cover retirement ordering, incomplete exit evidence, process-death distinctions,
exact successor resume, descriptor/pane races and unknown/foreign refusals.
No physical processes, provider calls, signals or live restarts were exercised,
and no full-suite result is claimed.
Root, Open and Trident TypeScript checks pass on the final source.
