## 2026-09-18 — Launch falsification revokes the typed retry source

The retry contract permits carrying a checkpoint only while the branch holds its
recorded head (`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:13`).
Launch already falsified a dispatch-time seed when the branch moved, dropping the
shortcut and re-pinning a fresh base (`trident/launch-preparation.ts:146`). But the
typed source link survived that intentional change.

The consuming reproduction found a narrower defect than the initial hypothesis:
branch movement alone did not wedge the next dispatch. The full-row save excludes
the workflow-owned checkpoint head (`trident/store.ts:1948`). When the base also
advanced, however, preparation persisted the new base, failed its old-source
identity check, and the next dispatch returned an invalid-checkpoint backend
error. The branch-only positive control passed while the branch-and-base case
failed through the real orchestrator, project launcher, terminal save and next
board dispatch.

Launch now carries an explicit transient falsification observation: original
head/base and the measured different head (`trident/launch-preparation.ts:151`).
The store validates the still-original source, run identity and never-fired seed
before writing a `build-retry-source-invalidated` event (`trident/store.ts:1099`).
Preparation records it before changing the base (`open/wiring/project-build.ts:212`).
A pre-fire terminal save records it in the same transaction as the changed row
(`trident/store.ts:2251`). A failed event write rolls back that row mutation.

The reader accepts only an invalidation pinned to the exact source-link event,
its contents, original base and head, and run identity
(`trident/build-mode-state.ts:64`). An already recorded invalidation is idempotent;
a copied or changed source is not silently treated as absent. No row schema,
approval receipt, CI receipt, card link or Ralph budget was changed.

Nine consuming orchestration cases cover PR and local unmoved resumes, movement
before dispatch, branch-only movement, branch-plus-base movement, and a PR
pre-fire failure (`open/__tests__/project-build-e2e.test.ts:1158`). Unmoved cases
reach terminal success without rebuilding and preserve the review round. Moved
cases persist a terminal refusal and admit a subsequent fresh dispatch. The
source tests preserve spend 4 of cap 8, refuse unknown/unchanged heads and copied
links, and fault-inject the event write to prove rollback
(`trident/cross-run-retry-checkpoint.test.ts:53`).

Executed semantic mutations were restored: ignoring valid invalidation failed
both the budget/source case and the consuming branch-plus-base case; removing
the source-event equality admitted a replaced link and failed its refusal test.

Verification used the complete cross-run checkpoint, store, orchestrator and
consuming project-build end-to-end files, plus root and Trident TypeScript checks
and the lint gate. These are fixture worker/GitHub boundaries over real local Git
and SQLite, not a live service or unattended-publication claim. No full repository
suite was rerun for this follow-up. The broader retry acceptance, including
card-visible refusal delivery, is not claimed complete.
