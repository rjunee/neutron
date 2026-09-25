---
title: Admit dependency installation only with measured disk headroom
group: trident
status: open
priority: P1
cutover: false
---

# Trident dependency installation disk admission

Before the host installs Bun workspace dependencies, measure filesystem space
available to the installer at the worktree destination. Unknown space or less
than 5 GiB pauses installation before any installer or build worker is launched.
At least 5 GiB permits the existing installation and verification path. Retrying
after capacity recovers must work without changing policy or bypassing a gate.

This is an admission snapshot, not a reservation of an installation's unknown
eventual size or a guarantee against concurrent disk consumption. It does not
evict active work, manage scratch ownership, or intercept arbitrary shell
installs. A valid dependency receipt still avoids installation and runs the
existing readiness verifier without requiring new installation headroom.

## Acceptance

- [ ] Unknown, failed, negative, and below-threshold measurements refuse the
      actual host installer and leave no reusable success receipt or worker
      dispatch. Measure the destination filesystem's available blocks.
- [ ] Exactly 5 GiB and above admit installation; a refused attempt succeeds
      after space recovers and its installed dependency is actually consumed.
- [ ] Valid receipt reuse under low space still runs readiness verification,
      without calling the install-space probe or reinstalling dependencies.
- [ ] Exercise these cases through `open/__tests__/project-build-e2e.test.ts`;
      relaxing the refusal and over-applying it must each make a test fail.

The locked gate requirements remain in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271-295`.
