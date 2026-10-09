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
Ordinary held cards remain queued and retry after the operation releases its
claim; unrelated branches remain available. Recovery contention returns a typed
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

The complete corrected shared-host check and final reviews/CI remain pending; their exact
receipts will be recorded before publication. This source change alone does not
establish deployed unattended single, sequence or concurrent acceptance.
