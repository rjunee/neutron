## 2026-09-19 — Recover native owners across token refresh and proven terminal failures

Cross-model review of the durable Open owner integration found that its immutable
launch scope hashed all `auth.json` bytes. Native token refresh legitimately
changes those bytes (`auth/chatgpt-oauth.ts:241`), so restarting a gateway could
reject an otherwise identical surviving owner. This correction supersedes the
credential-byte limitation recorded in `codex-durable-owner-open-integration.md`;
that historical record remains unchanged.

`codex-durable-owner.ts` now reuses `validateCodexSubscriptionAuth` and
`readAccountId` to identify the private subscription account, not its volatile
access/id/refresh tokens or `last_refresh`. Unidentifiable accounts refuse rather
than deriving authority from unverified JWT claims. The subscription validator
rejects metered keys before account selection, including keys coexisting with
OAuth tokens: native key precedence is documented at
`trident/codex-auth.ts:179`, and the subscription-only rule and paired controls
live at `docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md:101`
and `:293`. Full project/home, authenticated helper, pane/process, native
thread/session, revision and generation checks remain in force.

Two lifecycle failures also had overly broad refusal behavior. An actual chat
before credentials were connected cached its rejected project lookup forever.
Only failures before any owner-opening attempt now evict that promise; a later
connection can serve the first turn. Attempted opening remains sticky because
its delivery may be uncertain. A pre-aborted bounded request now returns before
dispatch without marking the owner uncertain. A worker result that never invoked
the acting owner likewise cannot manufacture an owner-delivery fence.

`failed` is not treated as proof of safe recovery by itself. A failed host outcome
can release the work marker only when this invocation observed its exact native
parent completion and structurally terminal child trailer, fresh native state is
idle, no lease/build is active, and no independent uncertainty fence exists. The
host's failed result remains failed. Ordinary post-dispatch timeout, missing or
invalid trailer and unknown host validation still fence chat/build across restart.
Even relabeling an unknown child timeout as `failed` cannot clear that fence.
These distinctions preserve the single long-lived owner in the pivot plan at
`:87` and the no-second-owner refusal in the restart spec at `:176`.

The final native proof exposed an additional event-order race: rollout completion
can precede the broker's native terminal event, including after one fresh state
read. Lease release now performs bounded read-only reconciliation for that exact
completed turn. It never waits on a different turn or replays input; unresolved
state still refuses. A delayed-terminal-state test catches removal of this wait.

### Evidence and limits

The focused suites pass 38 tests. Consuming app/WS and project-build E2E suites
pass 97 tests, including admission, review and publication. Root and runtime
TypeScript checks and focused lint pass. Mutation controls detect volatile byte
pinning, ignored account identity, mixed-key admission, poisoned cold-chat lookup,
retrying uncertain opening, pre-dispatch fencing, refusal after terminal evidence,
clearing post-dispatch uncertainty, and skipping terminal-state reconciliation.
Restored tests pass. Added-content and commit-message privacy scans use the actual
local denylist; no full-tree cleanliness claim is made.

The native disposable-service SIGKILL smoke passes with unchanged helper,
app-server, TUI and thread identities after all volatile fields in a synthetic
OAuth-shaped credential file are rotated. Conversation history survives. Changed
account identity and mixed/changed API keys refuse without another provider
request. Pending approval and stale-frontend negative controls still pass, and
scoped gateway/native process cleanup is verified. This exercises native owner
survival around a simulated credential refresh, not a live OAuth refresh endpoint.

Missing stable account identity, uncertain opening, unresolved child/host work,
pending approval and helper loss still require explicit reconciliation. No native
child-cancellation acknowledgement or pending-approval continuation is invented.
Older draft byte-pinned launch records are not silently migrated. No live service
is changed, and this correction is frozen locally for repeat independent review.
