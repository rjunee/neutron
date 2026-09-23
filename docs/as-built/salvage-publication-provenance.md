## 2026-09-23 — Preserve ownership of PRs created by build salvage

Tracked by #1217; acceptance is owned by
`docs/spec-items/salvage-publication-provenance.md`. A live failed build was
published by the outer stranded-work salvage after the project driver stopped.
The salvage row stored its PR number but no publication ownership. The next
retry carried the completed build and correctly refused the discovered PR.
The leak preflight's unrelated findings were advisory under G139, not the cause.

The outer publisher (`trident/publication.ts:344-359`) now distinguishes
discovery from a corroborated creation:
the successful create command must return a valid PR URL whose number matches
the separate PR observation. Missing, mismatched and timed-out responses grant
no ownership. A matching existing lineage receipt remains valid. A newly
corroborated receipt is written through the host's existing store-update seam
before later annotation and review-diff preparation. This explicit write matters
because full-snapshot saves deliberately leave `published_pr` untouched. The
outer re-fire result and boot salvage sweep retain the receipt as well
(`trident/orchestrator.ts:795,1454,1596,2414`).

The real consuming test (`open/__tests__/project-build-e2e.test.ts:2145`) builds
once, stops at publication proof, salvages through
the outer publisher, redispatches through the Work Board and runs the project
host. The owned case merges with zero new plan/build calls; its unowned sibling
keeps the discovered PR open. No prior receipt is inferred from a branch name,
matching commit, author or failure message, and no historical row is backfilled.
The original live PR therefore remains unowned. These static consuming E2E
cases establish the salvage ownership seam; ordinary fresh publication does not
directly exercise salvage.

Completion remains in progress under the locked pivot
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:278-295`). The unchecked
acceptance criterion requires the exact merged revision to be deployed and
served, positive and negative source controls on that served revision, and a
fresh adopted-chat Work Board dispatch reaching unattended merge. That live
dispatch establishes the served end-to-end regression. Deployment and live
acceptance evidence are still outstanding; the static results below do not
establish them.

Verification: 364 tests pass across the publisher, stranded real-git salvage,
orchestrator and boot-composition suites. The publisher tests cover valid,
missing, mismatched, timed-out, discovered and already-owned receipts, and prove
receipt recording precedes a later diff-output failure. Both new consuming E2E
cases pass. Removing the durable receipt write makes the owned retry lose its
ownership and fail; granting ownership to every discovered PR makes the unowned
case fail. Both mutants execute valid code and were restored. The complete
`open/__tests__/project-build-e2e.test.ts` passes all 209 cases. Root
`tsc --noEmit -p tsconfig.json`, Trident `tsc --noEmit -p trident/tsconfig.json`
and `scripts/ci/lint.sh` pass. The spec index tests pass all 38 cases.
