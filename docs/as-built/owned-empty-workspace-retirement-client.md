## 2026-09-28 — Guarded empty-workspace retirement client

Refs #1226. `docs/spec-items/project-herdr-workspaces.md` requires an atomic
ownership-and-contents guard before workspace removal. This change supplies its
client contract and consuming Claude sleep path, not the server implementation
or a live workspace migration. The server must explicitly advertise
`owned_empty_workspace_retirement` on the supported protocol. There is one close
operation, `workspace.retire_empty_owned`; absent capability refuses that operation
and retains the existing pane-only result. No operator flag or raw
`workspace.close` alternative is introduced.

The manager reserves the original workspace/Chat observation and operation ID
under the existing durable journal lock. Replies must echo the complete target;
compare-and-swap refuses stale acknowledgements or concurrent journal rewrites.
Unknown results retain the reservation across restart. A subsequent explicit
sleep request can retry the exact operation, including after the server completed
it but the reply was lost; this does not add automatic boot reconciliation.
Confirmed retirement clears workspace/Chat claims while preserving worker
operation tombstones. A correlated non-mutating refusal releases only the
retirement reservation, with a fresh revision, so an arriving foreign pane survives
and the next verified Chat can still wake. Conversation history and session pins
remain owned by the existing pool.

The new manager fixtures exercise null General, a literal `general` project,
another project, exact capability/protocol, foreign arrival at the atomic
boundary, changed markers/observations, lost replies, stale acknowledgements,
concurrent journal rewrites and worker tombstones. Consuming gateway fixtures
verify workspace removal plus same-session/history wake, foreign-pane survival
and wake, and explicit retry after lifecycle reconstruction. Existing
unsupported-server, busy, approval, child, foreign, unknown and Codex-sleep refusal
tests remain in place.

Five temporary semantic mutations were killed and restored:
capability bypass, unconditional refusal, acknowledgement-correlation bypass,
dropping worker tombstones and bypassing the gateway retirement call. These are
behavioral failures, not snapshots of the implementation text. Open typecheck and
lint of every changed TypeScript file passed. The runtime/placement/host/spec-index
selection passed 110 tests; consuming sleep and credential-handoff fixtures passed
38 tests. No live pane, server or socket was changed.

The server operation, authority-preserving live daemon handover, safe adopted-pane
handle migration, Codex sleep authority and a fresh deployed live cycle remain
open. No #1226 acceptance box is ticked and this client change does not complete
workspace cutover.
