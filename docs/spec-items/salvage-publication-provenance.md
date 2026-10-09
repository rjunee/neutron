---
title: Preserve publication ownership when salvaging a failed build
group: trident
status: open
priority: P0
cutover: true
---

# Salvage publication provenance

## Live branch ownership

Tracked by #1469. Every stranded reconciliation must reserve the shared Git
repository (including linked worktrees and path aliases) and branch before
inspecting or changing its checkout, replaying commits, publishing,
or recording the resulting publication. It must refuse another nonterminal run
on that branch, across project scopes, and refuse unknown ownership. Ownership
queries must be complete. Admission holds the same durable reservation before
branch-dependent retry/publication reads through the run-row commit. Checkout capture, replay, publication and network calls must not hold an open
database transaction; bounded Git identity reads may run inside acquisition.

Normal completion or an exception releases the exact reservation. A crash does
not authorize expiring or stealing one: an outstanding Git command may survive
its caller. Such a branch remains explicitly held until its operation is settled;
unrelated branches remain available. This reservation does not authenticate a
native child's completion or weaken immutable review-input checks. A recovery
request refused solely because another operation holds the branch must leave
the card and one-use source unchanged; the same authorized request may proceed
after release. Verify: `trident/orchestrator-recovery.test.ts`.

- [ ] A real-Git startup sweep with an old failed row and a live review on the
  same branch leaves local/remote refs, checkout and review checkpoint unchanged,
  including when main advanced and the failed row has no recorded PR.
  Verify: `trident/stranded-salvage-realgit.test.ts`.
- [ ] Unowned failed work still publishes and retains its receipt. Unknown
  ownership, direct reconciliation and a live owner in another project refuse.
- [ ] Pausing either admission or salvage excludes the other across separate
  database connections; normal release admits the waiting retry. A retained
  reservation remains held across reopening the database, while another branch
  remains usable. Verify: `trident/branch-reservation.test.ts` and the real-Git
  consuming controls above.
- [ ] A missing reservation seam cannot perform salvage writes. Removing the
  guard fails the live-owner control; refusing all salvage fails the unowned
  publication control. The deployed repair is followed by fresh unattended
  Work Board acceptance under the original single/sequence/concurrent contract.

Tracked by #1217. The locked pivot retains
the publication and pinned merge gates
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271-274`). Recovery
must preserve completed work and provenance
(`docs/spec-items/trident-build-efficiency.md:154-166,190-201`).

A terminal build may be published by the outer stranded-work salvage after the
project driver stops. The publisher must preserve a witnessed creation receipt
so a later retry can identify the PR as belonging to this run lineage. Finding a
PR on the same branch is insufficient: it may belong to someone else. A receipt
contains the number returned by the successful create command, corroborated by
the independently observed PR. A pre-existing matching lineage receipt remains
valid. Missing, mismatched or timed-out creation responses grant no ownership.

Persist a new receipt before optional annotation and later diff preparation can
fail. The boot salvage sweep and ordinary outer publication must retain the same
ownership. A retry still runs publication proof, review and pinned merge gates.
Historical PRs without a durable receipt are not adopted by guessing from their
branch, head, author or failure text. This change does not backfill historical
rows. Static consuming E2E tests prove the salvage ownership seam; a fresh live
dispatch proves the served end-to-end regression, without claiming that ordinary
fresh publication directly exercises salvage. Completion requires both forms of
evidence under the locked pivot
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:278-295`).

## Acceptance

- [x] A successful salvage creation records `published_pr` durably, and the real
  board retry carries it into the project driver without planning or rebuilding.
  Verify: `trident/stranded-salvage-realgit.test.ts` and
  `open/__tests__/project-build-e2e.test.ts`.
- [x] A discovered PR and missing, mismatched or timed-out create receipts do
  not gain ownership; a matching existing lineage receipt remains valid.
  Verify: `trident/publication-session-trailer-realgit.test.ts` and the paired
  consuming E2E case, which keeps the unowned PR open.
- [x] A failure after corroborated creation cannot erase its durable receipt;
  failures before corroboration cannot mint one. Verify with the publisher's
  receipt callback and a failure during subsequent diff preparation.
- [x] Semantic mutations that discard a valid receipt or adopt a discovered PR
  fail the consuming tests. The restored implementation passes, including both
  TypeScript checks.
- [x] The exact merged revision is deployed and served on the target instance,
  verified with positive and negative source controls: the served source contains
  corroborated creation receipt recording, and the superseded receipt-dropping
  salvage path is absent, with a known-present control checked by the same
  source inspection. A fresh Work Board card dispatched from an adopted chat
  reaches merged with no human intervention. Record the merged and served
  revision, source-control evidence, dispatch/run identity and resulting merge.
  This live dispatch establishes the served end-to-end regression; the static
  consuming E2E cases above establish the salvage seam.

## Interrupted project publication

The project driver must retain a successful PR creation response before its
independent PR inspection. Store that response in the run's existing stage
events, bound to its run, project, repository, worktree, branch, base, merge
mode, target branch and published head. A response alone grants no ownership:
the restarted host must independently observe the exact PR, OPEN at the same
head on the same source and target branches, before recording `published_pr`.
The publication, review and pinned merge gates still apply.

- [x] Restart after the response is saved but before PR inspection or ownership
  persistence resumes publication with exactly one creation, including repeated
  recovery. Verify: `trident/production-host-effects.test.ts`, `publication restart`.
- [x] Missing, corrupt, mismatched or uncorroborated response evidence cannot
  authorize ownership or repeat creation. A malformed latest response cannot
  revive an older valid one. Verify: the same tests and the existing foreign-PR
  discovery refusal control.
- [x] A failed response write leaves the independently discovered PR unowned.
  Recovery never infers the lost response from a branch or matching head.
  Verify: `publication restart cannot invent a create response when its durable write failed`.

A crash before the successful response reaches durable storage remains
unresolved. This slice does not establish interrupted native worker recovery,
release native-child leases, or prove unattended recovery across an actual
gateway, terminal-host or machine restart.

Live acceptance: [sequence and publication witness](../as-built/trident-sequence-and-publication-live-acceptance.md).

## Card lineage after an intermediate failure

Tracked by #1418. An intermediate terminal attempt can become the card's linked
run without creating a PR. That attempt must not erase an earlier witnessed
publication for the same card, repository and generated branch. Ownership may
come only from a durable `published_pr` on an earlier terminal PR-mode run in the
card's terminal-attempt ledger, anchored to the exact currently linked run. Both
run start order and ledger insertion order must precede that anchor. Observed
PR numbers never grant ownership. This carries publication ownership only;
completed-build reuse still follows the existing checkpoint and task bindings.

- [x] The real board retry can retain an earlier same-card creation receipt
  across an intermediate failed attempt, while its discovered-PR sibling remains
  unowned and unmerged. Verify: `salvaged publication` consuming cases in
  `open/__tests__/project-build-e2e.test.ts`.
- [x] Changed repository, branch, project, card, missing anchor, later start,
  later ledger entry, local mode and nonterminal owners cannot supply a receipt.
  Direct linked-run receipts remain scoped to their original repository and
  branch. Verify: `earlier card publication provenance` in `trident/store.test.ts`
  and the linked-receipt controls in `trident/board-dispatch.test.ts`.
- [x] Removing valid lineage inheritance or substituting an observational PR
  fails the corresponding consuming control; removing the SQL mode, chronology
  or anchor boundary fails its refusal control with the valid sibling passing.

## Owned published retry through outer launch

Tracked by #1476. A terminal predecessor can hold this card's witnessed
publication while its latest host checkpoint still records a pending build or
fix reservation: its native worker wrote the original result after the driver's
acknowledgement was lost, or after a supported stop. That checkpoint remains
ineligible for implementation reuse. The card's normal retry therefore starts
fresh planning while carrying the publication receipt, strategy and task spend
under `Card lineage after an intermediate failure`. The outer launcher refused
such a retry as a foreign wrong-base branch before its first worker, for owned
and unowned publications alike, and actual preparation could not add a worktree
for a branch the predecessor's linked checkout still held.

Outer launch may adopt a retained local branch that is not contained in the
fetched base only when every fact below is re-established at launch from
existing authority:

- the run's `published_pr` is the exact same-card lineage receipt for its
  project, repository, branch and PR mode; an observed or discovered PR never
  qualifies;
- the predecessor is a terminal attempt in that card's ledger for the same
  project, repository and branch, with a valid terminal host checkpoint. It is
  the newest such attempt; a newer attempt is passed over only when it is
  provably a retry refused before its first worker on that same branch (no
  checkpoint, no recovery, no worker accounting, and no receipt other than this
  one). It was refused either at outer launch (no inner result) or at
  preparation. A preparation refusal qualifies only in its exact shape: an
  inner result of exactly `ok: false`, `checkpoint: 'inner-error'` and the
  bounded worktree-creation refusal as `terminalCause` (the launcher's write
  over its own reservation), the single `build-worktree-add-failed` diagnostic
  as its only stage event apart from the launch and dispatch telemetry the
  production composition stamps on every launch (`launch-start`,
  `fire-dispatched`, `work-board-start-dispatched` and the other fire stamps),
  and no PR other than this card's. A refused retry,
  including a transient UNKNOWN refusal of this path at launch or preparation,
  never ends the card's recovery, and any other newer attempt refuses;
- the predecessor's pending worker is settled by its original authenticated
  evidence: the host-saved request, the exact armed reservation, and a completed
  result at the canonical path that the live project-build trailer validator
  accepts for that run, step, branch and worktree. Its attempt accounting may be
  completed, unfinished (`ended_at` and `outcome` null) or explicitly `unknown`;
  it is never rewritten to establish settlement;
- no native-child lease, other worker ownership or other nonterminal run holds
  the predecessor's work or the branch;
- the local branch tip equals the settled head, descends from the predecessor's
  base pin, and contains the published PR head observed OPEN on the same source
  and target branches. A PR head object that cannot be read locally makes that
  containment UNKNOWN, never a wrong-base verdict.

The retry then pins the predecessor's base, keeps its own run identity, and
starts fresh planning on the retained branch. Terminal phase, a process exit,
elapsed time, a PR number or a matching branch name never establish settlement
or ownership. Every other shape keeps the existing refusals, and an unknown Git
observation refuses as UNKNOWN.

Preparation re-establishes the same authority while holding its own durable
`salvage`-purpose reservation of the branch, acquired for the hand-off and
released once the worktree add returns; a reservation already held by any other
run refuses. The branch tip must still be the settled head, descend from the
base pin and contain the owned PR head observed OPEN, whether or not a checkout
still holds the branch, and the attached worktree is re-checked at the settled
head. When the predecessor's linked checkout still holds the branch, it is handed off through the existing worktree cleanup
lifecycle: a clean, unlocked checkout that is exactly the predecessor's recorded
worktree at the settled head is removed without force while the branch and every
commit are kept. A dirty, locked, unverifiable or ambiguous checkout, another
holder, a moved branch, an unavailable reservation or a changed observation
refuses before any branch reset, checkout deletion, forced checkout or ownership
release, and records the existing worktree-add diagnostic. When the authority
cannot be re-read at preparation but the row carries the base pin outer launch
wrote on adopting the branch (the predecessor's own pin, on an owned-published
fresh retry whose same-lane predecessor still records a pending build or fix),
preparation refuses as UNKNOWN before any reservation, cleanup or add; it never
attaches that branch unchecked. That fallback applies only to a fresh adopted
retry: once the retry holds its own checkpoint, retry source or recovery, its
existing path is unchanged. Preparation consults the hand-off whether or not the
retained branch still exists, so an adopted retry whose branch vanished after
outer launch refuses as UNKNOWN instead of recreating the branch at the
predecessor's base without the retained work. A preparation failure AFTER a
successful hand-off (dependency installation, the disk reserve, the phase-model
parse) is not the exact preparation-refused shape: it fails closed, and the
card's next retry refuses at outer launch until an operator resolves it.
Predecessor run rows,
stage events, attempts, budgets and retained artifacts are unchanged.

The retry receives current proof, review and pinned merge gates under its own
identity. No prior approval, suite receipt, mutation proof or checkpoint carries
because a PR exists.

- [x] The real board retry, through `dispatchBoardBoundBuild`, the outer launcher
  and actual project preparation with the predecessor checkout still present,
  reaches merged on the same PR with its published commits retained, fresh
  planning, and the consumed strategy and task spend. Cover a completed attempt
  whose driver acknowledgement was lost and an unfinished or `unknown` attempt
  settled by its original authenticated result. Verify: `owned published retry`
  cases in `open/__tests__/project-build-e2e.test.ts`.
- [x] The discovered-but-unowned sibling remains refused at outer launch, with
  its PR, branch and checkout untouched and no worker dispatched.
- [x] Missing or altered request, result, reservation or publication authority;
  an active native writer; another live owner; a dirty, locked or ambiguous
  retained checkout; changed repository, card or branch; unknown Git
  observations; and concurrent reservation acquisition each refuse without
  branch reset, checkout deletion, forced checkout or ownership release.
  Verify: `trident/published-retry-handoff.test.ts` and the preparation
  controls in `open/__tests__/project-build-e2e.test.ts`.
- [x] A card whose newest terminal attempt is a retry refused before its first
  worker (here a transient UNKNOWN refusal of this path, saved and reconciled by
  the real board observer) still reaches merged on the next normal retry. A
  newer attempt that dispatched a worker, carries another receipt, ran on
  another branch, was seeded from a checkpoint or holds an inner checkpoint
  refuses. Verify: `owned published retry survives an intermediate retry` in
  `open/__tests__/project-build-e2e.test.ts` and the intermediate cases in
  `trident/published-retry-handoff.test.ts`.
- [x] A card whose newest terminal attempt is a retry refused at PREPARATION
  (adopted at outer launch, then a transient UNKNOWN hand-off with the
  predecessor checkout still present, or one failed worktree add after the
  checkout was already released), saved and reconciled by the real board
  observer, still reaches merged on the same PR on the next normal retry, with
  both predecessors' rows, events and attempts unchanged. A preparation-refused
  attempt with an extra inner-result key, a still-pending reservation, a driver
  rejection's cause, no or two diagnostics, another stage event, a worker
  attempt, a checkpoint or its own PR refuses; the production launch telemetry
  around the diagnostic neither qualifies nor disqualifies it, and the consuming
  case launches with the production `record_stage` wiring. Verify: `owned
  published retry survives an intermediate retry refused at preparation` in
  `open/__tests__/project-build-e2e.test.ts` and the `refused at preparation`
  and `preparation-refused card attempt` cases in
  `trident/published-retry-handoff.test.ts`.
- [x] An authority that cannot be re-read at preparation on a row carrying the
  adopted base pin refuses as UNKNOWN `authority-unreadable` with the holder
  checkout and branch ref unchanged and no command run; without that pin the
  hand-off stays `none`, and a retry that already recorded its own checkpoint
  or retry source stays `none`. Verify: the `unreadable authority` and
  `adopted-pin fallback` cases in `trident/published-retry-handoff.test.ts`.
- [x] An adopted retry whose retained branch vanished after outer launch
  refuses at preparation as UNKNOWN `branch-unreadable`: the branch is not
  recreated, no worktree is added and no worker runs. Verify: `owned published
  retry refuses at preparation when the adopted branch vanished after outer
  launch` in `open/__tests__/project-build-e2e.test.ts` and the `adopted
  retained branch vanished` case in `trident/published-retry-handoff.test.ts`.
- [x] An owned PR head object that `git cat-file -e` cannot read (missing,
  failed or killed by its watchdog) refuses outer launch as UNKNOWN, not
  wrong-base, with nothing written. Verify: the `unreadable owned PR head`
  cases in `trident/published-retry-handoff.test.ts`.
- [x] With the predecessor's checkout already gone at preparation, a branch
  rewound or advanced past the settled head refuses as `branch-moved` before
  any add; at the settled head it is attached and re-checked, with no cleanup.
  Verify: the `no remaining holder` cases in
  `trident/published-retry-handoff.test.ts`.
- [x] Outer launch's tick snapshot of the retry may lag the stored row in
  columns the authority does not read; a disagreement in a column it does read
  refuses. Verify: the `tick snapshot` cases in
  `trident/published-retry-handoff.test.ts`.
- [x] The predecessor's pending checkpoint is still refused as a retry source;
  the retry imports no checkpoint, approval or suite receipt. Verify:
  `trident/build-mode-state.test.ts`.
- [x] Refusing every retry fails the owned positive; granting publication from
  discovery fails the unowned negative; bypassing retained-checkout ownership or
  settlement fails its active or unknown control. Each mutation is restored and
  the focused suites pass again.
