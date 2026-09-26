## 2026-09-26 — Revalidate the Herdr client against protocol 22

The client previously required protocol 20. Official Herdr v0.9.1 declares
protocol 22 (`src/protocol/wire.rs:20` at upstream commit `065ef9d6a531c49fb8bee7e818ef837065b21ee9`).
The mandatory equality gate therefore rejected the updated server before pane
creation (`runtime/adapters/claude-code/persistent/herdr-client.ts:624` and
`herdr-host.ts:249`). The supported pin now names 22 (`herdr-protocol.ts:31`);
the equality gate and its unknown-version refusal remain intact.

The upstream source was read at that commit, separately from concurrent server
development. The JSON request envelope remains `{ id, method, params }`
(`src/api/schema.rs:35–43`); ordinary methods still read one initial line and
return one response (`src/api/server.rs:171–178,276–303`). Success/error envelopes
remain separate objects (`src/api/schema/response.rs:24–39`). Pong states the
protocol (`response.rs:45–50`). These source references are to Herdr, not this
repository.

The consumed pane/layout structures remain compatible: `LayoutApplyParams` and
the pane root retain command, cwd, env, focus and placement (`panes.rs:155–213`);
`PaneInfo` retains label and optional scroll (`panes.rs:517–559`);
`PaneProcessInfo` retains optional shell pid and foreground argv
(`panes.rs:570–589`); `PaneReadResult` retains nested read text and truncation
(`panes.rs:755–763`). Text/key parameters retain pane id and text/key vector
(`panes.rs:332–340`). Text is delivered without implicit Enter and both input
methods return `ok` (`src/app/api/panes.rs:1801–1816,1917–1938`). No codec
replacement was needed. The newer source caps requested reads at 1,000 lines
(`src/app/api_helpers.rs:117`); the existing conservative 999-line allowance is
retained, rather than asserting a new live measurement.

Project placement also retains workspace creation parameters, ownership-token
metadata and workspace tokens (`src/api/schema/workspaces.rs:8–19,49–75`), plus
tab placement (`src/api/schema/tabs.rs:34–48`). Their response envelopes remain
workspace, root pane and tab objects (`response.rs:54–60,87–89`); independent
fixtures exercise these through the socket codec as well.

Independent protocol-22 fixtures exercise the actual socket codec through host
spawn, inspect, screen capture, acknowledged submission and close
(`__tests__/herdr-protocol-22-compatibility.test.ts:78–103`). They do not derive the
protocol from the production constant or shared fake. A changed read nesting
must fail screen capture (`:106–114`). Explicit protocols 20, 21 and 23 are refused
before `layout.apply` (`__tests__/herdr-protocol-gate.test.ts:524–532`). The shared
fake now reports v0.9.1/protocol 22; normative acceptance names the supported pin.
Historical protocol-20 measurements and frozen records remain historical.

Validation: 68 focused mock tests passed (165 assertions); runtime TypeScript
checking passed with worktree-local dependency resolution. Restoring the old
pin caused both independent protocol-22 controls to fail. Removing the equality
comparison caused all five selected mismatch tests to fail. Both mutations were
restored before final validation. The documentation sweep found the amended
acceptance criterion alongside historical protocol-20 measurements, with the
same search finding the new protocol-22 assertion as its positive control.

This establishes consumed JSON shape compatibility, not live process lifecycle
or provider completion. Open E2E through `createClaudeCodeSubstrateAuto` and
project pane ownership/retirement proofs remain integration checks; no live pane
was created, closed or killed by these mock tests.
