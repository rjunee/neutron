## 2026-09-23 — Add optional project placement at adapter boundaries

Refs #1226. This change adds API plumbing only. The persistent Claude substrate
accepts an optional placement (`runtime/adapters/claude-code/persistent/types.ts:223-224`)
and forwards it to its selected terminal host
(`runtime/adapters/claude-code/persistent/spawn.ts:539`). The new opt-in factory
constructs a manager-backed Herdr host and refuses a missing placement or relative
journal path (`runtime/adapters/claude-code/persistent/project-workspace-host.ts:15-24`).
Codex bootstrap accepts placement, requires a terminal host when it is supplied,
and forwards it at terminal launch
(`runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts:96-100`, `:304`).

No production caller is activated. Searching `createProjectWorkspaceHost` across
runtime, gateway and Open finds only its declaration and test uses; searching
`projectPlacement` finds the existing host contract, optional propagation and
tests. The same searches positively find the new factory tests and Claude spawn
forwarding. The diff has no Open/gateway composition or auto-selector change.

Validation: 35 focused tests passed with 189 assertions across workspace-manager,
host, Claude-spawn and Codex-bootstrap suites. Disabling Claude placement
forwarding made three scope tests fail; removing the host's missing-placement
guard made three accepting/refusing tests fail; removing Codex's required-host
guard made its refusal test fail. Restoring all three mutations restored the
original tree. These checks use fake terminal hosts; Codex's actual native launch
forwarding still needs a consuming integration test.
The nine new tests passed again after restoration. Root and Trident TypeScript
checks passed on this isolated foundation branch.

This does not complete any production workspace acceptance criterion or change
credential rotation. Wiring all credential-specific conversations to Chat needs
a verified scope-wide handoff: the manager must continue refusing a second live
Chat owner. Production Codex/Claude composition, worker transport integration,
legacy-pane reconciliation, lifecycle and deployed proof remain outstanding.
No live pane or deployed service was changed.
