## 2026-09-30 — Align focused project wiring tests with native continuation admission

The focused wiring tests still expected the general live tool profile, while
the project profile includes the continuation tool. They also expected receipt
reconciliation after a repeated acting turn, although the unique independent
workspace admission now refuses that repeated admission first.

`open/__tests__/project-build-wiring.test.ts:35` defines the expected project
profile from the live tools and the canonical continuation tool name. The
dispatch retains the shared profile identity assertion at line 1092. The cold
session fixture uses a real linked worktree and verifies one successful submit,
followed by the exact workspace refusal and no second submit at lines 594–600.
Missing, unlinked and mismatched request directories refuse before submission
at lines 603–628.

The real persistent pool and argv builder reuse the current profile, then
replace the warm session when continuation is removed at lines 1151–1175.
A temporary fixture mutant that retained the original profile failed on the
observed warm reply (`seen=2` rather than `seen=0`); restoring the changed
profile passed. Production guards and merge gates are unchanged.

Validation: `bun test open/__tests__/project-build-wiring.test.ts` passed all
57 tests. The changed-profile semantic mutant failed, and the restored focused
control passed. Root and Trident TypeScript checks both passed.
