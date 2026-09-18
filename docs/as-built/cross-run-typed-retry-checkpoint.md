## 2026-09-18 — A new retry run consumes its predecessor's completed typed checkpoint

The retry specification requires a card's retry to preserve completed review-capable
work and its review round (`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:13`).
The dispatch seed only populated legacy `inner_checkpoint` columns, while the typed
host loaded `build-mode-state` events belonging to the new run. A real predecessor
at a fixed checkpoint, round 3 and Ralph spend 4/8, therefore produced a new row
with the budget but no resumable typed state. The new focused regression first
failed with `Host resume checkpoint is missing`; reading the predecessor through
its original host was the positive control.

Dispatch now validates completed typed state under the predecessor's own identity,
then records an explicit source link in the same transaction that creates the row
(`trident/board-dispatch.ts:1432`, `trident/store.ts:1016`). Exact card linkage,
task, project, repository, branch, mode and live head still govern adoption.
`trident/build-mode-state.ts:32` accepts a failed predecessor at `fixed`, or at
`built` outside Ralph mode. Approval, rejection, stopped runs, unresolved pending
workers and bare Ralph task builds do not authorize this review shortcut.
Any typed checkpoint supersedes the legacy seed projection. Native review found
that a second retry could otherwise revive the first retry's old `fix-round`
column after its typed state became approved, rejected or pending. Three chained
producer-to-consumer regressions failed before the veto and pass with it.

The host reads the source again and mints a checkpoint bearing the new run and
worktree identity through the existing compare-and-append operation
(`trident/production-host-effects.ts:253`). The original event is never relabeled.
Source event changes and copied links are rejected. A source write failure rolls
back the new row; the regression also restores the writer and proves the same
source is then admitted. Importing cannot lower a newer card-owned iteration count.
Terminal cleanup may already have removed the predecessor's worktree; importing does not use that historical
path. Active same-run reconstruction retains the exact worktree check
(`trident/build-mode-state.ts:14`).

Publication and suite assessment need the predecessor's completed worker artifacts,
too. Preparation reads them through the validated source chain under their original
run directories (`open/wiring/project-build.ts:400`). New results take precedence;
missing or invalid build evidence cannot establish the measured revision. Plan
artifacts may precede later fixes to the same task. No worker reservation, review
approval, CI receipt or publication receipt is transferred. Review and release
gates execute for the new run.

The consuming regression at `open/__tests__/project-build-e2e.test.ts:1154` creates a
completed predecessor, runs the actual host cleanup, dispatches a new linked run using the
default branch reader, reconstructs the composed host and reaches `merged` without
another plan/build/fix dispatch. It covers PR and local builds plus a governed
round-2 fixed checkpoint; local mode makes no GitHub command. This is a new-row
checkpoint test, distinct from the same-row restart tests and the separate fresh
retry publication regression.

Actual PR cleanup also deletes the local branch once origin holds the same head.
An earlier fixture removed only the worktree and missed that preparation recreated
the branch at the base. Tightening it to actual cleanup made both PR cases fail.
Preparation now restores an absent branch at the validated source commit; PR mode
first fetches the branch and requires its observed head to match
(`open/wiring/project-build.ts:220`). A separate case moves the remote after
dispatch and proves preparation refuses without creating a local branch or starting
workers.

Verification: 380 tests and 1,827 assertions passed across the focused cross-run suite, retry checkpoint suite, board
dispatch suite, store suite, project host suite and the consuming project-build
end-to-end suite. Both `tsc -p tsconfig.json --noEmit` and
`tsc -p trident/tsconfig.json --noEmit` passed. Five executed mutations failed:
accepting a moved head, refusing a legitimate fixed checkpoint, accepting a copied
source link, removing predecessor artifact lookup, and accepting a moved fetched
branch. Removing artifact lookup failed all three
cross-run merged-outcome cases. Each mutation was restored.

The tree leak gate reported no findings from the rules it ran, but exited
incomplete because the private PII denylists were unavailable.

This does not close the entire retry spec. Legacy-only checkpoints have no typed
mode-state event to import; card-visible refusal text is still outside this change.
Ralph continuation checkpoints retain their existing separate continuation path.
No live service, database, model worker or external PR was used in these tests.
