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

## Original-child continuation

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

- [ ] The native launcher registers the exact process before first chat; broken
      registered routes refuse without direct-auth fallback or credential 429.
      Stable host account rotation retains warm transport identity; changed
      host/instance/socket/key and revoked registration refuse. Self-host direct
      authentication retains its existing behavior.
      Verify: native-request-relay, auth-fingerprint and launch tests.
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
