## 2026-09-19 — Claude bounded work in Codex-owned Open builds

Open now constructs the Claude headless runner from the host-selected environment,
the assigned worktree, the run-owned state directory and the existing payload
validators (`open/wiring/project-build.ts:350`). Explicit Claude plan, review and
synthesis phases therefore execute under a Codex project owner; the same-provider
build still uses that owner's native child. This consumes the runner introduced
in `claude-cross-provider-headless.md` without changing owner selection or gates.

Recurring Claude review seats and synthesis retain separate observed thread IDs
across source replacement (`trident/project-review-source.ts:78`). The existing
exclusive thread writer and unknown-response behavior now apply to both headless
providers. Run, project, working directory, seat, model and selected authentication
remain part of the receipt identity; a changed returned thread is refused.

Consuming verification exposed two runner limitations. Model defaults are class
aliases, so the runner now admits the explicit opus, sonnet, haiku and fable
classes and requires the reported concrete model to belong to that class;
concrete selections still require exact identity
(`runtime/workers/claude-headless.ts:138`). This supersedes the earlier runner
record's unconditional model-string equality, without adding model fallback.
Selected config paths can change accounts in place, so retained sessions now
bind a digest of credential bytes and recheck before dispatch (`:52`, `:238`).
The digest and raw credentials are never emitted to logs. Unreadable credentials
refuse admission. No stable account identifier is assumed: config credential
refreshes also refuse continuation, conservatively, until a stable account
attestation contract is available. Keychain-only authentication is not admitted
through this bounded runner.

The consuming process-boundary fixture reaches MERGED through real preparation,
worker transport, durable results, git publication, pinned review and merge checks,
with only the model CLI and hosted service boundaries simulated
(`open/__tests__/project-build-e2e.test.ts:803`). Wrong credentials and missing
configured runners produce no worker dispatch; wrong schema produces no build or
publication. The full named end-to-end file passes 94 tests. Runtime and review
source suites pass 54 tests, including config rotation, model-class mismatch,
independent recurring threads, durable receipt recovery and uncertain-result
non-replay. Open, runtime and Trident TypeScript checks pass.

Five semantic mutations were killed: removing selected Claude credentials broke
the legal merge; removing schema equality let an invalid result merge; accepting
any reported class completed a wrong-class response; replacing config identity
with a constant admitted account rotation; restoring Codex-only thread persistence
lost Claude continuity. Each mutation was restored and its control rerun.

The whole-tree lint run reports inherited promise/console findings outside this
change. The whole-tree leak run reports existing denylist findings and the local
worktree git pointer; it is not a clean release claim. This change's scoped file,
commit-message and as-built checks are recorded separately in the handoff.
No live owner run, push or publication was performed by this implementation lane.
