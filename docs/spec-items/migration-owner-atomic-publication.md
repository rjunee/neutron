---
title: Publish complete migration ownership markers without replacement
group: platform
status: done
priority: P0
cutover: true
---

# Publish complete migration ownership markers without replacement

The locked pivot plan requires keeping the gates
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271-274`). The honesty
contract says unknown authorises nothing (`docs/INVARIANTS.md:1058-1060`).
Nexus must round-trip concurrent append
(`docs/plans/2026-07-02-world-class-refactor-plan.md:1861-1871`).

The shared migration runner must publish complete ownership claims. Publishing
an empty marker before writing its owner made simultaneous Nexus first writers
refuse migration. Ignoring a competing claimant without validating its identity
also allowed the losing runner to migrate under an unverified owner.

## Acceptance

- [x] A first ownership claim publishes only complete bytes without replacing
      an existing marker. A second Nexus writer paused at the first writer's
      open-before-write boundary succeeds, preserving both appends and one
      migration ledger row.
      verify: `bun test gateway/nexus/__tests__/init-contention.test.ts`
- [x] Existing and competing foreign or malformed markers refuse before any
      schema or ledger write and retain their original bytes. Losing an
      exclusive first claim never grants migration authority. An unreadable
      dangling marker is not treated as absence.
      verify: `bun test gateway/nexus/__tests__/init-contention.test.ts migrations/__tests__/migrate-owner-refusal.test.ts`
- [x] An unsuccessful private first-claim write leaves no public malformed
      marker. Existing tolerance for an absent marker on unwritable media and
      in-memory databases remains usable. Failure to publish completed bytes
      on writable media refuses rather than silently proceeding unclaimed.
      verify: the same consuming and ownership-refusal suites
- [x] Semantic mutants for partial publication, skipped winner validation,
      foreign-owner admission, and own-owner refusal make the Nexus consuming
      assertions fail while the unchanged control passes.
      verify: `bun test migrations/__tests__/migrate-owner-publication-mutation.test.ts`
