---
title: Independently scan reviewed commit messages before merge
group: trident
status: open
priority: P1
cutover: false
---

Work state: remaining pre-merge admission scope from PR #1171, using #1133's
G166 scanner. Publication already checks messages; merge must independently
measure the immutable reviewed history, including previously published owned
PRs and local-mode builds. Reuse the authenticated raw-object scanner and its
origin-observed public-base window. A public base commit above the launch pin
is excluded only under the existing ancestry rules; a branch-owned carrier
beneath a clean tip is refused. Missing or incomplete evidence refuses merge.

The ownership, draft, CI, reviewed-head and pinned merge gates remain required.
This is admission, not message rewriting or historical repair. G100 preservation
and the advisory leak preflight retain their existing contracts.

## Acceptance

- [x] Local and PR merges independently refuse a branch-owned session-trailer
  carrier beneath a clean reviewed tip, without updating the base or merging
  the PR. A PR carrier refuses before a draft-ready write. Verify with real Git
  through `trident/production-host-effects.test.ts` and the consuming
  `open/__tests__/project-build-e2e.test.ts` host.
- [x] A clean reviewed branch, including harmless body mentions and coauthors,
  merges when its base includes an already-public carrier above the launch pin.
  The same public window must still refuse a new branch-owned carrier.
- [x] Failed, truncated, or throwing raw reads refuse at merge even when earlier
  publication succeeded. Existing ownership, draft, CI and pinned merge tests
  remain green.
- [x] Paired semantic mutations prove that removing pre-merge admission allows
  the forbidden merge and that scanning the full launch window refuses the
  valid public-base sibling. Restore the implementation, pass focused tests,
  the consuming E2E suite, and root/open TypeScript checks.
