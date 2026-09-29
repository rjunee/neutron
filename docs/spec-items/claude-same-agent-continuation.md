---
title: Continue a quota-limited Claude child on its original native agent ID
group: trident
status: open
priority: P0
cutover: true
---

Issue #1416 is the inbox reference. The locked pivot
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md` §3.2 and §4) requires
same-provider work inside the project REPL and retains the publication/review
gates. `a-gateway-restart-keeps-the-project-repls.md` requires harvesting completed
work before continuation and preserving at-most-one dispatch.

An exact provider quota rejection may authorize one bounded `SendMessage` parent
submission addressed to the original native `agentId`. This continues the original
request and its worktree, result contract and durable child lease. It does not
re-enter `Agent`, switch substrate, rotate credentials, release ownership on a 429,
or bypass a publication/result validator. General errors and assistant prose are
not quota evidence. The host binds the provider rejection identity and digest,
original signed receipt, request, child, lease, parent and transcript boundary in
the durable continuation claim before input. The claim has no refund or expiry.

The original host-signed dispatch receipt must include a host-observed launch
profile for the exact project, parent session and generation: executable digest
and version, argv and explicit `Agent,SendMessage` grants. The accepted profile is
pinned in `CLAUDE_CONTINUATION_PROFILE`; a version string or argv assertion alone
is insufficient. This authenticates launch inputs, not a served tool catalog or
an executed process image. Missing/mismatched launch evidence remains UNKNOWN;
a current launch without `SendMessage` reports tool-unavailable. Old parents
without the signed observation stay fenced. No state permits a replacement child.
For a new child dispatched after parent adoption, the host may remeasure the
survivor's kernel executable, exact argv and process-start identity, cross-check
the pane host, and record the observation only after ownership publication. That
observation enters the new child's signed original receipt. Mutable registry
labels alone never provide launch evidence; an Agent-only survivor remains
unavailable. Executable/argv adoption does not authenticate the survivor's
effective authentication. Without the original fresh host file-auth observation,
capacity admission stays UNKNOWN even when the tool launch is known.

A lost acknowledgement or restart makes the saved attempt observation-only.
Authorized startup restoration may change the parent process generation while
preserving its recorded native session and scope. The original signed parent
identity remains provenance. A new submission requires a host-observed accepted
launch for the current generation, or an adopted survivor with exactly the signed
original PID and kernel process-start identity. The signed original launch remains
required in either case. A spent claim remains observation-only across restoration.
Reconciliation can identify the exact `SendMessage` tool invocation by parent
session, post-claim transcript boundary including the original prefix digest,
native recipient and nonce-bound input. Parent text, another recipient, replaced
transcripts, shortened or changed prefixes and same-nonce conflicting invocations
preserve UNKNOWN. Prefixes larger than 64 MiB or observation tails larger than
4 MiB refuse reconciliation. A terminal acknowledgement establishes only parent
input; an exact tool invocation establishes only invocation. The original result
validator still decides completion, and completed work always takes precedence.
Unavailable continuation preconditions do not suppress passive original-result
recovery. Both initial and resumed result observation use the same bounded,
stable regular-file reader; symlinks, FIFOs and changing snapshots refuse safely.

## Acceptance

- [ ] A typed exact-child quota rejection plus authenticated pinned launch permits
      one same-ID continuation and the consuming Open build reaches the unchanged
      merge gates. Known-unavailable and foreign launch profiles refuse with no replacement
      `Agent`, no merge and the original child lease retained.
      Verify: `bun test open/__tests__/project-build-e2e.test.ts`.
- [ ] An adopted parent without a fresh host authentication observation refuses
      capacity input, as does an adopted Agent-only parent. Independently observed
      executable/argv alone cannot authorize selection. Verify: the same consuming suite.
- [ ] Completed and invalid current results take precedence; ordinary errors,
      foreign request/receipt/lease/launch, fencing and expired budget cannot send.
      A concurrent claimant, lost acknowledgement and a newly constructed observer
      cannot spend another continuation. Exact invocation reconciliation is paired
      with wrong-recipient and unobserved-input controls.
      Verify: `runtime/workers/claude-native-continuation.test.ts` and admission tests.
- [ ] Reconstructed workspace proofs for the same admitted child do not self-wait.
      Its continuation can pass ordinary input queued before that child yielded,
      but never overlap active parent input or bypass a different bound child.
      Normal input keeps FIFO ordering and original busy ownership is retained.
      Verify: continuation and native-child-workspace runtime tests.
- [ ] Missing-parent recovery still observes an original result arriving after its
      first harvest, without quota evidence or new input. Unsafe and invalid result
      controls retain ownership. Verify: `open/__tests__/project-build-e2e.test.ts`.
- [ ] Semantic allow-all and deny-all launch mutations fail the consuming refusal
      and success tests respectively. Both root and Trident typechecks pass.
- [ ] Served acceptance records the pinned project launch and actual successful same-ID
      continuation; synthetic fixtures establish local behavior only. Until that
      observation exists the live capability remains UNKNOWN, and #1416 remains open.

## Live proof still required

Run an explicitly authorized isolated native project session under the pinned
launch profile. Require an original native child, an actual `SendMessage` tool
invocation to that ID, and a fresh child-attributed response. Pair an omitted-tool
control with the explicit-grant positive. Neither model prose nor the launch
observation itself establishes tool execution. An unavailable tool, missing exact
invocation, conflicting recipient or inconclusive response remains UNKNOWN.
The host launch producer and signed receipt are implemented; this live native
positive remains a release prerequisite, not a synthetic fixture result.

For behavioral cross-account continuity, a disposable project parent using the
normal Managed-owned file-auth destination must first produce a genuine
quota-category 429 on account A with a future reset. Do not copy credentials,
create another credential bank, or manually force a shared account switch
for this proof. Use the approved authenticated local capacity socket and normal
exact-model selection after a natural rejection. A matched
A-only same-ID continuation must fail. After the authorized account selector
installs B, require the same parent session and child ID to answer a fresh
post-rejection challenge with a new child-attributed provider response before A's
reset, and confirm A remains capped afterward. Exclude other credential sources
and concurrent writers. Keep all publication gates. This is behavioral evidence,
not cryptographic proof of the token used by each request. File replacement,
mtime, selector receipts, synthetic 429 fixtures and 401 recovery alone cannot
establish 429 account consumption. Failure to complete these controls is UNKNOWN.

## Capacity admission

Before spending the one-use continuation claim, Open obtains an exact-model
capacity response over the authenticated local Unix endpoint. Independently
provisioned, protected public verification material binds the host, instance,
socket and canonical credential directory. Open verifies the signature, current
boot, fresh challenge, request digest, original lease, native child, provider-event
digest and observation freshness. Competing authentication sources refuse.
Admission additionally requires a fresh host observation of the actual launch
environment and explicit settings sources, bound to the measured parent process
identity and preserved in the signed original launch. Known socket, descriptor,
helper, profile and settings-env routes refuse. Changed observed sources revoke
admission. This conservative observation is not a claim of complete native
effective-auth attestation; unknown sources and legacy/adopted parents without
the original observation remain unavailable.
`available` retains the direct connection through bounded submission and saves
the signed opaque account generation in the durable claim; this is selection
evidence only. Before a claim, `all-full`, `unknown`, missing authority and
transport failure neither spend the claim nor release the child. After a claim,
transport loss, freshness expiry and unknown submission remain spent: they
cannot license another input. Original-result harvesting and
spent-claim reconciliation remain independent of current capacity.

- [ ] Real-socket consuming controls exercise signed availability, all-full,
      uncertainty, forged and miscorrelated responses, disconnect and competing
      auth; no refusal dispatches a replacement or reaches merge.
      Verify: `bun test open/__tests__/project-build-e2e.test.ts` and
      `runtime/workers/claude-capacity-client.test.ts`.
- [ ] Default native model aliases have an authoritative resolved-model binding
      before requesting capacity. A guessed alias mapping, model prose or
      worker-writable transcript is not authority. The fresh Fable path must bind
      host-owned zero-inference native metadata under protected executable and
      launcher ancestry to the actual parent model and native family override.
      Require exact environment/settings parity and reject model force, policy,
      hooks or contradictory auth-source metadata. Other unbound aliases remain
      UNKNOWN; a concrete-only fixture does not complete ordinary Fable recovery.
      Verify: `runtime/adapters/claude-code/persistent/__tests__/native-model-launch.test.ts`
      and the alias cases in `open/__tests__/project-build-e2e.test.ts`.

The current capacity protocol does not retain an A-only native failure, an
old-account reset receipt or a post-B observation that A remains capped. Those
live controls remain open. Fresh-parent auth observation currently exists only in
host memory: restoring its authenticated provenance for a surviving parent across
gateway restart is also required. Legacy parents without it remain UNKNOWN.
