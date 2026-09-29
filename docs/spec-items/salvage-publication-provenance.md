---
title: Preserve publication ownership when salvaging a failed build
group: trident
status: done
priority: P0
cutover: true
---

# Salvage publication provenance

Tracked by #1217. The locked pivot retains
the publication and pinned merge gates
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271-274`). Recovery
must preserve completed work and provenance
(`docs/spec-items/trident-build-efficiency.md:154-166,190-201`).

A terminal build may be published by the outer stranded-work salvage after the
project driver stops. The publisher must preserve a witnessed creation receipt
so a later retry can identify the PR as belonging to this run lineage. Finding a
PR on the same branch is insufficient: it may belong to someone else. A receipt
contains the number returned by the successful create command, corroborated by
the independently observed PR. A pre-existing matching lineage receipt remains
valid. Missing, mismatched or timed-out creation responses grant no ownership.

Persist a new receipt before optional annotation and later diff preparation can
fail. The boot salvage sweep and ordinary outer publication must retain the same
ownership. A retry still runs publication proof, review and pinned merge gates.
Historical PRs without a durable receipt are not adopted by guessing from their
branch, head, author or failure text. This change does not backfill historical
rows. Static consuming E2E tests prove the salvage ownership seam; a fresh live
dispatch proves the served end-to-end regression, without claiming that ordinary
fresh publication directly exercises salvage. Completion requires both forms of
evidence under the locked pivot
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:278-295`).

## Acceptance

- [x] A successful salvage creation records `published_pr` durably, and the real
  board retry carries it into the project driver without planning or rebuilding.
  Verify: `trident/stranded-salvage-realgit.test.ts` and
  `open/__tests__/project-build-e2e.test.ts`.
- [x] A discovered PR and missing, mismatched or timed-out create receipts do
  not gain ownership; a matching existing lineage receipt remains valid.
  Verify: `trident/publication-session-trailer-realgit.test.ts` and the paired
  consuming E2E case, which keeps the unowned PR open.
- [x] A failure after corroborated creation cannot erase its durable receipt;
  failures before corroboration cannot mint one. Verify with the publisher's
  receipt callback and a failure during subsequent diff preparation.
- [x] Semantic mutations that discard a valid receipt or adopt a discovered PR
  fail the consuming tests. The restored implementation passes, including both
  TypeScript checks.
- [x] The exact merged revision is deployed and served on the target instance,
  verified with positive and negative source controls: the served source contains
  corroborated creation receipt recording, and the superseded receipt-dropping
  salvage path is absent, with a known-present control checked by the same
  source inspection. A fresh Work Board card dispatched from an adopted chat
  reaches merged with no human intervention. Record the merged and served
  revision, source-control evidence, dispatch/run identity and resulting merge.
  This live dispatch establishes the served end-to-end regression; the static
  consuming E2E cases above establish the salvage seam.

## Interrupted project publication

The project driver must retain a successful PR creation response before its
independent PR inspection. Store that response in the run's existing stage
events, bound to its run, project, repository, worktree, branch, base, merge
mode, target branch and published head. A response alone grants no ownership:
the restarted host must independently observe the exact PR, OPEN at the same
head on the same source and target branches, before recording `published_pr`.
The publication, review and pinned merge gates still apply.

- [x] Restart after the response is saved but before PR inspection or ownership
  persistence resumes publication with exactly one creation, including repeated
  recovery. Verify: `trident/production-host-effects.test.ts`, `publication restart`.
- [x] Missing, corrupt, mismatched or uncorroborated response evidence cannot
  authorize ownership or repeat creation. A malformed latest response cannot
  revive an older valid one. Verify: the same tests and the existing foreign-PR
  discovery refusal control.
- [x] A failed response write leaves the independently discovered PR unowned.
  Recovery never infers the lost response from a branch or matching head.
  Verify: `publication restart cannot invent a create response when its durable write failed`.

A crash before the successful response reaches durable storage remains
unresolved. This slice does not establish interrupted native worker recovery,
release native-child leases, or prove unattended recovery across an actual
gateway, terminal-host or machine restart.

Live acceptance: [sequence and publication witness](../as-built/trident-sequence-and-publication-live-acceptance.md).

## Card lineage after an intermediate failure

Tracked by #1418. An intermediate terminal attempt can become the card's linked
run without creating a PR. That attempt must not erase an earlier witnessed
publication for the same card, repository and generated branch. Ownership may
come only from a durable `published_pr` on an earlier terminal PR-mode run in the
card's terminal-attempt ledger, anchored to the exact currently linked run. Both
run start order and ledger insertion order must precede that anchor. Observed
PR numbers never grant ownership. This carries publication ownership only;
completed-build reuse still follows the existing checkpoint and task bindings.

- [x] The real board retry can retain an earlier same-card creation receipt
  across an intermediate failed attempt, while its discovered-PR sibling remains
  unowned and unmerged. Verify: `salvaged publication` consuming cases in
  `open/__tests__/project-build-e2e.test.ts`.
- [x] Changed repository, branch, project, card, missing anchor, later start,
  later ledger entry, local mode and nonterminal owners cannot supply a receipt.
  Direct linked-run receipts remain scoped to their original repository and
  branch. Verify: `earlier card publication provenance` in `trident/store.test.ts`
  and the linked-receipt controls in `trident/board-dispatch.test.ts`.
- [x] Removing valid lineage inheritance or substituting an observational PR
  fails the corresponding consuming control; removing the SQL mode, chronology
  or anchor boundary fails its refusal control with the valid sibling passing.
