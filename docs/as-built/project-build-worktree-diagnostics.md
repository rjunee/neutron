## 2026-09-22 — Preserve bounded evidence when build worktree creation fails

A retry can fail before its first worker starts when its assigned branch is
still checked out by a predecessor. Preparation previously reduced every failed
`git worktree add` to the same message, hiding the difference between branch
ownership, a path collision, storage failure and a timed-out observation.

`open/wiring/project-build.ts:213` classifies at most 4096 characters from each
command stream into fixed diagnostic labels. The result includes a bounded exit
code and timeout observation. Raw output, command arguments and exception text
are excluded from both the thrown failure and the durable stage event.
`open/wiring/project-build.ts:268` records `build-worktree-add-failed` before
refusing preparation; if the record cannot be written, the same bounded failure
explicitly reports that the diagnostic was not recorded.

This change adds evidence, not reclamation authority. A terminal database row
does not prove that a worker or delayed predecessor cleanup has stopped. No
branch handoff, worktree removal or cleanup change is introduced.

The real-git consumer at `open/__tests__/project-build-e2e.test.ts:909` creates a
terminal predecessor holding the assigned branch, observes the durable
`branch-held` diagnostic, verifies that the holder and commit survive unchanged,
and verifies that no worker ran. After the fixture explicitly releases its clean
old tree, the retry reaches `merged`. The adjacent cases cover path collisions,
permissions, storage exhaustion, timeout, unclassified output, bounded input and
a thrown command observation.

Validation: the worktree-add focused consumer passed all nine cases. Replacing
the failure gate with `false` lost the classified failure and made the real-git
test fail; replacing it with `true` rejected successful creation and also made
that test fail. Both mutations were restored. Root and Trident TypeScript checks
passed. The complete project-build E2E file passed all 117 tests in an
unsandboxed invocation; the sandbox denied its local socket fixtures. The local
full-tree purity scan reported existing denylist matches and the linked-worktree
administrative pointer, so it is not claimed green.
An export containing the three changed files and the license passed the same
purity gate with zero findings and zero allowlist suppressions.
