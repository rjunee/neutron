## 2026-10-09 — Recover an owned published retry through outer launch and preparation

A card's terminal predecessor can build useful commits and hold the card's
witnessed salvage PR, while its latest checkpoint still records a pending build
or fix. This happens when its native worker wrote the original result after the
driver's acknowledgement was lost, or after a supported stop. The normal card
retry already carried the publication receipt, strategy and task spend, and
started fresh planning. However, the outer launcher refused it as a foreign
wrong-base branch before its first worker. Even past that guard, preparation
could not add a worktree for a branch the predecessor's linked checkout still
held. This implements the `Owned published retry through outer launch` and
`Settled pending predecessor of an owned publication` criteria in
`docs/spec-items/salvage-publication-provenance.md` and
`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md` for #1476.

**Authority.** One read-only authority is composed from existing exact checks
(`publishedRetryHandoff` in `trident/published-retry-handoff.ts`). It requires all of the following:

- the same-card lineage receipt
- the card's newest terminal attempt that holds a host checkpoint, on the same
  project, repository, branch and PR mode. Newer attempts are passed over only
  when each is provably a retry refused before its first worker on that branch:
  no checkpoint, no recovery stage, no `build-retry-source`, no attempt rows, no
  inner checkpoint or result, and no receipt other than this one
  (`linkedCardAttempts` in `trident/store.ts` lists the card's terminal attempts newest first)
- the original host-saved request, its dispatch journal and its exact armed
  reservation
- one attempt row, whose accounting may be completed, unfinished (`ended_at`
  and `outcome` null) or explicitly `unknown`, and is never rewritten
- a completed result at the canonical path with a valid forge trailer
- no other unfinished worker and no foreign branch reservation

The authority also requires that none of these changed while it was being read.
The Open composition adds the host witness
(`open/wiring/published-retry-settlement.ts`). That witness refuses while any
native-child admission lease names the predecessor, and it checks the trailer
with the live validator. The composed reader is
`readPublishedRetryHandoff` in `trident/published-retry-handoff.ts`.

**Outer launch.** Outer launch consumes this authority only for a fresh,
unseeded PR launch whose tip is not contained in the fetched base
(`prepareLaunch` in `trident/launch-preparation.ts`). Before the launch is allowed, Git must
prove three things:

- the tip equals the settled head
- the tip descends from the predecessor's base pin
- the tip contains the owned PR head, which is observed OPEN on the same
  branches

The authority is then re-read and must be unchanged. If any of this fails, the
existing wrong-base refusal is kept. An unknown observation refuses as UNKNOWN.

**Preparation.** `prepareProjectBuild` re-establishes the same authority while
the hand-off holds its own durable `salvage`-purpose reservation of the branch,
which it acquires itself and releases once the worktree add returns
(`prepareProjectBuild` in `open/wiring/project-build.ts`, `withRetainedCheckoutHandoff` in `trident/published-retry-checkout.ts`). A
reservation already held by another run refuses. The branch tip must equal the
settled head, descend from the base pin and contain the owned PR head observed
OPEN, whether or not a checkout still holds the branch. It then hands off the
one clean, unlocked checkout that is exactly the predecessor's recorded worktree
at the settled head; when no checkout holds the branch any more, nothing is
released. Either way the attached worktree is re-checked at the settled head. The hand-off goes through `worktree-cleanup.sh keep-branch`, and
the existing branch is attached afterwards. Dirty, locked, moved, ambiguous or
unreadable shapes refuse before any mutation and record the existing
`build-worktree-add-failed` diagnostic.

**Production change found by the consuming E2E.** On the real launch path, the
launcher links the owned PR it discovers through `gh pr list --head <branch>`
onto a launch-local row. The authority's unchanged-row check compares the run it
is given against the stored row, and the stored row still has `pr: null`. Outer
launch therefore refused every owned retry whose PR GitHub reports, which is the
production shape. The direct tests had stubbed discovery to `null` and could not
see this.

Outer launch now reads the authority over the row it was handed (the tick's
snapshot of the stored row), not the launch-local enrichment, for both the first read and the re-read
(both authority reads in `prepareLaunch`, `trident/launch-preparation.ts`). A direct case pins this:
discovery reports the PR, the reader sees `pr: null` twice, and the pinned run
still links the PR (`owned published retry adopts the retained branch when launch discovers its open PR` in `trident/published-retry-handoff.test.ts`). Restoring
the old argument fails that case (0 pass, 1 fail).

**Consuming end-to-end cases.** These are the `owned published retry` cases in
`open/__tests__/project-build-e2e.test.ts` (built by `ownedPublishedRetry`). Each predecessor is driven
through the real project driver:

- **Completed build.** A completed build whose mode-driver acknowledgement is
  lost leaves a pending build checkpoint.
- **Unfinished fix.** The incident shape: a fix stopped through the supported
  terminator whose attempt stays unfinished.
- **Unknown fix.** A fix attempt that ends `unknown`.

Each predecessor publishes through the real guarded `reconcile_stranded`
salvage seam. A Work Board card is bound to it, and the retry runs through
`dispatchBoardBoundBuild`, `buildTridentOrchestrator` with
`createProjectLauncher`, and actual `prepareProjectBuild`. The predecessor's
worktree stays present throughout.

Each shape reaches merged on PR #1, with this evidence:

- fresh planning: one plan and one build
- a current review and a pinned merge
- no `gh pr create`
- the published and settled heads contained in origin main
- the predecessor's base pin kept, and its strategy and 1/4 task spend carried
- no checkout, approval or suite receipt imported
- the predecessor's checkout removed with `keep-branch` and nothing forced
- the predecessor's run, events, attempts and retained artifacts byte-equal
- `retryModeSource` still null

The discovered-but-unowned sibling is refused at outer launch, with no dispatch,
PR #1 still OPEN, and its rows and Git unchanged. Six controls are applied after
dispatch:

- a dirty checkout
- a locked checkout
- a holder at another path
- an unreadable worktree listing (UNKNOWN)
- an active native writer lease
- a branch reservation held by another run

Each control refuses with no worker, no forcing command, no cleanup call, PR #1
OPEN, and rows, Git and reservations unchanged. The missing or altered
request, result, reservation, publication, repository, card and branch
controls, and the concurrent-acquisition controls, stay in the direct tests.

**Paired mutations.** Each mutation was executed through
`bun test open/__tests__/project-build-e2e.test.ts -t <pattern>` and restored
byte-for-byte:

| Mutation | Change | Guard (fails) | Control (passes) |
| --- | --- | --- | --- |
| M1 | Refuse every retry in the composed reader | owned positive: 0 pass, 3 fail | unowned sibling: 1 pass |
| M2 | Grant publication from the observational `prior.pr`, at both the dispatch and authority receipt sites | unowned sibling: 0 pass, 1 fail | owned positive: 3 pass |
| M3 | Bypass the host settlement witness | active native writer: 0 pass, 1 fail | unowned sibling: 1 pass |
| M4 | Bypass the recorded-holder path check | holder at another path: 0 pass, 1 fail | unowned sibling: 1 pass |

**Review fix round.** The first review found four defects, all repaired here:

- **Intermediate refused retry.** The authority took the card's latest terminal
  attempt as the predecessor. A retry refused at outer launch is itself recorded
  as a terminal attempt with no checkpoint, so one refusal (the live #1459 card
  has exactly this shape, and a transient UNKNOWN refusal of this path produces
  it too) ended the card's recovery for good. The authority now walks the
  card's ledger as described under Authority, and re-reads every passed-over
  attempt unchanged. The consuming case `owned published retry survives an
  intermediate retry refused before its first worker`
  in `open/__tests__/project-build-e2e.test.ts` fails one owned PR read,
  saves the refused run, reconciles it through the real board observer and
  then merges on the next normal retry. Direct cases cover both accounting
  shapes and five refusing intermediates
  (the `newer card attempt` cases in `trident/published-retry-handoff.test.ts`).
- **No-holder preparation.** With no checkout holding the branch, the hand-off
  returned `none` before checking the tip, so a branch moved between launch and
  preparation was attached unchecked. It now applies the same tip, ancestry and
  publication checks and returns `handed-off` without a cleanup call, so the
  caller's settled-head check runs after the add
  (the `no remaining holder` cases in `trident/published-retry-handoff.test.ts`).
- **Tick snapshot.** The authority compared the whole run row it was handed
  with the stored row, so any unrelated write between the tick's listing and
  the step refused an owned retry permanently. It now compares only the columns
  it reads (`authorityFields` in `trident/published-retry-handoff.ts`); a
  disagreement in one of them still refuses (the `tick snapshot` cases in
  `trident/published-retry-handoff.test.ts`).
- **Rev-range enumeration.** The new base-behind measurement's operand
  `handoff.priorBase` is argued in `trident/diff-base-option-shaped.test.ts`,
  which had failed the host suite and CI shard 3/4.

Paired mutations for the fix round, each restored byte-for-byte afterwards:

| Mutation | Change | Guard (fails) | Control (passes) |
| --- | --- | --- | --- |
| F1 | Refuse every newer intermediate attempt | intermediate direct cases: 2 fail; intermediate e2e case: 1 fail | `trident/build-mode-state.test.ts`: 20 pass |
| F2 | Pass over an intermediate with another receipt | `carries another receipt`: 1 fail | the other 66 direct cases pass |
| F3 | Return `none` when no checkout holds the branch | the three `no remaining holder` cases fail | the other 64 direct cases pass |
| F4 | Compare the whole handed row again | `tick snapshot may lag`: 1 fail | the other 66 direct cases pass |

**Validation.** All of the following passed:

- the 10 focused consuming E2E cases, and the whole
  `open/__tests__/project-build-e2e.test.ts` (616 pass, 0 fail)
- in the fix round: the 11 `owned published retry` and 4 `salvaged
  publication` consuming cases (15 pass), the 67 cases in
  `trident/published-retry-handoff.test.ts`, the 42 cases in
  `trident/diff-base-option-shaped.test.ts`, and 323 cases in
  `trident/store.test.ts`, `trident/build-mode-state.test.ts`,
  `trident/board-dispatch.test.ts` and
  `open/wiring/__tests__/published-retry-settlement.test.ts`
- in the first round: 369 tests in `trident/published-retry-handoff.test.ts`,
  `trident/build-mode-state.test.ts`, `trident/board-dispatch.test.ts` and
  `trident/store.test.ts`
- `tsc --noEmit -p tsconfig.json` and `-p trident/tsconfig.json`
- `scripts/ci/lint.sh` and `git diff --check`

`scripts/ci/typecheck-all.sh` fails only on
`app/__tests__/support/mount.tsx(17,1)` (an unused `@ts-expect-error`), which
fails identically on main at `84a38afec`. This change touches no `app/` file.
The full host suite is left to the host pipeline.

**Scope of this record.** No live row, lease, receipt, branch, PR or deployment
was changed. This record establishes the repair against the real-Git fixture; it
does not claim that #1476 has been deployed or witnessed live.

### Round 2: preparation-refused intermediates and two UNKNOWN refusals

Review round 2 of PR #1479 raised one major and two smaller findings. This round
merges the published head `d5a284d8` unchanged and repairs all three.

**Finding 1 (major): a retry refused at preparation ended the card's
recovery.** The project launcher writes its reservation into `inner_result`
before `prepare`. When preparation throws, the launcher overwrites its own
reservation with `{ ok: false, checkpoint: 'inner-error', terminalCause }`
(the `prepare` catch in `createProjectLauncher`, `trident/project-launcher.ts`). The authority's pass-over rejected any
newer attempt with a non-null `inner_result`, so a single preparation refusal
(a transient UNKNOWN hand-off, or one failed attach after the predecessor's
checkout was released) ended the card's recovery for good.

The pass-over loop in `publishedRetryHandoff` now also skips an attempt that
`preparationRefused` (both in `trident/published-retry-handoff.ts`) admits. All of the following must hold:

- `inner_result` has exactly the keys `ok`, `checkpoint` and `terminalCause`,
  with `ok: false`, `checkpoint: 'inner-error'`, and a `terminalCause` that
  starts with `Error: Build worktree creation was not confirmed (` and ends
  with `; diagnostic_recorded=true)`. That is the bounded message
  `prepareProjectBuild` throws after recording its diagnostic. A driver
  rejection writes the same three keys with another cause, so the shape alone
  is not accepted.
- Its stage events are exactly one `build-worktree-add-failed` diagnostic,
  apart from launch telemetry (corrected in round 3, below).
- Its `pr` is null or this card's own receipt.
- The existing checks are unchanged: no attempt rows, no inner checkpoint, no
  `build-retry-source` or recovery stage, no bound PR, no other
  `published_pr`, the same lane, and an unchanged re-read at the end.

The allowed pre-preparation event set is `['build-worktree-add-failed']`
(`PREPARATION_REFUSAL_EVENTS` in `trident/published-retry-handoff.ts`). Round 2
measured it on a harness that built the orchestrator without `record_stage`;
round 3 below corrects that to the production event set. The T2
hand-off refusals (`publication-unknown`, `worktree-list-unreadable` and the
rest) already record the diagnostic through the existing recorder in
`open/wiring/project-build.ts`, so nothing was rerouted. Nothing releases,
rewrites or annotates the passed-over row, reservation or events.

**Finding 2 (minor): an unreadable authority after adoption attached the branch
unchecked.** When the authority could not be re-read at preparation,
`withRetainedCheckoutHandoff` returned `none` and the caller attached the
branch. Outer launch persists no separate adoption marker; the one thing its
adoption writes is the predecessor's own base pin as the run's `base_sha`.
That pin alone is not distinctive (the base may not have moved), so
`adoptedPublishedRetryPin` (in `trident/published-retry-handoff.ts`) requires
all of these:

- the row is an owned-published fresh retry: PR mode, a positive receipt, no
  inner checkpoint and no bound PR;
- its `base_sha` equals the base pin of the card's newest same-lane attempt
  that holds a `build-mode-state` checkpoint;
- that checkpoint still records a pending build or fix, which is the only
  predecessor the authority adopts.

A read failure on such a row answers true. When the authority is null and the
pin is present, the hand-off answers UNKNOWN `authority-unreadable`
(`withRetainedCheckoutHandoff`) before any reservation, Git call,
cleanup or add, and preparation records the existing diagnostic. Without the
pin it stays `none`. The salvaged-publication consuming cases, whose
predecessors hold no pending checkpoint, keep `none`.

**Finding 3 (nit): an unreadable PR-head object was labelled wrong-base.** A
failed or timed-out `git cat-file -e` of the owned PR head now refuses outer
launch through the existing UNKNOWN refusal, with no wrong-base remedy text and
nothing written (the PR-head containment read in `prepareLaunch`).

**Tests.**

- `owned published retry survives an intermediate retry refused at
  preparation` in `open/__tests__/project-build-e2e.test.ts`, in two
  variants. In the first, the predecessor checkout is still present and one
  `git worktree list --porcelain` fails, so the hand-off is UNKNOWN. In the
  second, the keep-branch cleanup succeeds and then one `git worktree add`
  fails, so the branch is retained with no holder. In both, the refused run is
  saved and reconciled through the real board observer. The next
  `dispatchBoardBoundBuild` retry then reaches merged on PR #1 with no
  `gh pr create`, fresh planning, the predecessor's base pin, strategy and 1/4
  task spend, no forcing argv, and both predecessors' rows, events and
  attempts unchanged.
- Direct cases in `trident/published-retry-handoff.test.ts`:
  - `refused at preparation does not end recovery`, for both
    accounting shapes;
  - nine `preparation-refused card attempt` refusals: an extra key, a
    pending reservation, a driver rejection's cause, no diagnostic, two
    diagnostics, another stage event, a worker attempt, a checkpoint, and its
    own PR;
  - three `unreadable authority after outer launch adopted the branch` cases
    (witness refuses, foreign reservation, missing result), each with the
    holder checkout and branch ref unchanged and no command run, plus the
    no-pin case that stays `none`;
  - three `unreadable owned PR head` cases: missing, exit 128, and
    the watchdog.

Two existing direct cases changed expectation, because the finding changes
that behaviour: a refusing settlement witness and a foreign reservation on an
adopted row were `none` and are now UNKNOWN `authority-unreadable`.

**Paired mutations.** Each was restored byte-for-byte and re-run green:

| Mutation | Change | Guard (fails) | Control (passes) |
| --- | --- | --- | --- |
| M-F1 | Reject every intermediate with a non-null `inner_result` again | both new e2e variants: 0 pass, 2 fail (outer launch refuses wrong-base); direct `refused at preparation`: 0 pass, 2 fail | owned positive e2e: 3 pass |
| M-F2 | Drop the adopted-pin check (`adopted = false`) | `unreadable authority` cases: 3 fail | the two `no owned authority` cases: 2 pass |
| M-F3 | Label a failed (not timed-out) `cat-file -e` wrong-base again | `missing object` and `exit 128`: 2 fail | `watchdog timeout`: 1 pass |

**Validation.** All of the following passed in this round:

- the whole `open/__tests__/project-build-e2e.test.ts` (627 pass, 0 fail), and
  the 13 `owned published retry` and 4 `salvaged publication` consuming cases
  on their own (17 pass)
- 448 cases across `trident/published-retry-handoff.test.ts` (83),
  `trident/store.test.ts`, `trident/build-mode-state.test.ts`,
  `trident/board-dispatch.test.ts`, `trident/diff-base-option-shaped.test.ts`
  and `open/wiring/__tests__/published-retry-settlement.test.ts`
- `scripts/__tests__/spec-items-index.test.ts` (38 pass)
- `tsc --noEmit -p trident/tsconfig.json`, `scripts/ci/lint.sh` and
  `git diff --check`

`scripts/ci/typecheck-all.sh` fails only on
`app/__tests__/support/mount.tsx(17,1)`, the unused `@ts-expect-error` recorded
in round 1 as failing identically on main. This change touches no `app/` file.
The full host suite is left to the host pipeline.

**Scope of this record.** No live row, lease, receipt, branch, PR or
deployment was changed. This round establishes the repairs against the real-Git
fixture; it does not claim that #1476 has been deployed or witnessed live.

### Round 3: production launch telemetry, a vanished branch, and a scoped fallback

Review round 3 of PR #1479 found that round 2 added a second `## ` heading to
this new record. `scripts/ci/as-built-write-guard.sh` requires exactly one, so
the `layering` job and the repo self-gate case in
`scripts/ci/check-governed-repo-attributes.test.ts` failed on the PR. The round
headings are now `###`. The reviewers' other findings are repaired here, except
the one recorded below as a known limit.

**Launch telemetry (major).** Production wires the orchestrator's
`record_stage` into the run store (`gateway/composition/build-core-modules.ts`).
`launch()` therefore stamps `launch-start` before `prepareLaunch` and
`fire-dispatched` before the project launcher runs `prepareProjectBuild`, and a
`work_board_start` dispatch stamps `work-board-start-dispatched`. A live attempt
refused at preparation therefore carried more than the one diagnostic. Round
2's exactly-one-event rule never matched it, so recovery still ended on the
production composition. `preparationRefused` now ignores the launch and dispatch
telemetry listed in `LAUNCH_TELEMETRY_EVENTS` and still requires exactly one
`build-worktree-add-failed` and no other stage. The owned-retry consuming
launches now pass the production `record_stage` wiring to
`launchThroughGateway`. The preparation-refused e2e asserts that `launch-start`
and `fire-dispatched` are present, and that the only non-telemetry event is the
diagnostic.

**Vanished retained branch (minor).** `prepareProjectBuild` consulted the
hand-off only when the branch existed. If the predecessor's checkout and local
branch were removed after outer launch adopted the branch, preparation recreated
the branch at the predecessor's base pin without the retained work. The hand-off
now runs whether or not the branch exists. With an authority, the settled-head
read fails and the outcome is UNKNOWN `branch-unreadable`. With only the adopted
pin, the outcome is UNKNOWN `authority-unreadable`. With neither, the outcome is
`none` and the path is unchanged.

**Scoped adopted-pin fallback (minor).** `adoptedPublishedRetryPin` now answers
false once the run holds its own `build-mode-state`, `build-retry-source` or
recovery. These are the same exclusions the authority applies. A same-run
re-preparation of a retry that already ran therefore keeps its existing path,
where before it refused UNKNOWN.

**Known limit (recorded, not repaired).** Preparation can fail AFTER a
successful hand-off and before any worker: dependency installation, the disk
reserve, the phase-model parse, or the post-add settled-head check. That attempt
is not in the exact preparation-refused shape. Its cause is not the
worktree-creation refusal, it records dependency-interval events, and its own
worktree now holds the branch. It is therefore not passed over, and the card's
next retry is refused at outer launch, failing closed. Making it recoverable
would require preparation to undo its own attach, and the pass-over to admit a
second exact shape. That is left to a follow-up. The spec criterion states this
limit.

**Anchors (nit).** The citations above now name symbols instead of line numbers
that later rounds shifted.

**Tests.**

- `trident/published-retry-handoff.test.ts` has three new direct cases. The
  first: `a preparation-refused card attempt with the production launch
  telemetry still passes over`. It also asserts that telemetry without the
  diagnostic still refuses. The second: `preparation refuses UNKNOWN when the
  adopted retained branch vanished after outer launch`, with the snapshot
  unchanged and no destructive command. The third: `the adopted-pin fallback
  does not apply to a retry that already recorded` its own `build-mode-state`
  or `build-retry-source`. It has two variants, each answering `none` with no
  command and no reservation.
- `open/__tests__/project-build-e2e.test.ts` has a new case: `owned published
  retry refuses at preparation when the adopted branch vanished after outer
  launch`. The launcher hook removes the predecessor's checkout and deletes the
  local branch ref after outer launch, which hands the launcher the
  predecessor's base pin. Preparation then refuses with
  `handoff=unknown:branch-unreadable`. No worktree add runs, no worker runs, and
  the branch is not recreated. The origin still holds the published head, and
  the predecessor's rows, events, attempts and artifacts are unchanged.

**Paired mutations.** Each mutation was restored byte-for-byte and re-run
green:

| Mutation | Change | Guard (fails) | Control (passes) |
| --- | --- | --- | --- |
| M-R1 | `const evidence = events` (count telemetry again) | both `refused at preparation` e2e variants: 0 pass, 2 fail; the direct telemetry case: 1 fail (86 pass) | owned positive and the other direct cases |
| M-R2 | Consult the hand-off only when `branch.ok` again | `adopted branch vanished` e2e: 0 pass, 1 fail | the other owned-retry e2e cases |

**Validation.** All of the following passed in this round:

- the 14 `owned published retry` and 4 `salvaged publication` consuming cases
  (18 pass)
- 480 cases in total across these files:
  - `trident/published-retry-handoff.test.ts` (87)
  - `trident/store.test.ts`
  - `trident/build-mode-state.test.ts`
  - `trident/board-dispatch.test.ts`
  - `trident/diff-base-option-shaped.test.ts`
  - `trident/work-board-build-tool.test.ts`
  - `open/wiring/__tests__/published-retry-settlement.test.ts`
- `GUARD_BASE_SHA=<origin/main> GUARD_HEAD_SHA=HEAD bash
  scripts/ci/as-built-write-guard.sh`
- `tsc --noEmit -p tsconfig.json`, `scripts/ci/lint.sh` and `git diff --check`

`scripts/ci/typecheck-all.sh` passes 50 of its 51 configurations. The one
failure is `app/tsconfig.json`: the unused `@ts-expect-error` in
`app/__tests__/support/mount.tsx`, as recorded in round 1. This change touches
no `app/` file. The full host suite is left to the host pipeline.

**Scope of this record.** No live row, lease, receipt, branch, PR or
deployment was changed.
