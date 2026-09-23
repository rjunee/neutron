---
title: Preserve publication ownership when salvaging a failed build
group: trident
status: done
priority: P0
cutover: true
---

# Salvage publication provenance

Work state: #1217. The locked pivot retains the publication and pinned merge
gates (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271-274`). Recovery
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
branch, head, author or failure text. Deployment acceptance uses a fresh
publication; this change does not backfill historical rows.

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
