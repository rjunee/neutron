## 2026-09-19 — Detachable Codex project-owner helper

This is a bounded runtime slice toward
[`a-gateway-restart-keeps-the-project-repls`](../spec-items/a-gateway-restart-keeps-the-project-repls.md),
not a production Open cutover. The fresh factory cannot preserve its children
when its hosting gateway dies. The helper instead owns that factory, native
app-server stdio, broker and journals in an independent Herdr pane; the actual
native TUI occupies a second visible Herdr pane. Admission compares Linux boot
and process-start identity and requires positive cgroup separation from the
launching gateway. A detached child in the gateway's cgroup is refused.

`project-owner-helper.ts` retains the live factory and revalidates its opaque
binding and complete project credential-home marker on every operation. A private
Unix socket and immutable private descriptor locate an authenticated challenge
handshake. Attachment requires equality of the complete original native binding,
including thread, session, rollout, pane, credential fingerprint, revision and
both journal generations. An existing or uncertain descriptor never falls back
to another owner. The gateway does not reopen the journals.

`project-owner-helper-registry.ts` retains one original broker Client object per
logical gateway writer. Reconnection rotates frontend and writer grants without
transferring another client's approval authority. Explicit writer close revokes
its grant immediately; outstanding native work and approvals remain available to
an authenticated reopening of that same writer. Idle retired clients are removed.
Bounded event and approval retention fails closed on an unreconcilable gap or
overflow. Disconnecting an attachment never destroys the helper or native owner.

`attachCodexOwner` returns an opaque factory binding plus `refreshState()` and
awaitable `replyApproval()`. Synchronous broker state is explicitly a cached
observation, not fresh reconciliation evidence. The legacy void approval method
refuses remote use rather than claiming an unacknowledged reply succeeded.
Malformed or lost response bodies revoke the frontend because a write outcome
may be unknown. Direct terminal input uses the real Herdr pane.

### Evidence and limits

Focused factory/helper tests pass: 14 tests and 108 assertions. They exercise the
real broker's exact-client approval routing, explicit-close stale interrupt and
reply refusal, and legitimate retained-approval acceptance after reconnect.
Positive controls also cover independent cgroups, the complete project marker,
unchanged generation and successful response decoding. Mutations that remove
grant comparison, collapse client identity, omit lost-body revocation, or reject
all legitimate attachment are detected. Both root and Trident TypeScript checks
and focused ESLint pass.

`project-owner-helper.smoke.ts` is the consuming native proof instrument: an
explicit isolated Herdr test server, disposable gateway user service, zero-seed
release barrier, exact process identities and cgroups, scoped gateway SIGKILL,
reattachment, subsequent native turn and direct actual TUI submission. It can
also consume the Open binding implementation supplied by the caller. Wrong
identity, stale frontend, foreign thread and unauthorized attachment are negative
controls. Success is emitted only after owned-pane and process cleanup is
confirmed; uncertainty retains diagnostics and fails the process.

The native 0.154.0 consuming smoke passes. Helper, native TUI and app-server kept
their exact boot/start process identities outside the disposable gateway service
cgroup across SIGKILL of its verified main PID. Reattachment preserved the exact
thread/session/rollout and broker generation. The actual Open binding consumer
completed before and after restart; the second provider request contained prior
conversation history. The third turn came through the actual Herdr TUI, whose
screen rendered its response. All three recorded owner process identities and
owned panes were confirmed stopped before the successful exit. An earlier probe
failed on a broader systemd kill invocation before reattachment; the final probe
uses the verified main-process target.

This proves gateway death after a completed turn, not while a native approval is
pending. Served Open/gateway wiring and build-child/trailer reconciliation remain
outside this slice. A broker reporting idle does not prove those higher-level
obligations settled. No production service or shared launcher is changed, and the
existing fresh-only Open consumer is not cut over here.
