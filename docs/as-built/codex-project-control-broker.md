## 2026-09-19 — Codex project control broker transport and mutation fencing primitive

The locked harness plan requires an owner to move between a native terminal and
Neutron while retaining one long-lived project REPL
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:51`, `:87`). This change
adds an unintegrated broker primitive under the persistent Codex adapter.

`project-control-broker-transport.ts:21` starts one native app-server with an
explicit stdio listener. `project-control-broker.ts:58` requires a private,
owner-controlled Unix socket directory and refuses an existing socket. The
downstream native TUI connects over Unix WebSocket; an in-process gateway port
uses the same upstream connection (`project-control-broker.ts:282`). Native
initialization includes both required capability booleans; attestation requests
are explicitly disabled because this primitive has no attestation provider.

`project-control-broker.ts:13` classifies resume, turn start, settings update,
config batch writes and interrupt as mutations. Unknown RPC methods are refused.
Gateway mutation admission compares the expected process-local epoch before
reserving the next one (`project-control-broker.ts:201`). Other writers receive
an explicit refusal while an operation or turn owns the fence; the native TUI
can stay attached while idle. Settings requests from one connection queue in
order. Turn ownership survives a frontend disconnect and ends only on exact
native terminal evidence. Approval replies and interrupts require the active
owner and matching native identity (`project-control-broker.ts:218`). Lost
acknowledgement closes the broker because mutation outcome is unknown.

Validation: nine broker tests, 51 assertions, cover simultaneous claims, stale
epochs, read filtering, scope bypass refusals, approval replay, exact-turn
interrupts, queued parameter copying, socket protection and uncertain outcomes.
`bun run runtime/adapters/codex-cli/persistent/project-control-broker.smoke.ts`
also passed using installed Codex 0.154.0, a disposable PTY and CODEX_HOME, and a
loopback model fixture. The unmodified TUI resumed a seeded thread, submitted a
turn through the broker and rendered its response. A gateway turn then used the
same thread while that TUI remained attached; the TUI rendered the gateway input,
and the model fixture received both inputs with the seed history. Root and
Trident TypeScript checks passed after installing the frozen dependencies in
the isolated worktree.

Scope limits: this is not wired into project-session, gateway, Herdr, startup
recovery or deployment. It requires a pre-existing thread and a dedicated native
child supplied by its caller. The smoke's seed is fixture preparation, not a
production solution for empty-thread creation. Epochs and turn ownership are
in-memory only; durable recovery and stale claims across broker replacement
remain integration work. The native `/model` operation spans separate settings
and config requests: the test deliberately demonstrates that another writer can
win between those requests. This change does not claim transaction atomicity,
canonical model reconciliation, or completed owner chat.

A fresh TUI resume during another client's active turn is refused because resume
can carry configuration mutations. Approval replies and interrupts belong to the
originating client; moving those controls between owner surfaces needs its own
consuming tests. Those cases and process-generation recovery must be addressed
before production owner-chat integration.
