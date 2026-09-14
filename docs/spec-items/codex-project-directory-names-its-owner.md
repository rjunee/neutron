---
title: Codex project credential directories name their owning project
group: trident
status: done
priority: P2
cutover: false
---

Issue #742. The fixed-width key selects a location; the full project id recorded
inside that location establishes its ownership. Decision: SPEC.md, 2026-09-14,
"Codex project credential directories name their owner".

## Acceptance

- [x] A connected project resolves its materialized credential after service
      reconstruction; a mismatched owner refuses resolution, reads, probing,
      connection and deletion before credential changes.
      Verify: `trident/codex-credential.test.ts`, "project directory ownership".
- [x] Missing, malformed and mismatched markers refuse; newly created directories
      record their full project id. Another project at the same derived location
      cannot read the first project's credential through the service.
      Verify: `trident/codex-project-owner.test.ts`.
- [x] Existing unmarked directories require explicit offline migration using an
      independently confirmed project id. Migration preserves refreshed credential
      bytes, refuses replacement of a different owner, and reports a same-owner
      no-op. The migrated copy resolves; the untouched original remains unmarked.
      Verify: both test files above, migration tests.
- [x] HTTP GET, POST and DELETE return 409 with `codex_project_owner_refused` for
      an ownership conflict; restoring the correct owner restores successful GET.
      Verify: `gateway/http/codex-credential-surface.test.ts`.
- [x] Bound review propagates ownership refusal instead of falling back to the
      global directory, and succeeds after repair.
      Verify: `trident/review-run.test.ts`.
- [x] Mutations disable each ownership safeguard and the consumer checks; the
      tests fail and pass after restoration. Evidence lives in the change's
      as-built record.
