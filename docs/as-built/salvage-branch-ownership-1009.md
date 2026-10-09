## 2026-10-09 — Reserve live branches against stranded salvage

The startup sweep disabled checkout inspection for an old failed run when a
newer run owned its branch, but still allowed publication. Publication can replay
commits onto current main and move the shared branch. A pending read-only review
then correctly refused its changed input. A real-Git regression reproduced the
branch movement against the original orchestrator with an already published
candidate, advanced main, an old failed row with no PR, and a live review owner.

Admission and every stranded reconciliation now share a durable branch
reservation in the project database. Repository identity is Git's common
directory, so linked worktrees and symlink aliases cannot obtain distinct claims
for the same refs. Admission reserves before branch-dependent remote/seed reads
and retains the claim through run creation. The run store checks the reservation
again in its insertion transaction. Salvage checks the complete live-owner set,
across project scopes, and retains its claim through checkout capture, replay,
publication and publication-receipt persistence. Missing composition or unknown
ownership refuses salvage. The existing review-input and publication gates stay
in force.

Database transactions acquire/check/release claims, including bounded Git
identity reads. Checkout capture, replay, publication and network calls run
outside them. Normal completion and exceptions release the exact token.
An interrupted claim remains held across process/database reopening and cannot
be stolen by age or a different token. This change does not provide automatic
recovery of an interrupted branch reservation or settle native-child ownership.
Ordinary held cards remain queued and can be retried after the operation
releases its claim; unrelated branches remain available. Recovery contention returns a typed
refusal without changing the card or consuming its one-use source: a competing
refusal write would invalidate the winning admission's captured card version.
The same authorized recovery succeeds after the holder releases its claim.
The identity scope is a local shared Git repository, not separate clones of one
remote. An unreadable same-branch repository identity fails closed.

The tests cover both admission/salvage orderings, separate database connections,
retained claims, unknown ownership, direct reconciliation, linked worktrees,
path aliases, ownership beyond the old startup census limit, absent composition,
and legitimate unowned publication. The consuming real-Git control checks both
refs, checkout status, and the pending review row. The existing project-build
E2E salvage/provenance controls are part of validation.

The original orchestrator failed the new live-review control by changing its
branch head. The corrected focused regression passed 649 cases before the
linked-worktree review correction; the affected post-correction suites passed
315 cases, including the linked-checkout admission refusal. The four consuming
project-build E2E salvage/provenance cases passed, as did the Trident TypeScript
check. Four semantic mutations were killed: dropping the live-owner predicate,
using distinct checkout identities for linked worktrees, refusing all salvage,
and releasing the claim before salvage completes. The restored controls passed.

The first complete-check attempt at `4463ca0e72d844a10d4e13340a803c8d8a8df688`
found three migration expectations missing ordinal 170 and a parallel-recovery
race introduced by the reservation refusal. The correction updates those
expectations and keeps reservation contention from writing a competing card
refusal. Its four focused files passed 134 tests, and the Trident TypeScript
check passed. Removing the contention distinction failed the new consuming
control; restoring it passed all 13 recovery tests. All E2E orchestrator
constructors now use the production store guard; the three selected restart,
corrupt-recovery and concurrent-authority cases passed after correction.
Nonblocking review follow-ups are recorded in #1471. The existing subprocess
setup failure tracked by #1457 was also reproduced.

The original shared-host run executed all 1,801 discovered files, with
28,017 passes, 24 skips and 7 failures. The seven failures were the three
migration expectations, two recovery-race consumers, an ordinary-salvage
fixture missing the reservation seam, and the existing #1457 subprocess error.
All 51 typechecks passed. Documentation edits during that run also made its
final clean-tree identity unavailable, so it does not establish a stable-input
suite receipt. The failures and that rejection remain recorded.

The corrected branch and the companion invalidated-review ownership repair were
validated together at `164112fef451829fcb78002b0f15714dd30d1df0` with
`bash scripts/check-shared-host.sh`. Lint and all 51 typechecks passed. The
complete suite executed all 1,801 discovered files: 28,069 passed, 24 skipped
and one failed. The general batches, database lane, device lane and both HTTP
batches all completed. The sole failure was the existing #1457
`project-owner-retirement.test.ts:12` subprocess setup error; that file is
unchanged from base `8e473fcc9b412938ab80c79c0a5fbbe2efd81b00`. The gate exited
1 and confirmed unchanged input identity
`6a20d7eed2b7bb60ea822dafda30c183192cfba1015834c34a827c6467439704`.
This is a stable-input failed receipt, not a full-suite pass.

`bash scripts/ci/depcruise.sh` passed with no new cross-band violations.
The local full-tree privacy scan reported 452 findings, including worktree
metadata. Scans of the 25 changed-file contents plus LICENSE at the base and
candidate each reported the same eight findings after line-number normalization:
seven in existing system-overview prose and one in an existing store comment.
Both corpus scans remain FAIL and do not cover commit messages or PR prose.
Separate publication-text preflight and exact-head CI remain required.

Native and bounded cross-model source reviews approve the combined source.
The publication delta after the completed check records evidence only; no full
receipt is transferred to a different input identity. Final receipt review and
green exact-head CI remain merge gates. This source change alone does not
establish deployed unattended single, sequence or concurrent acceptance.
