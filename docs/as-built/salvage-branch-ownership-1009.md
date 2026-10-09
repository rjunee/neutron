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

Database transactions only acquire/check/release claims; Git and network calls
run outside them. Normal completion and exceptions release the exact token.
An interrupted claim remains held across process/database reopening and cannot
be stolen by age or a different token. This change does not provide automatic
recovery of an interrupted branch reservation or settle native-child ownership.
The held card remains queued and retries after its operation releases the claim;
unrelated branches remain available.

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

The complete shared-host check and final reviews/CI remain pending; their exact
receipts will be recorded before publication. This source change alone does not
establish deployed unattended single, sequence or concurrent acceptance.
