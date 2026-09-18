## 2026-09-18 — Preserve typed retry lineage across preparation failures

A retry could fail while creating its worktree, before `loadResume` wrote its own
typed checkpoint. The next dispatch then inherited its legacy `fix-round` string
without a source marker, and the composed host stopped with `Host resume
checkpoint is missing`. This extends the checkpoint continuity change recorded in
`docs/as-built/cross-run-typed-retry-checkpoint.md` within the unchanged-head scope
of `docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:13`.

`retryModeSource` now follows a failed predecessor's source marker when that run
has no own typed checkpoint (`trident/build-mode-state.ts:33`). Each immediate
predecessor, source event id and head stays pinned; every edge still validates
run, project, repository, branch, task, merge mode and base identity. Cycles refuse.
A real typed checkpoint remains authoritative, including an ineligible state.
Dispatch also treats a source marker as authoritative over a legacy projection
(`trident/board-dispatch.ts:1440`). No worker receipt or approval is copied.

The focused regression carries three consecutive source-only retries, keeps the
Ralph spend and cap, and imports the original checkpoint under the final run's
identity (`trident/cross-run-retry-checkpoint.test.ts:69`). Foreign ancestry,
changed source events, copied links, stopped predecessors, changed merge mode,
moved heads and cycles cannot acquire that state.

The consuming PR and local cases run real terminal cleanup, inject one failed
worktree creation, dispatch another linked run, and reach `merged` without another
plan/build/fix (`open/__tests__/project-build-e2e.test.ts:1154`). Both failed against
the original implementation with the missing-checkpoint outcome, while the focused
chain test found the missing source marker. Temporarily removing source run-id
validation made the copied-link refusal fail; removing the source-marker legacy
veto made the changed-mode refusal fail by inheriting `fix-round-3`. Both mutations
were restored. These tests use real Git and the composed host with fixture worker
and GitHub boundaries; they do not establish live model or cutover readiness.

Restored verification: the cross-run checkpoint, board dispatch, production host
effects and complete project-build end-to-end suites passed together (219 tests,
1,272 assertions). Root and Trident TypeScript checks both passed with `--noEmit`.
The tree leak gate returned incomplete: its available rules found nothing, but
the private PII denylists were unavailable.
