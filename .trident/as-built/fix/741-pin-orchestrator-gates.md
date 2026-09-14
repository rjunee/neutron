## Pin the seven orchestrator gates — issue #741

### Change and evidence

Tests only: 25 new cases, enumerated by the seven gate IDs in the staged issue.
The existing real-Git fixture gains an optional conflict-file count to exercise
progress for twelve turns (trident/publish-rebase-realgit.test.ts:147, :167, :192).
No production behavior or product decision changed.

| Gate | Consequence pin | Production evidence |
| --- | --- | --- |
| G018 | Invalid dispatch identities fail without firing; a valid identity launches. trident/orchestrator.test.ts:329 | trident/orchestrator.ts:4552 |
| G083 | Invalid publication mode, failed head read, empty/abbreviated/nonhex head cannot reach publication or review. trident/orchestrator.test.ts:351 | trident/orchestrator.ts:2537, :2545 |
| G085 | Present and absent refs choose distinct leases and dispatch review; failed lookup exhausts three reads and fails without publication. trident/orchestrator.test.ts:420 | trident/orchestrator.ts:2589, :2603, :2609, :2724 |
| G089 | Failed local/PR diff, empty/missing patch, partial scratch provisioning cannot reach apply. trident/publish-rebase-realgit.test.ts:235 | trident/orchestrator.ts:1712, :1730, :1732, :1753 |
| G094 | Twelve real conflicts resolve; thirteen leave one unresolved after twelve turns and preserve the original branch. trident/publish-rebase-realgit.test.ts:292 | trident/orchestrator.ts:1869; trident/merge.ts:198 |
| G097 | A competing commit survives a branch advance at patch generation and immediately before the write; scratch is removed. trident/publish-rebase-realgit.test.ts:318 | trident/orchestrator.ts:1585, :1977, :1983 |
| G111 | All terminal phases are inert; a durable result beats both crashed and orphaned running launchers without spending recovery budget. trident/orchestrator.test.ts:386 | trident/orchestrator.ts:5467, :5509; trident/state-machine.ts:48; trident/store.ts:351 |

### Priority findings and classification

G085 and G097 were implemented and mutation-checked before starting the other
five. G085 currently distinguishes unknown (failed command), absent (successful
empty output), and present (successful OID output). The refusal at
trident/orchestrator.ts:2603 occurs before extracting the lease at :2609.
The issue's collapse is the consequence of removing the gate, not a current
defect established by these tests. The pin covers command failure, not arbitrary
malformed successful command output.

G097 compares the local refs/heads branch, captured at
trident/orchestrator.ts:1585 before replay, against that same ref under Git's
update-ref lock at :1977. The first race detects a late expectation read; the
second detects an unconditional write. These are real Git writes and commits,
not assertions that a CAS-shaped command was emitted. A changed branch must be
preserved even if the writer is gone; Git's atomic ref comparison, independent
of either writer's continued operation, maintains this property.

G083's local-mode mutation still fails loudly at
trident/orchestrator.ts:2763 because detectExistingPr returns null outside PR
mode (:2482). It nevertheless reaches publication/PR creation first (:2724,
:2758). Thus a later error does not substitute for the early side-effect gate.
This supports Loud for that arm, not a blanket proof for every head-read failure.
G089's empty/missing arms also remain loud when removed: Git apply refuses the
input (:1761) and the wholesale-apply error is raised (:1850). Their pins protect
the earlier refusal and diagnosis; the diff-read and partial-provisioning arms
use usable patch bytes/worktrees so removing those refusals can really write.

The inventory file named in the brief is unavailable in this checkout.
Filesystem enumeration, including a positive control, was:

```sh
rg --files docs | rg '(^docs/trident-gates-inventory.md$|^docs/spec-items/the-orchestrator-owns-the-build-loop.md$)'
```

It returned only docs/spec-items/the-orchestrator-owns-the-build-loop.md.
This is not a claim about a freshly fetched ref: network access is prohibited
for this lane. No inventory was fabricated or edited. The classification
qualifications above are for the orchestrator to reconcile with its inventory.
All supplied production gate line numbers still match the checkout; CAS's
command operands are on :1977, with the call beginning on the cited :1976.

### Mutation evidence

For every row, the actual modified production line and git diff were printed
before running the gate's named tests. Each mutation returned exit 1; each
restoration returned exit 0. Mutations were temporary and restored immediately.

| Gate and landed line | Mutation | RED consequence | Restored |
| --- | --- | --- | --- |
| G018 orchestrator.ts:4552 | Remove typeof check | Invalid identity does not produce the required failed/no-fire result | GREEN |
| G018 orchestrator.ts:4552 | Remove empty-string check | Empty identity advances launch | GREEN |
| G083 orchestrator.ts:2537 | Remove mode refusal | Local-mode handoff reaches later publication failure | GREEN |
| G083 orchestrator.ts:2545 | Remove local.ok check | Failed read proceeds past its refusal | GREEN |
| G083 orchestrator.ts:2545 | Remove full-OID check | Empty/abbreviated/nonhex head proceeds past its refusal | GREEN |
| G085 orchestrator.ts:2603 | Replace condition with false | Unknown lookup proceeds toward publication | GREEN |
| G089 orchestrator.ts:1712 | Remove PR diff refusal | Applies despite failed diff command | GREEN |
| G089 orchestrator.ts:1730 | Remove local diff refusal | Applies despite failed diff command | GREEN |
| G089 orchestrator.ts:1732 | Replace condition with false | Attempts apply on empty/missing input | GREEN |
| G089 orchestrator.ts:1753 | Remove worktree refusal | Applies into partial provisioning | GREEN |
| G094 orchestrator.ts:1869 | Remove round cap | Thirteen conflicts resolve, exceeding twelve turns | GREEN |
| G094 merge.ts:198 | Change 12 to 13 | Thirteen conflicts resolve, exceeding twelve turns | GREEN |
| G097 orchestrator.ts:1977 | Omit oldHead operand | Both races overwrite competing commit and resolve | GREEN |
| G097 orchestrator.ts:1977 | Replace oldHead with await readHead() | Patch-boundary race overwrites competing commit and resolves | GREEN |
| G111 orchestrator.ts:5467 | Replace condition with false | Terminal row ceases to be inert | GREEN |
| G111 orchestrator.ts:5509 | Replace condition with false | Valid result loses to launcher recovery | GREEN |

Paths in the mutation table are relative to trident/.
The restored run of both complete touched files passed: 322 tests, 0 failures.
Targeted commands used the G018/G083/G085/G089/G094/G097/G111 name filters on
those two files. G089 was rerun after ordering its assertions to expose attempted
apply before diagnostic differences. G083 was rerun with a responder that can
confirm a successful push, avoiding a fake failure at remote confirmation.

### Decisions and limits

No new outcome vocabulary or invariant was introduced. Existing publication
errors enter failedRun through trident/orchestrator.ts:5076; unrecognized reasons
classify as publish-unknown at :957. Replay exhaustion remains
TridentRebaseConflict (:1869), not a new review verdict. Terminal phase enumeration
comes from trident/state-machine.ts:48. Tests use that existing vocabulary.

Fixture corrections retained their original assertions: publication counting
excludes branch-deletion cleanup; the recovery counter uses the actual
crash_recoveries field; conflict resolution takes the branch side so twelve
resolved files still produce a nonempty commit. Choosing the base side had
correctly failed the successful-replay assertion.

The lane's explicit as-built destination overrides the general work-tracking
shard location. This is the only record for this change. Deliberately excluded:
production fixes, edits to inner-workflow.mjs, the #545 rewrite, network access,
pushes, PR creation, and merge. No separately fileable current defect was
established by these pins.

### Validation

- Complete touched-file run: 322 passed, 0 failed.
- bash scripts/ci/typecheck-all.sh: all 51 configurations passed (exit 0).
- bash scripts/ci/lint.sh: passed (exit 0).
- git diff --check: passed.
- bash scripts/ci/leak-gate.sh --tree .: incomplete (exit 3), zero findings
  from executed rules. The private denylist was unavailable, so pii-denylist
  and pii-denylist-msg did not run. Complete validation remains with the
  orchestrator before publication; this is not reported as a clean leak gate.
- Full repository test suite deliberately not run, per the lane brief.
