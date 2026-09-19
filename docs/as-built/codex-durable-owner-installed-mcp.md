## 2026-09-19 — Bind approved MCP servers to the durable Codex owner

The independently reviewed provider at `aa0de08a` used an older project-session
host. Merging that host into the shared native owner would introduce a competing
chat/build authority. This change ports its approved SDK broker and fixed gateway
onto the existing `CodexOwnerBindings` authority instead. It preserves the
acknowledged-interrupt successor behavior at `136c0d17`, the build worker gates,
and the Claude substrate. The governing acceptance is
`docs/spec-items/owner-installable-mcp-servers.md:13`; project continuity is
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87`.

Fresh native roots register `neutron_owner_mcp` once, alongside the authenticated
TUI's native tools (`project-control-bootstrap.ts:253`). Native Codex requires
canonical `type: function` registration when the TUI supplies canonical tools;
the legacy untagged shape was rejected by the native smoke. The broker forwards
tool calls only to the exact active writer, thread and turn
(`project-control-broker.ts:156`). Open prepares approved SDK peers before owner
delivery and returns results through that same helper writer
(`open/wiring/codex-owner-binding.ts:108`, `:139`);
`open/composer.ts:1190` supplies the existing encrypted approval-store resolver.

The gateway retains complete discovery and protocol results, shared resource
subscriptions, progress tokens and bounded notification queues. Consumer handles
survive successive owner turns; old-turn envelopes do not replay. Revocation or
changed approved material retires the peers and handles. Bounded work never
acquires installed-server authority. The private helper and control broker still
refuse foreign writers, stale grants and mismatched native turns. Installed-server
HTTP aliases and the superseded project-session host are not introduced.
Inherited native child tool declarations receive explicit RPC refusals instead
of hanging without an owner handler; the consuming test also exercises a stale turn.

An existing root without fixed-tool registration explicitly refuses an owner
turn requiring approved servers. It is never replaced or resumed with new
configuration. Removing those approved servers permits ordinary chat on the
same root. Direct native TUI-owned turns do not use the gateway-owned provider;
this change does not claim installed-MCP acceptance on that path. The existing
native TUI and same-provider child execution remain covered by the native smoke.

Verification: 334 tests pass across the explicit Open project-build E2E, owner
binding, approved SDK broker/gateway, control broker/bootstrap and worker suites.
The new Open consuming test traverses the actual binding, authenticated helper,
broker and SDK stdio peer; it verifies successor handles, notification isolation,
bounded denial, a complete MERGED build, subsequent owner chat and live revocation.
An old-root test proves refusal does not create another owner or poison ordinary
chat. Root and Trident TypeScript checks and touched-file lint pass. Client parity
keeps approval distinct from running-process claims.
The local full-tree leak scan did not pass; it reports 453 findings with truncated
per-rule examples. This record does not attribute those findings to the baseline
or claim a clean purity gate.

Four restored semantic mutations were detected: removing SDK owner authorization,
refusing all owner execution, allowing predecessor notification replay, and
suppressing current notifications. The replay mutation removes both redundant
lease filters; removing only the receive filter remains protected by notification
enqueue filtering. The latter three failures occur in the Open consuming test;
the authorization bypass is caught by the SDK consumer's forbidden-call assertion.

The native smoke uses a disposable credential-free home and loopback model
provider. It verifies real fixed-tool advertisement, request/reply routing,
native child execution, gateway and terminal turns, and existing scope controls.
These checks do not establish live-account, physical-device or deployment acceptance.
