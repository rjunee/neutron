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

The parent must have an independently observed native tool catalog bound to its
session and current process generation. An argv allowlist, static source string,
model assertion, or catalog from another session is insufficient. Existing
sessions without a read-only provider catalog probe explicitly remain UNKNOWN.
An observed catalog lacking `SendMessage` reports tool-unavailable. These states
retain ownership and expose the unresolved capability; they never fall back to
a replacement child or silently claim continuity.

A lost acknowledgement or restart makes the saved attempt observation-only.
Reconciliation can identify the exact `SendMessage` tool invocation by parent
session, post-claim transcript boundary, native recipient and nonce-bound input.
Parent text, another recipient, replaced/truncated transcripts and conflicting
invocations preserve UNKNOWN. A terminal acknowledgement establishes only parent
input; an exact tool invocation establishes only invocation. The original result
validator still decides completion, and completed work always takes precedence.

## Acceptance

- [ ] A typed exact-child quota rejection plus measured current catalog permits
      one same-ID continuation and the consuming Open build reaches the unchanged
      merge gates. Known-unavailable and foreign catalogs refuse with no replacement
      `Agent`, no merge and the original child lease retained.
      Verify: `bun test open/__tests__/project-build-e2e.test.ts`.
- [ ] Completed and invalid current results take precedence; ordinary errors,
      foreign request/receipt/lease/catalog, fencing and expired budget cannot send.
      A concurrent claimant, lost acknowledgement and a newly constructed observer
      cannot spend another continuation. Exact invocation reconciliation is paired
      with wrong-recipient and unobserved-input controls.
      Verify: `runtime/workers/claude-native-continuation.test.ts` and admission tests.
- [ ] Semantic allow-all and deny-all catalog mutations fail the consuming refusal
      and success tests respectively. Both root and Trident typechecks pass.
- [ ] Served acceptance records the actual parent catalog and successful same-ID
      continuation; synthetic fixtures establish local behavior only. Until that
      observation exists the live capability remains UNKNOWN, and #1416 remains open.

## Live proof still required

Run an explicitly authorized isolated native session and observe its provider
catalog through a read-only provider instrument bound to session ID and process
generation. Install that instrument as `ReplSession.probeNativeToolCatalog`; an
operator must not assign names based on argv or a model's description. The current
Open adapter exposes this seam but has no production provider-catalog instrument.

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
