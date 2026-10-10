---
title: Continue a quota-limited Claude child on its original native agent ID
group: trident
status: open
priority: P0
cutover: true
---

Issue #1416 is the inbox reference. The locked pivot
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md` §3.2 and §4) requires
same-provider work inside the project REPL and retains publication/review gates.
`a-gateway-restart-keeps-the-project-repls.md` requires harvesting completed work
before continuation and preserving at-most-one dispatch. The native request
relay decision is recorded in SPEC.md on 2026-09-30.

## Native request and account authority

A protected host registration routes the existing native CLI over one Unix
socket. Open creates a random 32-byte parent scope, injects the supported native
Unix transport and OAuth environment placeholder, then registers the exact PID,
kernel start ticks, boot and session after spawn and before first chat. A present
invalid or unavailable host route refuses with a local error; it never falls back
to direct authentication or becomes a synthetic provider quota error. An
unregistered self-host retains the native authentication contract.

The registered local Unix socket speaks plaintext HTTP; provider HTTPS belongs
to the host relay, not that local hop. Its native base URL is the fixed loopback
port-zero sentinel, never a routable plaintext provider URL. Missing or ignored
Unix transport must fail locally without emitting scope or auth headers to an
external endpoint. Unregistered self-host provider URLs are not rewritten.
The registered-route reuse fingerprint binds this local wire protocol. A stored
older-protocol parent is not current merely because its host, socket and key
match: normal fingerprint and live-child refusals still apply. Only a genuine
authorized launch captures the new fingerprint; historical signed evidence and
held native work are never rewritten to make an old parent eligible.

The host consumes the actual native model and session/agent headers. Account
selection and refresh stay in the host account service. A genuine pre-stream
quota rejection can rotate an authorized account and relay that same native
request without creating a child or sending `SendMessage`. Partially streamed or
ambiguous requests are never replayed. Unknown session changes refuse; a new
header alone cannot grant a new session scope. The adapter currently has no
authorized in-place native session-change operation. No assumption is made that
compaction changes the native session ID.

Open verifies the original signed dispatch receipt before joining its native
child to the relay scope, request digest, original lease and receipt-signature
digest. Joining uses structured host receipt fields, never worker prompt text.
The signed host observation reports actual native request model, request body
digest, root native agent identity, opaque account generation and quota outcome.
Its separate fresh capacity response is based only on the previously observed
actual model. Launch aliases and credential-file changes cannot establish these
facts. Ordinary assistant text and arbitrary local 429s are not quota authority.

A native terminal API failure may settle its conversation only through a
generation-authenticated `StopFailure` hook correlated to the exact injected
root channel turn by `UserPromptSubmit` and its native prompt ID. Startup,
history, quoted text, retries, foreign generations and subagent failures cannot
settle that turn. The normal failure path releases conversation admission, not
unresolved native-child ownership. Before warm reuse, an authenticated exact
terminal acknowledgement retires that turn's reply correlation without erasing
older stale-reply debt. Children launched without these hooks cannot acquire
retrospective terminal authority from a rendered error or an operator assertion.

## Original-child continuation

On registered host routes, new bounded native dispatch first checks an already
ready parent against the current route fingerprint, project tool grants, required
planner role and matching measured continuation launch and relay scope. A stale
parent refuses before acquiring a child lease; this check never refreshes the
parent or promotes recorded metadata. Missing-parent acquisition remains behind
native admission, and the selected parent is checked again before original
dispatch binding. An unavailable registered route refuses. Unregistered
self-hosts retain their existing native authentication contract. These checks
do not change recovery or retrospectively authorize an existing child.

An authenticated native quota observation and fresh available capacity may
authorize a bounded `SendMessage` addressed to the original native agent ID.
This retains the request, worktree, result contract, parent and durable child
lease. It never re-enters `Agent`, switches substrate, releases ownership for a
429, or bypasses a publication/result validator. The signed original launch must
bind project, session, generation, executable digest/version, argv and explicit
`Agent,SendMessage` grants under `CLAUDE_CONTINUATION_PROFILE`. A version or argv
assertion alone is insufficient. This observes launch inputs, not a served tool
catalog or an executed process image.

The relay scope is preserved inside that signed original launch. The scope
capability contains no provider credential and is valid only for the exact
original parent PID/start/boot/session. A gateway restart can recover that
survivor's provenance; a replacement process cannot inherit it. A newly adopted
parent without the original scope remains unavailable even if its executable and
argv are independently measured. Current admission authorization, workspace and
parent identity are checked before capacity and again before input.

Original-child continuation must also make progress while independently admitted
peer children remain live. A host-bound child may acquire the serialized parent
input slot without awaiting compatible peers' completion. Independence uses the
same measured workspace and result-path contract as
`trident-build-efficiency.md`; it is not inferred from a role name or a quota
message. Unbound, foreign, unknown and conflicting ownership retain their fences.
Reconstructed ownership must derive its child binding from the original verified
dispatch receipt before using this admission. Ordinary parent turns still wait,
and neither original budgets nor durable child leases change.
Cancellation or expiry removes a still-queued continuation's parent turn and
busy count without releasing another active turn or its native child lease.

The durable continuation claim is committed before the host registers its pending
intent, and both complete before Enter. A timeout, lost acknowledgement or restart
never refunds the claim. Exact invocation reconciliation
requires the parent session, unchanged original transcript prefix, post-claim
boundary, native recipient and nonce-bound structured input. Conflicting
same-nonce invocations, replaced/truncated transcripts or unknown input preserve
UNKNOWN. Prefixes above 64 MiB and tails above 4 MiB refuse reconciliation.
Terminal acknowledgement proves parent input only. Promotion additionally requires
the linked native `tool_result` to report success and the original `resumedAgentId`,
consistent with the native result metadata. The original result validator decides completion, and completed work is
harvested first even when current parent or capacity evidence is unavailable.
Both result readers require bounded stable regular files; links, FIFOs and
changing snapshots refuse safely.

Each authenticated episode has one permanent claim under the original lease.
The initial episode derives from that lease and signed original receipt digest;
a successor derives from the same lease and the verified predecessor native
`SendMessage` tool-use ID. A new timestamp, request-body digest, account generation
or SDK retry cannot create a successor. The signed observation must bind the
predecessor and immutable intent as well as the original child, session and scope.
An unresolved claim remains observation-only. A recovered pending claim may be
promoted after exact reconciliation, but cannot be re-prepared or resent.

The pending host intent binds the complete nonce-bearing generic HostMessage,
original request, receipt digest, parent scope, child and lease. Its signed budget
and fence digests are correlation fields; the original Open admission authority
and live host authorization still decide whether work may proceed. Matching native
HTTP is quarantined without forwarding provider bytes until verified promotion.
The newest exact structured user message must contain the pinned native delivery
wrapper around the complete HostMessage. Missing, compacted, marker-only, foreign
or delayed old markers cannot advance episodes. SDK retries retaining the newest
exact marker remain in that episode even when body metadata changes. Promotion
and forwarding recheck cancellation, deadline and current authorization.
Work cancellation tombstones that work's immutable intent without revoking the
whole parent scope, refunding the claim or creating an episode. Its cancellation
control uses a separate bounded signal and may run after the original deadline;
expired authority cannot promote or forward a model request.

The original host-selected dispatch deadline is signed before dispatch and binds
the first observation and every successor. Recovery never starts a fresh budget;
missing signed budget authority permits passive original-result harvesting only.
All-full retains the original child and claim opportunity, emits durable scoped
waiting stages, and polls within that deadline. Retry hints determine a bounded
one-to-thirty-second capacity cadence; original-result harvesting continues each
second without holding parent input. Passive recovery and pending-intent
reconciliation proceed together so quarantined HTTP cannot deadlock promotion.
Unknown capacity cannot authorize another input. The existing waiting projections
consume the same durable stages across repeated episodes.
The resumed stage is emitted only after verified promotion or validated original
result settlement. A terminal input acknowledgement retains the waiting notice
while HTTP remains quarantined. Episode-bound resume events cannot clear a newer
wait on the same child; restart reconstructs the current durable waiting state.
For nested review and synthesis, the original signed dispatch also binds the
enclosing host review checkpoint supplied by the orchestration scope. The durable
child binding retains the actual child step and that explicit parent step, so the
board can display its wait without guessing from step-name prefixes or whichever
checkpoint happens to be current at recovery time.

## Acceptance

- [ ] Registered current warm and cold parents reach the existing merge gates;
      stale route, tools, planner, launch identity, argv or relay refuse before
      new child admission or input. A changed parent after admission releases
      only its positively unsubmitted child; fenced cold scopes never spawn.
      Verify the registered-parent preparation cases in
      `open/__tests__/project-build-e2e.test.ts`, with accepting and refusing
      semantic mutations.

- [ ] The native launcher registers the exact process before first chat; broken
      registered routes refuse without direct-auth fallback or credential 429.
      Stable host account rotation retains warm transport identity; changed
      host/instance/socket/key and revoked registration refuse. Self-host direct
      authentication retains its existing behavior.
      Verify: native-request-relay, auth-fingerprint and launch tests, the
      consuming `open/__tests__/project-build-e2e.test.ts` Unix-transport case,
      and the offline official-CLI wire proof.
- [ ] Generation-authenticated, exactly correlated native terminal failure reaches
      the existing chat failure path and permits a warm next turn without killing
      or replacing the parent. Conversation leases release; unresolved native
      child leases remain unchanged. Uncorrelated and foreign evidence refuses.
      Verify: `gateway/wiring/__tests__/build-live-agent-turn-native-failure.test.ts`
      and `runtime/adapters/claude-code/persistent/__tests__/native-turn-failure.test.ts`,
      including the real dev-channel endpoint and opposite semantic mutations.
- [ ] Genuine pre-stream A-to-B rotation preserves the same native request,
      parent and child without `SendMessage`; ambiguous upstream completion and
      partial streams cannot replay. Root-depth native agent headers are accepted,
      unknown sessions and nested/foreign children are refused. Verify: host
      relay consuming tests; live provider acceptance remains separate.
- [ ] Signed actual-model observations survive a warm native model change.
      Alias guesses, fabricated quota text, forged signatures, wrong boot,
      request, lease, child, parent, scope, challenge and stale capacity refuse.
      Verify: `runtime/workers/claude-capacity-client.test.ts`.
- [ ] Fresh, queued and exact-survivor continuation reaches the unchanged
      consuming merge gates with one original child. Missing/tampered original
      receipts, scope, PID/start/boot, authorization or launch grants refuse;
      unavailable/adopted parents never spawn a replacement.
      Verify: `open/__tests__/project-build-e2e.test.ts` and
      `runtime/workers/claude-native-continuation.test.ts`.
- [ ] Completed/invalid results precede continuation. Concurrent claimants,
      postclaim restart and lost acknowledgements cannot resend. Exact invocation
      is paired with wrong-recipient, changed-prefix and nonce-conflict controls.
      Reconstructed workspace authorization never self-waits or bypasses another
      child's ownership. Missing-parent recovery still harvests an arriving
      original result. Verify: the same consuming and runtime suites.
- [ ] Two compatible, host-bound children can each enter original-child
      continuation while both retain their busy leases. Parent submissions stay
      serialized, including when an ordinary turn is queued first. An unbound
      candidate and a conflicting peer still block; stale or forged recovery
      evidence cannot mark a child bound. Cancellation leaves no orphaned queued
      submission and preserves the conflicting peer's busy lease. Verify through the real ReplSession
      queue in `runtime/workers/native-child-workspace.test.ts` and the signed
      continuation consumer in `runtime/workers/claude-native-continuation.test.ts`,
      with opposite source mutations and the project-build consuming suite.
- [ ] All-full remains durably and visibly waiting under the original lease.
      After quota clears, harvest first and continue the same ID once for that
      authenticated episode. Repeated genuine episodes continue after verified
      predecessor completion; SDK retries, delayed old requests, terminal ack
      alone and unresolved prior input cannot mint episodes. Verify: a consuming
      repeated-quota cycle through original result and existing merge gates,
      paired refusal controls, deadline and restart cases.
- [ ] Allow-all and deny-all mutations of the authority checks fail consuming
      refusal and success controls respectively. Root, Trident and Open
      typechecks pass, plus the complete project-build consuming file.
- [ ] Served acceptance proves real renewable account use and same-child
      post-rotation progress. Synthetic fixtures and fake native endpoints prove
      local behavior only. Until live evidence exists the live capability is
      UNKNOWN and #1416 remains open.

## Live proof still required

An explicitly authorized isolated native parent must produce an actual provider
quota rejection on account A with a future reset. A matched A-only request must
remain capped; after authorized selection of B, require a fresh child-attributed
response on the same parent and child before A's reset, and recheck A remains
capped. Verify request model and selected account generation through host
observations. Preserve publication gates. No credential copying, parallel bank,
manual shared-account switch or paid-key fallback is part of this proof.

The supported native OAuth environment mode has offline fake-endpoint evidence;
provider acceptance of a real renewable account is unverified. A file replacement,
launch-source descriptor, model metadata command, synthetic 429, selector receipt
or 401 recovery cannot establish real 429 account consumption. Same-ID native
tool invocation and fresh child response need their own explicit-grant positive
and omitted-tool refusal. No live provider or real credential access is authorized
by the local fake-only test workflow.
