## 2026-09-19 — Codex owner preflight is not native delivery

This draft correction preserves the one-project, one-native-owner chat/build
contract in `docs/plans/harness-orchestrator-pivot-2026-09-11.md:87-111`.
The restart criterion at
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:21-35` remains
explicitly scoped; this change does not declare that broader item complete.

The real in-REPL worker converts a rejected credential lookup into `unknown`.
Previously the Open guard recorded an acting-turn invocation before that lookup,
mistook it for native delivery, and permanently refused the project even though
no owner had opened. The host now records the boundary immediately before an
opening attempt or native `turn/start`, not before preflight
(`open/wiring/codex-owner-binding.ts:184`, `:108`, `:257`, `:347`). Missing
credentials and invalid paths against an already-known idle owner do not write
a work marker. An opening or native submission of uncertain outcome remains
sticky; a post-dispatch timeout is not treated as settled failure.

The worker observation closes on outer settlement. Deferred credential/model
reads cannot subsequently open or submit for that expired observation. Runtime
conversation and build wrappers also retain uncertainty fences of their own.
Open renews only a project-specific conversation host view after fresh idle
state, opaque binding validation, zero native delivery, and no independent host
refusal (`open/wiring/codex-owner-binding.ts:149`). It discards a build wrapper
only after zero native attempts (`:420`). Neither operation creates or replaces
the native owner. Actual successful delivery keeps its stable host view; a
foreign active native turn prevents renewal even after that turn later settles.

Validation: 48 focused binding/durable tests passed, including real
`createProjectRunners`/`codexInReplRunner` consuming controls for missing-credential
build then connection/chat, wrong cwd/root then correct chat, late resolver and
model reads, an already-attempted opening returning after timeout, uncertain
native submission across restart, and foreign active work. The 88-test
`open/__tests__/project-build-e2e.test.ts` suite exercises admission, review and
publication. Root and runtime TypeScript checks, focused lint and diff checks
passed. Six restored semantic mutations were rejected: treating preflight as
delivery (including the credential regression), omitting the opening attempt,
renewing after actual delivery, renewing while native work is active, refusing
all zero-delivery renewal, and opening after the preflight expired.

The production durable launcher/Open consumer native smoke passed: exact helper,
app-server, TUI and thread survived the disposable gateway SIGKILL; an idle
owner turn resumed after simulated OAuth token-field refresh; changed account,
mixed/changed API keys and stale frontend authority refused. Pending approval
was proven to refuse replay, not to resume. A live OAuth refresh request and
production deployment are not claimed. Herdr was used only for the isolated
probe workspace and disposable processes. Added-content and commit-message
privacy scans use the repository leak gate; existing unrelated full-tree
findings are outside this scoped claim. No push, PR, merge or deployment was
performed.
