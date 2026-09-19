## 2026-09-19 — Durable Codex owner attachment in Open

This draft composes the durable owner helper into the shared Open chat/build
binding. It follows the one-project REPL boundary in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87` and the restart target in
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:21`. It does not
declare the broader restart spec complete or change its existing Claude scope.

### Built

`open/wiring/codex-durable-owner.ts` replaces the production gateway-owned native
bootstrap with an independently hosted Herdr helper. An exclusive private launch
record precedes any launch; an incomplete record refuses replacement. The helper
enforces its separate gateway cgroup boundary before starting native processes.
The host records its exact helper pane and boot/start identity, then authenticates
the published helper descriptor and complete native binding. Restart requires the
same private launch scope, credential digest, pane/process identity, descriptor,
thread/session, revisions and generations. Neither failed attachment nor missing
provenance launches another native owner. Existing legacy bootstrap journals are
not silently migrated.

Open boot reconciles existing launch records for selected Codex projects before
serving traffic. Missing credentials on a cold project do not become a permanent
refusal: connecting credentials later permits its first turn. An actual uncertain
launch remains fenced, and the fence is checked before attempting another launch.
Closing an attached binding detaches the frontend; it does not destroy the helper,
native app-server or TUI.

Remote lease completion explicitly awaits `refreshState()` instead of interpreting
a cached broker snapshot as exact current state. Native approval actions await
`replyApproval()` using the original logical writer identity. Reply uncertainty
remains one-shot and fences the owner. Local injected test owners retain their
synchronous broker seam; production has only the durable helper path.

A private host-work marker is written before managed chat/build dispatch and
survives unresolved child observation and the outer result decoder. Only a
confirmed successful host outcome clears it. Restart with that marker refuses
reuse even when the native parent reports idle. A marker-free active native turn
also refuses adoption. Pending approval recovery is deliberately not implemented:
the native owner survives, but Open does not reconstruct a lost host consumer or
replay an answer. These cases require explicit reconciliation, not a second owner.

The model control response now distinguishes a stable `conversationId` from its
epoch-bearing conditional `sessionId`. The phone/web component accepts successful
revision advancement on the same conversation and uses the new token on its next
request, while rejecting actual conversation replacement. Server epoch and exact
native identity comparisons are unchanged. Claude's existing session behavior is
preserved.

### Evidence

The focused binding, durable-launch refusal and rendered app-control suites pass
47 tests. Their positive and negative controls include credential-free cold boot
followed by connection; uncertain journal refusal; awaited remote approvals;
remote terminal state refresh; parent-complete/child-pending and outer-decoder-
pending restart; valid child acceptance and subsequent restart; malformed and
invalid child payload quarantine across restart; and an active terminal-originated
turn without a host marker. The composed app/WS suite passes nine tests, and
`open/__tests__/project-build-e2e.test.ts` passes all 88 admission, review and
publication tests. Root, runtime and app TypeScript checks and focused lint pass.

Semantic mutations are detected in both directions: removing the work-marker
refusal fails four restart cases; rejecting every owner fails legitimate cold and
remote-turn controls. Removing the UI conversation guard fails replacement
controls; restoring its old revision-equality comparison fails a legitimate
native model switch. The restored tests pass.

`open/wiring/codex-durable-owner.smoke.ts` passes against native Codex with a
loopback model fixture and disposable gateway services. It uses the production
durable launcher and actual Open binding, then SIGKILLs the verified gateway main
process. Exact helper, app-server and TUI process identities and complete binding
survive; the resumed turn includes pre-restart conversation history. A separate
death during an actual native approval proves refusal without prompt replay or
tool execution. A superseded frontend grant refuses state access. The instrument
confirms scoped gateway/native process cleanup before successful exit. This is
idle continuation proof plus pending-approval refusal proof, not pending-approval
continuation or native build-child completion proof.

An independent read-only review found the model-picker identity mismatch and the
cold credential boot fence; both have consuming regressions. The reviewer found
no further concrete blocker in the final source review. Changed-content privacy
checks use the actual local denylist; no claim is made that the unrelated full
repository leak gate is clean.

### Remaining boundary

Credential bytes changing, missing/uncertain launch provenance, active native
turns, unresolved host work and helper loss all require reconciliation. There is
no automatic replacement, token-refresh migration or pending-approval adoption.
The helper requires a supported independent Herdr host and gateway service cgroup;
unsupported launch environments refuse. This change is a frozen integration
draft, not deployed cutover evidence. No live project or shared gateway is changed.
