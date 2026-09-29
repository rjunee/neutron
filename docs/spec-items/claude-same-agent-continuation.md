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

For behavioral cross-account continuity, an isolated file-auth profile must first
produce a genuine quota-category 429 on account A with a future reset. A matched
A-only same-ID continuation must fail. After the authorized account selector
installs B, require the same parent session and child ID to answer a fresh
post-rejection challenge with a new child-attributed provider response before A's
reset, and confirm A remains capped afterward. Exclude other credential sources
and concurrent writers. Keep all publication gates. This is behavioral evidence,
not cryptographic proof of the token used by each request. File replacement,
mtime, selector receipts, synthetic 429 fixtures and 401 recovery alone cannot
establish 429 account consumption. Failure to complete these controls is UNKNOWN.
